#!/usr/bin/env node
// `pnpm roadmap <command>`: read, update, check and serve docs/roadmap/roadmap.json.
// The commands and the data format are described in docs/roadmap/README.md.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY,
  GATE_STATES,
  GATES,
  STATUSES,
  auditEffortFor,
  auditModelFor,
  byId,
  canonical,
  codexPrompts,
  composePrompt,
  criticalPath,
  dependents,
  displayStatus,
  effortFor,
  isCodex,
  laneFile,
  modelFor,
  modelName,
  sharedPaths,
  tally,
  today,
  unlocks,
  validate,
} from './lib.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROADMAP = path.dirname(TOOLS);
const REPO = path.resolve(ROADMAP, '..', '..');
const DATA_FILE = path.join(ROADMAP, 'roadmap.json');
const PAGE_FILE = path.join(ROADMAP, 'index.html');
const DIST_FILE = path.join(ROADMAP, 'dist', 'explorer.html');

class UsageError extends Error {}

function load() {
  const text = readFileSync(DATA_FILE, 'utf8');
  try {
    return { data: JSON.parse(text), text };
  } catch (error) {
    throw new UsageError(`docs/roadmap/roadmap.json is not valid JSON: ${error.message}`);
  }
}

function save(data) {
  const { errors } = validate(data);
  if (errors.length) throw new UsageError(`refusing to write invalid data:\n  ${errors.join('\n  ')}`);
  writeFileSync(DATA_FILE, canonical(data));
}

/** Accepts a full id, the lane-file form (feat--ui-preview) or a unique tail (ui-preview). */
function findLane(data, query) {
  if (!query) throw new UsageError('name a lane, e.g. feat/ui-preview');
  const exact = data.lanes.find((l) => l.id === query || laneFile(l.id) === query);
  if (exact) return exact;
  const tails = data.lanes.filter((l) => l.id.endsWith(`/${query}`));
  if (tails.length === 1) return tails[0];
  const matches = data.lanes.filter((l) => l.id.includes(query));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new UsageError(`no lane matches "${query}"`);
  throw new UsageError(`"${query}" matches ${matches.map((l) => l.id).join(', ')}`);
}

/** Splits `--name value` / `--flag` options from positional arguments. */
function parse(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (arg.startsWith('--no-')) options[arg.slice(5)] = false;
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[(i += 1)];
    else options[arg.slice(2)] = true;
  }
  return { positional, options };
}

/** "Sonnet 5.5 · low": the model and effort to start a lane's session at. */
const run = (data, lane) => `${modelName(data, modelFor(lane, data))} · ${effortFor(lane)}`;
/** The same for the Claude Code audit of a Codex lane. */
const audit = (data, lane) => `${modelName(data, auditModelFor(lane, data))} · ${auditEffortFor(lane)}`;
/** What a Claude Code session for this lane runs at now: the audit once a Codex lane is in review. */
const session = (data, lane) => (!isCodex(lane) ? run(data, lane) : lane.status === 'review' ? `audit ${audit(data, lane)}` : 'Codex');

const tag = (lane, lanes) => {
  const shown = displayStatus(lane, lanes);
  return `${DISPLAY[shown].mark} ${DISPLAY[shown].label}`;
};

function check() {
  const { data, text } = load();
  const { errors, warnings } = validate(data);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (text !== canonical(data)) errors.push('roadmap.json is not in canonical formatting: run `pnpm roadmap fmt`');
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exitCode = 1;
    return;
  }
  const { total } = tally(data);
  const counts = Object.entries(total)
    .sort(([a], [b]) => DISPLAY[a].order - DISPLAY[b].order)
    .map(([status, n]) => `${DISPLAY[status].label} ${n}`)
    .join(' · ');
  console.log(`roadmap.json OK: ${data.lanes.length} lanes (${counts})`);
}

