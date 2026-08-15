# Fit tab redesign plan: flagship multicomponent modeling

The tab is **Fit** (masthead button at `web/index.html:286`, section `#v-fit` at `:497`).
Its implementation is three files plus two touch points:

| File | Role |
|---|---|
| `web/fit.js` (538 lines) | all UI: parsing, both fit modes, charts, examples |
| `src/lib/network.ts` (473 lines) | scheme parser, RK4 simulator, Nelder-Mead fitter |
| `web/index.html:497-536` | markup: chips, data textarea, scheme textarea |
| `web/estimate.js` (`currentPoint`, `applyFittedOrder`) | the cross-tab handoffs |
| `web/app.js` (`mountFit`, `#estimate?n=` preset) | routing |

Target model for the redesign, per the brief:

    Y(t) = sum_i  y_i * c_i(t) + b (+ m*t)

with populations c(t) from a user-defined first-order network. Today's tab fits
per-species concentration columns directly (y fixed at identity); the redesign adds the
single-signal composite case and keeps today's case as the special case where the data
columns name the species.

---

## 1. Audit findings

### 1.1 Fitting reality check

**Synchronous, main thread, no worker anywhere** (`grep Worker` finds nothing). The
chain is: keystroke, then `debounce(render, 200)` (`fit.js:508`), then `renderNetwork`
(`:364`), then `fitNetwork` (`network.ts:307`), all synchronous. `fitNetwork` runs
**Nelder-Mead** (`network.ts:169`, 400 iterations) in log space with **multi-start x3**
(`:362`), and with replicates it refits **each block again** for the spread. Every
objective evaluation integrates by RK4 whose substep count scales with the fastest rate
(`:144`, up to 20,000 substeps per interval).

Measured (Node, this machine):

| Case | Time |
|---|---|
| Today's E3 example, 7 pts, 2 ks | 35 ms |
| One simulate, 2,000 pts, 4 species | 6 ms |
| Fit, 2,000 pts, 4-species reversible chain, 6 ks | **13,065 ms** |
| Fit, 800 pts, stiff (k spread 500x) | **36,908 ms** |
| Fit, 3 replicates x 400 pts | 12,780 ms |

So: **yes, the fit only looks instantaneous because the shipped examples are tiny.** At
2,000 points the page freezes for 13 seconds, and does it again on the next keystroke.
The recovered constants were correct to 4 decimals, so the math core is sound; the
execution model is not.

### 1.2 Species ceiling

The **engine has no cap**: `parseScheme`, `rateMatrix`, `simulate`, `fitNetwork` are
general-N, and the benchmark fit a 4-species chain with 6 rate constants. The ceiling
is entirely UX:

- Preset chips stop at three species (`index.html:521-525`).
- Examples stop at three species (`fit.js:448-467`).
- `COLOURS`/`DASHES` are 5 long and cycle by modulo (`fit.js:20-21`), so species 6
  repeats species 1's colour.
- No species-count control, no rename, no add-species anywhere.
- **No initial-composition UI at all** (confirmed: no markup for it). c0 is read
  silently from each block's first row (`network.ts:269`), with unmeasured sources
  inferred as fit parameters (`:339`). Correct behaviour, invisible to the user.
- Scheme textarea is styled for 3 rows (`index.html:527`).

### 1.3 Examples wiring (the two-tier confusion)

- Top chips `#f-examples` (`index.html:503-508`): each writes **both** textareas
  (`fit.js:514-522` sets `f-data` and `f-scheme` from `EXAMPLES` at `:448`), then
  rerenders. Nothing announces what changed.
- Clicking a **single-species** example additionally **hides the whole scheme field**
  (`fit.js:487` toggles `#f-scheme-field.hide`), so the lower half of the page
  disappears without explanation.
- Bottom chips `#f-presets` (`index.html:521`) write **only** the scheme textarea
  (`fit.js:531-536`). If the data does not match the new scheme's species, the user
  gets `The data has a column "X" that the scheme never mentions` with no pointer to
  which control caused it.
- Net effect on screen: top chips change two boxes and possibly delete a section;
  bottom chips change one box and possibly produce an error about the other. The
  confusion the brief names, confirmed.

### 1.4 Data parsing

