import type { Conversion, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { continuousParam, fmt, num } from './shared.ts';

const DEFAULT_M = 2;

const avramiExponent = (p: Params): number => num(p, 'm', DEFAULT_M);

/**
 * Johnson-Mehl-Avrami-Kolmogorov (Avrami-Erofeev), nucleation and growth.
 *
 *   g(X) = [−ln(1 − X)]^(1/m),  equivalently X = 1 − exp(−(Kt)^m)
 *
 * The classic sigmoidal law for crystallization, cure and phase transformation, where m
 * encodes nucleation mechanism and growth dimensionality.
 *
 * Worth noting for the completion verdict: g diverges at X = 1, but only as
 * (ln 1/δ)^(1/m), so slowly that its successive differences *shrink*. Measured, a
 * numeric "differences are decaying ⇒ converged" probe calls this finite, which it is
 * not. Declaring the limit here removes the guesswork.
 */
export const jmak: KineticModel = {
  key: 'jmak',
  label: 'JMAK / Avrami-Erofeev',
  timeQuantity: 'batchTime',
  notes: 'Avrami–Erofeev; nucleation and growth, crystallization, cure. m sets the mechanism.',

  params: [
    continuousParam({
      key: 'm',
      symbol: 'm',
      label: 'Avrami exponent',
      default: DEFAULT_M,
      min: 0,
      max: 6,
      openMin: true,
      // The four exponents the geometry actually produces: 1 to 4, growth dimensionality
      // with or without continuing nucleation. Values above 4 are not physical here.
      bandValues: [1, 2, 3, 4],
    }),
  ],

  g: (c: Conversion, p: Params): number =>
    Math.pow(-Math.log(c.remaining), 1 / avramiExponent(p)),

  /** dg/dX = (1/m)·[−ln(1−X)]^(1/m − 1)/(1−X). */
  gPrime: (c: Conversion, p: Params): number => {
    const m = avramiExponent(p);
    const y = -Math.log(c.remaining);
    return (1 / m) * Math.pow(y, 1 / m - 1) * (1 / c.remaining);
  },

  gInv: (tau: number, p: Params): number => -Math.expm1(-Math.pow(tau, avramiExponent(p))),

  Xmax: (): number => 1,

  limitAtCeiling: (): Limit => ({ kind: 'divergent', rate: 'logarithmic' }),

  /** X = 1 − exp(−(kt)^m) rearranges to g(X) = k·t, so K = k with no concentration term. */
  kFromRateConstant: (k: number) => ok(k),

  describe: (p: Params) => {
    const m = avramiExponent(p);
    return [
      {
        kind: 'model' as const,
        plain: 'Nucleation and growth, X = 1 − exp[−(K·t)^m]  ⇒  K·t = g(X)',
        latex: 'X = 1 - \\exp[-(Kt)^m]',
      },
      {
        kind: 'closedForm' as const,
        plain: `m = ${fmt(m)}  ⇒  g(X) = [−ln(1−X)]^(1/m)`,
        latex: 'g(X) = [-\\ln(1-X)]^{1/m}',
        values: { m },
      },
    ];
  },
};
