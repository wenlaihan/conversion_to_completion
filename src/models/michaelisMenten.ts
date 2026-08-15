import type { Conversion, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_KAPPA = 1;

const kappa = (p: Params): number => num(p, 'kappa', DEFAULT_KAPPA);

/**
 * Michaelis-Menten / saturating kinetics, κ = K_M/S₀.
 *
 *   g(X) = X − κ·ln(1 − X)
 *
 * Bridges the two limiting orders: at κ = 0 the enzyme is saturated throughout and this
 * is exactly zero order (g = X); as κ → ∞ substrate is always scarce and g/κ → −ln(1−X),
 * first order.
 *
 * Two consequences the solver handles generically. With one observation and κ free
 * there are two unknowns and one equation, so the fit is underdetermined (G13), that
 * falls out of counting free parameters, not from a check naming this model. And κ = 0
 * is the one parameter value where the ceiling limit is finite (g(1) = 1), which is why
 * the limit is declared rather than probed: `g` itself would return NaN there, from 0·log 0.
 */
export const michaelisMenten: KineticModel = {
  key: 'michaelis-menten',
  label: 'Michaelis-Menten (saturating)',
  timeQuantity: 'batchTime',
  notes: 'κ = K_M/S₀; bridges zero order (κ→0) and first order (κ→∞).',

  params: [
    continuousParam({
      key: 'kappa',
      symbol: 'κ',
      label: 'Saturation ratio K_M/S₀',
      default: DEFAULT_KAPPA,
      min: 0,
      max: 100,
      // κ is a ratio whose two limits are the two limiting orders, so the band walks it
      // in decades around 1, saturated (zero order) to scarce (first order). Linear
      // points across [0,100] all sit in the first-order limit and report no spread.
      bandValues: [0.1, 0.3, 1, 3, 10],
    }),
  ],

  g: (c: Conversion, p: Params): number => {
    const k = kappa(p);
    // k === 0 short-circuits so the zero-order case never forms 0·(−∞) at X = 1.
    return k === 0 ? c.X : c.X - k * Math.log(c.remaining);
  },

  /** dg/dX = 1 + κ/(1−X). */
  gPrime: (c: Conversion, p: Params): number => 1 + kappa(p) / c.remaining,

  // No closed-form inverse: X − κ·ln(1−X) = τ is transcendental. The solver bisects.

  Xmax: (): number => 1,

  limitAtCeiling: (p: Params): Limit =>
    kappa(p) === 0 ? { kind: 'finite', value: 1 } : { kind: 'divergent', rate: 'logarithmic' },

  /** −r_A = Vmax·C_A/(K_M + C_A) gives K = Vmax/C_A0; the supplied k is Vmax. */
  kFromRateConstant: (k: number, CA0: number) => ok(k / CA0),

  describe: (p: Params) => {
    const k = kappa(p);
    return [
      {
        kind: 'model' as const,
        plain: 'Batch, −r_A = Vmax·C_A/(K_M + C_A)  ⇒  K·t = g(X),  K ≡ Vmax/C_A0',
        latex: 'K\\,t = g(X),\\quad K \\equiv V_{max}/C_{A0}',
      },
      {
        kind: 'closedForm' as const,
        plain:
          k === 0
            ? 'κ = 0 (saturated)  ⇒  g(X) = X, identical to zero order'
            : `κ = ${fmt(k)}  ⇒  g(X) = X − κ·ln(1−X)`,
        latex: k === 0 ? 'g(X) = X' : 'g(X) = X - \\kappa\\ln(1-X)',
        values: { kappa: k },
      },
    ];
  },
};
