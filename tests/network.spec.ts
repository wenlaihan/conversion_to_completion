import { describe, it, expect } from 'vitest';
import {
  fitNetwork,
  parseScheme,
  rateConstantUnits,
  simulate,
  trueRateConstant,
  type TraceBlock,
} from '../src/lib/network.ts';

/**
 * The network module against the closed forms it must reproduce.
 *
 * A -> B -> C has an exact solution (the Bateman equations), and A = B approaches
 * equilibrium with k_obs = kf + kr and an equilibrium ratio of kf/kr. Synthetic traces
 * generated from those forms are the ground truth here; the fitter has to find its way
 * back to the constants that made them.
 */

const times = (n: number, dt: number) => Array.from({ length: n }, (_, i) => i * dt);

/** Bateman: A0 = 100, A -> B -> C with k1, k2. */
const consecutive = (k1: number, k2: number, ts: readonly number[]) => {
  const A = ts.map((t) => 100 * Math.exp(-k1 * t));
  const B = ts.map((t) => ((100 * k1) / (k2 - k1)) * (Math.exp(-k1 * t) - Math.exp(-k2 * t)));
  const C = ts.map((_, i) => 100 - (A[i] as number) - (B[i] as number));
  return { A, B, C };
};

describe('the scheme parser', () => {
  it('reads plain and unicode arrows', () => {
    const p = parseScheme('A -> B\nB → C');
    expect(p.ok).toBe(true);
    expect(p.scheme.species).toEqual(['A', 'B', 'C']);
    expect(p.scheme.steps).toHaveLength(2);
  });

  it('expands a reversible pair into two steps', () => {
    for (const arrow of ['=', '<->', '<=>', '⇌']) {
      const p = parseScheme(`A ${arrow} B`);
      expect(p.ok).toBe(true);
      expect(p.scheme.steps).toMatchObject([
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ]);
    }
  });

  it('refuses what it cannot read, by name', () => {
    expect(parseScheme('A + B -> C').ok).toBe(false);
    expect(parseScheme('A -> A').ok).toBe(false);
    expect(parseScheme('').ok).toBe(false);
    expect(parseScheme('A -> A').error).toContain('itself');
  });
});

describe('the simulator', () => {
  it('reproduces the Bateman solution for A -> B -> C', () => {
    const p = parseScheme('A -> B\nB -> C');
    const ts = times(30, 2);
    const exact = consecutive(0.08, 0.03, ts);
    const model = simulate(p.scheme, [0.08, 0.03], [100, 0, 0], ts);
    ts.forEach((_, i) => {
      expect(model[i]?.[0]).toBeCloseTo(exact.A[i] as number, 6);
      expect(model[i]?.[1]).toBeCloseTo(exact.B[i] as number, 6);
      expect(model[i]?.[2]).toBeCloseTo(exact.C[i] as number, 6);
    });
  });

  it('conserves mass in a closed network', () => {
    const p = parseScheme('A -> B\nB -> C\nC -> A');
    const model = simulate(p.scheme, [0.4, 0.11, 0.05], [60, 30, 10], times(20, 5));
    for (const row of model) {
      expect((row[0] as number) + (row[1] as number) + (row[2] as number)).toBeCloseTo(100, 6);
    }
  });

  it('holds accuracy when the constants are stiff', () => {
    const p = parseScheme('A -> B\nB -> C');
    // A hundredfold spread between the steps: the guard buys steps, not error.
    const ts = [0, 1, 5, 20, 80];
    const exact = consecutive(1.0, 0.01, ts);
    const model = simulate(p.scheme, [1.0, 0.01], [100, 0, 0], ts);
    ts.forEach((_, i) => {
      expect(model[i]?.[1]).toBeCloseTo(exact.B[i] as number, 4);
    });
  });
});

describe('fitting a consecutive scheme', () => {
  const ts = times(25, 2.5);
  const truth = consecutive(0.09, 0.025, ts);
  const block: TraceBlock = {
    times: ts,
    series: { A: truth.A, B: truth.B, C: truth.C },
  };

  it('recovers both rate constants from a clean trace', () => {
    const fit = fitNetwork([block], 'A -> B\nB -> C');
    expect(fit.ok).toBe(true);
    expect(fit.steps[0]?.k).toBeCloseTo(0.09, 3);
    expect(fit.steps[1]?.k).toBeCloseTo(0.025, 3);
    expect(fit.r2).toBeGreaterThan(0.9999);
    // All three species observed: the assignment is unambiguous.
    expect(fit.ambiguous).toBeNull();
  });

  it('names the flip-flop when only the end product is observed', () => {
    /**
     * The documented trap: with only C measured, exchanging k1 and k2 gives exactly the
     * same curve, so no fit can assign which step is the fast one. The fit must say so
     * rather than silently pick.
     */
    const fit = fitNetwork([{ times: ts, series: { C: truth.C } }], 'A -> B\nB -> C');
    expect(fit.ok).toBe(true);
    expect(fit.ambiguous).not.toBeNull();
    expect(fit.ambiguous).toContain('k(A→B)');
  });

  it('refuses a data column the scheme never mentions', () => {
    const fit = fitNetwork([{ times: ts, series: { Q: truth.A } }], 'A -> B');
    expect(fit.ok).toBe(false);
    expect(fit.error).toContain('"Q"');
  });
});

