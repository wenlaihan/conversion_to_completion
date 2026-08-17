import {
  fmtFactor,
  fmtPercent,
  fmtRate,
  fmtTemp,
  fmtTime,
  meaningfulChange,
} from '../dist/lib/format.js';
import {
  $,
  esc,
  announcer,
  coachMark,
  copyRows,
  debounce,
  livePill,
  pairedField,
  perFrame,
  writeValue,
} from './ui.js';
import {
  ORDER_COLOURS,
  ORDER_DASHES,
  attachCrosshair,
  drawCurve,
  drawSpread,
  sampleSeries,
  timeScale,
} from './curve.js';
import {
  arrheniusRatio,
  completionTime,
  conversionAtTime,
  conversionAtTimeStepped,
  isReachable,
  q10,
  rateConstantUnits,
  timeToConversion,
  timeToConversionStepped,
} from '../dist/lib/kinetics.js';

/**
 * Estimate: one curve, and every question asked of it.
 *
 * Temperature and order comparison used to be separate routes. They are not separate
 * topics, they are two things that happen to the same curve, and holding that curve in
 * memory across a tab switch was exactly the comparison a reader is least able to make.
 * Both are panels here, and both draw onto the figure above them.
 */

// Three ghosts, not five: n = 0, 1 and 2 span the spread without the half-order
// clutter. Each order keeps its fixed palette slot so the colours never reshuffle.
const CANDIDATE_ORDERS = [0, 1, 2];
const ORDER_SLOT = { 0: 0, 0.5: 1, 1: 2, 1.5: 3, 2: 4 };
/** Halfway, the headline, the tail. More labels read as clutter before they read as data. */
const ANNOTATION_LEVELS = [0.5, 0.9, 0.99];
/** The conversion the candidate-order spread is read at. */
const SPREAD_LEVEL = 0.95;
const FAR_EXTRAPOLATION_K = 40;
const EA_MIN_J = 0;
const EA_MAX_J = 400_000;
const PLOT_TOP = 22;
const PLOT_BOT = 330;

/* ------------------------------------------------------------------ *
 * Units and formatting
 * ------------------------------------------------------------------ */

const toKelvin = (value, unit) =>
  unit === 'K' ? value : unit === 'F' ? ((value - 32) * 5) / 9 + 273.15 : value + 273.15;

const fromKelvin = (K, unit) =>
  unit === 'K' ? K : unit === 'F' ? ((K - 273.15) * 9) / 5 + 32 : K - 273.15;

const unitLabel = (unit) => (unit === 'K' ? 'K' : unit === 'F' ? '°F' : '°C');

// The precision rules live in one shared module (item 2): integers for percent,
// 2 to 3 significant figures for times and factors, whole degrees, and fixed
// significant figures with scientific extremes for rate constants.
const fmtNum = fmtRate;

/** Trimmed: a set temperature or concentration is exact, so decimals are only noise. */
const fmtTrim = (v, dp = 1) => (Number.isFinite(v) ? String(Number(v.toFixed(dp))) : 'n/a');

const MINUTES_PER = { s: 1 / 60, min: 1, h: 60 };
const TWO_HOURS_MIN = 120;
const TWO_DAYS_H = 48;

/**
 * A time in whatever unit its size asks for.
 *
 * "4327 min" makes the reader do the division that decides "overnight or not"; the
 * display answers in minutes below two hours, hours to two days, then days. The input
 * unit is untouched; only what is read changes.
 */
const fmtSmart = (v) => {
  if (!isReachable(v)) return 'never';
  const minutes = v * (MINUTES_PER[state.timeUnit] ?? 1);
  if (minutes < 1) return `${fmtTime(minutes * 60)} s`;
  if (minutes < TWO_HOURS_MIN) return `${fmtTime(minutes)} min`;
  const hours = minutes / 60;
  if (hours <= TWO_DAYS_H) return `${fmtTime(hours)} h`;
  return `${fmtTime(hours / 24)} d`;
};
const pct = fmtPercent;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Real values on first load, so the chart is already drawn.
 *
 * An empty chart on arrival teaches nothing and sends people hunting for the button that
 * would fill it. These are a plausible bench measurement, not placeholders.
 */
