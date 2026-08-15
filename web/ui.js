/**
 * The machinery that makes live recomputation visible.
 *
 * The form already recomputed on input before any of this existed, but nothing on screen
 * said so, so people looked for a submit button. The fix is affordance rather than
 * instruction: a slider the curve moves under, a pill that reports its own state, and a
 * highlight on the digits that actually changed.
 *
 * Nothing here knows any chemistry. It is imported by the views, never the reverse.
 */

export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const reducedMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

/** Typed text waits; a slider drag never does. */
export const TYPING_DEBOUNCE_MS = 120;
const FLASH_HOLD_MS = 400;
const DIGIT_TWEEN_MS = 250;
const PILL_SETTLE_MS = 800;
const ANNOUNCE_THROTTLE_MS = 700;

export const debounce = (fn, ms = TYPING_DEBOUNCE_MS) => {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

/** Coalesces a burst into one call per animation frame, for slider drags. */
export const perFrame = (fn) => {
  let queued = false;
  let latest = [];
  return (...args) => {
    latest = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...latest);
    });
  };
};

/* ------------------------------------------------------------------ *
 * Numbers that announce their own change
 * ------------------------------------------------------------------ */

const easeOut = (p) => 1 - (1 - p) ** 3;

const highlight = (el) => {
  el.classList.remove('flash');
  // Reading the layout restarts the animation when one node flashes twice in quick
  // succession; without it the second change would show nothing.
  void el.offsetWidth;
  el.classList.add('flash');
  clearTimeout(Number(el.dataset.flashTimer));
  el.dataset.flashTimer = String(setTimeout(() => el.classList.remove('flash'), FLASH_HOLD_MS));
};

/**
 * Writes a value into an element, tweening the digits and holding a highlight, but only
 * when it actually changed.
 *
 * Flashing everything on every keystroke trains people to ignore the flash, which is the
 * opposite of the point. The previous rendering is kept on the node itself, so the
 * comparison survives a re-render of the surrounding markup.
 */
