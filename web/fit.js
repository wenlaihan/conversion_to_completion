import { $, esc, debounce } from './ui.js';
import { solve } from '../dist/api/solve.js';
import {
  fitNetwork,
  parseScheme,
  quoteSpecies,
  rateConstantUnits,
  trueRateConstant,
} from '../dist/lib/network.js';
import { smartCells } from '../dist/lib/csv.js';
import { fmtRate } from '../dist/lib/format.js';
import { detectMassBalance } from '../dist/lib/massBalance.js';
import { buildZip, fitDataCsv } from '../dist/lib/export.js';
import { currentPoint, applyFittedOrder } from './estimate.js';

/**
 * Fit: from a pasted time course to rate constants, without documentation.
 *
 * Stage 1 of docs/fit-redesign-plan.md: the data box explains itself (ghost placeholder,
 * tolerant parser with line-level errors, live status line), the plot appears the moment
 * a paste parses, and one gallery of complete scenarios replaces the old two-tier
 * examples. A step strip tracks Data, Scheme, Estimates, Fit.
 *
 * Two data modes remain: two headerless columns fit the reaction order (the label
 * declares its percent convention); columns with a header name species and fit one rate
 * constant per step of the scheme. Values are taken as entered. Replicates arrive as
 * blank-line blocks or as repeated header names on a shared grid, and put error bars on
 * the figure.
 */

const COLOURS = [
  '#2a78d6', '#184f95', '#86b6ef', '#5598e7', '#0d366b', '#7c3aed', '#0e7490', '#9a3412',
];
const DASHES = ['', '5 4', '1 5', '9 4', '2 3', '7 3', '3 3', '10 3'];

const state = {
  unit: 'h',
  label: '',
  /** Where the data came from: a file name, or "pasted data". For the step rail. */
  source: '',
  /** Per-column mass-balance override: true forces balance, false forces species. */
  balance: {},
  /** The example currently loaded, or null once the user's own data replaces it. */
  exampleLoaded: null,
  /** Manual examples-section toggle; null means follow the automatic rule. */
  examplesOpen: null,
};

/**
 * Item 5's labeling system: real column names are often too long for a circular
 * node, so every species gets a display name. Short names pass through; long ones
 * become S1, S2, ... and the legend under the map plus a tooltip on every node
 * carry the full heading. The same map feeds the chart legend, the conditions
 * step and the results tiles, so a species is called one thing everywhere.
 */
/**
 * The time unit, read off the time column's own heading: "time (min)", "t/min",
 * "time_min", "t (h)", "time [s]". Inference runs once per new heading, so the
 * dropdown stays the boss for manual changes on the same data.
 */
const unitFromHeader = (heading) => {
  const t = heading.toLowerCase();
  if (/(^|[^a-z])min(ute)?s?([^a-z]|$)/.test(t)) return 'min';
  if (/(^|[^a-z])h(ou)?rs?([^a-z]|$)/.test(t)) return 'h';
  if (/(^|[^a-z])s(ec(onds?)?)?([^a-z]|$)/.test(t)) return 's';
  return null;
};
let lastTimeHeading = null;

const DISPLAY_MAX = 5;
let displayMap = new Map();
let balanceSet = new Set();
const disp = (name) => displayMap.get(name) ?? name;
const buildDisplayMap = (names) => {
  const map = new Map();
  let n = 0;
  for (const name of names) {
    if (name.length <= DISPLAY_MAX) {
      map.set(name, name);
    } else {
      n += 1;
      map.set(name, `S${n}`);
    }
  }
  return map;
};

// The scheme canvas: species added but not yet wired in, the node tapped and awaiting
// its partner, the data columns shown as unwired nodes, and the last successful fit
// whose rate constants annotate the arrows.
const canvas = {
  extras: [],
  selected: null,
  selectedEdge: null,
  dataNames: [],
  lastFit: null,
  lastR2: null,
  lastRuns: 0,
  /** Field-relative anchor of the edit popup; null when nothing is selected. */
  popAt: null,
  lastPopKey: '',
  /** Node under the pointer: its connect handle is showing. */
  hover: null,
  /** Live drag-to-connect: { from, x, y, over } in canvas coordinates. */
  drag: null,
  /** Set when a drag just completed, so the trailing click does not reselect. */
  suppressClick: false,
};

const fmtNum = (v) => {
  if (!Number.isFinite(v)) return 'n/a';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 1e-4) return v.toPrecision(3);
  return v.toExponential(2);
};

/* ------------------------------------------------------------------ *
 * Parser v2: line-level errors, sorted times, replicate columns
 * ------------------------------------------------------------------ */


/**
 * @returns {{ runs, errors, stats }}
 *   runs   : [{ kind: 'network', times, series } | { kind: 'single', points }]
 *   errors : [{ line, text, reason }] with 1-based line numbers into the textarea
 *   stats  : { points, tMin, tMax, yMin, yMax } over everything numeric, or null
 */
export const parseInput = (text) => {
  const errors = [];
  const runs = [];
  const lines = text.split('\n');

  let block = null; // { header: string[] | null, headerLine, rows: [{line, text, cells}] }
  let firstHeader = null;

  const finishBlock = () => {
    if (!block || block.rows.length === 0) {
      block = null;
      return;
    }
    const rows = [...block.rows].sort((a, b) => a.cells[0] - b.cells[0]);
    if (block.header) {
      if (firstHeader === null) firstHeader = [...block.header];
      const names = block.header.slice(1);
      const width = names.length + 1;
      for (const row of block.rows) {
        if (row.cells.length !== width) {
          errors.push({
            line: row.line,
            text: row.text,
            reason: `has ${row.cells.length} numbers where the header promises ${width}`,
          });
        }
      }
      // Repeated header names are same-grid replicates: each occurrence becomes a run.
      const counts = new Map();
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      const repeat = Math.max(...counts.values());
      const uneven = [...counts.values()].some((c) => c !== 1 && c !== repeat);
      if (uneven) {
        errors.push({
          line: block.headerLine,
          text: block.header.join(', '),
          reason: 'repeated column names must repeat the same number of times',
        });
      } else {
        const times = rows.map((r) => r.cells[0]);
        for (let occurrence = 0; occurrence < repeat; occurrence += 1) {
          const seen = new Map();
          const series = {};
          names.forEach((name, i) => {
            const nth = seen.get(name) ?? 0;
            seen.set(name, nth + 1);
            const wanted = counts.get(name) === 1 ? 0 : occurrence;
            if (nth === wanted) series[name] = rows.map((r) => r.cells[i + 1] ?? 0);
          });
          runs.push({ kind: 'network', times, series });
        }
      }
    } else {
      const width = Math.max(...block.rows.map((r) => r.cells.length));
      if (width === 2) {
        runs.push({
          kind: 'single',
          points: rows.map((r) => ({ t: r.cells[0], X: r.cells[1] / 100 })),
        });
      } else {
        errors.push({
          line: block.rows[0].line,
          text: block.rows[0].text,
          reason: 'columns of several species need a header naming them, like "t, A, B, C"',
        });
      }
    }
    block = null;
  };

  lines.forEach((raw, index) => {
    const line = raw.trim();
    const lineNo = index + 1;
    if (line === '') {
      finishBlock();
      return;
    }
    if (line.startsWith('#')) return;
    const cells = smartCells(line);
    const numbers = cells.map(Number);
    const numeric = numbers.every(Number.isFinite);

    if (!block) block = { header: null, headerLine: 0, rows: [] };

    if (!numeric) {
      if (block.rows.length === 0 && block.header === null) {
        block.header = cells;
        block.headerLine = lineNo;
      } else {
        errors.push({
          line: lineNo,
          text: line,
          reason: 'has a gap or a word where a number should be',
        });
      }
      return;
    }
    if (numbers.length < 2) {
      errors.push({
        line: lineNo,
        text: line,
        reason: 'has only one number; a row needs a time and a value',
      });
      return;
    }
    block.rows.push({ line: lineNo, text: line, cells: numbers });
  });
  finishBlock();

  const values = runs.flatMap((run) =>
    run.kind === 'single'
      ? run.points.map((p) => p.X * 100)
      : Object.values(run.series).flatMap((v) => [...v]),
  );
  const times = runs.flatMap((run) =>
    run.kind === 'single' ? run.points.map((p) => p.t) : [...run.times],
  );
  const stats =
    times.length === 0
      ? null
      : {
          points: times.length,
          tMin: Math.min(...times),
          tMax: Math.max(...times),
          yMin: Math.min(...values),
          yMax: Math.max(...values),
        };
  return { runs, errors, stats, header: firstHeader };
};

/* ------------------------------------------------------------------ *
 * Shared drawing
 * ------------------------------------------------------------------ */

const W = 720;
const L = 56;
const R = 118;
const PW = W - L - R;

const niceStep = (span, target = 5) => {
  const raw = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
};

const axisTicks = (max) => {
  const step = niceStep(max);
  const ticks = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
};

/**
 * Right-margin names, staggered, wearing their series colour and dash; the clamp walks
 * the pile back up so the lowest name stays above the tick strip.
 */
const endLabels = (ends, maxY = Infinity) => {
  const GAP = 15;
  const sorted = [...ends].sort((a, b) => a.y - b.y);
  let last = -Infinity;
  for (const e of sorted) {
    e.ly = Math.max(e.y, last + GAP);
    last = e.ly;
  }
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const cap = maxY - (sorted.length - 1 - i) * GAP;
    if (sorted[i].ly > cap) sorted[i].ly = cap;
  }
  return sorted
    .map(
      (e) =>
        `<g${e.dim ? ' opacity="0.55"' : ''}>` +
        `<line x1="${(e.x + 5).toFixed(1)}" y1="${e.ly.toFixed(1)}" x2="${(e.x + 17).toFixed(1)}" y2="${e.ly.toFixed(1)}" ` +
        `stroke="${e.colour}" stroke-width="1.8" ${e.dash ? `stroke-dasharray="${e.dash}"` : ''} stroke-linecap="round"/>` +
        `<text x="${(e.x + 21).toFixed(1)}" y="${(e.ly + 4).toFixed(1)}" font-size="13" font-weight="500" ` +
        `fill="${e.colour}" font-family="var(--sans)">${esc(e.label)}</text></g>`,
    )
    .join('');
};

/**
 * The trace figure: points (with whiskers when replicates align), fitted curves when a
 * model exists, direct labels either way. Rendering points before any model exists is
 * the format confirmation the redesign leans on.
 */
const traceChart = ({ seriesList, yLabel, xLabel }) => {
  const H = 330;
  const TOP = 16;
  const BOT = 268;
  const allY = seriesList.flatMap((s) => [
    ...s.points.map((p) => p.mean + (p.spread ?? 0)),
    ...s.curve.map((c) => c.y),
  ]);
  const allX = seriesList.flatMap((s) => [...s.points.map((p) => p.t), ...s.curve.map((c) => c.t)]);
  const yMax = Math.max(...allY, 1) * 1.06;
  const xMax = Math.max(...allX, 1);
  const x = (t) => L + (t / xMax) * PW;
  const y = (v) => BOT - (v / yMax) * (BOT - TOP);

  const grid = axisTicks(xMax)
    .map(
      (t) =>
        `<line x1="${x(t).toFixed(1)}" y1="${TOP}" x2="${x(t).toFixed(1)}" y2="${BOT}" stroke="var(--hairline)"/>` +
        `<text x="${x(t).toFixed(1)}" y="${BOT + 20}" text-anchor="middle" font-size="14" ` +
        `fill="var(--on-variant)" font-family="var(--math)">${esc(fmtNum(t))}</text>`,
    )
    .join('');
  const rows = axisTicks(yMax)
    .map(
      (v) =>
        `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${L + PW}" y2="${y(v).toFixed(1)}" stroke="var(--hairline)"/>` +
        `<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="14" ` +
        `fill="var(--on-variant)" font-family="var(--math)">${esc(fmtNum(v))}</text>`,
    )
    .join('');

  const marks = seriesList
    .map((s) => {
      const curve =
        s.curve.length === 0
          ? ''
          : `<path d="${s.curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c.t).toFixed(1)} ${y(c.y).toFixed(1)}`).join('')}" ` +
            `fill="none" stroke="${s.colour}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linecap="round"/>`;
      const points = s.points
        .map((p) => {
          const px = x(p.t).toFixed(1);
          const whisker =
            p.spread && p.spread > 0
              ? `<line x1="${px}" y1="${y(p.mean - p.spread).toFixed(1)}" x2="${px}" y2="${y(p.mean + p.spread).toFixed(1)}" ` +
                `stroke="${s.colour}" stroke-width="1.4"/>` +
                `<line x1="${(x(p.t) - 4).toFixed(1)}" y1="${y(p.mean - p.spread).toFixed(1)}" x2="${(x(p.t) + 4).toFixed(1)}" y2="${y(p.mean - p.spread).toFixed(1)}" stroke="${s.colour}" stroke-width="1.4"/>` +
                `<line x1="${(x(p.t) - 4).toFixed(1)}" y1="${y(p.mean + p.spread).toFixed(1)}" x2="${(x(p.t) + 4).toFixed(1)}" y2="${y(p.mean + p.spread).toFixed(1)}" stroke="${s.colour}" stroke-width="1.4"/>`
              : '';
          return (
            whisker +
            `<circle cx="${px}" cy="${y(p.mean).toFixed(1)}" r="3.6" fill="${s.colour}" ` +
            `stroke="var(--lowest)" stroke-width="1.6"/>`
          );
        })
        .join('');
      return curve + (s.dim ? `<g opacity="0.5">${points}</g>` : points);
    })
    .join('');

  const labels = endLabels(
    seriesList
      .map((s) => {
        const anchor = s.curve[s.curve.length - 1] ?? null;
        const lastPoint = s.points[s.points.length - 1] ?? null;
        const yEnd = anchor ? anchor.y : lastPoint ? lastPoint.mean : null;
        return yEnd === null
          ? null
          : { x: L + PW, y: y(yEnd), colour: s.colour, dash: s.dash, label: s.name, dim: s.dim === true };
      })
      .filter(Boolean),
    BOT - 6,
  );

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Data and fitted curves" style="display:block;width:100%;height:auto">` +
    grid +
    rows +
    marks +
    labels +
    `<text x="${L + PW / 2}" y="${H - 8}" text-anchor="middle" font-size="16" fill="var(--on-surface)" ` +
    `font-family="var(--sans)">${esc(xLabel)}</text>` +
    `<text transform="rotate(-90 14 ${(TOP + BOT) / 2})" x="14" y="${(TOP + BOT) / 2}" text-anchor="middle" ` +
    `font-size="16" fill="var(--on-surface)" font-family="var(--sans)">${esc(yLabel)}</text></svg>`
  );
};

