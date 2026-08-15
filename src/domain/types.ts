import type { Result } from './result.ts';
import { MIN_REMAINING } from './constants.ts';

/* ------------------------------------------------------------------ *
 * Primitive quantities
 * ------------------------------------------------------------------ */

/** Time in seconds. Stored in SI internally; converted only at the API boundary (§8). */
export type Seconds = number;
/** Absolute temperature. Stored in Kelvin internally (§8). */
export type Kelvin = number;

/**
 * A conversion, carrying its own remaining fraction.
 *
 * `X` alone cannot represent the deep end of the ladder: as a double it saturates at
 * 1 − 1.1e-16, and `1 − X` inside a model formula is catastrophic cancellation well
 * before that. Every model reads `remaining` rather than recomputing it, so accuracy
 * at 99.999…% is set by how the value was *constructed*, not by how it is consumed.
 */
export interface Conversion {
  readonly X: number;
  readonly remaining: number;
}

/** Builds a conversion from X. Use `fromRemaining` when the remaining fraction is the exact input. */
export const conversionOf = (X: number): Conversion => ({ X, remaining: 1 - X });

/** Builds a conversion from its remaining fraction, the accurate direction near the ceiling. */
export const fromRemaining = (remaining: number): Conversion => ({ X: 1 - remaining, remaining });

/** Clamps a conversion to a usable distance below a ceiling (1−δ collapses to 1 below ~1.1e-16). */
export const clampBelow = (X: number, ceiling: number): Conversion => {
  const gap = ceiling - X;
  if (gap > MIN_REMAINING) return { X, remaining: 1 - X };
  const clamped = ceiling - MIN_REMAINING;
  return { X: clamped, remaining: 1 - clamped };
};

/* ------------------------------------------------------------------ *
 * Model parameters
 * ------------------------------------------------------------------ */

export type ParamValue = number | string;
export type Params = Readonly<Record<string, ParamValue>>;

/**
 * A parameter's admissible set.
 *
 * The solver switches on `kind`; that is branching on a declared *structural* property
 * and is unavoidable. Branching on a model's identity (`model.key === 'jmak'`) is
 * forbidden, and `tests/architecture.spec.ts` fails the build if it appears.
 */
export type Domain =
  | {
      readonly kind: 'continuous';
      readonly min: number;
      readonly max: number;
      readonly openMin?: boolean;
      readonly openMax?: boolean;
    }
  | { readonly kind: 'categorical'; readonly options: readonly string[] };

/** Context handed to a parameter's temperature response. */
export interface TemperatureShift {
  readonly from: Kelvin;
  readonly to: Kelvin;
  /** Reaction enthalpy, J·mol⁻¹, required by van 't Hoff (§5 C7). */
  readonly deltaH?: number;
}

export interface ParamSpec {
  readonly key: string;
  readonly symbol: string;
  readonly label: string;
  readonly units: string;
  readonly default: ParamValue;
  readonly domain: Domain;
  /**
   * The plausible values to sweep when this parameter is assumed rather than fitted.
   *
   * Declared here because "which reaction orders are worth considering" is chemistry,
   * not arithmetic; it is what lets the solver produce the spec's {0, ½, 1, 1½, 2}
   * ladder without ever learning which model it is holding. Absent ⇒ the solver spreads
   * points across the declared domain instead.
   */
  readonly bandValues?: readonly ParamValue[];
  /**
   * Below this the value is still computable but physically unusual, and the response
   * says so (G8). Declared per parameter because it is not a general rule: a negative
   * reaction order is worth remarking on, a negative volume-change fraction is just a
   * reaction that contracts.
   */
  readonly unusualBelow?: number;
  /**
   * How this parameter responds to temperature. Absent ⇒ invariant, which is the
   * common case; the solver calls it blindly and never learns which parameter is an
   * equilibrium conversion. Only `reversible-1`'s Xe supplies one (van 't Hoff).
   */
  readonly shiftTemperature?: (
    value: number,
    shift: TemperatureShift,
  ) => Result<number, KineticsError>;
}

/* ------------------------------------------------------------------ *
 * Behaviour of g at the ceiling
 * ------------------------------------------------------------------ */

/**
 * The limit of g as X approaches Xmax, declared analytically by each model.
 *
 * This is the whole basis of the completion verdict (§5 D), and it is deliberately not
 * computed numerically: `g(Xmax)` is `Infinity` for some divergent models but `NaN` for
 * others (diffusion D2 hits 0·log 0; michaelis-menten at κ=0 likewise), while every
 * diffusion model actually has a *finite* limit. A declared limit is exact and carries
 * the divergence rate, which is what lets the response explain the physics rather than
 * just refuse to answer.
 */
export type Limit =
  | { readonly kind: 'finite'; readonly value: number }
  | {
      readonly kind: 'divergent';
      readonly rate: 'logarithmic' | 'power';
      /** For power divergence g ~ δ^(−exponent): each extra nine costs 10^exponent longer. */
      readonly exponent?: number;
    };

/* ------------------------------------------------------------------ *
 * Worked-solution steps
 * ------------------------------------------------------------------ */

export type DerivationKind =
  | 'model'
  | 'closedForm'
  | 'calibration'
  | 'prediction'
  | 'completion'
  | 'temperature'
  | 'note';

/**
 * One line of the worked solution. Structured rather than pre-rendered prose so tests
 * assert on `kind` and `values` instead of on English, and so the UI can restyle or
 * translate it without the engine changing.
 */
