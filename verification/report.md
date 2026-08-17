# Verification report

Persona: 4th-year organic chemistry PhD student, Pd-catalyzed coupling, HPLC time
course, wants a rate constant with thesis-ready units. Browser driven with Playwright;
screenshots in `verification/round-1/`.

## Fixtures

`tests/fixtures/run-1.csv` and `run-2.csv`, generated from the stated ground truth:

| | run-1 | run-2 |
|---|---|---|
| reaction | S + Cat -> P + Cat | same |
| k (true) | 0.16 M⁻¹ s⁻¹ | 0.16 M⁻¹ s⁻¹ |
| [S]₀ | 0.10 M | 0.10 M |
| loading | 5 mol% ([Cat] = 5.0 mM) | 10 mol% ([Cat] = 10.0 mM) |
| k_obs = k[Cat] | 8.0e-4 s⁻¹ = 4.8e-2 min⁻¹ | 1.6e-3 s⁻¹ = 9.6e-2 min⁻¹ |
| t½ | 14.44 min | 7.22 min |
| points | 15 over 0 to 60 min | 11 over 0 to 30 min |
| noise | 2% multiplicative | 2% multiplicative |

Columns are `time, S, P`; the header row names the species, which is how the app maps
data columns onto the mechanism.

## Round 1

Steps driven: fresh load, paste run-1, set time unit, type `S + Cat -> P + Cat`, enter
[S]₀ and 5 mol%, read constants, switch the catalyst entry to molar, retype the
mechanism as reversible with `<->`, then repeat on run-2.

### Defects found and fixed

| # | Defect | Fix | Re-verified |
|---|---|---|---|
| 1 | Fit threw `scheme.catalysts is not iterable`: the web layer's `parsedScheme()` returned only `{species, steps}` and did not mirror the engine's new `Scheme` shape. | `parsedScheme()` now carries `catalysts`, empty case included. | yes, `03-mechanism.png` |
| 2 | Fixture is in minutes; the time-unit selector defaults to hours, so the status line read "t 0 to 60.0 h" for minute data. Not a code fault (the control exists) but it is a real trap. | Logged, not code-changed. Open UX item: the unit should be inferable from a `time_min`-style header, or prompted on first paste. | n/a |
| 3 | Unit labels rendered upper case (`MIN⁻¹`, `M⁻¹·MIN⁻¹`): `.readout .k` applies `text-transform:uppercase`, and the `.lit` guard loses on specificity when used as a second class on the same element rather than as a nested span. | Unit text wrapped in `<span class="lit">`. | yes, `07-units-fixed.png` |

### Result after fixes

Both fixtures, entered exactly as the persona would:

```
run-1, 5 mol%:   5 mol% of 0.100 M = 5.00 mM
                 k obs  S to P   0.0470   min⁻¹
                 k      S to P   9.41     M⁻¹·min⁻¹
                 rate = k[Cat][S]   (k_obs = k[Cat])

run-2, 10 mol%:  10 mol% of 0.100 M = 10.0 mM
                 k obs  S to P   0.0953   min⁻¹
                 k      S to P   9.53     M⁻¹·min⁻¹
```

### Hand-verified unit arithmetic

The fit works in the data's own time unit, minutes, and says so in every label.

    k_obs (fitted, run-1) = 0.0470 min⁻¹
    truth                 = 4.80e-2 min⁻¹        error -2.1%, at the 2% noise level

    [Cat] = 5 mol% x 0.10 M = 0.005 M = 5.00 mM   (shown in the UI, not hidden)

    k = k_obs / [Cat] = 0.0470 min⁻¹ / 0.005 M = 9.41 M⁻¹ min⁻¹

    convert to the thesis unit:
    9.41 M⁻¹ min⁻¹ / 60 s min⁻¹ = 0.157 M⁻¹ s⁻¹   truth 0.16 M⁻¹ s⁻¹, error -2.1%

Independent check of the division, which is the part that could silently be wrong: the
two runs differ only in catalyst loading, so a correct k must be loading-independent.

    run-1 (5.0 mM):  9.41 M⁻¹ min⁻¹  = 0.1568 M⁻¹ s⁻¹
    run-2 (10.0 mM): 9.53 M⁻¹ min⁻¹  = 0.1588 M⁻¹ s⁻¹
    spread 1.3%, both within the injected noise of the true 0.16 M⁻¹ s⁻¹

Units follow each step's molecularity, not a hardcoded string:

    A -> B              first order, order 1  ->  min⁻¹
    S + Cat -> P + Cat  as written,  order 2  ->  M⁻¹·min⁻¹
    (general)           order n                ->  M^(1-n)·time⁻¹

The fitted quantity is always pseudo-first order (the engine integrates dc/dt = M(k)c),
so k_obs is reported in reciprocal time and the derived k in the molecularity's units,
with the assumed rate law printed beside them.

### Reversible catalytic step

