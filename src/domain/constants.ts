/** Named constants. Nothing in this engine hardcodes a bare number at a call site. */

/** Universal gas constant, J·mol⁻¹·K⁻¹ (CODATA, exact by SI definition). */
export const R_GAS = 8.314462618;

/** Absolute zero guard: temperatures at or below this are rejected (G12). */
export const MIN_KELVIN = 0;

/** Default conversion ladder (§5 B2), the literal generalization of "how long to 50/90/99%?". */
export const DEFAULT_LADDER = [0.5, 0.75, 0.9, 0.95, 0.99, 0.999] as const;

/** Practical ladder reported when completion is asymptotic (§5 D). */
export const PRACTICAL_LADDER = [0.99, 0.999] as const;

/**
 * The target the response leads with when several are requested. 90% is the level a
 * chemist usually means by "how long until it's done", and it is the one the motivating
 * question asks about.
 */
export const HEADLINE_TARGET = 0.9;

/** Order ladder used for the band when the shape parameter is assumed, not fitted (§5 A2). */
export const DEFAULT_ORDER_BAND = [0, 0.5, 1, 1.5, 2] as const;

/** Points sampled for a band over a non-nth-order parameter. */
export const GENERIC_BAND_POINTS = 5;

/** G10: g(X₂)/g(X₁) beyond this is extrapolation far past the measurement. */
export const EXTRAPOLATION_WARN_FACTOR = 10;

/** G11: Arrhenius extrapolation wider than this (K) is unreliable. */
export const WIDE_DELTA_T_KELVIN = 20;

/** Default Q10 when no activation energy is available (§4.6 d). */
export const DEFAULT_Q10 = 2;

/** Q10 is defined as the rate ratio per ten kelvin, the "10" in its name. */
export const Q10_INTERVAL_KELVIN = 10;

/** Relative tolerance for the remaining-fraction bisection (see `Conversion`). */
export const BISECTION_RTOL = 1e-12;
export const BISECTION_MAX_ITERATIONS = 200;

/** Adaptive quadrature contract (§8). */
export const QUADRATURE_RTOL = 1e-10;
export const QUADRATURE_MAX_DEPTH = 50;
export const QUADRATURE_MAX_EVALUATIONS = 200_000;

/**
 * Below this magnitude the expm1(z)/z and log1p(z)/z series are used instead of the
 * direct quotient. This is a bound on a *series argument*, chosen so the truncated
 * series and the direct form agree to machine precision, it is never a branch on a
 * model parameter, which is what makes g smooth through n=1 and M=1.
 */
export const SERIES_CUTOFF = 0.25;
/** 32 terms converges both series below the cutoff: at |z|=0.25 the log series
 *  (the slower of the two) has term 25 at 3.4e-17, already under double precision. */
export const SERIES_TERMS = 32;

/** Smallest usable distance below a ceiling: 1−δ collapses to 1 below ~1.1e-16. */
export const MIN_REMAINING = 1e-15;

/** Deterministic default Monte Carlo seed, never Date.now(), never Math.random. */
export const DEFAULT_MC_SEED = 0x9e3779b9;
export const MAX_MC_SAMPLES = 1_000_000;

/** Coarse scan resolution used to bracket a free parameter before refining. */
export const SCAN_POINTS = 129;

/** Golden-section / Brent convergence controls for parameter fitting. */
export const FIT_RTOL = 1e-12;
export const FIT_MAX_ITERATIONS = 300;

/** Central-difference step for reported sensitivities (∂ln t/∂param). */
export const SENSITIVITY_STEP = 1e-5;

/** Confidence level for the Arrhenius regression interval (§4.6 c). */
export const CONFIDENCE_LEVEL = 0.95;

/** Seconds per accepted time unit. Time is stored in seconds internally (§8). */
export const SECONDS_PER_TIME_UNIT = {
  s: 1,
  min: 60,
  h: 3600,
  d: 86400,
  wk: 604800,
  mo: 2629800, // mean Gregorian month = 365.2425 d / 12
  yr: 31556952, // mean Gregorian year = 365.2425 d
} as const;

export type TimeUnit = keyof typeof SECONDS_PER_TIME_UNIT;
export type TemperatureUnit = 'K' | 'C' | 'F';
