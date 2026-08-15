import { BISECTION_MAX_ITERATIONS } from '../domain/constants.ts';

/* ------------------------------------------------------------------ *
 * Quantiles
 * ------------------------------------------------------------------ */

/**
 * Type-7 (linear interpolation) quantile, the definition is pinned deliberately:
 * nearest-rank and interpolated definitions differ enough to make reported intervals
 * flap between runs, which would undermine the golden expectations.
 */
export const quantile = (sorted: readonly number[], p: number): number => {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0] as number;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  const frac = h - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
};

/* ------------------------------------------------------------------ *
 * Student-t quantiles, via the regularized incomplete beta
 * ------------------------------------------------------------------ */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;

const logGamma = (z: number): number => {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < LANCZOS.length; i += 1) a += (LANCZOS[i] as number) / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
};

/** Continued fraction for the incomplete beta (modified Lentz). */
const betaContinuedFraction = (a: number, b: number, x: number): number => {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= BISECTION_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    const aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;

    const bb = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + bb * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + bb / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
};

/** Regularized incomplete beta I_x(a, b). */
export const incompleteBeta = (a: number, b: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
};

/** CDF of Student's t with `df` degrees of freedom. */
export const studentTCdf = (t: number, df: number): number => {
  const p = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? 1 - p : p;
};

/**
 * Inverse CDF of Student's t.
 *
 * Computed rather than tabulated: a hardcoded table would be a wall of magic numbers
 * supporting exactly one confidence level. Reference values live in the tests, which is
 * where hardcoded constants belong.
 */
export const studentTInv = (p: number, df: number): number => {
  if (df <= 0) return Number.NaN;
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < BISECTION_MAX_ITERATIONS; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(mid))) break;
  }
  return 0.5 * (lo + hi);
};

/* ------------------------------------------------------------------ *
 * Ordinary least squares
 * ------------------------------------------------------------------ */

export interface Regression {
  readonly slope: number;
  readonly intercept: number;
  readonly rSquared: number;
  /** Standard error of the slope. NaN when df = 0 (an exactly determined fit). */
  readonly slopeStdErr: number;
  readonly df: number;
}

/** OLS of y on x. With two points the fit is exact and df = 0, no interval exists. */
export const linearRegression = (
  xs: readonly number[],
  ys: readonly number[],
): Regression | null => {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - meanX;
    const dy = (ys[i] as number) - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const ssResidual = Math.max(syy - slope * sxy, 0);
  const df = n - 2;
  const slopeStdErr = df > 0 ? Math.sqrt(ssResidual / df / sxx) : Number.NaN;
  const rSquared = syy === 0 ? 1 : 1 - ssResidual / syy;
  return { slope, intercept, rSquared, slopeStdErr, df };
};
