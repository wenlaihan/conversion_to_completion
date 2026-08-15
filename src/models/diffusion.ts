import type { Conversion, KineticModel, Limit, Params } from '../domain/types.ts';
import { ok } from '../domain/result.ts';
import { categoricalParam, str } from './shared.ts';

interface DiffusionLaw {
  readonly g: (c: Conversion) => number;
  readonly gPrime: (c: Conversion) => number;
  readonly limit: number;
  readonly plain: string;
  readonly latex: string;
  /** A known limitation of the law itself, surfaced in the worked solution. */
  readonly caution?: string;
}

/**
 * The four standard diffusion-controlled solid-state laws.
 *
 * Every one of them has a FINITE limit at X = 1, so each has an exact, well-posed
 * completion time. This is the sharpest counterexample to phrasing the completion rule
 * as "n < 1": these models have no n at all, and a rule written in terms of one would
 * declare their completion undefined when it is perfectly definite.
 *
 * D2 additionally shows why the limit must be declared rather than read off `g(1)`:
 * evaluated there it is 0·log 0 = NaN, though the limit is exactly 1.
 */
const LAWS: Readonly<Record<string, DiffusionLaw>> = {
  /** One-dimensional, parabolic law. */
  D1: {
    g: (c) => c.X * c.X,
    gPrime: (c) => 2 * c.X,
    limit: 1,
    plain: 'D1 (one-dimensional)  ⇒  g(X) = X²',
    latex: 'g(X) = X^2',
  },
  /** Two-dimensional, Valensi–Barrer. */
  D2: {
    g: (c) => c.remaining * Math.log(c.remaining) + c.X,
    gPrime: (c) => -Math.log(c.remaining),
    limit: 1,
    plain: 'D2 (two-dimensional)  ⇒  g(X) = (1−X)ln(1−X) + X',
    latex: 'g(X) = (1-X)\\ln(1-X) + X',
  },
  /** Three-dimensional, Jander. */
  D3: {
    g: (c) => {
      const s = 1 - Math.cbrt(c.remaining);
      return s * s;
    },
    gPrime: (c) => (2 / 3) * (1 - Math.cbrt(c.remaining)) * Math.pow(c.remaining, -2 / 3),
    limit: 1,
    plain: 'D3 (three-dimensional, Jander)  ⇒  g(X) = [1 − (1−X)^(1/3)]²',
    latex: 'g(X) = \\left[1 - (1-X)^{1/3}\\right]^2',
    // The Jander derivation assumes the product layer stays thin relative to the
    // particle, which stops being true well before complete conversion. It is widely
    // held to be a good approximation only at low conversion, precisely the opposite
    // of where this tool is usually pointed, so the caveat travels with the answer.
    caution:
      'The Jander equation assumes a thin product layer and is only a good approximation at low conversion. Times it predicts at 90% and beyond should be read as indicative; D4 (Ginstling–Brounshtein) rests on a less restrictive geometric assumption.',
  },
  /** Three-dimensional, Ginstling–Brounshtein. */
  D4: {
    g: (c) => 1 - (2 * c.X) / 3 - Math.pow(c.remaining, 2 / 3),
    gPrime: (c) => (2 / 3) * (Math.pow(c.remaining, -1 / 3) - 1),
    limit: 1 / 3,
    plain: 'D4 (Ginstling–Brounshtein)  ⇒  g(X) = 1 − 2X/3 − (1−X)^(2/3)',
    latex: 'g(X) = 1 - \\tfrac{2X}{3} - (1-X)^{2/3}',
  },
};

const DEFAULT_TYPE = 'D3';
const TYPES = ['D1', 'D2', 'D3', 'D4'] as const;

const law = (p: Params): DiffusionLaw =>
  LAWS[str(p, 'type', DEFAULT_TYPE)] ?? (LAWS.D3 as DiffusionLaw);

/**
 * Diffusion-controlled solid-state kinetics.
 *
 * The type is categorical, so fitting it means enumerating four options rather than
 * searching an interval, handled generically by the solver switching on the declared
 * domain kind, never on this model's identity.
 *
 * No closed-form inverse is offered: D2 and D4 have none, and rather than expose a
 * partial `gInv` that silently fails for half the options, all four go through the
 * solver's bisection, which is exact to the stated tolerance anyway.
 */
export const diffusion: KineticModel = {
  key: 'diffusion',
  label: 'Diffusion-controlled (solid state)',
  timeQuantity: 'batchTime',
  notes:
    'Diffusion-controlled solid state. All four laws reach complete conversion in finite time.',

  params: [
    categoricalParam({
      key: 'type',
      symbol: 'D',
      label: 'Diffusion law',
      default: DEFAULT_TYPE,
      options: TYPES,
    }),
  ],

  g: (c: Conversion, p: Params): number => law(p).g(c),

  gPrime: (c: Conversion, p: Params): number => law(p).gPrime(c),

  Xmax: (): number => 1,

  limitAtCeiling: (p: Params): Limit => ({ kind: 'finite', value: law(p).limit }),

  /** These laws are written g(α) = k·t, so K is the rate constant itself. */
  kFromRateConstant: (k: number) => ok(k),

  describe: (p: Params) => {
    const chosen = law(p);
    return [
      {
        kind: 'model' as const,
        plain: 'Diffusion-controlled solid-state reaction  ⇒  K·t = g(X)',
        latex: 'K\\,t = g(X)',
      },
      { kind: 'closedForm' as const, plain: chosen.plain, latex: chosen.latex },
      {
        kind: 'completion' as const,
        plain: `g(1) = ${chosen.limit === 1 ? '1' : '1/3'} is finite, so complete conversion is reached in a definite time.`,
        values: { gAtOne: chosen.limit },
      },
      ...(chosen.caution === undefined
        ? []
        : [{ kind: 'note' as const, plain: chosen.caution }]),
    ];
  },
};
