import type {
  Conversion,
  Kelvin,
  KineticModel,
  KineticsError,
  Params,
  ParamValue,
  Seconds,
  Warning,
} from '../domain/types.ts';
import { kineticsError, warning } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';
import {
  CONFIDENCE_LEVEL,
  DEFAULT_Q10,
  Q10_INTERVAL_KELVIN,
  R_GAS,
  WIDE_DELTA_T_KELVIN,
} from '../domain/constants.ts';
import { linearRegression, studentTInv } from '../numerics/stats.ts';
import { bisect, bracketRoot } from '../numerics/roots.ts';
import { timeAt } from './predict.ts';

export type EaSource = 'user' | 'two-dataset' | 'regression' | 'q10-heuristic';

export interface ConfidenceInterval {
  readonly low: number;
  readonly high: number;
  readonly level: number;
  readonly df: number;
}

export interface ActivationEnergy {
  /** J·mol⁻¹. */
  readonly Ea: number;
  readonly source: EaSource;
  readonly ci: ConfidenceInterval | null;
  readonly rSquared: number | null;
  readonly warnings: readonly Warning[];
}

export interface RateAtTemperature {
  readonly T: Kelvin;
  readonly K: number;
}

/**
 * Activation energy, in the spec's order of preference.
 *
 * The regression is always of ln K against 1/T, never of ln t: when datasets sit at
 * different conversions the slope of ln t is not Ea/R, because the g(X) factor differs
 * between them. Calibrating K per temperature first removes that, and is more
 * model-agnostic besides.
 */
export const resolveActivationEnergy = (
  perTemperature: readonly RateAtTemperature[],
  options: {
    readonly userEa?: number;
    readonly q10?: number;
    readonly from?: Kelvin;
    readonly to?: Kelvin;
  },
): Result<ActivationEnergy, KineticsError> => {
  if (options.userEa !== undefined) {
    return ok({ Ea: options.userEa, source: 'user', ci: null, rSquared: null, warnings: [] });
  }

  const distinct = [...new Map(perTemperature.map((d) => [d.T, d])).values()].sort(
    (a, b) => a.T - b.T,
  );

  if (distinct.length === 2) {
    const [first, second] = distinct as [RateAtTemperature, RateAtTemperature];
    const Ea = (R_GAS * Math.log(second.K / first.K)) / (1 / first.T - 1 / second.T);
    // Two points determine a line exactly: df = 0, so no interval exists. Reporting one
    // would be inventing precision.
    return ok({ Ea, source: 'two-dataset', ci: null, rSquared: null, warnings: [] });
  }

  if (distinct.length >= 3) {
    const regression = linearRegression(
      distinct.map((d) => 1 / d.T),
      distinct.map((d) => Math.log(d.K)),
    );
    if (regression !== null) {
      const Ea = -R_GAS * regression.slope;
      const warnings: Warning[] = [];
      let ci: ConfidenceInterval | null = null;
      if (regression.df > 0 && Number.isFinite(regression.slopeStdErr)) {
        const critical = studentTInv(1 - (1 - CONFIDENCE_LEVEL) / 2, regression.df);
        const halfWidth = critical * R_GAS * regression.slopeStdErr;
        ci = {
          low: Ea - halfWidth,
          high: Ea + halfWidth,
          level: CONFIDENCE_LEVEL,
          df: regression.df,
        };
        if (halfWidth > Math.abs(Ea)) {
          warnings.push(
            warning(
              'G17_ILL_CONDITIONED_FIT',
              'loud',
              `The activation energy is barely determined by these datasets: its 95% interval spans ${(ci.low / 1000).toFixed(1)} to ${(ci.high / 1000).toFixed(1)} kJ/mol. Every temperature-shifted prediction inherits that spread.`,
              { ci },
            ),
          );
        }
      }
      return ok({ Ea, source: 'regression', ci, rSquared: regression.rSquared, warnings });
    }
  }

  // Last resort: assume the rate doubles per 10 K. Always tagged, never silent.
  const from = options.from;
  const to = options.to;
  if (from === undefined || to === undefined || from === to) {
    return err(
      kineticsError(
        'MISSING_ACTIVATION_ENERGY',
        'Predicting at a different temperature needs an activation energy. Supply temperature.Ea in J/mol, or provide measurements at two or more temperatures so it can be fitted.',
      ),
    );
  }
  const q10 = options.q10 ?? DEFAULT_Q10;
  /**
   * Q10 is defined per ten kelvin: Q10 ≡ (r₂/r₁)^(10/ΔT). So ln(r₂/r₁) = ΔT·ln(Q10)/10,
   * and equating that to the Arrhenius form (Eₐ/R)·ΔT/(T₁T₂) gives the expression below.
   *
   * The spec writes this with ΔT in the denominator rather than 10, which coincides only
   * when the shift happens to be exactly 10 K. Over a 20 K shift it makes "Q10 = 2" mean
   * "twice as fast in total" instead of "twice as fast per 10 K", understating the rate
   * change by a factor of two, so the defining constant is used here.
   */
  const Ea = (R_GAS * from * to * Math.log(q10)) / Q10_INTERVAL_KELVIN;
  return ok({
    Ea,
    source: 'q10-heuristic',
    ci: null,
    rSquared: null,
    warnings: [
      warning(
        'G18_Q10_HEURISTIC',
        'loud',
        `No activation energy was supplied or fittable, so one was assumed from a Q10 of ${q10}, the rate changing by a factor of ${q10} per 10 K. That is a rule of thumb, not a measurement, and every temperature-shifted time below is only as good as the assumption. Measure at a second temperature to replace it.`,
        { q10, Ea },
      ),
    ],
  });
};