function next() {
  const { data } = load();
  const lanes = byId(data);
  const shown = (lane) => displayStatus(lane, lanes);
  console.log(`# ${data.now.stage}\n`);
  for (const line of data.now.summary) console.log(`- ${line}`);

  console.log('\n## Landing queue (one at a time)');
  data.landingQueue.forEach((entry, i) => {
    const lane = lanes.get(entry.lane);
    const open = Object.entries(lane.gates ?? {}).filter(([, v]) => v === 'todo' || v === 'fail' || v === 'partial');
    const gates = open.length ? `  [open: ${open.map(([k, v]) => `${GATES[k]} ${v}`).join(', ')}]` : '';
    console.log(`${i + 1}. ${lane.id}  ${tag(lane, lanes)}  [${session(data, lane)}]${gates}\n   ${entry.why}`);
  });

  const active = data.lanes.filter((l) => shown(l) === 'wip');
  const rust = active.filter((l) => l.track === 'core').length;
  const ui = active.filter((l) => l.track === 'ui').length;
  console.log(`\n## In progress (Rust ${rust}/${data.limits.rustSessions}, UI ${ui}/${data.limits.uiSessions})`);
  for (const lane of active) console.log(`- ${lane.id} (${lane.agent}, ${session(data, lane)}): ${lane.next ?? ''}`);

  const codexOpen = data.lanes.filter((l) => codexPrompts(data, l));
  const codexReady = codexOpen.filter((l) => ['ready', 'queued'].includes(shown(l)));
  const codexReview = codexOpen.filter((l) => l.status === 'review');
  console.log(`\n## Codex (backend): ${codexOpen.length} open lanes`);
  for (const lane of codexReady) console.log(`- hand to Codex: ${lane.id}  →  pnpm roadmap prompt ${lane.id} --codex`);
  for (const lane of codexReview) console.log(`- Claude audit (${audit(data, lane)}): ${lane.id}  →  pnpm roadmap prompt ${lane.id} --audit`);
  if (!codexReady.length && !codexReview.length) console.log('- nothing to hand over or audit right now');

  console.log('\n## Can start now');
  for (const lane of data.lanes.filter((l) => ['ready', 'queued'].includes(shown(l))))
    console.log(`- ${tag(lane, lanes)}  ${lane.id} [${lane.track}, ${lane.size}, ${session(data, lane)}]${lane.hold ? `: ${lane.hold}` : ''}`);

  const focusGate = data.lanes.find((l) => l.kind === 'gate' && l.milestone === data.now.focus);
  if (focusGate) {
    const { path: chain } = criticalPath(data, focusGate.id);
    console.log(`\n## Critical path to ${focusGate.id}\n${chain.join(' → ')}`);
  }

  console.log('\n## Needs Sirui');
  for (const d of data.decisions.filter((x) => x.state === 'open' || x.state === 'recurring'))
    console.log(`- [${d.when}] ${d.item}`);
}

function show(args) {
  const { data } = load();
  const lane = findLane(data, args.positional[0]);
  const lanes = byId(data);
  const deps = dependents(data).get(lane.id);
  const line = (label, value) => value !== undefined && value !== '' && console.log(`${label.padEnd(10)}${value}`);
  console.log(`${lane.id} — ${lane.title}`);
  line('status', `${tag(lane, lanes)} (stored: ${lane.status}, updated ${lane.updated})`);
  line('where', `${lane.milestone} · ${data.phases.find((p) => p.id === lane.phase)?.label} · ${lane.track} · ${lane.size}`);
  line('agent', lane.reviewer ? `${lane.agent} (review: ${lane.reviewer})` : lane.agent);
  line('model', isCodex(lane)
    ? `Codex builds it; Claude Code audit at ${audit(data, lane)}${lane.auditModel || lane.auditEffort ? '' : ' (default by size)'}`
    : `${run(data, lane)}${lane.model || lane.effort ? '' : ' (default by size and track)'}`);
  line('summary', lane.summary);
  line('next', lane.next);
  line('hold', lane.hold);
  line('landed', lane.landed);
  line('lane file', `.agents/lanes/${laneFile(lane.id)}.md`);
  console.log('\nwaits for');
  for (const id of lane.deps) console.log(`  ${tag(lanes.get(id), lanes)}  ${id}`);
  if (!lane.deps.length) console.log('  —');
  if (lane.landAfter?.length) console.log(`land after\n  ${lane.landAfter.join('\n  ')}`);
  console.log('unblocks');
  for (const id of deps) console.log(`  ${tag(lanes.get(id), lanes)}  ${id}`);
  if (!deps.length) console.log('  —');
  const ready = unlocks(data, lane.id);
  if (lane.status !== 'done' && ready.length) console.log(`landing it makes ready: ${ready.join(', ')}`);
  if (lane.gates) {
    console.log('gates');
    for (const [key, value] of Object.entries(lane.gates)) console.log(`  ${GATES[key].padEnd(17)}${value}`);
  }
  for (const key of ['owns', 'shared', 'notes', 'links'])
    if (lane[key]?.length) console.log(`${key}\n  ${lane[key].join('\n  ')}`);
  const codex = codexPrompts(data, lane);
  if (codex) {
    console.log('');
    if (codex.handoff) console.log(`Codex handoff: pnpm roadmap prompt ${lane.id} --codex`);
    console.log(`Claude audit:  pnpm roadmap prompt ${lane.id} --audit`);
  } else console.log(composePrompt(data, lane) ? `\nprompt: pnpm roadmap prompt ${lane.id}` : '');
}

