/**
 * Serialization safety.
 *
 * `JSON.stringify({t: Infinity})` produces `{"t":null}`, and so does `NaN`. An
 * asymptotic completion time would therefore reach the UI indistinguishable from "not
 * computed", destroying exactly the output this engine exists to get right. Completion
 * is modelled as a tagged union so a non-finite number never needs to be sent; this is
 * the assertion that the modelling actually held.
 *
 * A failure here is a programmer error, not a user error, so it throws rather than
 * returning a Result.
 */

const describePath = (path: readonly string[]): string =>
  path.length === 0 ? '<root>' : path.join('.');

export const assertSerializable = (value: unknown, path: readonly string[] = []): void => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Response field ${describePath(path)} is ${String(value)}, which JSON would silently turn into null. Represent unbounded results with an explicit tagged value instead.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertSerializable(entry, [...path, String(i)]));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      assertSerializable(entry, [...path, key]);
    }
  }
};

/** Maps a typed error code to the HTTP status a client should see. */
export const statusFor = (code: string): number => {
  if (code === 'UNKNOWN_MODEL' || code === 'UNKNOWN_PARAM') return 404;
  if (code === 'QUADRATURE_BUDGET_EXCEEDED' || code === 'ROOT_NOT_BRACKETED') return 500;
  // Everything else is the caller describing an experiment the model cannot represent:
  // a well-formed request with unprocessable content, rather than a server fault.
  return 422;
};