`parseBlocks` (`fit.js:45-78`): blocks split on blank lines; delimiters comma,
semicolon, tab, whitespace (`:37`); `#` comments; header detected by any non-numeric
cell; headerless 2-column block = single-species conversion in percent (divided by 100
at `:69`); headerless 3+ columns = error asking for a header. Scientific notation
works. **Unsorted times are rejected** (`network.ts:322`), not sorted. **Malformed rows
are silently dropped** (`fit.js:57` filters them), so line-level errors are impossible
today. No decimal-comma handling. No parse status line; first feedback is a chart or an
engine error.

### 1.5 What works: "Start from your Estimate point"

`#f-seed` (`index.html:507`; handler `fit.js:523-529`) pulls the measured point from
Estimate via the exported getter `currentPoint()` (`estimate.js`), writes
`# time (min), conversion %` plus the point into the data box, focuses it, renders. The
reverse handoff exists too: `Send this order to Estimate` links `#estimate?n=1.30`,
routed in `app.js` to `applyFittedOrder`. The pattern to preserve and generalize:
**cross-tab state travels through small exported getters and appliers plus hash
presets, and seeded text carries its own format hint as a comment line.**

### 1.6 Fragile or surprising

1. Full fit (multi-start x3, plus per-replicate refits) on **every keystroke** in
   either textarea, synchronously.
2. Silently dropped malformed rows (worse than an error).
3. Single mode divides by 100; network mode takes values as entered; nothing says
   which convention is active.
4. `alignReplicates` is O(n^2) per species (`fit.js:250`).
5. Duplicate times within a run are rejected, so replicate *columns* in one block are
   impossible; replicates must be separate blocks.
6. Uncertainties come only from replicate spread; single runs get none (no JtJ SEs).
7. No cancel, no progress; negative R^2 rendered bare.
8. Build: `tsc` compiles to `dist/`, no bundler; the app is static ES modules.
   "Self-contained" holds in the no-bundler sense; the plan keeps it that way.

---

## 2. Proposed layout

One column, workflow order, persistent step strip. Estimate-first flow retained as
step 3.

    [ Fit ]  -------------------------------------------------------------
    | (1) Data   (2) Scheme   (3) Estimates   (4) Fit      step strip    |
    |  done       current      todo            todo                      |
    ----------------------------------------------------------------------
    | EXAMPLES  [E1 Single conversion] [E2 Reversible pair]              |
    |           [E3 Sequential intermediate] [E4 Four-species chain]     |
    |           [E5 Branched pathways] [E6 Real-world messy]             |
    |           [Start from your Estimate point]                         |
    ----------------------------------------------------------------------
    | (1) DATA                                                           |
    |  [textarea, ghost placeholder]    [Load sample][Upload CSV][Clear] |
    |  status: ok 86 points · t 0 to 3600 [s v] · signal 0.021 to 1.004 |
    |  [signal label: ______]                        > Data format help  |
    |  [ PLOT: points appear immediately on successful parse ]           |
    ----------------------------------------------------------------------
    | (2) SCHEME                                                         |
    |  Species [2][3][4][5][6][+]  names: [A][B][C] (editable, coloured) |
    |  Seeds: [Irreversible chain][Reversible chain][Branch][Trap]       |
    |  Rows:  [A v] [-> | <=>] [B v]   k1        [x]                     |
    |         [B v] [-> | <=>] [C v]   k2        [x]     [+ add step]    |
    |  Text:  A -> B  : k1                                               |
    |         B <-> C : k2, k3          (two-way synced)                 |
    |  [ SCHEME DIAGRAM: coloured nodes, arrows, k labels ]              |
    |  At t = 0 the sample is: A [100]%  B [0]%  C [0]%   [Normalize]    |
    ----------------------------------------------------------------------
    | (3) ESTIMATES                                                      |
    |  parameter table: name | value | fix/float | min | max             |
    |  (k1..kn log sliders, y_A..y_n, baseline b, drift m)               |
    |  [ PLOT: data + simulated overlay ] [ subplot: populations c(t) ]  |
    ----------------------------------------------------------------------
    | (4) FIT                                                            |
    |  [Fit] [Cancel]  multi-start [off|x20]  status: iter 143, SSR ...  |
    |  results: value ± SE table, R2, SSR, converged, wall time          |
    |  [ residuals subplot ]  [ populations at fitted params ]           |
    |  warnings: correlation, flip-flop, bounds                          |
    |  [Copy summary][Export CSV][Export JSON][Send to Estimate]         |
    ----------------------------------------------------------------------

