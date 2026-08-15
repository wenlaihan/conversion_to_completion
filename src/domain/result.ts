/**
 * Result<T, E>, expected failures are values, not exceptions.
 *
 * Exceptions are reserved for programmer error. Everything a user can provoke
 * (unreachable conversion, no root in range, underdetermined fit) travels as an
 * `err` carrying a typed code, so no failure can be silently swallowed.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const map = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

export const flatMap = <T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> =>
  r.ok ? f(r.value) : r;

/** Collects a list of Results into a Result of a list, short-circuiting on the first error. */
export const all = <T, E>(results: readonly Result<T, E>[]): Result<readonly T[], E> => {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
};

/** Unwraps, throwing on error. Only for call sites where an error would be a programmer bug. */
export const expect = <T, E>(r: Result<T, E>, context: string): T => {
  if (r.ok) return r.value;
  throw new Error(`${context}: ${JSON.stringify(r.error)}`);
};
