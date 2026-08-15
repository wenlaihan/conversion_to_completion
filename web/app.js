import { $, esc } from './ui.js';
import { mountEstimate, revealPanel, applyFittedOrder } from './estimate.js';
import { renderFigures } from './figures.js';
import { mountFit } from './fit.js';

/**
 * Router and page wiring.
 *
 * Three routes where there were five. Temperature and order comparison were never
 * separate topics, they were two questions about one curve, and they now live as panels
 * on Estimate. The model catalogue became Learn.
 *
 * Every number on screen comes from the engine in src/, the same modules the test suite
 * covers and the /solve endpoint runs. Nothing here recomputes kinetics.
 */

/** The author's public page, linked from the masthead. */
const PERSONAL_URL = 'https://wenlaihan.github.io/';

const VIEWS = ['estimate', 'fit', 'learn'];

/**
 * Retired routes, and the panel each one became.
 *
 * A bookmark or a shared link still has to land somewhere sensible, so these resolve to
 * Estimate with the panel that absorbed them opened and brought into view, rather than
 * dropping the reader at the top of a page they did not ask for.
 */
const REDIRECTS = {
  temperature: { view: 'estimate', panel: 'panel-temperature' },
  temp: { view: 'estimate', panel: 'panel-temperature' },
  compare: { view: 'estimate', panel: 'panel-orders' },
  'compare-orders': { view: 'estimate', panel: 'panel-orders' },
  models: { view: 'learn', panel: null },
};

/* ------------------------------------------------------------------ *
 * Learn: predict, observe, explain
 * ------------------------------------------------------------------ */

/**
 * Asks for a commitment before revealing.
 *
 * Nothing is gated: the reveal is one click away whatever the reader picks, and picking
 * again is free. The point is the moment of committing, not the grading.
 */
const wirePredictions = () => {
  for (const block of document.querySelectorAll('.poe')) {
    const reveal = block.querySelector('.reveal');
    for (const button of block.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        for (const other of block.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        reveal?.classList.remove('hide');
      });
    }
  }
};

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

const show = (requested) => {
  // "#estimate?orders=1" carries a preset: Learn links to the live overlay this way.
  const [name, query = ''] = requested.split('?');
  const params = new URLSearchParams(query);
  const redirect = REDIRECTS[name];
  const view = redirect ? redirect.view : VIEWS.includes(name) ? name : 'estimate';

  for (const section of document.querySelectorAll('main > section')) {
    section.classList.add('hide');
  }
  $(`v-${view}`)?.classList.remove('hide');
  for (const button of document.querySelectorAll('#nav button')) {
    button.setAttribute('aria-current', button.dataset.v === view ? 'page' : 'false');
  }

  const fittedN = Number(params.get('n'));
  if (params.get('n') !== null && Number.isFinite(fittedN)) {
    applyFittedOrder(fittedN);
    globalThis.history?.replaceState(null, '', `#${view}`);
  }
  if (params.get('orders') === '1' || redirect?.panel === 'panel-orders') {
    const toggle = $('orders-toggle');
    if (toggle && !toggle.checked) {
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
    }
    if (!redirect) globalThis.history?.replaceState(null, '', `#${view}`);
  }
  if (redirect) {
    // Rewrite the address so the retired name does not survive in history, then open the
    // panel that absorbed it.
    globalThis.history?.replaceState(null, '', `#${view}`);
    if (redirect.panel) requestAnimationFrame(() => revealPanel(redirect.panel));
  }
};

const routeFromHash = () => (globalThis.location?.hash ?? '').replace('#', '') || 'estimate';

const navigate = (view) => {
  if (globalThis.location) globalThis.location.hash = view;
  else show(view);
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

const links = $('toplinks');
if (links) {
  links.innerHTML = `<a href="${esc(PERSONAL_URL)}" target="_blank" rel="noopener">About the author</a>`;
}

for (const button of document.querySelectorAll('#nav button')) {
  button.addEventListener('click', () => navigate(button.dataset.v));
}
globalThis.addEventListener?.('hashchange', () => show(routeFromHash()));

mountEstimate();
mountFit();
wirePredictions();
renderFigures();
show(routeFromHash());
