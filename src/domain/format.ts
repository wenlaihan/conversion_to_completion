/**
 * Number formatting for human-readable output.
 *
 * Shared by the registry's derivation text and the worked solution so both speak with
 * one voice, and so the explain layer need not reach into `models/`, which it is not
 * permitted to import.
 */

/** Compact, significant-figure-aware rendering. Never emits "Infinity" or "NaN". */
export const fmt = (value: number, digits = 6): string => {
  if (Number.isNaN(value)) return 'undefined';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';
  if (value === Math.trunc(value) && Math.abs(value) < 1e15) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e7)) {
    return value.toExponential(digits - 1);
  }
  return String(Number(value.toPrecision(digits)));
};

/** A conversion as a percentage, trimmed of trailing zeros. */
export const asPercent = (fraction: number, digits = 2): string => {
  const fixed = (fraction * 100).toFixed(digits);
  return `${fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed}%`;
};
