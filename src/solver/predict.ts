import type { Conversion, KineticModel, KineticsError, Params, Seconds } from '../domain/types.ts';
import { kineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';
import { BISECTION_MAX_ITERATIONS, BISECTION_RTOL, MIN_REMAINING } from '../domain/constants.ts';

/**
 * Model-agnostic prediction. Written once; nothing here knows which model it holds.
 *
 * Conversions are built from their distance to the ceiling rather than from X, so the
 * remaining fraction stays exact where it matters. At a ceiling of 1 the gap *is* the
 * remaining fraction, which is what keeps the 99.9…% end of the ladder accurate.
 */

export const conversionFromGap = (gap: number, ceiling: number): Conversion => ({
  X: ceiling - gap,
  remaining: 1 - ceiling + gap,
});

/** Largest conversion this model can be evaluated at without touching the singularity. */
export const largestEvaluable = (ceiling: number): Conversion =>
  conversionFromGap(MIN_REMAINING, ceiling);

/** t = g(X)/K. */
export const timeAt = (
  model: KineticModel,
  p: Params,
  K: number,
  c: Conversion,
): Result<Seconds, KineticsError> => {
  const value = model.g(c, p);
  if (!Number.isFinite(value)) {
    return err(
      kineticsError(
        'G3_TARGET_ABOVE_CEILING',
        `This model cannot reach a conversion of ${(c.X * 100).toFixed(4)}%.`,
        { X: c.X },
      ),
    );
  }
  return ok(value / K);
};

/**
 * X such that g(X) = K·t.
 *
 * Uses the model's closed-form inverse when it declares one, otherwise bisects on
 * ln(gap-to-ceiling): searching in log space is what makes the deep end reachable at
 * all, since a linear search on X cannot resolve below ~1e-16 of the ceiling.
 */
export const conversionAt = (
  model: KineticModel,
  p: Params,
  K: number,
  t: Seconds,
): Result<Conversion, KineticsError> => {
  const ceiling = model.Xmax(p);
  const tau = K * t;
  if (tau <= 0) return ok(conversionFromGap(ceiling, ceiling)); // X = 0

  if (model.gInv !== undefined) {
    const X = model.gInv(tau, p);
    if (Number.isFinite(X)) {
      const clamped = Math.min(Math.max(X, 0), ceiling);
      return ok({ X: clamped, remaining: 1 - clamped });
    }
  }

  const edge = largestEvaluable(ceiling);
  const gEdge = model.g(edge, p);
  if (Number.isFinite(gEdge) && tau >= gEdge) return ok(edge);

  // f(s) = g(ceiling − e^s) − τ, decreasing in s.
  const f = (s: number): number => model.g(conversionFromGap(Math.exp(s), ceiling), p) - tau;
  let lo = Math.log(MIN_REMAINING);
  let hi = Math.log(ceiling);
  if (!(f(lo) > 0) || !(f(hi) < 0)) {
    return err(
      kineticsError(
        'ROOT_NOT_BRACKETED',
        'Could not invert the conversion-time function for this time.',
        { t, tau },
      ),
    );
  }

  for (let i = 0; i < BISECTION_MAX_ITERATIONS; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo <= BISECTION_RTOL * Math.max(1, Math.abs(mid))) break;
  }
  return ok(conversionFromGap(Math.exp(0.5 * (lo + hi)), ceiling));
};

export interface CurvePoint {
  readonly t: Seconds;
  readonly X: number;
}

/**
 * Sampled X(t) for plotting, log-spaced in time so the early rise and the long tail are
 * both resolved. `fractionOfCeiling` keeps the request meaningful for capped models,
 * where an absolute conversion target may sit above the ceiling entirely.
 */
export const curve = (
  model: KineticModel,
  p: Params,
  K: number,
  points: number,
  fractionOfCeiling: number,
): Result<readonly CurvePoint[], KineticsError> => {
  const ceiling = model.Xmax(p);
  const gap = Math.max(ceiling * (1 - fractionOfCeiling), MIN_REMAINING);
  const end = timeAt(model, p, K, conversionFromGap(gap, ceiling));
  if (!end.ok) return end;

  const tEnd = end.value;
  if (!Number.isFinite(tEnd) || tEnd <= 0) return ok([{ t: 0, X: 0 }]);

  const first = tEnd * 1e-4;
  const samples: CurvePoint[] = [{ t: 0, X: 0 }];
  for (let i = 0; i < points; i += 1) {
    const t = first * Math.pow(tEnd / first, i / Math.max(points - 1, 1));
    const c = conversionAt(model, p, K, t);
    if (!c.ok) return c;
    samples.push({ t, X: c.value.X });
  }
  return ok(samples);
};
