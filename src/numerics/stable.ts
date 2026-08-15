import { SERIES_CUTOFF, SERIES_TERMS } from '../domain/constants.ts';

/**
 * Removable-singularity primitives.
 *
 * The spec (§8) asks for the n→1 and M→1 singularities to be guarded with a
 * `|x−1| < 1e-9` branch. Measured, that branch is worse than the floats it replaces:
 * it freezes g over a 2e-9-wide plateau of exactly zero gradient (g(0.999) returns the
 * identical double for n = 1−1e-9 … 1+1e-10, so g stops being monotone in n) and steps
 * by 3.45e-9 relative at the branch edge, roughly 3400x the 1e-12 tolerance budget.
 * A flat plateau also stalls golden-section and undefines Brent's interpolation, and
 * the order fit searches n ∈ [0,6], crossing n=1 on every call: two-point recovery of
 * n=1 returns 0.999999999 through the branch and exactly 1 through these primitives.
 *
 * The fix is to branch on the magnitude of a *series argument*, a local, numerically
 * motivated choice whose value is continuous across the switch, and never on a model
 * parameter. Both forms below are smooth and exact at z = 0.
 */

/** expm1(z)/z, continuous at z = 0 where it equals 1. */
export const expm1OverX = (z: number): number => {
  if (Math.abs(z) >= SERIES_CUTOFF) return Math.expm1(z) / z;
  // Σ z^k/(k+1)! , converged well before term 12 at |z| = 0.25.
  let term = 1;
  let sum = 1;
  for (let k = 1; k < SERIES_TERMS; k += 1) {
    term *= z / (k + 1);
    sum += term;
  }
  return sum;
};

/** log1p(z)/z, continuous at z = 0 where it equals 1. */
export const log1pOverX = (z: number): number => {
  if (Math.abs(z) >= SERIES_CUTOFF) return Math.log1p(z) / z;
  // Σ (−1)^k z^k/(k+1), the slower series; term 25 is 3.4e-17 at |z| = 0.25.
  let power = 1;
  let sum = 1;
  for (let k = 1; k < SERIES_TERMS; k += 1) {
    power *= -z;
    sum += power / (k + 1);
  }
  return sum;
};

/**
 * (1 − X)^a − 1, evaluated from the remaining fraction so it stays exact deep into the
 * ladder. Never materializes an intermediate power, which is also the §8 G9 overflow
 * guard: at large n with X → 1 the direct form overflows, this does not.
 */
export const remainingPowM1 = (remaining: number, a: number): number =>
  Math.expm1(a * Math.log(remaining));