const state = {
  X1: 0.4,
  t1: 30,
  C0: 1.7,
  n: 1,
  tempUnit: 'C',
  timeUnit: 'min',
  Tmeasure: 298.15,
  Tpredict: 298.15,
  Ea: 50_000,
  eaMeasured: false,
  logTime: false,
  // Off until asked for: the first question here is "when is it done", and five extra
  // curves at first load answer a question nobody has asked yet. The one-line toggle
  // under the order field is where that question gets asked.
  showOrders: false,
};

let pill = { busy() {}, done() {} };
let say = () => {};
let coach = { dismiss() {} };

/* ------------------------------------------------------------------ *
 * Kinetics, all of it through the one module
 * ------------------------------------------------------------------ */

/**
 * The rate constant that puts the curve exactly through the measured point.
 *
 * Every time on the curve is proportional to 1/k, so the time at k = 1 divided by the
 * measured time is the rate constant, with no root finding needed. That identity is the
 * same one the temperature panel leans on, and it is pinned by a property test.
 */
const rateConstantFor = (n) => {
  const unitTime = timeToConversion(state.X1, { k: 1, n, C0: state.C0 });
  if (!isReachable(unitTime) || !(state.t1 > 0)) return Number.NaN;
  return unitTime / state.t1;
};

const shifted = (k) => k * arrheniusRatio(state.Ea, state.Tmeasure, state.Tpredict);

const paramsAt = (n, k) => ({ k, n, C0: state.C0 });

const kUnits = () => rateConstantUnits(state.n, { conc: 'M', time: state.timeUnit });

/**
 * The curve for one order, under whatever temperature schedule is set.
 *
 * With no switch time, this is the uniform Predict-at curve, exactly as before. With
 * one, the run holds the measured temperature until that moment and switches, which is
 * how a bench chemist actually heats a flask: the reaction is already going.
 */
const scheduled = (n) => {
  const kBefore = rateConstantFor(n);
  const kAfter = shifted(kBefore);
  if (state.heatAt === null || !(state.heatAt > 0)) {
    const p = paramsAt(n, kAfter);
    return { time: (X) => timeToConversion(X, p), conv: (t) => conversionAtTime(t, p) };
  }
  const p = paramsAt(n, kBefore);
  const step = { tSwitch: state.heatAt, kAfter };
  return {
    time: (X) => timeToConversionStepped(X, p, step),
    conv: (t) => conversionAtTimeStepped(t, p, step),
  };
};

/* ------------------------------------------------------------------ *
 * Figure
 * ------------------------------------------------------------------ */

