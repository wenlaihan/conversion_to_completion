/**
 * First-order reaction networks: species that interconvert.
 *
 * A scheme is a set of first-order (or pseudo-first-order) steps written the way a
 * chemist writes them: "A -> B", "B -> C", "A = B" for a reversible pair. That covers
 * the workhorse analyses of reaction monitoring: consecutive A to B to C, approach to
 * equilibrium, parallel branching, and their combinations. Higher-order steps are out of
 * scope by design; under the flooding conditions most traces are collected in, they are
 * pseudo-first-order anyway.
 *
 * The model is linear, dc/dt = M(k) c, integrated by RK4 with stiffness-guarded step
 * counts. Rate constants are fitted by Nelder-Mead in log space on the untransformed
 * data, minimizing the plain sum of squared residuals over every species, row and
 * replicate (CODATA asks that the minimized quantity be stated; this is it).
 *
 * One documented trap is checked explicitly: consecutive fits can be nearly invariant
 * under exchanging rate constants (the flip-flop ambiguity) when the intermediate is
 * poorly observed, and a fit that cannot tell k1 from k2 says so instead of picking one.
 */

export { rateConstantUnits } from './units.ts';
export type { UnitLabels } from './units.ts';

/**
 * The true rate constant behind a fitted pseudo-first-order one.
 *
 * A catalytic step is fitted as a first-order decay, so its constant is k_obs with
 * units of reciprocal time. Dividing by the constant concentrations that were folded
 * into it, rate = k[Cat][S] means k = k_obs / [Cat], recovers the constant that the
 * rate law actually carries.
 */
export const trueRateConstant = (
  kObs: number,
  catalystConcentrations: readonly number[],
): number | null => {
  if (catalystConcentrations.length === 0) return kObs;
  let product = 1;
  for (const c of catalystConcentrations) {
    if (!Number.isFinite(c) || c <= 0) return null;
    product *= c;
  }
  return kObs / product;
};

export interface Step {
  readonly from: string;
  readonly to: string;
  /**
   * Order of this step as written, counting every reactant with its coefficient and
   * including catalysts: `A -> B` is 1, `S + Cat -> P + Cat` is 2. The fit itself is
   * always first order in the varying species; this is what gives k its units.
   */
  readonly molecularity: number;
  /** Species that appear unchanged on both sides, so their concentration is constant. */
  readonly catalysts: readonly string[];
}

export interface Scheme {
  /** Species whose concentration varies, in first-seen order. Catalysts are not here. */
  readonly species: readonly string[];
  readonly steps: readonly Step[];
  /** Every catalyst named anywhere in the scheme, in first-seen order. */
  readonly catalysts: readonly string[];
}

export interface TraceBlock {
  /** Times, ascending, in the user's unit. */
  readonly times: readonly number[];
  /** One series per measured species, same length as times. */
  readonly series: Readonly<Record<string, readonly number[]>>;
}

/* ------------------------------------------------------------------ *
 * Scheme parsing
 * ------------------------------------------------------------------ */

const ARROWS = ['<->', '<=>', '⇌', '->', '→', '='] as const;
/**
 * One reactant or product: an optional integer coefficient then a species name.
 * A name is a single word, or any text in double quotes: real CSV columns are
 * headings like "Starting Material", and the quotes carry them through a grammar
 * whose bare words cannot contain spaces.
 */
const TERM = /^(?:(\d+)\s*\*?\s*)?(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_']*))$/;

/** True when a name survives the grammar unquoted. */
export const isBareName = (name: string): boolean => /^[A-Za-z][A-Za-z0-9_']*$/.test(name);

/** The name as scheme text: bare when it can be, quoted when it must be. */
export const quoteSpecies = (name: string): string => (isBareName(name) ? name : `"${name}"`);

/** Split a line at its arrow, honouring quotes; null unless exactly one arrow. */
const splitArrow = (line: string): { left: string; arrow: string; right: string } | null => {
  let inQuote = false;
  let found: { at: number; token: string } | null = null;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    const token = ARROWS.find((a) => line.startsWith(a, i));
    if (token !== undefined) {
      if (found !== null) return null;
      found = { at: i, token };
      i += token.length - 1;
    }
  }
  if (found === null) return null;
  return {
    left: line.slice(0, found.at).trim(),
    arrow: found.token,
    right: line.slice(found.at + found.token.length).trim(),
  };
};

/** Split one side on "+", honouring quotes. */
const splitPlus = (side: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of side) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === '+' && !inQuote) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
};

