import { describe, it, expect } from 'vitest';
import {
  NOT_REACHABLE,
  arrheniusRatio,
  conversionAtTimeStepped,
  timeToConversionStepped,
  completionTime,
  conversionAtTime,
  halfLife,
  isReachable,
  logTimeShiftDecades,
  q10,
  rateConstantUnits,
  timeToConversion,
  type MaybeTime,
  type RateParams,
} from '../src/lib/kinetics.ts';

/**
 * The fixtures are cross-checked against closed-form results and quoted to six decimal
 * places, so they are compared at the precision they are published to rather than at
 * machine epsilon.
 *
 * Times are in minutes, k = 0.03 in order-appropriate units, C0 = 1.7 M throughout.
 */

const C0 = 1.7;
const k = 0.03;
const at = (n: number): RateParams => ({ k, n, C0 });

/** Reads a MaybeTime for comparison, failing loudly rather than coercing a sentinel. */
const minutes = (value: MaybeTime): number => {
  if (!isReachable(value)) throw new Error('expected a finite time, got the sentinel');
  return value;
};

describe('the conversion time table', () => {
  const TABLE = [
    { n: 0, t50: 28.333333, t90: 51.0, t99: 56.1, completion: 56.666667 },
    { n: 0.5, t50: 25.459069, t90: 59.435328, t99: 78.230429, completion: 86.922699 },
    { n: 1, t50: 23.104906, t90: 76.752836, t99: 153.505673, completion: null },
    { n: 1.5, t50: 21.179153, t90: 110.559417, t99: 460.178993, completion: null },
    { n: 2, t50: 19.607843, t90: 176.470588, t99: 1941.176471, completion: null },
  ] as const;

  it.each(TABLE)('reproduces the published times at n = $n', (row) => {
    expect(minutes(timeToConversion(0.5, at(row.n)))).toBeCloseTo(row.t50, 6);
    expect(minutes(timeToConversion(0.9, at(row.n)))).toBeCloseTo(row.t90, 6);
    expect(minutes(timeToConversion(0.99, at(row.n)))).toBeCloseTo(row.t99, 6);
  });

  it.each(TABLE)('agrees on whether n = $n ever finishes', (row) => {
    const finish = completionTime(at(row.n));
    if (row.completion === null) {
      // At n >= 1 the last trace of reactant never disappears.
      expect(finish).toBe(NOT_REACHABLE);
      expect(timeToConversion(1, at(row.n))).toBe(NOT_REACHABLE);
    } else {
      expect(minutes(finish)).toBeCloseTo(row.completion, 6);
      expect(minutes(timeToConversion(1, at(row.n)))).toBeCloseTo(row.completion, 6);
    }
  });

  it('matches the closed forms it was derived from', () => {
    // Half life at first order is ln2/k, independent of C0.
    expect(minutes(halfLife(at(1)))).toBeCloseTo(Math.LN2 / k, 9);
    // At zero order it is half the starting material divided by a constant rate.
    expect(minutes(halfLife(at(0)))).toBeCloseTo((0.5 * C0) / k, 9);
    // At second order it is 1/(k C0).
    expect(minutes(halfLife(at(2)))).toBeCloseTo(1 / (k * C0), 9);
    // X(t) = kC0t/(1 + kC0t) at n = 2.
    expect(conversionAtTime(50, at(2))).toBeCloseTo(0.718309859, 9);
  });

  it('inverts itself: the time to a conversion returns that conversion', () => {
    for (const n of [0, 0.5, 1, 1.5, 2]) {
      for (const X of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
        const t = minutes(timeToConversion(X, at(n)));
        expect(conversionAtTime(t, at(n))).toBeCloseTo(X, 9);
      }
    }
  });
});

