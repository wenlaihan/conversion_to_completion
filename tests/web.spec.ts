import { describe, it, expect } from 'vitest';
// @ts-expect-error: browser module, shipped without type declarations by design.
import { labelBox, placeAnnotations, sampleSeries, timeScale } from '../web/curve.js';

/**
 * The chart's geometry, tested where it is pure.
 *
 * This file used to drive the whole five-view app through a hand-rolled DOM stub. The
 * rebuild split that monolith into a DOM layer and the arithmetic underneath it, so what
 * is worth pinning now is what decides what a reader can actually see: which labels
 * survive a crowded axis, where the ticks land, and whether a curve that finishes stops
 * when it finishes.
 */

interface Mark {
  X: number;
  px: number;
  py: number;
  label: string;
}

const mark = (X: number, px: number, py: number): Mark => ({
  X,
  px,
  py,
  label: `${X * 100}% at 100 min`,
});

const place = (marks: Mark[]) => placeAnnotations(marks).placed as {
  x0: number;
  x1: number;
  y: number;
  mark: Mark;
}[];

const kept = (placed: { mark: Mark }[]) => placed.map((p) => p.mark.X);

describe('the time axis', () => {
  it('puts linear ticks on round numbers', () => {
    const scale = timeScale({ tMax: 271, log: false });
    expect(scale.log).toBe(false);
    // A reader should never have to parse 271/6 = 45.17 as a gridline.
    for (const tick of scale.ticks) {
      expect(Number.isInteger(tick / 50) || Number.isInteger(tick)).toBe(true);
    }
    expect(scale.ticks[0]).toBe(0);
    expect(scale.hi).toBeGreaterThanOrEqual(271);
  });

  it('covers the data it was given', () => {
    for (const tMax of [1, 9.7, 135.2, 4455, 1e5]) {
      const scale = timeScale({ tMax, log: false });
      expect(scale.hi).toBeGreaterThanOrEqual(tMax);
      expect(scale.toPx(tMax)).toBeLessThanOrEqual(scale.toPx(scale.hi) + 1e-9);
    }
  });

  it('steps by decades when logarithmic, and round-trips a time', () => {
    const scale = timeScale({ tMax: 1000, log: true });
    expect(scale.log).toBe(true);
    // Only 1, 2 and 5 times a power of ten, so the axis reads as decades.
    for (const tick of scale.ticks) {
      const mantissa = tick / 10 ** Math.floor(Math.log10(tick));
      expect([1, 2, 5]).toContain(Number(mantissa.toPrecision(6)));
    }
    for (const t of [3, 30, 300]) {
      expect(scale.fromPx(scale.toPx(t))).toBeCloseTo(t, 6);
    }
  });

  it('turns a rate constant ratio into a rigid pixel shift', () => {
    /**
     * The whole reason the logarithmic axis exists: a temperature change multiplies every
     * time by one factor, so on a log axis it becomes one translation, the same at 50% as
     * at 99%. If this stopped holding, the log toggle would be decoration.
     */
    const scale = timeScale({ tMax: 5000, log: true });
    const factor = 5.198257;
    // Both the time and its shifted partner have to sit inside the axis: below the floor
    // the scale deliberately clamps to the left edge, which is the right rendering for a
    // point that is off-scale and the wrong place to measure a translation.
    const shifts = [100, 500, 2000].map((t) => scale.toPx(t) - scale.toPx(t / factor));
    for (const shift of shifts) expect(shift).toBeCloseTo(shifts[0] as number, 6);
  });
});

