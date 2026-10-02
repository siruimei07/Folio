// The palette's two groups (app-shell handoff §8; ipc-m1 §10): "File names" holds the hits whose
// name has a matched span, "Contents" the rest, each in rank order.
import type { SearchHit } from '../ipc';

export interface HitGroups {
  names: SearchHit[];
  contents: SearchHit[];
}

export function groupHits(hits: readonly SearchHit[]): HitGroups {
  const groups: HitGroups = { names: [], contents: [] };
  for (const hit of hits) {
    (hit.name.some((span) => span.matched) ? groups.names : groups.contents).push(hit);
  }
  return groups;
}
