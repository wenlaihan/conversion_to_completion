import { esc, reducedMotion } from './ui.js';

/**
 * The conversion curve, and everything drawn on it.
 *
 * One figure carries what used to be three screens: the live curve, a muted ghost of the
 * same reaction at its measured temperature, and the five candidate orders that all pass
 * through the measured point. They belong in one picture because they are one curve seen
 * under three questions, and splitting them across tabs forced the reader to hold the
 * shape in memory while switching context.
 *
 * Conversion is fixed to 0 to 100 so curves stay comparable as inputs move. Time
 * auto-ranges on nice numbers and animates rather than jumping, and can be switched to a
 * logarithmic axis, where a temperature change becomes a rigid sideways slide.
 */

const W = 760;
const H = 424;
const L = 62; // room for "100" plus the rotated axis title
const R = 118; // room for a swatch plus its label past the right edge of the plot
const TOP = 22;
const BOT = 330;
const SAMPLES = 170;
const TWEEN_MS = 180;

const PLOT_W = W - L - R;
const PLOT_H = BOT - TOP;

export const ORDER_COLOURS = [
  'var(--ord-0)',
  'var(--ord-1)',
  'var(--ord-2)',
  'var(--ord-3)',
  'var(--ord-4)',
];

/** Colour is never the only channel telling two curves apart. */
export const ORDER_DASHES = ['1 5', '5 4', '', '9 4', '2 3'];

const y = (X) => BOT - X * PLOT_H;

/* ------------------------------------------------------------------ *
 * Axis
 * ------------------------------------------------------------------ */

/** Ticks on 1, 2, 2.5 or 5 times a power of ten, so labels read as round numbers. */
const niceTicks = (max, target = 6) => {
  if (!(max > 0)) return { ticks: [0, 1], max: 1 };
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { ticks, max: top };
};

const decadeTicks = (lo, hi) => {
  const ticks = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e += 1) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo && v <= hi) ticks.push(v);
    }
  }
  return ticks;
};

/**
 * The time axis, in whichever of its two forms is showing.
 *
 * The logarithmic form is not a display preference. Because every time on the curve is
 * proportional to 1/k, a temperature change slides the whole curve sideways by exactly
 * log10(k2/k1) decades and changes nothing else about it. That is visible on a log axis
 * and invisible on a linear one.
 */
export const timeScale = ({ tMax, log }) => {
  if (log) {
    const hi = tMax * 1.6;
    const lo = Math.max(hi / 3000, 1e-9);
    const span = Math.log10(hi) - Math.log10(lo);
    return {
      log: true,
      lo,
      hi,
      ticks: decadeTicks(lo, hi),
      toPx: (t) => L + ((Math.log10(Math.max(t, lo)) - Math.log10(lo)) / span) * PLOT_W,
      fromPx: (px) => 10 ** (Math.log10(lo) + ((px - L) / PLOT_W) * span),
    };
  }
  const { ticks, max } = niceTicks(tMax);
  return {
    log: false,
    lo: 0,
    hi: max,
    ticks,
    toPx: (t) => L + (t / max) * PLOT_W,
    fromPx: (px) => ((px - L) / PLOT_W) * max,
  };
};

/* ------------------------------------------------------------------ *
 * Sampling
 * ------------------------------------------------------------------ */

/**
 * One point per plot column, so the curve is smooth wherever the axis is dense.
 *
 * Sampling in the axis's own coordinate rather than in time or in conversion means the
 * logarithmic view puts its resolution near the origin, where the curve is turning,
 * instead of spending every sample in the flat tail.
 */
export const sampleSeries = (scale, conversionAt, stopAt = null) => {
  const points = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    const px = L + (i / SAMPLES) * PLOT_W;
    const t = scale.fromPx(px);
    if (t < 0) continue;
    // At n < 1 the reaction genuinely finishes, so the curve stops there rather than
    // running along the ceiling and implying that later times still mean something.
    if (stopAt !== null && t > stopAt) break;
    points.push([px, y(conversionAt(t))]);
  }
  if (stopAt !== null && stopAt <= scale.hi) points.push([scale.toPx(stopAt), y(1)]);
  return points;
};

