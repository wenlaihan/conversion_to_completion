/**
 * The units a rate constant carries.
 *
 * A rate law of overall order n, rate = k * C^n, forces k to carry
 * concentration^(1-n) * time^-1: M/s at zero order, per second at first order, per
 * molar per second at second order. Printing "s^-1" for every order is a common and
 * consequential bug, so the units are computed from the order in one place and used by
 * both the single-species facade and the network fitter.
 */

export interface UnitLabels {
  /** Concentration unit, for example "M". */
  readonly conc: string;
  /** Time unit, for example "min". */
  readonly time: string;
}

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

const superscript = (value: number): string => {
  const text = String(value);
  return [...text].every((ch) => ch in SUPERSCRIPT)
    ? [...text].map((ch) => SUPERSCRIPT[ch] as string).join('')
    : `^${text}`;
};

/**
 * The units of k for a rate law of the given overall order.
 *
 * The order is the molecularity of the step as written, counting every reactant with
 * its stoichiometric coefficient, catalysts included: `S + Cat -> P + Cat` is second
 * order and its constant is M⁻¹·s⁻¹, even though the fit itself only ever sees a
 * pseudo-first-order decay.
 */
export const rateConstantUnits = (order: number, units: UnitLabels): string => {
  const perTime = `${units.time}${superscript(-1)}`;
  if (!Number.isFinite(order)) return perTime;
  const exponent = Number((1 - order).toPrecision(12));
  if (exponent === 0) return perTime;
  if (exponent === 1) return `${units.conc}·${perTime}`;
  return `${units.conc}${superscript(exponent)}·${perTime}`;
};
