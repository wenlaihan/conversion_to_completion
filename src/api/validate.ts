import type {
  Conversion,
  Kelvin,
  KineticModel,
  KineticsError,
  Observation,
  ParamValue,
  Seconds,
} from '../domain/types.ts';
import { conversionOf, kineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';
import {
  DEFAULT_LADDER,
  DEFAULT_Q10,
  type TemperatureUnit,
  type TimeUnit,
} from '../domain/constants.ts';
import { defaultModel, lookupModel, reactorFor } from '../models/registry.ts';
import type { SolveRequest } from './schema.ts';
import {
  detectConversionFormat,
  isTemperatureUnit,
  isTimeUnit,
  toFraction,
  toKelvin,
  toSeconds,
  type ConversionFormat,
} from './units.ts';

const DEFAULT_TIME_UNIT: TimeUnit = 'h';
const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = 'K';
const DEFAULT_BASIS_KELVIN = 298.15;
const DEFAULT_CURVE_POINTS = 200;
const DEFAULT_CURVE_XMAX = 0.999;
const MAX_CURVE_POINTS = 5000;

export interface ValidRequest {
  readonly model: KineticModel;
  readonly requestedParams: Readonly<Record<string, ParamValue | null>>;
  readonly observations: readonly Observation[];
  readonly known: {
    readonly k?: number;
    readonly CA0?: number;
    readonly K?: number;
    readonly halfLife?: Seconds;
    readonly initialRate?: number;
  };
  readonly targetConversions: readonly Conversion[];
  readonly targetTimes: readonly Seconds[];
  readonly curve: { readonly points: number; readonly fractionOfCeiling: number };
  readonly temperature: {
    readonly basis: Kelvin;
    readonly predictAt?: Kelvin;
    readonly Ea?: number;
    readonly q10: number;
    readonly deadline?: Seconds;
    readonly deltaH?: number;
  };
  readonly uncertainty: {
    readonly sigmaX: number;
    readonly sigmaT: number;
    readonly paramRange?: readonly [number, number];
    readonly monteCarlo: number;
    readonly seed?: number;
  };
  readonly units: {
    readonly time: TimeUnit;
    readonly temperature: TemperatureUnit;
    readonly conversion: ConversionFormat;
  };
  readonly reactor: string;
}

const finiteOrUndefined = (v: number | null | undefined): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Checks one supplied parameter against the admissible set its model declares. */
const validateParam = (
  model: KineticModel,
  key: string,
  value: ParamValue,
): Result<true, KineticsError> => {
  const spec = model.params.find((s) => s.key === key);
  if (spec === undefined) {
    return err(
      kineticsError('UNKNOWN_PARAM', `The ${model.label} model has no parameter "${key}".`, {
        expected: model.params.map((s) => s.key),
      }),
    );
  }

  if (spec.domain.kind === 'categorical') {
    if (typeof value !== 'string' || !spec.domain.options.includes(value)) {
      return err(
        kineticsError(
          'PARAM_OUT_OF_DOMAIN',
          `${spec.label} must be one of ${spec.domain.options.join(', ')}.`,
          { param: key, value, options: spec.domain.options },
        ),
      );
    }
    return ok(true);
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return err(
      kineticsError('PARAM_OUT_OF_DOMAIN', `${spec.label} must be a number.`, {
        param: key,
        value,
      }),
    );
  }
  const { min, max, openMin, openMax } = spec.domain;
  const belowFloor = openMin === true ? value <= min : value < min;
  const aboveRoof = openMax === true ? value >= max : value > max;
  if (belowFloor || aboveRoof) {
    const lower = openMin === true ? `greater than ${min}` : `at least ${min}`;
    const upper = openMax === true ? `less than ${max}` : `at most ${max}`;
    return err(
      kineticsError(
        'PARAM_OUT_OF_DOMAIN',
        `${spec.label} (${spec.symbol}) must be ${lower} and ${upper}, but ${value} was given. ${model.notes}`,
        { param: key, value, min, max },
      ),
    );
  }
  return ok(true);
};

/**
 * Parses and normalizes a request: units to SI, conversions to fractions, and every
 * value that can be rejected up front rejected here, with a message aimed at a chemist.
 *
 * Guards enforced at this boundary: G1 (zero conversion), G7 (non-positive time),
 * G12 (temperature at or below absolute zero), G15 (conversion outside 0 to 1) and the
 * per-parameter domains, which is where G14 (an autocatalytic reaction with no seed)
 * falls out of an open lower bound rather than a special case.
 */
export const validateRequest = (raw: SolveRequest): Result<ValidRequest, KineticsError> => {
  if (typeof raw !== 'object' || raw === null) {
    return err(kineticsError('INVALID_REQUEST', 'The request body must be a JSON object.'));
  }

  const timeUnit = raw.units?.time ?? DEFAULT_TIME_UNIT;
  if (!isTimeUnit(timeUnit)) {
    return err(
      kineticsError(
        'INVALID_REQUEST',
        `Unknown time unit "${timeUnit}". Use one of s, min, h, d, wk, mo, yr.`,
      ),
    );
  }
  const temperatureUnit = raw.units?.temperature ?? DEFAULT_TEMPERATURE_UNIT;
  if (!isTemperatureUnit(temperatureUnit)) {
    return err(
      kineticsError('INVALID_REQUEST', `Unknown temperature unit "${temperatureUnit}". Use K, C or F.`),
    );
  }
  const perUnit = toSeconds(1, timeUnit);

  const modelResult = lookupModel(raw.model ?? defaultModel().key);
  if (!modelResult.ok) return modelResult;
  const model = modelResult.value;

  const requestedParams = raw.params ?? {};
  for (const [key, value] of Object.entries(requestedParams)) {
    if (value === null || value === undefined) continue;
    const check = validateParam(model, key, value);
    if (!check.ok) return check;
  }

  const rawObservations = raw.observations ?? [];
  const rawTargets = raw.targets?.X ?? [...DEFAULT_LADDER];
  const conversionFormat = detectConversionFormat([
    ...rawObservations.map((o) => o.X),
    ...rawTargets,
  ]);

  const basisRaw = finiteOrUndefined(raw.temperature?.basis);
  const basisResult =
    basisRaw === undefined ? ok(DEFAULT_BASIS_KELVIN) : toKelvin(basisRaw, temperatureUnit);
  if (!basisResult.ok) return basisResult;
  const basis = basisResult.value;

  const observations: Observation[] = [];
  for (const entry of rawObservations) {
    if (typeof entry?.t !== 'number' || typeof entry?.X !== 'number') {
      return err(
        kineticsError(
          'INVALID_REQUEST',
          'Each observation needs a numeric time t and conversion X.',
        ),
      );
    }
    const t = toSeconds(entry.t, timeUnit);
    if (!(t > 0)) {
      return err(
        kineticsError(
          'G7_NONPOSITIVE_TIME',
          `An observation was given at t = ${entry.t} ${timeUnit}. Measurement times must be greater than zero. At t = 0 nothing has reacted yet, so the measurement carries no rate information.`,
          { t: entry.t },
        ),
      );
    }
    const fraction = toFraction(entry.X, conversionFormat);
    if (!fraction.ok) return fraction;
    if (fraction.value <= 0) {
      return err(
        kineticsError(
          'G1_ZERO_CONVERSION',
          'An observation reports zero conversion, which cannot fix a rate constant: every reaction passes through zero at time zero, whatever its rate. Supply a measurement with a nonzero conversion.',
          { X: entry.X },
        ),
      );
    }
    const temperature = entry.T === undefined ? ok(basis) : toKelvin(entry.T, temperatureUnit);
    if (!temperature.ok) return temperature;
    observations.push({ t, conversion: conversionOf(fraction.value), T: temperature.value });
  }

  const targetConversions: Conversion[] = [];
  for (const value of rawTargets) {
    const fraction = toFraction(value, conversionFormat);
    if (!fraction.ok) return fraction;
    targetConversions.push(conversionOf(fraction.value));
  }

  const targetTimes: Seconds[] = [];
  for (const value of raw.targets?.t ?? []) {
    if (typeof value !== 'number' || !(value > 0)) {
      return err(
        kineticsError('G7_NONPOSITIVE_TIME', `A target time of ${value} is not a positive time.`),
      );
    }
    targetTimes.push(toSeconds(value, timeUnit));
  }

  const predictAtRaw = finiteOrUndefined(raw.temperature?.predictAt);
  let predictAt: Kelvin | undefined;
  if (predictAtRaw !== undefined) {
    const converted = toKelvin(predictAtRaw, temperatureUnit);
    if (!converted.ok) return converted;
    predictAt = converted.value;
  }

  const deadlineRaw = finiteOrUndefined(raw.temperature?.deadline);
  const halfLifeRaw = finiteOrUndefined(raw.known?.halfLife);
  const knownK = finiteOrUndefined(raw.known?.K);
  const knownRate = finiteOrUndefined(raw.known?.initialRate);
  // k carries units of concentration^(1−n)·time⁻¹. Only the time dimension needs
  // converting, and it does so inversely; the concentration part is the caller's own
  // and passes through untouched.
  const knownRateConstant = finiteOrUndefined(raw.known?.k);
  const nRange = raw.uncertainty?.nRange;

  return ok({
    model,
    requestedParams,
    observations,
    known: {
      ...(knownRateConstant === undefined ? {} : { k: knownRateConstant / perUnit }),
      ...(finiteOrUndefined(raw.known?.CA0) === undefined ? {} : { CA0: raw.known?.CA0 as number }),
      // K and initial rate are per unit time, so they convert inversely.
      ...(knownK === undefined ? {} : { K: knownK / perUnit }),
      ...(halfLifeRaw === undefined ? {} : { halfLife: toSeconds(halfLifeRaw, timeUnit) }),
      ...(knownRate === undefined ? {} : { initialRate: knownRate / perUnit }),
    },
    targetConversions,
    targetTimes,
    curve: {
      points: Math.min(
        Math.max(raw.targets?.curve?.points ?? DEFAULT_CURVE_POINTS, 2),
        MAX_CURVE_POINTS,
      ),
      fractionOfCeiling: Math.min(
        Math.max(raw.targets?.curve?.XMax ?? DEFAULT_CURVE_XMAX, 1e-6),
        1 - 1e-12,
      ),
    },
    temperature: {
      basis,
      ...(predictAt === undefined ? {} : { predictAt }),
      ...(finiteOrUndefined(raw.temperature?.Ea) === undefined
        ? {}
        : { Ea: raw.temperature?.Ea as number }),
      q10: raw.temperature?.q10 ?? DEFAULT_Q10,
      ...(deadlineRaw === undefined ? {} : { deadline: toSeconds(deadlineRaw, timeUnit) }),
      ...(finiteOrUndefined(raw.temperature?.deltaH) === undefined
        ? {}
        : { deltaH: raw.temperature?.deltaH as number }),
    },
    uncertainty: {
      sigmaX: Math.max(raw.uncertainty?.sigmaX ?? 0, 0),
      sigmaT: Math.max(raw.uncertainty?.sigmaT ?? 0, 0) * perUnit,
      ...(nRange === undefined ? {} : { paramRange: [nRange[0], nRange[1]] as const }),
      monteCarlo: Math.max(raw.uncertainty?.monteCarlo ?? 0, 0),
      ...(finiteOrUndefined(raw.uncertainty?.seed) === undefined
        ? {}
        : { seed: raw.uncertainty?.seed as number }),
    },
    units: { time: timeUnit, temperature: temperatureUnit, conversion: conversionFormat },
    reactor: raw.reactor ?? reactorFor(model),
  });
};
