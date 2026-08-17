import { describe, expect, it } from 'vitest';
import {
  fmtFactor,
  fmtPercent,
  fmtRate,
  fmtTemp,
  fmtTime,
  meaningfulChange,
} from '../src/lib/format.ts';
import { arrheniusRatio, q10 } from '../src/lib/kinetics.ts';

describe('fmtPercent', () => {
  it('is always a whole number', () => {
    expect(fmtPercent(0.9)).toBe('90%');
    expect(fmtPercent(0.5)).toBe('50%');
    expect(fmtPercent(0.99)).toBe('99%');
    expect(fmtPercent(0.404)).toBe('40%');
  });
  it('never emits a decimal point', () => {
    for (const X of [0.1234, 0.5, 0.905, 0.999]) {
      expect(fmtPercent(X)).not.toContain('.');
    }
  });
});

describe('fmtTime', () => {
  it('caps at the spec examples', () => {
    expect(fmtTime(70.39)).toBe('70');
    expect(fmtTime(2.16)).toBe('2.2');
    expect(fmtTime(5.28)).toBe('5.3');
  });
  it('keeps integers honest above 100', () => {
    expect(fmtTime(132.4)).toBe('132');
    expect(fmtTime(70.0)).toBe('70');
  });
  it('never carries more than 3 significant figures of the value', () => {
    for (const v of [70.39, 2.16, 132.44, 0.5341, 4327.9]) {
      const sig = Math.abs(v) >= 100 ? 3 : 2;
      expect(Number(fmtTime(v)), String(v)).toBe(Number(v.toPrecision(sig)));
    }
  });
});

describe('fmtTemp', () => {
  it('shows whole degrees unless the value carries finer', () => {
    expect(fmtTemp(66)).toBe('66');
    expect(fmtTemp(66.0)).toBe('66');
    expect(fmtTemp(66.5)).toBe('66.5');
    expect(fmtTemp(25.04)).toBe('25');
  });
});

describe('fmtRate', () => {
  it('uses three significant figures in the comfortable range', () => {
    expect(fmtRate(0.047)).toBe('0.047');
    expect(fmtRate(9.412)).toBe('9.41');
    expect(fmtRate(0.16)).toBe('0.16');
  });
  it('switches to scientific notation at the extremes', () => {
    expect(fmtRate(8.0e-4)).toBe('8.00e-4');
    expect(fmtRate(123456)).toBe('1.23e+5');
  });
  it('never renders non-finite values', () => {
    expect(fmtRate(Number.NaN)).toBe('n/a');
    expect(fmtRate(Number.POSITIVE_INFINITY)).toBe('n/a');
  });
});

describe('meaningfulChange, the what-if suppression rule', () => {
  it('suppresses below the 5 percent threshold', () => {
    expect(meaningfulChange(100, 104)).toBe(false);
    expect(meaningfulChange(100, 96)).toBe(false);
  });
  it('reports at and above it', () => {
    expect(meaningfulChange(100, 95)).toBe(true);
    expect(meaningfulChange(2.2, 5.3)).toBe(true);
  });
  it('stays silent on incomplete input', () => {
    expect(meaningfulChange(Number.NaN, 5)).toBe(false);
    expect(meaningfulChange(Number.POSITIVE_INFINITY, 5)).toBe(false);
  });
});

describe('the per-10-degree factor is Arrhenius, not a constant', () => {
  it('matches exp(Ea/R x (1/T - 1/(T+10))) at the reference temperature', () => {
    const R = 8.314462618;
    for (const [Ea, T] of [
      [50_000, 298.15],
      [100_000, 298.15],
      [50_000, 333.15],
    ] as const) {
      const expected = Math.exp((Ea / R) * (1 / T - 1 / (T + 10)));
      expect(q10(Ea, T)).toBeCloseTo(expected, 8);
      expect(q10(Ea, T)).toBeCloseTo(arrheniusRatio(Ea, T, T + 10), 12);
    }
  });
  it('depends on where it is evaluated, so the copy must anchor a temperature', () => {
    expect(q10(50_000, 298.15)).not.toBeCloseTo(q10(50_000, 358.15), 2);
  });
  it('fmtFactor renders it at two significant figures', () => {
    expect(fmtFactor(1.925)).toBe('1.9');
    expect(fmtFactor(3.7189)).toBe('3.7');
  });
});
