import { describe, it, expect } from 'vitest';
import { allModels, lookupModel } from '../src/models/registry.ts';
import { conversionOf, type KineticModel, type Params } from '../src/domain/types.ts';
import { integrateEndpointSingular } from '../src/numerics/quadrature.ts';
import { conversionAt, conversionFromGap } from '../src/solver/predict.ts';
import { solve } from '../src/api/solve.ts';

/** A representative parameter set per model, covering every registered key. */
const CASES: readonly { readonly key: string; readonly params: Params }[] = [
  { key: 'nth-order', params: { n: 0.5 } },
  { key: 'nth-order', params: { n: 1 } },
  { key: 'nth-order', params: { n: 2.3 } },
  { key: 'reversible-1', params: { Xe: 0.6 } },
  { key: 'reversible-1', params: { Xe: 0.95 } },
  { key: 'two-reactant', params: { M: 0.5 } },
  { key: 'two-reactant', params: { M: 1 } },
  { key: 'two-reactant', params: { M: 3 } },
  { key: 'autocatalytic', params: { r0: 0.01 } },
  { key: 'autocatalytic', params: { r0: 1 } },
  { key: 'michaelis-menten', params: { kappa: 0 } },
  { key: 'michaelis-menten', params: { kappa: 2.5 } },
  { key: 'var-volume', params: { n: 0.6, eps: 1 } },
  { key: 'var-volume', params: { n: 1, eps: 2 } },
  { key: 'var-volume', params: { n: 1.8, eps: -0.4 } },
  { key: 'jmak', params: { m: 0.5 } },
  { key: 'jmak', params: { m: 3 } },
  { key: 'diffusion', params: { type: 'D1' } },
  { key: 'diffusion', params: { type: 'D2' } },
  { key: 'diffusion', params: { type: 'D3' } },
  { key: 'diffusion', params: { type: 'D4' } },
  { key: 'cstr', params: { n: 0 } },
  { key: 'cstr', params: { n: 1 } },
  { key: 'cstr', params: { n: 2 } },
];

const label = (c: { key: string; params: Params }): string =>
  `${c.key} ${JSON.stringify(c.params)}`;

const model = (key: string): KineticModel => lookupModel(key).value;

describe('every model is a valid conversion-time function', () => {
  it.each(CASES.map((c) => [label(c), c] as const))('%s: g(0) = 0', (_name, c) => {
    expect(model(c.key).g(conversionOf(0), c.params)).toBe(0);
  });

  it.each(CASES.map((c) => [label(c), c] as const))(
    '%s: g is strictly increasing and finite below the ceiling',
    (_name, c) => {
      const m = model(c.key);
      const ceiling = m.Xmax(c.params);
      let previous = -Infinity;
      for (let i = 1; i <= 300; i += 1) {
        const value = m.g(conversionFromGap(ceiling * (1 - i / 301), ceiling), c.params);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(previous);
        previous = value;
      }
    },
  );

  it.each(CASES.map((c) => [label(c), c] as const))(
    '%s: g prime is positive below the ceiling',
    (_name, c) => {
      const m = model(c.key);
      const ceiling = m.Xmax(c.params);
      for (const fraction of [0.1, 0.4, 0.8, 0.99]) {
        const derivative = m.gPrime(
          conversionFromGap(ceiling * (1 - fraction), ceiling),
          c.params,
        );
        expect(derivative).toBeGreaterThan(0);
      }
    },
  );
});

describe('gInv(g(X)) === X to 1e-9 across every model', () => {
  it.each(CASES.map((c) => [label(c), c] as const))('%s round-trips', (_name, c) => {
    const m = model(c.key);
    const ceiling = m.Xmax(c.params);
    for (const fraction of [1e-6, 0.01, 0.2, 0.5, 0.9, 0.99, 0.999]) {
      const target = conversionFromGap(ceiling * (1 - fraction), ceiling);
      const tau = m.g(target, c.params);
      // Uses the model's closed form where it declares one, and the solver's bisection
      // (with K = 1, so t = tau) where it does not.
      const back = conversionAt(m, c.params, 1, tau);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(Math.abs(back.value.X - target.X)).toBeLessThan(1e-9);
    }
  });
});

describe('closed-form g equals numerical quadrature to 1e-8', () => {
  it.each([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3])(
    'nth-order at n = %s matches the integral of du/(1-u)^n',
    (n) => {
      const m = model('nth-order');
      for (const X of [0.1, 0.5, 0.9, 0.99, 0.999]) {
        const closed = m.g(conversionOf(X), { n });
        const numeric = integrateEndpointSingular(() => 1, 1 - X, n);
        expect(numeric.ok).toBe(true);
        if (!numeric.ok) return;
        expect(Math.abs(numeric.value - closed) / Math.max(1, Math.abs(closed))).toBeLessThan(
          1e-8,
        );
      }
    },
  );
});

/**
 * The numeric limit probe, kept as a test oracle.
 *
 * It was considered as the runtime classifier and rejected: `g(Xmax)` is Infinity for
 * some divergent models but NaN for others whose limits are finite, and slow
 * (logarithmic) divergence has *shrinking* successive differences, so a naive decay test
 * calls JMAK convergent when it is not. The difference-RATIO does separate the cases , 
 * convergent tails sit near 0.01 to 0.10 while divergent ones climb toward or past 1, which
 * makes it a good independent check that a model author declared the right limit, even
 * though the declaration itself is what the engine uses.
 */
