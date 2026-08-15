/**
 * Deterministic pseudo-randomness for the Monte Carlo path.
 *
 * The engine is specified as pure and deterministic, so the sampler is seeded and the
 * effective seed is echoed in the response, any interval can be reproduced from the
 * response alone. Never `Date.now()`, never `Math.random`.
 *
 * Each uncertain input draws from its own substream keyed by name. Drawing all inputs
 * sequentially from one stream would mean that adding a second uncertain variable
 * renumbers every subsequent draw, silently changing results that were previously
 * pinned by tests.
 */

export type Rng = () => number;

/** FNV-1a over the substream name. */
const hashKey = (key: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** splitmix32, 2^32 period, ample for the sample counts this engine allows. */
const splitmix32 = (seed: number): Rng => {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
};

/** An independent stream for one named uncertain input. */
export const streamFor = (seed: number, key: string): Rng =>
  splitmix32((seed ^ hashKey(key)) | 0);

/** Standard normal deviate (Box–Muller). */
export const standardNormal = (rng: Rng): number => {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

/** Normal deviate with the given mean and standard deviation. */
export const normal = (rng: Rng, mean: number, sd: number): number =>
  sd === 0 ? mean : mean + sd * standardNormal(rng);

/** Uniform deviate on [lo, hi]. */
export const uniform = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();
