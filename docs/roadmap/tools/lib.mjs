// Pure roadmap logic shared by the CLI (roadmap.mjs) and the explorer page (index.html).
// No imports and no Node APIs: `build` inlines this file into the page with the `export`
// keywords removed, so the page and the CLI derive statuses, paths and prompts the same way.

export const STATUSES = ['done', 'review', 'wip', 'planned', 'dropped'];

/** What a lane shows as: stored status, or for a planned lane whether its dependencies landed. */
export const DISPLAY = {
  done: { label: '已完成', mark: '✅', order: 6 },
  review: { label: '待评审 / 合并', mark: '🟡', order: 1 },
  wip: { label: '进行中', mark: '🔄', order: 0 },
  ready: { label: '可以开始', mark: '🟢', order: 2 },
  queued: { label: '排队', mark: '⏳', order: 3 },
  locked: { label: '未解锁', mark: '🔒', order: 4 },
  dropped: { label: '已放弃', mark: '⊘', order: 7 },
};

export const GATES = {
  check: 'pnpm check',
  e2e: 'pnpm e2e',
  codeReview: '/code-review',
  securityReview: '/security-review',
  simplify: '/simplify',
  designCritique: '设计评审',
  a11y: '无障碍',
};

export const GATE_STATES = ['pass', 'partial', 'fail', 'todo', 'na'];

export const SIZE_WEIGHT = { S: 1, M: 2, L: 3 };

/** Reasoning effort levels of the recommended model (meta.model), lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The effort to run a lane at: its own `effort`, else by size (S medium, M high, L xhigh),
 * one step up for Rust core work (crash safety, COM, concurrency) and down for docs-only lanes.
 */
export function effortFor(lane) {
  if (lane.effort) return lane.effort;
  let i = { S: 1, M: 2, L: 3 }[lane.size] ?? 2;
  if (lane.track === 'core') i += 1;
  if (lane.track === 'flow' && lane.id.startsWith('docs/')) i -= 1;
  return EFFORTS[Math.max(0, Math.min(3, i))];
}

export const ID_PATTERN = /^(feat|fix|chore|docs|design|spike|refactor|test|perf|gate)\/[a-z0-9][a-z0-9.-]*$/;

/** The lane file name under .agents/lanes/ (CLAUDE.md §7.3). */
export function laneFile(id) {
  return id.replaceAll('/', '--');
}

/** The Codex scratch folder under folio-agent-work/tasks/. */
export function taskDir(id) {
  return id.replaceAll('/', '-');
}

/** A URL-hash-safe token for a lane (letters, digits, `.`, `_`, `~`, `-` only). */
export function anchor(id) {
  return laneFile(id);
}

export function byId(data) {
  return new Map(data.lanes.map((lane) => [lane.id, lane]));
}

export function displayStatus(lane, lanes) {
  if (lane.status !== 'planned') return lane.status;
  const blocked = lane.deps.some((dep) => lanes.get(dep)?.status !== 'done');
  if (blocked) return 'locked';
  return lane.hold ? 'queued' : 'ready';
}

/** id → ids of the lanes that list it in `deps`. */
export function dependents(data) {
  const out = new Map(data.lanes.map((lane) => [lane.id, []]));
  for (const lane of data.lanes) for (const dep of lane.deps) out.get(dep)?.push(lane.id);
  return out;
}

function walk(start, next) {
  const seen = new Set();
  const stack = [...next(start)];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return seen;
}

/** Every lane `id` waits for, transitively. */
export function upstream(data, id) {
  const lanes = byId(data);
  return walk(id, (x) => lanes.get(x)?.deps ?? []);
}

/** Every lane that waits for `id`, transitively. */
export function downstream(data, id) {
  const deps = dependents(data);
  return walk(id, (x) => deps.get(x) ?? []);
}

/** Lanes that become ready once `id` lands: planned dependents whose other deps are done. */
export function unlocks(data, id) {
  const lanes = byId(data);
  return (dependents(data).get(id) ?? []).filter((d) => {
    const lane = lanes.get(d);
    return lane.status === 'planned' && lane.deps.every((x) => x === id || lanes.get(x)?.status === 'done');
  });
}