interface Term {
  readonly name: string;
  readonly coeff: number;
}

/** One side of an arrow, split on "+". Null when any term is unreadable. */
const parseSide = (side: string): Term[] | null => {
  const terms: Term[] = [];
  for (const raw of splitPlus(side)) {
    const found = TERM.exec(raw.trim());
    if (found === null) return null;
    terms.push({
      name: (found[2] ?? found[3]) as string,
      coeff: found[1] === undefined ? 1 : Number(found[1]),
    });
  }
  return terms;
};

/** Total order of a side: the sum of its stoichiometric coefficients. */
const orderOf = (terms: readonly Term[]): number => terms.reduce((sum, t) => sum + t.coeff, 0);

export interface ParsedScheme {
  readonly ok: boolean;
  readonly scheme: Scheme;
  readonly error: string | null;
}

const badScheme = (error: string): ParsedScheme => ({
  ok: false,
  scheme: { species: [], steps: [], catalysts: [] },
  error,
});

/** One step per line; "A = B" and "A <-> B" expand to the forward and reverse steps. */
export const parseScheme = (text: string): ParsedScheme => {
  const species: string[] = [];
  const steps: Step[] = [];
  const catalysts: string[] = [];
  const seen = new Set<string>();
  const seenCatalyst = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      species.push(name);
    }
  };
  const addCatalyst = (name: string) => {
    if (!seenCatalyst.has(name)) {
      seenCatalyst.add(name);
      catalysts.push(name);
    }
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = splitArrow(line);
    if (parts === null) {
      return badScheme(`Cannot read "${line}". Write one step per line, like "A -> B" or "A = B".`);
    }
    const { left: from, arrow, right: to } = parts;
    const left = parseSide(from);
    const right = parseSide(to);
    if (left === null || right === null) {
      return badScheme(
        `Species names in "${line}" must be single words like A, B2 or SM, ` +
          `or double-quoted: "Starting Material" -> "Product 1".`,
      );
    }

    // A species that appears unchanged on both sides turns over without being consumed:
    // that is a catalyst, and its concentration is a constant of the experiment rather
    // than something the trace can follow.
    const unchanged = (term: Term, other: readonly Term[]) =>
      other.some((o) => o.name === term.name && o.coeff === term.coeff);
    const stepCatalysts = left.filter((t) => unchanged(t, right)).map((t) => t.name);
    const consumed = left.filter((t) => !unchanged(t, right));
    const formed = right.filter((t) => !unchanged(t, left));

    if (consumed.length === 0 && formed.length === 0) {
      return badScheme(`"${line}" converts ${left[0]?.name ?? '?'} to itself.`);
    }
    if (
      consumed.length !== 1 ||
      formed.length !== 1 ||
      consumed[0]?.coeff !== 1 ||
      formed[0]?.coeff !== 1
    ) {
      return badScheme(
        `"${line}" is not first order in one species. This fitter follows one species ` +
          `turning into one other, with any number of catalysts: "A -> B", or ` +
          `"S + Cat -> P + Cat". A step like "A + B -> C" or "2 A -> B" needs both ` +
          `reactants to vary, which these traces cannot pin down.`,
      );
    }

    const a = (consumed[0] as Term).name;
    const b = (formed[0] as Term).name;
    add(a);
    add(b);
    for (const name of stepCatalysts) addCatalyst(name);
    steps.push({ from: a, to: b, molecularity: orderOf(left), catalysts: stepCatalysts });
    if (arrow !== '->' && arrow !== '→') {
      steps.push({ from: b, to: a, molecularity: orderOf(right), catalysts: stepCatalysts });
    }
  }
  if (steps.length === 0) {
    return badScheme('The scheme is empty. Write one step per line, like "A -> B".');
  }
  return { ok: true, scheme: { species, steps, catalysts }, error: null };
};

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

const rateMatrix = (scheme: Scheme, ks: readonly number[]): number[][] => {
  const n = scheme.species.length;
  const index = new Map(scheme.species.map((s, i) => [s, i]));
  const M = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  scheme.steps.forEach((step, s) => {
    const i = index.get(step.from) as number;
    const j = index.get(step.to) as number;
    const k = ks[s] as number;
    M[i]![i] = (M[i]![i] as number) - k;
    M[j]![i] = (M[j]![i] as number) + k;
  });
  return M;
};

/**
 * Concentrations at the requested (ascending) times, integrating dc/dt = Mc by RK4.
 *
 * The step count scales with the fastest rate in the network, so a stiff pair of
 * constants costs more steps rather than accuracy.
 */
