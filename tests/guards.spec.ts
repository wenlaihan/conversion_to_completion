import { describe, it, expect } from 'vitest';
import { solve } from '../src/api/solve.ts';
import type { SolveRequest } from '../src/api/schema.ts';

/**
 * §7 guard cases. Each is asserted on its typed code *and* on the message actually
 * shown, because a guard that fires with unusable prose has not really done its job.
 */

const base: SolveRequest = {
  model: 'nth-order',
  params: { n: 1 },
  observations: [{ t: 6, X: 0.21, T: 293.15 }],
  temperature: { basis: 293.15 },
  units: { time: 'h', temperature: 'K' },
};

const failure = (request: SolveRequest) => {
  const result = solve(request);
  expect(result.ok, 'expected this request to be rejected').toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.error;
};

const success = (request: SolveRequest) => {
  const result = solve(request);
  expect(result.ok, result.ok ? '' : `unexpectedly rejected: ${result.error.message}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
};

const warningCodes = (request: SolveRequest): string[] =>
  success(request).diagnostics.warnings.map((w) => w.code);

describe('G1, zero conversion cannot fix a rate constant', () => {
  it('rejects and explains why', () => {
    const error = failure({ ...base, observations: [{ t: 6, X: 0, T: 293.15 }] });
    expect(error.code).toBe('G1_ZERO_CONVERSION');
    expect(error.message).toMatch(/nonzero conversion/i);
  });
});

describe('G2, an observation at or beyond the model ceiling', () => {
  it('is infeasible for a capped model', () => {
    const error = failure({
      ...base,
      model: 'reversible-1',
      params: { Xe: 0.3 },
      observations: [{ t: 6, X: 0.5, T: 293.15 }],
    });
    expect(error.code).toBe('G2_OBSERVATION_ABOVE_CEILING');
    expect(error.message).toMatch(/ceiling/i);
  });
});

describe('G3, an unreachable target returns the ceiling and the reason', () => {
  it('marks the row unreachable rather than emitting a nonsense time', () => {
    const response = success({
      ...base,
      model: 'reversible-1',
      params: { Xe: 0.6 },
      observations: [{ t: 6, X: 0.21, T: 293.15 }],
      targets: { X: [0.5, 0.9] },
    });
    const beyond = response.table.find((r) => r.X === 0.9);
    expect(beyond?.reachable).toBe(false);
    expect(beyond?.t).toBeNull();
    expect(beyond?.unreachableReason).toMatch(/60%/);
    expect(response.resolved.Xmax).toBe(0.6);
  });
});

describe('G4 / G5, completion at X = 1 depends on whether g converges', () => {
  it('G4: at or above first order there is no finite answer, so the ladder is returned', () => {
    const response = success({ ...base, params: { n: 1 }, targets: { X: [1] } });
    expect(response.completion.wellPosed).toBe(false);
    expect(response.completion.time).toBeNull();
    expect(response.table[0]?.reachable).toBe(false);
    expect(response.table[0]?.unreachableReason).toMatch(/asymptotic/i);
    expect(Object.keys(response.completion.practical)).toEqual(['0.99', '0.999']);
  });

  it('G5: below first order the completion time is finite and exact', () => {
    const response = success({ ...base, params: { n: 0.5 }, targets: { X: [1] } });
    expect(response.completion.wellPosed).toBe(true);
    // t = 1/[(1-n)K] = 2/K, the spec's closed form.
    expect(response.completion.time as number).toBeCloseTo(53.97, 2);
    expect(response.table[0]?.reachable).toBe(true);
    expect(response.table[0]?.t as number).toBeCloseTo(53.97, 2);
  });

  it('G5: zero order likewise', () => {
    const response = success({ ...base, params: { n: 0 }, targets: { X: [1] } });
    expect(response.table[0]?.t as number).toBeCloseTo(28.57, 2);
  });
});

describe('G6, targets below the measurement are back-extrapolation', () => {
  it('is allowed but flagged', () => {
    expect(warningCodes({ ...base, targets: { X: [0.05, 0.9] } })).toContain(
      'G6_BACK_EXTRAPOLATION',
    );
  });
});

describe('G7, measurement times must be positive', () => {
  it('rejects t = 0', () => {
    const error = failure({ ...base, observations: [{ t: 0, X: 0.21, T: 293.15 }] });
    expect(error.code).toBe('G7_NONPOSITIVE_TIME');
    expect(error.message).toMatch(/greater than zero/i);
  });

  it('rejects negative times', () => {
    expect(failure({ ...base, observations: [{ t: -1, X: 0.21 }] }).code).toBe(
      'G7_NONPOSITIVE_TIME',
    );
  });
});

describe('G8, a negative order computes, with a warning', () => {
  it('still produces times', () => {
    const response = success({ ...base, params: { n: -0.5 }, targets: { X: [0.9] } });
    expect(response.table[0]?.t as number).toBeGreaterThan(0);
    expect(response.diagnostics.warnings.map((w) => w.code)).toContain('G8_NEGATIVE_ORDER');
    const warning = response.diagnostics.warnings.find((w) => w.code === 'G8_NEGATIVE_ORDER');
    expect(warning?.message).toMatch(/physically unusual/i);
  });
});

describe('G9, large order approaching complete conversion does not overflow', () => {
  it('stays finite at the top of the order range and deep into the ladder', () => {
    // (1−X)^(1−n) would be ~1e35 if formed directly; evaluating g in log space keeps
    // every intermediate representable.
    const response = success({ ...base, params: { n: 6 }, targets: { X: [0.99, 0.9999999] } });
    for (const row of response.table) {
      expect(Number.isFinite(row.t as number)).toBe(true);
      expect(row.t as number).toBeGreaterThan(0);
    }
  });

  it('rejects an order outside the range the model declares', () => {
    const error = failure({ ...base, params: { n: 12 } });
    expect(error.code).toBe('PARAM_OUT_OF_DOMAIN');
    expect(error.message).toMatch(/at most 6/);
  });

  it('warns when a time has passed the point of meaning anything', () => {
    expect(warningCodes({ ...base, params: { n: 6 }, targets: { X: [0.9999999] } })).toContain(
      'G9_CLAMPED_DISPLAY',
    );
  });
});

describe('G10, extrapolation far past the measurement is loud', () => {
  it('fires beyond a factor of ten in g', () => {
    const response = success({ ...base, targets: { X: [0.999] } });
    const warning = response.diagnostics.warnings.find((w) => w.code === 'G10_FAR_EXTRAPOLATION');
    expect(warning?.severity).toBe('loud');
    expect(warning?.message).toMatch(/where kinetic predictions fail/i);
  });

  it('stays quiet close to the measurement', () => {
    expect(warningCodes({ ...base, targets: { X: [0.3] } })).not.toContain(
      'G10_FAR_EXTRAPOLATION',
    );
  });
});

describe('G11, wide temperature extrapolation is unreliable', () => {
  it('warns beyond 20 K', () => {
    expect(
      warningCodes({ ...base, temperature: { basis: 293.15, predictAt: 353.15, Ea: 80000 } }),
    ).toContain('G11_WIDE_TEMPERATURE_SHIFT');
  });

  it('stays quiet within 20 K', () => {
    expect(
      warningCodes({ ...base, temperature: { basis: 293.15, predictAt: 303.15, Ea: 80000 } }),
    ).not.toContain('G11_WIDE_TEMPERATURE_SHIFT');
  });
});

describe('G12, temperatures at or below absolute zero are rejected', () => {
  it('rejects 0 K', () => {
    const error = failure({
      ...base,
      observations: [{ t: 6, X: 0.21, T: 0 }],
      temperature: { basis: 293.15 },
    });
    expect(error.code).toBe('G12_NONPOSITIVE_TEMPERATURE');
    expect(error.message).toMatch(/absolute zero/i);
  });

  it('rejects a Celsius value below absolute zero', () => {
    const error = failure({
      ...base,
      observations: [{ t: 6, X: 0.21, T: -300 }],
      temperature: { basis: 20 },
      units: { time: 'h', temperature: 'C' },
    });
    expect(error.code).toBe('G12_NONPOSITIVE_TEMPERATURE');
  });
});

describe('G13, underdetermined fits are refused, not guessed', () => {
  it('one point and a free parameter with no plausible ladder', () => {
    // The registry decides which of the two honest answers applies. A parameter with a
    // declared ladder is banded, because the data really do fit every value on it; one
    // without a ladder has no principled set of values to sweep, so the only honest
    // answer is to ask for more data. Volume expansivity is the latter.
    const error = failure({
      ...base,
      model: 'var-volume',
      params: { n: 1, eps: null },
      observations: [{ t: 6, X: 0.21, T: 293.15 }],
    });
    expect(error.code).toBe('G13_UNDERDETERMINED');
    expect(error.message).toMatch(/at least 2 measurements/i);
  });

  it('bands rather than refuses when the free parameter has a ladder', () => {
    const result = solve({
      ...base,
      model: 'michaelis-menten',
      params: { kappa: null },
      observations: [{ t: 6, X: 0.21, T: 293.15 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.headline.kind).toBe('band');
    expect(result.value.resolved.identifiable).toBe(false);
    // The ladder walks the ratio in decades around 1, so it spans the two limiting
    // orders it bridges rather than sitting entirely inside one of them.
    expect(result.value.band?.values).toEqual([0.1, 0.3, 1, 3, 10]);
    expect(result.value.diagnostics.warnings.map((w) => w.code)).toContain(
      'ORDER_ASSUMED_NOT_FITTED',
    );
  });

  it('two free parameters at once', () => {
    const error = failure({
      ...base,
      model: 'var-volume',
      params: { n: null, eps: null },
      observations: [
        { t: 6, X: 0.21, T: 293.15 },
        { t: 24, X: 0.6, T: 293.15 },
      ],
    });
    expect(error.code).toBe('G13_UNDERDETERMINED');
    expect(error.message).toMatch(/two-dimensional/i);
  });
});

describe('G14, an autocatalytic reaction needs a seed', () => {
  it('rejects r0 = 0 and explains that the reaction never starts', () => {
    const error = failure({ ...base, model: 'autocatalytic', params: { r0: 0 } });
    expect(error.code).toBe('PARAM_OUT_OF_DOMAIN');
    expect(error.message).toMatch(/greater than 0/);
    expect(error.message).toMatch(/seed/i);
  });
});

describe('G15, conversion must lie in the possible range', () => {
  it('rejects a conversion above 100%', () => {
    const error = failure({ ...base, observations: [{ t: 6, X: 21 }], targets: { X: [150] } });
    expect(error.code).toBe('G15_CONVERSION_OUT_OF_RANGE');
  });

  it('rejects a negative conversion', () => {
    expect(failure({ ...base, observations: [{ t: 6, X: -0.2 }] }).code).toBe(
      'G15_CONVERSION_OUT_OF_RANGE',
    );
  });

  it('reads values above 1 as percentages and echoes the format back', () => {
    // 21 can only mean 21%, so the whole request is read on that scale and the
    // interpretation is reported rather than assumed silently.
    const response = success({ ...base, observations: [{ t: 6, X: 21 }], targets: { X: [90] } });
    expect(response.units.conversion).toBe('percent');
    expect(response.resolved.K).toBeCloseTo(0.0392871, 7);
    expect(response.table[0]?.t as number).toBeCloseTo(58.61, 2);
  });
});

describe('G16, conversion falling with time is flagged, not silently fitted', () => {
  it('names a model that can explain it', () => {
    const response = success({
      ...base,
      observations: [
        { t: 2, X: 0.3, T: 293.15 },
        { t: 6, X: 0.21, T: 293.15 },
      ],
    });
    const warning = response.diagnostics.warnings.find((w) => w.code === 'G16_NON_MONOTONE');
    expect(warning?.severity).toBe('loud');
    expect(warning?.message).toMatch(/equilibrium|side reaction/i);
    expect(warning?.detail?.suggestedModel).toBe('reversible-1');
  });
});

describe('G17, an ill-conditioned two-point fit reports no order', () => {
  it('refuses when the two conversions are effectively identical', () => {
    const error = failure({
      ...base,
      params: { n: null },
      observations: [
        { t: 6, X: 0.21, T: 293.15 },
        { t: 6.5, X: 0.2100001, T: 293.15 },
      ],
    });
    expect(error.code).toBe('G13_UNDERDETERMINED');
    expect(error.message).toMatch(/same conversion/i);
  });

  it('refuses when the implied ratio is outside anything the model can produce', () => {
    const error = failure({
      ...base,
      params: { n: null },
      observations: [
        { t: 1, X: 0.5, T: 293.15 },
        { t: 1.05, X: 0.9, T: 293.15 },
      ],
    });
    expect(error.code).toBe('RATIO_OUTSIDE_ACHIEVABLE_RANGE');
    expect(error.message).toMatch(/data and the model disagree/i);
  });
});

describe('G18, a Q10-derived activation energy is always tagged', () => {
  it('labels the source and warns loudly', () => {
    const response = success({
      ...base,
      temperature: { basis: 293.15, predictAt: 303.15, q10: 2 },
    });
    expect(response.temperature?.eaSource).toBe('q10-heuristic');
    const warning = response.diagnostics.warnings.find((w) => w.code === 'G18_Q10_HEURISTIC');
    expect(warning?.severity).toBe('loud');
    expect(warning?.message).toMatch(/rule of thumb/i);
  });

  it('means a factor of Q10 per ten kelvin, not per shift', () => {
    // Q10 = 2 over 20 K is four times faster, not twice. Deriving Ea with ΔT in the
    // denominator instead of 10 gives the right answer only for a 10 K shift and halves
    // the exponent for a 20 K one.
    const at90 = (predictAt: number, q10: number): number => {
      const response = success({ ...base, temperature: { basis: 293.15, predictAt, q10 } });
      return response.table.find((r) => r.X === 0.9)?.t as number;
    };
    const atBase = 58.6093;

    expect(atBase / at90(303.15, 2)).toBeCloseTo(2, 3);
    expect(atBase / at90(313.15, 2)).toBeCloseTo(4, 3);
    expect(atBase / at90(323.15, 2)).toBeCloseTo(8, 2);
    // A different Q10 scales the same way: 3 per 10 K is nine over 20 K.
    expect(atBase / at90(313.15, 3)).toBeCloseTo(9, 2);
  });

  it('prefers a supplied activation energy over the heuristic', () => {
    const request: SolveRequest = {
      ...base,
      temperature: { basis: 293.15, predictAt: 303.15, Ea: 75000 },
    };
    expect(success(request).temperature?.eaSource).toBe('user');
    expect(warningCodes(request)).not.toContain('G18_Q10_HEURISTIC');
  });
});
