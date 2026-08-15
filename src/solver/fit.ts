import type {
  KineticModel,
  KineticsError,
  Observation,
  ParamSpec,
  Params,
  ParamValue,
  Warning,
} from '../domain/types.ts';
import { kineticsError, warning } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';
import { FIT_RTOL, SCAN_POINTS } from '../domain/constants.ts';
import { bisect, bracketRoot, goldenSectionMin } from '../numerics/roots.ts';
import { calibrate } from './calibrate.ts';

/** Where each resolved parameter value came from. */
export type ParamSource = 'given' | 'default' | 'fitted';

export interface ResolvedParams {
  readonly params: Params;
  readonly sources: Readonly<Record<string, ParamSource>>;
  /** Keys the request left null, i.e. asked to be fitted. */
  readonly free: readonly string[];
}

/** `null` on a parameter means "fit it"; absent means "use the model default". */
export const resolveParameters = (
  model: KineticModel,
  requested: Readonly<Record<string, ParamValue | null | undefined>>,
): ResolvedParams => {
  const params: Record<string, ParamValue> = {};
  const sources: Record<string, ParamSource> = {};
  const free: string[] = [];

  for (const spec of model.params) {
    const supplied = requested[spec.key];
    if (supplied === null) {
      params[spec.key] = spec.default;
      sources[spec.key] = 'fitted';
      free.push(spec.key);
    } else if (supplied === undefined) {
      params[spec.key] = spec.default;
      sources[spec.key] = 'default';
    } else {
      params[spec.key] = supplied;
      sources[spec.key] = 'given';
    }
  }
  return { params, sources, free };
};

/**
 * Identifiability is a rank condition, not a count.
 *
 * The unknowns are K plus every free parameter. Duplicated points, or two points at the
 * same conversion, add rows without adding information, counting raw observations
 * would call such a request identified when it is not. Guard G13 (Michaelis-Menten with
 * a single point) falls straight out of this arithmetic rather than naming that model.
 */
export const countIndependent = (observations: readonly Observation[]): number => {
  const distinct = new Set(observations.map((o) => o.conversion.X.toPrecision(12)));
  return distinct.size;
};

export interface FitResult {
  readonly params: Params;
  readonly sources: Readonly<Record<string, ParamSource>>;
  readonly identifiable: boolean;
  readonly rSquared: number | null;
  readonly residuals: readonly number[];
  /** Ranked candidates for a categorical parameter, best first. */
  readonly candidates?: readonly { readonly value: string; readonly sse: number }[];
  readonly warnings: readonly Warning[];
}

const withParam = (base: Params, key: string, value: ParamValue): Params => ({
  ...base,
  [key]: value,
});

/** Σ(tᵢ − g(Xᵢ)/K)² with K profiled out by the same closed form `calibrate` uses. */
const sumSquaredTimeError = (
  model: KineticModel,
  p: Params,
  observations: readonly Observation[],
): number => {
  const calibration = calibrate(model, p, { observations });
  if (!calibration.ok) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (const o of observations) {
    const predicted = model.g(o.conversion, p) / calibration.value.K;
    if (!Number.isFinite(predicted)) return Number.POSITIVE_INFINITY;
    total += (o.t - predicted) ** 2;
  }
  return total;
};

/**
 * The admissible interval for a free parameter is narrower than its declared domain,
 * because the data constrain it too: a model whose ceiling sits below an observed
 * conversion evaluates to NaN everywhere. Scanning for the feasible span keeps the
 * search inside the region where the objective actually exists.
 */
const feasibleSpan = (
  model: KineticModel,
  base: Params,
  key: string,
  domain: Extract<ParamSpec['domain'], { kind: 'continuous' }>,
  observations: readonly Observation[],
): { readonly lo: number; readonly hi: number; readonly islands: number } | null => {
  const step = (domain.max - domain.min) / (SCAN_POINTS - 1);
  const usable: number[] = [];
  let islands = 0;
  let previousUsable = false;

  for (let i = 0; i < SCAN_POINTS; i += 1) {
    const v = domain.min + i * step;
    const p = withParam(base, key, v);
    const ceiling = model.Xmax(p);
    const fits = observations.every(
      (o) => o.conversion.X < ceiling && Number.isFinite(model.g(o.conversion, p)),
    );
    if (fits) {
      usable.push(v);
      if (!previousUsable) islands += 1;
    }
    previousUsable = fits;
  }
  if (usable.length === 0) return null;
  return { lo: usable[0] as number, hi: usable[usable.length - 1] as number, islands };
};