export const simulate = (
  scheme: Scheme,
  ks: readonly number[],
  c0: readonly number[],
  times: readonly number[],
  t0 = 0,
): number[][] => {
  const M = rateMatrix(scheme, ks);
  const n = scheme.species.length;
  const deriv = (c: number[]): number[] => {
    const d = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) sum += M[i]![j]! * (c[j] as number);
      d[i] = sum;
    }
    return d;
  };
  const kMax = Math.max(...ks.map((k) => Math.abs(k)), 1e-12);

  let c = [...c0] as number[];
  let t = t0;
  const out: number[][] = [];
  for (const target of times) {
    const span = target - t;
    if (span > 0) {
      const steps = Math.min(Math.max(Math.ceil(span * 24 * kMax), 8), 20_000);
      const h = span / steps;
      for (let s = 0; s < steps; s += 1) {
        const k1 = deriv(c);
        const k2 = deriv(c.map((v, i) => v + (h / 2) * (k1[i] as number)));
        const k3 = deriv(c.map((v, i) => v + (h / 2) * (k2[i] as number)));
        const k4 = deriv(c.map((v, i) => v + h * (k3[i] as number)));
        c = c.map(
          (v, i) =>
            v +
            (h / 6) *
              ((k1[i] as number) + 2 * (k2[i] as number) + 2 * (k3[i] as number) + (k4[i] as number)),
        );
      }
      t = target;
    }
    out.push([...c]);
  }
  return out;
};

/* ------------------------------------------------------------------ *
 * Nelder-Mead, in log space
 * ------------------------------------------------------------------ */

const nelderMead = (f: (x: number[]) => number, x0: number[], iterations = 400): number[] => {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + 0.4 : v)))];
  let values = simplex.map(f);

  for (let iter = 0; iter < iterations; iter += 1) {
    const order = values
      .map((_, i) => i)
      .sort((a, b) => (values[a] as number) - (values[b] as number));
    simplex = order.map((i) => simplex[i] as number[]);
    values = order.map((i) => values[i] as number);
    const best = values[0] as number;
    const worst = values[n] as number;
    if (worst - best < 1e-12 * (1 + Math.abs(best))) break;

    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) centroid[j] = (centroid[j] as number) + simplex[i]![j]! / n;
    }
    const at = (factor: number) => centroid.map((c, j) => c + factor * (c - simplex[n]![j]!));

    const reflected = at(1);
    const fr = f(reflected);
    if (fr < best) {
      const expanded = at(2);
      const fe = f(expanded);
      simplex[n] = fe < fr ? expanded : reflected;
      values[n] = Math.min(fe, fr);
    } else if (fr < (values[n - 1] as number)) {
      simplex[n] = reflected;
      values[n] = fr;
    } else {
      const contracted = at(-0.5);
      const fc = f(contracted);
      if (fc < worst) {
        simplex[n] = contracted;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i += 1) {
          simplex[i] = simplex[i]!.map((v, j) => (simplex[0]![j]! + v) / 2);
          values[i] = f(simplex[i] as number[]);
        }
      }
    }
  }
  const bestIndex = values.indexOf(Math.min(...values));
  return simplex[bestIndex] as number[];
};

/* ------------------------------------------------------------------ *
 * Fitting
 * ------------------------------------------------------------------ */

export interface FittedStep extends Step {
  readonly k: number;
  /** Half the spread across replicate fits; null with a single run. */
  readonly kSpread: number | null;
}

export interface NetworkFit {
  readonly ok: boolean;
  readonly error: string | null;
  readonly scheme: Scheme;
  readonly steps: readonly FittedStep[];
  /**
   * Starting amounts the fit had to infer.
   *
   * A species nobody measured contributes nothing to the starting composition read from
   * the data, and when that species is the reactant the model would start empty and
   * nothing would ever react. An unmeasured pure source (no incoming steps) therefore
   * gets its initial amount fitted alongside the rate constants, which is the standard
   * treatment for co-product traces; unmeasured intermediates and products start at 0.
   */
  readonly inferredStart: readonly { readonly name: string; readonly value: number }[];
  readonly r2: number;
  readonly sse: number;
  /** Model curves for drawing, from the first run's starting composition. */
  readonly curve: {
    readonly t: readonly number[];
    readonly series: Readonly<Record<string, readonly number[]>>;
  };
  /** Residuals per run, per measured species, aligned with each run's times. */
  readonly residuals: readonly Readonly<Record<string, readonly number[]>>[];
  /** Named when exchanging two rate constants fits almost as well: the flip-flop trap. */
  readonly ambiguous: string | null;
}

