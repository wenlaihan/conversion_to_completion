import type { Domain, Params, ParamSpec } from '../domain/types.ts';

export { fmt } from '../domain/format.ts';

/** Reads a numeric parameter, falling back to the spec default. */
export const num = (p: Params, key: string, fallback: number): number => {
  const raw = p[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
};

/** Reads a categorical parameter. */
export const str = (p: Params, key: string, fallback: string): string => {
  const raw = p[key];
  return typeof raw === 'string' ? raw : fallback;
};

interface ContinuousOptions {
  readonly key: string;
  readonly symbol: string;
  readonly label: string;
  readonly units?: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly openMin?: boolean;
  readonly openMax?: boolean;
  readonly bandValues?: readonly number[];
  readonly unusualBelow?: number;
  readonly shiftTemperature?: ParamSpec['shiftTemperature'];
}

export const continuousParam = (o: ContinuousOptions): ParamSpec => {
  const domain: Domain = {
    kind: 'continuous',
    min: o.min,
    max: o.max,
    ...(o.openMin === undefined ? {} : { openMin: o.openMin }),
    ...(o.openMax === undefined ? {} : { openMax: o.openMax }),
  };
  return {
    key: o.key,
    symbol: o.symbol,
    label: o.label,
    units: o.units ?? 'dimensionless',
    default: o.default,
    domain,
    ...(o.bandValues === undefined ? {} : { bandValues: o.bandValues }),
    ...(o.unusualBelow === undefined ? {} : { unusualBelow: o.unusualBelow }),
    ...(o.shiftTemperature === undefined ? {} : { shiftTemperature: o.shiftTemperature }),
  };
};

interface CategoricalOptions {
  readonly key: string;
  readonly symbol: string;
  readonly label: string;
  readonly default: string;
  readonly options: readonly string[];
}

export const categoricalParam = (o: CategoricalOptions): ParamSpec => ({
  key: o.key,
  symbol: o.symbol,
  label: o.label,
  units: 'dimensionless',
  default: o.default,
  domain: { kind: 'categorical', options: o.options },
});