const buildFigure = () => {
  const svg = $('curve');
  if (!svg) return null;

  const kMeasured = rateConstantFor(state.n);
  const kLive = shifted(kMeasured);
  const sched = scheduled(state.n);
  const finish = sched.time(1);

  const candidates = CANDIDATE_ORDERS.map((n) => ({ n, sched: scheduled(n) }));
  const reach = (schedN, X) => {
    const t = schedN.time(X);
    return isReachable(t) ? t : Number.NaN;
  };
  /**
   * Sizing the axis to the slowest candidate's 99% time would be defensible and useless:
   * at n = 2 that is sixteen times the live curve's own tail, so the curve the reader
   * came for gets crushed into the left margin. The axis holds the live curve to 99% and
   * every candidate to 90%, which is where the spread strip below reads; slower tails
   * run off the right edge, where their direct labels still name them.
   */
  const spans = [
    reach(sched, 0.99),
    ...(state.showOrders ? candidates.map((c) => reach(c.sched, SPREAD_LEVEL)) : []),
  ];
  const tMax = Math.max(...spans.filter(Number.isFinite), state.t1 * 1.4, (state.heatAt ?? 0) * 1.3, 1) * 1.15;

  const scale = timeScale({ tMax, log: state.logTime });
  const conversionOf = (p) => (t) => conversionAtTime(t, p);
  const stopFor = (p) => {
    const t = completionTime(p);
    return isReachable(t) ? t : null;
  };

  const series = [];
  const shiftedAway = Math.abs(state.Tpredict - state.Tmeasure) > 0.05;

  // A ghost of the same reaction at the temperature it was measured at, kept alongside so
  // the shift reads as a comparison rather than as a claim.
  if (shiftedAway) {
    const ghost = paramsAt(state.n, kMeasured);
    series.push({
      points: sampleSeries(scale, conversionOf(ghost), stopFor(ghost)),
      colour: 'var(--outline)',
      dash: '4 5',
      faint: 0.75,
      label: `${fmtTemp(fromKelvin(state.Tmeasure, state.tempUnit))} ${unitLabel(state.tempUnit)}`,
    });
  }

  if (state.showOrders) {
    candidates.forEach((c) => {
      if (c.n === state.n) return;
      const stop = c.sched.time(1);
      const slot = ORDER_SLOT[c.n] ?? 2;
      series.push({
        points: sampleSeries(scale, c.sched.conv, isReachable(stop) ? stop : null),
        colour: ORDER_COLOURS[slot],
        dash: ORDER_DASHES[slot],
        faint: 0.5,
        label: `n=${c.n}`,
      });
    });
  }

  // Item 1: the legend rail is the one place a curve is named, so the live curve
  // always carries its label there; when shifted, temperature is what tells the two
  // solid-versus-ghost curves apart, so it is the name.
  series.push({
    points: sampleSeries(scale, sched.conv, isReachable(finish) ? finish : null),
    colour: 'var(--primary)',
    dash: '',
    emphasis: true,
    label: shiftedAway
      ? `${fmtTemp(fromKelvin(state.Tpredict, state.tempUnit))} ${unitLabel(state.tempUnit)}`
      : `n=${state.n}`,
  });

  const annotations = [];
  for (const X of ANNOTATION_LEVELS) {
    const t = sched.time(X);
    if (!isReachable(t) || t > scale.hi) continue;
    // While the ghost is shown, the headline annotation holds both times, so the payoff
    // of heating is read where the eye already is instead of remembered from a sentence.
    // The comparison rides the annotation only when the curve does not also finish on
    // screen: a finite completion brings its own mark into the same corner, the top
    // strip is already holding two curve names, and the speedup sentence below carries
    // both times anyway.
    const was =
      X === 0.9 && shiftedAway && !isReachable(finish)
        ? ` (was ${fmtSmart(timeToConversion(X, paramsAt(state.n, kMeasured)))})`
        : '';
    annotations.push({
      X,
      px: scale.toPx(t),
      py: PLOT_BOT - X * (PLOT_BOT - PLOT_TOP),
      label: `${pct(X)} at ${fmtSmart(t)}${was}`,
      // The comparison yields before any label is allowed to collide.
      alt: was ? `${pct(X)} at ${fmtSmart(t)}` : undefined,
    });
  }
  const stepActive = state.heatAt !== null && state.heatAt > 0 && shiftedAway;
  if (stepActive && state.heatAt <= scale.hi) {
    const Xs = sched.conv(state.heatAt);
    if (Xs < 1) {
      const verb = state.Tpredict > state.Tmeasure ? 'heat' : 'cool';
      annotations.push({
        X: Xs,
        px: scale.toPx(state.heatAt),
        py: PLOT_BOT - Xs * (PLOT_BOT - PLOT_TOP),
        label: `${verb} to ${fmtTemp(fromKelvin(state.Tpredict, state.tempUnit))} ${unitLabel(state.tempUnit)}`,
      });
    }
  }
  // At n < 1 the reaction reaches 100% at a definite time, and that is the answer rather
  // than another gridline. At n >= 1 it never does, so 100% is never annotated.
  if (isReachable(finish) && finish <= scale.hi) {
    annotations.push({
      X: 1,
      px: scale.toPx(finish),
      py: PLOT_TOP,
      label: `complete at ${fmtSmart(finish)}`,
    });
  }

  drawCurve(svg, {
    series,
    scale,
    annotations,
    // Symbols only, and no order: the legend rail is the one place orders appear.
    badge: [
      state.heatAt !== null && state.heatAt > 0 && shiftedAway
        ? `k = ${fmtNum(kMeasured)}\u2192${fmtNum(kLive)} ${kUnits()}`
        : `k = ${fmtNum(kLive)} ${kUnits()}`,
      `C₀ = ${fmtTrim(state.C0, 2)} M`,
      state.heatAt !== null && state.heatAt > 0 && shiftedAway
        ? `T = ${fmtTemp(fromKelvin(state.Tmeasure, state.tempUnit))}\u2192${fmtTemp(fromKelvin(state.Tpredict, state.tempUnit))} ${unitLabel(state.tempUnit)}`
        : `T = ${fmtTemp(fromKelvin(state.Tpredict, state.tempUnit))} ${unitLabel(state.tempUnit)}`,
    ],
    // When the switch lands on the measured point itself, the ring stays but its words
    // yield to the switch annotation that shares the dot.
    measured: {
      t: state.t1,
      X: state.X1,
      quiet: stepActive && Math.abs(scale.toPx(state.heatAt) - scale.toPx(state.t1)) < 30,
    },
    timeUnit: state.timeUnit,
    // Not a sentence: the 100% line goes dashed and gets a two word tag, which says the
    // same thing where the reader is already looking.
    asymptote: !isReachable(finish),
  });

  attachCrosshair(svg, $('curve-tip'), {
    scale,
    conversionAt: sched.conv,
    fmt: (t, X) => `<b>${pct(X)}</b> at ${esc(fmtSmart(t))}`,
    onPin: (t) => {
      const near =
        state.pinnedT !== null && Math.abs(scale.toPx(t) - scale.toPx(state.pinnedT)) < 14;
      state.pinnedT = near ? null : t;
      render();
    },
  });

  // The pin redraws from state on every render, so it tracks the live curve while the
  // reader drags temperature or order underneath it.
  if (state.pinnedT !== null && state.pinnedT >= scale.lo && state.pinnedT <= scale.hi) {
    const px = scale.toPx(state.pinnedT);
    const X = sched.conv(state.pinnedT);
    const py = PLOT_BOT - X * (PLOT_BOT - PLOT_TOP);
    const label = `${pct(X)} at ${fmtSmart(state.pinnedT)}`;
    const flip = px > 560;
    svg.insertAdjacentHTML(
      'beforeend',
      `<line x1="${px.toFixed(1)}" y1="${PLOT_TOP}" x2="${px.toFixed(1)}" y2="${PLOT_BOT}" ` +
        `stroke="var(--deep-teal)" stroke-width="1" stroke-dasharray="3 3"/>` +
        `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="var(--deep-teal)" ` +
        `stroke="var(--lowest)" stroke-width="2"/>` +
        `<rect x="${(flip ? px - 8 - label.length * 6.6 : px + 8).toFixed(1)}" y="${(py - 22).toFixed(1)}" ` +
        `width="${(label.length * 6.6).toFixed(0)}" height="17" rx="3" fill="var(--deep-teal)"/>` +
        `<text x="${(flip ? px - 12 : px + 12).toFixed(1)}" y="${(py - 10).toFixed(1)}" ` +
        `text-anchor="${flip ? 'end' : 'start'}" font-size="12" font-weight="600" fill="#fff" ` +
        `font-family="var(--sans)">${esc(label)}</text>`,
    );
  }

  const spread = $('spread');
  if (spread) {
    spread.style.display = state.showOrders ? '' : 'none';
    if (state.showOrders) {
      drawSpread(spread, {
        scale,
        title: `Time to ${pct(SPREAD_LEVEL)}`,
        marks: candidates
          .map((c) => {
            const t = c.sched.time(SPREAD_LEVEL);
            return isReachable(t)
              ? {
                  t,
                  colour: ORDER_COLOURS[ORDER_SLOT[c.n] ?? 2],
                  emphasis: c.n === state.n,
                  label: `n=${c.n}`,
                  value: fmtSmart(t),
                }
              : null;
          })
          .filter(Boolean),
      });
    }
  }

  return { sched, kMeasured, kLive, finish, annotations, stepActive };
};

