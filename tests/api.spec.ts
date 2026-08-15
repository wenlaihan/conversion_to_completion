import { describe, it, expect, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { solve } from '../src/api/solve.ts';
import { assertSerializable, statusFor } from '../src/api/serialize.ts';
import { createKineticsServer } from '../src/http/server.ts';
import type { SolveRequest, SolveResponse } from '../src/api/schema.ts';

const at20C = { basis: 293.15 } as const;
const hours = { time: 'h', temperature: 'K' } as const;

const run = (request: SolveRequest): SolveResponse => {
  const result = solve(request);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/* ------------------------------------------------------------------ *
 * §5 A, what is known
 * ------------------------------------------------------------------ */

describe('A1, one point plus an assumed order', () => {
  it('calibrates K and predicts the full ladder', () => {
    const response = run({
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21 }],
      temperature: at20C,
      units: hours,
    });
    expect(response.resolved.K).toBeCloseTo(0.0392871, 7);
    expect(response.table).toHaveLength(6);
    expect(response.resolved.paramSources.n).toBe('given');
  });
});

describe('A2, one point with the order unknown', () => {
  const response = run({
    params: { n: null },
    observations: [{ t: 6, X: 0.21 }],
    targets: { X: [0.9] },
    temperature: at20C,
    units: hours,
  });

  it('never returns a single order', () => {
    expect(response.resolved.identifiable).toBe(false);
    expect(response.headline.kind).toBe('band');
  });

  it('returns the band over the plausible orders', () => {
    expect(response.band?.values).toEqual([0, 0.5, 1, 1.5, 2]);
    const at90 = response.band?.times['0.9'] as readonly number[];
    expect(at90.map((t) => Number(t.toFixed(2)))).toEqual([25.71, 36.9, 58.61, 103.72, 203.14]);
  });

  it('says plainly that the order is not determined', () => {
    const warning = response.diagnostics.warnings.find(
      (w) => w.code === 'ORDER_ASSUMED_NOT_FITTED',
    );
    expect(warning?.severity).toBe('loud');
  });
});

describe('A3, two points determine the order exactly', () => {
  it('solves for n and K together', () => {
    // Synthesized from n = 1 exactly, so the recovered order should be exact too.
    const t2 = (6 * -Math.log1p(-0.75)) / -Math.log1p(-0.21);
    const response = run({
      params: { n: null },
      observations: [
        { t: 6, X: 0.21 },
        { t: t2, X: 0.75 },
      ],
      temperature: at20C,
      units: hours,
    });
    expect(response.resolved.params.n as number).toBeCloseTo(1, 9);
    expect(response.resolved.identifiable).toBe(true);
    expect(response.headline.kind).toBe('point');
  });
});

describe('A4, three or more points give least squares with R squared', () => {
  it('reports the fit quality and residuals', () => {
    const response = run({
      params: { n: null },
      observations: [
        { t: 2, X: 0.1 },
        { t: 6, X: 0.26 },
        { t: 12, X: 0.44 },
        { t: 20, X: 0.6 },
      ],
      temperature: at20C,
      units: hours,
    });
    expect(response.diagnostics.rSquared as number).toBeGreaterThan(0.99);
    expect(response.diagnostics.residuals).toHaveLength(4);
    expect(response.resolved.identifiable).toBe(true);
  });
});

describe('A5, a known rate constant needs no experiment', () => {
  it('lumps C_A0^(n-1) into K', () => {
    const response = run({
      params: { n: 2 },
      known: { k: 0.01, CA0: 4 },
      targets: { X: [0.5] },
      temperature: at20C,
      units: hours,
    });
    // K = k·C_A0^(n−1) = 0.01 × 4 = 0.04 per hour.
    expect(response.resolved.K).toBeCloseTo(0.04, 10);
    expect(response.resolved.calibrationSource).toBe('known constants');
  });

  it('uses each model own rule rather than the nth-order one', () => {
    // Michaelis-Menten: K = Vmax/C_A0, not k·C_A0^(n−1).
    const response = run({
      model: 'michaelis-menten',
      params: { kappa: 1 },
      known: { k: 2, CA0: 4 },
      targets: { X: [0.5] },
      temperature: at20C,
      units: hours,
    });
    expect(response.resolved.K).toBeCloseTo(0.5, 10);
  });
});