/** Residuals under the trace, one colour per species, zero line ruled. */
const residualChart = (groups, xMax, xLabel) => {
  const H = 150;
  const T = 22;
  const B = 112;
  const worst = Math.max(...groups.flatMap((g) => g.points.map((p) => Math.abs(p.r))), 1e-9) * 1.3;
  const x = (t) => L + (t / xMax) * PW;
  const y = (r) => (T + B) / 2 - (r / worst) * ((B - T) / 2);
  const dots = groups
    .map((g) =>
      g.points
        .map(
          (p) =>
            `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.r).toFixed(1)}" r="3.4" fill="${g.colour}" ` +
            `stroke="var(--lowest)" stroke-width="1.4"/>`,
        )
        .join(''),
    )
    .join('');
  const top = worst / 1.3;
  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Residuals" style="display:block;width:100%;height:auto">` +
    `<text x="${L}" y="12" font-size="13" font-weight="700" letter-spacing="0.05em" fill="var(--outline)" ` +
    `font-family="var(--sans)">RESIDUALS (observed - model)</text>` +
    // Without a scale a residual plot cannot be read: these are the extremes.
    `<text x="${L - 8}" y="${(y(top) + 4).toFixed(1)}" text-anchor="end" font-size="13" ` +
    `fill="var(--on-variant)" font-family="var(--math)">+${esc(fmtNum(top))}</text>` +
    `<text x="${L - 8}" y="${(y(-top) + 4).toFixed(1)}" text-anchor="end" font-size="13" ` +
    `fill="var(--on-variant)" font-family="var(--math)">-${esc(fmtNum(top))}</text>` +
    `<line x1="${L}" y1="${y(0)}" x2="${L + PW}" y2="${y(0)}" stroke="var(--on-variant)"/>` +
    `<text x="${L - 8}" y="${y(0) + 4}" text-anchor="end" font-size="13" fill="var(--on-variant)" ` +
    `font-family="var(--math)">0</text>` +
    dots +
    `<text x="${L + PW / 2}" y="${H - 6}" text-anchor="middle" font-size="14" fill="var(--on-surface)" ` +
    `font-family="var(--sans)">${esc(xLabel)}</text></svg>`
  );
};

/** Mean and half-spread across replicate runs at the first run's times. */
const alignReplicates = (blocks, read) => {
  const first = blocks[0];
  return first.times
    .map((t) => {
      const values = [];
      for (const block of blocks) {
        const index = block.times.findIndex((bt) => Math.abs(bt - t) <= Math.abs(t) * 1e-9 + 1e-9);
        if (index >= 0) {
          const v = read(block, index);
          if (v !== undefined) values.push(v);
        }
      }
      if (values.length === 0) return null;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const spread = values.length > 1 ? (Math.max(...values) - Math.min(...values)) / 2 : 0;
      return { t, mean, spread };
    })
    .filter(Boolean);
};

const timeLabel = () => `Time (${state.unit})`;
const signalLabel = () => (state.label.trim() === '' ? 'Signal (as entered)' : state.label.trim());

/* ------------------------------------------------------------------ *
 * The two fits
 * ------------------------------------------------------------------ */

/**
 * One arrow: a shaft plus a barbed head drawn as an explicit polygon at the tip.
 * Explicit geometry rather than an SVG marker: exact tip placement, a swept-back
 * base with no flat shoulders, and the shaft tucks into the notch with no stub.
 */
const arrowSVG = (ax, ay, bx, by, width, head, colour) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const half = head * 0.42;
  const baseX = bx - ux * head;
  const baseY = by - uy * head;
  const notchX = bx - ux * head * 0.72;
  const notchY = by - uy * head * 0.72;
  const endX = bx - ux * head * 0.66;
  const endY = by - uy * head * 0.66;
  return (
    `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${endX.toFixed(1)}" y2="${endY.toFixed(1)}"
       stroke="${colour}" stroke-width="${width}"/>` +
    `<path d="M${bx.toFixed(1)} ${by.toFixed(1)} L${(baseX + px * half).toFixed(1)} ${(
      baseY + py * half
    ).toFixed(1)} L${notchX.toFixed(1)} ${notchY.toFixed(1)} L${(baseX - px * half).toFixed(1)} ${(
      baseY - py * half
    ).toFixed(1)} Z" fill="${colour}"/>`
  );
};

// The Fit button is the contract: solve the scheme's rate equations for the constants
// when the user asks, rather than refitting on every keystroke. The key covers exactly
// the fit's inputs, the raw data and the scheme text; anything else, conditions and
// labels included, re-renders from the cached solution without a refit.
const fitCache = { key: '', network: null, single: null };
const inputsKey = () => `${$('f-data')?.value ?? ''}\u0000${$('f-scheme')?.value ?? ''}`;

const fitRunPrompt = () =>
  `<div class="fitrun">
     <button type="button" class="btn-primary" id="f-fit-btn">Fit</button>
     <span class="fitrun-note">Solves the scheme's rate equations and finds the constants
       by least squares over every point, species and run.</span>
   </div>`;

const singleSolve = (points) =>
  solve({
    model: 'nth-order',
    params: { n: null },
    observations: points.map((p) => ({ ...p, T: 20 })),
    targets: { X: [0.5, 0.9, 0.99], curve: { points: 140, XMax: 0.995 } },
    units: { time: 'min', temperature: 'C' },
    temperature: { basis: 20 },
  });

const wiredBlocksFor = (blocks, wired) =>
  blocks
    .map((b) => ({
      times: b.times,
      series: Object.fromEntries(Object.entries(b.series).filter(([n]) => wired.has(n))),
    }))
    .filter((b) => Object.keys(b.series).length > 0);

const runFit = () => {
  const parsedInput = parseInput($('f-data')?.value ?? '');
  const network = parsedInput.runs.filter((r) => r.kind === 'network');
  const single = parsedInput.runs.filter((r) => r.kind === 'single');
  const key = inputsKey();
  if (network.length > 0) {
    const parsed = parsedScheme();
    if (parsed === null) return;
    const blocksForFit = wiredBlocksFor(network, new Set(parsed.species));
    if (blocksForFit.length === 0) return;
    const fit = fitNetwork(blocksForFit, $('f-scheme')?.value ?? '');
    if (!fit.ok) {
      $('f-err').textContent = fit.error;
      return;
    }
    fitCache.key = key;
    fitCache.network = fit;
    fitCache.single = null;
  } else if (single.length > 0) {
    const pooled = single.flatMap((b) => b.points);
    const result = singleSolve(pooled);
    if (!result.ok) {
      $('f-err').textContent = result.error.message;
      return;
    }
    let nSpread = null;
    if (single.length >= 2) {
      const perRun = single
        .map((b) => singleSolve(b.points))
        .filter((r) => r.ok)
        .map((r) => r.value.resolved.params.n)
        .filter((v) => typeof v === 'number');
      if (perRun.length >= 2) nSpread = (Math.max(...perRun) - Math.min(...perRun)) / 2;
    }
    fitCache.key = key;
    fitCache.single = { res: result.value, nSpread };
    fitCache.network = null;
  }
  render();
};

const singleAsNetwork = (b) => ({
  times: b.points.map((p) => p.t),
  series: { 'conv%': b.points.map((p) => p.X * 100) },
});

const renderSingle = (blocks) => {
  if (fitCache.key !== inputsKey() || fitCache.single === null) {
    $('f-err').textContent = '';
    $('f-plot').innerHTML = pointsOnlyChart(blocks.map(singleAsNetwork));
    $('f-body').innerHTML = fitRunPrompt();
    return false;
  }
  $('f-err').textContent = '';
  const pooled = blocks.flatMap((b) => b.points);
  const { res, nSpread } = fitCache.single;
  const fitted = res.resolved.params.n;
  const r2 = res.diagnostics.rSquared;
  canvas.lastR2 = typeof r2 === 'number' ? r2 : null;
  canvas.lastRuns = blocks.length;

  const aligned = alignReplicates(
    blocks.map((b) => ({ times: b.points.map((p) => p.t), points: b.points })),
    (block, i) => block.points[i].X * 100,
  );

  const figure = traceChart({
    xLabel: timeLabel(),
    yLabel: 'Conversion (%)',
    seriesList: [
      {
        name: `n = ${typeof fitted === 'number' ? fitted.toFixed(2) : fitted}`,
        colour: COLOURS[0],
        dash: '',
        points: aligned,
        curve: res.curve.t.map((t, i) => ({ t, y: res.curve.X[i] * 100 })),
      },
    ],
  });

  const xMax = Math.max(...pooled.map((p) => p.t));
  const residual = residualChart(
    [
      {
        colour: COLOURS[0],
        points: pooled.map((p, i) => ({ t: p.t, r: res.diagnostics.residuals?.[i] ?? 0 })),
      },
    ],
    xMax * 1.05,
    timeLabel(),
  );

  const residualsArr = res.diagnostics.residuals ?? [];
  const sse = residualsArr.reduce((a, r) => a + r * r, 0);
  $('f-plot').innerHTML = figure;
  $('f-body').innerHTML =
    `<div class="readouts" style="margin:8px 0 24px">
       <div class="readout"><div class="k">Order n</div>
         <div class="v">${esc(typeof fitted === 'number' ? fitted.toFixed(3) : String(fitted))}${
           nSpread !== null ? ` ± ${esc(nSpread.toFixed(3))}` : ''
         }</div></div>
       <div class="readout"><div class="k">SSE <span class="lit">(loss)</span></div>
         <div class="v">${esc(fmtNum(sse))}<span class="u">${esc(state.unit)}\u00B2</span></div></div>
       <div class="readout"><div class="k">RMSE</div>
         <div class="v">${esc(fmtNum(Math.sqrt(sse / Math.max(1, pooled.length))))}<span class="u">${esc(state.unit)}</span></div></div>
       <div class="readout"><div class="k"><span class="lit">points</span></div>
         <div class="v">${pooled.length}</div></div>
     </div>` +
    `<div class="chips exports">
       <button type="button" data-export="graph">Download graph</button>
       <button type="button" data-export="data">Download data</button>
       <button type="button" data-export="both">Download both</button>
     </div>` +
    residual +
    `<div class="explain"><p>Curved residuals mean the order is wrong, however high R&#178; climbs.</p></div>` +
    `<p style="margin-top:16px"><a href="#estimate?n=${encodeURIComponent(
      typeof fitted === 'number' ? fitted.toFixed(2) : '1',
    )}">Send this order to Estimate</a></p>`;
  return true;
};

/** Data column names in first-seen order across blocks. */
const orderedColumns = (blocks) => {
  const out = [];
  const seen = new Set();
  for (const b of blocks)
    for (const n of Object.keys(b.series))
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
  return out;
};

/** One shared ordering, data columns first, so node and curve colours always agree. */
const speciesOrder = (columns, schemeSpecies, extras = []) => {
  const out = [];
  const seen = new Set();
  for (const n of [...columns, ...schemeSpecies, ...extras])
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  return out;
};

