# Kinetics Time-to-Conversion Estimator

A chemist measures one point on a reaction and wants to know how long to 50%, 90%, 99%,
at that temperature or another. This app answers that, and it is careful about what it
does not know.

## Stack

Vanilla ES modules in `web/`, TypeScript engine in `src/`, no framework and no runtime
dependencies. `package.json` has an empty `dependencies` block and a test asserts it
stays empty. Browser assets that cannot be written by hand (the Asana Math font, KaTeX)
are vendored under `web/` with their licence notices, never installed as runtime deps.

Node 23 runs the TypeScript directly with `--experimental-strip-types`. `npm start`
builds and serves on port 3000.

## Punctuation rule (enforced)

**Never use an em dash, U+2014.** Not in UI copy, headings, tooltips, code comments,
test names, commit messages, or docs. Replace it with a comma, a colon, parentheses, a
semicolon, or a sentence break, whichever is grammatically correct in that spot. Do not
blanket-substitute a comma: that produces comma splices wherever the clause on the right
is independent, and those need a semicolon or a full stop.

Write numeric ranges as "20 to 200". An en dash between two digits is also rejected. An
en dash inside a joint proper name is fine and expected (Avrami-Erofeev, Box-Muller,
Ginstling-Brounshtein, Valensi-Barrer are all set with one).

Enforced in three places, so it cannot regress:

- `npm run lint:prose` runs `scripts/no-em-dash.mjs` over `src/`, `web/`, `tests/`,
  `docs/`, `scripts/`, and the root markdown files.
- `pretest` runs it, so `npm test` fails on a violation.
- `.githooks/pre-commit` runs it. Enable once per clone with
  `git config core.hooksPath .githooks`.

## Rules the architecture depends on

**The registry is the only place chemistry lives.** `src/models/` holds one file per
kinetic model plus `registry.ts`. Nothing under `solver/`, `explain/`, or `api/` may
branch on a model key. `tests/architecture.spec.ts` fails the build if a model key
appears as a string literal in those layers, or if they import a model file directly
rather than through `registry.ts`. Switching on a declared structural property
(`domain.kind`, `timeQuantity`) is allowed; switching on identity is not.

**One math module.** `src/lib/kinetics.ts` is the single entry point for anything that
computes. No page or component recomputes kinetics inline.

**No non-finite number reaches the UI.** `JSON.stringify` turns both `Infinity` and
`NaN` into `null`, which would make "approached asymptotically" indistinguishable from
"not computed". Unreachable targets carry a `NOT_REACHABLE` sentinel and render as
"never". Nothing displays `NaN`, `Infinity`, `undefined`, or `-0`.

**The band is the headline.** A single measurement fixes one point on the curve, not the
reaction order. Where the order was assumed rather than measured, the interval across
plausible orders is the result and the single number is a detail inside it. No screen may
present one number as though the order were known.

**Units.** Kelvin, seconds, mol/L internally; convert only at the UI boundary. The rate
constant's units depend on the order (`concentration^(1-n) * time^-1`), so never hardcode
a single unit string for k.

## Commands

| Command | Does |
|---|---|
| `npm test` | Vitest, whole suite, prose guard first |
| `npm run lint:prose` | Punctuation guard on its own |
| `npm run typecheck` | `tsc --noEmit` |
| `npm start` | Build, then serve on 3000 |
| `npm run coverage` | Vitest with v8 coverage |
