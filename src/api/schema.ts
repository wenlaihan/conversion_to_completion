import type { DerivationStep, ParamValue, Warning } from '../domain/types.ts';
import type { ReactorKind } from '../models/registry.ts';
import type { Completion } from '../solver/completion.ts';
import type { EaSource, ConfidenceInterval } from '../solver/temperature.ts';
import type { Sensitivity } from '../solver/uncertainty.ts';
import type { ConversionFormat } from './units.ts';

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

export interface ObservationInput {
  readonly t: number;
  readonly X: number;
  readonly T?: number;
}

export interface SolveRequest {
  readonly model?: string;
  /** `null` on a parameter means "fit it"; omitted means "use the model default". */
  readonly params?: Readonly<Record<string, ParamValue | null>>;
  readonly observations?: readonly ObservationInput[];
  readonly known?: {
    readonly k?: number | null;
    readonly CA0?: number | null;
    readonly K?: number | null;
    readonly halfLife?: number | null;
    readonly initialRate?: number | null;
  };
  readonly targets?: {
    readonly X?: readonly number[];
    readonly t?: readonly number[];
    readonly curve?: { readonly points?: number; readonly XMax?: number };
  };
  readonly temperature?: {
    readonly basis?: number;
    readonly predictAt?: number | null;
    readonly Ea?: number | null;
    readonly q10?: number;
    readonly deadline?: number | null;
    /** Reaction enthalpy, J/mol, needed to move an equilibrium ceiling (§5 C7). */
    readonly deltaH?: number | null;
  };
  readonly uncertainty?: {
    readonly sigmaX?: number;
    readonly sigmaT?: number;
    readonly nRange?: readonly [number, number];
    readonly monteCarlo?: number;
    /** Fixing this makes any interval exactly reproducible. */
    readonly seed?: number;
  };
  readonly units?: { readonly time?: string; readonly temperature?: string };
  /** Labelling only: PFR is mathematically identical to batch, with t read as τ. */
  readonly reactor?: ReactorKind;
}

/* ------------------------------------------------------------------ *
 * Response
 * ------------------------------------------------------------------ */

export interface TableRow {
  readonly X: number;
  /** Null when this conversion is not reachable for the resolved model. */
  readonly t: number | null;
  readonly reachable: boolean;
  /** Present only when the target sits above the model's ceiling. */
  readonly unreachableReason?: string;
  /** Spread across the plausible range of an assumed parameter. */
  readonly bandLow?: number | null;
  readonly bandHigh?: number | null;
  readonly p5?: number | null;
  readonly p50?: number | null;
  readonly p95?: number | null;
  /** How much further along the reaction than the measurement this target sits. */
  readonly extrapolationFactor?: number | null;
  /** B6: additional time from the last observation to this target. */
  readonly deltaFromObserved?: number | null;
}

export interface BandOutput {
  readonly param: string;
  readonly symbol: string;
  readonly values: readonly ParamValue[];
  /** Per target conversion: the times across the band, in `values` order. */
  readonly times: Readonly<Record<string, readonly (number | null)[]>>;
  readonly spreadFactor: Readonly<Record<string, number | null>>;
}

/**
 * The lead result. When a shape parameter was assumed rather than measured this is a
 * band, and the point estimate is subordinate to it, the discriminated union exists so
 * a UI cannot render it the other way round by accident (§11).
 */
export type Headline =
  | {
      readonly kind: 'band';
      readonly message: string;
      readonly param: string;
      readonly band: BandOutput;
      readonly pointEstimate: TableRow | null;
    }
  | { readonly kind: 'point'; readonly message: string; readonly estimate: TableRow | null };

export interface TemperatureOutput {
  readonly basis: number;
  readonly predictAt: number | null;
  readonly Ea: number | null;
  readonly EaUnits: 'J/mol';
  readonly eaSource: EaSource | null;
  readonly eaConfidenceInterval: ConfidenceInterval | null;
  readonly arrheniusRSquared: number | null;
  /** B8/C6: the temperature that meets the deadline, in the caller's units. */
  readonly requiredTemperature: number | null;
  readonly perTemperature: readonly { readonly T: number; readonly K: number }[];
}

export interface CompletionOutput extends Omit<Completion, 'time' | 'practical'> {
  readonly time: number | null;
  readonly practical: Readonly<Record<string, number>>;
  readonly practicalDetail: readonly {
    readonly fractionOfCeiling: number;
    readonly X: number;
    readonly t: number;
  }[];
}

export interface SolveResponse {
  readonly resolved: {
    readonly model: string;
    readonly label: string;
    readonly params: Readonly<Record<string, ParamValue>>;
    readonly paramSources: Readonly<Record<string, string>>;
    readonly K: number;
    readonly KUnits: string;
    readonly KNote: string;
    readonly Xmax: number;
    readonly identifiable: boolean;
    readonly calibrationSource: string;
    readonly reactor: string;
    readonly timeQuantity: 'batchTime' | 'spaceTime';
    readonly timeLabel: string;
  };
  readonly headline: Headline;
  readonly table: readonly TableRow[];
  readonly inverse: readonly { readonly t: number; readonly X: number }[];
  readonly curve: { readonly t: readonly number[]; readonly X: readonly number[] };
  readonly completion: CompletionOutput;
  readonly band: BandOutput | null;
  readonly temperature: TemperatureOutput | null;
  readonly diagnostics: {
    readonly extrapolationFactor: number | null;
    readonly dlnt_dX1: number | null;
    readonly dlnt_dn: number | null;
    readonly sensitivities: readonly Sensitivity[];
    readonly rSquared: number | null;
    readonly residuals: readonly number[];
    readonly monteCarloSeed: number | null;
    readonly warnings: readonly Warning[];
  };
  /** Rendered worked solution, one line per step. */
  readonly derivation: readonly string[];
  /** The same steps, structured, so tests and the UI need not parse English. */
  readonly derivationSteps: readonly DerivationStep[];
  readonly units: {
    readonly time: string;
    readonly temperature: string;
    readonly conversion: ConversionFormat;
  };
}

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  };
}
