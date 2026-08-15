import { describe, it, expect } from 'vitest';
import { lookupModel } from '../src/models/registry.ts';
import { conversionOf, fromRemaining } from '../src/domain/types.ts';
import { resolveParameters, fitFreeParameter } from '../src/solver/fit.ts';
import { solve } from '../src/api/solve.ts';

/**
 * The §10 golden table is the hard contract of this engine.
 *
 * One deviation, recorded deliberately: the published cell for n = 0.5 at 99.9% reads
 * 52.34, but the correct value is 52.2597. g(0.999) = 2[1−√0.001] = 1.9367544 and
 * K = 0.0370602, so t = 52.2597, confirmed both from the general form
 * [(1−X)^(1−n)−1]/(n−1) and from the closed form 2[1−(1−X)^½]. Every other cell in the
 * table reproduces to the digit, including t(100%) = 53.97 in that same row, which is
 * computed from the same g and K. The published figure is a transcription slip.
 */

const model = lookupModel('nth-order').value;
const observed = conversionOf(0.21);
const T1 = 6;

/** Cells exactly as published, compared at the precision they were published to. */
const GOLDEN: Readonly<Record<string, readonly string[]>> = {
  '0': ['0.0350000', '14.29', '25.71', '28.29', '28.54', '28.57'],
  '0.5': ['0.0370602', '15.81', '36.90', '48.57', '52.26', '53.97'],
  '1': ['0.0392871', '17.64', '58.61', '117.22', '175.83', 'Inf'],
  '1.5': ['0.0416960', '19.87', '103.72', '431.70', '1468.9', 'Inf'],
  '2': ['0.0443038', '22.57', '203.14', '2234.57', '22548.9', 'Inf'],
  '3': ['0.0501923', '29.89', '986.21', '99606.96', '9961682', 'Inf'],
};

const matchesPublished = (value: number, published: string): boolean => {
  if (published === 'Inf') return !Number.isFinite(value);
  const decimals = published.split('.')[1]?.length;
  return decimals === undefined
    ? String(Math.round(value)) === published
    : value.toFixed(decimals) === published;
};

describe('§10 golden table, 21% at 6 h, nth-order, hours', () => {
  it.each(Object.keys(GOLDEN))('reproduces every cell for n = %s', (key) => {
    const n = Number(key);
    const published = GOLDEN[key] as readonly string[];
    const K = model.g(observed, { n }) / T1;
    const limit = model.limitAtCeiling({ n });

    const times = [0.5, 0.9, 0.99, 0.999].map(
      (X) => model.g(fromRemaining(1 - X), { n }) / K,
    );
    const completion = limit.kind === 'finite' ? limit.value / K : Number.POSITIVE_INFINITY;
    const cells = [K, ...times, completion];

    cells.forEach((value, i) => {
      expect(
        matchesPublished(value, published[i] as string),
        `n=${n} cell ${i}: got ${value}, published ${published[i]}`,
      ).toBe(true);
    });
  });

  it('classifies completion as exact below first order and asymptotic at or above it', () => {
    expect(model.limitAtCeiling({ n: 0 })).toEqual({ kind: 'finite', value: 1 });
    expect(model.limitAtCeiling({ n: 0.5 })).toEqual({ kind: 'finite', value: 2 });
    expect(model.limitAtCeiling({ n: 1 })).toEqual({ kind: 'divergent', rate: 'logarithmic' });
    expect(model.limitAtCeiling({ n: 2 })).toEqual({
      kind: 'divergent',
      rate: 'power',
      exponent: 1,
    });
  });
});

