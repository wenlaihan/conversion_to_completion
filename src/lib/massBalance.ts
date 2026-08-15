/**
 * Mass-balance column detection.
 *
 * Time-course files routinely carry a bookkeeping column, the row-wise total that
 * checks nothing was lost. It must never become a species in the fitting network,
 * but its points still belong on the chart. Two independent routes flag it: the
 * name, and the numbers; either alone suffices, and the UI lets the user override
 * both ways, so a false positive or a miss is always recoverable.
 */

const NAME_KEYS = [
  'massbalance',
  'massbal',
  'materialbalance',
  'matbalance',
  'totalmass',
  'totalconcentration',
  'totalconc',
  'recovery',
  'balance',
  'total',
  'sum',
] as const;

/**
 * Name route, case-insensitive, ignoring units, punctuation and underscores:
 * "Mass Balance (%)", "mass_bal", "MB", "Total conc (M)" all match.
 */
export const isMassBalanceName = (name: string): boolean => {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'mb') return true;
  return NAME_KEYS.some((key) => normalized === key || normalized.startsWith(key));
};

const REL_TOL = 0.05;
const MIN_ROWS = 4;

/**
 * Numeric route: the column is approximately the row-wise sum of the other
 * columns, or approximately constant near 100 (a percentage balance beside
 * concentration columns).
 */
export const looksLikeMassBalance = (
  column: readonly number[],
  others: readonly (readonly number[])[],
): boolean => {
  if (column.length < MIN_ROWS) return false;

  if (others.length > 0) {
    let hits = 0;
    let rows = 0;
    for (let i = 0; i < column.length; i += 1) {
      const value = column[i] as number;
      const sum = others.reduce((a, series) => a + (series[i] ?? 0), 0);
      if (!Number.isFinite(value) || !Number.isFinite(sum)) continue;
      rows += 1;
      const scale = Math.max(Math.abs(value), Math.abs(sum), 1e-12);
      if (Math.abs(value - sum) / scale <= REL_TOL) hits += 1;
    }
    if (rows >= MIN_ROWS && hits / rows >= 0.8) return true;
  }

  const finite = column.filter((v) => Number.isFinite(v));
  if (finite.length < MIN_ROWS) return false;
  const mean = finite.reduce((a, v) => a + v, 0) / finite.length;
  const spread = Math.max(...finite) - Math.min(...finite);
  return mean >= 80 && mean <= 120 && spread / Math.abs(mean) <= 0.1;
};

/**
 * The columns of one run that read as mass balance, name route first, numeric
 * route as backstop against the columns the name route left as species.
 */
export const detectMassBalance = (
  series: Readonly<Record<string, readonly number[]>>,
): string[] => {
  const names = Object.keys(series);
  const byName = names.filter((name) => isMassBalanceName(name));
  const speciesNames = names.filter((name) => !byName.includes(name));
  const byNumbers = speciesNames.filter((name) =>
    looksLikeMassBalance(
      series[name] as readonly number[],
      speciesNames
        .filter((other) => other !== name)
        .map((other) => series[other] as readonly number[]),
    ),
  );
  return [...byName, ...byNumbers];
};
