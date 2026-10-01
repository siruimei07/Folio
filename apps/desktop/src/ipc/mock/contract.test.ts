// Drift between the fake shell and the contract (docs/specs/ui-architecture.md §11.5). `tsc`
// catches changed shapes; this test catches every other change of bindings.ts, doc comments
// included, because a comment can carry behaviour ("`null`: cancelled").
import { describe, expect, it } from 'vitest';

import { commands, events } from '../bindings';
import bindings from '../bindings.ts?raw';
import { createHandlers } from './commands';
import { fingerprint, REVIEWED_BINDINGS, snakeCase } from './contract';
import { scenarioFixture } from './scenarios';
import { FakeShell } from './shell';

describe('the fake shell follows the bindings', () => {
  it('was reviewed against this bindings.ts', () => {
    const current = fingerprint(bindings);
    expect(
      current,
      [
        'bindings.ts changed since the fake shell (src/ipc/mock/) was last compared with it.',
        'The lane that changed the contract updates the fake in the same change: compare the',
        'change with the command files in src/ipc/mock/commands/ and the spec sections they name,',
        `update the fake, then set REVIEWED_BINDINGS in src/ipc/mock/contract.ts to '${current}'.`,
        'Implementation lanes do not change bindings.ts; that belongs in a contract lane',
        '(roadmap §4 rule 2).',
      ].join('\n'),
    ).toBe(REVIEWED_BINDINGS);
  });

  it('answers every command the bindings declare, and nothing else', () => {
    const shell = new FakeShell({ fixture: scenarioFixture('first-run', 0).fixture });
    const declared = Object.keys(commands).map(snakeCase).sort();
    expect(Object.keys(createHandlers(shell)).sort()).toEqual(declared);
    shell.dispose();
  });

  it('knows every event the bindings declare', () => {
    // The fake emits all of these but MaximizeButtonChanged, which only the native overlay sends.
    expect(Object.keys(events).sort()).toEqual([
      'appSettingsChanged',
      'catalogChanged',
      'dropHover',
      'filesDropped',
      'ignoreRulesChanged',
      'jobChanged',
      'libraryStateChanged',
      'maximizeButtonChanged',
      'problemsChanged',
    ]);
  });

  it('fingerprints text the same whatever its line endings', () => {
    expect(fingerprint('a\r\nb\n')).toBe(fingerprint('a\nb\n'));
    expect(fingerprint('a\nb\n')).not.toBe(fingerprint('a\nb \n'));
  });
});
