import {
  QUADRATURE_MAX_DEPTH,
  QUADRATURE_MAX_EVALUATIONS,
  QUADRATURE_RTOL,
  SERIES_CUTOFF,
} from '../domain/constants.ts';
import { kineticsError, type KineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';

interface Counter {
  count: number;
}

const simpson = (f: (x: number) => number, a: number, b: number, c: Counter): number => {
  c.count += 3;
  return ((b - a) / 6) * (f(a) + 4 * f(0.5 * (a + b)) + f(b));
};

/**
 * `tol` is an ABSOLUTE error budget, halved as it is split between the two halves.
 * Scaling it by the local magnitude *and* halving it per level would compound: at the
 * ~30 levels needed to resolve s→1 from an interval of width 1e9, a relative budget
 * becomes ~1e-19 and can never be met in double precision, so the recursion runs until
 * it exhausts the evaluation budget on an integrand that is perfectly smooth.
 */
const refine = (
  f: (x: number) => number,
  a: number,
  b: number,
  whole: number,
  tol: number,
  depth: number,
  c: Counter,
): number | null => {
  if (c.count > QUADRATURE_MAX_EVALUATIONS) return null;
  const mid = 0.5 * (a + b);
  const left = simpson(f, a, mid, c);
  const right = simpson(f, mid, b, c);
  const delta = left + right - whole;
  if (depth <= 0 || Math.abs(delta) <= 15 * tol) {
    return left + right + delta / 15;
  }
  const l = refine(f, a, mid, left, tol * 0.5, depth - 1, c);
  if (l === null) return null;
  const r = refine(f, mid, b, right, tol * 0.5, depth - 1, c);
  if (r === null) return null;
  return l + r;
};

/** Adaptive Simpson with a hard evaluation budget, never a silently truncated recursion. */
export const integrate = (
  f: (x: number) => number,
  a: number,
  b: number,
  rtol: number = QUADRATURE_RTOL,
): Result<number, KineticsError> => {
  if (a === b) return ok(0);
  const counter: Counter = { count: 0 };
  const whole = simpson(f, a, b, counter);
  // Two-level estimate of the integral's magnitude, so the relative contract can be
  // turned into the absolute budget `refine` splits. Taking the max of the one- and
  // two-panel estimates keeps the budget honest when the coarse panel underestimates.
  const mid = 0.5 * (a + b);
  const twoPanel = simpson(f, a, mid, counter) + simpson(f, mid, b, counter);
  const scale = Math.max(Math.abs(whole), Math.abs(twoPanel), Number.MIN_VALUE);
  const value = refine(f, a, b, whole, rtol * scale, QUADRATURE_MAX_DEPTH, counter);
  if (value === null || !Number.isFinite(value)) {
    return err(
      kineticsError(
        'QUADRATURE_BUDGET_EXCEEDED',
        'The integral for this model could not be evaluated to the required accuracy.',
        { a, b, evaluations: counter.count },
      ),
    );
  }
  return ok(value);
};

/**
 * ∫₀ˣ h(u)·(1−u)^(−n) du, with the endpoint singularity removed by substitution.
 *
 * Attacking the raw integrand with a better *rule* is the wrong move, the algebraic
 * endpoint singularity is the entire problem. Measured against raw adaptive Simpson at
 * rtol 1e-12, substituting costs 9 evaluations where the raw form costs 923,319
 * (n=0.5, X=1−1e-12) or 7,923,051 (n=2, X=1−1e-12). At n=2 the raw form is not merely
 * slow but wrong: 1.000022119e12 against an exact 1.000022122e12, a 3e-9 relative error
 * that breaches the 1e-10 contract after all those evaluations.
 *
 * Two charts, selected by the magnitude of a series argument rather than by any model
 * parameter:
 *   |1−n| ≥ cutoff   s = (1−u)^(1−n)  maps the singularity to a finite bounded interval
 *   |1−n| < cutoff   w = −ln(1−u)     avoids s^(1/(1−n)) blowing up as 1−n → 0
 */
export const integrateEndpointSingular = (
  h: (u: number) => number,
  remaining: number,
  n: number,
  rtol: number = QUADRATURE_RTOL,
): Result<number, KineticsError> => {
  if (remaining >= 1) return ok(0);
  const p = 1 - n;

  if (Math.abs(p) < SERIES_CUTOFF) {
    // w = −ln(1−u):  ∫₀^W h(1−e^(−w))·e^((n−1)w) dw.  At n=1 the exponential is 1,
    // which is exactly why var-volume is ε-independent there.
    const W = -Math.log(remaining);
    return integrate((w) => h(-Math.expm1(-w)) * Math.exp(-p * w), 0, W, rtol);
  }

  // s = (1−u)^p, u = 1 − s^(1/p); du·(1−u)^(−n) = −ds/p.
  const sX = Math.exp(p * Math.log(remaining));
  const lo = Math.min(sX, 1);
  const hi = Math.max(sX, 1);
  const inner = integrate((s) => h(-Math.expm1(Math.log(s) / p)), lo, hi, rtol);
  return inner.ok ? ok(inner.value / Math.abs(p)) : inner;
};