function prompt(args) {
  const { data } = load();
  const lane = findLane(data, args.positional[0]);
  const which = args.options.codex ? 'handoff' : args.options.audit ? 'audit' : null;
  const codex = codexPrompts(data, lane);
  if (which && !codex) throw new UsageError(`${lane.id} is not an open Codex lane`);
  const text = which ? codex[which] : composePrompt(data, lane);
  if (!text) throw new UsageError(`${lane.id} has no ${which === 'handoff' ? 'Codex handoff' : 'prompt'} (it is ${lane.status})`);
  console.log(text);
}

function status(args) {
  const { data } = load();
  const [query, value] = args.positional;
  const lane = findLane(data, query);
  if (!STATUSES.includes(value)) throw new UsageError(`status must be one of ${STATUSES.join(', ')}`);
  const { options } = args;
  lane.status = value;
  lane.updated = today();
  if (typeof options.next === 'string') lane.next = options.next;
  if (typeof options.hold === 'string') lane.hold = options.hold;
  if (options.hold === false || value !== 'planned') delete lane.hold;
  if (value === 'done') {
    lane.landed = typeof options.landed === 'string' ? options.landed : today();
    delete lane.next;
    data.landingQueue = data.landingQueue.filter((entry) => entry.lane !== lane.id);
  }
  save(data);
  const ready = value === 'done' ? unlocks(data, lane.id) : [];
  const lanes = byId(data);
  const nowReady = ready.filter((id) => displayStatus(lanes.get(id), lanes) !== 'locked');
  console.log(`${lane.id}: ${value}${nowReady.length ? ` — now startable: ${nowReady.join(', ')}` : ''}`);
}

function gate(args) {
  const { data } = load();
  const [query, ...pairs] = args.positional;
  const lane = findLane(data, query);
  if (!pairs.length) throw new UsageError(`give gates as name=state, e.g. e2e=pass (${Object.keys(GATES).join(', ')})`);
  lane.gates ??= {};
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (!(key in GATES)) throw new UsageError(`unknown gate "${key}" (${Object.keys(GATES).join(', ')})`);
    if (!GATE_STATES.includes(value)) throw new UsageError(`gate state must be one of ${GATE_STATES.join(', ')}`);
    lane.gates[key] = value;
  }
  lane.updated = today();
  save(data);
  console.log(`${lane.id}: ${pairs.join(' ')}`);
}

function note(args) {
  const { data } = load();
  const [query, text] = args.positional;
  const lane = findLane(data, query);
  if (!text) throw new UsageError('give the note text in quotes');
  lane.notes = [...(lane.notes ?? []), text];
  lane.updated = today();
  save(data);
  console.log(`${lane.id}: note added`);
}

