import type { KineticModel, Params, Seconds } from '../domain/types.ts';
import { PRACTICAL_LADDER } from '../domain/constants.ts';
import { conversionFromGap, timeAt } from './predict.ts';

/**
 * Is "time to completion" even a well-posed question, and if not, what should be said
 * instead? Computed on every request.
 *
 * The spec offers three outcomes (finite, divergent, model-capped) as alternatives.
 * They are not mutually exclusive: reversible-1 with Xe = 0.6 has a ceiling *and*
 * diverges at it, and so does two-reactant with M < 1. Treating them as one list makes
 * the capped case silently swallow the divergent one. They are two independent axes:
 *
 *   ceiling       Xmax = 1, or a model cap (equilibrium, limiting reagent)
 *   reachability  g(Xmax) finite ⇒ an exact time; divergent ⇒ asymptotic
 *
 * The reachability axis is read from each model's declared `limitAtCeiling` rather than
 * evaluated, because `g(Xmax)` is not a reliable signal: it is Infinity for some
 * divergent models but NaN for others (diffusion D2, michaelis-menten at κ=0) whose
 * limits are perfectly finite. Declaring it also carries the divergence *rate*, which is
 * what turns "undefined" into an actual explanation.
 */

export interface LadderEntry {
  readonly fractionOfCeiling: number;
  readonly X: number;
  readonly t: Seconds;
}

export interface Divergence {
  readonly rate: 'logarithmic' | 'power';
  readonly exponent?: number;
  /** What one more nine of conversion costs. */
  readonly perNine: string;
}

export interface Completion {
  readonly wellPosed: boolean;
  readonly kind: 'exact' | 'asymptotic';
  readonly ceiling: number;
  readonly capped: boolean;
  readonly reason: string;
  /** Present only when the completion time is exact, never Infinity, never NaN. */
  readonly time?: Seconds;
  readonly divergence?: Divergence;
  /** Ceiling-relative practical ladder; the meaningful answer when completion is not. */
  readonly practical: readonly LadderEntry[];
}

const describeDivergence = (
  rate: 'logarithmic' | 'power',
  exponent: number | undefined,
): Divergence => {
  if (rate === 'power' && exponent !== undefined && exponent > 0) {
    const factor = Math.pow(10, exponent);
    const shown = factor >= 100 ? factor.toExponential(2) : factor.toFixed(factor < 10 ? 1 : 0);
    return {
      rate,
      exponent,
      perNine: `each additional nine of conversion takes about ${shown}x longer than the one before`,
    };
  }
  return {
    rate,
    perNine: 'each additional nine of conversion costs roughly the same extra time again',
  };
};

/**
 * Builds the practical ladder as fractions *of the ceiling*.
 *
 * For a capped model an absolute target of 99% is not merely unreachable, it is
 * meaningless: with Xe = 0.6, g(0.99) is NaN because the model is being asked for a
 * conversion beyond equilibrium. "99% of equilibrium" (X = 0.594) is the question the
 * chemist is actually asking.
 */
const buildLadder = (
  model: KineticModel,
  p: Params,
  K: number,
  ceiling: number,
): readonly LadderEntry[] => {
  const entries: LadderEntry[] = [];
  for (const fraction of PRACTICAL_LADDER) {
    const c = conversionFromGap(ceiling * (1 - fraction), ceiling);
    const t = timeAt(model, p, K, c);
    if (t.ok && Number.isFinite(t.value)) {
      entries.push({ fractionOfCeiling: fraction, X: c.X, t: t.value });
    }
  }
  return entries;
};

export const classifyCompletion = (model: KineticModel, p: Params, K: number): Completion => {
  const ceiling = model.Xmax(p);
  const capped = ceiling < 1;
  const limit = model.limitAtCeiling(p);
  const practical = buildLadder(model, p, K, ceiling);

  if (limit.kind === 'finite') {
    if (Number.isFinite(limit.value)) {
      return {
        wellPosed: true,
        kind: 'exact',
        ceiling,
        capped,
        time: limit.value / K,
        reason: capped
          ? `g reaches a finite value at the ceiling X = ${ceiling.toPrecision(4)}, so that ceiling is attained at a definite time.`
          : 'g(1) is finite, so complete conversion is reached at a definite, exact time.',
        practical,
      };
    }
    // The model declares a finite limit but could not evaluate it, for the one model
    // whose limit needs quadrature, that means the integral did not converge to the
    // required accuracy. Reporting the ladder is honest; inventing a time is not.
    return {
      wellPosed: false,
      kind: 'asymptotic',
      ceiling,
      capped,
      reason:
        'This model reaches complete conversion in finite time in principle, but that time could not be evaluated to the required accuracy for these parameters. The practical ladder below is computed directly and is unaffected.',
      practical,
    };
  }

  const divergence = describeDivergence(limit.rate, limit.exponent);
  return {
    wellPosed: false,
    kind: 'asymptotic',
    ceiling,
    capped,
    divergence,
    reason: capped
      ? `Conversion cannot pass X = ${ceiling.toPrecision(4)} for these parameters, and that ceiling is approached asymptotically, so the time to reach it is unbounded; ${divergence.perNine}.`
      : `g diverges at X = 1, so complete conversion is approached asymptotically and "time to completion" has no finite answer; ${divergence.perNine}.`,
    practical,
  };
};