`S + Cat <-> P + Cat` parses and fits, producing four tiles (k_obs and k for each
direction) with the catalyst carried through both directions. Screenshot
`06-reversible.png`.

## Round 2

Full persona walkthrough with real file uploads (`setInputFiles`), covering all nine
work items. Screenshots in `verification/round-2/`.

### Steps and outcomes

1. Fresh load: empty-chart placeholder with muted axes, centred
   "Upload your time-course data to populate this chart", Upload CSV button, drop
   target. Rail shows step 1 current. `01-fresh.png`
2. Upload `run-1.csv` through the real file input: chart replaces placeholder in the
   same frame; rail advances to "done: Your data, Sample: run-1.csv, 15 points,
   2 species". `02-uploaded.png`
3. Upload `run-2.csv`: rail sub-label flips to "Sample: run-2.csv" immediately, no
   reload. Back to run-1 for the rest.
4. Typed mechanism. `S + Cat <-> P + Cat` gives the live note
   "2 steps, catalyst: Cat"; the broken line `S + -> P` gives a legible error quoting
   the offending line; the cheat-sheet is visible beside the box while typing.
   `04-mechanism.png`
5. Arrow popup at the cursor (anchored at the click point, e.g. left 381px top
   305px): Direction group with Make reversible / Reverse direction, then a separated
   Delete step; on a two-way arrow the one-way choice names both directions
   ("Keep only S to P" / "Keep only P to S"). Esc closes. `05-popup.png`
6. Conditions: [S]0 = 0.10 M and 5 mol% shows "5 mol% of 0.100 M = 5.00 mM".
   `06-conditions.png`
7. Results: k obs 0.0470 min^-1 and k 9.41 M^-1 min^-1 with the rate law printed.
   `08-results.png`
8. Typography audit: no HTML text below 12px anywhere in the app (computed styles).
9. Arrowheads at 200% (deviceScaleFactor 2): mirrored heads on the reversible edge,
   tips exactly at the line ends, no stray corners, head proportionate to node
   labels. `09-arrowheads-2x.png`
10. Cross-page geometry: Estimate text input and Fit status input both 34px tall;
    Estimate chip and Fit compact chip share the chip spec. Estimate and Learn render
    unchanged under the new tokens. `10-estimate.png`, `11-learn.png`
11. Mobile 390px: zero horizontal overflow, all tabs console-clean.

### Defects found and fixed in round 2

| # | Defect | Fix |
|---|---|---|
| 4 | Editing a catalytic arrow on the canvas silently erased the catalyst: the edge round-trip (`pairEdges` to `textFromEdges`) rewrote `S + Cat -> P + Cat` as `S = P`, which also hid the Conditions step. Found because the popup test left the persona with no way to enter [Cat]. | Edges carry their catalysts; regenerated text restores them, and reversible steps are now written with the chemist's `<->` rather than `=`. Re-verified: Make reversible yields `S + Cat <-> P + Cat`. |

## Status by work item

| Item | State |
|---|---|
| 1 layout tokens | done: spacing one-offs mapped to the u-scale, controls on the Estimate spec (34px inputs), Fit back on the shared 720px measure |
| 2 empty-state chart | done: placeholder in the chart's own 720 x 330 frame, CTA + upload + drop, no layout shift on swap |
| 3 left stepper | done: sticky rail ≥1100px mirroring the numbered sections, clickable, sample sub-label, live recompute |
| 4 signal input | done: labelled "y-axis label" with example placeholder; column-to-species mapping stated in the format help |
| 5 at-cursor popup | done: anchored menu, Direction group, separated Delete, Esc/click-away, keyboard focus |
| 6 typed-mechanism syntax | done: parser + cheat-sheet + live parse note with quoted offending line |
| 7 arrowheads | done: per-edge markers, tip at line end, head scales with stroke |
| 8 type scale | done: 7 tokens, nothing below 12px, same-role sizes identical by construction |
| 9 catalytic units | done: mol% or molar, conversion shown, k obs + true k with molecularity-derived units, rate law printed |

## Round 3 (design-review gate)

An independent reviewer examined the round-2 captures and returned 20 findings, three
of them blockers. All three are fixed; the should-fix list is addressed except where
noted.

### Blockers

| # | Finding | Fix |
|---|---|---|
| 1 | Two screenshots were byte-identical, so the conditions state and the results state had no separate evidence; full-page capture also let the sticky masthead paint mid-page. | Round 3 captures each state separately with element-clipped screenshots (`elementHandle.screenshot`), which sticky chrome cannot overpaint. `02-conditions-blank.png` and `03-conditions-filled.png` are now distinct states, verified by differing MD5. |
| 2 | A reversible step was drawn as one double-headed arrow. To an organic chemist that is resonance, not equilibrium. The pair label also did not say which constant was forward. | Reversible edges now draw two opposing arrows offset either side of the axis (verified: 2 shafts with `marker-end`, 0 with `marker-start`), and the label reads `-> 0.0477  <- 0.000497`. |
| 3 | The rate-law line was garbled, rendering k_obs as mixed sub- and superscript characters. | Rebuilt with real markup, `k<sub>obs</sub>`, styled in the theme. |

