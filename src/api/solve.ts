import type {
  Conversion,
  Kelvin,
  KineticModel,
  KineticsError,
  Observation,
  Params,
  Warning,
} from '../domain/types.ts';
import { warning as makeWarning } from '../domain/types.ts';
import { ok, type Result } from '../domain/result.ts';
import { asPercent } from '../domain/format.ts';
import { HEADLINE_TARGET } from '../domain/constants.ts';
import { calibrate, groupByTemperature } from '../solver/calibrate.ts';
import { classifyCompletion } from '../solver/completion.ts';
import { fitFreeParameter, resolveParameters } from '../solver/fit.ts';
import { conversionAt, curve as sampleCurve, timeAt } from '../solver/predict.ts';
import {
  resolveActivationEnergy,
  shiftToTemperature,
  solveForTemperature,
  type ActivationEnergy,
} from '../solver/temperature.ts';
import { buildBand, monteCarlo, sensitivityVector } from '../solver/uncertainty.ts';
import type { StateTransform } from '../solver/uncertainty.ts';
import {
  assumedParameterWarning,
  checkBackExtrapolation,
  checkExtrapolation,
  checkMagnitudes,
  checkMonotonicity,
  checkParameters,
} from '../solver/guards.ts';
import { buildDerivation, renderDerivation } from '../explain/derivation.ts';
import { validateRequest, type ValidRequest } from './validate.ts';
import { fromKelvin, fromSeconds, rateUnitsLabel, toSeconds } from './units.ts';
import type {
  BandOutput,
  Headline,
  SolveRequest,
  SolveResponse,
  TableRow,
  TemperatureOutput,
} from './schema.ts';

/**
 * The single entry point: JSON in, JSON out, pure and deterministic.
 *
 * The HTTP layer around this is a thin wrapper that can be deleted without touching any
 * of the mathematics.
 */

/** Which parameter to sweep when nothing was fitted, chosen without naming any model. */
const bandParameterFor = (
  model: KineticModel,
  sources: Readonly<Record<string, string>>,
): string | null => {
  const declared = model.params.find(
    (s) => s.bandValues !== undefined && sources[s.key] !== 'fitted',
  );
  if (declared !== undefined) return declared.key;
  return model.params.find((s) => sources[s.key] !== 'fitted')?.key ?? null;
};

/** The target a chemist is most likely asking about, used to lead the response. */
const headlineIndexOf = (targets: readonly Conversion[]): number => {
  if (targets.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < targets.length; i += 1) {
    const current = targets[i] as Conversion;
    const incumbent = targets[best] as Conversion;
    if (Math.abs(current.X - HEADLINE_TARGET) < Math.abs(incumbent.X - HEADLINE_TARGET)) best = i;
  }
  return best;
};

interface BaseState {
  readonly params: Params;
  readonly K: number;
  readonly warnings: readonly Warning[];
  readonly temperature: TemperatureOutput | null;
  readonly activationEnergy: ActivationEnergy | null;
  /**
   * The unshifted state at the measurement temperature.
   *
   * Kept separate because the inverse-Arrhenius solve searches *from* the basis: handing
   * it an already-shifted K while still telling it the origin is the basis applies the
   * shift twice, and the temperature it returns then leans the wrong way.
   */
  readonly basisK: number;
  readonly basisParams: Params;
  readonly basis: Kelvin;
  /**
   * The same temperature move the point estimate made, reusable on any calibrated state.
   *
   * The band re-calibrates from the observations, so without this it reports the spread
   * at the measurement temperature while the row beside it reports the shifted time , 
   * an 8× disagreement on the app's own headline. Null when no shift was requested.
   */
  readonly shift: StateTransform | null;
}

