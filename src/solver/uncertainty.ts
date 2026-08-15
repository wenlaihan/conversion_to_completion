import type {
  Conversion,
  KineticModel,
  Observation,
  Params,
  ParamValue,
  Seconds,
  Warning,
} from '../domain/types.ts';
import { conversionOf, warning } from '../domain/types.ts';
import {
  DEFAULT_MC_SEED,
  GENERIC_BAND_POINTS,
  MAX_MC_SAMPLES,
  SENSITIVITY_STEP,
} from '../domain/constants.ts';
import { normal, streamFor, uniform } from '../numerics/prng.ts';
import { quantile } from '../numerics/stats.ts';
import { calibrate } from './calibrate.ts';
import { timeAt } from './predict.ts';

/* ------------------------------------------------------------------ *
 * Analytic sensitivity
 * ------------------------------------------------------------------ */

export interface Sensitivity {
  readonly input: string;
  /** ∂ln t / ∂input. */
  readonly dLnT: number;
  /** Plain-English effect of a realistic perturbation of this input. */
  readonly effect: string;
}

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/**
 * Ranked sensitivity of the predicted time to each uncertain input.
 *
 * The spec highlights ∂ln t/∂X₁ = −g′(X₁)/g(X₁), and that term is real, but it is
 * usually not the dominant one, so reporting it alone gives false confidence. For
 * extrapolation from X₁ = 0.5 to X = 0.999 at n = 2 it is −4, so one percentage point on
 * X₁ moves the answer 4%; over the same span ∂ln t/∂n ≈ 6.2, and a fitted order is
 * realistically uncertain by ±0.2, a factor of 3.4. The order dominates by an order of
 * magnitude, which is precisely the point this app exists to make.
 *
 * Note the generic form: g′ comes from the model, not from a hardcoded (1−X₁)^(−n).
 */
export const sensitivityVector = (
  model: KineticModel,
  params: Params,
  observation: Observation,
  target: Conversion,
  plausibleSpread: Readonly<Record<string, number>> = {},
): readonly Sensitivity[] => {
  const results: Sensitivity[] = [];

  const gObs = model.g(observation.conversion, params);
  const dLnTdX1 = -model.gPrime(observation.conversion, params) / gObs;
  results.push({
    input: 'X1',
    dLnT: dLnTdX1,
    effect: `±1 percentage point on the measured conversion moves every predicted time by about ${percent(Math.abs(dLnTdX1) * 0.01)}`,
  });

  results.push({
    input: 't1',
    dLnT: 1,
    effect: 'predicted times scale in direct proportion to the measured time',
  });

  // ∂ln t/∂param by central difference on ln[g(target)/g(observed)].
  for (const spec of model.params) {
    const current = params[spec.key];
    if (typeof current !== 'number') continue;
    const h = Math.max(Math.abs(current), 1) * SENSITIVITY_STEP;
    const lnRatioAt = (v: number): number => {
      const p = { ...params, [spec.key]: v };
      return Math.log(model.g(target, p) / model.g(observation.conversion, p));
    };
    const slope = (lnRatioAt(current + h) - lnRatioAt(current - h)) / (2 * h);
    if (!Number.isFinite(slope)) continue;
    const spread = plausibleSpread[spec.key] ?? 0.2;
    results.push({
      input: spec.key,
      dLnT: slope,
      effect: `±${spread} on ${spec.symbol} changes the predicted time by a factor of about ${Math.exp(Math.abs(slope) * spread).toFixed(2)}`,
    });
  }

  return [...results].sort((a, b) => Math.abs(b.dLnT) - Math.abs(a.dLnT));
};

/* ------------------------------------------------------------------ *
 * Band over an assumed parameter
 * ------------------------------------------------------------------ */

export interface BandColumn {
  readonly value: ParamValue;
  readonly K: number;
  /** Predicted time per requested target; null where the target is unreachable. */
  readonly times: readonly (Seconds | null)[];
}

