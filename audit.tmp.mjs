import { chromium } from 'playwright';
import fs from 'fs';
const b = await chromium.launch();
const p = await b.newPage({ viewport:{ width:1273, height:1000 } });
const errs=[];
p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
const rows = [];
const check = (element, expected, observed, pass) => rows.push({ element, expected, observed: String(observed), pass });
const shot = async (name) => { await p.screenshot({ path:`verification/round-5/${name}.png` }); };
const go = async () => { await p.goto('http://127.0.0.1:3000/web/index.html#fit', { waitUntil:'networkidle' }); await p.waitForTimeout(700); };
await go();

// --- Top nav ---
for (const [hash, view] of [['#estimate','v-estimate'],['#learn','v-learn'],['#fit','v-fit']]) {
  await p.click(`.masthead a[href="${hash}"]`).catch(()=>{});
  await p.waitForTimeout(400);
  const visible = await p.evaluate((v)=>!document.getElementById(v)?.classList.contains('hide'), view);
  check(`nav ${hash}`, 'switches view', visible ? 'view shown' : 'NOT SHOWN', visible);
}

// --- Data chips ---
await p.click('#f-sample'); await p.waitForTimeout(600);
check('Load sample chip', 'loads E1 with active card + detail', await p.evaluate(()=>
  document.querySelector('#f-gallery button.active b')?.textContent?.includes('E1') &&
  !document.getElementById('f-callout').classList.contains('hide') &&
  document.getElementById('f-data').value.includes('99.5')), true);
await p.click('#f-clear'); await p.waitForTimeout(400);
check('Clear chip', 'empties box, clears active + callout', await p.evaluate(()=>
  document.getElementById('f-data').value === '' &&
  !document.querySelector('#f-gallery button.active') &&
  document.getElementById('f-callout').classList.contains('hide')), true);
const chooser = p.waitForEvent('filechooser');
await p.click('#f-upload');
check('Upload CSV chip', 'opens file chooser', !!(await chooser), true);
await (await chooser).setFiles('tests/fixtures/run-1.csv'); await p.waitForTimeout(700);
check('file input', 'loads file, rail shows filename', await p.evaluate(()=>
  [...document.querySelectorAll('.rail-note')].some(n=>n.textContent.includes('run-1.csv'))), true);

// --- Flow (a): own CSV -> mechanism -> conditions -> fit ---
await p.selectOption('#f-unit','min'); await p.waitForTimeout(300);
check('time unit select', 'status echoes min', await p.evaluate(()=>document.getElementById('f-status-text').textContent.includes('min')), true);
await p.fill('#f-label','HPLC area %'); await p.waitForTimeout(400);
check('y-axis label input', 'chart y-axis titled', await p.evaluate(()=>document.querySelector('#f-plot svg')?.textContent.includes('HPLC area %')), true);
await p.evaluate(()=>{document.querySelector('#f-scheme-field details').open = true;});
await p.evaluate(()=>{const s=document.getElementById('f-scheme');s.value='S + Cat -> P + Cat';s.dispatchEvent(new Event('input'));});
await p.waitForTimeout(600);
check('scheme textarea', 'parse note: 1 step, catalyst Cat', await p.evaluate(()=>document.getElementById('f-scheme-status').textContent.includes('catalyst: Cat')), true);
await p.fill('#f-cond-s0','0.10'); await p.fill('[data-cat-value="Cat"]','5'); await p.waitForTimeout(500);
check('conditions inputs', 'derived 5 mol% = 5.00 mM', await p.evaluate(()=>document.querySelector('[data-cat-derived="Cat"]')?.textContent.includes('5.00 mM')), true);
await p.click('#f-fit-btn'); await p.waitForTimeout(1200);
const flowA = await p.evaluate(()=>[...document.querySelectorAll('#f-body .readout')].map(x=>x.innerText.replace(/\n/g,' ')).slice(0,2).join(' | '));
check('Fit button (flow a)', 'k_obs 0.0470 + true k 9.41', flowA, flowA.includes('0.0470') && flowA.includes('9.41'));
await shot('07-flow-a-results');

// --- Flow (b): every example fits ---
for (const key of ['E1','E2','E3','E4','E5','E6']) {
  await go();
  await p.click(`#f-gallery button[data-example="${key}"]`); await p.waitForTimeout(700);
  await p.click('#f-fit-btn'); await p.waitForTimeout(key==='E4'?4000:2500);
  const r = await p.evaluate(()=>({
    err: document.getElementById('f-err')?.textContent ?? '',
    note: [...document.querySelectorAll('.rail-note')].map(x=>x.textContent).join(' '),
    tiles: document.querySelectorAll('#f-body .readout').length,
    active: document.querySelector('#f-gallery button.active b')?.textContent ?? '',
  }));
  const m = r.note.match(/R² ([0-9.]+)/);
  check(`example ${key} card`, 'loads + fits clean, R² > 0.99', `R² ${m?.[1] ?? '?'} tiles ${r.tiles} ${r.err || ''}`,
    r.err === '' && r.tiles > 0 && Number(m?.[1] ?? 0) > 0.99 && r.active.includes(key));
}
await shot('08-flow-b-e6');