/** Resolves K and parameters at the temperature predictions are wanted for. */
const establishState = (
  request: ValidRequest,
  model: KineticModel,
  params: Params,
  observations: readonly Observation[],
): Result<BaseState, KineticsError> => {
  const groups = groupByTemperature(observations);
  const perTemperature: { T: number; K: number }[] = [];
  for (const [T, members] of groups) {
    const calibration = calibrate(model, params, { observations: members, ...request.known });
    if (!calibration.ok) return calibration;
    perTemperature.push({ T, K: calibration.value.K });
  }

  const baseCalibration = calibrate(model, params, { observations, ...request.known });
  if (!baseCalibration.ok) return baseCalibration;

  const basis =
    perTemperature.find((d) => d.T === request.temperature.basis)?.T ??
    perTemperature[0]?.T ??
    request.temperature.basis;
  const basisK = perTemperature.find((d) => d.T === basis)?.K ?? baseCalibration.value.K;

  const wantsShift =
    request.temperature.predictAt !== undefined && request.temperature.predictAt !== basis;
  const wantsEa =
    wantsShift || perTemperature.length >= 2 || request.temperature.deadline !== undefined;

  if (!wantsEa) {
    return ok({
      params,
      K: basisK,
      warnings: [],
      temperature: null,
      activationEnergy: null,
      basisK,
      basisParams: params,
      basis,
      shift: null,
    });
  }

  const activation = resolveActivationEnergy(perTemperature, {
    ...(request.temperature.Ea === undefined ? {} : { userEa: request.temperature.Ea }),
    q10: request.temperature.q10,
    from: basis,
    ...(request.temperature.predictAt === undefined
      ? {}
      : { to: request.temperature.predictAt }),
  });
  if (!activation.ok) return activation;

  const warnings: Warning[] = [...activation.value.warnings];
  let workingParams = params;
  let workingK = basisK;

  const predictAt = request.temperature.predictAt;
  const shift: StateTransform | null =
    wantsShift && predictAt !== undefined
      ? (p, k) => {
          const moved = shiftToTemperature(
            model,
            p,
            k,
            basis,
            predictAt,
            activation.value.Ea,
            request.temperature.deltaH,
          );
          return moved.ok ? { params: moved.value.params, K: moved.value.K } : null;
        }
      : null;

  if (wantsShift && predictAt !== undefined) {
    const shifted = shiftToTemperature(
      model,
      params,
      basisK,
      basis,
      predictAt,
      activation.value.Ea,
      request.temperature.deltaH,
    );
    if (!shifted.ok) return shifted;
    workingParams = shifted.value.params;
    workingK = shifted.value.K;
    warnings.push(...shifted.value.warnings);
  }

  const unit = request.units.temperature;
  return ok({
    params: workingParams,
    K: workingK,
    warnings,
    activationEnergy: activation.value,
    basisK,
    basisParams: params,
    basis,
    shift,
    temperature: {
      basis: fromKelvin(basis, unit),
      predictAt:
        request.temperature.predictAt === undefined
          ? null
          : fromKelvin(request.temperature.predictAt, unit),
      Ea: activation.value.Ea,
      EaUnits: 'J/mol',
      eaSource: activation.value.source,
      eaConfidenceInterval: activation.value.ci,
      arrheniusRSquared: activation.value.rSquared,
      requiredTemperature: null,
      perTemperature: perTemperature.map((d) => ({ T: fromKelvin(d.T, unit), K: d.K })),
    },
  });
};

