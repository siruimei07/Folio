import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  byId,
  canonical,
  composePrompt,
  criticalPath,
  displayStatus,
  downstream,
  effortFor,
  laneFile,
  sharedPaths,
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
    meta: {},
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
      codexPreamble: ['Codex preamble.'],
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

test('prompts fill the lane fields, drop an empty {extra} and add the Codex preamble', () => {
  const data = sample();
  const lanes = byId(data);
  lanes.get('feat/core-e').prompt = { template: 'land' };
  assert.equal(composePrompt(data, lanes.get('feat/core-e')), 'Land feat/core-e (feat--core-e, feat-core-e).\nDone.');
  lanes.get('feat/core-e').prompt = { template: 'land', extra: ['Extra step.'] };
  assert.match(composePrompt(data, lanes.get('feat/core-e')), /\nExtra step\.\nDone\.$/);
  assert.equal(composePrompt(data, lanes.get('feat/core-b')), 'Start feat/core-b: summary of feat/core-b (Wave 1)');
  assert.match(composePrompt(data, lanes.get('feat/core-d')), /^Codex preamble\.\n\nStart feat\/core-d/);
  assert.equal(composePrompt(data, lanes.get('feat/core-a')), null);
  assert.equal(laneFile('feat/ui-preview'), 'feat--ui-preview');
  assert.equal(taskDir('feat/ui-preview'), 'feat-ui-preview');
});

test('effort defaults by size and track, and a lane can override it', () => {
  const lanes = byId(sample());
  assert.equal(effortFor(lanes.get('feat/core-a')), 'high');
  assert.equal(effortFor(lanes.get('feat/core-c')), 'xhigh');
  assert.equal(effortFor({ id: 'docs/x', size: 'S', track: 'flow' }), 'low');
  assert.equal(effortFor({ id: 'feat/ui-x', size: 'L', track: 'ui' }), 'xhigh');
  assert.equal(effortFor({ id: 'feat/core-x', size: 'L', track: 'core', effort: 'max' }), 'max');
  const data = sample();
  data.lanes[1].effort = 'extreme';
  assert.match(validate(data).errors.join('\n'), /effort must be one of/);
});

test('canonical formatting puts lane fields in one order', () => {
  const data = sample();
  data.lanes[1] = { next: 'x', ...data.lanes[1], status: 'wip' };
  const keys = Object.keys(JSON.parse(canonical(data)).lanes[1]);
  assert.ok(keys.indexOf('status') < keys.indexOf('next'));
  assert.equal(keys[0], 'id');
});
