import type { Conversion, DerivationStep, KineticModel, Params } from '../domain/types.ts';
import { asPercent, fmt } from '../domain/format.ts';
import type { Completion } from '../solver/completion.ts';

/**
 * The worked solution, assembled once for every model.
 *
 * Model-specific lines come from the registry's `describe`; everything else here is
 * generic. The steps are structured rather than pre-rendered prose so tests can assert
 * on `kind` and `values` instead of on English, and the UI can restyle or translate
 * without the engine changing, the rendered strings are derived from these, not the
 * other way round.
 */

export interface DerivationContext {
  readonly model: KineticModel;
  readonly params: Params;
  /** K in the caller's time units, with a matching label such as "1/h". */
  readonly K: number;
  readonly KUnits: string;
  readonly timeUnit: string;
  readonly timeLabel: string;
  readonly calibrationSource: string;
  readonly observation?: { readonly t: number; readonly conversion: Conversion };
  readonly headline?: { readonly conversion: Conversion; readonly t: number };
  readonly completion: Completion;
  /** Already converted to the caller's time units, this layer does no unit arithmetic. */
  readonly completionTime: number | null;
  readonly practicalLadder: readonly { readonly X: number; readonly t: number }[];
  readonly temperature?: {
    readonly from: number;
    readonly to: number;
    readonly Ea: number;
    readonly source: string;
    readonly unit: string;
  };
}

export const buildDerivation = (ctx: DerivationContext): readonly DerivationStep[] => {
  const { model, params, K, KUnits, timeUnit, timeLabel } = ctx;
  const steps: DerivationStep[] = [...model.describe(params)];

  // Why one measurement is enough: K is a single multiplicative constant, so it cancels.
  steps.push({
    kind: 'note',
    plain:
      't₂/t₁ = g(X₂)/g(X₁): the rate constant, initial concentration, reactor volume and stoichiometry all cancel, so the ratio of times depends only on the shape of g. That is why a single measured point fixes the whole curve.',
    latex: '\\frac{t_2}{t_1} = \\frac{g(X_2)}{g(X_1)}',
  });

  if (ctx.observation !== undefined) {
    const gObserved = model.g(ctx.observation.conversion, params);
    steps.push({
      kind: 'calibration',
      plain: `K = g(${fmt(ctx.observation.conversion.X)}) / ${fmt(ctx.observation.t)} ${timeUnit} = ${fmt(gObserved)} / ${fmt(ctx.observation.t)} ${timeUnit} = ${fmt(K)} ${KUnits}`,
      latex: `K = \\frac{g(X_1)}{t_1} = ${fmt(K)}\\;\\mathrm{${KUnits}}`,
      values: { X1: ctx.observation.conversion.X, t1: ctx.observation.t, g: gObserved, K },
    });
  } else {
    steps.push({
      kind: 'calibration',
      plain: `K = ${fmt(K)} ${KUnits} (from ${ctx.calibrationSource})`,
      values: { K },
    });
  }

  steps.push({
    kind: 'note',
    plain: `K has units of ${KUnits} whatever the reaction order. The rate constant k does not (its units are concentration^(1−n)·time⁻¹) which is the usual source of confusion; lumping C_A0^(n−1) into K is what removes it.`,
  });

  if (ctx.headline !== undefined) {
    const gTarget = model.g(ctx.headline.conversion, params);
    steps.push({
      kind: 'prediction',
      plain: `${timeLabel}(${asPercent(ctx.headline.conversion.X)}) = g(${fmt(ctx.headline.conversion.X)})/K = ${fmt(gTarget)}/${fmt(K)} = ${fmt(ctx.headline.t)} ${timeUnit}`,
      latex: `t(X) = \\frac{g(X)}{K} = ${fmt(ctx.headline.t)}\\;\\mathrm{${timeUnit}}`,
      values: { X: ctx.headline.conversion.X, g: gTarget, t: ctx.headline.t },
    });
  }

  if (ctx.completion.kind === 'exact' && ctx.completionTime !== null) {
    steps.push({
      kind: 'completion',
      plain: `Complete conversion is reached in finite time: ${timeLabel}(100%) = g(1)/K = ${fmt(ctx.completionTime)} ${timeUnit}. ${ctx.completion.reason}`,
      values: { t: ctx.completionTime },
    });
  } else {
    const ladder = ctx.practicalLadder
      .map((entry) => `${asPercent(entry.X)} at ${fmt(entry.t)} ${timeUnit}`)
      .join(', ');
    steps.push({
      kind: 'completion',
      plain: `${ctx.completion.reason} The practical answer is the ladder instead: ${ladder}.`,
    });
  }

  if (ctx.temperature !== undefined) {
    const { from, to, Ea, source, unit } = ctx.temperature;
    steps.push({
      kind: 'temperature',
      plain: `Shifted from ${fmt(from)} ${unit} to ${fmt(to)} ${unit} at constant conversion using Ea = ${fmt(Ea / 1000)} kJ/mol (${source}): K scales by exp[−(Ea/R)(1/T₂ − 1/T₁)], and any temperature-dependent parameter moves with it before the times are recomputed.`,
      latex:
        'K_2 = K_1\\exp\\left[-\\frac{E_a}{R}\\left(\\frac{1}{T_2}-\\frac{1}{T_1}\\right)\\right]',
      values: { from, to, Ea },
    });
  }

  return steps;
};

export const renderDerivation = (steps: readonly DerivationStep[]): readonly string[] =>
  steps.map((step) => step.plain);
