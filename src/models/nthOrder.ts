import type { Conversion, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { expm1OverX, log1pOverX } from '../numerics/stable.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_N = 1;

const order = (p: Params): number => num(p, 'n', DEFAULT_N);

/**
 * nth-order kinetics, the default model.
 *
 *   g(X) = ∫₀ˣ du/(1−u)ⁿ = [(1−X)^(1−n) − 1]/(n−1),  and −ln(1−X) at n = 1.
 *
 * Both regimes are one expression here. Writing `−L · expm1OverX((1−n)L)` with
 * L = ln(1−X) is exact at n = 1 and smooth through it, so g stays monotone in n and
 * the order fit (which crosses n = 1 on every call) keeps full precision.
 * Evaluating L from the stored remaining fraction rather than `log1p(−X)` is what
 * keeps the deep end of the ladder (99.999…%) accurate.
 *
 * Subsumes contracting-area (n = 1/2) and contracting-sphere (n = 2/3).
 */
export const nthOrder: KineticModel = {
  key: 'nth-order',
  label: 'nth-order',
  timeQuantity: 'batchTime',
  notes:
    'Default model; subsumes contracting-area (n=1/2), contracting-sphere (n=2/3) and first-order (n=1).',

  params: [
    continuousParam({
      key: 'n',
      symbol: 'n',
      label: 'Reaction order',
      default: DEFAULT_N,
      // Negative orders are mathematically valid and physically unusual (G8): admitted
      // here so the engine computes and warns rather than refusing.
      min: -2,
      max: 6,
      // The orders worth reporting a band across when n is assumed rather than measured.
      // From one point at 21%/6 h these span t(90%) = 26 h to 203 h, the spread that is
      // the headline result, not a footnote to a point estimate.
      bandValues: [0, 0.5, 1, 1.5, 2],
      unusualBelow: 0,
    }),
  ],

  g: (c: Conversion, p: Params): number => {
    const L = Math.log(c.remaining);
    // The trailing + 0 normalizes the signed zero at X = 0, where −L is −0.
    return -L * expm1OverX((1 - order(p)) * L) + 0;
  },

  /** dg/dX = (1−X)^(−n). */
  gPrime: (c: Conversion, p: Params): number => Math.exp(-order(p) * Math.log(c.remaining)),

  /**
   * Closed-form inverse. Solving [(1−X)^(1−n) − 1]/(n−1) = τ for the remaining fraction
   * gives (1−X) = exp(−τ·log1pOverX((n−1)τ)), which collapses to exp(−τ) at n = 1
   * without a branch.
   */
  gInv: (tau: number, p: Params): number => {
    const n = order(p);
    const a = (n - 1) * tau;
    // a ≤ −1 means τ has passed g(1); for n < 1 that ceiling is finite and reached.
    if (a <= -1) return 1;
    return -Math.expm1(-tau * log1pOverX(a));
  },

  Xmax: (): number => 1,

  limitAtCeiling: (p: Params): Limit => {
    const n = order(p);
    if (n < 1) return { kind: 'finite', value: 1 / (1 - n) };
    if (n === 1) return { kind: 'divergent', rate: 'logarithmic' };
    return { kind: 'divergent', rate: 'power', exponent: n - 1 };
  },

  kFromRateConstant: (k: number, CA0: number, p: Params) => ok(k * Math.pow(CA0, order(p) - 1)),

  describe: (p: Params) => {
    const n = order(p);
    const isFirstOrder = n === 1;
    return [
      {
        kind: 'model' as const,
        plain: 'Batch, constant volume, −r_A = k·C_A^n  ⇒  K·t = g(X),  K ≡ k·C_A0^(n−1)',
        latex: 'K\\,t = g(X),\\quad K \\equiv k\\,C_{A0}^{\\,n-1}',
      },
      {
        kind: 'closedForm' as const,
        plain: isFirstOrder
          ? 'n = 1  ⇒  g(X) = −ln(1−X)'
          : `n = ${fmt(n)}  ⇒  g(X) = [(1−X)^(1−n) − 1]/(n−1)`,
        latex: isFirstOrder ? 'g(X) = -\\ln(1-X)' : 'g(X) = \\frac{(1-X)^{1-n} - 1}{n-1}',
        values: { n },
      },
    ];
  },
};