/** Overall drift of one column as a fraction of its range: +1 grows, -1 falls. */
const trendOf = (blocks, name) => {
  const rows = blocks
    .flatMap((b) => (b.series[name] ?? []).map((v, i) => ({ t: b.times[i], v })))
    .sort((a, b) => a.t - b.t);
  if (rows.length < 4) return 0;
  const k = Math.max(1, Math.floor(rows.length / 4));
  const mean = (xs) => xs.reduce((a, r) => a + r.v, 0) / xs.length;
  const lo = Math.min(...rows.map((r) => r.v));
  const hi = Math.max(...rows.map((r) => r.v));
  if (hi <= lo) return 0;
  return (mean(rows.slice(-k)) - mean(rows.slice(0, k))) / (hi - lo);
};

/**
 * The data read against the drawn scheme: species not wired in yet, growth with
 * nothing feeding it, decay with nothing draining it. Each hint names the next arrow,
 * which is what makes drawing the mechanism a guided game rather than a guess.
 */
const schemeHints = (blocks, columns, scheme) => {
  const hints = [];
  const inScheme = new Set(scheme.species);
  for (const name of columns) {
    if (!inScheme.has(name))
      hints.push(`${name} is not connected yet: click ${name} on the canvas to wire it in.`);
  }
  for (const name of columns) {
    if (!inScheme.has(name)) continue;
    const trend = trendOf(blocks, name);
    const hasIn = scheme.steps.some((step) => step.to === name);
    const hasOut = scheme.steps.some((step) => step.from === name);
    if (trend > 0.25 && !hasIn) hints.push(`${name} grows in your data, but no arrow points into it.`);
    if (trend < -0.25 && !hasOut) hints.push(`${name} falls in your data, but no arrow leaves it.`);
  }
  return hints.slice(0, 3);
};

/**
 * The fit follows the drawing. Only wired species are fitted; unwired columns stay on
 * the plot as dimmed points, waiting to be connected, so each new arrow visibly turns
 * one more dimmed trace into a fitted curve.
 */
const renderNetwork = (blocks) => {
  const parsed = parsedScheme();
  const columns = orderedColumns(blocks);

  if (parsed === null) {
    $('f-err').textContent = 'The scheme text below does not parse; fix it to fit.';
    $('f-plot').innerHTML = pointsOnlyChart(blocks);
    $('f-body').innerHTML = '';
    return false;
  }

  const wired = new Set(parsed.species);
  const wiredCols = columns.filter((c) => wired.has(c));

  if (parsed.steps.length === 0 || wiredCols.length === 0) {
    $('f-err').textContent =
      parsed.steps.length > 0 ? 'None of the connected species matches a data column.' : '';
    $('f-plot').innerHTML = pointsOnlyChart(blocks);
    $('f-body').innerHTML = '';
    return false;
  }

  const blocksForFit = wiredBlocksFor(blocks, wired);

  if (fitCache.key !== inputsKey() || fitCache.network === null) {
    $('f-err').textContent = '';
    $('f-plot').innerHTML = pointsOnlyChart(blocks);
    const cautions = schemeHints(blocks, columns.filter((c) => !balanceSet.has(c)), parsed);
    $('f-body').innerHTML =
      cautions.map((c) => `<div class="caution">${esc(c)}</div>`).join('') + fitRunPrompt();
    return false;
  }
  const fit = fitCache.network;
  $('f-err').textContent = '';
  canvas.lastFit = fit;
  canvas.lastR2 = fit.r2;
  canvas.lastRuns = blocksForFit.length;

  const order = speciesOrder(columns, fit.scheme.species);
  const colourOf = (n) => COLOURS[order.indexOf(n) % COLOURS.length];
  const dashOf = (n) => DASHES[order.indexOf(n) % DASHES.length];

  const seriesList = order.map((name) => {
    const isWired = wired.has(name);
    const hasData = columns.includes(name);
    return {
      name: balanceSet.has(name) ? `${disp(name)} \u00b7 balance` : disp(name),
      colour: colourOf(name),
      dash: dashOf(name),
      dim: !isWired,
      points: hasData ? alignReplicates(blocks, (block, i) => block.series[name]?.[i]) : [],
      curve:
        isWired && fit.curve.series[name]
          ? fit.curve.t.map((t, i) => ({ t, y: fit.curve.series[name]?.[i] ?? 0 }))
          : [],
    };
  });

  const xMax = Math.max(...fit.curve.t);
  const residual = residualChart(
    wiredCols.map((name) => ({
      colour: colourOf(name),
      points: blocksForFit.flatMap((block, b) =>
        (fit.residuals[b]?.[name] ?? []).map((r, i) => ({ t: block.times[i], r })),
      ),
    })),
    xMax,
    timeLabel(),
  );

  // Each step reports what was fitted and, when the concentrations are known, the
  // constant its own rate law carries. The units follow the step's molecularity.
  const timeUnits = { conc: 'M', time: state.unit };
  const rateLaws = [];
  const tiles = fit.steps
    .map((step) => {
      const cats = step.catalysts ?? [];
      const concs = cats.map((name) => catalystMolar(name));
      const known = concs.every((c) => c !== null);
      const kTrue = known ? trueRateConstant(step.k, concs) : null;
      const arrow = `${esc(disp(step.from))}&#8594;${esc(disp(step.to))}`;
      const fullArrow =
        disp(step.from) !== step.from || disp(step.to) !== step.to
          ? ` title="${esc(step.from)} \u2192 ${esc(step.to)}"`
          : '';
      const obsUnits = rateConstantUnits(1, timeUnits);
      const trueUnits = rateConstantUnits(step.molecularity ?? 1, timeUnits);
      const spread = step.kSpread !== null ? ` ± ${esc(fmtRate(step.kSpread))}` : '';

      if (cats.length === 0) {
        return `<div class="readout"${fullArrow}><div class="k"><span class="lit">k</span> ${arrow}</div>
           <div class="v">${esc(fmtRate(step.k))}${spread}<span class="u">${esc(trueUnits)}</span></div></div>`;
      }
      const catBrackets = cats.map((c) => `[${esc(disp(c))}]`).join('');
      rateLaws.push(
        `rate = k${catBrackets}[${esc(step.from)}]` +
          `<span class="ratelaw-note">\u00b7 k<sub>obs</sub> = k${catBrackets}</span>`,
      );
      const obsTile = `<div class="readout"${fullArrow}><div class="k"><span class="lit">k obs</span> ${arrow}</div>
           <div class="v">${esc(fmtRate(step.k))}${spread}<span class="u">${esc(obsUnits)}</span></div></div>`;
      const trueTile =
        kTrue === null
          ? `<div class="readout"><div class="k"><span class="lit">k</span> ${arrow}</div>
               <div class="v" style="color:var(--on-error-container)">?<span class="u">enter [${esc(cats.join(', '))}]</span></div></div>`
          : `<div class="readout"><div class="k"><span class="lit">k</span> ${arrow}</div>
               <div class="v">${esc(fmtRate(kTrue))}<span class="u">${esc(trueUnits)}</span></div></div>`;
      return obsTile + trueTile;
    })
    .join('');
  const inferred = fit.inferredStart
    .map(
      (i) =>
        `<div class="readout" title="${esc(i.name)}"><div class="k">${esc(disp(i.name))}&#8320; inferred</div>
           <div class="v">${esc(fmtNum(i.value))}</div></div>`,
    )
    .join('');

  const nPts = blocksForFit.reduce(
    (a, b) => a + Object.values(b.series).reduce((x, v) => x + v.length, 0),
    0,
  );
  const statTiles =
    `<div class="readout"><div class="k">SSE <span class="lit">(loss)</span></div>
       <div class="v">${esc(fmtNum(fit.sse))}<span class="u">signal\u00B2</span></div></div>` +
    `<div class="readout"><div class="k">RMSE</div>
       <div class="v">${esc(fmtNum(Math.sqrt(fit.sse / Math.max(1, nPts))))}<span class="u">signal units</span></div></div>` +
    `<div class="readout"><div class="k"><span class="lit">points</span></div>
       <div class="v">${nPts}</div></div>`;

  const cautions = schemeHints(blocks, columns.filter((c) => !balanceSet.has(c)), parsed);
  if (fit.ambiguous) {
    cautions.push(
      `${fit.ambiguous} fit these traces almost equally well when exchanged. The data cannot say ` +
        `which step is the fast one; measuring the intermediate directly would.`,
    );
  }
  if (blocksForFit.length === 1 && cautions.length === 0) {
    cautions.push('No replicate, no error bars: paste a second run after a blank line.');
  }

  $('f-plot').innerHTML = traceChart({ xLabel: timeLabel(), yLabel: signalLabel(), seriesList });
  const exportRow = `<div class="chips exports">
       <button type="button" data-export="graph">Download graph</button>
       <button type="button" data-export="data">Download data</button>
       <button type="button" data-export="both">Download both</button>
     </div>`;
  $('f-body').innerHTML =
    `<div class="readouts" style="margin:8px 0 12px">${tiles}${inferred}${statTiles}</div>` +
    (order.some((n) => disp(n) !== n)
      ? `<div class="maplegend">${order
          .filter((n) => disp(n) !== n)
          .map((n) => `<span><b>${esc(disp(n))}</b> = ${esc(n)}</span>`)
          .join('')}</div>`
      : '') +
    exportRow +
    [...new Set(rateLaws)].map((law) => `<div class="ratelaw">${law}</div>`).join('') +
    residual +
    cautions.map((c) => `<div class="caution">${esc(c)}</div>`).join('') +
    `<div class="explain"><p>Rate constants are per ${esc(state.unit)}. Background:
       <a href="https://pubs.rsc.org/en/content/articlelanding/2019/sc/c8sc04698k" target="_blank" rel="noopener">visual kinetic analysis</a>.</p></div>`;
  return true;
};

/** The data alone, plotted the moment it parses: the format confirmation. */
const pointsOnlyChart = (blocks) => {
  if (blocks.length === 0) return '';
  const names = [...new Set(blocks.flatMap((b) => Object.keys(b.series)))];
  const seriesList = names.map((name, i) => ({
    name: balanceSet.has(name) ? `${disp(name)} \u00b7 balance` : disp(name),
    colour: COLOURS[i % COLOURS.length],
    dash: DASHES[i % DASHES.length],
    points: alignReplicates(blocks, (block, r) => block.series[name]?.[r]),
    curve: [],
  }));
  return traceChart({ xLabel: timeLabel(), yLabel: signalLabel(), seriesList });
};

/**
 * A small static diagram of an example's mechanism, in the canvas's own visual
 * language: coloured nodes, barbed arrows, opposing pairs for equilibria. It is what
 * lets each example card say what it models before any text is read.
 */
