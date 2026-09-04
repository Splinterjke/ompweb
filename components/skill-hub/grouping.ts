/**
 * Grouping and sorting helpers for the Skill Hub panel.
 */

import type { CatalogSkill, CollectionGroup, SkillTag } from '@/lib/skill-hub/protocol';
import { isProjectSource } from '@/lib/skill-hub/protocol';

export { isProjectSource };

export type GroupSwitchState = 'on' | 'off' | 'mixed';

export interface GroupSwitchView {
  state: GroupSwitchState;
  enabled: string[];
  disabled: string[];
}

export function groupSwitchView(members: readonly string[], enabledNames: ReadonlySet<string>): GroupSwitchView {
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const name of members) {
    if (enabledNames.has(name)) enabled.push(name);
    else disabled.push(name);
  }
  const state: GroupSwitchState = disabled.length === 0 ? 'on' : enabled.length === 0 ? 'off' : 'mixed';
  return { state, enabled, disabled };
}

export function groupNamesOf(name: string, tags: readonly SkillTag[], collections: readonly CollectionGroup[]): string[] {
  const names: string[] = [];
  for (const tag of tags) if (tag.skillNames.includes(name)) names.push(tag.name);
  for (const collection of collections) if (collection.skillNames.includes(name)) names.push(collection.name);
  return names;
}

export function conflictsOnClose(
  members: readonly string[],
  enabledNames: ReadonlySet<string>,
  otherGroups: ReadonlyArray<{ members: readonly string[] }>,
): string[] {
  return members.filter((name) => {
    if (!enabledNames.has(name)) return false;
    return otherGroups.some((group) => group.members.includes(name));
  });
}

export const PRIVATE_SOURCE = 'private';

export function filterBySource(
  skills: readonly CatalogSkill[],
  source: string,
  origins: Readonly<Record<string, string>>
): CatalogSkill[] {
  if (source === 'all') return [...skills];
  return skills.filter((skill) => {
    if (isProjectSource(skill.source)) return false;
    const origin = origins[skill.name];
    if (origin !== undefined) return origin === source;
    return skill.source === source || source === PRIVATE_SOURCE;
  });
}

export type SortKey = 'name' | 'added' | 'uses';

export function sortSkills(
  skills: readonly CatalogSkill[],
  key: SortKey,
  getUses?: (name: string) => number | undefined
): CatalogSkill[] {
  const list = [...skills];
  if (key === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else if (key === 'added') {
    list.sort((a, b) => (b.addedAt ?? -Infinity) - (a.addedAt ?? -Infinity));
  } else if (key === 'uses') {
    list.sort((a, b) => (getUses?.(b.name) ?? 0) - (getUses?.(a.name) ?? 0));
  }
  return list;
}

export interface RelativeTime {
  key: 'time.justNow' | 'time.minutesAgo' | 'time.hoursAgo' | 'time.daysAgo' | 'time.weeksAgo';
  value?: number;
}

export function formatRelativeTime(ms: number, now = Date.now()): RelativeTime {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return { key: 'time.justNow' };
  if (minutes < 60) return { key: 'time.minutesAgo', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: 'time.hoursAgo', value: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { key: 'time.daysAgo', value: days };
  return { key: 'time.weeksAgo', value: Math.floor(days / 7) };
}
