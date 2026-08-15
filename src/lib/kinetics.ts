import type { Conversion, Params } from '../domain/types.ts';
import { conversionOf } from '../domain/types.ts';
import { R_GAS } from '../domain/constants.ts';
import { lookupModel } from '../models/registry.ts';
import { conversionAt, timeAt } from '../solver/predict.ts';

/**
 * The single entry point for anything that computes.
 *
 * Every page imports from here. Nothing recomputes kinetics inline, and nothing below
 * this file is re-implemented here: the equations live in the registry model and the
 * solver, and this module is the nth-order-shaped face of them. `tests/kinetics.spec.ts`
 * pins its output against the published closed forms, so a divergence between the two is
 * a build failure rather than a quiet disagreement between pages.
 *
 * With rate = k*C^n and C = C0(1 - X), the engine works in the lumped constant
 * K = k*C0^(n-1), which has units of reciprocal time for every order. That is what lets
 * one solver serve every model. The rate constant k does not have order-independent
 * units, which is why `rateConstantUnits` exists and why no caller may hardcode one.
 *
 * Units are consistent rather than fixed: pass k in per-minute units and times come back
 * in minutes. The application boundary converts to seconds and Kelvin on the way in and
 * back again on the way out.
 */

/* ------------------------------------------------------------------ *
 * Sentinel
 * ------------------------------------------------------------------ */

/**
 * A target that no finite time reaches.
 *
 * Never `Infinity`. `JSON.stringify` renders both `Infinity` and `NaN` as `null`, so an
 * asymptotic answer would arrive at the UI indistinguishable from "not computed", which
 * is the one distinction this app exists to make. A string survives serialization and
 * forces the caller to handle it.
 */
export const NOT_REACHABLE = 'not-reachable';
export type NotReachable = typeof NOT_REACHABLE;
export type MaybeTime = number | NotReachable;

export const isReachable = (value: MaybeTime): value is number => value !== NOT_REACHABLE;

export interface RateParams {
  /** Rate constant, in units of concentration^(1-n) per unit time. */
  readonly k: number;
  /** Reaction order. */
  readonly n: number;
  /** Initial concentration of the limiting reactant. */
  readonly C0: number;
}

/* ------------------------------------------------------------------ *
 * Bridge to the registry
 * ------------------------------------------------------------------ */

const model = (() => {
  // Named once, at the boundary. `src/lib` sits above the registry, so unlike the solver
  // layer it may know which model it fronts; this facade is nth-order by definition, and
  // an implicit dependency on "the registry default happens to be nth-order" would be
  // less honest than saying so here.
  const found = lookupModel('nth-order');
  if (!found.ok) throw new Error('nth-order missing from the registry');
  return found.value;
})();

const paramsFor = (n: number): Params => ({ n });

/**
 * k to K, the lumped constant the solver works in.
 *
 * A non-positive k means nothing ever happens, and C0 <= 0 has no defined lumped
 * constant at any order but 1. Both are caught here rather than left to become a NaN
 * four calls later.
 */
const lumped = (p: RateParams): number | null => {
  if (!Number.isFinite(p.k) || p.k <= 0) return null;
  if (!Number.isFinite(p.C0) || p.C0 <= 0) return null;
  if (!Number.isFinite(p.n)) return null;
  const K = model.kFromRateConstant(p.k, p.C0, paramsFor(p.n));
  if (!K.ok || !Number.isFinite(K.value) || K.value <= 0) return null;
  return K.value;
};

/** Guards X into the closed unit interval, keeping `remaining` free of cancellation. */
const conversion = (X: number): Conversion => conversionOf(Math.min(Math.max(X, 0), 1));

/* ------------------------------------------------------------------ *
 * The four curve questions
 * ------------------------------------------------------------------ */

/**
 * Time at which conversion reaches exactly 1, for the orders where that happens.
 *
 * Finite only for n < 1, at t_c = 1 / [(1-n) * k * C0^(n-1)]. At n >= 1 the integral
 * diverges at the endpoint and no such time exists.
 */