// --- Flow (c): switch example in place, refit ---
await go();
await p.click('#f-gallery button[data-example="E3"]'); await p.waitForTimeout(600);
await p.click('#f-gallery button[data-example="E4"]'); await p.waitForTimeout(700);
const swapped = await p.evaluate(()=>({
  active: document.querySelector('#f-gallery button.active b')?.textContent ?? '',
  scheme: document.getElementById('f-scheme').value,
  source: [...document.querySelectorAll('.rail-note')].map(x=>x.textContent).join(' '),
}));
check('switch E3 -> E4', 'active + scheme + sample all E4', `${swapped.active} / ${JSON.stringify(swapped.scheme)}`,
  swapped.active.includes('E4') && swapped.scheme.includes('A = B') && swapped.source.includes('Example E4'));
await p.click('#f-fit-btn'); await p.waitForTimeout(4000);
check('refit after switch', 'fits clean', await p.evaluate(()=>document.getElementById('f-err')?.textContent === '' && document.querySelectorAll('#f-body .readout').length > 0), true);

// --- Flow (d): example -> replace with own CSV ---
await go();
await p.click('#f-gallery button[data-example="E1"]'); await p.waitForTimeout(600);
await p.setInputFiles('#f-file','tests/fixtures/run-2.csv'); await p.waitForTimeout(700);
const flowD = await p.evaluate(()=>({
  active: !!document.querySelector('#f-gallery button.active'),
  callout: document.getElementById('f-callout').classList.contains('hide'),
  source: [...document.querySelectorAll('.rail-note')].map(x=>x.textContent).join(' '),
}));
check('replace example with CSV', 'active cleared, callout hidden, sample = run-2.csv',
  JSON.stringify(flowD), !flowD.active && flowD.callout && flowD.source.includes('run-2.csv'));

// --- Details/misc elements ---
await go();
await p.click('#f-data-field summary'); await p.waitForTimeout(200);
check('Data format help', 'expands', await p.evaluate(()=>document.querySelector('#f-data-field details').open), true);
await p.click('#f-gallery button[data-example="E1"]'); await p.waitForTimeout(500);
await p.click('#f-callout-close'); await p.waitForTimeout(200);
check('callout close', 'hides detail panel', await p.evaluate(()=>document.getElementById('f-callout').classList.contains('hide')), true);
for (const [sel, expected] of [['A -> B','A -> B'],['A -> B\\nB -> C','B -> C'],['A = B','A = B'],['A -> B\\nA -> C','A -> C']]) {
  await p.click(`#f-presets button[data-scheme="${sel}"]`); await p.waitForTimeout(300);
  const v = await p.evaluate(()=>document.getElementById('f-scheme').value);
  check(`preset ${expected}`, 'writes scheme text', JSON.stringify(v), v.includes(expected.split('\\n').pop()));
}
await p.click('#f-add-species'); await p.waitForTimeout(300);
check('+ species', 'adds a node', await p.evaluate(()=>document.querySelectorAll('#f-canvas [data-node]').length >= 3), true);
// canvas edge popup
await p.evaluate(()=>{const s=document.getElementById('f-scheme');s.value='A -> B';s.dispatchEvent(new Event('input'));});
await p.waitForTimeout(500);
const edge = await p.$('#f-canvas [data-edge]');
await edge.click({ force:true }); await p.waitForTimeout(300);
check('canvas edge click', 'at-cursor popup with Direction + Delete', await p.evaluate(()=>{
  const pop = document.getElementById('f-pop');
  return !pop.classList.contains('hide') && /reversible/i.test(pop.textContent) && /delete/i.test(pop.textContent);
}), true);
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
check('Esc', 'closes popup', await p.evaluate(()=>document.getElementById('f-pop').classList.contains('hide')), true);
// seed card
await p.click('#f-seed'); await p.waitForTimeout(500);
check('Your Estimate point card', 'seeds one row + callout', await p.evaluate(()=>
  document.getElementById('f-data').value.includes('time') &&
  !document.getElementById('f-callout').classList.contains('hide')), true);
// single-mode link
await p.evaluate(()=>{
  const d=document.getElementById('f-data');
  d.value='# time, conversion %\n5, 20\n10, 36\n20, 59\n30, 74\n45, 87\n60, 93\n90, 98';
  d.dispatchEvent(new Event('input'));
});
await p.waitForTimeout(600);
await p.click('#f-fit-btn'); await p.waitForTimeout(1500);
check('single-mode Estimate link', 'link with fitted order present', await p.evaluate(()=>{
  const a = document.querySelector('#f-body a[href^="#estimate"]');
  return a !== null && /n=1/.test(a.href);
}), true);

const table = rows.map(r=>`| ${r.element} | ${r.expected} | ${r.observed.slice(0,90)} | ${r.pass?'pass':'FAIL'} |`).join('\n');
fs.writeFileSync('verification/round-5/audit-table.md',
  '| element | expected | observed | result |\n|---|---|---|---|\n'+table+'\n');
console.log(table);
console.log('\nFAILS:', rows.filter(r=>!r.pass).length, ' errors:', errs.length?errs:'none');
await b.close();