export interface Band {
  readonly param: string;
  readonly symbol: string;
  readonly values: readonly ParamValue[];
  readonly columns: readonly BandColumn[];
  /** Per target: lowest and highest across the band, and the spread factor between them. */
  readonly envelope: readonly {
    readonly X: number;
    readonly low: Seconds | null;
    readonly high: Seconds | null;
    readonly spreadFactor: number | null;
  }[];
}

/** Values to sweep: whatever the registry declares as plausible, else across the domain. */
const bandValuesFor = (model: KineticModel, key: string): readonly ParamValue[] => {
  const spec = model.params.find((s) => s.key === key);
  if (spec === undefined) return [];
  if (spec.bandValues !== undefined) return spec.bandValues;
  if (spec.domain.kind === 'categorical') return spec.domain.options;
  const { min, max } = spec.domain;
  return Array.from(
    { length: GENERIC_BAND_POINTS },
    (_, i) => min + ((max - min) * (i + 1)) / (GENERIC_BAND_POINTS + 1),
  );
};

/**
 * The spread of predictions across plausible values of an assumed parameter.
 *
 * From one measurement (21% at 6 h) the time to 90% is 26 h at zero order and 986 h at
 * third order, a factor of 38 from data that fits every one of those models perfectly.
 * When the parameter was assumed rather than measured, this spread *is* the answer and
 * the point estimate is the detail.
 */
/**
 * Re-expresses a calibrated state somewhere other than the measurement temperature.
 *
 * The band is calibrated from the observations, which are at the basis temperature, so
 * on a request that predicts elsewhere, every column has to make the same journey the
 * point estimate makes, or the band describes a different experiment than the number it
 * is meant to bracket. The caller supplies the transform because temperature belongs to
 * the solver layer; this file only knows that a state can be moved. Returning null drops
 * the column, which is the honest outcome when the shift is undefined for that value.
 */
export type StateTransform = (
  params: Params,
  K: number,
) => { readonly params: Params; readonly K: number } | null;

export const buildBand = (
  model: KineticModel,
  params: Params,
  assumedKey: string,
  observations: readonly Observation[],
  targets: readonly Conversion[],
  transform?: StateTransform,
): Band | null => {
  const spec = model.params.find((s) => s.key === assumedKey);
  if (spec === undefined) return null;
  const values = bandValuesFor(model, assumedKey);
  if (values.length === 0) return null;

  const columns: BandColumn[] = [];
  for (const value of values) {
    const candidate = { ...params, [assumedKey]: value };
    const calibration = calibrate(model, candidate, { observations });
    if (!calibration.ok) continue;
    const at =
      transform === undefined
        ? { params: candidate, K: calibration.value.K }
        : transform(candidate, calibration.value.K);
    if (at === null) continue;
    const ceiling = model.Xmax(at.params);
    const times = targets.map((target) => {
      if (target.X >= ceiling) return null;
      const t = timeAt(model, at.params, at.K, target);
      return t.ok && Number.isFinite(t.value) ? t.value : null;
    });
    columns.push({ value, K: at.K, times });
  }
  if (columns.length === 0) return null;

  const envelope = targets.map((target, i) => {
    const finite = columns
      .map((c) => c.times[i])
      .filter((t): t is number => t !== null && t !== undefined && t > 0);
    if (finite.length === 0) return { X: target.X, low: null, high: null, spreadFactor: null };
    const low = Math.min(...finite);
    const high = Math.max(...finite);
    return { X: target.X, low, high, spreadFactor: high / low };
  });

  return {
    param: assumedKey,
    symbol: spec.symbol,
    values: columns.map((c) => c.value),
    columns,
    envelope,
  };
};

/* ------------------------------------------------------------------ *
 * Monte Carlo
 * ------------------------------------------------------------------ */

