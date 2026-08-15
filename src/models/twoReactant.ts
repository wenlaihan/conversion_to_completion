import type { Conversion, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { expm1OverX, log1pOverX } from '../numerics/stable.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_M = 2;

const ratio = (p: Params): number => num(p, 'M', DEFAULT_M);

/**
 * Second-order with two reactants, A + B → P, M = C_B0/C_A0.
 *
 *   g(X) = ln[(M−X)/(M(1−X))]/(M−1)   and   X/(1−X) at M = 1.
 *
 * Both regimes are one expression. Writing d = M−1 and r = 1−X,
 *
 *   g = log1pOverX(d/r)/r − log1pOverX(d)
 *
 * which is exactly X/(1−X) at d = 0 because log1pOverX(0) = 1, so the M→1 removable
 * singularity needs no branch and g stays smooth in M for the fitter to search across.
 *
 * M ≫ 1 degenerates to pseudo-first-order: M·g → −ln(1−X).
 */
export const twoReactant: KineticModel = {
  key: 'two-reactant',
  label: 'Two-reactant second order',
  timeQuantity: 'batchTime',
  notes:
    'A+B→P with M = C_B0/C_A0. M≫1 approaches pseudo-first-order; M<1 caps conversion at M.',

  params: [
    continuousParam({
      key: 'M',
      symbol: 'M',
      label: 'Initial molar ratio C_B0/C_A0',
      default: DEFAULT_M,
      min: 0,
      max: 100,
      openMin: true,
      // Near-stoichiometric through to large excess, the span over which the ratio
      // changes the kinetics. Sweeping (0,100] linearly lands every point in the
      // pseudo-first-order limit, where M no longer matters, and reports no spread.
      bandValues: [1.2, 1.5, 2, 5, 20],
    }),
  ],

  g: (c: Conversion, p: Params): number => {
    const d = ratio(p) - 1;
    return log1pOverX(d / c.remaining) / c.remaining - log1pOverX(d);
  },

  /** dg/dX = 1/[(1−X)(M−X)], which is 1/(1−X)² at M = 1, matching second order. */
  gPrime: (c: Conversion, p: Params): number => {
    const d = ratio(p) - 1;
    return 1 / (c.remaining * (d + c.remaining));
  },

  /**
   * Inverting gives X = M·τ·E/(1 + M·τ·E) with E = expm1OverX(τ(M−1)); at M = 1 the
   * factor E is 1 and this reduces to τ/(1+τ), the inverse of X/(1−X).
   */
  gInv: (tau: number, p: Params): number => {
    const M = ratio(p);
    const scaled = M * tau * expm1OverX(tau * (M - 1));
    return scaled / (1 + scaled);
  },

  Xmax: (p: Params): number => Math.min(1, ratio(p)),

  limitAtCeiling: (p: Params): Limit =>
    ratio(p) === 1
      ? // At M = 1 this is exactly second order: g = X/(1−X) ~ 1/r.
        { kind: 'divergent', rate: 'power', exponent: 1 }
      : // Otherwise the ceiling is whichever reactant runs out first, approached as a log.
        { kind: 'divergent', rate: 'logarithmic' },

  /** −r_A = k·C_A·C_B gives dX/dt = k·C_A0(1−X)(M−X), so K = k·C_A0. */
  kFromRateConstant: (k: number, CA0: number) => ok(k * CA0),

  describe: (p: Params) => {
    const M = ratio(p);
    const isEquimolar = M === 1;
    return [
      {
        kind: 'model' as const,
        plain: 'Batch, A + B → P, −r_A = k·C_A·C_B  ⇒  K·t = g(X),  K ≡ k·C_A0',
        latex: 'K\\,t = g(X),\\quad K \\equiv k\\,C_{A0}',
      },
      {
        kind: 'closedForm' as const,
        plain: isEquimolar
          ? 'M = 1  ⇒  g(X) = X/(1−X)'
          : `M = ${fmt(M)}  ⇒  g(X) = ln[(M−X)/(M(1−X))]/(M−1)`,
        latex: isEquimolar
          ? 'g(X) = \\frac{X}{1-X}'
          : 'g(X) = \\frac{1}{M-1}\\ln\\frac{M-X}{M(1-X)}',
        values: { M },
      },
    ];
  },
};
