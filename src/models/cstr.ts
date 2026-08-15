import type { Conversion, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_N = 1;

const order = (p: Params): number => num(p, 'n', DEFAULT_N);

/**
 * Continuous stirred-tank reactor at steady state.
 *
 *   τ = X / [K(1−X)ⁿ]
 *
 * The spec calls this "not a g, algebraic" and asks for it to be kept isolated, but
 * that relation *is* K·τ = X/(1−X)ⁿ, so defining g(X) = X/(1−X)ⁿ fits the same
 * interface exactly and needs no special case anywhere in the solver. Verified strictly
 * increasing on [0,1): g′ = (1−X)^(−n−1)·(1 + (n−1)X) > 0 for all n ≥ 0.
 *
 * What genuinely differs is the meaning of the answer, not its arithmetic: `t` here is
 * space time τ = V/v₀, not elapsed batch time. That travels as `timeQuantity` so the UI
 * never labels a required reactor size as a waiting time.
 *
 * The completion behaviour is a second reason the "n < 1" rule cannot be trusted: a
 * CSTR converges only for n < 0, so at n = 0.5 a batch reactor reaches completion in
 * finite time while a CSTR never does, as X → 1 the outlet concentration, and with it
 * the rate, goes to zero. At n = 0 the requirement is finite: g(1) = 1.
 */
export const cstr: KineticModel = {
  key: 'cstr',
  label: 'CSTR (steady state)',
  timeQuantity: 'spaceTime',
  notes:
    'The one non-batch case: τ = X/[K(1−X)ⁿ]. Reported times are space times τ = V/v₀, not batch times.',

  params: [
    continuousParam({
      key: 'n',
      symbol: 'n',
      label: 'Reaction order',
      default: DEFAULT_N,
      min: 0,
      max: 6,
      bandValues: [0, 0.5, 1, 1.5, 2],
    }),
  ],

  g: (c: Conversion, p: Params): number => c.X * Math.exp(-order(p) * Math.log(c.remaining)),

  /** dg/dX = (1−X)^(−n−1)·(1 + (n−1)X). */
  gPrime: (c: Conversion, p: Params): number => {
    const n = order(p);
    return Math.exp(-(n + 1) * Math.log(c.remaining)) * (1 + (n - 1) * c.X);
  },

  // Closed forms exist only at n = 0 and n = 1; the solver bisects for the general case.

  Xmax: (): number => 1,

  limitAtCeiling: (p: Params): Limit => {
    const n = order(p);
    return n === 0
      ? { kind: 'finite', value: 1 }
      : { kind: 'divergent', rate: 'power', exponent: n };
  },

  kFromRateConstant: (k: number, CA0: number, p: Params) => ok(k * Math.pow(CA0, order(p) - 1)),

  describe: (p: Params) => {
    const n = order(p);
    return [
      {
        kind: 'model' as const,
        plain: 'CSTR at steady state, τ = X/[K(1−X)ⁿ]  ⇒  K·τ = g(X),  K ≡ k·C_A0^(n−1)',
        latex: 'K\\,\\tau = g(X),\\quad \\tau = \\frac{X}{K(1-X)^n}',
      },
      {
        kind: 'closedForm' as const,
        plain: `n = ${fmt(n)}  ⇒  g(X) = X/(1−X)ⁿ`,
        latex: 'g(X) = \\frac{X}{(1-X)^n}',
        values: { n },
      },
      {
        kind: 'note' as const,
        plain: 'Times reported for a CSTR are space times τ = V/v₀, not elapsed reaction times.',
      },
    ];
  },
};