export interface MonteCarloResult {
  readonly p5: readonly (Seconds | null)[];
  readonly p50: readonly (Seconds | null)[];
  readonly p95: readonly (Seconds | null)[];
  readonly samples: number;
  /** Fraction of draws in which each target became unreachable. */
  readonly unreachableFraction: readonly number[];
  readonly seed: number;
  readonly warnings: readonly Warning[];
}

export interface MonteCarloOptions {
  readonly samples: number;
  readonly sigmaX: number;
  readonly sigmaT: number;
  readonly paramRange?: readonly [number, number];
  readonly paramKey?: string;
  readonly seed?: number;
}

/**
 * Propagates measurement uncertainty by resampling the inputs.
 *
 * Two details decide whether the numbers mean anything. Each input draws from its own
 * keyed substream, so adding an uncertain variable later does not renumber every other
 * draw and silently move previously pinned results. And draws where the target becomes
 * unreachable (a sampled parameter that puts the ceiling below the target) are counted
 * and reported rather than dropped: discarding them quietly biases the interval toward
 * the feasible region and reports a confidently narrow answer.
 */
export const monteCarlo = (
  model: KineticModel,
  params: Params,
  observation: Observation,
  targets: readonly Conversion[],
  options: MonteCarloOptions,
): MonteCarloResult => {
  const seed = options.seed ?? DEFAULT_MC_SEED;
  const samples = Math.min(Math.max(Math.trunc(options.samples), 0), MAX_MC_SAMPLES);
  const drawX = streamFor(seed, 'X1');
  const drawT = streamFor(seed, 't1');
  const drawParam = streamFor(seed, options.paramKey ?? 'param');

  const collected: number[][] = targets.map(() => []);
  const unreachable: number[] = targets.map(() => 0);
  const markAllUnreachable = (): void => {
    for (let j = 0; j < targets.length; j += 1) unreachable[j] = (unreachable[j] as number) + 1;
  };

  for (let i = 0; i < samples; i += 1) {
    const X = normal(drawX, observation.conversion.X, options.sigmaX);
    const t = normal(drawT, observation.t, options.sigmaT);
    const candidate: Params =
      options.paramRange !== undefined && options.paramKey !== undefined
        ? {
            ...params,
            [options.paramKey]: uniform(drawParam, options.paramRange[0], options.paramRange[1]),
          }
        : params;

    const ceiling = model.Xmax(candidate);
    if (!(X > 0) || X >= ceiling || !(t > 0)) {
      markAllUnreachable();
      continue;
    }

    const drawn: Observation = { t, conversion: conversionOf(X), T: observation.T };
    const calibration = calibrate(model, candidate, { observations: [drawn] });
    if (!calibration.ok) {
      markAllUnreachable();
      continue;
    }

    targets.forEach((target, j) => {
      if (target.X >= ceiling) {
        unreachable[j] = (unreachable[j] as number) + 1;
        return;
      }
      const predicted = timeAt(model, candidate, calibration.value.K, target);
      if (predicted.ok && Number.isFinite(predicted.value)) {
        (collected[j] as number[]).push(predicted.value);
      } else {
        unreachable[j] = (unreachable[j] as number) + 1;
      }
    });
  }

  const at = (p: number): readonly (number | null)[] =>
    collected.map((values) =>
      values.length === 0 ? null : quantile([...values].sort((a, b) => a - b), p),
    );

  const fractions = unreachable.map((count) => (samples === 0 ? 0 : count / samples));
  const warnings: Warning[] = [];
  const worst = Math.max(0, ...fractions);
  if (worst > 0.01) {
    warnings.push(
      warning(
        'MONTE_CARLO_UNREACHABLE_DRAWS',
        'warning',
        `In ${percent(worst)} of the resampled draws the target conversion was not reachable at all. The percentiles are computed only over the draws where it was, so they describe the reachable cases rather than the full range of outcomes.`,
        { unreachableFraction: fractions },
      ),
    );
  }

  return {
    p5: at(0.05),
    p50: at(0.5),
    p95: at(0.95),
    samples,
    unreachableFraction: fractions,
    seed,
    warnings,
  };
};