/**
 * Exactly-determined fit: solve g(X₂)/g(X₁) = t₂/t₁ for the free parameter.
 *
 * Root-finding rather than minimising, because a sign change is a *certificate* that a
 * solution exists. The achievable ratio range is bounded, for nth-order with X₁=0.5,
 * X₂=0.9 over n ∈ [0,6] it spans only [1.800, 3225.77], so ordinary noisy data can
 * imply a ratio no parameter value can produce. A minimiser would return the boundary
 * with a small-looking residual; this reports that the data are inconsistent with the
 * model, and says what range the model can actually express.
 */
const solveByRatio = (
  model: KineticModel,
  base: Params,
  key: string,
  lo: number,
  hi: number,
  first: Observation,
  second: Observation,
): Result<number, KineticsError> => {
  const targetRatio = second.t / first.t;
  const ratioAt = (v: number): number => {
    const p = withParam(base, key, v);
    return model.g(second.conversion, p) / model.g(first.conversion, p);
  };
  const residual = (v: number): number => ratioAt(v) - targetRatio;

  const bracket = bracketRoot(residual, lo, hi);
  if (bracket === null) {
    const ends = [ratioAt(lo), ratioAt(hi)].filter(Number.isFinite).sort((a, b) => a - b);
    const low = ends[0];
    const high = ends[ends.length - 1];
    return err(
      kineticsError(
        'RATIO_OUTSIDE_ACHIEVABLE_RANGE',
        `These two measurements imply a time ratio of ${targetRatio.toPrecision(4)}, which this model cannot produce for any value of ${key} in its range (it spans only ${low?.toPrecision(4) ?? '?'} to ${high?.toPrecision(4) ?? '?'}). The data and the model disagree; a different model is needed.`,
        { targetRatio, achievable: ends, param: key },
      ),
    );
  }
  return bisect(residual, bracket, FIT_RTOL);
};

const rSquaredOf = (sse: number, observations: readonly Observation[]): number | null => {
  if (observations.length < 3) return null;
  const mean = observations.reduce((a, o) => a + o.t, 0) / observations.length;
  const totals = observations.reduce((a, o) => a + (o.t - mean) ** 2, 0);
  return totals === 0 ? 1 : 1 - sse / totals;
};

const residualsOf = (
  model: KineticModel,
  p: Params,
  observations: readonly Observation[],
): readonly number[] => {
  const calibration = calibrate(model, p, { observations });
  if (!calibration.ok) return [];
  return observations.map((o) => o.t - model.g(o.conversion, p) / calibration.value.K);
};

/** Enumerates a categorical parameter, a handful of options is a search, not an optimisation. */
const fitCategorical = (
  model: KineticModel,
  base: Params,
  key: string,
  options: readonly string[],
  observations: readonly Observation[],
): { readonly best: string; readonly ranked: readonly { value: string; sse: number }[] } => {
  const ranked = options
    .map((value) => ({
      value,
      sse: sumSquaredTimeError(model, withParam(base, key, value), observations),
    }))
    .sort((a, b) => a.sse - b.sse);
  return { best: (ranked[0] as { value: string }).value, ranked };
};

/**
 * Fits the one free parameter, if there is one.
 *
 * Deliberately supports at most a single free parameter: with two, this becomes a 2-D
 * search, which the spec rules out and which is genuinely ill-advised here, the result
 * would be a confident-looking pair of values with no identifiability behind them.
 */
