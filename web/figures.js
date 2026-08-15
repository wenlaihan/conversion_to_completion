import { esc } from './ui.js';
import {
  arrheniusRatio,
  completionTime,
  conversionAtTime,
  isReachable,
  timeToConversion,
} from '../dist/lib/kinetics.js';

/**
 * Static teaching figures for the Learn page.
 *
 * Learn was twelve hundred words with no pictures: every concept, including curve shape,
 * was taught in prose, on a product whose whole thesis is that the curve says it better.
 * Each figure here replaces a paragraph rather than joining one.
 *
 * The main chart's helpers bake in its own fixed geometry, so these figures carry a
 * small renderer of their own. Every number in them still comes from the one math
 * module; only the pixel mapping lives here.
 */

const ORD = ['#86b6ef', '#5598e7', '#2a78d6', '#184f95', '#0d366b'];
const DASH = ['1 5', '5 4', '', '9 4', '2 3'];
const ORDERS = [0, 0.5, 1, 1.5, 2];
const NAVY = '#002271';

/* ------------------------------------------------------------------ *
 * A minimal plot: curves on a quiet frame, nothing it does not need
 * ------------------------------------------------------------------ */

const frame = (W, H) => {
  const L = 34;
  const R = 74;
  const TOP = 16;
  const BOT = H - 26;
  return { W, H, L, R, TOP, BOT, PW: W - L - R, PH: BOT - TOP };
};

const mapping = (f, { xMax, logLo = null }) => ({
  x: logLo
    ? (t) =>
        f.L +
        ((Math.log10(Math.max(t, logLo)) - Math.log10(logLo)) /
          (Math.log10(xMax) - Math.log10(logLo))) *
          f.PW
    : (t) => f.L + (t / xMax) * f.PW,
  y: (X) => f.BOT - X * f.PH,
});

const path = (points) =>
  points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`).join('');

const curvePoints = (f, m, params, { xMax, logLo = null, samples = 120 }) => {
  const stop = completionTime(params);
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = logLo
      ? 10 ** (Math.log10(logLo) + (i / samples) * (Math.log10(xMax) - Math.log10(logLo)))
      : (i / samples) * xMax;
    if (isReachable(stop) && t > stop) break;
    points.push([m.x(t), m.y(conversionAtTime(t, params))]);
  }
  if (isReachable(stop) && stop <= xMax) points.push([m.x(stop), m.y(1)]);
  return points;
};

const text = (
  x,
  y,
  label,
  { size = 12, fill = 'var(--on-variant)', anchor = 'start', weight = 400 } = {},
) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="${size}" ` +
  `font-weight="${weight}" fill="${fill}" font-family="var(--sans)">${esc(label)}</text>`;

const baseline = (f, xTitle = 'time') =>
  `<line x1="${f.L}" y1="${f.BOT}" x2="${f.L + f.PW}" y2="${f.BOT}" stroke="var(--outline-variant)" stroke-width="1"/>` +
  text(f.L, f.BOT + 16, xTitle, { size: 11, fill: 'var(--outline)' }) +
  `<text transform="rotate(-90 ${f.L - 10} ${(f.TOP + f.BOT) / 2})" x="${f.L - 10}" y="${(f.TOP + f.BOT) / 2}" ` +
  `text-anchor="middle" font-size="11" fill="var(--outline)" font-family="var(--sans)">conversion</text>`;

const ceiling = (f) =>
  `<line x1="${f.L}" y1="${f.TOP}" x2="${f.L + f.PW}" y2="${f.TOP}" stroke="var(--outline)" ` +
  `stroke-width="1" stroke-dasharray="5 4"/>`;

/** Right-edge names, staggered apart, each wearing its curve's colour and dash. */
const endLabels = (ends) => {
  const sorted = [...ends].sort((a, b) => a.y - b.y);
  let last = -Infinity;
  for (const e of sorted) {
    e.ly = Math.max(e.y, last + 13);
    last = e.ly;
  }
  return sorted
    .map(
      (e) =>
        `<line x1="${(e.x + 5).toFixed(1)}" y1="${e.ly.toFixed(1)}" x2="${(e.x + 17).toFixed(1)}" y2="${e.ly.toFixed(1)}" ` +
        `stroke="${e.colour}" stroke-width="1.6" ${e.dash ? `stroke-dasharray="${e.dash}"` : ''} stroke-linecap="round"/>` +
        text(e.x + 21, e.ly + 4, e.label, { size: 11, fill: e.colour, weight: 500 }),
    )
    .join('');
};