/* ------------------------------------------------------------------ *
 * Read-outs
 * ------------------------------------------------------------------ */

const renderReadouts = (ctx) => {
  for (const [id, value] of [
    ['t-half', ctx.sched.time(0.5)],
    ['t-90', ctx.sched.time(0.9)],
    ['t-99', ctx.sched.time(0.99)],
  ]) {
    writeValue($(id), fmtSmart(value), {
      numeric: isReachable(value) ? value : null,
    });
  }
  writeValue($('k-value'), `${fmtNum(ctx.kLive)} ${kUnits()}`, { numeric: ctx.kLive });

  // The C0 caption tells the truth for the current order. At first order k is
  // concentration independent, so a blanket "changes k" promise reads as a bug the
  // moment someone drags the slider and watches nothing move; that stillness is the
  // defining first-order property, and the caption should claim it.
  const note = $('c0-note');
  if (note) {
    note.textContent =
      Math.abs(state.n - 1) < 0.001
        ? 'At n = 1 nothing here moves: a first order k is independent of C\u2080.'
        : 'Changes k and its units, not the curve.';
  }

  // Item 4: the concentration what-if, in the temperature sentence's register,
  // computed from the same params as the plotted curve. Suppressed while a
  // temperature switch is active (the comparison would mix schedules), when either
  // time is unreachable, and when the change is negligible, which is exactly the
  // n = 1 case the note above already explains.
  const whatifC0 = $('c0-whatif');
  if (whatifC0) {
    const live = paramsAt(state.n, ctx.kLive);
    const t90Now = ctx.sched.time(0.9);
    const t90Half = timeToConversion(0.9, { ...live, C0: state.C0 / 2 });
    const show =
      !ctx.stepActive &&
      isReachable(t90Now) &&
      isReachable(t90Half) &&
      meaningfulChange(t90Now, t90Half);
    whatifC0.innerHTML = show
      ? `Halving C₀ to ${esc(fmtTrim(state.C0 / 2, 2))} M moves 90% conversion from ` +
        `<b>${esc(fmtSmart(t90Now))}</b> to <b>${esc(fmtSmart(t90Half))}</b>.`
      : '';
  }
  const whatifTarget = $('target-whatif');
  if (whatifTarget) {
    const t90 = ctx.sched.time(0.9);
    const t99 = ctx.sched.time(0.99);
    const show = isReachable(t90) && isReachable(t99) && meaningfulChange(t90, t99);
    whatifTarget.innerHTML = show
      ? `Going from 90% to 99% conversion costs an extra <b>${esc(fmtSmart(t99 - t90))}</b>.`
      : '';
  }

  const half = ctx.sched.time(0.5);
  const ninety = ctx.sched.time(0.9);
  say(`Half life ${fmtSmart(half)}, 90 percent conversion at ${fmtSmart(ninety)}.`);

  // The hidden table is what the visible one used to be: the numbers leave the design,
  // they do not leave the product.
  const body = $('sr-rows');
  if (body) {
    body.innerHTML = ctx.annotations
      .map((a) => {
        const [what, when] = a.label.split(' at ');
        return `<tr><td>${esc(what)}</td><td>${esc(when ?? '')}</td></tr>`;
      })
      .join('');
  }
};

