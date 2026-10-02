#!/usr/bin/env node
// Commits are Sirui's (CLAUDE.md §7.1 rule 5): author and committer are Sirui Mei
// <sirui.mei07@gmail.com>, and no agent puts its name, model, session, link or co-author
// trailer into a commit message. `pnpm check` runs this on the commits not yet on origin/main;
// CI (and `--all`) runs it on every commit reachable from HEAD.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const NAME = 'Sirui Mei';
export const EMAIL = 'sirui.mei07@gmail.com';

/** Message patterns that credit an agent, each with what it catches for the error line. */
const FORBIDDEN = [
  [/^[\w-]*(co-?authored|assisted|generated|signed-off|helped|reviewed)[\w-]*\s*:/im, 'a credit trailer (Co-Authored-By, Signed-off-by, Assisted-by …)'],
  [/^[\w-]*(claude|codex|anthropic|openai|chatgpt|copilot|cursor|gemini|deepseek)[\w-]*\s*:/im, 'an agent-named trailer (Claude-Session: …)'],
  [/\bgenerated\s+(with|by|using)\b/i, '"Generated with/by …"'],
  [/\b(written|authored|created|drafted|made)\s+(by|with)\s+(claude|codex|chatgpt|gpt|copilot|cursor|gemini|deepseek|an?\s+(ai|agent|assistant))\b/i, 'an "authored by <agent>" line'],
  [/(claude\.ai|claude\.com|anthropic\.com|openai\.com|chatgpt\.com|cursor\.(com|sh))/i, 'an agent vendor link or e-mail'],
  [/🤖/u, 'the robot emoji'],
];

const WORKSPACE_COMMIT = 'GitButler Workspace Commit';

/** What is wrong with one commit: its identities and its message. */
export function problemsIn({ an, ae, cn, ce, body }) {
  const problems = [];
  if (an !== NAME || ae !== EMAIL) problems.push(`author is ${an} <${ae}>, not ${NAME} <${EMAIL}>`);
  if (cn !== NAME || ce !== EMAIL) problems.push(`committer is ${cn} <${ce}>, not ${NAME} <${EMAIL}>`);
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(body)) problems.push(`message contains ${what}`);
  return problems;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function hasRef(ref) {
  try {
    git('rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const all = process.argv.includes('--all') || process.env.GITHUB_ACTIONS === 'true';
  const range = all || !hasRef('origin/main') ? ['HEAD'] : ['HEAD', '--not', 'origin/main'];
  const commits = git('log', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e', ...range)
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, an, ae, cn, ce, body] = record.split('\x1f');
      return { hash, an, ae, cn, ce, body: body.trimEnd() };
    })
    // GitButler's own merge commit for the applied branches never lands; skip it.
    .filter((c) => !(c.ae === 'gitbutler@gitbutler.com' && c.body.startsWith(WORKSPACE_COMMIT)));

  const report = commits.flatMap((c) =>
    problemsIn(c).map((p) => `${c.hash.slice(0, 10)} ${c.body.split('\n')[0]}\n    ${p}`),
  );
  const scope = all ? 'whole history' : 'not yet on origin/main';
  if (report.length) {
    console.error(`check-commits: ${report.length} problem(s), ${scope} (CLAUDE.md §7.1 rule 5):\n  ${report.join('\n  ')}`);
    console.error(`\nFix: git config --global user.email ${EMAIL}; for unpushed commits, \`but reword\` the message or \`but uncommit\` and commit again.`);
    process.exitCode = 1;
  } else {
    console.log(`check-commits: ${commits.length} commit(s) by ${NAME} <${EMAIL}>, no agent attribution (${scope})`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
