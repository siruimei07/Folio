import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  auditEffortFor,
  auditModelFor,
  byId,
  canonical,
  codexPrompts,
  composePrompt,
  criticalPath,
  displayStatus,
  downstream,
  effortFor,
  laneFile,
  modelFor,
  sharedPaths,
  startTemplate,
  taskDir,
  unlocks,
  validate,
} from './lib.mjs';

const real = JSON.parse(readFileSync(new URL('../roadmap.json', import.meta.url), 'utf8'));

/** A small valid roadmap: a → b → d, a → c → d, with c the heavier branch. */
function sample() {
  const lane = (id, deps, extra = {}) => ({
    id,
    title: id,
    milestone: 'M1',
    phase: 'w1',
    track: 'core',
    agent: 'claude-code',
    size: 'S',
    deps,
    summary: `summary of ${id}`,
    status: 'planned',
    updated: '2026-10-02',
    ...extra,
  });
  return {
    meta: { models: { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet' } },
    now: { stage: '', focus: 'M1', summary: [] },
    limits: { rustSessions: 3, uiSessions: 4 },
    runtime: {},
    agents: [{ id: 'claude-code' }, { id: 'codex' }],
    tracks: [{ id: 'core' }],
    milestones: [{ id: 'M1', state: 'active' }],
    phases: [{ id: 'w1', milestone: 'M1', label: 'Wave 1', kind: 'wave' }],
    lanes: [
      lane('feat/core-a', [], { status: 'done', landed: '2026-10-01' }),
      lane('feat/core-b', ['feat/core-a']),
      lane('feat/core-c', ['feat/core-a'], { size: 'L', hold: 'waits for a Rust slot' }),
      lane('feat/core-d', ['feat/core-b', 'feat/core-c'], { agent: 'codex', owns: ['crates/x/**'] }),
      lane('feat/core-e', ['feat/core-a'], { status: 'review', next: 'land', shared: ['crates/x/**'] }),
    ],
    landingQueue: [{ lane: 'feat/core-e', why: 'reviewed' }],
    decisions: [],
    looseEnds: [],
    risks: [],
    rules: [],
    prompts: {
      land: ['Land {lane} ({laneFile}, {taskDir}).', '{extra}', 'Done.'],
      start: ['Start {lane}: {summary} ({phase})'],
      startUi: ['UI {lane}', '{extra}'],
      startCore: ['Core {lane}: {summary} ({phase}) at {model} · {effort}, unblocks {unblocks}', '{extra}'],
      startSpec: ['Spec {lane}'],
      startDesign: ['Design {lane}'],
      startVerify: ['Verify {lane}'],
      gate: ['Gate {lane} at {model} · {effort}', '{extra}'],
      codexHandoff: ['Codex builds {lane}: {summary}', '{extra}', 'Owns {owns}.'],
      codexAudit: ['Audit {lane} at {auditModel} · {auditEffort}.'],
    },
    log: [],
  };
}

test('the committed roadmap is valid and canonical', () => {
  const { errors } = validate(real);
  assert.deepEqual(errors, []);
  assert.equal(readFileSync(new URL('../roadmap.json', import.meta.url), 'utf8'), canonical(real));
});

test('a planned lane is ready, queued or locked by its dependencies', () => {
  const data = sample();
  const lanes = byId(data);
  assert.equal(displayStatus(lanes.get('feat/core-b'), lanes), 'ready');
  assert.equal(displayStatus(lanes.get('feat/core-c'), lanes), 'queued');
  assert.equal(displayStatus(lanes.get('feat/core-d'), lanes), 'locked');
  assert.equal(displayStatus(lanes.get('feat/core-e'), lanes), 'review');
});

test('graph helpers follow deps both ways', () => {
  const data = sample();
  assert.deepEqual([...downstream(data, 'feat/core-a')].sort(), ['feat/core-b', 'feat/core-c', 'feat/core-d', 'feat/core-e']);
  assert.deepEqual(unlocks(data, 'feat/core-b'), []);
  data.lanes[2].status = 'done';
  assert.deepEqual(unlocks(data, 'feat/core-b'), ['feat/core-d']);
  assert.deepEqual(criticalPath(sample(), 'feat/core-d').path, ['feat/core-c', 'feat/core-d']);
  assert.deepEqual(sharedPaths(data), [{ path: 'crates/x/**', lanes: ['feat/core-d', 'feat/core-e'] }]);
});

test('validation catches broken references, cycles and inconsistent states', () => {
  const broken = (change) => {
    const data = sample();
    change(data);
    return validate(data).errors.join('\n');
  };
  assert.match(broken((d) => d.lanes[1].deps.push('feat/core-zz')), /unknown lane "feat\/core-zz"/);
  assert.match(broken((d) => d.lanes[0].deps.push('feat/core-d')), /cycle|is done but/);
  assert.match(broken((d) => (d.lanes[0].deps = ['feat/core-b'])), /is done but its dependency feat\/core-b is not/);
  assert.match(broken((d) => (d.lanes[1].status = 'started')), /status must be one of/);
  assert.match(broken((d) => (d.lanes[1].colour = 'red')), /unknown field "colour"/);
  assert.match(broken((d) => (d.lanes[1].hold = 'x') && (d.lanes[1].status = 'wip')), /hold only applies/);
  assert.match(broken((d) => (d.lanes[1].id = 'Feature B')), /id must look like/);
  assert.match(broken((d) => d.landingQueue.push({ lane: 'feat/core-e', why: '' })), /appears twice/);
  assert.deepEqual(validate(sample()).errors, []);
});

test('prompts fill the lane fields and drop an empty {extra}', () => {
  const data = sample();
  const lanes = byId(data);
  lanes.get('feat/core-e').prompt = { template: 'land' };
  assert.equal(composePrompt(data, lanes.get('feat/core-e')), 'Land feat/core-e (feat--core-e, feat-core-e).\nDone.');
  lanes.get('feat/core-e').prompt = { template: 'land', extra: ['Extra step.'] };
  assert.match(composePrompt(data, lanes.get('feat/core-e')), /\nExtra step\.\nDone\.$/);
  assert.equal(composePrompt(data, lanes.get('feat/core-b')), 'Core feat/core-b: summary of feat/core-b (Wave 1) at Opus · xhigh, unblocks feat/core-d');
  lanes.get('feat/core-b').prompt = { extra: ['Lane detail.'] };
  assert.match(composePrompt(data, lanes.get('feat/core-b')), /^Core feat\/core-b: .*\nLane detail\.$/);
  assert.equal(composePrompt(data, lanes.get('feat/core-a')), null);
  assert.deepEqual(validate(data).errors, []);
  lanes.get('feat/core-b').prompt = { extra: 'not a list' };
  assert.match(validate(data).errors.join('\n'), /prompt\.extra must be an array of strings/);
  delete data.prompts.startVerify;
  assert.match(validate(data).errors.join('\n'), /prompts\.startVerify must be an array of lines/);
  assert.equal(laneFile('feat/ui-preview'), 'feat--ui-preview');
  assert.equal(taskDir('feat/ui-preview'), 'feat-ui-preview');
});

test('a Codex lane gets a handoff while it is open and a short audit', () => {
  const data = sample();
  const d = byId(data).get('feat/core-d');
  assert.deepEqual(codexPrompts(data, d), {
    handoff: 'Codex builds feat/core-d: summary of feat/core-d\nOwns crates/x/**.',
    audit: 'Audit feat/core-d at Opus · medium.',
  });
  assert.equal(composePrompt(data, d), codexPrompts(data, d).handoff);
  d.prompt = { template: 'codexHandoff', extra: ['Lane detail.'] };
  assert.match(codexPrompts(data, d).handoff, /\nLane detail\.\nOwns/);
  d.status = 'review';
  assert.equal(codexPrompts(data, d).handoff, null);
  assert.equal(composePrompt(data, d), 'Audit feat/core-d at Opus · medium.');
  d.prompt = { template: 'land' };
  assert.equal(codexPrompts(data, d).audit, 'Land feat/core-d (feat--core-d, feat-core-d).\nDone.');
  assert.equal(codexPrompts(data, byId(data).get('feat/core-b')), null);
  assert.equal(auditEffortFor({ size: 'S' }), 'medium');
  assert.equal(auditEffortFor({ size: 'M' }), 'high');
  assert.equal(auditEffortFor({ size: 'L' }), 'xhigh');
  assert.equal(auditEffortFor({ size: 'L', auditEffort: 'high' }), 'high');
  d.prompt = { template: 'nope' };
  assert.match(validate(data).errors.join('\n'), /unknown prompt template "nope"/);
  byId(data).get('feat/core-b').auditEffort = 'low';
  assert.match(validate(data).errors.join('\n'), /auditEffort only applies to Codex lanes/);
});

test('effort defaults by size and track, and a lane can override it', () => {
  const lanes = byId(sample());
  assert.equal(effortFor(lanes.get('feat/core-a')), 'xhigh');
  assert.equal(effortFor(lanes.get('feat/core-c')), 'max');
  assert.equal(effortFor({ id: 'docs/docs-x', size: 'S', track: 'flow' }), 'medium');
  assert.equal(effortFor({ id: 'docs/specs-x', size: 'M', track: 'flow' }), 'xhigh');
  assert.equal(effortFor({ id: 'gate/m1-x', kind: 'gate', size: 'M', track: 'verify' }), 'xhigh');
  assert.equal(effortFor({ id: 'feat/ui-x', size: 'S', track: 'ui' }), 'high');
  assert.equal(effortFor({ id: 'feat/ui-x', size: 'S', track: 'ui', prompt: { template: 'land' } }), 'medium');
  assert.equal(effortFor({ id: 'feat/ui-x', size: 'L', track: 'ui' }), 'xhigh');
  assert.equal(effortFor({ id: 'feat/core-x', size: 'L', track: 'core', effort: 'max' }), 'max');
  const data = sample();
  data.lanes[1].effort = 'extreme';
  assert.match(validate(data).errors.join('\n'), /effort must be one of/);
});

test('Fable takes the hardest-to-undo lanes, Sonnet routine ones, Opus the rest; a lane can override it', () => {
  const ui = (extra) => ({ id: 'feat/ui-x', track: 'ui', size: 'M', ...extra });
  assert.equal(modelFor(ui({})), 'opus');
  assert.equal(modelFor(ui({ size: 'S' })), 'opus');
  assert.equal(modelFor(ui({ size: 'L' })), 'opus');
  assert.equal(modelFor(ui({ effort: 'max' })), 'fable');
  assert.equal(modelFor(ui({ prompt: { template: 'land' } })), 'sonnet');
  assert.equal(modelFor({ id: 'feat/core-x', track: 'core', size: 'S' }), 'opus');
  assert.equal(modelFor({ id: 'feat/core-x', track: 'core', size: 'L' }), 'fable');
  assert.equal(modelFor({ id: 'feat/ipc-x', track: 'core', size: 'M' }), 'fable');
  assert.equal(modelFor({ id: 'gate/m1-x', kind: 'gate', track: 'verify', size: 'S' }), 'fable');
  assert.equal(modelFor({ id: 'docs/specs-x', track: 'flow', size: 'M' }), 'fable');
  assert.equal(modelFor({ id: 'docs/docs-x', track: 'flow', size: 'S' }), 'sonnet');
  assert.equal(modelFor(ui({ model: 'sonnet' })), 'sonnet');
  assert.equal(auditModelFor({ size: 'S' }), 'opus');
  assert.equal(auditModelFor({ size: 'M' }), 'opus');
  assert.equal(auditModelFor({ size: 'L' }), 'fable');
  assert.equal(auditModelFor({ size: 'S', auditModel: 'sonnet' }), 'sonnet');
  const data = sample();
  data.lanes[1].model = 'haiku';
  data.lanes[2].auditModel = 'opus';
  const errors = validate(data).errors.join('\n');
  assert.match(errors, /model must be one of fable, opus, sonnet/);
  assert.match(errors, /auditModel only applies to Codex lanes/);
  delete data.meta.models.sonnet;
  assert.match(validate(data).errors.join('\n'), /meta\.models\.sonnet must name the model/);
});

test('canonical formatting puts lane fields in one order', () => {
  const data = sample();
  data.lanes[1] = { next: 'x', ...data.lanes[1], status: 'wip' };
  const keys = Object.keys(JSON.parse(canonical(data)).lanes[1]);
  assert.ok(keys.indexOf('status') < keys.indexOf('next'));
  assert.equal(keys[0], 'id');
});

test('a planned lane without its own prompt gets the start template for its kind', () => {
  const kind = (extra) => startTemplate({ id: 'feat/x', track: 'flow', agent: 'claude-code', ...extra });
  assert.equal(kind({ id: 'gate/m1-x', kind: 'gate', track: 'verify' }), 'gate');
  assert.equal(kind({ agent: 'cowork', track: 'design' }), 'startDesign');
  assert.equal(kind({ id: 'docs/specs-x' }), 'startSpec');
  assert.equal(kind({ track: 'ui' }), 'startUi');
  assert.equal(kind({ id: 'feat/ipc-x', track: 'core' }), 'startCore');
  assert.equal(kind({ track: 'verify' }), 'startVerify');
  assert.equal(kind({}), 'start');
  const data = sample();
  data.lanes.push({ ...data.lanes[1], id: 'gate/m1-acceptance', kind: 'gate', deps: ['feat/core-e'], prompt: { extra: ['Criterion.'] } });
  assert.equal(composePrompt(data, byId(data).get('gate/m1-acceptance')), 'Gate gate/m1-acceptance at Fable · xhigh\nCriterion.');
});

test('a paused model gives way to Opus at the same effort, also when a lane names it', () => {
  const data = sample();
  data.meta.pausedModels = ['fable'];
  const gate = { id: 'gate/m1-x', kind: 'gate', track: 'verify', size: 'L' };
  assert.equal(modelFor(gate), 'fable');
  assert.equal(modelFor(gate, data), 'opus');
  assert.equal(effortFor(gate), 'max');
  assert.equal(modelFor({ ...gate, model: 'fable' }, data), 'opus');
  assert.equal(modelFor({ id: 'docs/docs-x', track: 'flow', size: 'S' }, data), 'sonnet');
  assert.equal(auditModelFor({ size: 'L' }, data), 'opus');
  assert.equal(auditModelFor({ size: 'S', auditModel: 'fable' }, data), 'opus');
  data.lanes.push({ ...data.lanes[1], id: 'gate/m1-acceptance', kind: 'gate', deps: ['feat/core-e'] });
  assert.equal(composePrompt(data, byId(data).get('gate/m1-acceptance')), 'Gate gate/m1-acceptance at Opus · xhigh');
  assert.deepEqual(validate(data).errors, []);
  data.meta.pausedModels = ['opus'];
  assert.match(validate(data).errors.join('\n'), /meta\.pausedModels: "opus" must be one of fable, sonnet/);
});