describe('one measurement does not fix the order', () => {
  /**
   * A single point at 40% conversion after 30 minutes. Each order below has had its rate
   * constant chosen so its curve passes exactly through that point, and every one of
   * them does. They separate only afterward, and the later you look the more they
   * disagree: a factor of 6 at 90% conversion and a factor of 60 at 99%.
   */
  const FITTED = [
    { n: 0, k: 0.022667, t90: 67.5, t99: 74.25 },
    { n: 0.5, k: 0.019593, t90: 91.006, t99: 119.785 },
    { n: 1, k: 0.017028, t90: 135.227, t99: 270.455 },
    { n: 1.5, k: 0.014879, t90: 222.919, t99: 927.853 },
    { n: 2, k: 0.013072, t90: 405.0, t99: 4455.0 },
  ] as const;

  it.each(FITTED)('passes through the measured point at n = $n', (row) => {
    // The fitted rate constants are quoted to six decimals, so a relative error of about
    // 2.5e-5 in k is baked into the fixture and carries straight through to the time.
    // Two decimals on a 30 minute reading (under a second) is well inside that and still
    // shows every order landing on the same point.
    expect(minutes(timeToConversion(0.4, { k: row.k, n: row.n, C0 }))).toBeCloseTo(30.0, 2);
  });

  it.each(FITTED)('then diverges by n = $n', (row) => {
    expect(minutes(timeToConversion(0.9, { k: row.k, n: row.n, C0 }))).toBeCloseTo(row.t90, 2);
    expect(minutes(timeToConversion(0.99, { k: row.k, n: row.n, C0 }))).toBeCloseTo(row.t99, 1);
  });

  it('spreads wider the further past the measurement you ask', () => {
    const times = (X: number) =>
      FITTED.map((row) => minutes(timeToConversion(X, { k: row.k, n: row.n, C0 })));
    const spread = (X: number) => Math.max(...times(X)) / Math.min(...times(X));
    expect(spread(0.4)).toBeCloseTo(1, 3); // the measured point, where they agree
    expect(spread(0.9)).toBeGreaterThan(5);
    expect(spread(0.99)).toBeGreaterThan(55);
    // Monotone: no conversion level is less discriminating than a shallower one.
    expect(spread(0.99)).toBeGreaterThan(spread(0.9));
    expect(spread(0.9)).toBeGreaterThan(spread(0.5));
  });
});

describe('temperature is a pure rescaling of time', () => {
  const ARRHENIUS = [
    { Ea: 65_000, T1: 298.15, T2: 318.15, ratio: 5.198257, decades: 0.715858 },
    { Ea: 50_000, T1: 298.15, T2: 308.15, ratio: 1.924265, decades: 0.284265 },
    { Ea: 44_550, T1: 298.15, T2: 313.15, ratio: 2.365124, decades: 0.373854 },
    { Ea: 100_000, T1: 298.15, T2: 308.15, ratio: 3.702795, decades: 0.56853 },
  ] as const;

  it.each(ARRHENIUS)('gives k2/k1 = $ratio at Ea = $Ea J/mol', (row) => {
    expect(arrheniusRatio(row.Ea, row.T1, row.T2)).toBeCloseTo(row.ratio, 6);
    expect(logTimeShiftDecades(row.Ea, row.T1, row.T2)).toBeCloseTo(row.decades, 6);
  });

  it('multiplies every time on the curve by the same factor', () => {
    /**
     * Every expression for t(X) is proportional to 1/k, so at fixed order and fixed
     * starting concentration a change in rate constant rescales the whole curve and
     * changes nothing about its shape. This is the cheapest possible check that the
     * temperature feature is wired to the mathematics rather than to a guess.
     */
    for (const n of [0, 0.5, 1, 1.5, 2]) {
      for (const factor of [0.25, 1.924265, 5.198257, 40]) {
        for (const X of [0.25, 0.5, 0.75, 0.9, 0.99]) {
          const slow = minutes(timeToConversion(X, { k, n, C0 }));
          const fast = minutes(timeToConversion(X, { k: k * factor, n, C0 }));
          expect(slow / fast).toBeCloseTo(factor, 9);
        }
      }
    }
  });

  it('slides the curve rigidly on a log time axis', () => {
    // The same statement in the form the log-time toggle makes visible: one translation,
    // identical at every conversion level and for every order.
    const ratio = arrheniusRatio(65_000, 298.15, 318.15);
    const shift = logTimeShiftDecades(65_000, 298.15, 318.15);
    for (const n of [0, 0.5, 1, 1.5, 2]) {
      for (const X of [0.25, 0.5, 0.9, 0.99]) {
        const before = Math.log10(minutes(timeToConversion(X, { k, n, C0 })));
        const after = Math.log10(minutes(timeToConversion(X, { k: k * ratio, n, C0 })));
        expect(before - after).toBeCloseTo(shift, 9);
      }
    }
  });

  it('computes Q10 rather than asserting that rates double', () => {
    // The rule of thumb holds near 53 kJ/mol at room temperature and nowhere else.
    expect(q10(53_000, 298.15)).toBeCloseTo(2.0, 1);
    expect(q10(50_000, 298.15)).toBeCloseTo(1.924265, 6);
    expect(q10(100_000, 298.15)).toBeCloseTo(3.702795, 6);
    // The same ten Kelvin step, nearly twice the factor: this is why it cannot be a
    // constant in a sentence.
    expect(q10(100_000, 298.15) / q10(50_000, 298.15)).toBeGreaterThan(1.9);
  });

  it('refuses a temperature at or below absolute zero', () => {
    expect(arrheniusRatio(50_000, 0, 300)).toBeNaN();
    expect(arrheniusRatio(50_000, 300, -5)).toBeNaN();
  });
});