/**
 * Carries parameters to another temperature using whatever response each one declares.
 *
 * The solver never learns which parameter is which; it just applies the closures. That
 * is what makes the shift correct for reversible-1, where Xe moves with temperature and
 * a plain multiplicative time shift would be wrong.
 */
export const shiftParameters = (
  model: KineticModel,
  params: Params,
  shift: { readonly from: Kelvin; readonly to: Kelvin; readonly deltaH?: number },
): Result<{ readonly params: Params; readonly moved: readonly string[] }, KineticsError> => {
  const next: Record<string, ParamValue> = { ...params };
  const moved: string[] = [];
  for (const spec of model.params) {
    if (spec.shiftTemperature === undefined) continue;
    const current = params[spec.key];
    if (typeof current !== 'number') continue;
    const shifted = spec.shiftTemperature(current, shift);
    if (!shifted.ok) return shifted;
    next[spec.key] = shifted.value;
    moved.push(spec.key);
  }
  return ok({ params: next, moved });
};

export interface ShiftedState {
  readonly K: number;
  readonly params: Params;
  readonly warnings: readonly Warning[];
}

/**
 * Transforms (K, params) to another temperature; predictions are then re-run from the
 * shifted state.
 *
 * The spec's t·exp[(Ea/R)(1/T₂ − 1/T₁)] is the special case where g does not itself
 * depend on temperature. It is wrong wherever a parameter moves, for an equilibrium
 * conversion the shape of g changes, not merely its scale.
 */
export const shiftToTemperature = (
  model: KineticModel,
  params: Params,
  K: number,
  from: Kelvin,
  to: Kelvin,
  Ea: number,
  deltaH?: number,
): Result<ShiftedState, KineticsError> => {
  const warnings: Warning[] = [];
  if (Math.abs(to - from) > WIDE_DELTA_T_KELVIN) {
    warnings.push(
      warning(
        'G11_WIDE_TEMPERATURE_SHIFT',
        'loud',
        `This prediction extrapolates ${Math.abs(to - from).toFixed(1)} K from the measured temperature. Arrhenius behaviour rarely holds that far: mechanisms change, glass transitions intervene, and many systems are super-Arrhenius. Treat the result as an order-of-magnitude guide.`,
        { deltaT: to - from },
      ),
    );
  }

  const shifted = shiftParameters(
    model,
    params,
    deltaH === undefined ? { from, to } : { from, to, deltaH },
  );
  if (!shifted.ok) return shifted;

  const ceilingBefore = model.Xmax(params);
  const ceilingAfter = model.Xmax(shifted.value.params);
  if (ceilingAfter < ceilingBefore - 1e-12 && to > from) {
    warnings.push(
      warning(
        'EQUILIBRIUM_FALLS_WITH_TEMPERATURE',
        'loud',
        `Raising the temperature speeds this reaction up but lowers how far it can go: the attainable conversion falls from ${(ceilingBefore * 100).toFixed(2)}% to ${(ceilingAfter * 100).toFixed(2)}%. For an exothermic equilibrium those two effects pull against each other.`,
        { ceilingBefore, ceilingAfter },
      ),
    );
  }

  return ok({
    K: K * Math.exp(-(Ea / R_GAS) * (1 / to - 1 / from)),
    params: shifted.value.params,
    warnings,
  });
};

/**
 * Inverse use case (B8/C6): the temperature at which a target conversion is reached by
 * a deadline.
 *
 * Solved numerically rather than by inverting Arrhenius in closed form, because the
 * closed form silently assumes g is temperature-independent, untrue exactly when it
 * matters most, for equilibrium-limited reactions whose ceiling moves with temperature.
 */
export const solveForTemperature = (
  model: KineticModel,
  params: Params,
  K: number,
  from: Kelvin,
  Ea: number,
  target: Conversion,
  deadline: Seconds,
  deltaH?: number,
): Result<Kelvin, KineticsError> => {
  const shortfall = (T: Kelvin): number => {
    const state = shiftToTemperature(model, params, K, from, T, Ea, deltaH);
    if (!state.ok) return Number.NaN;
    if (target.X >= model.Xmax(state.value.params)) return Number.NaN;
    const t = timeAt(model, state.value.params, state.value.K, target);
    return t.ok && Number.isFinite(t.value) ? t.value - deadline : Number.NaN;
  };

  const bracket = bracketRoot(shortfall, Math.max(from - 150, 1), from + 300);
  if (bracket === null) {
    return err(
      kineticsError(
        'DEADLINE_INFEASIBLE',
        `No temperature within 150 K below or 300 K above the measured one reaches ${(target.X * 100).toFixed(2)}% conversion by that deadline. Either the deadline is too tight, or raising the temperature lowers the attainable conversion below the target.`,
        { deadline, targetX: target.X },
      ),
    );
  }
  return bisect(shortfall, bracket);
};