const miniScheme = (schemeText) => {
  const parsedResult = parseScheme(schemeText);
  if (!parsedResult.ok) return '';
  const sp = parsedResult.scheme.species;
  const steps = parsedResult.scheme.steps;
  const edges = pairEdges(steps);
  // A path in the undirected edge graph lays out as a row; anything else rings.
  // Reversible pairs and branches both count one edge per neighbour, so A = B = C
  // and B <- A -> C are rows too, which is how a chemist would sketch them.
  const adj = new Map(sp.map((n) => [n, []]));
  for (const e of edges) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }
  // Any graph with a spanning path lays out as a row; edges the row cannot carry
  // become arcs over it, which is how a chemist sketches a cycle: a run of arrows
  // with the return step arched back to the start. Only pathless graphs ring.
  const spanningPath = () => {
    const walk = (at, seen, path) =>
      path.length === sp.length
        ? path
        : adj
            .get(at)
            .filter((nb) => !seen.has(nb))
            .reduce(
              (found, nb) =>
                found ?? walk(nb, new Set([...seen, nb]), [...path, nb]),
              null,
            );
    return sp.reduce((found, start) => found ?? walk(start, new Set([start]), [start]), null);
  };
  const rowOrder = spanningPath();
  const R = 7;
  const pos = new Map();
  const indexOf = new Map((rowOrder ?? []).map((n, i) => [n, i]));
  const chords = rowOrder
    ? edges.filter((e) => Math.abs(indexOf.get(e.a) - indexOf.get(e.b)) > 1)
    : [];
  const liftFor = (e) => 8 + 3 * Math.abs(indexOf.get(e.a) - indexOf.get(e.b));
  const liftMax = chords.reduce((a, e) => Math.max(a, liftFor(e)), 0);
  let w;
  let h;
  if (rowOrder) {
    const gap = 32;
    const rowY = 13 + liftMax;
    h = 26 + liftMax;
    w = 2 * (R + 5) + (sp.length - 1) * gap;
    rowOrder.forEach((n, i) => pos.set(n, { x: R + 5 + i * gap, y: rowY }));
  } else {
    const ringR = 20;
    w = 2 * (ringR + R + 5);
    h = w;
    sp.forEach((n, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / sp.length;
      pos.set(n, { x: w / 2 + ringR * Math.cos(a), y: h / 2 + ringR * Math.sin(a) });
    });
  }
  const parts = [];
  const ink = 'var(--on-variant)';
  const arcArrow = (p1, p2, lift) => {
    const head = 4.2;
    const cx = (p1.x + p2.x) / 2;
    const cy = Math.min(p1.y, p2.y) - lift;
    const out = (from, toX, toY) => {
      const dx = toX - from.x;
      const dy = toY - from.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: from.x + (dx / len) * (R + 2), y: from.y + (dy / len) * (R + 2) };
    };
    const a = out(p1, cx, cy);
    const bTip = out(p2, cx, cy);
    const tdx = bTip.x - cx;
    const tdy = bTip.y - cy;
    const tlen = Math.hypot(tdx, tdy) || 1;
    const ux = tdx / tlen;
    const uy = tdy / tlen;
    const px = -uy;
    const py = ux;
    const half = head * 0.42;
    const baseX = bTip.x - ux * head;
    const baseY = bTip.y - uy * head;
    return (
      `<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${(
        bTip.x - ux * head * 0.6
      ).toFixed(1)} ${(bTip.y - uy * head * 0.6).toFixed(1)}" fill="none" stroke="${ink}"
         stroke-width="1.3"/>` +
      `<path d="M${bTip.x.toFixed(1)} ${bTip.y.toFixed(1)} L${(baseX + px * half).toFixed(1)} ${(
        baseY + py * half
      ).toFixed(1)} L${(bTip.x - ux * head * 0.72).toFixed(1)} ${(bTip.y - uy * head * 0.72).toFixed(1)} L${(
        baseX - px * half
      ).toFixed(1)} ${(baseY - py * half).toFixed(1)} Z" fill="${ink}"/>`
    );
  };
  edges.forEach((e) => {
    const p1 = pos.get(e.a);
    const p2 = pos.get(e.b);
    if (!p1 || !p2) return;
    if (chords.includes(e)) {
      parts.push(arcArrow(p1, p2, liftFor(e)));
      if (e.reversible) parts.push(arcArrow(p2, p1, liftFor(e) + 4));
      return;
    }
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = R + 2;
    const ax = p1.x + (dx / len) * off;
    const ay = p1.y + (dy / len) * off;
    const bx = p2.x - (dx / len) * off;
    const by = p2.y - (dy / len) * off;
    if (e.reversible) {
      const nx = (-dy / len) * 2.4;
      const ny = (dx / len) * 2.4;
      parts.push(
        arrowSVG(ax + nx, ay + ny, bx + nx, by + ny, 1.3, 4.2, ink),
        arrowSVG(bx - nx, by - ny, ax - nx, ay - ny, 1.3, 4.2, ink),
      );
    } else {
      parts.push(arrowSVG(ax, ay, bx, by, 1.3, 4.2, ink));
    }
  });
  sp.forEach((n, i) => {
    const p = pos.get(n);
    const colour = COLOURS[i % COLOURS.length];
    const rgb = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16));
    const ink = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150 ? '#0d366b' : '#fff';
    parts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${R}" fill="${colour}"/>`,
      `<text x="${p.x.toFixed(1)}" y="${(p.y + 3).toFixed(1)}" text-anchor="middle"
         font-size="9" font-weight="700" fill="${ink}" font-family="var(--sans)">${esc(n)}</text>`,
    );
  });
  // Width and height attributes pin every thumbnail to one shared scale (1.5x its
  // coordinate system, so node letters land at the type floor) and nothing can
  // letterbox or squish.
  const SCALE = 1.5;
  return `<svg viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" width="${(w * SCALE).toFixed(0)}" height="${(h * SCALE).toFixed(0)}" aria-hidden="true">${parts.join('')}</svg>`;
};

/* ------------------------------------------------------------------ *
 * Gallery: complete scenarios with ground truth in the comments
 * ------------------------------------------------------------------ */

// Every dataset below is synthesized from the stated constants (per hour) plus seeded
// noise, over 72 h sampled densely in the first 6 h. Fits are verifiable against them.
const GALLERY = {
  // truth: k1 = 0.35 per h, sigma 1.0
  E1: {
    scheme: 'A -> B',
    callout:
      'Single conversion: A -> B, 17 points over 72 h. Expect k near 0.35 per h.',
    data: `t, A, B
0, 99.5, 0
0.5, 84.1, 15.5
1, 70.2, 28.6
1.5, 59.1, 40.1
2, 50.4, 51.3
3, 35.7, 65
4, 24.9, 76.1
5, 17.6, 81.8
6, 11.5, 88.7
9, 5.1, 96.5
12, 1.6, 97.9
18, 0.3, 99.3
24, 0.9, 100.6
36, 0, 100.7
48, 0, 99.1
60, 0, 100.1
72, 0.7, 100.7`,
  },
  // truth: kf = 0.30, kr = 0.075 per h (Keq = 4), sigma 0.8
  E2: {
    scheme: 'A = B',
    callout:
      'Reversible pair: the plateau is an equilibrium, not a stall. Expect kf/kr near 4.',
    data: `t, A, B
0, 100.3, 0
0.5, 86.5, 14
1, 75.3, 25.4
1.5, 66.4, 34.3
2, 57.1, 41.7
3, 45.9, 53.4
4, 38.3, 62.3
5, 32.8, 67.6
6, 28, 71.2
9, 22, 76.9
12, 20.6, 79.7
18, 20.8, 79.4
24, 20.6, 80.1
36, 19.7, 79.7
48, 19.4, 80.8
60, 19.4, 80.7
72, 20.5, 79.9`,
  },
  // truth: k1 = 0.35, k2 = 0.08 per h, sigma 1.0
  E3: {
    scheme: 'A -> B\nB -> C',
    callout:
      'Sequential intermediate: A -> B -> C. Expect k1 near 0.35 and k2 near 0.08.',
    data: `t, A, B, C
0, 100.4, 0, 0
0.5, 84, 15, 0
1, 70.7, 28.7, 1.2
1.5, 58.6, 37.7, 2.9
2, 50.4, 46.7, 4.6
3, 35.7, 56.4, 7.7
4, 23.9, 62.2, 13.5
5, 18.4, 64.2, 18.7
6, 12.1, 63.4, 22.6
9, 4.9, 58.5, 38.8
12, 0.8, 47.5, 50.4
18, 0.2, 31.2, 70.2
24, 0, 18.6, 81.1
36, 0, 7.1, 91.7
48, 0.3, 2.5, 97.2
60, 0, 1.3, 99.3
72, 0.1, 0.6, 99.1`,
  },
  // truth: ks = 0.5, 0.2, 0.2, 0.1, 0.08, 0.04 per h, sigma 1.0
  E4: {
    scheme: 'A = B\nB = C\nC = D',
    callout:
      'Four-species chain, six rate constants. All should return within about 15%.',
    data: `t, A, B, C, D
0, 99.8, 0, 0.9, 0
0.5, 79.7, 21, 1.2, 0.9
1, 62.9, 32.1, 3.6, 0.1
1.5, 53.9, 41, 7.2, 0.9
2, 44.6, 44.3, 10.6, 0
3, 34.2, 46.7, 17.5, 2.6
4, 27.3, 45.9, 22.4, 3.5
5, 24.5, 43.4, 26.9, 5.5
6, 21.3, 39.9, 31.5, 7.6
9, 16.9, 34.4, 36.1, 15
12, 14.1, 29.3, 37.6, 19.8
18, 10.1, 23.3, 34.7, 32.3
24, 7.3, 20.5, 32.5, 39.1
36, 6.8, 16.2, 28.5, 47.6
48, 6.1, 13.7, 27.3, 50.6
60, 5.1, 13.5, 27.6, 52.8
72, 6.4, 14, 27.4, 53.3`,
  },
  // truth: k1 = 0.30 (to B), k2 = 0.12 (to C) per h, sigma 1.0
  E5: {
    scheme: 'A -> B\nA -> C',
    callout:
      'Branched pathways: the product ratio is the rate ratio. Expect 0.30 to B, 0.12 to C.',
    data: `t, A, B, C
0, 100.4, 0, 0.8
0.5, 81.8, 13.6, 5.7
1, 66.2, 24.7, 9.4
1.5, 52.6, 32.9, 12.6
2, 42.9, 40.5, 16.8
3, 28.7, 51.8, 20.1
4, 19, 58, 23
5, 12.7, 62.7, 25.6
6, 8.4, 65.2, 26.9
9, 3.2, 70.4, 28.7
12, 0, 71.1, 28.4
18, 0.4, 70.4, 28.4
24, 0, 72.1, 28
36, 0, 72.4, 28.9
48, 0.2, 70.7, 28.6
60, 0.1, 72.3, 27.9
72, 0, 72.1, 29.5`,
  },
  // truth: k1 = 0.35, k2 = 0.08 per h, sigma 3.0, 12 points only
  // truth: kAB = 0.45, kBC = 0.4, kCA = 0.35, kCD = 0.05 per h, sigma 1.
  // A driven loop (constants chosen for identifiability; a thermal cycle would need
  // Wegscheider-consistent reverse steps, which these traces cannot pin down).
  E6: {
    scheme: 'A -> B\nB -> C\nC -> A\nC -> D',
    callout:
      'A loop with a leak: C feeds back to A and slowly drains to D. ' +
      'Expect k near 0.45, 0.4, 0.35 h\u207B\u00B9 around the loop and 0.05 h\u207B\u00B9 for the drain.',
    data: `t, A, B, C, D
0, 100, 0, 0, 0
0.5, 79.9, 18.1, 1.4, 0
1, 63.9, 30.5, 4.1, 0
1.5, 52.9, 35.3, 11.2, 0
2, 46.6, 39, 15.5, 0.8
3, 33.5, 39.1, 25.2, 0.2
4, 28.6, 38.4, 28.1, 2.9
5, 28, 36.2, 30.1, 5
6, 26.1, 34.2, 32.4, 5.4
9, 26.2, 29.9, 33.8, 12
12, 24.2, 29.9, 31, 16.9
18, 20.3, 27.8, 27.3, 25.1
24, 18.2, 22.8, 24.7, 32.5
36, 16.6, 19.4, 19.7, 44.4
48, 14.9, 17.2, 16.8, 55.9
60, 11.4, 11, 13.6, 64.5
72, 9.5, 9.7, 10.2, 71.8`,
  },
};

/* ------------------------------------------------------------------ *
 * The scheme canvas: the network as tappable nodes and arrows
 * ------------------------------------------------------------------ */

/** Steps regrouped into edges; a forward/backward pair collapses to one reversible edge. */
const pairEdges = (steps) => {
  const edges = [];
  const used = new Set();
  steps.forEach((s, i) => {
    if (used.has(i)) return;
    const back = steps.findIndex(
      (r, j) => j > i && !used.has(j) && r.from === s.to && r.to === s.from,
    );
    if (back >= 0) used.add(back);
    // Catalysts ride along so a canvas edit can never silently drop them.
    edges.push({ a: s.from, b: s.to, reversible: back >= 0, cats: s.catalysts ?? [] });
  });
  return edges;
};

/** Edges back to scheme text; reversible pairs written with the chemist's `<->`. */
const textFromEdges = (edges) =>
  edges
    .map((e) => {
      const cats = (e.cats ?? []).map(quoteSpecies);
      const side = (name) => (cats.length ? [quoteSpecies(name), ...cats].join(' + ') : quoteSpecies(name));
      return `${side(e.a)} ${e.reversible ? '<->' : '->'} ${side(e.b)}`;
    })
    .join('\n');

/** The scheme textarea parsed, `{species, steps}`; empty on blank; null while unparsable. */
const parsedScheme = () => {
  const text = ($('f-scheme')?.value ?? '').trim();
  if (text === '') return { species: [], steps: [], catalysts: [] };
  const p = parseScheme(text);
  return p.ok
    ? { species: p.scheme.species, steps: p.scheme.steps, catalysts: p.scheme.catalysts }
    : null;
};

const setSchemeText = (text) => {
  canvas.selected = null;
  canvas.selectedEdge = null;
  canvas.popAt = null;
  const box = $('f-scheme');
  if (box) box.value = text;
  render();
};

/**
 * The network drawn the way the literature draws it: species as coloured nodes on a
 * ring, steps as arrows between them, and, once a fit exists, each arrow carrying its
 * rate constant and a thickness proportional to it. The drawing is also the editor:
 * tapping is handled by canvasClick below, and every edit round-trips through the
 * scheme text, which stays the single source of truth.
 */