/* ------------------------------------------------------------------ *
 * Temperature panel
 * ------------------------------------------------------------------ */

const renderTemperaturePanel = (ctx) => {
  const unit = unitLabel(state.tempUnit);
  const measuredAt = fmtTemp(fromKelvin(state.Tmeasure, state.tempUnit));
  const predictAt = fmtTemp(fromKelvin(state.Tpredict, state.tempUnit));
  const ratio = arrheniusRatio(state.Ea, state.Tmeasure, state.Tpredict);

  const ninetyNow = ctx.sched.time(0.9);
  const ninetyThen = timeToConversion(0.9, paramsAt(state.n, ctx.kMeasured));

  // Nothing to report until the two temperatures differ: the readouts already carry the
  // unshifted answer, and restating it here was one more thing to read.
  $('t-sentence').innerHTML =
    !Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.005
      ? ''
      : ctx.stepActive
        ? `Switching to ${esc(predictAt)} ${esc(unit)} at ${esc(fmtSmart(state.heatAt))} brings ` +
          `90% conversion to <b>${esc(fmtSmart(ninetyNow))}</b>; unswitched it takes ` +
          `<b>${esc(fmtSmart(ninetyThen))}</b>.`
        : `At ${esc(predictAt)} ${esc(unit)} the reaction runs ` +
          `<b>${esc(fmtFactor(ratio > 1 ? ratio : 1 / ratio))}x ${ratio > 1 ? 'faster' : 'slower'}</b> ` +
          `than at ${esc(measuredAt)} ${esc(unit)}. 90% conversion arrives at ` +
          `<b>${esc(fmtSmart(ninetyNow))}</b> instead of ` +
          `<b>${esc(fmtSmart(ninetyThen))}</b>.`;

  // Item 5: no jargon label, the quantity named, the step unit unmistakable, and
  // the reference temperature stated, because the Arrhenius factor is not constant
  // across the range.
  const perTen = q10(state.Ea, state.Tmeasure);
  const stepLabel =
    state.tempUnit === 'K'
      ? '10 K (= 10 \u00B0C)'
      : state.tempUnit === 'F'
        ? '18 \u00B0F (a 10 \u00B0C step)'
        : '10 \u00B0C';
  const perTenEl = $('rate-per-ten');
  if (perTenEl) {
    perTenEl.textContent = Number.isFinite(perTen)
      ? `The rate constant increases by a factor of about ${fmtFactor(perTen)} for every ` +
        `${stepLabel} increase in temperature, near ${measuredAt} ${unit}.`
      : '';
  }

  const badge = $('ea-badge');
  if (badge) badge.style.display = state.eaMeasured ? 'none' : '';

  for (const chip of document.querySelectorAll('#solvent-chips button')) {
    const at = Math.abs(state.Tpredict - toKelvin(Number(chip.dataset.t), 'C')) < 0.05;
    chip.setAttribute('aria-pressed', String(at));
  }

  // The when-question is sequential to the temperature question: without a new
  // temperature there is nothing to apply, and the whole mode fieldset waits.
  const mode = $('t-mode');
  if (mode) mode.disabled = !(Math.abs(ratio - 1) >= 0.005);
  const unitTag = $('hs-unit');
  if (unitTag) unitTag.textContent = state.timeUnit;

  const cautions = [];
  const delta = Math.abs(state.Tpredict - state.Tmeasure);
  if (delta > FAR_EXTRAPOLATION_K) {
    cautions.push(
      `This carries the rate constant ${fmtTrim(delta)} K from the measured temperature. A ` +
        `constant activation energy extrapolated that far is unreliable, and a straight ` +
        `Arrhenius plot is not on its own evidence that the activation energy is temperature ` +
        `independent.`,
    );
  }
  const lo = Math.min(state.Tmeasure, state.Tpredict);
  const hi = Math.max(state.Tmeasure, state.Tpredict);
  for (const [K, what] of [
    [273.15, 'freezing'],
    [373.15, 'boiling'],
  ]) {
    if (lo < K && hi > K) {
      cautions.push(
        `The prediction crosses ${fmtTemp(fromKelvin(K, state.tempUnit))} ${unit}. In a typical ` +
          `aqueous system a phase change at ${what} would invalidate this model entirely.`,
      );
    }
  }
  if (state.Ea <= EA_MIN_J || state.Ea >= EA_MAX_J) {
    cautions.push(
      `Activation energy is held at ${fmtTrim(state.Ea / 1000)} kJ/mol, the edge of the accepted ` +
        `range. Values outside 0 to 400 kJ/mol are not chemistry this model describes, so the ` +
        `figure is clamped rather than followed.`,
    );
  }
  $('t-cautions').innerHTML = cautions.map((c) => `<div class="caution">${esc(c)}</div>`).join('');
};

