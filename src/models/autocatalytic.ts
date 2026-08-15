import type { Conversion, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_R0 = 0.01;

const seed = (p: Params): number => num(p, 'r0', DEFAULT_R0);

/**
 * Autocatalytic, A + R → 2R, with r₀ = C_R0/C_A0.
 *
 *   g(X) = ln[(r₀ + X)/(r₀(1 − X))]
 *
 * Sigmoidal: the rate is proportional to the product it makes, so it starts slow,
 * accelerates, then dies as A runs out. The seed must be strictly positive, at r₀ = 0
 * there is no catalyst, g diverges for every X > 0, and the reaction never starts (G14).
 * That is enforced by the open lower bound on the domain rather than by a solver check.
 */
export const autocatalytic: KineticModel = {
  key: 'autocatalytic',
  label: 'Autocatalytic',
  timeQuantity: 'batchTime',
  notes: 'r₀ = C_R0/C_A0; sigmoidal conversion curve; requires a nonzero seed r₀ > 0.',

  params: [
    continuousParam({
      key: 'r0',
      symbol: 'r₀',
      label: 'Initial catalyst ratio C_R0/C_A0',
      default: DEFAULT_R0,
      min: 0,
      max: 10,
      openMin: true,
      // A seed is a trace quantity, so the plausible values span decades rather than a
      // linear range: a tenth of a percent to a tenth of the substrate.
      bandValues: [0.001, 0.003, 0.01, 0.03, 0.1],
    }),
  ],

  g: (c: Conversion, p: Params): number => Math.log1p(c.X / seed(p)) - Math.log(c.remaining),

  /** dg/dX = 1/(r₀+X) + 1/(1−X). */
  gPrime: (c: Conversion, p: Params): number => 1 / (seed(p) + c.X) + 1 / c.remaining,

  /** X = r₀·(e^τ − 1)/(1 + r₀·e^τ). */
  gInv: (tau: number, p: Params): number => {
    const r0 = seed(p);
    const grown = r0 * Math.expm1(tau);
    return grown / (1 + r0 + grown);
  },

  Xmax: (): number => 1,

  limitAtCeiling: (): Limit => ({ kind: 'divergent', rate: 'logarithmic' }),

  /** dX/dt = k·C_A0(1−X)(r₀+X) against K/g′ gives K = k·C_A0·(1+r₀). */
  kFromRateConstant: (k: number, CA0: number, p: Params) => ok(k * CA0 * (1 + seed(p))),

  describe: (p: Params) => {
    const r0 = seed(p);
    return [
      {
        kind: 'model' as const,
        plain: 'Batch, A + R → 2R, −r_A = k·C_A·C_R  ⇒  K·t = g(X)',
        latex: 'K\\,t = g(X)',
      },
      {
        kind: 'closedForm' as const,
        plain: `r₀ = ${fmt(r0)}  ⇒  g(X) = ln[(r₀+X)/(r₀(1−X))]`,
        latex: 'g(X) = \\ln\\frac{r_0 + X}{r_0(1-X)}',
        values: { r0 },
      },
    ];
  },
};