export const fitFreeParameter = (
  model: KineticModel,
  resolved: ResolvedParams,
  observations: readonly Observation[],
): Result<FitResult, KineticsError> => {
  const warnings: Warning[] = [];
  const independent = countIndependent(observations);
  const unknowns = resolved.free.length + 1; // + K

  if (resolved.free.length === 0) {
    const sse = sumSquaredTimeError(model, resolved.params, observations);
    return ok({
      params: resolved.params,
      sources: resolved.sources,
      identifiable: false,
      rSquared: rSquaredOf(sse, observations),
      residuals: residualsOf(model, resolved.params, observations),
      warnings,
    });
  }

  if (resolved.free.length > 1) {
    return err(
      kineticsError(
        'G13_UNDERDETERMINED',
        `Two or more parameters (${resolved.free.join(', ')}) were left to be fitted at once. That is a two-dimensional search with no identifiability from conversion-time data alone, fix all but one of them and re-run.`,
        { free: resolved.free },
      ),
    );
  }

  const key = resolved.free[0] as string;
  const spec = model.params.find((s) => s.key === key) as ParamSpec;

  if (independent < unknowns) {
    /**
     * Not enough data to determine the parameter. There are two honest responses, and
     * which one applies is declared by the registry rather than decided here.
     *
     * If the parameter has a plausible-value ladder, the answer is that ladder: the data
     * genuinely do fit every value on it, and reporting the spread is more useful, and
     * more truthful, than refusing (§5 A2). If it has no declared ladder there is no
     * principled set of values to sweep, so the only honest answer is to ask for more
     * information (G13).
     */
    if (spec.bandValues === undefined) {
      return err(
        kineticsError(
          'G13_UNDERDETERMINED',
          `Fitting ${key} together with the rate constant needs at least ${unknowns} measurements at distinct conversions, but only ${independent} ${independent === 1 ? 'was' : 'were'} supplied. Either supply ${key} directly or add another measurement.`,
          { required: unknowns, independent, param: key },
        ),
      );
    }
    const sse = sumSquaredTimeError(model, resolved.params, observations);
    return ok({
      params: resolved.params,
      sources: { ...resolved.sources, [key]: 'default' },
      identifiable: false,
      rSquared: rSquaredOf(sse, observations),
      residuals: residualsOf(model, resolved.params, observations),
      warnings: [
        warning(
          'ORDER_ASSUMED_NOT_FITTED',
          'loud',
          `${spec.label} cannot be determined from ${independent} measurement${independent === 1 ? '' : 's'}; every value in its plausible range fits the data exactly. The result below is the band across that range, which is the honest answer; there is no single number to report.`,
          { param: key, independent, required: unknowns },
        ),
      ],
    });
  }

  if (spec.domain.kind === 'categorical') {
    const { best, ranked } = fitCategorical(
      model,
      resolved.params,
      key,
      spec.domain.options,
      observations,
    );
    const bestSse = (ranked[0] as { sse: number }).sse;
    const allEqual = ranked.every((r) => Math.abs(r.sse - bestSse) < FIT_RTOL);
    if (allEqual) {
      warnings.push(
        warning(
          'CATEGORICAL_UNIDENTIFIED',
          'loud',
          `Every available option for ${key} fits these measurements equally well, so the choice is not determined by the data. The reported option is arbitrary; add measurements at other conversions to tell them apart.`,
          { options: ranked.map((r) => r.value) },
        ),
      );
    }
    const params = withParam(resolved.params, key, best);
    const sse = sumSquaredTimeError(model, params, observations);
    return ok({
      params,
      sources: resolved.sources,
      identifiable: !allEqual,
      rSquared: rSquaredOf(sse, observations),
      residuals: residualsOf(model, params, observations),
      candidates: ranked,
      warnings,
    });
  }

  const span = feasibleSpan(model, resolved.params, key, spec.domain, observations);
  if (span === null) {
    return err(
      kineticsError(
        'NO_FEASIBLE_DOMAIN',
        `No value of ${key} in this model's range can represent all of the supplied measurements: at every value, at least one observation sits at or beyond the model's conversion ceiling.`,
        { param: key },
      ),
    );
  }
  if (span.islands > 1) {
    warnings.push(
      warning(
        'G17_ILL_CONDITIONED_FIT',
        'warning',
        `The admissible range for ${key} is not contiguous, so the fitted value depends on where the search began. Treat it as indicative.`,
        { param: key, islands: span.islands },
      ),
    );
  }

  const ordered = [...observations].sort((a, b) => a.t - b.t);
  const exactlyDetermined = independent === unknowns && ordered.length === 2;

  let fitted: number;
  if (exactlyDetermined) {
    const [first, second] = ordered as [Observation, Observation];
    const gap = Math.abs(second.conversion.X - first.conversion.X);
    if (gap < 1e-6) {
      return err(
        kineticsError(
          'G13_UNDERDETERMINED',
          `The two measurements sit at essentially the same conversion (${(first.conversion.X * 100).toFixed(4)}% and ${(second.conversion.X * 100).toFixed(4)}%), which cannot determine ${key}. Measure at a clearly different conversion.`,
          { param: key, gap },
        ),
      );
    }
    const solved = solveByRatio(model, resolved.params, key, span.lo, span.hi, first, second);
    if (!solved.ok) return solved;
    fitted = solved.value;
  } else {
    fitted = goldenSectionMin(
      (v) => sumSquaredTimeError(model, withParam(resolved.params, key, v), observations),
      span.lo,
      span.hi,
      FIT_RTOL,
    );
  }

  const params = withParam(resolved.params, key, fitted);
  const sse = sumSquaredTimeError(model, params, observations);
  return ok({
    params,
    sources: resolved.sources,
    identifiable: true,
    rSquared: rSquaredOf(sse, observations),
    residuals: residualsOf(model, params, observations),
    warnings,
  });
};