## 3. Math core design

Pure, DOM-free TypeScript in `src/lib/`, imported unchanged by main thread (live
preview), worker (fits), and Node (tests). `network.ts` grows into this; nothing is
discarded (the RK4 becomes the oracle and the P1 bimolecular seed).

### 3.1 Types and signatures

```ts
interface Scheme { species: string[]; steps: { from: string; to: string }[] }

interface ModelParams {
  ks: number[];              // one per step, > 0
  c0: number[];              // fractions at t = 0, one per species
  y: number[];               // signal coefficient per species (identity for column data)
  b: number;                 // baseline
  m: number;                 // linear drift per unit time (0 unless floated)
}

simulate(scheme: Scheme, p: ModelParams, t: number[]):
  { populations: number[][]; observable: number[] }

interface FitOptions {
  float: Record<string, boolean>;
  bounds: Record<string, [number, number]>;
  multiStart?: number;              // 0 = off, else n perturbed restarts
  maxIterations?: number;           // default 300
  onProgress?: (iteration: number, ssr: number) => void;
  shouldCancel?: () => boolean;
}

fit(scheme: Scheme, guess: ModelParams, data: { t: number[]; y: number[] },
    opts: FitOptions):
  { params: ModelParams; se: Record<string, number>; corr: number[][];
    ssr: number; r2: number; iterations: number; converged: boolean;
    wallMs: number; warnings: string[] }
```

### 3.2 Propagator: eigendecomposition, with fallbacks

`c(t) = expm(K t) c0`. Cost argument: LM needs roughly 450 residual evaluations (50
iterations x 9 parameter perturbations). Stepwise Pade expm at 2,000 points costs 5 to
10 ms per evaluation, so 2 to 5 s per fit. Eigendecomposition costs one decomposition
per evaluation plus O(N^2) per point: about 0.2 ms per evaluation, under 100 ms per
fit. The eigen path is what makes live preview and sub-second fits real.

- Primary: balance, Householder Hessenberg, Francis double-shift QR for eigenvalues
  (complex pairs allowed; cycles produce them), eigenvectors by inverse iteration,
  then `c(t) = V diag(e^{lambda t}) V^{-1} c0` with a small complex-arithmetic helper.
  About 300 lines, N <= 8 only, no library.
- Fallback (degenerate or ill-conditioned V, cond above 1e8): stepwise
  scaling-and-squaring Pade-13 expm across sorted time intervals.
- Oracle: the existing RK4 `simulate` stays; a property test asserts eigen and RK4
  agree to 1e-9 on random schemes.

### 3.3 Variable projection: adopt

For fixed ks, `Y(t)` is linear in `(y, b, m)`. Solving those by linear least squares
inside every optimizer step (QR on an n x (N+2) matrix, microseconds) removes N+2
dimensions from the nonlinear search; for sums of exponentials that is the difference
between LM converging in tens of iterations and wandering. The nonlinear search runs
over log k only.

Column-mapped data (headers naming species) skips VARPRO: y is fixed identity and each
column contributes its own residuals, exactly today's behaviour.

**Uncertainties under VARPRO**: at the optimum, assemble the full Jacobian over all
floated parameters (log ks plus the linear ones), form `(JtJ)^{-1} * SSR/(n - p)` for
SEs and the correlation matrix. SEs on log k convert to multiplicative intervals
(`k times/divide a factor`); report both. The bordered treatment avoids understating k
uncertainty by ignoring amplitude trade-off.

### 3.4 Initial conditions

`c0` becomes a first-class editable row (default A = 100%). The current inference of
unmeasured sources (`network.ts:339`) remains as the default *value* of that row when
data columns exist, shown rather than silent. c0 entries can be floated like any
parameter.

### 3.5 Edge cases

Positivity of k by log-parameterization plus box bounds; empty scheme, disconnected
species, duplicate steps handled in validation (section 4); negative t rejected; a
single time point plots but refuses to fit; population conservation asserted in tests.

### 3.6 Unit-test list