export const completionTime = (p: RateParams): MaybeTime => {
  const K = lumped(p);
  if (K === null) return NOT_REACHABLE;
  if (p.n >= 1) return NOT_REACHABLE;

  const limit = model.limitAtCeiling(paramsFor(p.n));
  if (limit.kind !== 'finite' || !Number.isFinite(limit.value)) return NOT_REACHABLE;
  return limit.value / K + 0;
};

/**
 * Conversion reached after time t, always within [0, 1].
 *
 * For n < 1 the reaction genuinely finishes, so past the completion time this returns
 * exactly 1. The unclamped expression would raise a negative base to a fractional power
 * and produce NaN, which is the most common way this family of formulas fails.
 */
export const conversionAtTime = (t: number, p: RateParams): number => {
  if (!Number.isFinite(t) || t <= 0) return 0;
  const K = lumped(p);
  if (K === null) return 0;

  const finish = completionTime(p);
  if (isReachable(finish) && t >= finish) return 1;

  const solved = conversionAt(model, paramsFor(p.n), K, t);
  if (!solved.ok || !Number.isFinite(solved.value.X)) return 0;
  return Math.min(Math.max(solved.value.X, 0), 1);
};

/**
 * Time to reach conversion X, or the sentinel when nothing reaches it.
 *
 * At n >= 1 the last trace of reactant never disappears, so X = 1 is unreachable however
 * long you wait. At n < 1 it arrives at a definite time and is answered exactly.
 */
export const timeToConversion = (X: number, p: RateParams): MaybeTime => {
  if (!Number.isFinite(X) || X <= 0) return 0;
  if (X > 1) return NOT_REACHABLE;
  const K = lumped(p);
  if (K === null) return NOT_REACHABLE;

  if (X === 1) return completionTime(p);

  const solved = timeAt(model, paramsFor(p.n), K, conversion(X));
  if (!solved.ok || !Number.isFinite(solved.value) || solved.value < 0) return NOT_REACHABLE;
  // Adding zero normalizes a negative zero, which would otherwise render as "-0".
  return solved.value + 0;
};

/** Time to half conversion. Constant in C0 only at n = 1, which is the point of showing it. */
export const halfLife = (p: RateParams): MaybeTime => timeToConversion(0.5, p);

/* ------------------------------------------------------------------ *
 * A temperature step mid-run
 * ------------------------------------------------------------------ */

/**
 * The same reaction, run at a new rate constant from one moment onward.
 *
 * These kinetics are memoryless: the whole state of the reaction is its conversion. So
 * a temperature change at time tSwitch does not need a new solver, only a change of
 * clock: the run continues along the new-temperature curve entered at the conversion
 * already reached, k2 * (t - tSwitch) = g(X) - g(Xs).
 */
export interface RateStep {
  /** When the rate constant changes, in the same time unit k is expressed in. */
  readonly tSwitch: number;
  /** The rate constant from that moment on. */
  readonly kAfter: number;
}

/** Conversion at time t under a step schedule. */
export const conversionAtTimeStepped = (t: number, p: RateParams, step: RateStep): number => {
  const after: RateParams = { ...p, k: step.kAfter };
  if (!(step.tSwitch > 0)) return conversionAtTime(t, after);
  if (t <= step.tSwitch) return conversionAtTime(t, p);
  const Xs = conversionAtTime(step.tSwitch, p);
  if (Xs >= 1) return 1;
  const tEquiv = timeToConversion(Xs, after);
  if (!isReachable(tEquiv)) return Xs;
  return conversionAtTime(tEquiv + (t - step.tSwitch), after);
};