### Should-fix addressed

- Rail badges now carry done/current colours (the `.stage-n` rules only matched inside
  `.stage`, so the rail's badges were always grey).
- Result tiles adopt the Estimate anatomy: unit inline with the value rather than on
  its own line.
- Empty-chart grid faded to 45% with the call to action on a clear panel, so it no
  longer reads as a broken spreadsheet.
- Arrow shafts stop one head-length short of the tip, removing the protruding stubs.
- Residual plot labels its extremes and names what it plots (observed minus model).
- Fit headline left-aligned, matching Estimate.
- The y-axis label input widened so its placeholder is no longer clipped.
- Canvas copy says "click", not "tap": this is a mouse-driven desktop app.
- The Estimate coach mark restyled so it no longer looks like a primary button.
- [S]0 precision now echoes what was typed rather than reformatting it.

### Deliberately not changed

- Reviewer item 4 (Estimate annotation collides with the curve) and items 15, 17, 20
  are on the Estimate page, outside the nine work items; logged for a separate pass.
- Reviewer item 19 (the "Clear" chip is enabled when there is nothing to clear) is
  cosmetic and outside the listed items.

## Round 4 (user feedback batch)

Six items of direct user feedback, each verified in the browser after the change.

1. **Explicit Fit button.** The fit no longer runs on every keystroke. Once data and a
   scheme are present, the results stage shows a Fit button ("Solves the scheme's rate
   equations and finds the constants by least squares over every point, species and
   run"). A key over the raw data and scheme text decides whether the cached solution
   still applies: editing the data or the mechanism brings the button back; editing
   conditions, units, or labels re-renders from the cached solution, because those are
   not fit inputs (verified: after fitting, entering [S]0 and mol% updated the true-k
   tile with no button reappearing; editing the scheme cleared the results and
   restored the button; refit succeeded).
2. **Example cards show their mechanism.** Each card carries a small node-and-arrow
   diagram in the canvas's visual language: A to B, the reversible pair as two
   opposing arrows, chains as rows, the branched case drawn as B from A to C. Chains
   are detected on the undirected edge graph, so reversible chains lay out as rows
   rather than rings. Hidden in the compact chip state. `05-cards-2x.png`
3. **Type scale up one notch.** Tokens now 13/14/16/18/21/24/28; chart ticks 14px,
   axis titles 16px, canvas node letters 14px, nothing below 13px.
4. **Arrowheads rebuilt as explicit barbed polygons.** No SVG markers: the head is a
   swept-back barb drawn at the exact tip, the shaft tucks into its notch, so there is
   no flat shoulder and no protruding stub, at any stroke width. The same primitive
   draws the canvas and the card diagrams. `06-canvas-labels-2x.png`
5. **Canvas brought down to text scale.** The diagram's on-screen width now tracks its
   drawn size at roughly 1:1 (200 to 340px), so a two-node scheme no longer towers
   over the body text; node letters match body size. The equilibrium pair label is
   anchored at its arrow-facing end and grows outward, clear of both shafts.
6. **Fit statistics beyond R squared.** The results row now reports SSE (the minimised
   loss), RMSE with its units stated per mode (signal units for network fits; the time
   unit for single-species fits, whose residuals are time-domain, t minus g/K), and
   the point count. Fixture run-1: SSE 8.46e-5, RMSE 0.00168 signal units over 30
   points.
7. **Static input frame.** The data textarea is fixed at 200px (verified unchanged
   before and after upload); the status line's text no longer pushes the time-unit and
   label controls around.

Battery after the batch: 376 tests green, typecheck clean, prose guard clean, zero
console errors and zero horizontal overflow at 1440, 1100 and 390px, single-species
mode fits through the same button (order 1.029 on first-order test data), rail states
correct. A t = 0 row in single mode surfaces the engine's long-standing typed error
beside the button rather than silently failing.

## Round 5 (examples feature brief, seven work items)

### Inventory

- Example cards: static markup in `web/index.html` (`#f-gallery`, one `<button
  data-example>` per example plus the `#f-seed` card); content (scheme, callout,
  CSV data) in the `GALLERY` object in `web/fit.js`; loading one writes the data
  textarea, the scheme textarea, and the unit select, then re-renders.
- Scheme thumbnails: generated at mount by `miniScheme()` from each example's own
  scheme text, drawn with the same barbed-arrow primitive as the canvas.
- Left nav: `#f-rail`, built by `setStages()`, `scrollIntoView` on click.
- Upload affordances found: the "Upload CSV" chip (canonical) and a second
  uninitialized upload block inside the empty-state chart at the bottom (removed).

### Root causes, measured before fixing

| Item | Measured defect | Cause | Fix |
|---|---|---|---|
| 1 | Art slot offset 13px on six cards, 25px on one; slots could drift because each card's internals were hand-maintained markup | No structural template; button UA layout | Cards rebuilt at mount from one template: art slot (fixed 34px), title, description, as a top-aligned flex column. Offsets now 13,13,13,13,13,13,13. |
| 2, 6 | E3 and E6 shared the scheme `A -> B; B -> C`; no example had a cycle or hub | E6 was "E3 with worse data": distinct pedagogy, identical topology | E6 replaced by a photocycle: `A -> B, B -> C, C -> A, C -> D`. Cycle A-B-C, hub C (touches B, A, D), off-cycle branch D. |
| 3 | Empty-state chart carried its own Upload CSV button and drop target at the page bottom | Leftover from an earlier brief | Removed (markup, styles, listeners). One upload affordance remains; a loaded example shows "Sample: Example E6" in the rail. |
| 4 | Rail clicks landed sections at 0px, under the 58px sticky masthead | No scroll offset compensation | `.stage{scroll-margin-top:74px}`. All rail targets now land at 74px, heading fully visible. |
| 5 | Data box 593px empty, 720px loaded (127px jump) | Inside the rail grid, the measure's auto side margins disable grid stretch, so the column shrinks to fit-content and tracks content width | `#v-fit .measure{width:100%}` inside the grid media query. Now 720 to 720, no shift. |
| 7 | After loading an example the tab strip collapsed to text chips (schemes hidden), no active state, callout was plain text | Compact mode hid the art; no selection state existed | Compact chips keep their scheme art inline; the loaded card carries `.active`; the callout is a detail panel: art, title, description, mechanism text. |

### The new example (item 2)

`E6 · Photocycle with a trap`: `A -> B`, `B -> C`, `C -> A`, `C -> D` at
k = 0.45, 0.4, 0.35, 0.05 per h. A fully irreversible thermal cycle would violate
detailed balance (Wegscheider's condition: around any cycle the product of forward
constants must equal the product of reverse constants at equilibrium), so the example
is framed as light-driven, where that constraint does not bind; the bacteriorhodopsin
photocycle is the canonical precedent. Data synthesized by RK4 from those constants
with seeded sigma = 1 noise, 17 points over 72 h like every other example. The app
fits it back to 0.445, 0.396, 0.345, 0.0495 (all within 1.1 percent), R squared 0.998,
in under a second, with no ambiguity warning. Locked by `tests/gallery.spec.ts`,
which also enforces that no two examples ever share a scheme again.

### Example 3 vs example 6 decision

Replaced. E6's purpose (noise robustness) was real but lived entirely in the data;
its scheme duplicated E3's, and in a scheme-first card language two identical
diagrams read as a bug. The slot now carries the missing complex topology, and the
noise lesson was retired deliberately rather than left ambiguous.

### Interaction audit (one clean pass, zero defects)

| element | expected | observed | result |
|---|---|---|---|
| Load sample chip | loads E1, active card, detail panel | true | pass |
| Clear chip | empties box, clears active and callout | true | pass |
| Upload CSV chip | opens file chooser | chooser opened | pass |
| file input | rail shows run-1.csv | true | pass |
| time unit select | status echoes min | true | pass |
| y-axis label input | chart titled | true | pass |
| scheme textarea | parse note names catalyst | true | pass |
| conditions inputs | 5 mol% = 5.00 mM shown | true | pass |
| flow a: upload+scheme+cond+Fit | k_obs 0.0470, k 9.41 | k obs S→P 0.0470min⁻¹ / k S→P 9.41M⁻¹·min⁻¹ | pass |
| nav button estimate | switches view | view shown | pass |
| nav button learn | switches view | view shown | pass |
| nav button fit | switches view | view shown | pass |
| example E1 | fits clean, R² > 0.99, active card | R² 0.9995, 4 tiles  | pass |
| example E2 | fits clean, R² > 0.99, active card | R² 0.9997, 5 tiles  | pass |
| example E3 | fits clean, R² > 0.99, active card | R² 0.9997, 5 tiles  | pass |
| example E4 | fits clean, R² > 0.99, active card | R² 0.9991, 9 tiles  | pass |
| example E5 | fits clean, R² > 0.99, active card | R² 0.9993, 5 tiles  | pass |
| example E6 | fits clean, R² > 0.99, active card | R² 0.9978, 7 tiles  | pass |
| switch E3 to E4 | active, scheme, sample all follow | E4 · Four-species chain / "A = B\nB = C\nC = D" | pass |
| refit after switch | fits clean | true | pass |
| replace example with own CSV | active cleared, callout hidden, sample run-2.csv | {"active":false,"hidden":true,"source":"Sample: run-2.csv 11 points, 2 species 1 | pass |
| Data format help | expands | true | pass |
| detail panel close | hides | true | pass |
| preset A -> B | writes scheme | "A -> B" | pass |
| preset A -> B; B -> C | writes scheme | "A -> B\nB -> C" | pass |
| preset A = B | writes scheme | "A = B" | pass |
| preset A -> B; A -> C | writes scheme | "A -> B\nA -> C" | pass |
| + species chip | adds node | true | pass |
| canvas edge click | popup: Direction + Delete | true | pass |
| Escape | closes popup | true | pass |
| Your Estimate point card | seeds row + callout | true | pass |
| single-mode Estimate link | carries fitted order | true | pass |

Flows verified end to end: (a) fresh, upload own CSV, type catalytic mechanism,
enter conditions, Fit: k_obs 0.0470 min⁻¹, k 9.41 M⁻¹·min⁻¹. (b) each of the six
examples loads and fits with R squared above 0.99 and its card active. (c) switching
E3 to E4 swaps scheme, sample label and active state in place, then refits clean.
(d) replacing a loaded example with an uploaded CSV clears the active card and the
detail panel and shows the file name as the sample.

Battery: 381 tests green (5 new in `tests/gallery.spec.ts`), typecheck clean, prose
guard clean, zero console errors, zero horizontal overflow at 1440, 1100, 390px.

### Independent design review (round 5 gate)

An independent reviewer read all eight round-5 captures against the acceptance
criteria and returned GATE: PASS with zero blockers, four should-fixes and five
nits. Actions taken:

| # | Finding | Action |
|---|---|---|
| 1 | RMSE's "signal units" label wrapped with "units" orphaned on its own line | Unit spans no longer break internally (`white-space:nowrap`); verified a single box in the live DOM |
| 2 | E6 callout quoted constants without units | Now "0.45, 0.4, 0.35 h⁻¹ ... 0.05 h⁻¹" |
| 3 | Canvas arrow constants were bare numbers | Every arrow label now carries the reciprocal time unit, e.g. "0.445 h⁻¹" |
| 4 | Screenshot 02 showed E6 with a stale cramped thumbnail disagreeing with 05/06 | Stale capture, not a live defect: 02 predated the arc layout; re-shot, states agree |
| 5 | Detail panel printed ASCII arrows in serif type | Mechanism line renders real glyphs: A → B · B → C · C → A · C → D, ⇌ for reversible |
| 8 | SSE had no unit | Now "signal²" (network) or the time unit squared (single mode) |
| 9 | Y-axis placeholder clipped mid-word | Input widened; scrollWidth check confirms no clipping |
| 6, 7 | Nits: compact E6 arc reads small; residual tick labels near the size floor | Acknowledged, left: mini-scheme letters are decorative (aria-hidden, title repeats identity) and chart text sits at the token floor |

After fixes: 381 tests green, prose guard clean, zero console errors on the re-shoot.

## Round 6 (CSV headers, mass balance, labeling, drag-to-connect, export)

### Inventory

- CSV parsing: `parseInput` in `web/fit.js`; cells were split by `/[\s,;\t]+/`, the
  root cause of multi-word headers shattering. Now `smartCells` in `src/lib/csv.ts`:
  delimiter-only splitting with RFC 4180 quote handling, whitespace fallback only for
  delimiter-free lines.
- Node map: `drawCanvas` in `web/fit.js`; examples: `GALLERY` + `#f-gallery` markup;
  results: `renderNetwork`/`renderSingle`; export: none existed.
- Fixture: `tests/fixtures/tricky-headers.csv`, 14 rows, branched kinetics
  SM -> P1 (0.03 min⁻¹) and SM -> adduct (0.015 min⁻¹), 1.5 percent noise, mass
  balance near 100.

### Work items

| # | What changed | Verified |
|---|---|---|
| 1 | `smartCells` (comma/tab/semicolon-only, quoted fields, whitespace fallback); detected-columns notice under the status line lists time + every column as parsed | Fixture yields S1 = Starting Material, S2 = Product 1, S3 = 5-bromo-2-methylpyridine adduct, one node each; quoted-comma headers covered in `tests/csv.spec.ts` |
| 2 | `src/lib/massBalance.ts`: name route (documented variants, units stripped) + numeric route (row-wise sum, or constant near 100); balance columns get no node, are excluded from fit, plot as muted points labeled "· balance"; column chips toggle the override both ways | "Mass Balance (%)" flagged; chart shows S4 · balance; override 4 -> 3 nodes and back; 15 name variants + heuristics in `tests/massBalance.spec.ts` |
| 3 | E6 renamed "Complex 2D network", copy free of photochemistry; thumbnails now carry intrinsic width/height (1:1 with their coordinate systems) | No photo/light/bleach terms anywhere; aspect ratio actual/intrinsic = 1.00 for all 7 cards |
| 4 | User upload collapses examples (label becomes a toggle), clears the example scheme so no ghost nodes linger; example click over user data asks first | Fixture upload: gallery hidden, "Examples ▸"; E1 click shows confirm, dismiss keeps data, accept replaces |
| 5 | Display-name system: names over 5 chars become S1, S2, ...; legend under the map; SVG tooltips carry full names; chart, conditions, tiles, popup all use the same names; scheme grammar gained quoted species ("Starting Material" -> "Product 1") so real headings round-trip | No text escapes any circle; legend + tooltip verified; quoted grammar in `tests/csv.spec.ts` |
| 6 | Results tiles: value and unit are wrapping flex items (a same-rule `display:inline-block` had been overriding it), labels wrap anywhere, tiles use display names with full names in tooltips | E4's 9 tiles and the fixture's long names: zero overflowing tiles at 1440, 1100, 390px |
| 7 | Node popup removed; selection actions live in the guide bar under the map; hover shows a + handle on the node rim; dragging draws a dashed preview and releasing on a node writes the step; edge popup unchanged | Adjacent and far drags both connect with the popup hidden throughout; edge popup and Esc still work; hover jitter 0.0px after the overlay fix |
| 8 | `src/lib/export.ts`: sectioned CSV (raw data, fitted curves, constants with units) + STORE zip; graph as SVG + 3x PNG via var()-resolved serialization | All three buttons download; PNG 2160 x 990; zip opens with unzip, 3 entries; CSV constant 0.0303 min⁻¹ matches the tile |

### Defects found and fixed this round

| # | Defect | Fix |
|---|---|---|
| 1 | PNG export never produced a file: computed font stacks contain double quotes, and substituting them into double-quoted SVG attributes produced malformed XML the rasterizer refused to load | var() substitution flips embedded double quotes to single quotes |
| 2 | Hovering a node made the whole map shift by a few pixels: the + handle joined the drawing before the frame refit, growing the bounding box and rescaling everything under the pointer (which also made click targets move mid-gesture) | The handle and drag preview render as an overlay appended after the frame is fitted; the canvas allows visible overflow for rim handles |
| 3 | One results tile (RMSE) still overflowed after the flex fix: the same `.readout .v` rule carried a later `display:inline-block` that silently won | Conflicting declaration removed; flash box keeps its shrink-wrap via width:fit-content |
| 4 | The seed card's point art had no intrinsic size, rendering at UA default proportions | width/height attributes, like every other thumbnail |

### Verification pass (final, zero defects)

- Fixture upload: notice correct, 3 nodes, S-IDs in circles, legend, tooltip = full
  name, examples collapsed, no MB node, MB dots plotted muted.
- Balance override: unmark -> 4 nodes, remark -> 3.
- Drag-to-connect: adjacent (S1 to S2) and far (S1 to S3) both write quoted steps;
  dashed preview live; the popup stayed hidden throughout; node click selects with
  Remove/Cancel in the guide bar; Esc and the arrow popup unchanged.
- Fit: k = 0.0303 and 0.0153 min⁻¹ against truth 0.03 and 0.015 (1 to 2 percent, at
  the noise level), R squared 0.9994.
- Exports: fit-graph.svg, fit-graph.png (2160 x 990), fit-data.csv, fit-export.zip
  (3 entries, opens cleanly); CSV values match the UI.
- E6: renamed, thumbnail undistorted, strip consistent (aspect 1.00 x 7).
- Battery: 407 tests green (26 new), typecheck clean, prose guard clean, zero console
  errors, zero page overflow at 1440, 1100, 390px; Estimate tiles unaffected.

### Independent design review (round 6 gate)

The reviewer returned GATE: FAIL with two blockers and eight further findings.

| # | Finding | Action |
|---|---|---|
| B1 | "points 42" collided with the RMSE unit in the results capture | Stale capture taken before the tile display-conflict fix; re-measured after it: zero overflowing tiles on the fixture's results; re-shot |
| B2 | The app parsed "time (min)" yet labeled the run in hours everywhere except the fit | Real, long-logged defect, now fixed: the time unit is inferred from the time column's heading (min/h/s patterns), once per new heading so the dropdown still wins manual changes. Status, chart axis, constants and export all agree on minutes for the fixture |
| 3 | Balance badge did not say it was clickable | Caption now ends "Click a column to change this." |
| 4 | Mixed Unicode/ASCII units; Excel garbles BOM-less UTF-8 | Export units are plain ASCII (min^-1, M^-1 min^-1) and the CSV ships with a UTF-8 BOM |
| 5 | Export lacked date, mechanism, RMSE | Header comments now carry the export date and the mechanism lines; constants gained RMSE (over fitted points, matching the tile exactly: 0.0005613) and the point count |
| 6 | E6 thumbnail circles judged smaller than E4's | Measured: node radii are 7.0 CSS px on all six cards; the impression came from E6's taller art box, not its scale. No change |
| 7 | Fitted-curves header dropped the S-IDs | Curve columns now headed "S1 = Starting Material" like the raw section |
| 8 | Curve grid finer than the data, 17-digit values | Values now 7 significant figures; the curve keeps its plotting grid (it is the drawn curve; residuals are reproducible from the constants). Deliberate |
| 9 | Y-axis placeholder clipped | Input widened again; scrollWidth check confirms it fits |
| 10 | Results panel had no ID legend of its own | The S-ID legend renders inside the results body whenever any name is shortened |

After fixes: unit agreement verified end to end (status, x-axis, tiles, export all
minutes), 407 tests green, typecheck and prose clean, zero console errors.

### Re-review verdict

GATE: PASS. The reviewer confirmed both blockers fixed (unit agreement across status,
axis, constants, export; tiles clean with units and an in-panel S-ID legend), verified
the BOM and ASCII units by hexdump, matched RMSE 0.0005613 and 42 points against the
screen, withdrew the E6 scale finding after measuring 7.0 px node radii on every card
(matching this side's measurement), and accepted the curve-grid choice as deliberate.

One contested nit survived and taught something: the y-axis placeholder really was
still clipped. The width overrides never applied, because `.field input[type=text]`
outweighs `.fstatus-controls input`; and the "does it fit" probe used scrollWidth,
which inputs do not grow for placeholder text. Fixed with an id-scoped width and
re-verified by measuring the placeholder text against the input's inner width
(124px text in 138px). Remaining acknowledged nit: "0.100" round-trips as "0.1",
inherent to numeric parsing; trailing-zero preservation would require carrying raw
strings through the whole pipeline.

### Post-gate polish (user feedback)

- Download buttons moved beside the results: the export row now renders directly
  under the constants tiles (and the S-ID legend when present), above the rate laws
  and residual plot, in both network and single modes.
- Example thumbnails enlarged to a readable size: rendered at 1.5x their coordinate
  system (node letters about 13.5px, at the type floor), art slot 60px. Compact
  chips scale content uniformly (zoom .72) instead of forcing one box height, so
  E6's taller cycle no longer renders smaller than its neighbours; measured node
  radii 7.6px on every chip.

### Network depiction: magnitude in width and ink (user feedback)

Each directional arrow now encodes its own rate constant twice: stroke width on the
existing linear relative scale, and greyscale ink interpolated between a fixed light
floor rgb(178 184 198) and a fixed dark ceiling rgb(24 28 36), referenced against the
largest constant of the current fit. The fastest step reads heavy and near-black; the
slowest never fades below the floor. On-arrow labels dropped to two significant
figures (tiles and export keep full precision) and each number sits beside its own
shaft, on that shaft's side of the pair, so adjacency replaces the ambiguous
"-> x <- y" glyph label. Verified on E4: six shafts spanning rgb(24 28 36) at 3.4px
down to rgb(166 172 185) at 1.4px, labels 0.5 / 0.21 / 0.2 / 0.1 / 0.08 / 0.04 h⁻¹
each adjacent to its own arrow. Screenshot 09-greyscale-arrows.png.

### Canvas polish round (user feedback)

- Arrow labels are bare two-figure numbers; the unit is stated once, "k in h⁻¹", at
  the head of the map legend.
- "Remove E" fixed. Root cause: the document-level pointerdown handler cleared the
  selection for any press outside the popup or canvas, and the guide bar is outside
  the canvas, so pressing its Remove button deselected the node and rebuilt the bar
  (button and all) before the click could land. The guide bar is now exempt.
- The whole node is a drag source: pressing a node arms a drag that starts past a
  4px threshold, so a plain click still selects; the + handle stays as the visible
  hint and remains draggable itself. Two capture subtleties surfaced and were fixed:
  capturing at pointerdown retargets the composed click to the svg (breaking
  click-to-select), so capture now starts at drag promotion; and a captured drag
  whose press and release targets differ produces no click at all, so the
  suppress-next-click flag self-clears on a zero-timeout rather than waiting for a
  click that may never come. Verified: dragging B's body onto A writes "A <-> B",
  and a plain click immediately afterwards still selects.

## Round 7 (Estimate figure, precision, copy, what-ifs, canvas scale)

### Inventory

- Estimate figure: `web/estimate.js` (buildFigure) rendering through `web/curve.js`
  (drawCurve). Order label sites found: curve end labels (ghost orders and the live
  curve), the corner condition badge's "n = ..." row, and the spread strip's per-dot
  names. The spread strip is a separate captioned figure whose dots need identity,
  so "once per figure" is enforced on the main chart.
- Copy: the barrier note and the Q10 tile in `web/index.html`; a Q10 cross-reference
  on Learn.
- Formatters: page-local `fmtNum`/`fmtTrim`/`fmtSmart`/`pct` in `web/estimate.js`
  and a second `fmtNum` in `web/fit.js`, the duplication item 2 removes.
- Example networks: `drawCanvas` in `web/fit.js`; two species sat on a vertical
  ring axis, and a min-width clamp inflated sparse schemes.

### Work items

| # | Change | Verified |
|---|---|---|
| 1 | Kept: the per-curve legend-rail label (nearest the data). Removed: the badge's order row and the live curve's label suppression. All curve names now live in one staggered rail past the right plot edge, with a dotted leader for curves that finish mid-plot | Geometric audit at 1280, 1024, 620px: each of n=0, 0.5, 1, 1.5, 2 appears exactly once; zero label-label overlaps; zero label points inside any sampled curve path |
| 2 | `src/lib/format.ts`: fmtPercent (integers), fmtTime (2 to 3 sig figs), fmtTemp (whole degrees unless finer), fmtRate (3 sig figs, scientific extremes), fmtFactor, meaningfulChange. Estimate and the fit tiles both import it | No decimal percentage on the page; times like "2.3 h", "12 min"; fit tile "k A to B 0.35 h⁻¹" through the same fmtRate; 15 tests in `tests/format.spec.ts` |
| 3 | Rewritten, not cut: "Raising the temperature does not lower the barrier; it gives more molecules enough energy to cross it." One sentence, no tooltip | Cold-reader subagent review |
| 4 | Two readouts added where the page supports them: C₀ (halving, under the C₀ control) and target (90 to 99 cost, under the readouts). Temperature already existed. Both suppressed on negligible change, unreachable times, or an active temperature switch; both computed from the same params as the plotted curve | At n=1 the C₀ readout stays silent (concentration cancels); at n=2 it reads "6.8 h to 14 h" and its "from" equals the To-90% tile; live updates on input |
| 5 | Q10 gone everywhere (Estimate tile, Learn cross-reference). Now: "The rate constant increases about 1.9x for every 10 °C increase, near 25 °C.", unit written per the selected scale (10 K (= 10 °C); 18 °F (a 10 °C step)) | Recomputes with Ea: 1.9x at 50 kJ/mol, 3.7x at 100 kJ/mol, matching the Learn page's own stated factor; `q10 = arrheniusRatio(Ea, T, T+10)` asserted against exp(Ea/R (1/T - 1/(T+10))) in tests |
| 6 | Two-species schemes lay out left to right; the canvas renders 1:1 with its drawing (min-width clamp removed), so node size no longer inflates on sparse schemes | E1, E2 horizontal; measured node radius 16.00px on E1, E2, E4, E6 alike |

### Verification

Battery: 422 tests green (15 new in format.spec.ts), typecheck clean, prose guard
clean, zero console errors at 1280, 1024, 620px. Screenshots under
`verification/round-7/`.

### Cold-reader review (round 7 gate)

First pass: sentences A, B, C all judged clear, correct, and in the notebook
register (the reviewer independently re-derived the Arrhenius factors, 1.92x at
50 kJ/mol and 3.70x at 100 kJ/mol, and the n = 2 concentration arithmetic). One
blocker: the placement pass for time annotations dodged other labels and axis
furniture but not the plotted curves themselves, so "99% at 4.5 h" and neighbours
were struck through in the crowded views.

Fixes: curves are now first-class placement obstacles (Liang-Barsky segment-vs-box
tests over every sampled polyline reject any candidate position on a curve), all
annotation text and "your point" carry a surface halo so even forced placements
stay legible, sentence B became "increases by a factor of about 1.9" (the parse
trap), sub-minute times read in seconds, and the n = 2 screenshot was re-captured
from a clean state so it actually evidences the concentration sentences.

### Re-check verdict

GATE: PASS. The reviewer re-inspected all three regenerated captures at 3x zoom:
no annotation or label struck through anywhere; halo knockouts read as intended in
the crowded 66 °C switch view; the n = 2 capture evidences the concentration
sentences, whose numbers the reviewer re-derived analytically (t50 = 1/(kC0),
t90 = 9/(kC0), t99 = 99/(kC0)) and matched. Two observations noted as deliberate:
in the most crowded five-order view the placement cascade prefers dropping a
percentile annotation over forcing a collision (the values remain in the headline
strip), and the spread strip's stagger leaders are hairline-busy but never
overprint a glyph.

### Post-gate polish (user feedback)

- The candidate ghosts are three, not five: n = 0, 1 and 2, each keeping its fixed
  palette slot so the colours never reshuffle; the toggle reads "Any order fits one
  point. Show n = 0, 1 and 2."
- The promised ladder always renders: the page opens with "How long to 50%, 90%,
  99%?", so those three annotations now place forced (halo-protected) rather than
  dropping when the plot is crowded; only the unpromised 25 and 75 marks may yield.
  Verified present at 1280, 1024 and 620px. The 95% spread strip keeps its
  per-order time labels as before.
- Legend leaders shortened: a curve that finishes early is now named right beside
  its own endpoint (curve-dodging, halo-backed) instead of being wired across the
  plot to the rail; measured leader lengths dropped to 15 to 33px. Only curves that
  actually reach the right edge use the rail column.