const probeConverges = (m: KineticModel, params: Params): boolean => {
  const ceiling = m.Xmax(params);
  const values: number[] = [];
  for (let i = 2; i <= 14; i += 2) {
    values.push(m.g(conversionFromGap(ceiling * Math.pow(10, -i), ceiling), params));
  }
  const differences = values.slice(1).map((v, i) => v - (values[i] as number));
  const ratios = differences
    .slice(1)
    .map((d, i) => Math.abs(d / (differences[i] as number)))
    .slice(-3);
  return Math.max(...ratios) < 0.5;
};

describe('declared ceiling limits agree with the numeric probe', () => {
  it.each(CASES.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    const m = model(c.key);
    const declared = m.limitAtCeiling(c.params);
    expect(probeConverges(m, c.params)).toBe(declared.kind === 'finite');
  });

  it('all four diffusion laws reach completion in finite time', () => {
    const m = model('diffusion');
    expect(m.limitAtCeiling({ type: 'D1' })).toEqual({ kind: 'finite', value: 1 });
    expect(m.limitAtCeiling({ type: 'D2' })).toEqual({ kind: 'finite', value: 1 });
    expect(m.limitAtCeiling({ type: 'D3' })).toEqual({ kind: 'finite', value: 1 });
    expect(m.limitAtCeiling({ type: 'D4' })).toEqual({ kind: 'finite', value: 1 / 3 });
  });

  it('D2 has a finite limit even though g cannot be evaluated at the ceiling', () => {
    const m = model('diffusion');
    // 0 * log 0, the reason the limit is declared rather than read off g(1).
    expect(Number.isNaN(m.g(conversionOf(1), { type: 'D2' }))).toBe(true);
    expect(m.limitAtCeiling({ type: 'D2' })).toEqual({ kind: 'finite', value: 1 });
  });

  it('a CSTR converges only below zero order, unlike a batch reactor', () => {
    // At n = 0.5 a batch reactor finishes in finite time and a CSTR never does: as the
    // outlet concentration falls to zero, so does the rate.
    expect(model('nth-order').limitAtCeiling({ n: 0.5 }).kind).toBe('finite');
    expect(model('cstr').limitAtCeiling({ n: 0.5 }).kind).toBe('divergent');
    expect(model('cstr').limitAtCeiling({ n: 0 })).toEqual({ kind: 'finite', value: 1 });
  });

  it('capped models are also asymptotic at their ceiling', () => {
    const reversible = model('reversible-1');
    expect(reversible.Xmax({ Xe: 0.6 })).toBe(0.6);
    expect(reversible.limitAtCeiling({ Xe: 0.6 }).kind).toBe('divergent');

    const two = model('two-reactant');
    expect(two.Xmax({ M: 0.5 })).toBe(0.5);
    expect(two.limitAtCeiling({ M: 0.5 }).kind).toBe('divergent');
  });
});

describe('registry integrity', () => {
  it('holds exactly the nine specified models', () => {
    expect(
      allModels()
        .map((m) => m.key)
        .sort(),
    ).toEqual(
      [
        'autocatalytic',
        'cstr',
        'diffusion',
        'jmak',
        'michaelis-menten',
        'nth-order',
        'reversible-1',
        'two-reactant',
        'var-volume',
      ].sort(),
    );
  });

  it('every model describes itself and declares complete parameter specs', () => {
    for (const m of allModels()) {
      expect(m.notes.length).toBeGreaterThan(0);
      expect(m.params.length).toBeGreaterThan(0);
      const defaults = Object.fromEntries(m.params.map((s) => [s.key, s.default]));
      expect(m.describe(defaults).length).toBeGreaterThan(0);
      for (const spec of m.params) {
        expect(spec.symbol.length).toBeGreaterThan(0);
        expect(spec.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('only the CSTR reports a space time', () => {
    const flow = allModels().filter((m) => m.timeQuantity === 'spaceTime');
    expect(flow.map((m) => m.key)).toEqual(['cstr']);
  });

  it('gives every band ladder enough span to show that the assumption matters', () => {
    /**
     * The band is the app's headline whenever a parameter was assumed, so a ladder that
     * reports "a factor of 1.0" tells a chemist the assumption is harmless. That was true
     * of the generic fallback: sweeping a ratio linearly across its declared domain, M
     * over (0, 100], κ over [0, 100], put every point in the same limiting regime, where
     * the parameter no longer changes the answer. Each ladder now spans the region where
     * it does, and this pins that rather than the particular numbers.
     */
    const observation = { t: 6, X: 0.21, T: 293.15 };
    for (const model of allModels()) {
      const banded = model.params.filter((s) => s.bandValues !== undefined);
      for (const spec of banded) {
        const others = Object.fromEntries(
          model.params.filter((s) => s.key !== spec.key).map((s) => [s.key, s.default]),
        );
        const times = (spec.bandValues as readonly number[])
          .map((value) => {
            const result = solve({
              model: model.key,
              params: { ...others, [spec.key]: value },
              observations: [observation],
              targets: { X: [0.9] },
              temperature: { basis: 293.15 },
              units: { time: 'h', temperature: 'K' },
            });
            return result.ok ? result.value.table[0]?.t : null;
          })
          .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));

        expect(times.length, `${model.key}.${spec.key} produced no usable times`).toBeGreaterThan(1);
        const spread = Math.max(...times) / Math.min(...times);
        expect(spread, `${model.key}.${spec.key} spread ${spread.toFixed(2)}x`).toBeGreaterThan(1.15);
      }
    }
  });

  it('rejects an unknown model by name and lists what is available', () => {
    const missing = lookupModel('not-a-model');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('UNKNOWN_MODEL');
    expect(missing.error.detail?.available).toBeDefined();
  });
});
