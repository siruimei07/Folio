// The fake shell's contract with the generated bindings (docs/specs/ui-architecture.md §11.5).
//
// Shapes: `Handlers` is derived from `commands` in bindings.ts, so a new, renamed or reshaped
// command fails `tsc` until the fake follows it.
// Behaviour: `REVIEWED_BINDINGS` is the fingerprint of the bindings the fake was last compared
// with. `contract.test.ts` fails when bindings.ts changes, even in a doc comment, until the lane
// that changed the contract compares the change with the command files here (each names the spec
// sections it follows), updates the fake, and records the new fingerprint that the failure prints.
import type { commands } from '../bindings';

type Commands = typeof commands;

/** `listChildren` → `list_children`, as Tauri names commands (ipc-m1 §4). */
type SnakeCase<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${SnakeCase<Tail>}`
  : S;

/** What a command resolves to when it succeeds. */
type Data<F> = F extends (...args: never[]) => Promise<infer Result>
  ? Extract<Result, { status: 'ok' }> extends { data: infer D }
    ? D
    : never
  : never;

/** Every command of the bindings, by the name the shell registers. */
export type CommandName = SnakeCase<keyof Commands>;

/** One handler per command: the command's arguments in, its data out, or a thrown `ShellFailure`. */
export type Handlers = {
  [K in keyof Commands as SnakeCase<K>]: (
    ...args: Parameters<Commands[K]>
  ) => Data<Commands[K]> | Promise<Data<Commands[K]>>;
};

/** Part of `Handlers`, for one command group's file. */
export type GroupHandlers<Name extends CommandName> = Pick<Handlers, Name>;

/** A command name as Tauri registers it. */
export function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * A short fingerprint of text (cyrb53), with line endings normalised so a checkout with CRLF
 * gives the same value. Not for security: it only notices that the bindings changed.
 */
export function fingerprint(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < normalised.length; index++) {
    const code = normalised.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** The fingerprint of the bindings.ts the fake shell was last reviewed against. */
export const REVIEWED_BINDINGS = '1014b6bc0fc50d';