const fail = (error: string): NetworkFit => ({
  ok: false,
  error,
  scheme: { species: [], steps: [], catalysts: [] },
  steps: [],
  inferredStart: [],
  r2: 0,
  sse: 0,
  curve: { t: [], series: {} },
  residuals: [],
  ambiguous: null,
});

const blockStart = (
  scheme: Scheme,
  block: TraceBlock,
  inferred: Readonly<Record<string, number>>,
): number[] =>
  scheme.species.map((s) => {
    const series = block.series[s];
    if (series !== undefined) return series[0] as number;
    return inferred[s] ?? 0;
  });

const sseFor = (
  scheme: Scheme,
  ks: number[],
  inferred: Readonly<Record<string, number>>,
  blocks: readonly TraceBlock[],
): number => {
  let sse = 0;
  for (const block of blocks) {
    const model = simulate(
      scheme,
      ks,
      blockStart(scheme, block, inferred),
      block.times,
      block.times[0] as number,
    );
    scheme.species.forEach((name, i) => {
      const observed = block.series[name];
      if (!observed) return;
      for (let r = 0; r < block.times.length; r += 1) {
        const d = (observed[r] as number) - (model[r]![i] as number);
        sse += d * d;
      }
    });
  }
  return sse;
};

export const fitNetwork = (blocks: readonly TraceBlock[], schemeText: string): NetworkFit => {
  const parsed = parseScheme(schemeText);
  if (!parsed.ok) return fail(parsed.error as string);
  const scheme = parsed.scheme;

  if (blocks.length === 0) return fail('No data yet.');
  for (const block of blocks) {
    for (const name of Object.keys(block.series)) {
      if (!scheme.species.includes(name)) {
        return fail(
          `The data has a column "${name}" that the scheme never mentions. Add a step involving ${name}, or rename the column.`,
        );
      }
    }
    if (block.times.length < 3) return fail('Each run needs at least three time points.');
    for (let r = 1; r < block.times.length; r += 1) {
      if (!((block.times[r] as number) > (block.times[r - 1] as number))) {
        return fail('Times within a run must increase. Separate replicate runs with a blank line.');
      }
    }
  }
  const measured = new Set(blocks.flatMap((b) => Object.keys(b.series)));
  if (measured.size === 0) return fail('No species columns found.');

  const tSpan = Math.max(
    ...blocks.map((b) => (b.times[b.times.length - 1] as number) - (b.times[0] as number)),
  );
  if (!(tSpan > 0)) return fail('The times in a run must increase.');

  // An unmeasured pure source (no incoming steps) starts at an amount nobody recorded,
  // so that amount joins the fit. Everything else unmeasured starts at zero.
  const hasIncoming = new Set(scheme.steps.map((step) => step.to));
  const freeStarts = scheme.species.filter((name) => !measured.has(name) && !hasIncoming.has(name));
  const maxObserved = Math.max(
    ...blocks.flatMap((b) => Object.values(b.series).flatMap((v) => [...v].map(Math.abs))),
    1,
  );

  const unpack = (params: number[]) => {
    const ks = params.slice(0, scheme.steps.length).map((v) => 10 ** v);
    const inferred: Record<string, number> = {};
    freeStarts.forEach((name, i) => {
      inferred[name] = 10 ** (params[scheme.steps.length + i] as number);
    });
    return { ks, inferred };
  };

  // Multi-start in log space: the network timescale is unknown a priori, so decade-
  // spaced guesses cover slow, matched and fast against the data window.
  //
  // The barrier keeps the search inside the decades this data window can even see. A
  // rate 100x faster than the window is over before the second point; one 10,000x
  // slower never moves; both are invisible, and chasing them sends the integrator into
  // its substep clamp, which is how an unidentifiable scheme used to freeze the page
  // for minutes. Outside the window the objective is simply a wall.
  const logCentre = Math.log10(1 / tSpan);
  const logStart = Math.log10(maxObserved);
  const objective = (params: number[]) => {
    for (let i = 0; i < scheme.steps.length; i += 1) {
      const offset = (params[i] as number) - logCentre;
      if (offset > 2 || offset < -4) return 1e300;
    }
    for (let i = scheme.steps.length; i < params.length; i += 1) {
      if (Math.abs((params[i] as number) - logStart) > 3) return 1e300;
    }
    const { ks, inferred } = unpack(params);
    return sseFor(scheme, ks, inferred, blocks);
  };
  let bestLog: number[] | null = null;
  let bestVal = Infinity;
  for (const guess of [1 / tSpan, 4 / tSpan, 0.25 / tSpan]) {
    const start = [
      ...new Array(scheme.steps.length).fill(Math.log10(guess)),
      ...freeStarts.map(() => Math.log10(maxObserved)),
    ];
    const solution = nelderMead(objective, start);
    const value = objective(solution);
    if (value < bestVal) {
      bestVal = value;
      bestLog = solution;
    }
  }
  const { ks, inferred } = unpack(bestLog as number[]);
  const sse = bestVal;

  // R squared against each species' own mean, pooled, so a flat trace cannot flatter it.
  let sst = 0;
  for (const name of measured) {
    const values = blocks.flatMap((b) => [...(b.series[name] ?? [])]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    sst += values.reduce((a, v) => a + (v - mean) ** 2, 0);
  }
  const r2 = sst > 0 ? 1 - sse / sst : 0;

  // Replicates: each run fitted alone, seeded from the pooled answer. The spread is the
  // honest per-parameter uncertainty that two or three runs can support.
  let spreads: (number | null)[] = scheme.steps.map(() => null);
  if (blocks.length >= 2) {
    const perBlock = blocks.map((block) => {
      const single = nelderMead(
        (params) => {
          const single_ = unpack(params);
          return sseFor(scheme, single_.ks, single_.inferred, [block]);
        },
        bestLog as number[],
        200,
      );
      return unpack(single).ks;
    });
    spreads = scheme.steps.map((_, s) => {
      const values = perBlock.map((p) => p[s] as number);
      return (Math.max(...values) - Math.min(...values)) / 2;
    });
  }

  // The flip-flop check: if exchanging two rate constants fits nearly as well, the data
  // cannot say which step is the fast one, and the fit must say so. The floor scales
  // with the data because a near-perfect fit's SSE is numerical noise, and noise times
  // 1.1 cannot recognise an equal twin.
  let ambiguous: string | null = null;
  if (ks.length >= 2) {
    for (let a = 0; a < ks.length && !ambiguous; a += 1) {
      for (let b = a + 1; b < ks.length && !ambiguous; b += 1) {
        if (
          Math.abs((ks[a] as number) - (ks[b] as number)) /
            Math.max(ks[a] as number, ks[b] as number) <
          0.05
        )
          continue;
        const swapped = [...ks];
        [swapped[a], swapped[b]] = [swapped[b] as number, swapped[a] as number];
        if (sseFor(scheme, swapped, inferred, blocks) <= sse * 1.1 + 1e-6 * sst + 1e-12) {
          const stepA = scheme.steps[a] as Step;
          const stepB = scheme.steps[b] as Step;
          ambiguous = `k(${stepA.from}→${stepA.to}) and k(${stepB.from}→${stepB.to})`;
        }
      }
    }
  }

  // Curves for the figure, from the first run's starting composition.
  const first = blocks[0] as TraceBlock;
  const t0 = first.times[0] as number;
  const tEnd = t0 + tSpan * 1.05;
  const samples = 160;
  const curveTimes = Array.from({ length: samples + 1 }, (_, i) => t0 + ((tEnd - t0) * i) / samples);
  const curveValues = simulate(scheme, ks, blockStart(scheme, first, inferred), curveTimes, t0);
  const series: Record<string, number[]> = {};
  scheme.species.forEach((name, i) => {
    series[name] = curveValues.map((row) => row[i] as number);
  });

  const residuals = blocks.map((block) => {
    const model = simulate(
      scheme,
      ks,
      blockStart(scheme, block, inferred),
      block.times,
      block.times[0] as number,
    );
    const out: Record<string, number[]> = {};
    scheme.species.forEach((name, i) => {
      const observed = block.series[name];
      if (!observed) return;
      out[name] = observed.map((v, r) => v - (model[r]![i] as number));
    });
    return out;
  });

  return {
    ok: true,
    error: null,
    scheme,
    steps: scheme.steps.map((step, s) => ({ ...step, k: ks[s] as number, kSpread: spreads[s] ?? null })),
    inferredStart: freeStarts.map((name) => ({ name, value: inferred[name] as number })),
    r2,
    sse,
    curve: { t: curveTimes, series },
    residuals,
    ambiguous,
  };
};
