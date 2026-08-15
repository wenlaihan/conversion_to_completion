import type { Conversion, DerivationStep, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { integrateEndpointSingular } from '../numerics/quadrature.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_N = 1;
const DEFAULT_EPS = 0;

const order = (p: Params): number => num(p, 'n', DEFAULT_N);
const expansion = (p: Params): number => num(p, 'eps', DEFAULT_EPS);

/** Volume-change weighting: (1 + εu)^(n−1). At n = 1 this is 1 for every ε. */
const weight = (n: number, eps: number) => (u: number) => Math.pow(1 + eps * u, n - 1);

/**
 * Variable-volume gas phase at constant pressure, V = V₀(1 + εX).
 *
 *   g(X) = ∫₀ˣ (1+εu)^(n−1)/(1−u)ⁿ du
 *
 * The one model with no closed form. The integrand is endpoint-singular at u → 1 for
 * n ≥ 1, so it is integrated through a substitution that removes the singularity rather
 * than by throwing a finer rule at it, measured, that is the difference between 9
 * function evaluations and several million, and at n = 2 the raw form also misses the
 * accuracy contract.
 *
 * At n = 1 the weighting collapses to 1 and g is exactly ε-independent, reducing to
 * −ln(1−X): expansion changes concentration and residence-time bookkeeping, but for a
 * first-order rate law those effects cancel.
 */
export const varVolume: KineticModel = {
  key: 'var-volume',
  label: 'Variable volume (constant pressure)',
  timeQuantity: 'batchTime',
  notes:
    'Gas phase at constant P, V = V₀(1+εX). n = 1 is independent of ε; ε = 0 recovers nth-order.',

  params: [
    continuousParam({
      key: 'n',
      symbol: 'n',
      label: 'Reaction order',
      default: DEFAULT_N,
      min: -2,
      max: 6,
      bandValues: [0, 0.5, 1, 1.5, 2],
      unusualBelow: 0,
    }),
    continuousParam({
      key: 'eps',
      symbol: 'ε',
      label: 'Fractional volume change at complete conversion',
      default: DEFAULT_EPS,
      min: -0.9,
      max: 10,
    }),
  ],

  g: (c: Conversion, p: Params): number => {
    const n = order(p);
    const result = integrateEndpointSingular(weight(n, expansion(p)), c.remaining, n);
    // The interface returns a plain number; a failed quadrature surfaces as NaN and is
    // caught by the solver's finiteness guards rather than being silently absorbed.
    return result.ok ? result.value : Number.NaN;
  },

  /** The integrand itself. */
  gPrime: (c: Conversion, p: Params): number =>
    Math.pow(1 + expansion(p) * c.X, order(p) - 1) * Math.exp(-order(p) * Math.log(c.remaining)),

  // No closed-form inverse: the integral has none in general. The solver bisects.

  Xmax: (): number => 1,

  limitAtCeiling: (p: Params): Limit => {
    const n = order(p);
    if (n > 1) return { kind: 'divergent', rate: 'power', exponent: n - 1 };
    if (n === 1) return { kind: 'divergent', rate: 'logarithmic' };
    // n < 1 converges; the value depends on ε, so it is integrated all the way to the
    // ceiling, the substitution makes remaining = 0 a regular endpoint.
    const total = integrateEndpointSingular(weight(n, expansion(p)), 0, n);
    return { kind: 'finite', value: total.ok ? total.value : Number.NaN };
  },

  kFromRateConstant: (k: number, CA0: number, p: Params) => ok(k * Math.pow(CA0, order(p) - 1)),

  describe: (p: Params) => {
    const n = order(p);
    const eps = expansion(p);
    const steps: DerivationStep[] = [
      {
        kind: 'model' as const,
        plain: 'Gas phase at constant pressure, V = V₀(1+εX)  ⇒  K·t = g(X),  K ≡ k·C_A0^(n−1)',
        latex: 'K\\,t = g(X),\\quad V = V_0(1+\\varepsilon X)',
      },
      {
        kind: 'closedForm' as const,
        plain: `n = ${fmt(n)}, ε = ${fmt(eps)}  ⇒  g(X) = ∫₀ˣ (1+εu)^(n−1)/(1−u)ⁿ du (adaptive quadrature)`,
        latex: 'g(X) = \\int_0^X \\frac{(1+\\varepsilon u)^{n-1}}{(1-u)^n}\\,du',
        values: { n, eps },
      },
    ];
    if (n === 1) {
      steps.push({
        kind: 'note' as const,
        plain: 'At n = 1 the volume term cancels: g(X) = −ln(1−X) regardless of ε.',
        latex: 'g(X) = -\\ln(1-X)',
        values: { n, eps },
      });
    }
    return steps;
  },
};