const arrow = (x1, x2, y, label, colour = NAVY) => {
  const head = (x, dir) =>
    `<path d="M${(x + 5 * dir).toFixed(1)} ${(y - 3.5).toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)} ` +
    `L${(x + 5 * dir).toFixed(1)} ${(y + 3.5).toFixed(1)}" fill="none" stroke="${colour}" stroke-width="1.4"/>`;
  return (
    `<line x1="${x1.toFixed(1)}" y1="${y}" x2="${x2.toFixed(1)}" y2="${y}" stroke="${colour}" stroke-width="1.4"/>` +
    head(x1, 1) +
    head(x2, -1) +
    (label
      ? text((x1 + x2) / 2, y - 7, label, { anchor: 'middle', size: 11, fill: colour, weight: 600 })
      : '')
  );
};

/* ------------------------------------------------------------------ *
 * The four figures
 * ------------------------------------------------------------------ */

/** Five orders sharing one half life: low orders finish, high orders flatten. */
const figOrders = (svg) => {
  const f = frame(720, 220);
  const HALF = 20;
  const xMax = 100;
  const m = mapping(f, { xMax });

  const series = ORDERS.map((n, i) => {
    // The same half life for every order: k is whatever makes t(50%) equal HALF.
    const unit = timeToConversion(0.5, { k: 1, n, C0: 1 });
    const params = { k: unit / HALF, n, C0: 1 };
    return { n, i, params, points: curvePoints(f, m, params, { xMax }) };
  });

  const paths = series
    .map(
      (s) =>
        `<path d="${path(s.points)}" fill="none" stroke="${ORD[s.i]}" stroke-width="1.8" ` +
        `${DASH[s.i] ? `stroke-dasharray="${DASH[s.i]}"` : ''} stroke-linecap="round"/>`,
    )
    .join('');

  const zeroDone = completionTime(series[0].params);
  const done = isReachable(zeroDone)
    ? `<circle cx="${m.x(zeroDone).toFixed(1)}" cy="${f.TOP}" r="3.5" fill="${ORD[0]}"/>` +
      text(m.x(zeroDone) + 6, f.TOP + 14, 'n = 0: done at a finite time', { size: 11 })
    : '';
  const never = text(f.L + f.PW - 4, f.TOP + 30, 'n = 2: never reaches 100%', {
    size: 11,
    anchor: 'end',
  });

  svg.setAttribute('viewBox', `0 0 ${f.W} ${f.H}`);
  svg.innerHTML =
    baseline(f) +
    ceiling(f) +
    paths +
    done +
    never +
    endLabels(
      series
        // The completion annotation already names n = 0; a second label would sit on it.
        .filter((s) => s.n !== 0)
        .map((s) => ({
          x: s.points[s.points.length - 1][0],
          y: s.points[s.points.length - 1][1],
          colour: ORD[s.i],
          dash: DASH[s.i],
          label: `n=${s.n}`,
        })),
    );
};

/** First order: equal steps halve what is left, every time. */
const figHalfLife = (svg) => {
  const f = frame(560, 200);
  const HALF = 20;
  const xMax = 70;
  const m = mapping(f, { xMax });
  const params = { k: Math.LN2 / HALF, n: 1, C0: 1 };

  const marks = [1, 2, 3]
    .map((i) => {
      const X = 1 - 0.5 ** i;
      const px = m.x(HALF * i);
      return (
        `<line x1="${px.toFixed(1)}" y1="${m.y(X).toFixed(1)}" x2="${px.toFixed(1)}" y2="${f.BOT}" ` +
        `stroke="var(--outline-variant)" stroke-width="1" stroke-dasharray="2 3"/>` +
        `<circle cx="${px.toFixed(1)}" cy="${m.y(X).toFixed(1)}" r="3.5" fill="${NAVY}"/>` +
        text(px, m.y(X) - 8, `${X * 100}%`, { anchor: 'middle', size: 11, weight: 600, fill: NAVY })
      );
    })
    .join('');

  const arrows = [0, 1, 2]
    .map((i) => arrow(m.x(HALF * i) + 2, m.x(HALF * (i + 1)) - 2, f.BOT - 12, 't½'))
    .join('');

  svg.setAttribute('viewBox', `0 0 ${f.W} ${f.H}`);
  svg.innerHTML =
    baseline(f) +
    `<path d="${path(curvePoints(f, m, params, { xMax }))}" fill="none" stroke="${NAVY}" ` +
    `stroke-width="2" stroke-linecap="round"/>` +
    marks +
    arrows;
};