describe('the two branches agree in the limit', () => {
  it('converges to the logarithmic result as n approaches 1', () => {
    /**
     * The general result divides by (1 - n), which is undefined at n = 1. The split into
     * two cases is an artefact of how the integral is written rather than of the physics,
     * and the numbers must not notice the seam.
     */
    const atOne = minutes(timeToConversion(0.9, at(1)));
    const gapAt = (delta: number) =>
      Math.max(
        Math.abs(minutes(timeToConversion(0.9, at(1 - delta))) - atOne),
        Math.abs(minutes(timeToConversion(0.9, at(1 + delta))) - atOne),
      );

    // Convergence is the claim, so the tolerance has to shrink with the step rather than
    // sit at a constant: t varies with n at about 48 minutes per unit order here, and a
    // fixed tolerance would either pass vacuously or fail on the widest step.
    const deltas = [1e-3, 1e-5, 1e-7, 1e-9, 1e-11];
    for (const delta of deltas) {
      expect(gapAt(delta)).toBeLessThan(100 * delta);
    }
    // And it must actually be shrinking, not merely small.
    const gaps = deltas.map(gapAt);
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i] as number).toBeLessThan(gaps[i - 1] as number);
    }
  });

  it('stays monotone in n across the seam', () => {
    // A hard branch switch flattens a window around n = 1 into a plateau of identical
    // values, which is what makes an order fit stall there.
    const orders = [0.999_999, 0.999_999_9, 1 - 1e-10, 1, 1 + 1e-10, 1.000_000_1, 1.000_001];
    const times = orders.map((n) => minutes(timeToConversion(0.9, at(n))));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] as number).toBeGreaterThan(times[i - 1] as number);
    }
  });
});

describe('a temperature step mid-run', () => {
  // Heat at 30 minutes from 25 to 66 C at Ea = 50 kJ/mol: the 11.45x the app shows.
  const kCold = 0.017028;
  const ratio = arrheniusRatio(50_000, 298.15, 339.15);
  const p: RateParams = { k: kCold, n: 1, C0: 1.7 };
  const step = { tSwitch: 30, kAfter: kCold * ratio };

  it('is continuous at the switch', () => {
    for (const n of [0, 0.5, 1, 1.5, 2]) {
      const pn = { k: 0.03, n, C0: 1.7 };
      const sn = { tSwitch: 20, kAfter: 0.03 * 5.198257 };
      const left = conversionAtTimeStepped(20 - 1e-9, pn, sn);
      const right = conversionAtTimeStepped(20 + 1e-9, pn, sn);
      expect(right - left).toBeGreaterThanOrEqual(0);
      expect(right - left).toBeLessThan(1e-6);
    }
  });

  it('collapses to the uniform shift when the switch is at the start', () => {
    const uniform = { k: p.k * ratio, n: 1, C0: 1.7 };
    for (const X of [0.25, 0.5, 0.9, 0.99]) {
      expect(minutes(timeToConversionStepped(X, p, { ...step, tSwitch: 0 }))).toBeCloseTo(
        minutes(timeToConversion(X, uniform)),
        9,
      );
    }
  });

  it('leaves everything before the switch untouched', () => {
    for (const t of [5, 15, 29.9]) {
      expect(conversionAtTimeStepped(t, p, step)).toBeCloseTo(conversionAtTime(t, p), 12);
    }
    // 40% arrives around 30 min at this k, so 25% is squarely on the first segment.
    const early = minutes(timeToConversionStepped(0.25, p, step));
    expect(early).toBeCloseTo(minutes(timeToConversion(0.25, p)), 9);
    expect(early).toBeLessThan(30);
  });

  it('matches the closed form after the switch at first order', () => {
    // Xs = 1 - exp(-k1 ts); then t(X) = ts + ln((1 - Xs)/(1 - X)) / k2.
    const Xs = 1 - Math.exp(-p.k * 30);
    const k2 = p.k * ratio;
    for (const X of [0.9, 0.99]) {
      const expected = 30 + Math.log((1 - Xs) / (1 - X)) / k2;
      expect(minutes(timeToConversionStepped(X, p, step))).toBeCloseTo(expected, 6);
    }
  });

  it('inverts itself across the seam', () => {
    for (const X of [0.5, 0.9, 0.99]) {
      const t = minutes(timeToConversionStepped(X, p, step));
      expect(conversionAtTimeStepped(t, p, step)).toBeCloseTo(X, 9);
    }
  });

  it('still refuses complete conversion at n >= 1, on either segment', () => {
    expect(timeToConversionStepped(1, p, step)).toBe(NOT_REACHABLE);
  });

  it('finishes early when the reaction completes before the switch', () => {
    const fast = { k: 0.2, n: 0, C0: 1 }; // completes at t = 5
    const late = { tSwitch: 30, kAfter: 0.4 };
    expect(minutes(timeToConversionStepped(1, fast, late))).toBeCloseTo(5, 9);
    expect(conversionAtTimeStepped(40, fast, late)).toBe(1);
  });
});