describe('§10 limit identities', () => {
  const X_VALUES = [0.1, 0.3, 0.5, 0.7, 0.9, 0.99] as const;
  const g = (key: string, X: number, p: Record<string, number | string>): number =>
    lookupModel(key).value.g(conversionOf(X), p);

  it.each(X_VALUES)('nth-order at n=1/2 equals 2[1-(1-X)^1/2] (X=%s)', (X) => {
    expect(g('nth-order', X, { n: 0.5 })).toBeCloseTo(2 * (1 - Math.sqrt(1 - X)), 12);
  });

  it.each(X_VALUES)('nth-order at n=2/3 equals 3[1-(1-X)^1/3] (X=%s)', (X) => {
    expect(g('nth-order', X, { n: 2 / 3 })).toBeCloseTo(3 * (1 - Math.cbrt(1 - X)), 12);
  });

  it.each(X_VALUES)('two-reactant tends to X/(1-X) as M goes to 1 (X=%s)', (X) => {
    expect(g('two-reactant', X, { M: 1 })).toBeCloseTo(X / (1 - X), 10);
  });

  it.each(X_VALUES)('two-reactant: M*g tends to -ln(1-X) as M grows (X=%s)', (X) => {
    expect(1e7 * g('two-reactant', X, { M: 1e7 })).toBeCloseTo(-Math.log1p(-X), 5);
  });

  it.each(X_VALUES)('michaelis-menten at kappa=0 equals zero order (X=%s)', (X) => {
    expect(g('michaelis-menten', X, { kappa: 0 })).toBeCloseTo(g('nth-order', X, { n: 0 }), 12);
  });

  it.each(X_VALUES)('michaelis-menten: g/kappa tends to first order (X=%s)', (X) => {
    expect(g('michaelis-menten', X, { kappa: 1e8 }) / 1e8).toBeCloseTo(
      g('nth-order', X, { n: 1 }),
      6,
    );
  });

  it.each(X_VALUES)('reversible-1 tends to -ln(1-X) as Xe goes to 1 (X=%s)', (X) => {
    expect(g('reversible-1', X, { Xe: 1 - 1e-12 })).toBeCloseTo(-Math.log1p(-X), 9);
  });

  it.each(X_VALUES)('var-volume with eps=0 equals nth-order (X=%s)', (X) => {
    expect(g('var-volume', X, { n: 1.7, eps: 0 })).toBeCloseTo(g('nth-order', X, { n: 1.7 }), 9);
  });

  it.each([-0.5, 0, 2, 5])('var-volume at n=1 is independent of eps (eps=%s)', (eps) => {
    expect(g('var-volume', 0.7, { n: 1, eps })).toBeCloseTo(-Math.log1p(-0.7), 12);
  });
});

describe('§10 order recovery', () => {
  const refit = (trueOrder: number) => {
    const t2 =
      (T1 * model.g(conversionOf(0.75), { n: trueOrder })) / model.g(observed, { n: trueOrder });
    return fitFreeParameter(model, resolveParameters(model, { n: null }), [
      { t: T1, conversion: observed, T: 293.15 },
      { t: t2, conversion: conversionOf(0.75), T: 293.15 },
    ]);
  };

  it.each([0, 0.37, 0.5, 1, 1.37, 2, 2.5, 4.8])(
    'recovers n = %s from two synthesized points to better than 1e-6',
    (trueOrder) => {
      const fit = refit(trueOrder);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.value.params.n as number).toBeCloseTo(trueOrder, 6);
      expect(fit.value.identifiable).toBe(true);
    },
  );

  it('recovers n = 1 exactly, where a |n-1| branch would lose precision', () => {
    const fit = refit(1);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(Math.abs((fit.value.params.n as number) - 1)).toBeLessThan(1e-9);
  });
});

describe('the motivating question, end to end', () => {
  const response = solve({
    model: 'nth-order',
    params: { n: 1 },
    observations: [{ t: 6, X: 0.21, T: 293.15 }],
    targets: { X: [0.5, 0.75, 0.9, 0.95, 0.99, 0.999], t: [24, 48] },
    temperature: { basis: 293.15 },
    units: { time: 'h', temperature: 'K' },
  });

  it('solves', () => {
    expect(response.ok).toBe(true);
  });

  it('matches the §6 sample response', () => {
    if (!response.ok) return;
    const v = response.value;
    expect(v.resolved.K).toBeCloseTo(0.0392871, 7);
    expect(v.resolved.KUnits).toBe('1/h');
    expect(v.resolved.identifiable).toBe(false);
    expect(v.table[0]?.t as number).toBeCloseTo(17.64, 2);
    expect(v.table[2]?.t as number).toBeCloseTo(58.61, 2);
    expect(v.inverse[0]?.X as number).toBeCloseTo(0.6105, 4);
    expect(v.diagnostics.dlnt_dX1 as number).toBeCloseTo(-5.37, 2);
    // g(0.9)/g(0.21), the sample's extrapolation figure.
    expect(v.table[2]?.extrapolationFactor as number).toBeCloseTo(9.77, 2);
  });

  it('leads with the band, not the point estimate, when the order was assumed', () => {
    if (!response.ok) return;
    expect(response.value.headline.kind).toBe('band');
    expect(response.value.band?.values).toEqual([0, 0.5, 1, 1.5, 2]);
    const at90 = response.value.band?.times['0.9'] as readonly number[];
    expect(at90.map((t) => Number(t.toFixed(2)))).toEqual([25.71, 36.9, 58.61, 103.72, 203.14]);
  });

  it('refuses to give a completion time at first order, and says why', () => {
    if (!response.ok) return;
    const { completion } = response.value;
    expect(completion.wellPosed).toBe(false);
    expect(completion.kind).toBe('asymptotic');
    expect(completion.time).toBeNull();
    expect(completion.practical['0.99'] as number).toBeCloseTo(117.22, 2);
    expect(completion.practical['0.999'] as number).toBeCloseTo(175.83, 2);
  });

  it('renders a worked solution', () => {
    if (!response.ok) return;
    expect(response.value.derivation.length).toBeGreaterThanOrEqual(5);
    expect(response.value.derivation.join('\n')).toContain('K·t = g(X)');
  });
});