describe('A6, a half-life fixes K', () => {
  it('inverts g(0.5)/t_half', () => {
    const response = run({
      params: { n: 1 },
      known: { halfLife: 10 },
      targets: { X: [0.5] },
      temperature: at20C,
      units: hours,
    });
    expect(response.resolved.K).toBeCloseTo(Math.LN2 / 10, 10);
    expect(response.table[0]?.t as number).toBeCloseTo(10, 8);
  });

  it('is refused when 50% is above the model ceiling', () => {
    const result = solve({
      model: 'reversible-1',
      params: { Xe: 0.3 },
      known: { halfLife: 10 },
      temperature: at20C,
      units: hours,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HALF_LIFE_ABOVE_CEILING');
  });
});

describe('A7, an initial rate fixes K', () => {
  it('uses g prime at zero rather than assuming it is one', () => {
    const response = run({
      params: { n: 1 },
      known: { initialRate: 0.5, CA0: 10 },
      targets: { X: [0.5] },
      temperature: at20C,
      units: hours,
    });
    // g'(0) = 1 for nth-order, so K = r0/C_A0.
    expect(response.resolved.K).toBeCloseTo(0.05, 10);
  });

  it('refuses for models whose initial rate is zero by construction', () => {
    const result = solve({
      model: 'diffusion',
      params: { type: 'D3' },
      known: { initialRate: 0.5, CA0: 10 },
      temperature: at20C,
      units: hours,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INITIAL_RATE_UNDEFINED');
    expect(result.error.message).toMatch(/flat or vertical at X = 0/);
  });
});

describe('A8, datasets at two temperatures fit the activation energy', () => {
  it('regresses ln K against 1/T', () => {
    const response = run({
      params: { n: 1 },
      observations: [
        { t: 6, X: 0.21, T: 293.15 },
        { t: 2, X: 0.21, T: 313.15 },
      ],
      targets: { X: [0.9] },
      temperature: at20C,
      units: hours,
    });
    expect(response.temperature?.eaSource).toBe('two-dataset');
    expect((response.temperature?.Ea as number) / 1000).toBeCloseTo(41.9, 0);
    expect(response.temperature?.eaConfidenceInterval).toBeNull();
  });

  it('reports a confidence interval once three temperatures are available', () => {
    const response = run({
      params: { n: 1 },
      observations: [
        { t: 6, X: 0.21, T: 293.15 },
        { t: 3, X: 0.21, T: 303.15 },
        { t: 1.6, X: 0.21, T: 313.15 },
      ],
      targets: { X: [0.9] },
      temperature: at20C,
      units: hours,
    });
    expect(response.temperature?.eaSource).toBe('regression');
    expect(response.temperature?.eaConfidenceInterval?.df).toBe(1);
    expect(response.temperature?.arrheniusRSquared as number).toBeGreaterThan(0.99);
  });
});

/* ------------------------------------------------------------------ *
 * §5 B, what is asked
 * ------------------------------------------------------------------ */

describe('B3, B4, B6, inverse, curve and incremental time', () => {
  const response = run({
    params: { n: 1 },
    observations: [{ t: 6, X: 0.21 }],
    targets: { X: [0.5, 0.9], t: [24, 48], curve: { points: 50, XMax: 0.99 } },
    temperature: at20C,
    units: hours,
  });

  it('B3: reports the conversion reached at a given time', () => {
    expect(response.inverse[0]?.X as number).toBeCloseTo(0.6105, 4);
  });

  it('B4: samples a monotone curve', () => {
    expect(response.curve.t).toHaveLength(51);
    for (let i = 1; i < response.curve.X.length; i += 1) {
      expect(response.curve.X[i] as number).toBeGreaterThanOrEqual(
        response.curve.X[i - 1] as number,
      );
    }
  });

  it('B6: reports how much longer from where the reaction already is', () => {
    const row = response.table.find((r) => r.X === 0.9);
    expect(row?.deltaFromObserved as number).toBeCloseTo(58.61 - 6, 1);
  });
});

describe('B7, sensitivity is reported as a ranked vector', () => {
  it('ranks the order above the conversion measurement when extrapolating far', () => {
    const response = run({
      params: { n: 2 },
      observations: [{ t: 6, X: 0.5 }],
      targets: { X: [0.999] },
      temperature: at20C,
      units: hours,
    });
    const inputs = response.diagnostics.sensitivities.map((s) => s.input);
    expect(inputs[0]).toBe('n');
    expect(response.diagnostics.dlnt_dX1 as number).toBeCloseTo(-4, 5);
  });
});

describe('B8 / C6, the temperature needed to hit a deadline', () => {
  it('solves the inverse Arrhenius problem and round-trips', () => {
    const response = run({
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: { basis: 293.15, Ea: 80000, deadline: 24 },
      units: hours,
    });
    const required = response.temperature?.requiredTemperature as number;
    expect(required).toBeGreaterThan(293.15);

    const check = run({
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: { basis: 293.15, Ea: 80000, predictAt: required },
      units: hours,
    });
    expect(check.table[0]?.t as number).toBeCloseTo(24, 4);
  });

  it('answers from the measured temperature even when also predicting at another one', () => {
    // Regression: the inverse solve searches from the basis, so it must be handed the
    // unshifted K. Given the shifted one it double-counts the Arrhenius factor and
    // recommends going colder in order to finish sooner.
    const withShift = run({
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: { basis: 293.15, predictAt: 313.15, Ea: 80000, deadline: 24 },
      units: hours,
    });
    const withoutShift = run({
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: { basis: 293.15, Ea: 80000, deadline: 24 },
      units: hours,
    });

    const required = withShift.temperature?.requiredTemperature as number;
    // 90% takes 58.6 h at the measured temperature, so meeting 24 h means heating.
    expect(required).toBeGreaterThan(293.15);
    // And it must not depend on where else the user happened to ask for a prediction.
    expect(required).toBeCloseTo(withoutShift.temperature?.requiredTemperature as number, 6);
  });

  it('shifts the band with the point estimate rather than leaving it at the basis', () => {
    // Regression: the band re-calibrates from the observations, which sit at the basis
    // temperature. Without the same Arrhenius move the row's own bracket described a
    // different experiment than its number, at 40 °C the band still said 25.7 to 203.1 h
    // while the point said 7.2 h, an 8× disagreement on the app's headline claim.
    const at = (n: number | null) =>
      run({
        params: { n },
        observations: [{ t: 6, X: 0.21 }],
        targets: { X: [0.9] },
        temperature: { basis: 293.15, predictAt: 313.15, Ea: 80000 },
        units: hours,
      }).table[0];

    const banded = at(null);
    // The envelope is the sweep over the n ladder, so its edges must be the ladder's ends.
    expect(banded?.bandLow as number).toBeCloseTo(at(0)?.t as number, 9);
    expect(banded?.bandHigh as number).toBeCloseTo(at(2)?.t as number, 9);
    // And the point estimate has to sit inside its own bracket.
    expect(banded?.t as number).toBeGreaterThan(banded?.bandLow as number);
    expect(banded?.t as number).toBeLessThan(banded?.bandHigh as number);

    // Every edge moves by the one Arrhenius factor, since only K depends on temperature.
    const basis = run({
      params: { n: null },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: { basis: 293.15 },
      units: hours,
    }).table[0];
    const factor = (basis?.t as number) / (banded?.t as number);
    expect((basis?.bandLow as number) / (banded?.bandLow as number)).toBeCloseTo(factor, 9);
    expect((basis?.bandHigh as number) / (banded?.bandHigh as number)).toBeCloseTo(factor, 9);
  });
});

/* ------------------------------------------------------------------ *
 * §5 C, temperature modes
 * ------------------------------------------------------------------ */

describe('C7, an exothermic equilibrium trades rate against reach', () => {
  it('moves the ceiling with van t Hoff and warns about the trade', () => {
    const response = run({
      model: 'reversible-1',
      params: { Xe: 0.8 },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.5] },
      temperature: { basis: 293.15, predictAt: 313.15, Ea: 80000, deltaH: -60000 },
      units: hours,
    });
    expect(response.resolved.Xmax).toBeLessThan(0.8);
    const warning = response.diagnostics.warnings.find(
      (w) => w.code === 'EQUILIBRIUM_FALLS_WITH_TEMPERATURE',
    );
    expect(warning?.severity).toBe('loud');
    expect(warning?.message).toMatch(/lowers how far it can go/);
  });

  it('asks for the enthalpy rather than assuming the ceiling is fixed', () => {
    const result = solve({
      model: 'reversible-1',
      params: { Xe: 0.8 },
      observations: [{ t: 6, X: 0.21 }],
      temperature: { basis: 293.15, predictAt: 313.15, Ea: 80000 },
      units: hours,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MISSING_ENTHALPY');
  });
});

/* ------------------------------------------------------------------ *
 * §5 E, reactor modes, and units
 * ------------------------------------------------------------------ */

describe('E3, the CSTR reports a space time, not a reaction time', () => {
  it('labels the quantity differently while using the same solver', () => {
    const response = run({
      model: 'cstr',
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: at20C,
      units: hours,
    });
    expect(response.resolved.timeQuantity).toBe('spaceTime');
    expect(response.resolved.timeLabel).toMatch(/space time/);
    // K·τ = X/(1−X)^n, so τ(0.9) = 9/K with K = (0.21/0.79)/6.
    expect(response.table[0]?.t as number).toBeCloseTo(9 / (0.21 / 0.79 / 6), 6);
  });
});

describe('§8 units', () => {
  it('converts time at the boundary and reports K per that unit', () => {
    const inHours = run({
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: at20C,
      units: hours,
    });
    const inMinutes = run({
      params: { n: 1 },
      observations: [{ t: 360, X: 0.21 }],
      targets: { X: [0.9] },
      temperature: at20C,
      units: { time: 'min', temperature: 'K' },
    });
    expect(inMinutes.table[0]?.t as number).toBeCloseTo((inHours.table[0]?.t as number) * 60, 6);
    expect(inMinutes.resolved.K).toBeCloseTo(inHours.resolved.K / 60, 12);
    expect(inMinutes.resolved.KUnits).toBe('1/min');
  });

  it('accepts Celsius and echoes temperatures back in the same unit', () => {
    const response = run({
      params: { n: 1 },
      observations: [{ t: 6, X: 0.21, T: 20 }],
      targets: { X: [0.9] },
      temperature: { basis: 20, predictAt: 30, Ea: 80000 },
      units: { time: 'h', temperature: 'C' },
    });
    expect(response.temperature?.basis as number).toBeCloseTo(20, 10);
    expect(response.temperature?.predictAt as number).toBeCloseTo(30, 10);
    expect(response.table[0]?.t as number).toBeLessThan(58.61);
  });
});

/* ------------------------------------------------------------------ *
 * Monte Carlo determinism and serialization
 * ------------------------------------------------------------------ */

describe('§4.7 Monte Carlo', () => {
  const request: SolveRequest = {
    params: { n: 1 },
    observations: [{ t: 6, X: 0.21 }],
    targets: { X: [0.9] },
    uncertainty: { sigmaX: 0.01, monteCarlo: 2000, seed: 12345 },
    temperature: at20C,
    units: hours,
  };

  it('is reproducible from the seed alone', () => {
    const first = run(request);
    const second = run(request);
    expect(first.table[0]?.p5).toBe(second.table[0]?.p5);
    expect(first.table[0]?.p95).toBe(second.table[0]?.p95);
    expect(first.diagnostics.monteCarloSeed).toBe(12345);
  });

  it('brackets the point estimate', () => {
    const response = run(request);
    const row = response.table[0];
    expect(row?.p5 as number).toBeLessThan(row?.t as number);
    expect(row?.p95 as number).toBeGreaterThan(row?.t as number);
  });
});

describe('serialization safety', () => {
  it('never lets a non-finite number into a response', () => {
    for (const n of [0, 0.5, 1, 2, 3]) {
      const response = run({
        params: { n },
        observations: [{ t: 6, X: 0.21 }],
        targets: { X: [0.5, 0.9, 0.99, 0.999, 1] },
        temperature: at20C,
        units: hours,
      });
      expect(() => assertSerializable(response)).not.toThrow();
    }
  });

  it('catches Infinity, which JSON would silently turn into null', () => {
    expect(JSON.stringify({ t: Infinity })).toBe('{"t":null}');
    expect(() => assertSerializable({ completion: { time: Infinity } })).toThrow(
      /silently turn into null/,
    );
  });

  it('maps error codes to sensible HTTP statuses', () => {
    expect(statusFor('UNKNOWN_MODEL')).toBe(404);
    expect(statusFor('G1_ZERO_CONVERSION')).toBe(422);
    expect(statusFor('QUADRATURE_BUDGET_EXCEEDED')).toBe(500);
  });
});

/* ------------------------------------------------------------------ *
 * The HTTP wrapper
 * ------------------------------------------------------------------ */

describe('POST /solve', () => {
  const server = createKineticsServer().listen(0);
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/solve`;

  afterAll(() => {
    server.close();
  });

  it('answers the motivating question over the wire', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'nth-order',
        params: { n: 1 },
        observations: [{ t: 6, X: 0.21, T: 293.15 }],
        targets: { X: [0.5, 0.9, 0.99] },
        temperature: { basis: 293.15 },
        units: { time: 'h', temperature: 'K' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SolveResponse;
    expect(body.resolved.K).toBeCloseTo(0.0392871, 7);
    expect(body.table[1]?.t as number).toBeCloseTo(58.61, 2);
    expect(body.headline.kind).toBe('band');
    expect(body.derivation.length).toBeGreaterThan(0);
  });

  it('returns a typed error with a useful status', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNKNOWN_MODEL');
  });

  it('rejects anything other than POST /solve', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/other`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
