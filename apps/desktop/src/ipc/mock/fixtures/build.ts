// Helpers for writing fixtures: entries by path, times in days before `now`.
import { parentOf } from '../../../lib/paths';
import type { PresetTagNames } from '../../bindings';
import type { BlockedBy, GroupSettings, SeedEntry, SeedTag } from './types';

const DAY = 86_400_000;

export interface FileOptions {
  /** Bytes. */
  size?: number;
  /** Days before now; `null`: no modification time (a hint the file system did not give). */
  modified?: number | null;
  /** Days before now. */
  added?: number;
  tags?: string[];
  text?: string;
  blocked?: BlockedBy;
}

export interface FolderOptions {
  tags?: string[];
  group?: Partial<GroupSettings>;
  added?: number;
}

/** Settings of a semester or course: nothing set but `settings`. */
export function groupSettings(settings: Partial<GroupSettings> = {}): GroupSettings {
  return { order: null, archived: false, abbr: null, code: null, color: null, ...settings };
}

/** Collects entries by path; missing parent folders are added first. */
export class SeedBuilder {
  private readonly entries = new Map<string, SeedEntry>();
  private readonly now: number;

  constructor(now: number) {
    this.now = now;
  }

  private time(daysAgo: number): string {
    return String(Math.round(this.now - daysAgo * DAY));
  }

  /** Adds the folder `path` is in, and its own folders first, unless it is there. */
  private parents(path: string): void {
    const parent = parentOf(path);
    if (parent !== '' && !this.entries.has(parent)) this.folder(parent);
  }

  folder(path: string, options: FolderOptions = {}): this {
    this.parents(path);
    const existing = this.entries.get(path);
    const group =
      options.group === undefined
        ? (existing?.group ?? null)
        : groupSettings({ ...existing?.group, ...options.group });
    this.entries.set(path, {
      path,
      kind: 'folder',
      size: '0',
      modifiedMs: this.time(options.added ?? 120),
      addedMs: this.time(options.added ?? 120),
      tags: options.tags ?? existing?.tags ?? [],
      group,
      text: null,
      blocked: null,
    });
    return this;
  }

  file(path: string, options: FileOptions = {}): this {
    this.parents(path);
    const added = options.added ?? 30;
    const modified = options.modified === undefined ? added : options.modified;
    this.entries.set(path, {
      path,
      kind: 'file',
      size: String(Math.round(options.size ?? 24_576)),
      modifiedMs: modified === null ? null : this.time(modified),
      addedMs: this.time(added),
      tags: options.tags ?? [],
      group: null,
      text: options.text ?? null,
      blocked: options.blocked ?? null,
    });
    return this;
  }

  /** Entries so far, folders added for their children included. */
  get size(): number {
    return this.entries.size;
  }

  build(): SeedEntry[] {
    return [...this.entries.values()];
  }
}

export const DEFAULT_PRESET_NAMES: PresetTagNames = {
  notes: 'Notes',
  slides: 'Slides',
  homework: 'Homework',
  exam: 'Exams',
  reference: 'Reference',
};

/** The tags every new library starts with, as the core defines them (`meta::PresetTag`). */
export function presetTags(names: PresetTagNames = DEFAULT_PRESET_NAMES): SeedTag[] {
  return [
    { id: 'notes', name: names.notes, color: 'blue' },
    { id: 'slides', name: names.slides, color: 'green' },
    { id: 'homework', name: names.homework, color: 'orange' },
    { id: 'exam', name: names.exam, color: 'red' },
    { id: 'reference', name: names.reference, color: 'stone' },
  ];
}

/** Tags of the student's own, shared by the fixtures. */
export const IMPORTANT: SeedTag = { id: '3f9a1c2b5e6d7a8b', name: '重要', color: 'pink' };
export const TO_REVIEW: SeedTag = { id: 'a41c09e2b7d35f60', name: 'To review', color: 'amber' };

/** A deterministic random number generator (mulberry32), for generated fixtures. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
