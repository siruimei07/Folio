// Object ids as the history format writes them (docs/specs/ipc-m2.md §4): `b3:` and 64 lowercase
// hexadecimal digits.

/** The 64 hexadecimal digits of an object id or content hash, without `b3:`. */
export function hexOf(id: string): string {
  return id.replace(/^b3:/, '');
}

/** The short id History shows: the first 7 hexadecimal digits ("b7c1e20"). */
export function shortId(id: string): string {
  return hexOf(id).slice(0, 7);
}