const drawCanvas = () => {
  const svg = $('f-canvas');
  if (!svg) return;
  const parsed = parsedScheme();
  if (parsed === null) return; // mid-edit text: keep the last good drawing
  canvas.extras = canvas.extras.filter(
    (name) => !parsed.species.includes(name) && !canvas.dataNames.includes(name),
  );
  const names = speciesOrder(canvas.dataNames, parsed.species, canvas.extras);
  if (canvas.selected !== null && !names.includes(canvas.selected)) canvas.selected = null;
  if (names.length === 0) {
    svg.innerHTML = '';
    renderGuide();
    return;
  }

  const CW = 320;
  const CH = 236;
  const ring = names.length <= 3 ? 62 : names.length <= 5 ? 80 : 92;
  const pos = new Map(
    names.map((n, i) => {
      // Two species read left to right like a written scheme; three or more ring.
      const angle =
        names.length === 2 ? Math.PI - Math.PI * i : -Math.PI / 2 + (2 * Math.PI * i) / names.length;
      return [n, { x: CW / 2 + ring * Math.cos(angle), y: CH / 2 + ring * Math.sin(angle) }];
    }),
  );

  const kOf = new Map();
  if (canvas.lastFit) for (const s of canvas.lastFit.steps) kOf.set(`${s.from}>${s.to}`, s.k);
  const kMax = Math.max(...[...kOf.values()], 0);

  const parts = [];

  pairEdges(parsed.steps).forEach((e, idx) => {
    const p1 = pos.get(e.a);
    const p2 = pos.get(e.b);
    if (!p1 || !p2) return;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    // The line ends 2 units off the node rim (r = 16); with refX at the marker tip,
    // the arrowhead's point lands exactly there. The head extends backward over the
    // line, so the join is a single solid shape with no seam.
    const off = 18;
    // The marker draws backward from the tip, so the shaft ends short of the node by
    // the head's length; otherwise a stub of line protrudes past the point.
    const x1 = (p1.x + (dx / len) * off).toFixed(1);
    const y1 = (p1.y + (dy / len) * off).toFixed(1);
    const x2 = (p2.x - (dx / len) * off).toFixed(1);
    const y2 = (p2.y - (dy / len) * off).toFixed(1);
    const kf = kOf.get(`${e.a}>${e.b}`);
    const kr = kOf.get(`${e.b}>${e.a}`);
    // Two significant figures on the drawing; the tiles carry the precise values.
    const fmtK = (v) => {
      const r = Number(v.toPrecision(2));
      return Math.abs(r) < 1e-3 || Math.abs(r) >= 1e4 ? r.toExponential(1) : String(r);
    };
    const isSel = canvas.selectedEdge === idx;
    // Each direction carries its own constant twice over: stroke width on a linear
    // relative scale, and ink interpolated between a fixed light floor and a fixed
    // dark ceiling. Referenced against the largest constant of this fit, so the
    // fastest step is heavy and near-black while the slowest stays visibly grey.
    const widthOf = (k) => (kMax > 0 && k !== undefined && k > 0 ? 1.2 + 2.2 * (k / kMax) : 1.8);
    const inkOf = (k) => {
      if (isSel) return 'var(--deep-teal)';
      if (kMax <= 0 || k === undefined || !(k > 0)) return 'var(--on-variant)';
      const t = k / kMax;
      const lo = [178, 184, 198];
      const hi = [24, 28, 36];
      return `rgb(${lo.map((l, i) => Math.round(l + ((hi[i] ?? 0) - l) * t)).join(' ')})`;
    };
    const drawArrow = (ax, ay, bx, by, k) =>
      arrowSVG(ax, ay, bx, by, widthOf(k), 8 + 2.4 * widthOf(k), inkOf(k));
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    // Chemistry, not decoration: an equilibrium is two opposing arrows, offset either
    // side of the axis. A single double-headed arrow would read as resonance.
    const nx = -dy / len;
    const ny = dx / len;
    const sep = 6.2;
    // Each number sits beside its own shaft, on that shaft's side of the pair, so
    // adjacency says which direction it belongs to; no arrow glyphs needed.
    const kText = (k, side) =>
      k === undefined
        ? ''
        : `<text x="${(mx + nx * side).toFixed(1)}" y="${(my + ny * side + 4).toFixed(1)}"
             text-anchor="middle" font-size="13" fill="var(--on-variant)"
             font-family="var(--math)" pointer-events="none" paint-order="stroke"
             stroke="var(--surface)" stroke-width="4"
             stroke-linejoin="round">${esc(fmtK(k))}</text>`;
    // A one-way arrow keeps its label on the side facing away from the canvas
    // centre, so neighbouring labels spread apart instead of colliding.
    let ox = nx;
    let oy = ny;
    if (ox * (mx - 160) + oy * (my - 118) < 0) {
      ox = -ox;
      oy = -oy;
    }
    const singleText =
      kf === undefined
        ? ''
        : `<text x="${(mx + ox * 14).toFixed(1)}" y="${(my + oy * 14 + 4).toFixed(1)}"
             text-anchor="middle" font-size="13" fill="var(--on-variant)"
             font-family="var(--math)" pointer-events="none" paint-order="stroke"
             stroke="var(--surface)" stroke-width="4"
             stroke-linejoin="round">${esc(fmtK(kf))}</text>`;
    parts.push(
      e.reversible
        ? drawArrow(
            Number(x1) + nx * sep,
            Number(y1) + ny * sep,
            Number(x2) + nx * sep,
            Number(y2) + ny * sep,
            kf,
          ) +
            drawArrow(
              Number(x2) - nx * sep,
              Number(y2) - ny * sep,
              Number(x1) - nx * sep,
              Number(y1) - ny * sep,
              kr,
            )
        : drawArrow(Number(x1), Number(y1), Number(x2), Number(y2), kf),
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent"
         stroke-width="18" data-edge="${idx}"><title>Click to edit this step</title></line>`,
      e.reversible ? kText(kf, sep + 12) + kText(kr, -(sep + 12)) : singleText,
    );
  });

  names.forEach((n, i) => {
    const p = pos.get(n);
    const colour = COLOURS[i % COLOURS.length];
    const wired = parsed.species.includes(n);
    // Light fills take navy text; the pale steps of the ramp drown white.
    const rgb = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16));
    const ink = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150 ? '#0d366b' : '#fff';
    parts.push(
      canvas.selected === n
        ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="21" fill="none"
             stroke="var(--deep-teal)" stroke-width="2.5"/>`
        : '',
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="16" fill="${colour}"
         ${wired ? '' : 'fill-opacity="0.45"'} pointer-events="none"/>`,
      `<text x="${p.x.toFixed(1)}" y="${(p.y + 4.5).toFixed(1)}" text-anchor="middle"
         font-size="${disp(n).length > 2 ? 12 : 14}" font-weight="700" fill="${ink}"
         font-family="var(--sans)" pointer-events="none">${esc(disp(n))}</text>`,
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="24" fill="transparent"
         data-node="${esc(n)}"><title>${esc(n)}</title></circle>`,
    );
  });

  // Item 7: connecting is a drag, so no panel ever covers a node while the user is
  // choosing the target. Hovering shows a + handle on the node's rim; dragging it
  // draws a dashed preview, and releasing over another node writes the step. The
  // layer is added after the frame is fitted, so hovering never rescales the map
  // (a moving target under a pressed mouse button is unusable).
  const overlay = [];
  const handleNode = canvas.drag?.from ?? canvas.hover;
  const handlePos = handleNode === null || handleNode === undefined ? null : pos.get(handleNode);
  if (handlePos) {
    const ddx = handlePos.x - CW / 2;
    const ddy = handlePos.y - CH / 2;
    const dlen = Math.hypot(ddx, ddy) || 1;
    const hx = handlePos.x + (ddx / dlen) * 27;
    const hy = handlePos.y + (ddy / dlen) * 27;
    overlay.push(
      `<g data-handle="${esc(handleNode)}" style="cursor:crosshair">
         <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="13" fill="transparent"/>
         <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="8.5" fill="var(--deep-teal)"/>
         <text x="${hx.toFixed(1)}" y="${(hy + 4).toFixed(1)}" text-anchor="middle" font-size="13"
           font-weight="700" fill="#fff" font-family="var(--sans)" pointer-events="none">+</text>
         <title>Drag to connect ${esc(disp(handleNode))} to another species</title>
       </g>`,
    );
  }
  if (canvas.drag && handlePos) {
    const target = canvas.drag.over !== null ? pos.get(canvas.drag.over) : null;
    const endX = target ? target.x : canvas.drag.x;
    const endY = target ? target.y : canvas.drag.y;
    overlay.push(
      `<line x1="${handlePos.x.toFixed(1)}" y1="${handlePos.y.toFixed(1)}" x2="${endX.toFixed(1)}"
         y2="${endY.toFixed(1)}" stroke="var(--deep-teal)" stroke-width="2.2"
         stroke-dasharray="6 5" pointer-events="none"/>`,
      target && canvas.drag.over !== canvas.drag.from
        ? `<circle cx="${target.x.toFixed(1)}" cy="${target.y.toFixed(1)}" r="21" fill="none"
             stroke="var(--deep-teal)" stroke-width="2.5" pointer-events="none"/>`
        : '',
    );
  }

  svg.innerHTML = parts.join('');
  // The ring is laid out on a fixed grid, so a small network leaves most of that grid
  // empty. Refit the frame to what was actually drawn, labels included, and size the
  // element from the same box: no dead space, and the diagram reads at a useful size.
  // While a drag is live the frame must hold still, or the diagram slides under the
  // pointer mid-gesture.
  const box = svg.getBBox();
  const frameStable = box.width > 0 && box.height > 0 && canvas.drag === null;
  if (frameStable) {
    const pad = 16;
    const w = box.width + pad * 2;
    const h = box.height + pad * 2;
    svg.setAttribute('viewBox', `${(box.x - pad).toFixed(1)} ${(box.y - pad).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
    // Exactly 1:1 with the drawing: a sparse scheme uses less of the page instead of
    // inflating its nodes, so node size is identical across every example.
    svg.style.maxWidth = `${Math.round(w)}px`;
  }
  if (overlay.length > 0) svg.insertAdjacentHTML('beforeend', overlay.join(''));
  const legend = $('f-map-legend');
  if (legend) {
    const rows = names.filter((n) => disp(n) !== n);
    const unitNote =
      kOf.size > 0 ? [`<span>k in ${esc(state.unit)}\u207B\u00B9</span>`] : [];
    legend.innerHTML = [
      ...unitNote,
      ...rows.map((n) => `<span><b>${esc(disp(n))}</b> = ${esc(n)}</span>`),
    ].join('');
    legend.classList.toggle('hide', rows.length === 0 && unitNote.length === 0);
  }
  renderGuide();
  renderPop();
};

/**
 * The guide bar under the canvas: it always states the next step, and while a node or
 * an arrow is selected it carries the explicit edit and delete buttons. This is where
 * a first-time user learns the canvas without reading anything in advance.
 */
const renderGuide = () => {
  const guide = $('f-guide');
  if (!guide) return;
  const parsed = parsedScheme();
  if (parsed === null) {
    guide.textContent = 'Fix the scheme text below to keep editing here.';
    return;
  }
  const edges = pairEdges(parsed.steps);

  if (canvas.selected !== null) {
    const n = esc(disp(canvas.selected));
    guide.innerHTML =
      `<span><b>${n}</b> selected: click the species it turns into, or drag its + handle.</span>
       <span class="chips" style="margin:0">
         <button type="button" data-act="node-remove">Remove ${n}</button>
         <button type="button" data-act="cancel">Cancel</button>
       </span>`;
    return;
  }

  const edge = canvas.selectedEdge === null ? undefined : edges[canvas.selectedEdge];
  if (edge) {
    const name = `${esc(edge.a)} ${edge.reversible ? '&#8652;' : '&#8594;'} ${esc(edge.b)}`;
    guide.innerHTML = `<span>Editing <b>${name}</b> in the menu. Esc closes it.</span>`;
    return;
  }

  guide.textContent =
    edges.length === 0
      ? canvas.dataNames.length >= 2
        ? 'Hover the species that disappears and drag its + handle onto the one it becomes.'
        : 'Hover a species and drag its + handle onto another to draw the first step.'
      : 'Drag a + handle to connect species. Click an arrow to edit or delete it.';
};

/**
 * The edit menu, anchored where the tap landed. Actions are grouped: Direction first,
 * Delete visually separated at the bottom. It flips to stay inside the viewport, and
 * the first button takes focus so the keyboard can drive it; Esc and click-away close.
 */
const renderPop = () => {
  const pop = $('f-pop');
  if (!pop) return;
  const parsed = parsedScheme();
  const edges = parsed === null ? [] : pairEdges(parsed.steps);
  const edge = canvas.selectedEdge === null ? undefined : edges[canvas.selectedEdge];
  const showing = canvas.popAt !== null && parsed !== null && Boolean(edge);
  if (!showing) {
    pop.classList.add('hide');
    pop.innerHTML = '';
    canvas.lastPopKey = '';
    return;
  }

  const a = esc(disp(edge.a));
  const b = esc(disp(edge.b));
  const key = `edge:${a}:${b}:${edge.reversible}`;
  pop.innerHTML =
    `<div class="pop-title">${a} ${edge.reversible ? '&#8652;' : '&#8594;'} ${b}</div>
     <div class="pop-h">Direction</div>
     ${
       edge.reversible
         ? `<button type="button" data-act="edge-oneway">Keep only ${a} &#8594; ${b}</button>
            <button type="button" data-act="edge-oneway-rev">Keep only ${b} &#8594; ${a}</button>`
         : `<button type="button" data-act="edge-rev">Make reversible</button>
            <button type="button" data-act="edge-flip">Reverse direction</button>`
     }
     <div class="pop-sep"></div>
     <button type="button" data-act="edge-del" class="danger">Delete step</button>`;

  pop.classList.remove('hide');
  const field = $('f-scheme-field');
  const frame = field.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let x = canvas.popAt.x + 10;
  let y = canvas.popAt.y + 6;
  if (x + pw > frame.width) x = Math.max(0, canvas.popAt.x - pw - 10);
  if (frame.top + y + ph > window.innerHeight - 8) y = Math.max(0, canvas.popAt.y - ph - 6);
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
  if (key !== canvas.lastPopKey) {
    canvas.lastPopKey = key;
    pop.querySelector('button')?.focus({ preventScroll: true });
  }
};


const guideAction = (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const parsed = parsedScheme();
  if (parsed === null) return;

  if (act === 'cancel') {
    canvas.selected = null;
    canvas.selectedEdge = null;
    drawCanvas();
    return;
  }
  if (act === 'node-remove') {
    const name = canvas.selected;
    canvas.extras = canvas.extras.filter((x) => x !== name);
    setSchemeText(
      textFromEdges(pairEdges(parsed.steps.filter((s) => s.from !== name && s.to !== name))),
    );
    return;
  }

  const edge = canvas.selectedEdge === null ? undefined : pairEdges(parsed.steps)[canvas.selectedEdge];
  if (!edge) return;
  const isPair = (s) =>
    (s.from === edge.a && s.to === edge.b) || (s.from === edge.b && s.to === edge.a);
  let steps = parsed.steps;
  if (act === 'edge-rev') steps = [...steps, { from: edge.b, to: edge.a }];
  if (act === 'edge-oneway') steps = steps.filter((s) => !(s.from === edge.b && s.to === edge.a));
  if (act === 'edge-oneway-rev') steps = steps.filter((s) => !(s.from === edge.a && s.to === edge.b));
  if (act === 'edge-flip')
    steps = steps.map((s) => (s.from === edge.a && s.to === edge.b ? { from: edge.b, to: edge.a } : s));
  if (act === 'edge-del') steps = steps.filter((s) => !isPair(s));
  setSchemeText(textFromEdges(pairEdges(steps)));
};

const anchorPop = (ev) => {
  const field = $('f-scheme-field');
  if (!field) return;
  const frame = field.getBoundingClientRect();
  canvas.popAt = { x: ev.clientX - frame.left, y: ev.clientY - frame.top };
};

const canvasClick = (ev) => {
  if (canvas.suppressClick) {
    canvas.suppressClick = false;
    return;
  }
  let el = ev.target;
  while (el && el !== ev.currentTarget && !(el.dataset && (el.dataset.node || el.dataset.edge))) {
    el = el.parentNode;
  }
  const parsed = parsedScheme();
  if (parsed === null) return;

  if (el && el.dataset && el.dataset.node) {
    const name = el.dataset.node;
    canvas.selectedEdge = null;
    if (canvas.selected === null || canvas.selected === name) {
      canvas.selected = canvas.selected === name ? null : name;
      canvas.popAt = null;
      drawCanvas();
      return;
    }
    const from = canvas.selected;
    canvas.selected = null;
    if (parsed.steps.some((s) => s.from === from && s.to === name)) {
      drawCanvas();
      return;
    }
    setSchemeText(textFromEdges(pairEdges([...parsed.steps, { from, to: name }])));
    return;
  }

  if (el && el.dataset && el.dataset.edge) {
    const idx = Number(el.dataset.edge);
    canvas.selected = null;
    canvas.selectedEdge = canvas.selectedEdge === idx ? null : idx;
    if (canvas.selectedEdge === null) canvas.popAt = null;
    else anchorPop(ev);
    drawCanvas();
    return;
  }

  if (canvas.selected !== null || canvas.selectedEdge !== null) {
    canvas.selected = null;
    canvas.selectedEdge = null;
    canvas.popAt = null;
    drawCanvas();
  }
};

const addSpecies = () => {
  const parsed = parsedScheme() ?? { species: [] };
  const taken = new Set([...parsed.species, ...canvas.dataNames, ...canvas.extras]);
  const name =
    [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find((c) => !taken.has(c)) ?? `S${taken.size + 1}`;
  canvas.extras.push(name);
  drawCanvas();
};

/* ------------------------------------------------------------------ *
 * Conditions: the concentrations that give a rate constant its units
 * ------------------------------------------------------------------ */

/**
 * What the fit cannot learn from the shape of a trace.
 *
 * A catalytic decay is fitted as pseudo-first-order, so the constant it returns is
 * k_obs with units of reciprocal time. Recovering the constant the rate law actually
 * carries, rate = k[Cat][S], needs the catalyst concentration, and a chemist normally
 * knows that as a loading in mol% rather than as a molarity.
 */
const conditions = {
  /** Initial concentration of the starting material, in molar, as typed. */
  S0: '',
  /** Per catalyst: { mode: 'molpct' | 'molar', value: string }. */
  catalysts: {},
  /** The catalyst list the current fields were built for. */
  signature: '',
};

const numberOf = (text) => {
  const value = Number(String(text).trim());
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Molar concentration of one catalyst, or null when it cannot be worked out yet. */
const catalystMolar = (name) => {
  const entry = conditions.catalysts[name];
  if (!entry) return null;
  const value = numberOf(entry.value);
  if (value === null) return null;
  if (entry.mode === 'molar') return value;
  const S0 = numberOf(conditions.S0);
  return S0 === null ? null : (S0 * value) / 100;
};

const fmtConc = (molar) =>
  molar >= 0.1 ? `${fmtNum(molar)} M` : `${fmtNum(molar * 1000)} mM`;

/**
 * The conditions fields, rebuilt only when the catalyst list changes so that typing
 * into them never loses focus.
 */
const renderConditions = (scheme) => {
  const host = $('f-cond-fields');
  if (!host) return;
  const cats = scheme === null ? [] : [...scheme.catalysts];
  const signature = cats.join(',');

  if (conditions.signature !== signature) {
    conditions.signature = signature;
    for (const name of cats) {
      if (!conditions.catalysts[name]) conditions.catalysts[name] = { mode: 'molpct', value: '' };
    }
    host.innerHTML =
      `<div class="cond-row">
         <label for="f-cond-s0">Starting material [S]&#8320;</label>
         <input type="text" id="f-cond-s0" inputmode="decimal" placeholder="0.10"
                value="${esc(conditions.S0)}"> <span class="stage-say" style="margin:0">M</span>
       </div>` +
      cats
        .map(
          (name) =>
            `<div class="cond-row" data-cat="${esc(name)}">
               <label title="${esc(name)}">Catalyst ${esc(disp(name))}</label>
               <span class="chips" style="margin:0">
                 <button type="button" data-cat-mode="molpct" data-for="${esc(name)}"
                   aria-pressed="${conditions.catalysts[name].mode === 'molpct'}">mol%</button>
                 <button type="button" data-cat-mode="molar" data-for="${esc(name)}"
                   aria-pressed="${conditions.catalysts[name].mode === 'molar'}">molar</button>
               </span>
               <input type="text" data-cat-value="${esc(name)}" inputmode="decimal"
                      placeholder="${conditions.catalysts[name].mode === 'molpct' ? '5' : '0.005'}"
                      value="${esc(conditions.catalysts[name].value)}">
               <span class="cond-derived" data-cat-derived="${esc(name)}"></span>
             </div>`,
        )
        .join('');
  }

  // The derived line is refreshed every render: it is the mol% to molar conversion,
  // shown so the number the fit uses is never hidden.
  for (const name of cats) {
    const out = host.querySelector(`[data-cat-derived="${name}"]`);
    if (!out) continue;
    const molar = catalystMolar(name);
    const entry = conditions.catalysts[name];
    if (molar === null) {
      out.className = 'cond-missing';
      out.textContent =
        entry.mode === 'molpct' && numberOf(entry.value) !== null
          ? 'needs [S]\u2080'
          : 'needed for units';
    } else {
      out.className = 'cond-derived';
      out.textContent =
        entry.mode === 'molpct'
          ? `${entry.value} mol% of ${conditions.S0.trim()} M = ${fmtConc(molar)}`
          : `= ${fmtConc(molar)}`;
    }
  }
  return cats;
};

/* ------------------------------------------------------------------ *
 * Status line, step strip, callout
 * ------------------------------------------------------------------ */

let firstError = null;

const setStatus = (parsed) => {
  const el = $('f-status-text');
  if (!el) return;
  firstError = parsed.errors[0] ?? null;
  if (firstError) {
    el.innerHTML =
      `<span class="bad">Line ${firstError.line}: "${esc(firstError.text.slice(0, 32))}" ` +
      `${esc(firstError.reason)}.</span>`;
    return;
  }
  if (!parsed.stats) {
    el.textContent = 'Nothing pasted yet.';
    return;
  }
  if (parsed.stats.points === 1) {
    el.innerHTML =
      '<span class="bad">One point plots, but a fit needs at least three. Add more rows.</span>';
    return;
  }
  const single = parsed.runs.every((r) => r.kind === 'single');
  const runsPart = parsed.runs.length > 1 ? `${parsed.runs.length} runs · ` : '';
  const what = single ? 'conversion' : signalLabel().toLowerCase();
  el.innerHTML =
    `<span class="ok">${runsPart}${parsed.stats.points} points · t ${esc(fmtNum(parsed.stats.tMin))} to ` +
    `${esc(fmtNum(parsed.stats.tMax))} ${esc(state.unit)} · ${esc(what)} ${esc(fmtNum(parsed.stats.yMin))} to ` +
    `${esc(fmtNum(parsed.stats.yMax))}</span>`;
};

/**
 * The three numbered sections are the guidance: each carries its own state summary,
 * lights as current or done, and a section only appears once it is reachable. In
 * order-fit mode there is no mechanism to draw, so the fit renumbers itself to 2.
 */
const setStages = ({ data, scheme, cond, fit }) => {
  const stages = [
    ['f-stage-data', 'f-state-data', data],
    ['f-stage-scheme', 'f-state-scheme', scheme],
    ['f-stage-cond', 'f-state-cond', cond],
    ['f-stage-fit', 'f-state-fit', fit],
  ];
  const railRows = [];
  let currentTaken = false;
  let number = 0;
  for (const [sectionId, stateId, info] of stages) {
    const section = $(sectionId);
    const stateEl = $(stateId);
    if (!section) continue;
    section.classList.toggle('hide', !info.show);
    if (!info.show) continue;
    number += 1;
    const numberEl = section.querySelector('.stage-n');
    if (numberEl) numberEl.textContent = String(number);
    section.classList.toggle('done', info.done === true);
    const current = info.done !== true && !currentTaken;
    section.classList.toggle('current', current);
    if (current) currentTaken = true;
    if (stateEl) stateEl.textContent = info.note ?? '';

    // The left rail mirrors the sections: same numbering, same states, plus the
    // sample sub-label under the data step. Rows navigate back on click.
    const name = section.querySelector('h3')?.textContent ?? '';
    const cls = info.done === true ? 'done' : current ? 'current' : 'todo';
    const sub =
      sectionId === 'f-stage-data' && state.source !== '' && info.done === true
        ? `Sample: ${state.source}`
        : '';
    railRows.push(
      `<button type="button" class="rail-item ${cls}" data-goto="${sectionId}">
         <span class="stage-n">${number}</span>
         <span><span class="rail-name">${esc(name)}</span>
           ${sub ? `<span class="rail-note">${esc(sub)}</span>` : ''}
           ${info.note ? `<span class="rail-note">${esc(info.note)}</span>` : ''}
         </span>
       </button>`,
    );
  }
  const rail = $('f-rail');
  if (rail) rail.innerHTML = railRows.join('');
};

/* ------------------------------------------------------------------ *
 * Export: the fit as files
 * ------------------------------------------------------------------ */

const downloadBlob = (name, blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/**
 * The live chart as standalone SVG markup: design-token var() references are
 * resolved to their computed values, because a detached SVG file has no page
 * stylesheet to look them up in.
 */
const chartSvgMarkup = () => {
  const svg = document.querySelector('#f-plot svg');
  if (!svg) return null;
  const rootStyle = getComputedStyle(document.documentElement);
  // Substituted values live inside double-quoted attributes, so any quotes in a
  // token (font stacks) must flip to single quotes or the markup breaks.
  let markup = svg.outerHTML.replace(
    /var\((--[a-z0-9-]+)\)/g,
    (all, name) =>
      (rootStyle.getPropertyValue(name).trim() || '#1b1b1f').replace(/"/g, "'"),
  );
  if (!markup.includes('xmlns=')) {
    markup = markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  }
  return markup;
};

/** The chart rasterized at 3x for slides and SI figures. */
const chartPngBlob = (markup) =>
  new Promise((resolve) => {
    const svg = document.querySelector('#f-plot svg');
    const viewBox = (svg?.getAttribute('viewBox') ?? '0 0 720 330').split(/\s+/).map(Number);
    const scale = 3;
    const img = new Image();
    img.onload = () => {
      const cnv = document.createElement('canvas');
      cnv.width = Math.round((viewBox[2] ?? 720) * scale);
      cnv.height = Math.round((viewBox[3] ?? 330) * scale);
      const ctx = cnv.getContext('2d');
      ctx.fillStyle =
        getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff';
      ctx.fillRect(0, 0, cnv.width, cnv.height);
      ctx.drawImage(img, 0, 0, cnv.width, cnv.height);
      cnv.toBlob((blob) => resolve(blob), 'image/png');
    };
    img.onerror = () => resolve(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });

/** Unicode unit strings as plain ASCII for spreadsheet safety: min^-1, M^-1 min^-1. */
const SUPERSCRIPTS = '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079';
const asciiUnits = (units) =>
  units
    .replace(/\u207B/g, '^-')
    .replace(new RegExp(`[${SUPERSCRIPTS}]`, 'g'), (ch) => String(SUPERSCRIPTS.indexOf(ch)))
    .replace(/\u00B7/g, ' ');

/** The on-screen numbers as a sectioned CSV, display and full names both. */
const exportCsvText = () => {
  const parsedInput = parseInput($('f-data')?.value ?? '');
  const network = parsedInput.runs.filter((r) => r.kind === 'network');
  const single = parsedInput.runs.filter((r) => r.kind === 'single');
  const timeUnits = { conc: 'M', time: state.unit };

  if (network.length > 0 && fitCache.network !== null) {
    const fit = fitCache.network;
    const columns = orderedColumns(network);
    const times = network.flatMap((b) => b.times);
    const colDefs = columns.map((name) => ({
      name,
      display: disp(name),
      values: network.flatMap((b) => b.series[name] ?? b.times.map(() => NaN)),
    }));
    const constants = [];
    for (const step of fit.steps) {
      const cats = step.catalysts ?? [];
      const pair = `k ${disp(step.from)} -> ${disp(step.to)}`;
      const full =
        disp(step.from) !== step.from || disp(step.to) !== step.to
          ? ` (${step.from} -> ${step.to})`
          : '';
      if (cats.length === 0) {
        constants.push({
          label: `${pair}${full}`,
          value: step.k,
          units: rateConstantUnits(step.molecularity ?? 1, timeUnits),
        });
      } else {
        constants.push({
          label: `${pair.replace('k ', 'k_obs ')}${full}`,
          value: step.k,
          units: rateConstantUnits(1, timeUnits),
        });
        const concs = cats.map((c) => catalystMolar(c));
        const kTrue = concs.every((c) => c !== null) ? trueRateConstant(step.k, concs) : null;
        if (kTrue !== null) {
          constants.push({
            label: `${pair}${full}`,
            value: kTrue,
            units: rateConstantUnits(step.molecularity ?? 1, timeUnits),
          });
        }
      }
    }
    const fittedNames = new Set(fit.scheme.species);
    const nPts = colDefs
      .filter((c) => fittedNames.has(c.name))
      .reduce((a, c) => a + c.values.filter(Number.isFinite).length, 0);
    constants.push({ label: 'R squared', value: fit.r2, units: '' });
    constants.push({ label: 'SSE', value: fit.sse, units: 'signal^2' });
    constants.push({
      label: 'RMSE',
      value: Math.sqrt(fit.sse / Math.max(1, nPts)),
      units: 'signal units',
    });
    constants.push({ label: 'points', value: nPts, units: '' });
    const curveSeries = Object.fromEntries(
      Object.entries(fit.curve.series).map(([name, values]) => [
        disp(name) === name ? name : `${disp(name)} = ${name}`,
        values,
      ]),
    );
    return fitDataCsv({
      timeUnit: state.unit,
      times,
      columns: colDefs,
      curve: { t: fit.curve.t, series: curveSeries },
      constants: constants.map((c) => ({ ...c, units: asciiUnits(c.units) })),
      meta: [
        `exported ${new Date().toISOString().slice(0, 10)}`,
        ...($('f-scheme')?.value ?? '')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => `mechanism: ${line.trim()}`),
      ],
    });
  }

  if (single.length > 0 && fitCache.single !== null) {
    const { res } = fitCache.single;
    const pooled = single.flatMap((b) => b.points);
    return fitDataCsv({
      timeUnit: state.unit,
      times: pooled.map((point) => point.t),
      columns: [
        { name: 'conversion (%)', display: 'conversion (%)', values: pooled.map((p) => p.X * 100) },
      ],
      curve: { t: [...res.curve.t], series: { 'conversion (%)': res.curve.X.map((x) => x * 100) } },
      constants: [
        { label: 'order n', value: res.resolved.params.n, units: '' },
      ],
    });
  }
  return null;
};

const exportFit = async (kind) => {
  const markup = chartSvgMarkup();
  const csv = exportCsvText();
  const enc = (text) => new TextEncoder().encode(text);
  if (kind === 'graph' && markup !== null) {
    downloadBlob('fit-graph.svg', new Blob([markup], { type: 'image/svg+xml' }));
    const png = await chartPngBlob(markup);
    if (png) downloadBlob('fit-graph.png', png);
    return;
  }
  if (kind === 'data' && csv !== null) {
    downloadBlob('fit-data.csv', new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    return;
  }
  if (kind === 'both' && markup !== null && csv !== null) {
    const png = await chartPngBlob(markup);
    const entries = [
      { name: 'fit-data.csv', data: enc(csv) },
      { name: 'fit-graph.svg', data: enc(markup) },
    ];
    if (png) entries.push({ name: 'fit-graph.png', data: new Uint8Array(await png.arrayBuffer()) });
    const zip = buildZip(entries);
    downloadBlob('fit-export.zip', new Blob([zip], { type: 'application/zip' }));
  }
};

const showExampleDetail = (title, example) => {
  const box = $('f-callout');
  if (!box) return;
  const schemeLine = example.scheme
    .split('\n')
    .map((line) =>
      esc(line)
        .replace(/\s*(&lt;-&gt;|&lt;=&gt;|=)\s*/g, ' \u21CC ')
        .replace(/\s*-&gt;\s*/g, ' \u2192 '),
    )
    .join(' &nbsp;&middot;&nbsp; ');
  $('f-callout-text').innerHTML =
    `<span class="card-art">${miniScheme(example.scheme)}</span>` +
    `<div><b>${esc(title)}</b><br>${esc(example.callout)}<br>` +
    `<code>${schemeLine}</code></div>`;
  box.classList.remove('hide');
};

const showCallout = (text) => {
  const box = $('f-callout');
  if (!box) return;
  $('f-callout-text').textContent = text;
  box.classList.remove('hide');
  for (const id of ['f-data-field', 'f-stage-scheme']) {
    const el = $(id);
    el?.classList.remove('revealed');
    void el?.offsetWidth;
    el?.classList.add('revealed');
  }
};

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

const render = () => {
  try {
    renderUnsafe();
  } catch (error) {
    const box = $('f-err');
    if (box) box.textContent = `Could not fit this input: ${error?.message ?? error}`;
  }
};

const renderUnsafe = () => {
  const parsed = parseInput($('f-data')?.value ?? '');
  // Unit inference first: the status line and charts below all print the unit.
  const timeHeading = parsed.header?.[0] ?? null;
  if (timeHeading !== lastTimeHeading) {
    lastTimeHeading = timeHeading;
    const inferred = timeHeading === null ? null : unitFromHeader(timeHeading);
    if (inferred !== null && inferred !== state.unit) {
      state.unit = inferred;
      if ($('f-unit')) $('f-unit').value = inferred;
    }
  }
  setStatus(parsed);
  canvas.lastFit = null;
  canvas.lastR2 = null;
  canvas.lastRuns = 0;

  const network = parsed.runs.filter((r) => r.kind === 'network');
  const single = parsed.runs.filter((r) => r.kind === 'single');
  const hasData = parsed.runs.length > 0;

  // Mass-balance columns are bookkeeping, not species: no node, no fit, but their
  // points stay on the chart. Auto-detection by name and by numbers; a per-column
  // override in the notice below wins in either direction.
  const allDataNames = [...new Set(network.flatMap((r) => Object.keys(r.series)))];
  const autoBalance =
    network.length > 0 ? new Set(detectMassBalance(network[0].series)) : new Set();
  const isBalance = (name) => state.balance[name] ?? autoBalance.has(name);
  balanceSet = new Set(allDataNames.filter(isBalance));
  canvas.dataNames = allDataNames.filter((name) => !balanceSet.has(name));
  const schemeSpecies = parsedScheme()?.species ?? [];
  displayMap = buildDisplayMap(
    speciesOrder(allDataNames, schemeSpecies, canvas.extras),
  );

  // The examples are the empty state: full cards until data arrives, a chip strip
  // while an example is loaded, and a collapsed (manually expandable) section the
  // moment the user's own data replaces it.
  const userOwnData = hasData && state.exampleLoaded === null;
  const examplesOpen = state.examplesOpen ?? !userOwnData;
  $('f-gallery')?.classList.toggle('compact', hasData);
  $('f-gallery')?.classList.toggle('hide', !examplesOpen);
  const startersLabel = $('f-starters-label');
  if (startersLabel) {
    startersLabel.textContent = !hasData
      ? 'No data handy? Start from an example:'
      : userOwnData
        ? `Examples ${examplesOpen ? '\u25BE' : '\u25B8'}`
        : 'Examples';
    startersLabel.setAttribute('aria-expanded', String(examplesOpen));
  }

  // The detected-columns notice: what the parser saw, spelled out, with the
  // mass-balance state of every column one click away from being corrected.
  const colNote = $('f-columns');
  if (colNote) {
    if (parsed.header !== null && network.length > 0 && parsed.errors.length === 0) {
      const chips = allDataNames
        .map((name) => {
          const bal = balanceSet.has(name);
          const label = disp(name) === name ? esc(name) : `${esc(disp(name))} = ${esc(name)}`;
          return `<button type="button" class="colchip${bal ? ' bal' : ''}" data-col="${esc(name)}"
             title="${bal
               ? 'Detected as mass balance: plotted but not fitted. Click to fit it as a species.'
               : 'Click to mark as mass balance: plotted but not fitted.'}">${label}${
               bal ? ' \u00b7 mass balance' : ''
             }</button>`;
        })
        .join('');
      colNote.innerHTML =
        `<span class="colhead">Detected columns:</span>` +
        `<span class="colchip time">${esc(parsed.header[0] ?? 'time')} \u00b7 time</span>` +
        chips +
        (balanceSet.size > 0
          ? `<span class="colbal">${esc([...balanceSet].join(', '))} plotted but not fitted. ` +
            `Click a column to change this.</span>`
          : '');
      colNote.classList.remove('hide');
    } else {
      colNote.classList.add('hide');
    }
  }

  const dataReady = parsed.errors.length === 0 && parsed.stats !== null && parsed.stats.points >= 3;
  const mixed = network.length > 0 && single.length > 0;

  if (mixed) {
    $('f-err').textContent =
      'Mixed runs: every replicate must have the same columns. Give each run the same header.';
    $('f-plot').innerHTML = pointsOnlyChart(network);
    $('f-body').innerHTML = '';
  } else if (!hasData) {
    $('f-err').textContent = '';
    $('f-plot').innerHTML = '';
    $('f-body').innerHTML = '';
  }

  let fitted = false;
  let schemeReady = false;
  if (!mixed && hasData) {
    if (network.length > 0) {
      schemeReady = ($('f-scheme')?.value ?? '').trim() !== '';
      if (dataReady) {
        fitted = renderNetwork(network);
      } else {
        $('f-err').textContent = '';
        $('f-plot').innerHTML = pointsOnlyChart(network);
        $('f-body').innerHTML = '';
      }
    } else {
      schemeReady = true; // the order-fit mode carries its scheme implicitly
      if (dataReady) {
        fitted = renderSingle(single);
      } else {
        $('f-err').textContent = '';
        $('f-plot').innerHTML = pointsOnlyChart(single.map(singleAsNetwork));
        $('f-body').innerHTML = '';
      }
    }
  }

  const species = canvas.dataNames.length;
  const drawn = parsedScheme();
  const schemeNote = $('f-scheme-status');
  if (schemeNote) {
    const text = ($('f-scheme')?.value ?? '').trim();
    if (text === '') {
      schemeNote.textContent = '';
      schemeNote.className = 'parse-note';
    } else if (drawn === null) {
      schemeNote.textContent = `\u2717 ${parseScheme(text).error}`;
      schemeNote.className = 'parse-note bad';
    } else {
      const stepWord = drawn.steps.length === 1 ? 'step' : 'steps';
      schemeNote.textContent =
        `\u2713 ${drawn.steps.length} ${stepWord}` +
        (drawn.catalysts.length ? ` \u00b7 catalyst: ${drawn.catalysts.join(', ')}` : '');
      schemeNote.className = 'parse-note ok';
    }
  }
  const cats = renderConditions(drawn) ?? [];
  const condReady =
    cats.length === 0 || cats.every((name) => catalystMolar(name) !== null);
  const wiredAll =
    drawn !== null && canvas.dataNames.every((name) => drawn.species.includes(name));
  const connections = drawn === null ? 0 : pairEdges(drawn.steps).length;
  const dataNote = !hasData
    ? ''
    : `${parsed.stats.points} points${species > 0 ? `, ${species} species` : ''}`;

  setStages({
    data: { show: true, done: dataReady, note: dataNote },
    scheme: {
      show: network.length > 0 && !mixed,
      done: wiredAll && connections > 0,
      note: connections > 0 ? `${connections} connection${connections === 1 ? '' : 's'}` : '',
    },
    cond: {
      show: cats.length > 0 && !mixed,
      done: condReady,
      note: cats
        .map((name) => {
          const molar = catalystMolar(name);
          return molar === null ? `${name}: ?` : `[${name}] ${fmtConc(molar)}`;
        })
        .join(' · '),
    },
    fit: {
      show: dataReady && !mixed,
      done: fitted,
      note:
        fitted && canvas.lastR2 !== null && Number.isFinite(canvas.lastR2)
          ? `R\u00b2 ${canvas.lastR2.toFixed(4)} \u00b7 ${canvas.lastRuns} run${
              canvas.lastRuns === 1 ? '' : 's'
            }`
          : '',
    },
  });
  drawCanvas();
};

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export const mountFit = () => {
  const rerender = debounce(render, 200);
  const clearActiveExample = () => {
    for (const b of document.querySelectorAll('#f-gallery button')) b.classList.remove('active');
    $('f-callout')?.classList.add('hide');
    state.exampleLoaded = null;
  };
  // A user file replaces example state wholesale: the example's mechanism must not
  // linger as ghost nodes over the user's own columns.
  const dropExampleScheme = () => {
    if (state.exampleLoaded !== null && $('f-scheme')) {
      $('f-scheme').value = '';
      fitCache.key = '';
    }
    state.balance = {};
    state.examplesOpen = null;
    clearActiveExample();
  };
  $('f-data')?.addEventListener('input', () => {
    state.source = 'pasted data';
    clearActiveExample();
    rerender();
  });
  $('f-scheme')?.addEventListener('input', rerender);

  // Clicking a parse error selects the offending line in the box.
  $('f-status-text')?.addEventListener('click', () => {
    if (!firstError) return;
    const box = $('f-data');
    const lines = box.value.split('\n');
    const start = lines.slice(0, firstError.line - 1).reduce((a, l) => a + l.length + 1, 0);
    box.focus();
    box.setSelectionRange(start, start + (lines[firstError.line - 1]?.length ?? 0));
  });

  // One template for every card: art slot, title, description, in that order. The
  // seed card's art is a single point, which is what it contributes.
  const pointArt = () =>
    `<svg viewBox="0 0 26 26" width="39" height="39" aria-hidden="true"><circle cx="13" cy="13" r="7" fill="${COLOURS[0]}"/>
       <text x="13" y="16.5" text-anchor="middle" font-size="9" font-weight="700" fill="#fff"
         font-family="var(--sans)">1</text></svg>`;
  for (const chip of document.querySelectorAll('#f-gallery button')) {
    const title = chip.querySelector('b')?.textContent ?? '';
    const desc = chip.querySelector('span')?.textContent ?? '';
    const preview = GALLERY[chip.dataset.example];
    const art = preview ? miniScheme(preview.scheme) : pointArt();
    chip.innerHTML =
      `<span class="card-art">${art}</span><b>${esc(title)}</b>` +
      `<span class="card-desc">${esc(desc)}</span>`;
  }
  const markActive = (button) => {
    for (const other of document.querySelectorAll('#f-gallery button'))
      other.classList.toggle('active', other === button);
  };
  const loadExample = (key) => {
    const example = GALLERY[key];
    if (!example) return;
    const hasUserData =
      ($('f-data')?.value ?? '').trim() !== '' && state.exampleLoaded === null;
    if (
      hasUserData &&
      !window.confirm(`Replace your data with example ${key}? Your own data will be discarded.`)
    ) {
      return;
    }
    state.exampleLoaded = key;
    state.balance = {};
    state.examplesOpen = null;
    $('f-data').value = example.data;
    if ($('f-scheme')) $('f-scheme').value = example.scheme;
    state.unit = 'h';
    if ($('f-unit')) $('f-unit').value = 'h';
    state.source = `Example ${key}`;
    const chip = document.querySelector(`#f-gallery button[data-example="${key}"]`);
    markActive(chip);
    const title = chip?.querySelector('b')?.textContent ?? key;
    showExampleDetail(title, example);
    render();
  };
  for (const chip of document.querySelectorAll('#f-gallery button[data-example]')) {
    chip.addEventListener('click', () => loadExample(chip.dataset.example));
  }
  $('f-callout-close')?.addEventListener('click', () => $('f-callout')?.classList.add('hide'));

  // The bridge from Estimate: their one point becomes the first row of a trace.
  $('f-seed')?.addEventListener('click', () => {
    for (const b of document.querySelectorAll('#f-gallery button')) b.classList.remove('active');
    const point = currentPoint();
    $('f-data').value = `# time (${point.unit}), conversion %\n${point.t}, ${point.X}\n`;
    if ($('f-scheme')) $('f-scheme').value = '';
    state.unit = ['s', 'min', 'h'].includes(point.unit) ? point.unit : 'h';
    if ($('f-unit')) $('f-unit').value = state.unit;
    showCallout(
      'Your Estimate point is row one. Add your remaining time points below it.',
    );
    $('f-data').focus();
    render();
  });

  for (const chip of document.querySelectorAll('#f-presets button[data-scheme]')) {
    chip.addEventListener('click', () => {
      $('f-scheme').value = chip.dataset.scheme.replace(/\\n/g, '\n');
      render();
    });
  }

  $('f-body')?.addEventListener('click', (ev) => {
    if (ev.target.closest('#f-fit-btn')) runFit();
    const exportBtn = ev.target.closest('[data-export]');
    if (exportBtn) exportFit(exportBtn.dataset.export);
  });

  // Column chips toggle a column between species and mass balance.
  $('f-columns')?.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-col]');
    if (!chip) return;
    const name = chip.dataset.col;
    state.balance = { ...state.balance, [name]: !balanceSet.has(name) };
    render();
  });

  // The examples section header toggles the collapsed strip once user data owns
  // the page.
  $('f-starters-label')?.addEventListener('click', () => {
    if (!($('f-data')?.value ?? '').trim() || state.exampleLoaded !== null) return;
    state.examplesOpen = $('f-gallery')?.classList.contains('hide') ?? true;
    render();
  });

  $('f-canvas')?.addEventListener('click', canvasClick);

  // Item 7: drag-to-connect. Hover shows the + handle; dragging draws the dashed
  // preview; releasing over another node writes the step. elementFromPoint keeps
  // working under pointer capture, and the preview line is pointer-transparent so
  // it can never occlude its own target.
  const svgEl = $('f-canvas');
  const svgPointOf = (ev) => {
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    return {
      x: inv.a * ev.clientX + inv.c * ev.clientY + inv.e,
      y: inv.b * ev.clientX + inv.d * ev.clientY + inv.f,
    };
  };
  svgEl?.addEventListener('pointerover', (ev) => {
    if (canvas.drag) return;
    const name =
      ev.target.closest('[data-node]')?.dataset.node ??
      ev.target.closest('[data-handle]')?.dataset.handle ??
      null;
    if (name !== null && name !== canvas.hover) {
      canvas.hover = name;
      drawCanvas();
    }
  });
  svgEl?.addEventListener('pointerleave', () => {
    if (canvas.drag || canvas.hover === null) return;
    canvas.hover = null;
    drawCanvas();
  });
  // Pressing a node arms a drag; it becomes one only past a small threshold, so a
  // plain click still selects. The + handle stays as the visible hint (and remains
  // draggable itself), but the whole node is the real drag source.
  let pendingDrag = null;
  svgEl?.addEventListener('pointerdown', (ev) => {
    const handle = ev.target.closest('[data-handle]');
    if (handle) {
      ev.preventDefault();
      svgEl.setPointerCapture(ev.pointerId);
      const at = svgPointOf(ev);
      canvas.drag = { from: handle.dataset.handle, x: at.x, y: at.y, over: null };
      drawCanvas();
      return;
    }
    const node = ev.target.closest('[data-node]');
    if (!node) return;
    // No capture yet: capturing here would retarget the composed click to the svg
    // and break plain click-to-select. Capture starts when the drag does.
    pendingDrag = { from: node.dataset.node, x0: ev.clientX, y0: ev.clientY };
  });
  svgEl?.addEventListener('pointermove', (ev) => {
    if (
      pendingDrag &&
      Math.hypot(ev.clientX - pendingDrag.x0, ev.clientY - pendingDrag.y0) > 4
    ) {
      svgEl.setPointerCapture(ev.pointerId);
      const at = svgPointOf(ev);
      canvas.drag = { from: pendingDrag.from, x: at.x, y: at.y, over: null };
      pendingDrag = null;
      drawCanvas();
    }
    if (!canvas.drag) {
      // Clear a lingering handle once the pointer wanders far from its node.
      if (canvas.hover !== null && ev.target === svgEl) {
        canvas.hover = null;
        drawCanvas();
      }
      return;
    }
    const at = svgPointOf(ev);
    const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-node]');
    canvas.drag = { ...canvas.drag, x: at.x, y: at.y, over: under?.dataset.node ?? null };
    drawCanvas();
  });
  svgEl?.addEventListener('pointerup', () => {
    pendingDrag = null;
    if (!canvas.drag) return;
    // The click that follows a completed drag must not toggle the selection. The
    // flag clears on a zero-timeout too, because a captured drag whose press and
    // release targets differ produces no click at all, and a stale flag would
    // swallow the user's next real one.
    canvas.suppressClick = true;
    setTimeout(() => {
      canvas.suppressClick = false;
    }, 0);
    const { from, over } = canvas.drag;
    canvas.drag = null;
    canvas.hover = null;
    const parsed = parsedScheme();
    if (
      over &&
      over !== from &&
      parsed !== null &&
      !parsed.steps.some((step) => step.from === from && step.to === over)
    ) {
      setSchemeText(textFromEdges(pairEdges([...parsed.steps, { from, to: over }])));
      return;
    }
    drawCanvas();
  });
  $('f-add-species')?.addEventListener('click', addSpecies);
  $('f-guide')?.addEventListener('click', guideAction);
  $('f-pop')?.addEventListener('click', guideAction);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (canvas.selected === null && canvas.selectedEdge === null) return;
    canvas.selected = null;
    canvas.selectedEdge = null;
    canvas.popAt = null;
    drawCanvas();
  });
  document.addEventListener('pointerdown', (ev) => {
    if (canvas.selected === null && canvas.selectedEdge === null) return;
    const el = ev.target;
    if (el.closest?.('#f-pop') || el.closest?.('#f-canvas') || el.closest?.('#f-guide')) return;
    canvas.selected = null;
    canvas.selectedEdge = null;
    canvas.popAt = null;
    drawCanvas();
  });

  const condHost = $('f-cond-fields');
  condHost?.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'f-cond-s0') conditions.S0 = el.value;
    const forCat = el.dataset?.catValue;
    if (forCat && conditions.catalysts[forCat]) conditions.catalysts[forCat].value = el.value;
    render();
  });
  condHost?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-cat-mode]');
    if (!btn) return;
    const name = btn.dataset.for;
    const entry = conditions.catalysts[name];
    if (!entry) return;
    entry.mode = btn.dataset.catMode;
    conditions.signature = ''; // force a rebuild so the pressed state and placeholder follow
    render();
  });

  $('f-sample')?.addEventListener('click', () => loadExample('E1'));
  $('f-clear')?.addEventListener('click', () => {
    $('f-data').value = '';
    state.source = '';
    clearActiveExample();
    render();
    $('f-data').focus();
  });

  $('f-upload')?.addEventListener('click', () => $('f-file')?.click());
  $('f-file')?.addEventListener('change', async () => {
    const file = $('f-file').files?.[0];
    if (!file) return;
    dropExampleScheme();
    $('f-data').value = await file.text();
    state.source = file.name;
    render();
  });
  const box = $('f-data');
  box?.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    box.classList.add('dragover');
  });
  box?.addEventListener('dragleave', () => box.classList.remove('dragover'));
  box?.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    box.classList.remove('dragover');
    const file = ev.dataTransfer?.files?.[0];
    if (file) {
      dropExampleScheme();
      box.value = await file.text();
      state.source = file.name;
      render();
    }
  });

  // Rail rows navigate back to their sections.
  $('f-rail')?.addEventListener('click', (ev) => {
    const item = ev.target.closest?.('[data-goto]');
    if (!item) return;
    document.getElementById(item.dataset.goto)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('f-unit')?.addEventListener('change', () => {
    state.unit = $('f-unit').value;
    render();
  });
  $('f-label')?.addEventListener(
    'input',
    debounce(() => {
      state.label = $('f-label').value;
      render();
    }, 300),
  );

  render();
};

export { applyFittedOrder };