export interface DerivationStep {
  readonly kind: DerivationKind;
  readonly plain: string;
  readonly latex?: string;
  readonly values?: Readonly<Record<string, number>>;
}

/* ------------------------------------------------------------------ *
 * The model interface, the only place chemistry lives
 * ------------------------------------------------------------------ */

export interface KineticModel {
  readonly key: string;
  readonly label: string;
  readonly params: readonly ParamSpec[];
  readonly notes: string;

  /** `t` means batch reaction time everywhere except CSTR, where it is space time τ = V/v₀. */
  readonly timeQuantity: 'batchTime' | 'spaceTime';

  /** Dimensionless conversion-time function. Strictly increasing, g(0) = 0. */
  readonly g: (c: Conversion, p: Params) => number;

  /** dg/dX, the integrand. Needed for sensitivity, Newton polish and initial-rate calibration. */
  readonly gPrime: (c: Conversion, p: Params) => number;

  /** Closed-form inverse where one exists; the solver bisects when it is absent. */
  readonly gInv?: (tau: number, p: Params) => number;

  /** Hard ceiling on conversion for these parameters. */
  readonly Xmax: (p: Params) => number;

  /** Analytic limit of g at that ceiling. */
  readonly limitAtCeiling: (p: Params) => Limit;

  /**
   * K from a rate constant and initial concentration.
   *
   * Not model-agnostic: `k·C_A0^(n−1)` is nth-order's rule, but it is `Vmax/C_A0` for
   * Michaelis-Menten and plain `k` for JMAK. Without this hook the solver would have to
   * branch on the model.
   */
  readonly kFromRateConstant: (
    k: number,
    CA0: number,
    p: Params,
  ) => Result<number, KineticsError>;

  /** Model-specific lines of the worked solution, in the current parameter regime. */
  readonly describe: (p: Params) => readonly DerivationStep[];
}

/* ------------------------------------------------------------------ *
 * Errors and warnings
 * ------------------------------------------------------------------ */

export type ErrorCode =
  | 'G1_ZERO_CONVERSION'
  | 'G2_OBSERVATION_ABOVE_CEILING'
  | 'G3_TARGET_ABOVE_CEILING'
  | 'G7_NONPOSITIVE_TIME'
  | 'G12_NONPOSITIVE_TEMPERATURE'
  | 'G13_UNDERDETERMINED'
  | 'G14_AUTOCATALYTIC_NO_SEED'
  | 'G15_CONVERSION_OUT_OF_RANGE'
  | 'G16_NON_MONOTONE'
  | 'UNKNOWN_MODEL'
  | 'UNKNOWN_PARAM'
  | 'PARAM_OUT_OF_DOMAIN'
  | 'NO_OBSERVATIONS'
  | 'NO_CALIBRATION_SOURCE'
  | 'RATIO_OUTSIDE_ACHIEVABLE_RANGE'
  | 'NO_FEASIBLE_DOMAIN'
  | 'INITIAL_RATE_UNDEFINED'
  | 'HALF_LIFE_ABOVE_CEILING'
  | 'RATE_CONSTANT_UNSUPPORTED'
  | 'MISSING_ACTIVATION_ENERGY'
  | 'MISSING_ENTHALPY'
  | 'TARGET_ABOVE_SHIFTED_CEILING'
  | 'DEADLINE_INFEASIBLE'
  | 'QUADRATURE_BUDGET_EXCEEDED'
  | 'ROOT_NOT_BRACKETED'
  | 'INVALID_REQUEST';

export interface KineticsError {
  readonly code: ErrorCode;
  /** Plain English, written for a chemist rather than a programmer. */
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export const kineticsError = (
  code: ErrorCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): KineticsError => (detail === undefined ? { code, message } : { code, message, detail });

export type WarningCode =
  | 'G6_BACK_EXTRAPOLATION'
  | 'G8_NEGATIVE_ORDER'
  | 'G9_CLAMPED_DISPLAY'
  | 'G10_FAR_EXTRAPOLATION'
  | 'G11_WIDE_TEMPERATURE_SHIFT'
  | 'G16_NON_MONOTONE'
  | 'G17_ILL_CONDITIONED_FIT'
  | 'G18_Q10_HEURISTIC'
  | 'ORDER_ASSUMED_NOT_FITTED'
  | 'CATEGORICAL_UNIDENTIFIED'
  | 'PARAM_ASSUMED_TEMPERATURE_INVARIANT'
  | 'EQUILIBRIUM_FALLS_WITH_TEMPERATURE'
  | 'CEILING_RELATIVE_LADDER'
  | 'MONTE_CARLO_UNREACHABLE_DRAWS';

/** `loud` is reserved for the assumptions that most often produce confident wrong answers. */
export type Severity = 'info' | 'warning' | 'loud';

export interface Warning {
  readonly code: WarningCode;
  readonly severity: Severity;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export const warning = (
  code: WarningCode,
  severity: Severity,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): Warning =>
  detail === undefined ? { code, severity, message } : { code, severity, message, detail };

/* ------------------------------------------------------------------ *
 * Observations
 * ------------------------------------------------------------------ */

/** One measurement, normalized to SI at the boundary. */
export interface Observation {
  readonly t: Seconds;
  readonly conversion: Conversion;
  readonly T: Kelvin;
}