describe('fitting an equilibrium', () => {
  it('finds kf and kr from an approach to equilibrium', () => {
    // A = B with kf = 0.06, kr = 0.02: relaxes at kf + kr toward B/A = 3.
    const kf = 0.06;
    const kr = 0.02;
    const ts = times(30, 2);
    const eq = 100 * (kf / (kf + kr));
    const B = ts.map((t) => eq * (1 - Math.exp(-(kf + kr) * t)));
    const A = ts.map((_, i) => 100 - (B[i] as number));
    const fit = fitNetwork([{ times: ts, series: { A, B } }], 'A = B');
    expect(fit.ok).toBe(true);
    expect(fit.steps[0]?.k).toBeCloseTo(kf, 3);
    expect(fit.steps[1]?.k).toBeCloseTo(kr, 3);
  });
});

describe('replicates', () => {
  it('reports a spread across duplicate runs and none for a single run', () => {
    const ts = times(20, 3);
    const clean = consecutive(0.07, 0.02, ts);
    // Two runs bracketing the truth, as a pair of real replicates would.
    const wiggle = (values: readonly number[], f: number) => values.map((v) => v * f);
    const runA: TraceBlock = {
      times: ts,
      series: { A: wiggle(clean.A, 1.03), B: clean.B, C: wiggle(clean.C, 0.97) },
    };
    const runB: TraceBlock = {
      times: ts,
      series: { A: wiggle(clean.A, 0.97), B: clean.B, C: wiggle(clean.C, 1.03) },
    };

    const single = fitNetwork([runA], 'A -> B\nB -> C');
    expect(single.steps[0]?.kSpread).toBeNull();

    const both = fitNetwork([runA, runB], 'A -> B\nB -> C');
    expect(both.ok).toBe(true);
    // The pooled answer still lands near the truth.
    expect(both.steps[0]?.k).toBeCloseTo(0.07, 2);
    // And the disagreement between the runs surfaces as a spread, not as silence.
    expect(both.steps[0]?.kSpread).not.toBeNull();
    expect(both.steps[0]?.kSpread as number).toBeGreaterThan(0);
  });
});

describe('catalytic and stoichiometric syntax', () => {
  it('reads a catalyst as a species that is unchanged across the arrow', () => {
    const p = parseScheme('S + Cat -> P + Cat');
    expect(p.ok).toBe(true);
    // The catalyst turns over, so it is not one of the varying species...
    expect(p.scheme.species).toEqual(['S', 'P']);
    // ...but it is named, because the rate law needs its concentration.
    expect(p.scheme.catalysts).toEqual(['Cat']);
    expect(p.scheme.steps).toHaveLength(1);
    // Written as a bimolecular step, so k carries M^-1 time^-1.
    expect(p.scheme.steps[0]?.molecularity).toBe(2);
    expect(p.scheme.steps[0]?.catalysts).toEqual(['Cat']);
  });

  it('carries the catalyst through both directions of a reversible step', () => {
    for (const arrow of ['<->', '<=>', '=', '⇌']) {
      const p = parseScheme(`S + Cat ${arrow} P + Cat`);
      expect(p.ok).toBe(true);
      expect(p.scheme.steps).toHaveLength(2);
      expect(p.scheme.steps.every((s) => s.molecularity === 2)).toBe(true);
      expect(p.scheme.steps.every((s) => s.catalysts.includes('Cat'))).toBe(true);
    }
  });

  it('keeps a plain step first order', () => {
    const p = parseScheme('A -> B');
    expect(p.scheme.steps[0]?.molecularity).toBe(1);
    expect(p.scheme.steps[0]?.catalysts).toEqual([]);
    expect(p.scheme.catalysts).toEqual([]);
  });

  it('refuses steps whose reactants both vary, and says why', () => {
    for (const line of ['A + B -> C', '2 A -> B']) {
      const p = parseScheme(line);
      expect(p.ok).toBe(false);
      expect(p.error).toContain('first order in one species');
    }
  });

  it('still refuses a step from a species to itself', () => {
    expect(parseScheme('A -> A').error).toContain('itself');
    expect(parseScheme('A + Cat -> A + Cat').error).toContain('itself');
  });
});

describe('rate constant units', () => {
  const units = { conc: 'M', time: 's' };

  it('follows the molecularity of the step', () => {
    expect(rateConstantUnits(1, units)).toBe('s⁻¹');
    expect(rateConstantUnits(2, units)).toBe('M⁻¹·s⁻¹');
    expect(rateConstantUnits(3, units)).toBe('M⁻²·s⁻¹');
    expect(rateConstantUnits(0, units)).toBe('M·s⁻¹');
  });

  it('uses the time unit it is given', () => {
    expect(rateConstantUnits(2, { conc: 'M', time: 'min' })).toBe('M⁻¹·min⁻¹');
    expect(rateConstantUnits(1, { conc: 'M', time: 'h' })).toBe('h⁻¹');
  });

  it('divides out the catalyst to recover the true constant', () => {
    // The fixture: k_obs = 8.0e-4 per s with [Cat] = 5.0 mM gives k = 0.16 M^-1 s^-1.
    expect(trueRateConstant(8.0e-4, [0.005])).toBeCloseTo(0.16, 10);
    // No catalyst: the fitted constant is already the true one.
    expect(trueRateConstant(0.05, [])).toBe(0.05);
    // A concentration that was never entered cannot produce a constant.
    expect(trueRateConstant(8.0e-4, [0])).toBeNull();
    expect(trueRateConstant(8.0e-4, [Number.NaN])).toBeNull();
  });
});