export const solve = (raw: SolveRequest): Result<SolveResponse, KineticsError> => {
  const validated = validateRequest(raw);
  if (!validated.ok) return validated;
  const request = validated.value;
  const { model, observations, units } = request;

  const secondsPerUnit = toSeconds(1, units.time);
  const toUserTime = (seconds: number): number => fromSeconds(seconds, units.time);

  const resolved = resolveParameters(model, request.requestedParams);
  const fit = fitFreeParameter(model, resolved, observations);
  if (!fit.ok) return fit;

  const state = establishState(request, model, fit.value.params, observations);
  if (!state.ok) return state;

  const params = state.value.params;
  const K = state.value.K;
  const ceiling = model.Xmax(params);
  const warnings: Warning[] = [...fit.value.warnings, ...state.value.warnings];

  /* ---- table: B1, B2, B6 ---- */
  const deepest =
    observations.length > 0
      ? observations.reduce((a, b) => (a.conversion.X > b.conversion.X ? a : b))
      : null;
  const gObserved = deepest === null ? null : model.g(deepest.conversion, params);
  const observedTime = deepest === null ? null : timeAt(model, params, K, deepest.conversion);

  const ceilingLimit = model.limitAtCeiling(params);

  const rows: TableRow[] = request.targetConversions.map((target) => {
    if (target.X > ceiling) {
      return {
        X: target.X,
        t: null,
        reachable: false,
        unreachableReason: `This model tops out at ${asPercent(ceiling)} conversion for the resolved parameters, so ${asPercent(target.X)} is never reached: no amount of time gets there.`,
      };
    }
    // A target sitting exactly at the ceiling is answerable whenever g converges there
    // (G5): zero and half order reach complete conversion at a definite time, and every
    // diffusion law does too. Only a divergent ceiling has no finite answer (G4).
    if (target.X === ceiling) {
      if (ceilingLimit.kind === 'finite' && Number.isFinite(ceilingLimit.value)) {
        return {
          X: target.X,
          t: toUserTime(ceilingLimit.value / K),
          reachable: true,
          extrapolationFactor:
            gObserved === null || gObserved <= 0 ? null : ceilingLimit.value / gObserved,
        };
      }
      return {
        X: target.X,
        t: null,
        reachable: false,
        unreachableReason: `${asPercent(target.X)} conversion is approached asymptotically rather than attained, so no finite time reaches it. See the practical ladder in "completion" instead.`,
      };
    }
    const predicted = timeAt(model, params, K, target);
    if (!predicted.ok || !Number.isFinite(predicted.value)) {
      return {
        X: target.X,
        t: null,
        reachable: false,
        unreachableReason: `The time to reach ${asPercent(target.X)} is unbounded for this model.`,
      };
    }
    const gTarget = model.g(target, params);
    return {
      X: target.X,
      t: toUserTime(predicted.value),
      reachable: true,
      extrapolationFactor: gObserved === null || gObserved <= 0 ? null : gTarget / gObserved,
      deltaFromObserved:
        observedTime !== null && observedTime.ok
          ? toUserTime(predicted.value - observedTime.value)
          : null,
    };
  });

  /* ---- band and headline: A2, B7, §11 ---- */
  const assumedKey = fit.value.identifiable ? null : bandParameterFor(model, fit.value.sources);
  const band =
    assumedKey !== null && observations.length > 0
      ? buildBand(
          model,
          params,
          assumedKey,
          observations,
          request.targetConversions,
          state.value.shift ?? undefined,
        )
      : null;

  let bandOutput: BandOutput | null = null;
  if (band !== null) {
    const times: Record<string, readonly (number | null)[]> = {};
    const spreadFactor: Record<string, number | null> = {};
    request.targetConversions.forEach((target, i) => {
      const key = String(target.X);
      times[key] = band.columns.map((c) => {
        const value = c.times[i];
        return value === null || value === undefined ? null : toUserTime(value);
      });
      spreadFactor[key] = band.envelope[i]?.spreadFactor ?? null;
    });
    bandOutput = { param: band.param, symbol: band.symbol, values: band.values, times, spreadFactor };
  }

  const headlineIndex = headlineIndexOf(request.targetConversions);
  const headlineRow = headlineIndex >= 0 ? (rows[headlineIndex] as TableRow) : null;

  const rowsWithBand: TableRow[] = rows.map((row, i) => {
    const envelope = band?.envelope[i];
    if (envelope === undefined) return row;
    return {
      ...row,
      bandLow: envelope.low === null ? null : toUserTime(envelope.low),
      bandHigh: envelope.high === null ? null : toUserTime(envelope.high),
    };
  });

  let headline: Headline;
  if (bandOutput !== null && assumedKey !== null) {
    const spread = band?.envelope[headlineIndex]?.spreadFactor ?? null;
    warnings.unshift(assumedParameterWarning(model, assumedKey, spread));
    const spec = model.params.find((s) => s.key === assumedKey);
    const low = band?.envelope[headlineIndex]?.low ?? null;
    const high = band?.envelope[headlineIndex]?.high ?? null;
    headline = {
      kind: 'band',
      param: assumedKey,
      message:
        headlineRow === null || low === null || high === null
          ? `${spec?.label ?? assumedKey} was assumed rather than measured, so the result is a range rather than a single time.`
          : `Time to ${asPercent(headlineRow.X)}: between ${toUserTime(low).toPrecision(3)} and ${toUserTime(high).toPrecision(3)} ${units.time}, depending on ${spec?.label ?? assumedKey}. The measurement cannot distinguish these; every value in the band fits it exactly.`,
      band: bandOutput,
      pointEstimate: headlineRow,
    };
  } else {
    headline = {
      kind: 'point',
      message:
        headlineRow === null || headlineRow.t === null
          ? 'The requested conversion is not reachable for this model.'
          : `Time to ${asPercent(headlineRow.X)}: ${headlineRow.t.toPrecision(4)} ${units.time}.`,
      estimate: headlineRow,
    };
  }

  /* ---- inverse (B3) and curve (B4) ---- */
  const inverse: { t: number; X: number }[] = [];
  for (const t of request.targetTimes) {
    const reached = conversionAt(model, params, K, t);
    if (!reached.ok) return reached;
    inverse.push({ t: toUserTime(t), X: reached.value.X });
  }

  const sampled = sampleCurve(
    model,
    params,
    K,
    request.curve.points,
    request.curve.fractionOfCeiling,
  );
  if (!sampled.ok) return sampled;

  /* ---- completion: B5, §5 D ---- */
  const completion = classifyCompletion(model, params, K);
  const practical: Record<string, number> = {};
  for (const entry of completion.practical) practical[String(entry.X)] = toUserTime(entry.t);

  /* ---- inverse Arrhenius: B8, C6 ---- */
  let temperatureOutput = state.value.temperature;
  if (
    request.temperature.deadline !== undefined &&
    state.value.activationEnergy !== null &&
    headlineIndex >= 0 &&
    temperatureOutput !== null
  ) {
    const target = request.targetConversions[headlineIndex] as Conversion;
    // Searches from the measurement temperature using the unshifted state, passing the
    // already-shifted K here would apply the Arrhenius factor a second time.
    const required = solveForTemperature(
      model,
      state.value.basisParams,
      state.value.basisK,
      state.value.basis,
      state.value.activationEnergy.Ea,
      target,
      request.temperature.deadline,
      request.temperature.deltaH,
    );
    if (required.ok) {
      temperatureOutput = {
        ...temperatureOutput,
        requiredTemperature: fromKelvin(required.value, units.temperature),
      };
    } else {
      warnings.push(
        makeWarning('G17_ILL_CONDITIONED_FIT', 'warning', required.error.message, {
          code: required.error.code,
        }),
      );
    }
  }

  /* ---- Monte Carlo: §4.7 ---- */
  let monteCarloSeed: number | null = null;
  let rowsFinal = rowsWithBand;
  if (request.uncertainty.monteCarlo > 0 && deepest !== null) {
    const mc = monteCarlo(model, params, deepest, request.targetConversions, {
      samples: request.uncertainty.monteCarlo,
      sigmaX: request.uncertainty.sigmaX,
      sigmaT: request.uncertainty.sigmaT,
      ...(request.uncertainty.paramRange === undefined || assumedKey === null
        ? {}
        : { paramRange: request.uncertainty.paramRange, paramKey: assumedKey }),
      ...(request.uncertainty.seed === undefined ? {} : { seed: request.uncertainty.seed }),
    });
    monteCarloSeed = mc.seed;
    warnings.push(...mc.warnings);
    rowsFinal = rowsWithBand.map((row, i) => {
      const p5 = mc.p5[i];
      const p50 = mc.p50[i];
      const p95 = mc.p95[i];
      return {
        ...row,
        p5: p5 === null || p5 === undefined ? null : toUserTime(p5),
        p50: p50 === null || p50 === undefined ? null : toUserTime(p50),
        p95: p95 === null || p95 === undefined ? null : toUserTime(p95),
      };
    });
  }

  /* ---- diagnostics ---- */
  warnings.push(...checkMonotonicity(observations));
  warnings.push(...checkParameters(model, params));
  warnings.push(...checkBackExtrapolation(observations, request.targetConversions));
  warnings.push(...checkExtrapolation(model, params, observations, request.targetConversions));
  warnings.push(
    ...checkMagnitudes(
      rowsFinal.map((r) => (r.t === null ? null : r.t * secondsPerUnit)),
      rowsFinal.map((r) => r.X),
    ),
  );

  const headlineTarget =
    headlineIndex >= 0 ? (request.targetConversions[headlineIndex] as Conversion) : null;
  const sensitivities =
    deepest !== null && headlineTarget !== null
      ? sensitivityVector(model, params, deepest, headlineTarget)
      : [];
  const shapeKey = assumedKey ?? model.params[0]?.key ?? '';

  const derivationSteps = buildDerivation({
    model,
    params,
    K: K * secondsPerUnit,
    KUnits: rateUnitsLabel(units.time),
    timeUnit: units.time,
    timeLabel: model.timeQuantity === 'spaceTime' ? 'τ' : 't',
    calibrationSource:
      observations.length > 0 ? 'the supplied measurements' : 'the supplied constants',
    ...(deepest === null
      ? {}
      : { observation: { t: toUserTime(deepest.t), conversion: deepest.conversion } }),
    ...(headlineRow === null || headlineRow.t === null || headlineTarget === null
      ? {}
      : { headline: { conversion: headlineTarget, t: headlineRow.t } }),
    completion,
    completionTime: completion.time === undefined ? null : toUserTime(completion.time),
    practicalLadder: completion.practical.map((e) => ({ X: e.X, t: toUserTime(e.t) })),
    ...(temperatureOutput === null || temperatureOutput.predictAt === null
      ? {}
      : {
          temperature: {
            from: temperatureOutput.basis,
            to: temperatureOutput.predictAt,
            Ea: temperatureOutput.Ea ?? 0,
            source: temperatureOutput.eaSource ?? 'unknown',
            unit: units.temperature,
          },
        }),
  });

  const worstExtrapolation = rowsFinal.reduce<number | null>((worst, row) => {
    const factor = row.extrapolationFactor;
    if (factor === null || factor === undefined) return worst;
    return worst === null ? factor : Math.max(worst, factor);
  }, null);

  return ok({
    resolved: {
      model: model.key,
      label: model.label,
      params,
      paramSources: fit.value.sources,
      K: K * secondsPerUnit,
      KUnits: rateUnitsLabel(units.time),
      KNote: `K has units of ${rateUnitsLabel(units.time)} for every reaction order, because C_A0^(n−1) is lumped into it. The rate constant k does not.`,
      Xmax: ceiling,
      identifiable: fit.value.identifiable,
      calibrationSource: observations.length > 0 ? 'observations' : 'known constants',
      reactor: request.reactor,
      timeQuantity: model.timeQuantity,
      timeLabel: model.timeQuantity === 'spaceTime' ? 'space time τ' : 'reaction time t',
    },
    headline,
    table: rowsFinal,
    inverse,
    curve: { t: sampled.value.map((p) => toUserTime(p.t)), X: sampled.value.map((p) => p.X) },
    completion: {
      ...completion,
      time: completion.time === undefined ? null : toUserTime(completion.time),
      practical,
      practicalDetail: completion.practical.map((e) => ({
        fractionOfCeiling: e.fractionOfCeiling,
        X: e.X,
        t: toUserTime(e.t),
      })),
    },
    band: bandOutput,
    temperature: temperatureOutput,
    diagnostics: {
      extrapolationFactor: worstExtrapolation,
      dlnt_dX1: sensitivities.find((s) => s.input === 'X1')?.dLnT ?? null,
      dlnt_dn: sensitivities.find((s) => s.input === shapeKey)?.dLnT ?? null,
      sensitivities,
      rSquared: fit.value.rSquared,
      residuals: fit.value.residuals.map(toUserTime),
      monteCarloSeed,
      warnings,
    },
    derivation: renderDerivation(derivationSteps),
    derivationSteps,
    units: { time: units.time, temperature: units.temperature, conversion: units.conversion },
  });
};

export type { SolveRequest, SolveResponse };
