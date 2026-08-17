/**
 * Display formatting shared by the Estimate page and the fit results.
 *
 * One module owns the precision rules so the two pages cannot drift apart:
 * percentages are integers (a conversion target is not measured to a tenth of a
 * percent), times carry at most three significant figures, temperatures show whole
 * degrees unless the input itself was finer, and rate constants get fixed
 * significant figures with scientific notation at the extremes.
 */

/** A conversion fraction as a whole-number percentage: 0.9 becomes "90%". */
export const fmtPercent = (X: number): string =>
  Number.isFinite(X) ? `${Math.round(X * 100)}%` : 'n/a';

const trimmed = (v: number, sig: number): string => String(Number(v.toPrecision(sig)));

/**
 * A time in its display unit: two significant figures, three once the value needs
 * them to stay an integer ("70 min", "2.2 h", "132 min", never "70.00 min").
 */
export const fmtTime = (v: number): string => {
  if (!Number.isFinite(v)) return 'n/a';
  return trimmed(v, Math.abs(v) >= 100 ? 3 : 2);
};

/** A dimensionless multiplier, two significant figures: "1.9x faster". */
export const fmtFactor = (v: number): string => (Number.isFinite(v) ? trimmed(v, 2) : 'n/a');

/** A temperature: whole degrees, one decimal only when the value itself carries it. */
export const fmtTemp = (v: number): string =>
  Number.isFinite(v) ? String(Number(v.toFixed(1))) : 'n/a';

/**
 * A rate constant: three significant figures, scientific notation once the value
 * leaves the comfortable range. Units are the caller's job; they depend on the
 * order and must always ride beside the number.
 */
export const fmtRate = (v: number): string => {
  if (!Number.isFinite(v)) return 'n/a';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-3) return v.toExponential(2);
  return trimmed(v, 3);
};

/**
 * Whether a what-if comparison is worth a sentence: both values real, and the
 * relative difference at least the threshold (default 5 percent). Below that the
 * readout stays silent rather than reporting noise.
 */
export const meaningfulChange = (a: number, b: number, threshold = 0.05): boolean => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return false;
  return Math.abs(a - b) / scale >= threshold;
};
