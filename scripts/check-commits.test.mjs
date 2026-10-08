import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EMAIL, GITHUB_WEB, NAME, problemsIn } from './check-commits.mjs';

const sirui = { an: NAME, ae: EMAIL, cn: NAME, ce: EMAIL };
const message = (body) => problemsIn({ ...sirui, body });

test('accepts ordinary messages, including ones that name the tools as subjects', () => {
  for (const body of [
    'feat(ui): add the Ctrl+K search palette',
    'docs(agents): hand off through GitHub\n\nCopies of Codex\'s workflow guide and Claude Code\'s project memory.',
    'docs: keep CLAUDE.md and AGENTS.md in step\n\nCLAUDE.md: the commit identity rule.',
    'fix(core): address import review findings (WIP checkpoint)',
    'chore(app): disable browser accelerators before release navigation',
  ])
    assert.deepEqual(message(body), [], body);
});

test('rejects agent credits in any form', () => {
  for (const body of [
    'feat(x): y\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    'feat(x): y\n\nCo-authored-by: Codex <codex@openai.com>',
    'fix: a\n\nGenerated with Claude Code',
    'fix: a\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    'docs: b\n\nClaude-Session: 19bdb2fa',
    'docs: b\n\nCodex-Task: 42',
    'docs: c\n\nSigned-off-by: Some Agent <agent@example.com>',
    'docs: d\n\nWritten by Claude.',
    'docs: e\n\nDrafted with an AI assistant.',
    'chore: 🤖 bump',
  ])
    assert.notDeepEqual(message(body), [], body);
});

test('rejects any identity but Sirui as author or committer', () => {
  const body = 'fix: a';
  assert.equal(problemsIn({ ...sirui, ae: 'sirui.mei@school.example.edu', body }).length, 1);
  assert.equal(problemsIn({ ...sirui, cn: 'GitButler', ce: 'gitbutler@gitbutler.com', body }).length, 1);
  assert.equal(problemsIn({ an: 'Claude', ae: 'noreply@anthropic.com', cn: NAME, ce: EMAIL, body }).length, 1);
});

test("accepts GitHub's web-flow committer only on Sirui's own commits", () => {
  const web = { cn: GITHUB_WEB.name, ce: GITHUB_WEB.email, body: 'Add LICENSE file' };
  assert.deepEqual(problemsIn({ an: NAME, ae: EMAIL, ...web }), []);
  assert.equal(problemsIn({ an: 'Claude', ae: 'noreply@anthropic.com', ...web }).length, 2);
  assert.equal(problemsIn({ an: NAME, ae: EMAIL, cn: 'GitHub', ce: 'web-flow@example.com', body: 'fix: a' }).length, 1);
});
