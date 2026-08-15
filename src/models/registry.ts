import type { KineticModel, ParamSpec } from '../domain/types.ts';
import { kineticsError, type KineticsError } from '../domain/types.ts';
import { ok, err, type Result } from '../domain/result.ts';

import { nthOrder } from './nthOrder.ts';
import { reversibleFirstOrder } from './reversible.ts';
import { twoReactant } from './twoReactant.ts';
import { autocatalytic } from './autocatalytic.ts';
import { michaelisMenten } from './michaelisMenten.ts';
import { varVolume } from './varVolume.ts';
import { jmak } from './jmak.ts';
import { diffusion } from './diffusion.ts';
import { cstr } from './cstr.ts';

/**
 * The model registry, the single boundary of chemical knowledge in this engine.
 *
 * Everything above this layer is written once and is model-agnostic. The solver reaches
 * models only through `lookupModel`, and `tests/architecture.spec.ts` fails the build if
 * a solver, explain or api file imports a model file directly or mentions a model key.
 */
const MODELS: readonly KineticModel[] = Object.freeze([
  nthOrder,
  reversibleFirstOrder,
  twoReactant,
  autocatalytic,
  michaelisMenten,
  varVolume,
  jmak,
  diffusion,
  cstr,
]);

const BY_KEY: ReadonlyMap<string, KineticModel> = new Map(MODELS.map((m) => [m.key, m]));

export const allModels = (): readonly KineticModel[] => MODELS;

/**
 * The model assumed when a request does not name one. Exposed as a function so the API
 * layer can default without writing a model key, which the architecture test forbids.
 */
export const defaultModel = (): KineticModel => nthOrder;

export const modelKeys = (): readonly string[] => MODELS.map((m) => m.key);

export const lookupModel = (key: string): Result<KineticModel, KineticsError> => {
  const model = BY_KEY.get(key);
  if (model === undefined) {
    return err(
      kineticsError('UNKNOWN_MODEL', `Unknown model "${key}".`, { available: modelKeys() }),
    );
  }
  return ok(model);
};

export const findParamSpec = (model: KineticModel, key: string): ParamSpec | undefined =>
  model.params.find((spec) => spec.key === key);

/**
 * Reactor vocabulary.
 *
 * These names live here rather than in the API layer because which reactor a model
 * describes is a property of the model: everything integrating a batch rate law reports
 * an elapsed time, while the steady-state tank reports a space time. Keeping the strings
 * in the registry also keeps the architecture check strict, the API layer never writes
 * a model key, even one that only coincidentally names a reactor.
 */
export type ReactorKind = 'batch' | 'pfr' | typeof cstr.key;

export const REACTOR_KINDS: readonly string[] = ['batch', 'pfr', cstr.key];

export const reactorFor = (model: KineticModel): string =>
  model.timeQuantity === 'spaceTime' ? cstr.key : 'batch';

/**
 * Which model to point a chemist at when their data show a particular pathology.
 *
 * Lives here because "conversion that goes backwards suggests an approach to
 * equilibrium" is chemical judgement, and the guard layer is not allowed to know any
 * model by name. The guards ask; the registry answers.
 */
export const suggestionFor = (
  situation: 'non-monotone' | 'accelerating',
): { readonly key: string; readonly label: string } =>
  situation === 'non-monotone'
    ? { key: reversibleFirstOrder.key, label: reversibleFirstOrder.label }
    : { key: autocatalytic.key, label: autocatalytic.label };
