import type {
  Conversion,
  KineticModel,
  KineticsError,
  Limit,
  Params,
  TemperatureShift,
} from '../domain/types.ts';
import { kineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';
import { R_GAS } from '../domain/constants.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_XE = 0.9;

const equilibrium = (p: Params): number => num(p, 'Xe', DEFAULT_XE);

/**
 * van 't Hoff shift of the equilibrium conversion (§5 C7).
 *
 * This is why `shiftTemperature` is a closure on the parameter rather than a role tag
 * the solver inspects: the solver applies whatever each parameter declares and never
 * learns that this one is an equilibrium conversion.
 *
 *   ln(Keq₂/Keq₁) = −(ΔH/R)(1/T₂ − 1/T₁),   Xe = Keq/(1 + Keq)
 */
const shiftEquilibrium = (
  Xe: number,
  shift: TemperatureShift,
): Result<number, KineticsError> => {
  if (shift.deltaH === undefined) {
    return err(
      kineticsError(
        'MISSING_ENTHALPY',
        'Shifting the equilibrium conversion to another temperature needs the reaction enthalpy ΔH. Supply temperature.deltaH in J/mol, or predict at the measured temperature.',
      ),
    );
  }
  if (Xe >= 1) return ok(1); // effectively irreversible; Keq is unbounded
  const keqFrom = Xe / (1 - Xe);
  const keqTo = keqFrom * Math.exp(-(shift.deltaH / R_GAS) * (1 / shift.to - 1 / shift.from));
  if (!Number.isFinite(keqTo)) return ok(1);
  return ok(keqTo / (1 + keqTo));
};

/**
 * Reversible first-order, A ⇌ B.
 *
 *   g(X) = −Xe·ln(1 − X/Xe),   Xe = Keq/(1 + Keq)
 *
 * Capped *and* asymptotic: the ceiling is Xe < 1, and g diverges there. The spec treats
 * "model-capped" and "diverges" as alternatives, but this model is both at once, which
 * is why the completion verdict reports the ceiling and its reachability separately.
 */
export const reversibleFirstOrder: KineticModel = {
  key: 'reversible-1',
  label: 'Reversible first-order',
  timeQuantity: 'batchTime',
  notes: 'Reversible 1st order; Xe = Keq/(1+Keq). Conversion cannot pass equilibrium.',

  params: [
    continuousParam({
      key: 'Xe',
      symbol: 'Xe',
      label: 'Equilibrium conversion',
      default: DEFAULT_XE,
      min: 0,
      max: 1,
      openMin: true,
      // Moderately reversible through to nearly complete. A linear sweep of (0,1) would
      // spend most of its points below the measured conversion, where g is undefined.
      bandValues: [0.5, 0.7, 0.9, 0.95, 0.99],
      shiftTemperature: shiftEquilibrium,
    }),
  ],

  g: (c: Conversion, p: Params): number => {
    const Xe = equilibrium(p);
    // (Xe − X)/Xe rather than 1 − X/Xe: one subtraction instead of a division that
    // lands next to 1 and then loses its leading digits. The + 0 normalizes the signed
    // zero at X = 0.
    return -Xe * Math.log((Xe - c.X) / Xe) + 0;
  },

  gPrime: (c: Conversion, p: Params): number => {
    const Xe = equilibrium(p);
    return Xe / (Xe - c.X);
  },

  gInv: (tau: number, p: Params): number => {
    const Xe = equilibrium(p);
    return -Xe * Math.expm1(-tau / Xe);
  },

  Xmax: (p: Params): number => equilibrium(p),

  limitAtCeiling: (): Limit => ({ kind: 'divergent', rate: 'logarithmic' }),

  /** First-order: K is the forward rate constant, with no concentration dependence. */
  kFromRateConstant: (k: number) => ok(k),

  describe: (p: Params) => {
    const Xe = equilibrium(p);
    return [
      {
        kind: 'model' as const,
        plain: 'Reversible first order, A ⇌ B  ⇒  K·t = g(X)',
        latex: 'K\\,t = g(X)',
      },
      {
        kind: 'closedForm' as const,
        plain: `Xe = ${fmt(Xe)}  ⇒  g(X) = −Xe·ln(1 − X/Xe)`,
        latex: 'g(X) = -X_e\\ln\\!\\left(1 - \\frac{X}{X_e}\\right)',
        values: { Xe },
      },
    ];
  },
};