const pathOf = (points) =>
  points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(2)} ${py.toFixed(2)}`).join('');

/* ------------------------------------------------------------------ *
 * Annotations
 * ------------------------------------------------------------------ */

/**
 * Percentile labels, dropped rather than stacked when they will not fit.
 *
 * Priority runs 90, 50, 99, 75, 25: the headline conversion first, then the one people
 * reason with, then the tail. Anything that would overlap something already placed is
 * dropped, because two overlapping labels are worse than one label.
 */
const KEEP_ORDER = [0.9, 0.5, 0.99, 0.75, 0.25];

const CHAR_W = 6.7;
const LINE_H = 15;

/** Approximate ink box of a label centred on a point. */
export const labelBox = (cx, cy, text, height = LINE_H) => {
  const half = (String(text).length * CHAR_W) / 2 + 4;
  return { x0: cx - half, x1: cx + half, y0: cy - height / 2, y1: cy + height / 2, cx, cy };
};

const hits = (a, b, pad = 2) =>
  a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

/**
 * The boxes a label may never be placed on top of.
 *
 * Axis furniture is not negotiable: a tick label that moves is a lie about where the
 * gridline is, so everything else gives way to it. The condition badge is included
 * because it is pinned to a corner by design rather than placed by this pass.
 */
const axisFurniture = (scale, badgeBoxRect, asymptote) => {
  const reserved = [
    // The rotated axis title, in the screen box it actually occupies.
    { x0: 6, x1: 30, y0: TOP, y1: BOT },
    // The x axis title strip.
    { x0: L, x1: L + PLOT_W, y0: BOT + 40, y1: BOT + 62 },
  ];
  for (const pct of [0, 25, 50, 75, 100]) {
    reserved.push(labelBox(L - 22, y(pct / 100), '100', 16));
  }
  for (const t of scale.ticks) {
    reserved.push(labelBox(scale.toPx(t), BOT + 20, '0000', 16));
  }
  if (badgeBoxRect) reserved.push(badgeBoxRect);
  // The ceiling tag sits in the headroom above the plot, which is exactly where a label
  // for a 99% dot wants to go, so it has to be on the list rather than assumed empty.
  if (asymptote) reserved.push({ x0: L + PLOT_W - 84, x1: L + PLOT_W + 2, y0: TOP - 16, y1: TOP - 1 });
  return reserved;
};

/**
 * Places each annotation at the first candidate position that is free.
 *
 * Above the dot is the natural home, but near the top of the plot it collides with the
 * 100 gridline label and near the left edge it runs into the conversion axis, so the
 * label tries below, then to either side, before giving up its slot to a higher priority
 * neighbour.
 */
export const placeAnnotations = (candidates, reserved = []) => {
  /**
   * Two passes when one is not enough.
   *
   * A long label can place successfully and only then starve a later, higher-stakes
   * mark such as the completion point, which is forced onto whatever it collides with.
   * If the first pass forced anything, the layout runs again with every shortened
   * alternative preferred from the start; the run in which nothing is forced wins.
   */
  const run = (preferAlt) => {
    const placed = [];
    const taken = [...reserved];
    let forced = 0;

    const attempt = (mark) => {
      const labels = preferAlt
        ? [mark.alt ?? mark.label]
        : [mark.label, mark.alt].filter(Boolean);
      for (const label of labels) {
        const half = (label.length * CHAR_W) / 2 + 4;
        const minX = L + half + 4;
        const maxX = L + PLOT_W - half - 4;
        const cx = Math.min(Math.max(mark.px, minX), maxX);
        const options = [
          [cx, mark.py - 15],
          [cx, mark.py + 19],
          [cx, mark.py - 32],
          [cx + half + 12, mark.py - 2],
          [cx - half - 12, mark.py - 2],
          // Deeper drops for the crowded top strip: when a heated curve finishes inside
          // the plot, its name, the ghost's name and three annotations all want the same
          // corner, and the only remaining air is further down. The leader line keeps
          // the label tied to its dot.
          [cx, mark.py + 38],
          [cx, mark.py + 57],
        ];
        for (const [x, yAt] of options) {
          const box = labelBox(x, yAt, label);
          if (box.y0 < 3 || box.y1 > BOT - 2) continue;
          if (taken.some((r) => hits(box, r))) continue;
          taken.push(box);
          return { ...box, y: yAt, text: label, mark };
        }
      }
      return null;
    };

    for (const level of KEEP_ORDER) {
      const mark = candidates.find((c) => c.X === level);
      if (!mark) continue;
      const spot = attempt(mark);
      if (spot) placed.push(spot);
    }
    // Anything not a standard percentile, such as the completion point at n < 1, is the
    // answer rather than a gridline, so it lands even if it has to be forced in.
    for (const mark of candidates.filter((c) => !KEEP_ORDER.includes(c.X))) {
      const spot = attempt(mark);
      if (!spot) forced += 1;
      placed.push(
        spot ?? { ...labelBox(mark.px, mark.py - 15, mark.label), y: mark.py - 15, text: mark.label, mark },
      );
    }
    return { placed, taken, forced };
  };

  const first = run(false);
  if (first.forced === 0) return first;
  const second = run(true);
  return second.forced < first.forced ? second : first;
};

const fmtTick = (t, scale) => {
  if (t === 0) return '0';
  if (scale.log) return String(Number(t.toPrecision(t >= 1 ? 3 : 2)));
  const abs = Math.abs(t);
  if (abs >= 1000) return String(Math.round(t));
  if (abs >= 10) return String(Number(t.toFixed(1)));
  return String(Number(t.toPrecision(3)));
};

/* ------------------------------------------------------------------ *
 * The figure
 * ------------------------------------------------------------------ */

/**
 * @param {SVGElement} svg
 * @param {object} opts
 *   series      {points, colour, dash, label, emphasis, faint} drawn back to front
 *   scale       from timeScale()
 *   annotations {X, px, py, label}
 *   badge       {k, v} rows shown in the plot corner
 *   measured    {t, X}, the reader's own point
 *   timeUnit    label for the x axis title
 *   footnote    one line under the plot, or null
 */
export const drawCurve = (svg, opts) => {
  const { series, scale, annotations, badge, measured, timeUnit, asymptote } = opts;

  const grid = scale.ticks
    .map((t) => {
      const px = scale.toPx(t).toFixed(1);
      return `<line x1="${px}" y1="${TOP}" x2="${px}" y2="${BOT}" stroke="var(--hairline)" stroke-width="1"/>`;
    })
    .join('');

  const rows = [0, 25, 50, 75, 100]
    .map((pct) => {
      const py = y(pct / 100).toFixed(1);
      const ceiling = pct === 100 && asymptote;
      return (
        `<line x1="${L}" y1="${py}" x2="${L + PLOT_W}" y2="${py}" ` +
        `stroke="${ceiling ? 'var(--outline)' : 'var(--hairline)'}" stroke-width="1"` +
        `${ceiling ? ' stroke-dasharray="5 4"' : ''}/>` +
        `<text x="${L - 10}" y="${(Number(py) + 4).toFixed(1)}" text-anchor="end" font-size="13" ` +
        `fill="var(--on-variant)" font-family="var(--math)">${pct}</text>`
      );
    })
    .join('');

  const xLabels = scale.ticks
    .map(
      (t) =>
        `<text x="${scale.toPx(t).toFixed(1)}" y="${BOT + 24}" text-anchor="middle" font-size="13" ` +
        `fill="var(--on-variant)" font-family="var(--math)">${esc(fmtTick(t, scale))}</text>`,
    )
    .join('');

  const titles =
    `<text x="${L + PLOT_W / 2}" y="${BOT + 54}" text-anchor="middle" font-size="15" ` +
    `fill="var(--on-surface)" font-family="var(--sans)">Time (${esc(timeUnit)}${scale.log ? ', log scale' : ''})</text>` +
    `<text transform="rotate(-90 18 ${TOP + PLOT_H / 2})" x="18" y="${TOP + PLOT_H / 2}" ` +
    `text-anchor="middle" font-size="15" fill="var(--on-surface)" font-family="var(--sans)">Conversion (%)</text>`;

  const paths = series
    .map(
      (s, i) =>
        `<path data-series="${i}" d="${pathOf(s.points)}" fill="none" stroke="${s.colour}" ` +
        `stroke-width="${s.emphasis ? 2.5 : 1.6}" stroke-linecap="round" stroke-linejoin="round" ` +
        `${s.dash ? `stroke-dasharray="${s.dash}"` : ''} opacity="${s.emphasis ? 1 : (s.faint ?? 0.55)}"/>`,
    )
    .join('');

  // Several curves converge near 100%, so their end labels would sit on top of one
  // another. Spread them vertically in the order they arrive, keeping each beside its own
  // line rather than dropping any: a curve with no label is a curve with no identity.
  // The badge is pinned to a corner by design, so it is computed first and handed to the
  // placement pass as something to route around rather than something to negotiate with.
  const badgeW = 176;
  const badgeH = badge.length * 15 + 12;
  const badgeX = L + PLOT_W - badgeW - 6;
  const badgeY = BOT - badgeH - 8;
  const badgeRect = { x0: badgeX, x1: badgeX + badgeW, y0: badgeY, y1: badgeY + badgeH };
  const badgeBox =
    `<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="4" ` +
    `fill="var(--lowest)" opacity="0.92" stroke="var(--hairline)" stroke-width="1"/>`;
  const badgeRows = badge
    .map(
      (row, i) =>
        `<text x="${badgeX + 10}" y="${badgeY + 17 + i * 15}" font-size="12" ` +
        `font-family="var(--math)" fill="var(--on-variant)">${esc(row)}</text>`,
    )
    .join('');

  /**
   * Everything that carries text is placed against one shared occupancy list, in falling
   * order of how much it costs to move: axis furniture cannot move at all, an annotation
   * can shift around its dot, a curve's own name can slide down the right margin, and the
   * reader's point can flip to whichever side is free.
   */
  const taken = axisFurniture(scale, badgeRect, asymptote);

  /**
   * Curve names go down before annotations do.
   *
   * A curve's name is anchored to its own geometry: it belongs at the end of its line and
   * has nowhere else meaningful to be. An annotation label is free to move around its
   * dot, and the placement pass below gives it five ways to do so. Placing the immovable
   * thing first is what stops a name being marched halfway down the plot, dragging a
   * connector that reads as the curve itself plunging.
   *
   * Each name wears its own colour and dash, so the right margin is a key rather than a
   * column of anonymous grey words, and the dash carries the pairing for anyone who
   * cannot separate the hues.
   */
  const ends = series
    .filter((s) => s.label && s.points.length > 0)
    .map((s) => ({ s, x: s.points[s.points.length - 1][0], y: s.points[s.points.length - 1][1] }))
    .sort((a, b) => a.y - b.y);

  let lastY = -Infinity;
  for (const end of ends) {
    const centre = end.x + 26 + end.s.label.length * 3;
    const free = (yAt) =>
      yAt >= TOP + 6 && yAt <= BOT - 6 && !taken.some((r) => hits(labelBox(centre, yAt, end.s.label), r));

    if (end.x >= L + PLOT_W - 4) {
      // Ends at the right margin: this is the legend column, so stack down it.
      let yAt = Math.max(end.y, lastY + LINE_H + 1);
      for (let step = 0; step < 12 && !free(yAt); step += 1) yAt += LINE_H;
      end.labelY = Math.min(yAt, BOT - 6);
      lastY = end.labelY;
    } else {
      // Ends inside the plot, where a curve that finishes stops. Stay near the line end.
      end.labelY = [0, -16, 16, -30, 30, -44, 44].map((dy) => end.y + dy).find(free) ?? end.y;
    }
    taken.push(labelBox(centre, end.labelY, end.s.label));
  }

  const directLabels = ends
    .map(({ s, x, y: endY, labelY }) => {
      const nudged = Math.abs(labelY - endY) > 1.5;
      const connector = nudged
        ? `<path d="M${(x + 1).toFixed(1)} ${endY.toFixed(1)} L${(x + 5).toFixed(1)} ${labelY.toFixed(1)}" ` +
          `fill="none" stroke="var(--outline-variant)" stroke-width="1" stroke-dasharray="1 2"/>`
        : '';
      const swatch =
        `<line x1="${(x + 7).toFixed(1)}" y1="${labelY.toFixed(1)}" x2="${(x + 21).toFixed(1)}" ` +
        `y2="${labelY.toFixed(1)}" stroke="${s.colour}" stroke-width="${s.emphasis ? 2.5 : 1.6}" ` +
        `${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linecap="round"/>`;
      return (
        connector +
        swatch +
        `<text x="${(x + 26).toFixed(1)}" y="${(labelY + 4).toFixed(1)}" font-size="12" ` +
        `fill="${s.emphasis ? 'var(--primary)' : s.colour}" ` +
        `font-weight="${s.emphasis ? 600 : 500}" font-family="var(--sans)">${esc(s.label)}</text>`
      );
    })
    .join('');

  // The pass hands back everything it occupied; "your point" below must dodge the
  // annotation labels too, not only what stood before them.
  const { placed: annotationSlots, taken: occupied } = placeAnnotations(annotations, taken);

  const annotationMarks = annotationSlots
    .map(({ mark, cx, y: labelY, text: slotText = mark.label }) => {
      // The dot stays on the curve wherever the label went, so the leader runs from the
      // label back to the point it describes rather than the two drifting apart.
      const offset = Math.abs(cx - mark.px) > 1 || Math.abs(labelY - (mark.py - 15)) > 1;
      const leader = offset
        ? `<path d="M${cx.toFixed(1)} ${(labelY + 6).toFixed(1)} L${mark.px.toFixed(1)} ${mark.py.toFixed(1)}" ` +
          `fill="none" stroke="var(--outline-variant)" stroke-width="1"/>`
        : '';
      return (
        `<line x1="${mark.px.toFixed(1)}" y1="${mark.py.toFixed(1)}" x2="${mark.px.toFixed(1)}" y2="${BOT}" ` +
        `stroke="var(--outline-variant)" stroke-width="1" stroke-dasharray="2 3"/>` +
        leader +
        `<circle cx="${mark.px.toFixed(1)}" cy="${mark.py.toFixed(1)}" r="4.5" fill="var(--primary)" ` +
        `stroke="var(--lowest)" stroke-width="2"/>` +
        `<text x="${cx.toFixed(1)}" y="${(labelY + 4).toFixed(1)}" text-anchor="middle" font-size="12" ` +
        `font-weight="600" fill="var(--primary)" font-family="var(--sans)">${esc(slotText)}</text>`
      );
    })
    .join('');

  // "your point" sits left of its marker by preference and flips right when the marker is
  // near the conversion axis, where the tick labels live.
  let pointText = '';
  if (measured && measured.quiet) {
    // The ring alone: another mark occupies this exact spot and carries the words.
    const mx = scale.toPx(measured.t);
    const my = y(measured.X);
    pointText =
      `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="6" fill="var(--lowest)" ` +
      `stroke="var(--on-surface)" stroke-width="2.5"/>`;
  } else if (measured) {
    const mx = scale.toPx(measured.t);
    const my = y(measured.X);
    // Left of the marker by preference, then right, then under, then over: a measured
    // point can sit anywhere on the curve, including the crowded top strip where the
    // fast orders finish and carry their names.
    const spots = [
      { anchor: 'end', x: mx - 12, cx: mx - 12 - 30, dy: 0 },
      { anchor: 'start', x: mx + 12, cx: mx + 12 + 30, dy: 0 },
      { anchor: 'middle', x: mx, cx: mx, dy: -19 },
      { anchor: 'middle', x: mx, cx: mx, dy: 19 },
      { anchor: 'middle', x: mx + 24, cx: mx + 24, dy: -19 },
      { anchor: 'middle', x: mx + 24, cx: mx + 24, dy: 19 },
    ];
    // The fallback leans up and to the right: near the origin the axis ticks own
    // everything below and to the left, and near the ceiling the plot is open beneath.
    const side =
      spots.find((c) => {
        const box = labelBox(c.cx, my + c.dy, 'your point');
        return (
          box.x0 > L + 2 &&
          box.x1 < L + PLOT_W - 2 &&
          box.y0 > 3 &&
          box.y1 < BOT - 2 &&
          !occupied.some((r) => hits(box, r))
        );
      }) ?? spots[4];
    pointText =
      `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="6" fill="var(--lowest)" ` +
      `stroke="var(--on-surface)" stroke-width="2.5"/>` +
      `<text x="${side.x.toFixed(1)}" y="${(my + 4 + side.dy).toFixed(1)}" text-anchor="${side.anchor}" ` +
      `font-size="12" font-weight="600" fill="var(--on-surface)" font-family="var(--sans)">your point</text>`;
  }
  const point = pointText;

  const foot = asymptote
    ? `<text x="${L + PLOT_W}" y="${TOP - 7}" text-anchor="end" font-size="11" ` +
      `font-style="italic" fill="var(--outline)" font-family="var(--sans)">never reached</text>`
    : '';

  const crosshair =
    `<line id="xhair" x1="0" y1="${TOP}" x2="0" y2="${BOT}" stroke="var(--deep-teal)" ` +
    `stroke-width="1" opacity="0"/>`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML =
    grid +
    rows +
    xLabels +
    titles +
    paths +
    directLabels +
    annotationMarks +
    point +
    badgeBox +
    badgeRows +
    foot +
    crosshair;

  tweenTo(svg, series);
  return { W, H, L, TOP, BOT, PLOT_W, PLOT_H, y };
};

/* ------------------------------------------------------------------ *
 * Motion
 * ------------------------------------------------------------------ */

/**
 * Interpolates each path from where it was to where it now is.
 *
 * Swapping the geometry outright makes a change of inputs read as a new picture; moving
 * it makes the same picture respond, which is the whole affordance. Under reduced motion
 * the stylesheet cross-fades the figure instead and this does nothing.
 */
const tweenTo = (svg, series) => {
  const previous = svg.__series;
  svg.__series = series.map((s) => s.points);
  if (reducedMotion() || !previous || previous.length !== series.length) return;

  const nodes = [...svg.querySelectorAll('path[data-series]')];
  const from = previous;
  const to = svg.__series;
  const started = performance.now();

  cancelAnimationFrame(svg.__raf ?? 0);
  const step = (now) => {
    const p = Math.min((now - started) / TWEEN_MS, 1);
    const eased = 1 - (1 - p) ** 3;
    nodes.forEach((node, i) => {
      const a = from[i];
      const b = to[i];
      if (!a || !b || a.length < 2 || b.length < 2) return;
      // The two samplings can differ in length when the axis range changes, so both are
      // resampled onto a common parameter rather than zipped index by index.
      const count = Math.max(a.length, b.length);
      const at = (arr, j) =>
        arr[Math.min(Math.round((j / (count - 1)) * (arr.length - 1)), arr.length - 1)];
      const blended = [];
      for (let j = 0; j < count; j += 1) {
        const [ax, ay] = at(a, j);
        const [bx, by] = at(b, j);
        blended.push([ax + (bx - ax) * eased, ay + (by - ay) * eased]);
      }
      node.setAttribute('d', pathOf(blended));
    });
    if (p < 1) svg.__raf = requestAnimationFrame(step);
  };
  svg.__raf = requestAnimationFrame(step);
};

/* ------------------------------------------------------------------ *
 * Crosshair
 * ------------------------------------------------------------------ */

/** Exact readout anywhere along the curve, on hover and on touch. */
export const attachCrosshair = (svg, tip, { scale, conversionAt, fmt, onPin = null }) => {
  const hide = () => {
    tip.style.opacity = '0';
    svg.querySelector('#xhair')?.setAttribute('opacity', '0');
  };
  const move = (clientX) => {
    const box = svg.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * W;
    if (vx < L || vx > L + PLOT_W) return hide();
    const t = scale.fromPx(vx);
    const X = conversionAt(t);
    const line = svg.querySelector('#xhair');
    if (line) {
      line.setAttribute('x1', String(vx));
      line.setAttribute('x2', String(vx));
      line.setAttribute('opacity', '0.55');
    }
    tip.style.opacity = '1';
    tip.style.left = `${(vx / W) * box.width}px`;
    tip.style.top = `${(y(X) / H) * box.height}px`;
    tip.innerHTML = fmt(t, X);
    return undefined;
  };
  svg.onmousemove = (ev) => move(ev.clientX);
  svg.onmouseleave = hide;
  // A hover answers "what about here"; a click holds the answer still, so a slider can
  // be dragged while one chosen time point is watched.
  svg.onclick = (ev) => {
    if (!onPin) return;
    const box = svg.getBoundingClientRect();
    const vx = ((ev.clientX - box.left) / box.width) * W;
    if (vx < L || vx > L + PLOT_W) return;
    onPin(scale.fromPx(vx));
  };
  svg.ontouchstart = (ev) => move(ev.touches[0].clientX);
  svg.ontouchmove = (ev) => {
    ev.preventDefault();
    move(ev.touches[0].clientX);
  };
  svg.ontouchend = hide;
};

/* ------------------------------------------------------------------ *
 * Spread strip
 * ------------------------------------------------------------------ */

/**
 * Time to the headline conversion for each candidate order, on the chart's own x axis.
 *
 * The fan-out reads as a spread at a glance, which is exactly what a column of five
 * numbers never does. Sharing the axis above is what lets it carry no scale of its own.
 */
export const drawSpread = (svg, { scale, marks, title }) => {
  /**
   * Rows are assigned rather than alternated.
   *
   * Two rows are enough when the orders are evenly spread, but the axis has to stretch to
   * hold the live curve's own tail, and at high order that packs every candidate into the
   * left tenth of it. Each mark takes the lowest row where nothing is already within a
   * label width, and the strip grows to fit, so crowding costs height instead of
   * legibility.
   */
  const MIN_GAP = 48;
  const rows = [];
  const placed = marks
    .map((m) => ({ ...m, px: scale.toPx(m.t) }))
    .filter((m) => Number.isFinite(m.px))
    .sort((a, b) => a.px - b.px)
    .map((m) => {
      let row = 0;
      while ((rows[row] ?? -Infinity) > m.px - MIN_GAP) row += 1;
      rows[row] = m.px;
      return { ...m, row };
    });

  // The top name row sits at a fixed height whatever the depth, so the caption above it
  // keeps its clearance instead of being crowded as the strip grows downward.
  const depth = rows.length;
  const axisY = 36 + (depth - 1) * 15;
  const HEIGHT = axisY + 34 + (depth - 1) * 15;
  svg.setAttribute('viewBox', `0 0 ${W} ${HEIGHT}`);

  const caption =
    `<text x="${L}" y="10" font-size="11" font-weight="700" letter-spacing="0.05em" ` +
    `fill="var(--outline)" font-family="var(--sans)">${esc(title.toUpperCase())}</text>`;
  const rule =
    `<line x1="${L}" y1="${axisY}" x2="${L + PLOT_W}" y2="${axisY}" stroke="var(--outline-variant)" stroke-width="1"/>`;

  const dots = placed
    .map((m) => {
      const px = m.px.toFixed(1);
      const nameY = axisY - 13 - m.row * 15;
      const valueY = axisY + 20 + m.row * 15;
      const stem = m.row
        ? `<line x1="${px}" y1="${axisY - 8}" x2="${px}" y2="${nameY + 4}" ` +
          `stroke="var(--outline-variant)" stroke-width="1"/>` +
          `<line x1="${px}" y1="${axisY + 8}" x2="${px}" y2="${valueY - 9}" ` +
          `stroke="var(--outline-variant)" stroke-width="1"/>`
        : '';
      return (
        stem +
        `<circle cx="${px}" cy="${axisY}" r="${m.emphasis ? 6 : 4.5}" fill="${m.colour}" ` +
        `stroke="var(--lowest)" stroke-width="2"/>` +
        `<text x="${px}" y="${nameY}" text-anchor="middle" font-size="11" ` +
        `font-family="var(--sans)" font-weight="${m.emphasis ? 600 : 400}" ` +
        `fill="${m.emphasis ? 'var(--primary)' : m.colour}">${esc(m.label)}</text>` +
        `<text x="${px}" y="${valueY}" text-anchor="middle" font-size="11" ` +
        `font-family="var(--math)" fill="var(--on-variant)">${esc(m.value)}</text>`
      );
    })
    .join('');

  svg.innerHTML = caption + rule + dots;
};