/** Time to reach conversion X under a step schedule, or the sentinel. */
export const timeToConversionStepped = (X: number, p: RateParams, step: RateStep): MaybeTime => {
  const after: RateParams = { ...p, k: step.kAfter };
  if (!(step.tSwitch > 0)) return timeToConversion(X, after);
  const before = timeToConversion(X, p);
  // Reached on the first segment: the switch never mattered for this target.
  if (isReachable(before) && before <= step.tSwitch) return before;
  const Xs = conversionAtTime(step.tSwitch, p);
  if (Xs >= 1) return timeToConversion(X, p);
  const tEquiv = timeToConversion(Xs, after);
  const tTarget = timeToConversion(X, after);
  if (!isReachable(tEquiv) || !isReachable(tTarget)) return NOT_REACHABLE;
  return step.tSwitch + (tTarget - tEquiv) + 0;
};

/* ------------------------------------------------------------------ *
 * Units
 * ------------------------------------------------------------------ */

const SUPERSCRIPT: Readonly<Record<string, string>> = { '-': '⁻', '1': '¹', '2': '²', '3': '³' };

const superscript = (value: number): string => {
  const text = String(value);
  return [...text].every((ch) => ch in SUPERSCRIPT)
    ? [...text].map((ch) => SUPERSCRIPT[ch] as string).join('')
    : `^${text}`;
};

export interface UnitLabels {
  /** Concentration unit, for example "M". */
  readonly conc: string;
  /** Time unit, for example "min". */
  readonly time: string;
}

/**
 * The units of k at a given order.
 *
 * k carries concentration^(1-n) * time^-1, so it reads `M*min^-1` at zero order,
 * `min^-1` at first order and `M^-1*min^-1` at second. Printing `min^-1` for every order
 * is wrong and is a common bug, so each of those three has its own test.
 */
export const rateConstantUnits = (n: number, units: UnitLabels): string => {
  const perTime = `${units.time}${superscript(-1)}`;
  if (!Number.isFinite(n)) return perTime;
  const exponent = Number((1 - n).toPrecision(12));
  if (exponent === 0) return perTime;
  if (exponent === 1) return `${units.conc}·${perTime}`;
  return `${units.conc}${superscript(exponent)}·${perTime}`;
};

/* ------------------------------------------------------------------ *
 * Temperature
 * ------------------------------------------------------------------ */

/**
 * k(T2)/k(T1) = exp[-Ea/R * (1/T2 - 1/T1)], temperatures in Kelvin.
 *
 * Because every expression for t(X) is proportional to 1/k, this one scalar rescales the
 * whole curve. The invariant is pinned in `tests/kinetics.spec.ts`.
 */
export const arrheniusRatio = (Ea: number, T1: number, T2: number): number => {
  if (!Number.isFinite(Ea) || !Number.isFinite(T1) || !Number.isFinite(T2)) return Number.NaN;
  if (T1 <= 0 || T2 <= 0) return Number.NaN;
  return Math.exp((-Ea / R_GAS) * (1 / T2 - 1 / T1));
};

/** The rate constant carried from a reference temperature to another. Kelvin throughout. */
export const rateConstantAtTemperature = (
  kRef: number,
  Ea: number,
  TRef: number,
  T: number,
): number => kRef * arrheniusRatio(Ea, TRef, T);

/**
 * The factor by which the rate changes per ten Kelvin, at the given Ea and temperature.
 *
 * Computed, never asserted. "The rate roughly doubles every ten degrees" holds near
 * Ea = 53 kJ/mol at room temperature and nowhere else: at 100 kJ/mol the same step is a
 * factor of 3.7.
 */
export const q10 = (Ea: number, T: number): number => arrheniusRatio(Ea, T, T + 10);

/**
 * How far a temperature change slides the curve on a logarithmic time axis, in decades.
 *
 * The shift is rigid: identical at every conversion level and for every order, because
 * temperature only rescales time. That property is what makes the log-time toggle worth
 * building rather than decorative.
 */
export const logTimeShiftDecades = (Ea: number, T1: number, T2: number): number =>
  Math.log10(arrheniusRatio(Ea, T1, T2));
