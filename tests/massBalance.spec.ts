import { describe, expect, it } from 'vitest';
import {
  detectMassBalance,
  isMassBalanceName,
  looksLikeMassBalance,
} from '../src/lib/massBalance.ts';

describe('mass-balance name matching', () => {
  it('matches the documented variants, units and punctuation included', () => {
    for (const name of [
      'mass balance',
      'massbalance',
      'mass bal',
      'MB',
      'mb (%)',
      'material balance',
      'mat balance',
      'balance',
      'total',
      'sum',
      'total mass',
      'total conc (M)',
      'recovery',
      'Mass Balance (%)',
      'mass_balance_%',
    ]) {
      expect(isMassBalanceName(name), name).toBe(true);
    }
  });

  it('leaves species names alone', () => {
    for (const name of ['Starting Material', 'Product 1', 'SM', 'A', 'B2', 'glucoside']) {
      expect(isMassBalanceName(name), name).toBe(false);
    }
  });
});

describe('mass-balance numeric heuristic', () => {
  const a = [100, 80, 60, 40, 20];
  const b = [0, 19, 39, 58, 79];

  it('flags a column that is the row-wise sum of the others', () => {
    const sum = a.map((v, i) => v + (b[i] as number) + 0.5);
    expect(looksLikeMassBalance(sum, [a, b])).toBe(true);
  });

  it('flags a column approximately constant near 100', () => {
    expect(looksLikeMassBalance([99.8, 100.4, 98.9, 101.7, 99.3], [a, b])).toBe(true);
  });

  it('does not flag an ordinary decay or growth trace', () => {
    expect(looksLikeMassBalance(a, [b])).toBe(false);
    expect(looksLikeMassBalance(b, [a])).toBe(false);
  });
});

describe('detectMassBalance over a run', () => {
  it('detects by name and by numbers, and never eats real species', () => {
    const series = {
      'Starting Material': [0.1, 0.075, 0.051, 0.025, 0.01],
      'Product 1': [0, 0.016, 0.034, 0.05, 0.06],
      'Mass Balance (%)': [99.8, 98.6, 101.7, 99.4, 100.9],
    };
    expect(detectMassBalance(series)).toEqual(['Mass Balance (%)']);
  });

  it('catches an unnamed total via the sum route', () => {
    const series = {
      A: [100, 80, 60, 40, 20],
      B: [0, 19, 39, 58, 79],
      Check: [100.2, 99.4, 99.6, 98.5, 99.8],
    };
    expect(detectMassBalance(series)).toEqual(['Check']);
  });

  it('returns nothing for a clean two-species run', () => {
    expect(detectMassBalance({ A: [100, 60, 30, 12, 4], B: [0, 39, 68, 87, 95] })).toEqual([]);
  });
});
