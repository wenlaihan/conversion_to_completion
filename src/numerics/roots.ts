import { BISECTION_MAX_ITERATIONS, FIT_RTOL, SCAN_POINTS } from '../domain/constants.ts';
import { kineticsError, type KineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';

export interface Bracket {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Scans for a sign change of `f` over [lo, hi].
 *
 * A sign change is a *certificate* that a root exists. That matters more than speed
 * here: the achievable range of g(X₂)/g(X₁) is bounded (measured for nth-order over
 * n ∈ [0,6] with X₁=0.5, X₂=0.9, the ratio only spans [1.800, 3225.77]), so data
 * giving t₂/t₁ = 1.5 has no valid order at all. A minimizer would return the n=0
 * boundary with a small-looking residual and hand back a confident wrong answer;
 * requiring a bracket makes "your data is inconsistent with this model" detectable.
 */
export const bracketRoot = (
  f: (x: number) => number,
  lo: number,
  hi: number,
  points: number = SCAN_POINTS,
): Bracket | null => {
  const step = (hi - lo) / (points - 1);
  let prevX = lo;
  let prevY = f(lo);
  if (prevY === 0) return { lo, hi: lo };

  for (let i = 1; i < points; i += 1) {
    const x = i === points - 1 ? hi : lo + i * step;
    const y = f(x);
    if (Number.isFinite(y)) {
      if (y === 0) return { lo: x, hi: x };
      if (Number.isFinite(prevY) && Math.sign(y) !== Math.sign(prevY)) {
        return { lo: prevX, hi: x };
      }
    }
    prevX = x;
    prevY = y;
  }
  return null;
};

/**
 * Bisection on a bracketed root. Converges to the double-precision limit in ~60
 * iterations and cannot diverge, worth more than Brent's speed on a search that runs
 * once per request.
 */
export const bisect = (
  f: (x: number) => number,
  bracket: Bracket,
  rtol: number = FIT_RTOL,
): Result<number, KineticsError> => {
  let { lo, hi } = bracket;
  let flo = f(lo);
  const fhi = f(hi);

  if (lo === hi) return ok(lo);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) {
    return err(
      kineticsError(
        'ROOT_NOT_BRACKETED',
        'The equation could not be evaluated at the search bounds.',
        { lo, hi },
      ),
    );
  }
  if (flo === 0) return ok(lo);
  if (fhi === 0) return ok(hi);
  if (Math.sign(flo) === Math.sign(fhi)) {
    return err(
      kineticsError('ROOT_NOT_BRACKETED', 'No solution exists between the search bounds.', {
        lo,
        hi,
      }),
    );
  }

  for (let i = 0; i < BISECTION_MAX_ITERATIONS; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break; // adjacent doubles: cannot subdivide further
    const fmid = f(mid);
    if (fmid === 0) return ok(mid);
    if (Math.sign(fmid) === Math.sign(flo)) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
    }
    if (Math.abs(hi - lo) <= rtol * Math.max(1, Math.abs(mid))) break;
  }
  return ok(0.5 * (lo + hi));
};

const INV_PHI = (Math.sqrt(5) - 1) / 2;

/**
 * Golden-section minimization on [lo, hi]. Used only for over-determined fits, where
 * there is no exact root to certify and a least-squares minimum is the right answer.
 */
export const goldenSectionMin = (
  f: (x: number) => number,
  lo: number,
  hi: number,
  rtol: number = FIT_RTOL,
): number => {
  let a = lo;
  let b = hi;
  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = f(c);
  let fd = f(d);

  for (let i = 0; i < BISECTION_MAX_ITERATIONS; i += 1) {
    if (Math.abs(b - a) <= rtol * Math.max(1, Math.abs(a) + Math.abs(b))) break;
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - INV_PHI * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + INV_PHI * (b - a);
      fd = f(d);
    }
  }
  return 0.5 * (a + b);
};