export const writeValue = (el, text, { numeric = null } = {}) => {
  if (!el) return;
  const previous = el.dataset.shown;
  if (previous === text) return;
  el.dataset.shown = text;

  const first = previous === undefined;
  if (first || reducedMotion() || numeric === null || !Number.isFinite(numeric)) {
    el.textContent = text;
    el.dataset.value = String(numeric ?? '');
    if (!first) highlight(el);
    return;
  }

  const from = Number(el.dataset.value);
  el.dataset.value = String(numeric);
  if (!Number.isFinite(from) || from === numeric) {
    el.textContent = text;
    highlight(el);
    return;
  }

  // Tween through the intermediate values so the eye reads the size of the change, then
  // land on the exact formatted string rather than on a rounded interpolation.
  const started = performance.now();
  const decimals = (text.split('.')[1] ?? '').replace(/\D.*$/, '').length;
  // The separator before the unit belongs to the suffix: consuming it would make every
  // frame of the tween read "200.4min" and only the final value read "202.8 min".
  const suffix = text.replace(/^[\d.,-]+/, '');
  const step = (now) => {
    if (el.dataset.shown !== text) return; // superseded by a newer value
    const p = Math.min((now - started) / DIGIT_TWEEN_MS, 1);
    if (p >= 1) {
      el.textContent = text;
      return;
    }
    el.textContent = (from + (numeric - from) * easeOut(p)).toFixed(decimals) + suffix;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  highlight(el);
};

/* ------------------------------------------------------------------ *
 * Live pill
 * ------------------------------------------------------------------ */

/** Reports the recompute itself: Updating while in flight, Updated briefly, then Live. */
export const livePill = (el) => {
  let settle = 0;
  return {
    busy() {
      if (!el) return;
      clearTimeout(settle);
      el.dataset.state = 'busy';
      el.textContent = 'Updating';
    },
    done() {
      if (!el) return;
      el.dataset.state = 'done';
      el.textContent = 'Updated';
      clearTimeout(settle);
      settle = setTimeout(() => {
        el.dataset.state = 'live';
        el.textContent = 'Live';
      }, PILL_SETTLE_MS);
    },
  };
};

/* ------------------------------------------------------------------ *
 * Screen reader announcements
 * ------------------------------------------------------------------ */

/**
 * Announces the headline result, at most once per 700 ms.
 *
 * Without the throttle a slider drag emits a hundred announcements a second and floods
 * the screen reader queue, which is worse than saying nothing at all.
 */
export const announcer = (el) => {
  let last = 0;
  let pending = 0;
  let queued = null;
  const emit = (text) => {
    if (!el || text === el.textContent) return;
    el.textContent = text;
    last = performance.now();
  };
  return (text) => {
    const wait = ANNOUNCE_THROTTLE_MS - (performance.now() - last);
    if (wait <= 0) {
      emit(text);
      return;
    }
    queued = text;
    clearTimeout(pending);
    pending = setTimeout(() => emit(queued), wait);
  };
};

/* ------------------------------------------------------------------ *
 * Paired slider and numeric box
 * ------------------------------------------------------------------ */

/**
 * One value, two controls, and a raw string that survives partial typing.
 *
 * The numeric box holds whatever was typed, character for character. It is never written
 * back to while it has focus, so the cursor cannot jump and "1." cannot be reformatted to
 * "1" underneath someone mid-number. The parsed value updates only when the raw string
 * resolves to something inside the field's range; until then the field is marked pending
 * and the last valid model keeps driving the chart.
 */
export const pairedField = ({ box, slider, min, max, onChange, parse = Number, clamp = true }) => {
  const state = { raw: box?.value ?? '', value: Number(box?.value), valid: true };

  const publish = (immediate) => {
    box?.classList.toggle('pending', !state.valid);
    box?.setAttribute('aria-invalid', state.valid ? 'false' : 'true');
    onChange(state.value, { immediate, valid: state.valid });
  };

  const accept = (raw) => {
    state.raw = raw;
    const parsed = parse(raw);
    // Partial input is not an error, it is an unfinished number. Hold the last good one.
    const usable = raw.trim() !== '' && Number.isFinite(parsed);
    state.valid = usable && (!clamp || (parsed >= min && parsed <= max));
    if (state.valid) state.value = parsed;
    publish(false);
  };

  box?.addEventListener('input', () => {
    accept(box.value);
    if (slider && state.valid) slider.value = String(state.value);
  });

  // Tidy the field once the person has left it, never while they are inside it.
  box?.addEventListener('blur', () => {
    if (!Number.isFinite(state.value)) return;
    box.value = String(state.value);
    if (!state.valid) {
      state.valid = true;
      publish(true);
    } else {
      box.classList.remove('pending');
      box.setAttribute('aria-invalid', 'false');
    }
  });

  slider?.addEventListener('input', () => {
    state.value = Number(slider.value);
    state.valid = true;
    state.raw = slider.value;
    if (box && document.activeElement !== box) box.value = slider.value;
    publish(true);
  });

  return {
    get value() {
      return state.value;
    },
    get valid() {
      return state.valid;
    },
    /** Writes both controls, skipping whichever one currently has focus. */
    set(value) {
      state.value = value;
      state.valid = true;
      state.raw = String(value);
      if (box && document.activeElement !== box) box.value = String(value);
      if (slider && document.activeElement !== slider) slider.value = String(value);
      box?.classList.remove('pending');
    },
  };
};

/* ------------------------------------------------------------------ *
 * Coach mark
 * ------------------------------------------------------------------ */

const COACH_KEY = 'kinetics.coach.dismissed';

/**
 * Shown once, ever, against the first slider. Dismissed by the first input of any kind,
 * because someone who has already dragged something does not need telling.
 */
export const coachMark = (host, text) => {
  let dismissed = true;
  try {
    dismissed = globalThis.localStorage?.getItem(COACH_KEY) === '1';
  } catch {
    dismissed = false; // Private mode: show it, just do not remember.
  }
  if (dismissed || !host) return { dismiss() {} };

  const mark = document.createElement('div');
  mark.className = 'coach';
  mark.setAttribute('role', 'note');
  mark.textContent = text;
  host.appendChild(mark);

  return {
    dismiss() {
      mark.remove();
      try {
        globalThis.localStorage?.setItem(COACH_KEY, '1');
      } catch {
        /* nowhere to persist to; it is gone for this session either way */
      }
    },
  };
};

/* ------------------------------------------------------------------ *
 * Clipboard
 * ------------------------------------------------------------------ */

/** Copies tab separated rows, reporting the outcome on the button that asked. */
export const copyRows = async (button, rows) => {
  const text = rows.map((row) => row.join('\t')).join('\n');
  const said = button.dataset.label ?? button.textContent;
  button.dataset.label = said;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = said;
  }, 1400);
};