/** The longest chain of unfinished work (weighted by size) that ends at `target`. */
export function criticalPath(data, target) {
  const lanes = byId(data);
  const memo = new Map();
  const best = (id) => {
    if (memo.has(id)) return memo.get(id);
    const lane = lanes.get(id);
    if (!lane || lane.status === 'done' || lane.status === 'dropped') return { weight: 0, path: [] };
    memo.set(id, { weight: 0, path: [] });
    let top = { weight: 0, path: [] };
    for (const dep of lane.deps) {
      const candidate = best(dep);
      if (candidate.weight > top.weight) top = candidate;
    }
    const result = { weight: top.weight + (SIZE_WEIGHT[lane.size] ?? 1), path: [...top.path, id] };
    memo.set(id, result);
    return result;
  };
  return best(target);
}

/** Lane ids in an order where every lane comes after its deps; null when the deps have a cycle. */
export function topoOrder(data) {
  const lanes = byId(data);
  const state = new Map();
  const order = [];
  let cycle = null;
  const visit = (id, trail) => {
    if (cycle) return;
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'active') {
      cycle = [...trail.slice(trail.indexOf(id)), id];
      return;
    }
    state.set(id, 'active');
    for (const dep of lanes.get(id)?.deps ?? []) if (lanes.has(dep)) visit(dep, [...trail, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const lane of data.lanes) visit(lane.id, []);
  return cycle ? { cycle } : { order };
}

/** The copyable prompt for a lane: its own lines, a template with its fields, or the start template. */
export function composePrompt(data, lane) {
  const phase = data.phases.find((p) => p.id === lane.phase);
  const vars = {
    lane: lane.id,
    laneFile: laneFile(lane.id),
    taskDir: taskDir(lane.id),
    milestone: lane.milestone,
    phase: phase?.label ?? lane.phase,
    summary: lane.summary,
  };
  let lines;
  let extra = [];
  if (Array.isArray(lane.prompt)) lines = lane.prompt;
  else if (lane.prompt) {
    lines = data.prompts[lane.prompt.template] ?? [];
    extra = lane.prompt.extra ?? [];
  } else if (lane.status === 'planned' && lane.kind !== 'gate') lines = data.prompts.start;
  else return null;
  const filled = lines
    .flatMap((line) => (line === '{extra}' ? extra : [line]))
    .map((line) => line.replace(/\{(\w+)\}/g, (all, key) => vars[key] ?? all));
  const codex = lane.agent === 'codex' && lane.status === 'planned';
  return [...(codex ? [...data.prompts.codexPreamble, ''] : []), ...filled].join('\n');
}

/** Counts by display status, overall and per milestone. */
export function tally(data) {
  const lanes = byId(data);
  const total = {};
  const milestones = {};
  for (const lane of data.lanes) {
    const shown = displayStatus(lane, lanes);
    total[shown] = (total[shown] ?? 0) + 1;
    const m = (milestones[lane.milestone] ??= {});
    m[shown] = (m[shown] ?? 0) + 1;
  }
  return { total, milestones };
}

/** Paths that more than one unfinished lane owns or touches, with those lanes. */
export function sharedPaths(data) {
  const map = new Map();
  for (const lane of data.lanes) {
    if (lane.status === 'done' || lane.status === 'dropped') continue;
    for (const path of [...(lane.owns ?? []), ...(lane.shared ?? [])]) {
      const key = path.replace(/#.*$/, '');
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(lane.id);
    }
  }
  return [...map]
    .filter(([, ids]) => ids.size > 1)
    .map(([path, ids]) => ({ path, lanes: [...ids] }))
    .sort((a, b) => b.lanes.length - a.lanes.length || a.path.localeCompare(b.path));
}

const TOP_KEYS = [
  'meta', 'now', 'limits', 'runtime', 'agents', 'tracks', 'milestones', 'phases', 'lanes',
  'landingQueue', 'decisions', 'looseEnds', 'risks', 'rules', 'prompts', 'log',
];
const LANE_KEYS = [
  'id', 'kind', 'title', 'milestone', 'phase', 'track', 'agent', 'reviewer', 'size', 'effort', 'deps',
  'landAfter', 'summary', 'status', 'hold', 'updated', 'landed', 'next', 'gates', 'owns', 'shared',
  'notes', 'links', 'prompt',
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Structural and graph checks. Errors fail `pnpm check`; warnings are printed. */
export function validate(data) {
  const errors = [];
  const warnings = [];
  const err = (msg) => errors.push(msg);
  for (const key of TOP_KEYS) if (!(key in data)) err(`missing top-level "${key}"`);
  for (const key of Object.keys(data)) if (!TOP_KEYS.includes(key)) err(`unknown top-level "${key}"`);
  if (errors.length) return { errors, warnings };

  const ids = (list, what) => {
    const set = new Set();
    for (const item of list) {
      if (set.has(item.id)) err(`duplicate ${what} id "${item.id}"`);
      set.add(item.id);
    }
    return set;
  };
  const agents = ids(data.agents, 'agent');
  const tracks = ids(data.tracks, 'track');
  const milestones = ids(data.milestones, 'milestone');
  const phases = new Map(data.phases.map((p) => [p.id, p]));
  ids(data.phases, 'phase');
  const laneIds = ids(data.lanes, 'lane');
  for (const m of data.milestones)
    if (!['done', 'active', 'locked'].includes(m.state)) err(`milestone ${m.id}: state "${m.state}"`);
  for (const p of data.phases) {
    if (!milestones.has(p.milestone)) err(`phase ${p.id}: unknown milestone "${p.milestone}"`);
    if (!['wave', 'sync', 'gate'].includes(p.kind)) err(`phase ${p.id}: kind "${p.kind}"`);
  }

  for (const lane of data.lanes) {
    const at = `lane ${lane.id}`;
    for (const key of Object.keys(lane)) if (!LANE_KEYS.includes(key)) err(`${at}: unknown field "${key}"`);
    for (const key of ['id', 'title', 'milestone', 'phase', 'track', 'agent', 'size', 'summary', 'status', 'updated'])
      if (typeof lane[key] !== 'string' || !lane[key]) err(`${at}: "${key}" must be a non-empty string`);
    if (!ID_PATTERN.test(lane.id ?? '')) err(`${at}: id must look like <type>/<area>-<desc>`);
    const isGate = lane.kind === 'gate';
    if (lane.kind !== undefined && !isGate) err(`${at}: kind must be "gate" or absent`);
    if (isGate !== (lane.id ?? '').startsWith('gate/')) err(`${at}: gate ids start with gate/ and have kind "gate"`);
    if (!milestones.has(lane.milestone)) err(`${at}: unknown milestone "${lane.milestone}"`);
    const phase = phases.get(lane.phase);
    if (!phase) err(`${at}: unknown phase "${lane.phase}"`);
    else if (phase.milestone !== lane.milestone) err(`${at}: phase ${lane.phase} belongs to ${phase.milestone}`);
    if (!tracks.has(lane.track)) err(`${at}: unknown track "${lane.track}"`);
    if (!agents.has(lane.agent)) err(`${at}: unknown agent "${lane.agent}"`);
    if (lane.reviewer !== undefined && !agents.has(lane.reviewer)) err(`${at}: unknown reviewer "${lane.reviewer}"`);
    if (!(lane.size in SIZE_WEIGHT)) err(`${at}: size must be S, M or L`);
    if (lane.effort !== undefined && !EFFORTS.includes(lane.effort)) err(`${at}: effort must be one of ${EFFORTS.join(', ')}`);
    if (!STATUSES.includes(lane.status)) err(`${at}: status must be one of ${STATUSES.join(', ')}`);
    if (!DATE.test(lane.updated ?? '')) err(`${at}: updated must be YYYY-MM-DD`);
    if (lane.landed !== undefined && !DATE.test(lane.landed)) err(`${at}: landed must be YYYY-MM-DD`);
    if (lane.hold !== undefined && lane.status !== 'planned') err(`${at}: hold only applies to planned lanes`);
    for (const key of ['deps', 'landAfter']) {
      if (key === 'deps' && !Array.isArray(lane.deps)) {
        err(`${at}: deps must be an array`);
        continue;
      }
      for (const dep of lane[key] ?? []) {
        if (dep === lane.id) err(`${at}: ${key} lists itself`);
        else if (!laneIds.has(dep)) err(`${at}: ${key} names unknown lane "${dep}"`);
      }
    }
    for (const key of ['owns', 'shared', 'notes', 'links'])
      if (lane[key] !== undefined && (!Array.isArray(lane[key]) || lane[key].some((x) => typeof x !== 'string')))
        err(`${at}: ${key} must be an array of strings`);
    if (lane.gates !== undefined) {
      for (const [key, value] of Object.entries(lane.gates)) {
        if (!(key in GATES)) err(`${at}: unknown gate "${key}"`);
        if (!GATE_STATES.includes(value)) err(`${at}: gate ${key} must be one of ${GATE_STATES.join(', ')}`);
      }
    }
    if (Array.isArray(lane.prompt)) {
      if (lane.prompt.some((x) => typeof x !== 'string')) err(`${at}: prompt lines must be strings`);
    } else if (lane.prompt !== undefined) {
      if (!data.prompts[lane.prompt.template]) err(`${at}: unknown prompt template "${lane.prompt.template}"`);
      for (const key of Object.keys(lane.prompt))
        if (!['template', 'extra'].includes(key)) err(`${at}: unknown prompt field "${key}"`);
    }
    if (['review', 'wip'].includes(lane.status) && !lane.next) warnings.push(`${at}: an active lane should say what is next`);
  }

  const lanes = byId(data);
  const topo = topoOrder(data);
  if (topo.cycle) err(`dependency cycle: ${topo.cycle.join(' → ')}`);
  for (const lane of data.lanes) {
    if (lane.status !== 'done') continue;
    for (const dep of lane.deps)
      if (lanes.get(dep) && lanes.get(dep).status !== 'done') err(`lane ${lane.id} is done but its dependency ${dep} is not`);
  }

  const queued = new Set();
  for (const entry of data.landingQueue) {
    const lane = lanes.get(entry.lane);
    if (!lane) err(`landing queue: unknown lane "${entry.lane}"`);
    else if (lane.status === 'done') warnings.push(`landing queue: ${entry.lane} has landed; remove it from the queue`);
    if (queued.has(entry.lane)) err(`landing queue: ${entry.lane} appears twice`);
    queued.add(entry.lane);
  }
  for (const lane of data.lanes)
    if (lane.status === 'review' && !queued.has(lane.id)) warnings.push(`lane ${lane.id} is in review but not in the landing queue`);

  const decisionIds = new Set();
  for (const d of data.decisions) {
    if (decisionIds.has(d.id)) err(`duplicate decision id "${d.id}"`);
    decisionIds.add(d.id);
    if (!['open', 'recurring', 'locked', 'done'].includes(d.state)) err(`decision ${d.id}: state "${d.state}"`);
    if (!['approve', 'decide', 'manual'].includes(d.type)) err(`decision ${d.id}: type "${d.type}"`);
  }
  for (const item of data.looseEnds) {
    if (!['open', 'done'].includes(item.state)) err(`loose end "${item.item}": state "${item.state}"`);
    if (!laneIds.has(item.lane)) err(`loose end "${item.item}": unknown lane "${item.lane}"`);
  }
  for (const r of data.risks) if (!['high', 'med', 'low'].includes(r.level)) err(`risk "${r.risk}": level "${r.level}"`);
  for (const name of ['land', 'start', 'codexPreamble'])
    if (!Array.isArray(data.prompts[name])) err(`prompts.${name} must be an array of lines`);
  return { errors, warnings };
}

/**
 * The one formatting the CLI writes, so hand edits and CLI edits diff the same way. Lane fields
 * follow LANE_KEYS: the fields a status change touches (status … next) sit in the middle of each
 * lane, away from its neighbours, so two lanes' updates stay separate GitButler hunks.
 */
export function canonical(data) {
  const lanes = data.lanes?.map((lane) => {
    const known = LANE_KEYS.filter((key) => lane[key] !== undefined).map((key) => [key, lane[key]]);
    const unknown = Object.entries(lane).filter(([key]) => !LANE_KEYS.includes(key));
    return Object.fromEntries([...known, ...unknown]);
  });
  return `${JSON.stringify(lanes ? { ...data, lanes } : data, null, 2)}\n`;
}

/** Today's date in the machine's time zone, as YYYY-MM-DD. */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
