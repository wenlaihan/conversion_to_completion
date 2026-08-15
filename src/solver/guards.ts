import type {
  Conversion,
  KineticModel,
  Observation,
  Params,
  Seconds,
  Warning,
} from '../domain/types.ts';
import { warning } from '../domain/types.ts';
import { EXTRAPOLATION_WARN_FACTOR } from '../domain/constants.ts';
import { suggestionFor } from '../models/registry.ts';

/**
 * The advisory guards, the ones that let a calculation proceed but must not let it
 * proceed quietly. Guards that make an answer impossible rather than merely doubtful
 * (a zero conversion, an observation above the ceiling, an underdetermined fit) are
 * enforced where the impossibility arises, as typed errors.
 */

/** One year in seconds, for judging when a predicted time has stopped meaning anything. */
const SECONDS_PER_YEAR = 31_556_952;
const ABSURD_YEARS = 1e6;

/**
 * G16, conversion that falls as time increases.
 *
 * Fitting straight through this would be the silent failure the spec warns about: the
 * data are saying the mechanism is not what was assumed. Flagged loudly, with the
 * alternative supplied by the registry rather than named here.
 */
export const checkMonotonicity = (observations: readonly Observation[]): readonly Warning[] => {
  const byTime = [...observations].sort((a, b) => a.t - b.t);
  const drops: { from: number; to: number }[] = [];
  for (let i = 1; i < byTime.length; i += 1) {
    const previous = byTime[i - 1] as Observation;
    const current = byTime[i] as Observation;
    if (current.conversion.X < previous.conversion.X - 1e-6) {
      drops.push({ from: previous.conversion.X, to: current.conversion.X });
    }
  }
  if (drops.length === 0) return [];
  const suggestion = suggestionFor('non-monotone');
  return [
    warning(
      'G16_NON_MONOTONE',
      'loud',
      `Conversion falls with time in these measurements (${drops.map((d) => `${(d.from * 100).toFixed(1)}% to ${(d.to * 100).toFixed(1)}%`).join(', ')}). An irreversible rate law cannot do that, so the fit below is describing data it does not match. This usually means the reaction is approaching an equilibrium, or a side reaction is consuming product. Consider the "${suggestion.label}" model instead.`,
      { drops, suggestedModel: suggestion.key },
    ),
  ];
};

/**
 * G10, how far beyond the measurement the prediction reaches.
 *
 * g(X_target)/g(X₁) is the honest measure of extrapolation, and past a factor of ten it
 * is where kinetic predictions actually fail in practice.
 */
export const checkExtrapolation = (
  model: KineticModel,
  params: Params,
  observations: readonly Observation[],
  targets: readonly Conversion[],
): readonly Warning[] => {
  if (observations.length === 0 || targets.length === 0) return [];
  const deepest = observations.reduce((a, b) => (a.conversion.X > b.conversion.X ? a : b));
  const gObserved = model.g(deepest.conversion, params);
  if (!Number.isFinite(gObserved) || gObserved <= 0) return [];

  let worst = 0;
  let worstX = 0;
  for (const target of targets) {
    const gTarget = model.g(target, params);
    if (!Number.isFinite(gTarget)) continue;
    const factor = gTarget / gObserved;
    if (factor > worst) {
      worst = factor;
      worstX = target.X;
    }
  }
  if (worst <= EXTRAPOLATION_WARN_FACTOR) return [];
  return [
    warning(
      'G10_FAR_EXTRAPOLATION',
      'loud',
      `Reaching ${(worstX * 100).toFixed(2)}% conversion is a factor of ${worst.toFixed(1)} further along the reaction than the measurement at ${(deepest.conversion.X * 100).toFixed(1)}%. Extrapolating this far past the data is exactly where kinetic predictions fail: the rate law that fits the early points need not hold to the end.`,
      { factor: worst, targetX: worstX, observedX: deepest.conversion.X },
    ),
  ];
};

/** G6, a target below what has already been measured is a back-extrapolation. */
export const checkBackExtrapolation = (
  observations: readonly Observation[],
  targets: readonly Conversion[],
): readonly Warning[] => {
  if (observations.length === 0) return [];
  const earliest = observations.reduce((a, b) => (a.conversion.X < b.conversion.X ? a : b));
  const behind = targets.filter((t) => t.X < earliest.conversion.X);
  if (behind.length === 0) return [];
  return [
    warning(
      'G6_BACK_EXTRAPOLATION',
      'info',
      `Some targets (${behind.map((t) => `${(t.X * 100).toFixed(1)}%`).join(', ')}) are below the earliest measured conversion of ${(earliest.conversion.X * 100).toFixed(1)}%, so those times are extrapolated backwards to before the measurement.`,
      { targets: behind.map((t) => t.X) },
    ),
  ];
};

/** G8, a parameter below the range its model considers physically ordinary. */
export const checkParameters = (model: KineticModel, params: Params): readonly Warning[] => {
  const warnings: Warning[] = [];
  for (const spec of model.params) {
    const value = params[spec.key];
    if (typeof value !== 'number' || spec.unusualBelow === undefined) continue;
    if (value < spec.unusualBelow) {
      warnings.push(
        warning(
          'G8_NEGATIVE_ORDER',
          'warning',
          `${spec.label} came out at ${value.toPrecision(4)}, below the usual range for this model. That is mathematically valid and the numbers below are computed from it, but it is physically unusual, often a sign of inhibition, a changing mechanism, or measurement error.`,
          { param: spec.key, value },
        ),
      );
    }
  }
  return warnings;
};

/**
 * G9, times so long that reporting them to any precision is misleading.
 *
 * The overflow this guard exists for is prevented upstream, since g is evaluated in log
 * space and never forms an intermediate (1−X)^(1−n). What survives is a presentation
 * problem: at n = 3 the time to 99.9% is already about 10⁷ hours.
 */
export const checkMagnitudes = (
  times: readonly (Seconds | null)[],
  labels: readonly number[],
): readonly Warning[] => {
  const absurd: number[] = [];
  times.forEach((t, i) => {
    if (t !== null && t / SECONDS_PER_YEAR > ABSURD_YEARS) absurd.push(labels[i] ?? 0);
  });
  if (absurd.length === 0) return [];
  return [
    warning(
      'G9_CLAMPED_DISPLAY',
      'warning',
      `Reaching ${absurd.map((x) => `${(x * 100).toFixed(2)}%`).join(', ')} would take longer than a million years at this rate. The figure is arithmetically correct but has no practical meaning, read it as "does not happen" rather than as a schedule.`,
      { targets: absurd },
    ),
  ];
};

/** Raised whenever a shape parameter was assumed rather than measured (§11). */
export const assumedParameterWarning = (
  model: KineticModel,
  key: string,
  spreadFactor: number | null,
): Warning => {
  const spec = model.params.find((s) => s.key === key);
  const label = spec?.label ?? key;
  const spread =
    spreadFactor === null || !Number.isFinite(spreadFactor)
      ? ''
      : ` Across the plausible range it spans a factor of ${spreadFactor.toFixed(1)} in predicted time.`;
  return warning(
    'ORDER_ASSUMED_NOT_FITTED',
    'loud',
    `${label} was assumed, not determined from the data, so the single time below is only as good as that assumption.${spread} The band is the result; the point estimate is one line through it.`,
    { param: key, spreadFactor },
  );
};
