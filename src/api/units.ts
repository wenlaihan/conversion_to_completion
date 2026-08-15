import type { Kelvin, KineticsError, Seconds } from '../domain/types.ts';
import { kineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';
import {
  MIN_KELVIN,
  SECONDS_PER_TIME_UNIT,
  type TemperatureUnit,
  type TimeUnit,
} from '../domain/constants.ts';

/**
 * The unit boundary. Time is seconds and temperature is Kelvin everywhere inside the
 * engine; conversion happens here and nowhere else.
 */

export const isTimeUnit = (v: string): v is TimeUnit => v in SECONDS_PER_TIME_UNIT;

export const isTemperatureUnit = (v: string): v is TemperatureUnit =>
  v === 'K' || v === 'C' || v === 'F';

export const toSeconds = (value: number, unit: TimeUnit): Seconds =>
  value * SECONDS_PER_TIME_UNIT[unit];

export const fromSeconds = (value: Seconds, unit: TimeUnit): number =>
  value / SECONDS_PER_TIME_UNIT[unit];

/** K has units of reciprocal time whatever the reaction order, the usual confusion. */
export const rateUnitsLabel = (unit: TimeUnit): string => `1/${unit}`;

export const toKelvin = (value: number, unit: TemperatureUnit): Result<Kelvin, KineticsError> => {
  const kelvin =
    unit === 'K' ? value : unit === 'C' ? value + 273.15 : ((value - 32) * 5) / 9 + 273.15;
  if (!Number.isFinite(kelvin) || kelvin <= MIN_KELVIN) {
    return err(
      kineticsError(
        'G12_NONPOSITIVE_TEMPERATURE',
        `A temperature of ${value} ${unit} is at or below absolute zero, which is not a physical temperature.`,
        { value, unit, kelvin },
      ),
    );
  }
  return ok(kelvin);
};

export const fromKelvin = (value: Kelvin, unit: TemperatureUnit): number =>
  unit === 'K' ? value : unit === 'C' ? value - 273.15 : ((value - 273.15) * 9) / 5 + 32;

export type ConversionFormat = 'fraction' | 'percent';

/**
 * Conversions arrive as either fractions or percentages. Anything above 1 can only have
 * been a percentage, and the format is echoed back so the response speaks in whichever
 * one the request used.
 */
export const detectConversionFormat = (values: readonly number[]): ConversionFormat =>
  values.some((v) => v > 1) ? 'percent' : 'fraction';

export const toFraction = (
  value: number,
  format: ConversionFormat,
): Result<number, KineticsError> => {
  const fraction = format === 'percent' ? value / 100 : value;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    return err(
      kineticsError(
        'G15_CONVERSION_OUT_OF_RANGE',
        `A conversion of ${value}${format === 'percent' ? '%' : ''} is outside the possible range. Conversion runs from 0 (nothing reacted) to 1, or 0% to 100%.`,
        { value, format },
      ),
    );
  }
  return ok(fraction);
};

export const fromFraction = (value: number, format: ConversionFormat): number =>
  format === 'percent' ? value * 100 : value;