/* ------------------------------------------------------------------ *
 * Render and wiring
 * ------------------------------------------------------------------ */

const render = () => {
  pill.busy();
  const ctx = buildFigure();
  if (!ctx) return;
  renderReadouts(ctx);
  renderTemperaturePanel(ctx);
  pill.done();
};

const fromSlider = perFrame(render);
const fromTyping = debounce(render);

const bind = ({ apply, ...opts }) =>
  pairedField({
    ...opts,
    onChange: (value, { immediate }) => {
      apply(value);
      coach.dismiss();
      if (immediate) fromSlider();
      else fromTyping();
    },
  });

export const mountEstimate = () => {
  pill = livePill($('live-pill'));
  say = announcer($('announce'));
  coach = coachMark($('coach-host'), 'Drag this and watch the curve.');

  const FIELDS = [
    ['i-x', 's-x', 0.1, 99, (v) => (state.X1 = v / 100)],
    ['i-t', 's-t', 0.001, 100_000, (v) => (state.t1 = v)],
    ['i-n', 's-n', 0, 3, (v) => (state.n = v)],
    ['i-c0', 's-c0', 0.01, 10, (v) => (state.C0 = v)],
    ['i-tm', 's-tm', -50, 200, (v) => (state.Tmeasure = toKelvin(v, state.tempUnit))],
    ['i-tp', 's-tp', -50, 250, (v) => (state.Tpredict = toKelvin(v, state.tempUnit))],
    ['i-ea', 's-ea', 0, 400, (v) => (state.Ea = Math.min(Math.max(v * 1000, EA_MIN_J), EA_MAX_J))],
  ];
  const fields = {};
  for (const [box, slider, min, max, apply] of FIELDS) {
    fields[box] = bind({ box: $(box), slider: $(slider), min, max, apply });
  }
  orderField = fields['i-n'];

  /**
   * The when-question is a mode, not a magic blank. "From the start" is the uniform
   * shift; "from time" holds the measured temperature until that moment. heatAt derives
   * from the pair: null unless the second mode is chosen and carries a positive time.
   */
  const applyMode = () => {
    const atMode = $('mode-at')?.checked === true;
    const raw = ($('i-hs')?.value ?? '').trim();
    const value = Number(raw);
    const usable = raw !== '' && Number.isFinite(value) && value > 0;
    $('i-hs')?.classList.toggle('pending', atMode && raw !== '' && !usable);
    state.heatAt = atMode && usable ? value : null;
    coach.dismiss();
    fromTyping();
  };
  $('mode-start')?.addEventListener('change', applyMode);
  $('mode-at')?.addEventListener('change', () => {
    // Choosing the mode with an empty field prefills the measured time: "heat it now,
    // where the measurement was taken" is the case a bench chemist usually means.
    const box = $('i-hs');
    if (box && box.value.trim() === '') box.value = String(state.t1);
    applyMode();
  });
  $('i-hs')?.addEventListener('input', () => {
    // Typing a time is choosing the mode.
    const at = $('mode-at');
    if (at && !at.checked) at.checked = true;
    applyMode();
  });
  $('i-hs')?.addEventListener('focus', () => {
    const at = $('mode-at');
    if (at && !at.checked) {
      at.checked = true;
      applyMode();
    }
  });

  $('i-tu')?.addEventListener('change', () => {
    state.tempUnit = $('i-tu').value;
    // Carry the same physical temperature across the unit change rather than reading the
    // old number as though it were already in the new unit.
    for (const [box, slider, K] of [
      ['i-tm', 's-tm', state.Tmeasure],
      ['i-tp', 's-tp', state.Tpredict],
    ]) {
      const value = Number(fromKelvin(K, state.tempUnit).toFixed(1));
      if ($(box)) $(box).value = String(value);
      if ($(slider)) $(slider).value = String(value);
    }
    render();
  });

  $('i-timeu')?.addEventListener('change', () => {
    /**
     * Convert, never relabel. Leaving the number alone while the unit under it changes
     * turns 30 minutes into 30 hours, a silent factor of sixty in the measurement. The
     * physical time is carried across, and the slider gets a range that suits the unit.
     */
    const RANGES = { s: [1, 600, 1], min: [1, 300, 1], h: [0.25, 48, 0.25] };
    const MINUTES = { s: 1 / 60, min: 1, h: 60 };
    const from = state.timeUnit;
    state.timeUnit = $('i-timeu').value;
    const carried = Number(((state.t1 * MINUTES[from]) / MINUTES[state.timeUnit]).toPrecision(6));
    state.t1 = carried;
    fields['i-t']?.set(carried);
    if (state.heatAt !== null) {
      state.heatAt = Number(((state.heatAt * MINUTES[from]) / MINUTES[state.timeUnit]).toPrecision(6));
      if ($('i-hs')) $('i-hs').value = String(state.heatAt);
    }
    const [lo, hi, step] = RANGES[state.timeUnit] ?? RANGES.min;
    const slider = $('s-t');
    if (slider) {
      slider.min = String(lo);
      slider.max = String(hi);
      slider.step = String(step);
      slider.value = String(carried);
    }
    render();
  });

  // A bench chemist picks a solvent, not a temperature: one click per candidate reflux.
  for (const chip of document.querySelectorAll('#solvent-chips button')) {
    chip.addEventListener('click', () => {
      const value = Number(chip.dataset.t);
      state.Tpredict = toKelvin(value, 'C');
      const shown = Number(fromKelvin(state.Tpredict, state.tempUnit).toFixed(1));
      fields['i-tp']?.set(shown);
      coach.dismiss();
      render();
    });
  }

  $('log-toggle')?.addEventListener('click', () => {
    state.logTime = !state.logTime;
    const button = $('log-toggle');
    button.setAttribute('aria-pressed', String(state.logTime));
    button.textContent = state.logTime ? 'Log time' : 'Linear time';
    render();
  });

  $('orders-toggle')?.addEventListener('change', () => {
    state.showOrders = $('orders-toggle').checked;
    render();
  });

  $('copy-values')?.addEventListener('click', (ev) => {
    const rows = [['Conversion', `Time (${state.timeUnit})`]];
    for (const tr of $('sr-rows')?.querySelectorAll('tr') ?? []) {
      rows.push([...tr.children].map((td) => td.textContent ?? ''));
    }
    copyRows(ev.currentTarget, rows);
  });

  globalThis.addEventListener('resize', debounce(render, 200));
  globalThis.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.pinnedT !== null) {
      state.pinnedT = null;
      render();
    }
  });
  render();
};

/** The measured point, for seeding a trace on Fit. */
export const currentPoint = () => ({
  t: state.t1,
  X: Number((state.X1 * 100).toFixed(2)),
  unit: state.timeUnit,
});

let orderField = null;

/** A fitted order arriving from Fit: applied to the state and both controls. */
export const applyFittedOrder = (n) => {
  if (!Number.isFinite(n)) return;
  state.n = n;
  orderField?.set(Math.min(Math.max(n, 0), 3));
  render();
};

/** Opens a panel and brings it into view, for the redirects from the retired routes. */
export const revealPanel = (id) => {
  const panel = $(id);
  if (!panel) return;
  if (panel.tagName === 'DETAILS') panel.open = true;
  panel.classList.add('revealed');
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => panel.classList.remove('revealed'), 1800);
};