describe('nothing non-finite reaches a caller', () => {
  it('clamps n < 1 to exactly complete past its completion time', () => {
    const finish = minutes(completionTime(at(0.5)));
    expect(conversionAtTime(finish, at(0.5))).toBe(1);
    expect(conversionAtTime(2 * finish, at(0.5))).toBe(1);
    expect(conversionAtTime(1e6, at(0.5))).toBe(1);
    // The unclamped formula raises a negative base to a fractional power here.
    expect(Number.isNaN(conversionAtTime(2 * finish, at(0.5)))).toBe(false);
  });

  it('never returns a negative zero', () => {
    for (const n of [0, 0.5, 1, 1.5, 2]) {
      expect(Object.is(timeToConversion(0, at(n)), -0)).toBe(false);
      expect(Object.is(conversionAtTime(0, at(n)), -0)).toBe(false);
      expect(Object.is(conversionAtTime(1e-12, at(n)), -0)).toBe(false);
    }
  });

  it('has defined behaviour at every guarded input', () => {
    expect(timeToConversion(0, at(1))).toBe(0);
    expect(conversionAtTime(0, at(1))).toBe(0);
    expect(conversionAtTime(-5, at(1))).toBe(0);
    expect(timeToConversion(1.5, at(1))).toBe(NOT_REACHABLE);
    // Nothing happens without a rate constant or without any starting material.
    expect(timeToConversion(0.5, { k: 0, n: 1, C0 })).toBe(NOT_REACHABLE);
    expect(timeToConversion(0.5, { k: -1, n: 1, C0 })).toBe(NOT_REACHABLE);
    expect(timeToConversion(0.5, { k, n: 1, C0: 0 })).toBe(NOT_REACHABLE);
    expect(conversionAtTime(10, { k: 0, n: 1, C0 })).toBe(0);
    expect(conversionAtTime(10, { k, n: 1, C0: 0 })).toBe(0);
    // A NaN input produces a defined answer rather than propagating.
    expect(timeToConversion(Number.NaN, at(1))).toBe(0);
    expect(conversionAtTime(Number.NaN, at(1))).toBe(0);
    expect(timeToConversion(0.5, { k, n: Number.NaN, C0 })).toBe(NOT_REACHABLE);
  });
});

describe('the rate constant carries order-dependent units', () => {
  const units = { conc: 'M', time: 'min' } as const;

  it('is concentration per time at zero order', () => {
    expect(rateConstantUnits(0, units)).toBe('M·min⁻¹');
  });

  it('is reciprocal time only at first order', () => {
    expect(rateConstantUnits(1, units)).toBe('min⁻¹');
  });

  it('is reciprocal concentration per time at second order', () => {
    expect(rateConstantUnits(2, units)).toBe('M⁻¹·min⁻¹');
  });

  it('handles fractional orders', () => {
    expect(rateConstantUnits(0.5, units)).toBe('M^0.5·min⁻¹');
    expect(rateConstantUnits(1.5, units)).toBe('M^-0.5·min⁻¹');
  });

  it('follows the unit labels it is given', () => {
    expect(rateConstantUnits(1, { conc: 'mol/L', time: 's' })).toBe('s⁻¹');
    expect(rateConstantUnits(0, { conc: 'mol/L', time: 's' })).toBe('mol/L·s⁻¹');
  });
});
