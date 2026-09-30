// Catalog revisions are 32-bit counters that wrap (ipc-m1 §15.2), so they compare with serial
// number arithmetic (RFC 1982; UI architecture §5.4).

const SPAN = 2 ** 32;
const HALF = 2 ** 31;

/** Whether revision `a` came before `b`: `(b - a) mod 2³²` is between 1 and 2³¹ − 1. */
export function isOlderRevision(a: number, b: number): boolean {
  const distance = (((b - a) % SPAN) + SPAN) % SPAN;
  return distance >= 1 && distance < HALF;
}

/** The newer of two revisions. */
export function newerRevision(a: number, b: number): number {
  return isOlderRevision(a, b) ? b : a;
}
