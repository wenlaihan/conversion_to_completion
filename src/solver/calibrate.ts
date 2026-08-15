import type { KineticModel, KineticsError, Observation, Params } from '../domain/types.ts';
import { conversionOf, kineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';

export type CalibrationSource =
  | 'given-K'
  | 'observations'
  | 'least-squares'
  | 'half-life'
  | 'rate-constant'
  | 'initial-rate';

export interface Calibration {
  /** Lumped rate constant, s⁻¹. Units are time⁻¹ for every model and every order. */
  readonly K: number;
  readonly source: CalibrationSource;
  readonly pointsUsed: number;
}

export interface CalibrationInputs {
  readonly observations: readonly Observation[];
  readonly K?: number;
  readonly halfLife?: number;
  readonly k?: number;
  readonly CA0?: number;
  readonly initialRate?: number;
}

const HALF = 0.5;

/**
 * Least squares in absolute time.
 *
 * K = Σgᵢ²/Σ(tᵢ·gᵢ) is the closed form for minimising Σ(tᵢ − gᵢ/K)², i.e. residuals in
 * time rather than in g. That is the right choice for a tool that predicts times, and
 * the parameter fit profiles K out with this same expression so the two stay consistent
 *, mixing metrics between them would stop the outer search being a true profile.
 * One consequence to be aware of: absolute-time weighting lets the longest observation
 * dominate.
 */
const leastSquaresK = (
  model: KineticModel,
  p: Params,
  observations: readonly Observation[],
): Result<number, KineticsError> => {
  let sumGG = 0;
  let sumTG = 0;
  for (const o of observations) {
    const g = model.g(o.conversion, p);
    if (!Number.isFinite(g)) {
      return err(
        kineticsError(
          'G2_OBSERVATION_ABOVE_CEILING',
          `An observation at ${(o.conversion.X * 100).toFixed(3)}% conversion cannot be represented by this model: it lies at or beyond the model's ceiling.`,
          { X: o.conversion.X, ceiling: model.Xmax(p) },
        ),
      );
    }
    sumGG += g * g;
    sumTG += o.t * g;
  }
  if (sumTG <= 0) {
    return err(
      kineticsError(
        'G1_ZERO_CONVERSION',
        'The observations carry no usable conversion, so the rate constant is undefined. At least one measurement must have a nonzero conversion at a positive time.',
      ),
    );
  }
  return ok(sumGG / sumTG);
};

/**
 * K from an initial rate.
 *
 * The spec gives K = r₀/C_A0, which silently assumes g′(0) = 1, true for nth-order but
 * not in general. dX/dt at X = 0 is K/g′(0), so the model-agnostic form is
 * K = r₀·g′(0)/C_A0. Five configurations have no usable initial rate at all: g′(0) is 0
 * for all four diffusion laws and infinite for JMAK with m > 1 (Avrami has zero initial
 * rate by construction), which this reports rather than returning a zero or infinite K.
 */
const fromInitialRate = (
  model: KineticModel,
  p: Params,
  rate: number,
  CA0: number,
): Result<number, KineticsError> => {
  const slope = model.gPrime(conversionOf(0), p);
  if (!Number.isFinite(slope) || slope <= 0) {
    return err(
      kineticsError(
        'INITIAL_RATE_UNDEFINED',
        'This model has no usable initial rate: its conversion-time function is flat or vertical at X = 0, so an initial-rate measurement cannot fix the rate constant. Calibrate from a measured conversion instead.',
        { gPrimeAtZero: Number.isFinite(slope) ? slope : 'non-finite' },
      ),
    );
  }
  return ok((rate * slope) / CA0);
};

const fromHalfLife = (
  model: KineticModel,
  p: Params,
  halfLife: number,
): Result<number, KineticsError> => {
  const ceiling = model.Xmax(p);
  if (HALF >= ceiling) {
    return err(
      kineticsError(
        'HALF_LIFE_ABOVE_CEILING',
        `A half-life is not defined for this model: 50% conversion is above its ceiling of ${(ceiling * 100).toFixed(2)}%, so that conversion is never reached.`,
        { ceiling },
      ),
    );
  }
  if (halfLife <= 0) {
    return err(kineticsError('G7_NONPOSITIVE_TIME', 'The half-life must be a positive time.'));
  }
  return ok(model.g(conversionOf(HALF), p) / halfLife);
};

/**
 * Resolves the lumped rate constant K from whichever source the request supplies , 
 * all five routes in §4.1, plus a directly supplied K.
 */
export const calibrate = (
  model: KineticModel,
  p: Params,
  inputs: CalibrationInputs,
): Result<Calibration, KineticsError> => {
  if (inputs.K !== undefined && inputs.K > 0) {
    return ok({ K: inputs.K, source: 'given-K', pointsUsed: 0 });
  }

  if (inputs.observations.length > 0) {
    const result = leastSquaresK(model, p, inputs.observations);
    if (!result.ok) return result;
    return ok({
      K: result.value,
      source: inputs.observations.length === 1 ? 'observations' : 'least-squares',
      pointsUsed: inputs.observations.length,
    });
  }

  if (inputs.halfLife !== undefined) {
    const result = fromHalfLife(model, p, inputs.halfLife);
    return result.ok ? ok({ K: result.value, source: 'half-life', pointsUsed: 0 }) : result;
  }

  if (inputs.k !== undefined && inputs.CA0 !== undefined) {
    const result = model.kFromRateConstant(inputs.k, inputs.CA0, p);
    return result.ok ? ok({ K: result.value, source: 'rate-constant', pointsUsed: 0 }) : result;
  }

  if (inputs.initialRate !== undefined && inputs.CA0 !== undefined) {
    const result = fromInitialRate(model, p, inputs.initialRate, inputs.CA0);
    return result.ok ? ok({ K: result.value, source: 'initial-rate', pointsUsed: 0 }) : result;
  }

  return err(
    kineticsError(
      'NO_CALIBRATION_SOURCE',
      'Nothing to calibrate from. Supply at least one measured conversion, or a half-life, or a rate constant with C_A0, or an initial rate with C_A0.',
    ),
  );
};

/** Groups observations by temperature, the basis of any activation-energy fit. */
export const groupByTemperature = (
  observations: readonly Observation[],
): ReadonlyMap<number, readonly Observation[]> => {
  const groups = new Map<number, Observation[]>();
  for (const o of observations) {
    const bucket = groups.get(o.T);
    if (bucket === undefined) groups.set(o.T, [o]);
    else bucket.push(o);
  }
  return groups;
};