describe('sampling a curve', () => {
  const scale = timeScale({ tMax: 100, log: false });

  it('spans the plot when the curve never finishes', () => {
    const points = sampleSeries(scale, (t: number) => 1 - Math.exp(-t / 20));
    expect(points.length).toBeGreaterThan(100);
    expect(points[0]?.[0]).toBeCloseTo(62, 0); // the left edge of the plot area
    // Conversion never leaves the panel.
    for (const [, py] of points) {
      expect(py).toBeLessThanOrEqual(330.001);
      expect(py).toBeGreaterThanOrEqual(21.999);
    }
  });

  it('stops where a reaction that finishes actually finishes', () => {
    // At n < 1 the curve reaches 100% at a definite time and ends there, rather than
    // running along the ceiling implying that later times still mean something.
    const points = sampleSeries(scale, (t: number) => Math.min(t / 40, 1), 40);
    const last = points[points.length - 1] as [number, number];
    expect(scale.fromPx(last[0])).toBeCloseTo(40, 6);
    expect(last[1]).toBeCloseTo(22, 6); // exactly 100%
    for (const [px] of points) expect(scale.fromPx(px)).toBeLessThanOrEqual(40.000001);
  });
});

describe('annotation placement', () => {
  it('keeps every label when they are far apart', () => {
    const marks = [
      mark(0.25, 120, 250),
      mark(0.5, 260, 190),
      mark(0.75, 400, 120),
      mark(0.9, 540, 70),
      mark(0.99, 660, 30),
    ];
    expect(kept(place(marks)).sort()).toEqual([0.25, 0.5, 0.75, 0.9, 0.99]);
  });

  it('never lets placed labels overlap, and drops by priority when it must', () => {
    /**
     * Every one of the five anchored on the same point. The placer now has seven
     * candidate positions per label, so most survive by moving; the real invariants are
     * that whatever is placed does not overlap, and that any drops come from the bottom
     * of the priority order.
     */
    const marks = [0.25, 0.5, 0.75, 0.9, 0.99].map((X) => mark(X, 300, 200));
    const placed = place(marks);
    expect(placed.length).toBeGreaterThan(0);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i] as { x0: number; x1: number; y0: number; y1: number };
        const b = placed[j] as { x0: number; x1: number; y0: number; y1: number };
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
      }
    }
    const priority = [0.9, 0.5, 0.99, 0.75, 0.25];
    const survivors = kept(placed);
    expect(survivors).toEqual(priority.slice(0, survivors.length));
  });

  it('gives the headline conversion the position it wants', () => {
    // 90 is placed first and therefore keeps the natural spot above its own dot; anything
    // else colliding with it has to move rather than push it aside.
    const both = place([mark(0.5, 300, 200), mark(0.9, 302, 200)]);
    expect(kept(both)[0]).toBe(0.9);
    const ninety = both.find((s) => s.mark.X === 0.9) as { y: number; mark: Mark };
    expect(ninety.y).toBeCloseTo(200 - 15, 6);
  });

  it('never places two labels on top of each other', () => {
    const marks = [0.25, 0.5, 0.75, 0.9, 0.99].map((X, i) => mark(X, 300 + i * 12, 200));
    const placed = place(marks);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i] as { x0: number; x1: number; y: number };
        const b = placed[j] as { x0: number; x1: number; y: number };
        const overlaps = Math.abs(a.y - b.y) < 17 && a.x0 < b.x1 && b.x0 < a.x1;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('routes around boxes it was told are already occupied', () => {
    /**
     * Regression: the pass used to copy the reserved list instead of threading it, so the
     * boxes it placed were invisible to whatever ran next. On screen that showed up as a
     * curve's own name sitting on top of an annotation, in nine of nineteen input states.
     */
    const occupied = [labelBox(300, 185, 'n=0.5'), labelBox(300, 215, 'n=1')];
    const { placed, taken } = placeAnnotations([mark(0.9, 300, 200)], occupied);
    expect(placed).toHaveLength(1);

    const overlaps = (a: { x0: number; x1: number; y0: number; y1: number }, b: typeof a) =>
      a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    for (const blocked of occupied) {
      expect(overlaps(placed[0] as never, blocked as never)).toBe(false);
    }
    // And it hands back everything it occupied, so the next pass can see its work.
    expect(taken.length).toBe(occupied.length + placed.length);
  });

  it('always draws a completion mark, which is an answer rather than a gridline', () => {
    // X = 1 is not one of the percentile levels, so it is never a candidate for dropping.
    const marks = [mark(0.9, 300, 200), { ...mark(1, 300, 200), label: 'complete at 57 min' }];
    expect(kept(place(marks))).toContain(1);
  });
});