/** The signature insight: five orders through one measured point, then a factor of 60. */
const figFan = (svg) => {
  const f = frame(720, 240);
  const logLo = 2;
  const xMax = 6000;
  const m = mapping(f, { xMax, logLo });
  const C0 = 1.7;

  const series = ORDERS.map((n, i) => {
    const unit = timeToConversion(0.4, { k: 1, n, C0 });
    const params = { k: unit / 30, n, C0 };
    return { n, i, params, points: curvePoints(f, m, params, { xMax, logLo }) };
  });

  const paths = series
    .map(
      (s) =>
        `<path d="${path(s.points)}" fill="none" stroke="${ORD[s.i]}" stroke-width="1.8" ` +
        `${DASH[s.i] ? `stroke-dasharray="${DASH[s.i]}"` : ''} stroke-linecap="round"/>`,
    )
    .join('');

  const nineNine = m.y(0.99);
  const t99 = (n) => timeToConversion(0.99, series.find((s) => s.n === n).params);
  const cross = (n, dy) => {
    const t = t99(n);
    const colour = ORD[ORDERS.indexOf(n)];
    return (
      `<circle cx="${m.x(t).toFixed(1)}" cy="${nineNine.toFixed(1)}" r="3.5" fill="${colour}"/>` +
      text(m.x(t), nineNine + dy, `${Math.round(t)} min`, {
        anchor: 'middle',
        size: 11,
        weight: 600,
        fill: colour,
      })
    );
  };

  svg.setAttribute('viewBox', `0 0 ${f.W} ${f.H}`);
  svg.innerHTML =
    baseline(f, 'time (log scale)') +
    `<line x1="${f.L}" y1="${nineNine.toFixed(1)}" x2="${f.L + f.PW}" y2="${nineNine.toFixed(1)}" ` +
    `stroke="var(--outline)" stroke-width="1" stroke-dasharray="5 4"/>` +
    text(f.L + 4, nineNine - 6, '99%', { size: 11, fill: 'var(--outline)' }) +
    paths +
    cross(0, 16) +
    cross(2, -8) +
    `<circle cx="${m.x(30).toFixed(1)}" cy="${m.y(0.4).toFixed(1)}" r="5.5" fill="var(--lowest)" ` +
    `stroke="var(--on-surface)" stroke-width="2.2"/>` +
    text(m.x(30) - 10, m.y(0.4) + 4, 'your point', {
      anchor: 'end',
      size: 11,
      weight: 600,
      fill: 'var(--on-surface)',
    }) +
    endLabels(
      series.map((s) => ({
        x: s.points[s.points.length - 1][0],
        y: s.points[s.points.length - 1][1],
        colour: ORD[s.i],
        dash: DASH[s.i],
        label: `n=${s.n}`,
      })),
    );
};

/** Arrhenius on a log axis: one rigid slide, the same at every landmark. */
const figShift = (svg) => {
  const f = frame(720, 220);
  const logLo = 3;
  const xMax = 900;
  const m = mapping(f, { xMax, logLo });
  const kCold = Math.LN2 / 120;
  const ratio = arrheniusRatio(44_550, 298.15, 308.15);
  const cold = { k: kCold, n: 1, C0: 1 };
  const warm = { k: kCold * ratio, n: 1, C0: 1 };

  svg.setAttribute('viewBox', `0 0 ${f.W} ${f.H}`);
  svg.innerHTML =
    baseline(f, 'time (log scale)') +
    `<path d="${path(curvePoints(f, m, warm, { xMax, logLo }))}" fill="none" stroke="#5598e7" ` +
    `stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>` +
    `<path d="${path(curvePoints(f, m, cold, { xMax, logLo }))}" fill="none" stroke="${NAVY}" ` +
    `stroke-width="2" stroke-linecap="round"/>` +
    arrow(
      m.x(timeToConversion(0.5, warm)) + 3,
      m.x(timeToConversion(0.5, cold)) - 3,
      m.y(0.5),
      'every landmark shifts by the same amount',
    ) +
    endLabels([
      { x: f.L + f.PW, y: m.y(conversionAtTime(xMax, cold)), colour: NAVY, dash: '', label: '25 °C' },
      { x: f.L + f.PW, y: m.y(conversionAtTime(xMax, warm)), colour: '#5598e7', dash: '5 4', label: '35 °C' },
    ]);
};

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

const BUILDERS = { orders: figOrders, halflife: figHalfLife, fan: figFan, shift: figShift };

export const renderFigures = () => {
  for (const svg of document.querySelectorAll('svg[data-fig]')) {
    const build = BUILDERS[svg.dataset.fig];
    if (build) build(svg);
  }
};