1. A -> B against `exp(-kt)` to 1e-10.
2. Chains N = 2 to 5 against Bateman closed forms to 1e-9 (extends existing tests).
3. A <-> B end-state ratio = kf/kr to 1e-9; relaxation rate kf + kr.
4. Population conservation to 1e-10 on random schemes (exists for RK4; add eigen).
5. Eigen vs RK4 parity 1e-9, including a cycle A -> B -> C -> A (complex eigenvalues).
6. Degenerate ks (k1 = k2 chain) exercises the Pade fallback; parity with RK4.
7. VARPRO fit of E3 synthetic recovers ks within 1%, y within 2%, b within noise.
8. Correlation matrix on truncated E2 flags the kf/kr trade-off.
9. Cancel flag stops within one iteration.
10. Every gallery example: load then fit recovers ground truth within its stated
    tolerance.

## 4. Scheme builder spec

### 4.1 Text DSL (backward compatible with today's parser)

    step        := species arrow species [":" rateNames] [comment]
    arrow       := "->" | "→" | "<->" | "<=>" | "⇌" | "="
    rateNames   := name | name "," name        # reversible takes two
    species     := /[A-Za-z][A-Za-z0-9_']*/
    comment     := "#" .*

Rate names optional; auto-assigned k1, k2, ... in declaration order, renumbered stably
on edit. Today's label-free lines stay valid.

### 4.2 Row editor

Each row: `[species v] [-> | <=> toggle] [species v] [k-name chip] [x]`, plus
`+ add step`. Species dropdowns list current species plus `+ new species`. Rows and
text stay synced through one shared AST; whichever view was edited last regenerates the
other.

### 4.3 Species control

Stepper 2 to 6 plus `add species` beyond (engine uncapped). Names editable in place.
Colours assigned by species index from a fixed 8-ramp (extend the current 5 blues with
`#7c3aed`, `#0e7490`, `#9a3412`), used identically in diagram, plots, and tables.

### 4.4 Diagram

Inline SVG, circular layout for N <= 6 (node i at angle 2 pi i/N, radius 90, canvas
280 x 240). Nodes: 16 px circles in species colour, name beside. Arrows: quadratic
curves between node rims, one head for irreversible, a head at each end for reversible,
the k label at the midpoint offset along the normal. Re-rendered on every AST change;
it is a pure function of the AST. This diagram is the page's comprehension device: a
user who sees three coloured nodes and two arrows knows exactly what model they built.

### 4.5 Initial composition row

`At t = 0 the sample is:  A [100]%  B [0]%  C [0]%   [Normalize]`

Normalize rescales to sum 100, never silently. With data columns present the row
pre-fills and says: `Read from your first data row. Edit to override.`

### 4.6 Validation messages (verbatim)

- `Line 2: species "D" is not defined. Add it above, or fix the typo.`
- `C has no steps. It will sit at its initial value for the whole run.` (warning)
- `Steps 1 and 3 are both A -> B. Remove one; a faster k is one step, not two.`
- `The scheme is empty. Add a step, or start from a seed above.`
- `"A -> A" converts A to itself.` (exists today, kept)

## 5. Examples gallery

One gallery replaces both tiers. Every card populates data, scheme, initial
composition, estimates, units, and labels, lights the step strip, and shows a
dismissible callout. Ground truth lives in code comments beside each dataset so fits
are verifiable.

| # | Name | Scheme | Ground truth (per min) | Noise | Points | Teaches |
|---|---|---|---|---|---|---|
| E1 | Single conversion | A -> B | k1 0.030; y 1.00, 0.15; b 0.05 | 0.010 | 40 over 0 to 240 | one exponential |
| E2 | Reversible pair | A <-> B | kf 0.040, kr 0.010; y 1.00, 0.35 | 0.008 | 50 over 0 to 180 | plateau is not completion |
| E3 | Sequential intermediate | A -> B -> C | k1 0.030, k2 0.008; y 1.00, 0.55, 0.10; b 0.02 | 0.012 | 60 over 0 to 600 | B rises then falls |
| E4 | Four-species chain | A<->B<->C<->D | 0.050, 0.020, 0.020, 0.010, 0.008, 0.004; y 1.00, 0.70, 0.40, 0.10 | 0.010 | 80 over 0 to 600 | no species cap |
| E5 | Branched pathways | A -> B, A -> C | k1 0.030, k2 0.012; y 1.00, 0.20, 0.85 | 0.010 | 50 over 0 to 300 | topology is a choice |
| E6 | Real-world messy | A -> B -> C | E3 plus drift m 1.5e-4, sparse early rows | 0.030 | 45 | baselines, multi-start, SEs |

Card copy (verbatim; bold name, one line, expectation):

- E1: `One species becomes another. Fit one rate and read its half life.`
  `You should recover k1 near 0.030.`
- E2: `The signal plateaus with 20% left. Not slow: an equilibrium.`
  `You should recover kf/kr near 4.`
- E3: `The intermediate rises, then falls. No two-species model can draw this.`
  `You should recover k1 near 0.030 and k2 near 0.008.`
- E4: `Four species, six rate constants. The species count is yours to set.`
  `All six constants return within about 10%.`
- E5: `One reactant, two products. Try the sequential scheme on it and watch the residuals object.`
  `You should recover k1 near 0.030 and k2 near 0.012.`
- E6: `Noise, drift, and a thin early baseline. Turn multi-start on.`
  `k1 returns near 0.030 with an honest error bar.`

Load callout (E3, verbatim):

`Loaded "Sequential intermediate": A -> B -> C, 60 noisy points. Data, scheme, and
starting estimates are filled in below. Check the simulated overlay in Estimates, then
press Fit. You should recover k1 near 0.030.`

Each populated section flashes once, in workflow order, reusing the existing
`.revealed` animation.

## 6. Data input spec

Ghost placeholder (verbatim):

    Paste your time course, two columns:
    time   signal
    (tab, comma, or spaces; lines starting with # are ignored)

    0      1.000
    10     0.812
    25     0.603

Parser: delimiters tab, comma, semicolon, whitespace; auto-skip one non-numeric header
row (its names map columns to species when they match the scheme); `#` comments; blank
lines split replicate runs; scientific notation; **unsorted times sorted on parse**
(change from today's rejection); ragged or non-numeric rows become line errors, never
silent drops. Decimal-comma policy: **not auto-detected**, commas are delimiters; the
format help states `Use a dot for decimals (1.23). Commas separate columns.` The
ambiguity of "1,23" cannot be resolved reliably, so the policy is documented rather
than guessed.

Status line under the box (verbatim patterns):

- ok: `86 points · t 0 to 3600 s · signal 0.021 to 1.004`
- ok, replicates: `3 runs · 86 points each · t 0 to 3600 s`
- error: `Line 7: "25,,0.3" has a gap where a number should be.` The offending line is
  highlighted by an overlay div behind the textarea (same font metrics, tinted row).
- single point: `One point plots, but a fit needs at least three. Add more rows.`

Box buttons: `Load sample`, `Upload CSV` (plus drag-and-drop onto the textarea),
`Clear`. Time unit dropdown (s / min / h) lives inside the status line; the signal
label field feeds every axis title and export header.

The plot renders on every successful parse, before any scheme exists. The first plot
is the format confirmation, stronger than any help text.

## 7. Fitting engine

### 7.1 Worker protocol

`web/fit-worker.js`, a plain module worker importing the same `dist/lib` core.

    main -> worker: { type: "fit", id, scheme, params, float, bounds, data, options }
    worker -> main: { type: "progress", id, iteration, ssr }        // throttled, 50 ms
    worker -> main: { type: "result", id, converged, iterations, wallMs,
                      params, se, corr, ssr, r2, curve, populations }
    worker -> main: { type: "error", id, message }
    main -> worker: { type: "cancel", id }   // checked each iteration;
                                             // terminate() if unanswered in 250 ms

Live status in the UI (verbatim): `Fitting... iteration 143, SSR 2.41e-3  [Cancel]`,
then `Converged in 57 iterations, 0.08 s.` even when nearly instant. That line answers
"is the fit real work" honestly, in the product, forever.

### 7.2 Optimizer

Levenberg-Marquardt over log k (and any floated c0, log-transformed), amplitudes by
variable projection each step. Numeric forward-difference Jacobian (relative step
1e-6). Lambda starts at 1e-3, x10 on a rejected step, /10 on an accepted one; box
bounds by projection; converged when relative SSR improvement stays below 1e-10 twice
running, or at 300 iterations. Multi-start toggle: n = 20 log-normal perturbations of
the estimates (factor 3), keep the best, report agreement:
`18 of 20 starts agree within 0.1%.`

### 7.3 Results and warnings

Table: parameter, fitted value, SE (and times/divide factor for ks), fix/float, bounds
hit flagged. R^2, SSR, iterations, wall time. Residual subplot always visible;
populations subplot at the fitted parameters. Warnings verbatim:

- Correlation: `k2 and k3 trade off (r = 0.98). This data cannot tell them apart;
  consider fixing one, or measuring later time points.`
- Flip-flop (kept from today, `network.ts:426`): wording unchanged.
- Bound hit: `k3 stopped at its upper bound. Widen the bound or rethink the scheme.`

Exports: fitted curve plus populations as CSV, parameters as JSON, a copyable text
summary. `Send this order to Estimate` survives for single-species data.

## 8. Architecture recommendation

Compute reality: with the eigen propagator, one residual evaluation at 2,000 points
and N = 6 costs about 0.2 ms; an LM fit lands near 100 ms; multi-start x20 near 2 s.
The measured RK4-plus-Nelder-Mead path costs 13 to 37 s at the same sizes. Either way
the fit belongs in a Web Worker, because the main thread must never gamble on model
size.

A backend becomes justified only for batch or global fitting across many files, stiff
bimolecular networks at scale, or server-side persistence and sharing. The migration
path is already designed: the core is pure and DOM-free, so a Node endpoint would
import `dist/lib` unchanged. The Pyodide "robust mode" is assessed and rejected for
now: a lazy 12 MB download contradicts the app's self-contained character, and nothing
in P0 needs scipy once the eigen path exists; revisit only if P1 bimolecular stiffness
defeats RK45-in-worker.

**Recommendation:** pure front-end. Eigen-powered core in `src/lib`, fits in one Web
Worker, RK4 retained as oracle and future RK45 seed. No backend, no bundler, no new
dependencies.

## 9. First-time-user walkthrough

Ana, a postdoc, has a 90-row UV time course in her clipboard.

1. She clicks **Fit**. The step strip reads (1) Data (2) Scheme (3) Estimates (4) Fit;
   the data box shows the ghost placeholder. Nothing else demands attention.
2. She pastes. Under the box: `90 points · t 0 to 5400 s · signal 0.012 to 0.981`, and
   her points appear on the plot. Format anxiety over.
   *Hesitation check: her times are seconds but the unit dropdown said min.* The
   assumed unit prints inside the status line she is already reading; she flips the
   dropdown there and the axis relabels. Design revised: the unit control lives in the
   status line, not in a separate settings row.
3. Step (1) marks done. Scheme shows a seeded `A -> B`, two coloured nodes. She
   believes there is an intermediate: species stepper to 3, add row `B -> C`. The
   diagram grows a third node; the parameter table below now lists k1, k2, y_A, y_B,
   y_C, b.
4. Estimates: the simulated overlay is visibly too fast. She drags the k1 log slider;
   the curve relaxes onto her data live; the populations subplot shows B swelling and
   draining. The curve teaches her what k1 does; no manual needed.
5. She presses **Fit**: `Fitting... iteration 36, SSR 1.2e-3`, then
   `Converged in 41 iterations, 0.06 s.` The table reads k1 = 3.1e-4 ± 2e-5 per s, the
   residuals scatter flat, no warnings. She presses `Copy summary`.
   *Hesitation check: would she know to press Fit when Estimates was live?* Fit is the
   page's only filled-primary button, and the strip highlights (4) as the next step.
   Design revised: Estimates and Fit are adjacent sections with the strip as
   connective tissue, not separate tabs.

Elapsed: under two minutes, no documentation.

## 10. Staged roadmap

Default staging accepted, one adjustment: gallery datasets ship as baked arrays with
ground truth in comments, so Stage 1 does not wait on the math core.

**Stage 1: data input + examples gallery.**
Deliverables: ghost placeholder, tolerant parser with line errors and sorting, status
line with unit control, immediate plot, signal label, upload and drag-drop, gallery of
six cards with callouts, step strip driven by data/scheme presence.
Acceptance: garbage input (letters, ragged rows, empty box, one point) produces the
section 6 messages with zero uncaught console errors; each card populates everything
and its callout names what changed; a stranger reaches a plotted dataset in under ten
seconds.

**Stage 2: scheme builder + math core.**
Deliverables: species stepper and renames, row editor plus DSL with two-way sync,
diagram, initial-composition row, parameter table, eigen propagator with Pade fallback,
tests 1 to 6, live Estimates overlay and populations subplot.
Acceptance: a 5-species reversible chain simulates against RK4 to 1e-9; every
validation message fires verbatim; edits re-simulate in under 16 ms at 2,000 points.

**Stage 3: fitting engine + results.**
Deliverables: worker, LM plus VARPRO, multi-start, SEs and correlations, warnings,
results UI, exports, cancel.
Acceptance: every gallery example recovers its ground truth within stated tolerance; a
2,000-point fit keeps the UI interactive and cancel works mid-fit; E6 fits worse
without multi-start than with it, and the UI shows the start spread.

## 11. Risks and open questions

Risks:

- R1: the nonsymmetric eigensolver is the riskiest 300 lines; mitigated by the RK4
  oracle test and the Pade fallback.
- R2: two-way row/text sync is a classic divergence source; mitigated by one AST with
  one regenerator per view.
- R3: bounded amplitudes complicate VARPRO's linear solve; P0 ships unconstrained
  amplitudes and warns when any y turns negative.
- R4: the textarea line-highlight overlay must track scroll and font metrics exactly.

Open questions (each answerable in one line):

1. Typical time scales and units of your real traces: seconds, minutes, or hours?
2. What is the signal physically (absorbance, fluorescence, NMR integral, HPLC area)?
3. Can signal coefficients y_i be negative in your systems?
4. Do bimolecular steps (2A -> B, A + B -> C) occur in data you plan to fit soon?
5. Do you need multi-trace global fits (shared ks across conditions) this quarter?
6. Typical point counts per trace: tens, hundreds, or thousands?
7. Is instrument drift m*t common enough to show by default, or keep it opt-in?
8. Are replicates collected on the same time grid, or scattered times per run?
9. Is N = 6 a comfortable UI ceiling for year one?
10. Should per-species-column data keep today's percent convention, or move to
    "as entered" everywhere?

## 12. Acceptance criteria mapping

- Gallery recovery: test 10 (section 3.6) plus Stage 3 acceptance.
- 5-species chain, no ceiling: Stage 2 acceptance plus a dedicated fit test.
- Garbage input: Stage 1 acceptance against the section 6 messages.
- UI interactive, cancel works: worker protocol plus Stage 3 acceptance.
- Two-minute stranger: section 9 is the hallway-test script.
- Other tabs unaffected: all work lives in `fit.js`, `fit-worker.js`, `src/lib`, and
  the `#v-fit` section; `estimate.js` handoffs keep their exported signatures.

## 13. Ideas menu triage

| Idea | Verdict | Reason |
|---|---|---|
| Species-count advisor (AIC over N) | **Adopt (after Stage 3)** | answers the page's own question; nearly free once the core exists |
| Log-time axis toggle | **Adopt** | already built on Estimate; porting is small |
| Bootstrap uncertainties (about 200 resamples) | **Later** | worker makes it feasible; ship JtJ SEs first, bootstrap when SEs prove misleading |
| Session save/load (one JSON file) | **Adopt** | state is trivially serializable; makes analyses shareable and bug reports reproducible; URL hash rejected, data too large |
| Global multi-trace fitting + Arrhenius layer | **Later** | the real gateway feature, but it doubles the parameter-table UI; after Stage 3 |
| Publication export (SVG plus methods paragraph) | **Later** | SVG is easy; the methods text should wait until the schema stops moving |
| Animated population bars + draggable time cursor | **Adopt** | small, high teaching value, reuses the existing crosshair pattern |

---

## 14. Addendum: answers received, decisions locked

1. Time scales: up to 72 h, dense first 6 h. Default unit on Fit becomes hours; the
   gallery is retuned to per-hour constants over a 72 h window with 17 points sampled
   densely early and sparsely late, matching the described bench pattern.
2. Signal: NMR, IR, GC-MS TIC. Generalized "signal" plus label field confirmed; NMR
   integrals arrive as per-species columns, IR and TIC as the composite single signal,
   so both data modes stay first-class.
3. y_i cannot be negative: VARPRO's linear solve becomes NNLS (Lawson-Hanson, about 80
   lines). Risk R3 is resolved rather than deferred.
4. Catalysis, one catalyst: with catalyst concentration effectively constant, the steps
   are pseudo-first-order and P0 covers them. The real P1 risk is saturation (a
   Michaelis-Menten regime crossing), not dimerization; the tell is a trace that falls
   linearly early and bends into an exponential tail. P1 scope reordered accordingly,
   pending the user's observation of that shape.
5. Global fits needed: promoted from Later to the first post-Stage-3 feature. The
   distinction stated: multi-start (global minimum for one trace) ships in Stage 3;
   shared-k fitting across traces is the promoted feature.
6. 10 to 20 points per trace: compute is comfortable everywhere; identifiability
   warnings (SEs, correlations) matter more than speed at this size. The 2,000-point
   acceptance stays as stress headroom.
7. Drift m*t: opt-in, hidden until floated. Confirmed.
8. Replicates: support both same-grid replicate columns (repeated header names, like
   "t, A, A, A") and scattered-time blocks. The duplicate-time rejection is lifted for
   repeated columns.
9. Species ceiling N = 8: stepper 2 to 8; the 8-colour ramp and the eigensolver were
   already specced for N <= 8.
10. Decision (mine, as invited): values as entered, everywhere on Fit. The order-fit
    mode's own label declares its percent convention; nothing divides silently.

---

## 15. Addendum: scheme canvas decision (2026-08-15)

Prompted by the sugar cube paper (Carder et al., Science 2024, 385:456), whose Fig. 3C
draws the fitted network as nodes and weighted arrows. The user proposed draggable
model blocks; assessed and declined: motif blocks share species, so composition needs
node unification, which drag handles badly. Built instead, ahead of Stage 2:

- A tap-to-connect canvas inside the scheme field. Species are coloured nodes on a
  ring; tap two nodes to draw a step; tap an arrow to cycle one-way, reversible,
  removed. `+ species` adds an unwired node; data columns appear as unwired nodes
  automatically. Every edit round-trips through the scheme text, which stays the
  single source of truth.
- Paper-faithful annotations: after a fit, each arrow carries its rate constant
  (kf / kr on reversible edges) and a stroke width proportional to it.
- Labels take a surface-coloured halo and sit on the side of their arrow facing away
  from the canvas centre, so neighbouring labels never collide.
- Alternatives recorded: adjacency-matrix grid (good power view at N >= 5, later);
  append-chips (too small a fix); drag tray (declined as above).
- Page copy trimmed: callouts to one line plus expectation, explains to one sentence,
  format help compressed.

Stage 2's remaining scheme work narrows to: species rename, the parameter table, and
the DSL rate-name labels.

---

## 16. Addendum: canvas-first workflow (2026-08-15)

The page now runs in strict data-processing order, per the user's direction:

1. Paste data; the raw traces plot immediately, directly under the data box.
2. Every data column becomes a dimmed, unwired node on the scheme canvas; the guide
   bar asks the chemist's question: "Tap the one that disappears, then the one it
   becomes."
3. Each drawn connection re-fits at once. Partial schemes fit gracefully: only wired
   species are fitted; unwired columns stay on the plot as dimmed points, so each new
   arrow visibly turns one more dimmed trace into a fitted curve.
4. Data-aware hints name the next arrow: a column not yet wired, growth with no arrow
   in, decay with no arrow out. Verified on E3-shaped data: wiring only A -> B yields
   R2 = -0.95 plus the hints "C is not connected yet" and "B falls in your data, but
   no arrow leaves it"; wiring B -> C snaps to k1 = 0.348, k2 = 0.0800, R2 = 0.9997.
5. The scheme starts empty (placeholder shows the text form); one shared species
   ordering, data columns first, keeps node, curve and point colours in agreement.
6. The gallery is the empty state: full cards before any data, a compact chip row
   after. Examples remain one tap away without framing the page.

Consequence for the engine plan: the old "data has a column the scheme never
mentions" refusal is retired at the UI layer by fitting the wired subset; Stage 3's
worker protocol should accept the same filtered-series form.