function log(args) {
  const { data } = load();
  const [text] = args.positional;
  if (!text) throw new UsageError('give the log text in quotes');
  data.log.push({ at: today(), by: typeof args.options.by === 'string' ? args.options.by : 'Claude Code', text });
  save(data);
  console.log('log entry added');
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Compares the roadmap with the lane files on this device and the branches Git knows. */
function doctor() {
  const { data } = load();
  const lanes = byId(data);
  const findings = [];
  const laneDir = path.join(REPO, '.agents', 'lanes');
  const files = existsSync(laneDir) ? readdirSync(laneDir).filter((f) => f.endsWith('.md')) : [];
  const fileStatus = new Map();
  for (const file of files) {
    const text = readFileSync(path.join(laneDir, file), 'utf8');
    const id = text.match(/^# Lane: (\S+)/m)?.[1] ?? file.replace(/\.md$/, '').replaceAll('--', '/');
    const word = text.match(/^- Status: (\w+)/m)?.[1] ?? '';
    fileStatus.set(id, word);
  }
  const branches = new Set(
    git('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin')
      .split('\n')
      .map((b) => b.trim().replace(/^origin\//, ''))
      .filter(Boolean),
  );
  const asRoadmap = { planning: 'wip', editing: 'wip', checkpoint: 'wip', review: 'review', done: 'done' };
  for (const [id, word] of fileStatus) {
    const lane = lanes.get(id);
    if (!lane) findings.push(`lane file for ${id}, which roadmap.json does not list: add it`);
    else if (asRoadmap[word] && asRoadmap[word] !== lane.status)
      findings.push(`${id}: lane file says "${word}", roadmap says "${lane.status}" → pnpm roadmap status ${id} ${asRoadmap[word]}`);
  }
  for (const lane of data.lanes) {
    if (lane.kind === 'gate') continue;
    const active = lane.status === 'wip' || lane.status === 'review';
    if (active && !fileStatus.has(lane.id)) findings.push(`${lane.id} is ${lane.status} but has no lane file on this device`);
    if (active && branches.size && !branches.has(lane.id))
      findings.push(`${lane.id} is ${lane.status} but no branch of that name exists: landed? → pnpm roadmap status ${lane.id} done`);
    if (lane.status === 'planned' && branches.has(lane.id))
      findings.push(`${lane.id} has a branch but the roadmap says planned → pnpm roadmap status ${lane.id} wip`);
  }
  const overlap = sharedPaths(data).filter(({ lanes: ids }) => ids.filter((id) => lanes.get(id).status !== 'planned').length > 1);
  for (const { path: p, lanes: ids } of overlap.slice(0, 12))
    findings.push(`shared by active lanes: ${p} (${ids.join(', ')})`);
  if (!findings.length) console.log('doctor: roadmap, lane files and branches agree');
  for (const f of findings) console.log(`- ${f}`);
}

/** The explorer page with the shared logic and the data inlined; `wrap` adds a document skeleton. */
function render({ wrap }) {
  const { data } = load();
  const lib = readFileSync(path.join(TOOLS, 'lib.mjs'), 'utf8').replace(/^export /gm, '');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const page = readFileSync(PAGE_FILE, 'utf8')
    .replace('/*@lib*/', () => lib)
    .replace('/*@data*/null', () => json);
  if (!wrap) return page;
  return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${page}\n</body>\n</html>\n`;
}

function build() {
  const { errors } = validate(load().data);
  if (errors.length) throw new UsageError(`fix roadmap.json first (pnpm roadmap check)`);
  mkdirSync(path.dirname(DIST_FILE), { recursive: true });
  writeFileSync(DIST_FILE, render({ wrap: false }));
  console.log(`wrote ${path.relative(REPO, DIST_FILE).replaceAll('\\', '/')} — publish it as described in docs/roadmap/README.md`);
}

function serve(args) {
  const port = Number(args.options.port ?? 5199);
  const server = createServer((request, response) => {
    try {
      if (request.url === '/roadmap.json') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(readFileSync(DATA_FILE));
        return;
      }
      if (request.url !== '/' && !request.url.startsWith('/?') && !request.url.startsWith('/#')) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(render({ wrap: true }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error.message));
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`roadmap explorer: http://localhost:${port} (rebuilt on every load; Ctrl+C stops)`));
}

function fmt() {
  const { data } = load();
  writeFileSync(DATA_FILE, canonical(data));
  console.log('roadmap.json formatted');
}

const HELP = `pnpm roadmap <command>

  next                         where things stand: landing queue, active lanes, what can start, decisions
  show <lane>                  one lane: status, what it waits for and unblocks, gates, paths
  prompt <lane> [--codex | --audit]
                               print the lane's copyable prompt; for a Codex lane --codex is the
                               full handoff to Codex and --audit the short Claude Code audit
  status <lane> <status>       set done | review | wip | planned | dropped
        [--next "…"] [--hold "…" | --no-hold] [--landed YYYY-MM-DD]
  gate <lane> <gate>=<state>…  gates: ${Object.keys(GATES).join(', ')}; states: ${GATE_STATES.join(', ')}
  note <lane> "<text>"         add a note to a lane
  log "<text>" [--by <name>]   add a roadmap-wide log line (sync points only: it is a shared hunk)
  doctor                       compare with .agents/lanes/ and the Git branches
  check                        validate data and formatting (part of pnpm check)
  fmt                          rewrite roadmap.json in canonical formatting
  build                        write docs/roadmap/dist/explorer.html for publishing
  serve [--port 5199]          serve the explorer locally

<lane> is a full id (feat/ui-preview), its lane-file form (feat--ui-preview) or a unique tail (ui-preview).`;

const COMMANDS = { check, next, show, prompt, status, gate, note, log, doctor, build, serve, fmt };

const [command, ...rest] = process.argv.slice(2);
try {
  if (!command || command === 'help' || command === '--help') console.log(HELP);
  else if (!COMMANDS[command]) throw new UsageError(`unknown command "${command}"\n\n${HELP}`);
  else COMMANDS[command](parse(rest));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
