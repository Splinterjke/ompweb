/**
 * Hub sidecar store: remembers which skills the hub toggled off and the
 * user's organization/tracking records.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@/lib/omp/paths';
import {
  DEFAULT_SCENE_NAME,
  type DisabledSkill,
  type HubConfig,
  type MarketSourceRecord,
  resolveHubConfig,
  type SkillStatsCheckpoint,
  type SkillTag,
  type SourceRecord,
  type TrashEntry,
} from './protocol';

/** Wire shape persisted on disk. */
interface StoreFile {
  version: number;
  disabled: DisabledSkill[];
  config?: Partial<HubConfig>;
  tags?: SkillTag[];
  sources?: SourceRecord[];
  marketSources?: MarketSourceRecord[];
  trash?: TrashEntry[];
  skillStats?: SkillStatsCheckpoint;
  collectionOrder?: string[];
  sourceGroupOrder?: string[];
}

export function defaultSkillHubStatePath(): string {
  try {
    const ompPath = join(getAgentDir(), 'skill-hub.json');
    if (existsSync(ompPath)) return ompPath;
    const dshPath = join(homedir(), '.dsh', 'dsh-skill-hub.json');
    if (existsSync(dshPath)) return dshPath;
    return ompPath;
  } catch {
    return join(homedir(), '.agents', 'skill-hub.json');
  }
}

export const STORE_VERSION = 4;

export class StoreError extends Error {
  readonly kind: 'validation' | 'not-found' | 'conflict';
  constructor(kind: StoreError['kind'], message: string) {
    super(message);
    this.name = 'StoreError';
    this.kind = kind;
  }
}

function migrateStore(parsed: unknown): {
  version: number;
  disabled: unknown;
  config?: unknown;
  tags?: unknown;
  sources?: unknown;
  marketSources?: unknown;
  trash?: unknown;
  skillStats?: unknown;
  collectionOrder?: unknown;
  sourceGroupOrder?: unknown;
} | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const version = typeof record.version === 'number' ? record.version : 0;
  if (version > STORE_VERSION) return null;
  const disabled = Array.isArray(record.disabled) ? record.disabled : [];
  const config = typeof record.config === 'object' && record.config !== null && !Array.isArray(record.config) ? record.config : undefined;
  const tags = Array.isArray(record.tags) ? record.tags : undefined;
  const trash = Array.isArray(record.trash) ? record.trash : undefined;
  const marketSources = Array.isArray(record.marketSources)
    ? record.marketSources.map((entry) => (typeof entry === 'string' ? { repo: entry } : entry))
    : undefined;

  let sources: unknown;
  if (Array.isArray(record.sources)) {
    sources = record.sources;
  } else if (version < 2 && typeof record.origins === 'object' && record.origins !== null && !Array.isArray(record.origins)) {
    const byOrigin = new Map<string, string[]>();
    for (const [name, origin] of Object.entries(record.origins as Record<string, unknown>)) {
      if (typeof origin !== 'string' || origin === '') continue;
      const list = byOrigin.get(origin);
      if (list === undefined) byOrigin.set(origin, [name]);
      else list.push(name);
    }
    sources = [...byOrigin.entries()].map(([repo, skillNames]) => ({
      repo,
      root: 'skills',
      commitSha: '',
      skills: skillNames.sort((a, b) => a.localeCompare(b)),
    }));
  }

  return {
    version: STORE_VERSION,
    disabled,
    ...(config !== undefined ? { config } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(marketSources !== undefined ? { marketSources } : {}),
    ...(trash !== undefined ? { trash } : {}),
    ...(record.skillStats !== undefined ? { skillStats: record.skillStats } : {}),
    ...(Array.isArray(record.collectionOrder) ? { collectionOrder: record.collectionOrder } : {}),
    ...(Array.isArray(record.sourceGroupOrder) ? { sourceGroupOrder: record.sourceGroupOrder } : {}),
  };
}

export class SkillHubStore {
  private entries = new Map<string, DisabledSkill>();
  private config: Partial<HubConfig> = {};
  private tagsById = new Map<string, SkillTag>();
  private sourcesByRepo = new Map<string, SourceRecord>();
  private marketSources: MarketSourceRecord[] = [];
  private trashByName = new Map<string, TrashEntry>();
  private skillStats: SkillStatsCheckpoint | undefined = undefined;
  private collectionOrder: string[] = [];
  private sourceGroupOrder: string[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string = defaultSkillHubStatePath()) {}

  public async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const migrated = migrateStore(parsed);
      if (migrated === null) {
        console.warn('[skill-hub] state uses a newer schema; starting empty');
      } else {
        if (Array.isArray(migrated.disabled)) {
          for (const entry of migrated.disabled) {
            if (typeof entry?.name === 'string' && typeof entry?.path === 'string') {
              this.entries.set(entry.name, entry);
            }
          }
        }
        const saved = migrated.config as Partial<HubConfig> | undefined;
        if (typeof saved === 'object' && saved !== null) {
          if (typeof saved.enabled === 'boolean') this.config.enabled = saved.enabled;
          if (typeof saved.announceToAgent === 'boolean') this.config.announceToAgent = saved.announceToAgent;
          if (typeof saved.dotModelColor === 'string' && saved.dotModelColor !== '') this.config.dotModelColor = saved.dotModelColor;
          if (typeof saved.dotUserColor === 'string' && saved.dotUserColor !== '') this.config.dotUserColor = saved.dotUserColor;
          if (typeof saved.showUseCount === 'boolean') this.config.showUseCount = saved.showUseCount;
          if (typeof saved.showUseTime === 'boolean') this.config.showUseTime = saved.showUseTime;
          if (typeof saved.showGroupSummary === 'boolean') this.config.showGroupSummary = saved.showGroupSummary;
        }
        if (Array.isArray(migrated.tags)) {
          for (const entry of migrated.tags as unknown[]) {
            const tag = entry as { id?: unknown; name?: unknown; skillNames?: unknown; default?: unknown } | null;
            if (tag !== null && typeof tag === 'object' && typeof tag.id === 'string' && typeof tag.name === 'string' && Array.isArray(tag.skillNames)) {
              this.tagsById.set(tag.id, {
                id: tag.id,
                name: tag.name,
                skillNames: tag.skillNames.filter((n): n is string => typeof n === 'string'),
                ...(tag.default === true ? { default: true } : {}),
              });
            }
          }
        }
        if (Array.isArray(migrated.sources)) {
          for (const entry of migrated.sources as unknown[]) {
            const source = entry as { repo?: unknown; ref?: unknown; root?: unknown; commitSha?: unknown; skills?: unknown; manifest?: unknown } | null;
            if (source !== null && typeof source === 'object' && typeof source.repo === 'string' && source.repo !== '' && Array.isArray(source.skills)) {
              const manifest = source.manifest as Record<string, unknown> | undefined;
              const rawRoot = typeof source.root === 'string' && source.root !== '' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.root) ? source.root : 'skills';
              this.sourcesByRepo.set(source.repo, {
                repo: source.repo,
                ...(typeof source.ref === 'string' && source.ref !== '' ? { ref: source.ref } : {}),
                root: rawRoot,
                commitSha: typeof source.commitSha === 'string' ? source.commitSha : '',
                skills: source.skills.filter((n): n is string => typeof n === 'string'),
                ...(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
                  ? { manifest: Object.fromEntries(Object.entries(manifest).filter(([, size]) => typeof size === 'number')) as Record<string, number> }
                  : {}),
              });
            }
          }
        }
        if (Array.isArray(migrated.marketSources)) {
          for (const entry of migrated.marketSources as unknown[]) {
            const item = entry as { repo?: unknown; ref?: unknown; commitSha?: unknown } | null;
            if (item !== null && typeof item === 'object' && typeof item.repo === 'string' && item.repo !== '' && !this.marketSources.some((s) => s.repo === item.repo)) {
              this.marketSources.push({
                repo: item.repo,
                ...(typeof item.ref === 'string' && item.ref !== '' ? { ref: item.ref } : {}),
                ...(typeof item.commitSha === 'string' && item.commitSha !== '' ? { commitSha: item.commitSha } : {}),
              });
            }
          }
        }
        if (Array.isArray(migrated.trash)) {
          for (const entry of migrated.trash as unknown[]) {
            const item = entry as { name?: unknown; path?: unknown; movedAt?: unknown; sourcePath?: unknown } | null;
            if (item !== null && typeof item === 'object' && typeof item.name === 'string' && typeof item.path === 'string') {
              const origin = (item as Record<string, unknown>).origin as { repo?: unknown; root?: unknown; ref?: unknown; commitSha?: unknown } | undefined;
              const tagIds = (item as Record<string, unknown>).tagIds;
              this.trashByName.set(item.name, {
                name: item.name,
                path: item.path,
                movedAt: typeof item.movedAt === 'number' ? item.movedAt : 0,
                ...(typeof item.sourcePath === 'string' && item.sourcePath !== '' ? { sourcePath: item.sourcePath } : {}),
                ...(origin !== null && typeof origin === 'object' && typeof origin.repo === 'string' && origin.repo !== '' && typeof origin.root === 'string' && origin.root !== '' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(origin.root)
                  ? {
                      origin: {
                        repo: origin.repo,
                        root: origin.root,
                        ...(typeof origin.ref === 'string' && origin.ref !== '' ? { ref: origin.ref } : {}),
                        commitSha: typeof origin.commitSha === 'string' ? origin.commitSha : '',
                      },
                    }
                  : {}),
                ...(Array.isArray(tagIds) ? { tagIds: tagIds.filter((id): id is string => typeof id === 'string') } : {}),
              });
            }
          }
        }
        const savedStats = migrated.skillStats as Partial<SkillStatsCheckpoint> | null | undefined;
        if (savedStats !== null && typeof savedStats === 'object'
          && typeof savedStats.frozenBefore === 'number' && typeof savedStats.lastFullReconcile === 'number'
          && typeof savedStats.windowDays === 'number'
          && typeof savedStats.frozenSessions === 'object' && savedStats.frozenSessions !== null) {
          const sessions: SkillStatsCheckpoint['frozenSessions'] = {};
          for (const [id, entry] of Object.entries(savedStats.frozenSessions)) {
            if (entry === null || typeof entry !== 'object' || typeof entry.createdAt !== 'number'
              || typeof entry.counts !== 'object' || entry.counts === null) continue;
            const counts: Record<string, { count: number; lastUsed: number }> = {};
            for (const [name, stat] of Object.entries(entry.counts)) {
              if (stat !== null && typeof stat === 'object'
                && typeof (stat as { count?: unknown }).count === 'number'
                && typeof (stat as { lastUsed?: unknown }).lastUsed === 'number') {
                counts[name] = { count: (stat as { count: number }).count, lastUsed: (stat as { lastUsed: number }).lastUsed };
              }
            }
            sessions[id] = { createdAt: entry.createdAt, counts };
          }
          this.skillStats = {
            windowDays: savedStats.windowDays,
            frozenBefore: savedStats.frozenBefore,
            frozenSessions: sessions,
            lastFullReconcile: savedStats.lastFullReconcile,
          };
        }
        const rawColOrder = (migrated as Record<string, unknown>).collectionOrder as unknown;
        if (Array.isArray(rawColOrder)) {
          this.collectionOrder = rawColOrder.filter((n): n is string => typeof n === 'string' && n !== '');
        }
        const rawSrcOrder = (migrated as Record<string, unknown>).sourceGroupOrder as unknown;
        if (Array.isArray(rawSrcOrder)) {
          this.sourceGroupOrder = rawSrcOrder.filter((n): n is string => typeof n === 'string' && n !== '');
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn('[skill-hub] sidecar state unreadable, starting empty:', error instanceof Error ? error.message : error);
      }
    }
    await this.ensureDefaultTag();
  }

  private async ensureDefaultTag(): Promise<void> {
    if ([...this.tagsById.values()].some((tag) => tag.default === true)) return;
    const tag: SkillTag = { id: crypto.randomUUID(), name: DEFAULT_SCENE_NAME, skillNames: [], default: true };
    this.tagsById.set(tag.id, tag);
    await this.persist();
  }

  async listDisabled(): Promise<DisabledSkill[]> {
    await this.ensureLoaded();
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getDisabled(name: string): Promise<DisabledSkill | undefined> {
    await this.ensureLoaded();
    return this.entries.get(name);
  }

  async addDisabled(entry: DisabledSkill): Promise<void> {
    await this.ensureLoaded();
    this.entries.set(entry.name, entry);
    await this.persist();
  }

  async removeDisabled(name: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.entries.delete(name)) return;
    await this.persist();
  }

  async getConfig(): Promise<Partial<HubConfig>> {
    await this.ensureLoaded();
    return { ...this.config };
  }

  async setConfig(config: Partial<HubConfig>): Promise<void> {
    await this.ensureLoaded();
    const next: Partial<HubConfig> = { ...this.config };
    for (const [key, value] of Object.entries(config) as Array<[keyof HubConfig, boolean | string | undefined]>) {
      if (value === undefined) delete next[key];
      else (next as unknown as Record<string, unknown>)[key] = value;
    }
    this.config = next;
    await this.persist();
  }

  async listTags(): Promise<SkillTag[]> {
    await this.ensureLoaded();
    return [...this.tagsById.values()];
  }

  async getTag(id: string): Promise<SkillTag | undefined> {
    await this.ensureLoaded();
    return this.tagsById.get(id);
  }

  async saveTag(input: { id?: string; name: string; color?: string; icon?: string }): Promise<SkillTag> {
    await this.ensureLoaded();
    const name = input.name.trim();
    if (name === '') throw new StoreError('validation', 'tag name must not be empty');
    let tag: SkillTag;
    if (input.id !== undefined) {
      const existing = this.tagsById.get(input.id);
      if (existing === undefined) throw new StoreError('not-found', 'tag not found: ' + input.id);
      tag = {
        ...existing,
        name,
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
      };
    } else {
      tag = {
        id: crypto.randomUUID(),
        name,
        skillNames: [],
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
      };
    }
    this.tagsById.set(tag.id, tag);
    await this.persist();
    return tag;
  }

  async setTagSkills(id: string, skillNames: readonly string[]): Promise<SkillTag | undefined> {
    return this.setTagMembers(id, skillNames);
  }

  async setCollectionOrder(orderedNames: string[]): Promise<string[]> {
    return this.reorderCollections(orderedNames);
  }

  async setSourceGroupOrder(orderedNames: string[]): Promise<string[]> {
    return this.reorderSourceGroups(orderedNames);
  }

  async updateConfig(patch: Partial<HubConfig>): Promise<HubConfig> {
    await this.ensureLoaded();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (this.config as Record<string, unknown>)[key];
      else (this.config as Record<string, unknown>)[key] = value;
    }
    await this.persist();
    return resolveHubConfig({}, this.config);
  }

  async setDisabled(
    name: string,
    disabled: boolean,
    path?: string,
    root?: import('./protocol').WritableRoot,
    description?: string
  ): Promise<void> {
    await this.ensureLoaded();
    if (disabled) {
      if (!path) throw new StoreError('validation', 'path is required when disabling');
      await this.addDisabled({
        name,
        path,
        root: root ?? 'user-agents',
        description: description ?? '',
        disabledAt: Date.now(),
      });
    } else {
      await this.removeDisabled(name);
    }
  }

  async deleteTag(id: string): Promise<void> {
    await this.ensureLoaded();
    const tag = this.tagsById.get(id);
    if (tag?.default === true) throw new StoreError('conflict', 'the default scene cannot be deleted');
    if (!this.tagsById.delete(id)) return;
    await this.persist();
  }

  async getDefaultTag(): Promise<SkillTag | undefined> {
    await this.ensureLoaded();
    return [...this.tagsById.values()].find((tag) => tag.default === true);
  }

  async addSkillToTag(id: string, name: string): Promise<SkillTag | undefined> {
    await this.ensureLoaded();
    const existing = this.tagsById.get(id);
    if (existing === undefined || name.trim() === '' || existing.skillNames.includes(name)) return existing;
    const tag: SkillTag = { ...existing, skillNames: [...existing.skillNames, name] };
    this.tagsById.set(id, tag);
    await this.persist();
    return tag;
  }

  async setTagMembers(id: string, skillNames: readonly string[]): Promise<SkillTag | undefined> {
    await this.ensureLoaded();
    const existing = this.tagsById.get(id);
    if (existing === undefined) return undefined;
    const names = [...new Set(skillNames.filter((n) => n.trim() !== ''))];
    const tag: SkillTag = { ...existing, skillNames: names };
    this.tagsById.set(id, tag);
    await this.persist();
    return tag;
  }

  async removeSkillFromTags(name: string): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const tag of this.tagsById.values()) {
      if (!tag.skillNames.includes(name)) continue;
      tag.skillNames = tag.skillNames.filter((n) => n !== name);
      changed = true;
    }
    if (changed) await this.persist();
  }

  async reorderTags(orderedIds: string[]): Promise<SkillTag[]> {
    await this.ensureLoaded();
    const currentIds = [...this.tagsById.keys()];
    if (orderedIds.length !== currentIds.length) throw new StoreError('validation', 'orderedIds length mismatch');
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (typeof id !== 'string' || id === '') throw new StoreError('validation', 'invalid tag id');
      if (seen.has(id)) throw new StoreError('validation', 'duplicate tag id: ' + id);
      if (!this.tagsById.has(id)) throw new StoreError('not-found', 'tag not found: ' + id);
      seen.add(id);
    }
    const newMap = new Map<string, SkillTag>();
    for (const id of orderedIds) newMap.set(id, this.tagsById.get(id)!);
    this.tagsById = newMap;
    await this.persist();
    return [...this.tagsById.values()];
  }

  async getCollectionOrder(): Promise<string[]> {
    await this.ensureLoaded();
    return [...this.collectionOrder];
  }

  async reorderCollections(orderedNames: string[]): Promise<string[]> {
    await this.ensureLoaded();
    const uniq = [...new Set(orderedNames.filter((n): n is string => typeof n === 'string' && n !== ''))];
    this.collectionOrder = uniq;
    await this.persist();
    return [...this.collectionOrder];
  }

  async getSourceGroupOrder(): Promise<string[]> {
    await this.ensureLoaded();
    return [...this.sourceGroupOrder];
  }

  async reorderSourceGroups(orderedKeys: string[]): Promise<string[]> {
    await this.ensureLoaded();
    const uniq = [...new Set(orderedKeys.filter((k): k is string => typeof k === 'string' && k !== ''))];
    this.sourceGroupOrder = uniq;
    await this.persist();
    return [...this.sourceGroupOrder];
  }

  async listSources(): Promise<SourceRecord[]> {
    await this.ensureLoaded();
    return [...this.sourcesByRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  }

  async getSource(repo: string): Promise<SourceRecord | undefined> {
    await this.ensureLoaded();
    return this.sourcesByRepo.get(repo);
  }

  async getSourceForSkill(name: string): Promise<SourceRecord | undefined> {
    await this.ensureLoaded();
    for (const source of this.sourcesByRepo.values()) {
      if (source.skills.includes(name)) return source;
    }
    return undefined;
  }

  async deleteSource(repo: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.sourcesByRepo.delete(repo)) return;
    await this.persist();
  }

  async addSourceSkill(repo: string, root: string, commitSha: string, ref: string | undefined, skillName: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.sourcesByRepo.get(repo);
    if (existing === undefined) {
      this.sourcesByRepo.set(repo, {
        repo,
        ...(ref !== undefined && ref !== '' ? { ref } : {}),
        root,
        commitSha,
        skills: [skillName],
      });
    } else {
      const skills = existing.skills.includes(skillName) ? existing.skills : [...existing.skills, skillName].sort((a, b) => a.localeCompare(b));
      this.sourcesByRepo.set(repo, { ...existing, skills });
    }
    await this.persist();
  }

  async setSourceSkills(repo: string, skills: readonly string[]): Promise<SourceRecord | undefined> {
    await this.ensureLoaded();
    const existing = this.sourcesByRepo.get(repo);
    if (existing === undefined) return undefined;
    const names = [...new Set(skills.filter((n) => n.trim() !== ''))].sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      this.sourcesByRepo.delete(repo);
    } else {
      this.sourcesByRepo.set(repo, { ...existing, skills: names });
    }
    await this.persist();
    return this.sourcesByRepo.get(repo);
  }

  async removeSkillFromSources(name: string): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const [repo, source] of this.sourcesByRepo) {
      if (!source.skills.includes(name)) continue;
      const skills = source.skills.filter((n) => n !== name);
      if (skills.length === 0) this.sourcesByRepo.delete(repo);
      else this.sourcesByRepo.set(repo, { ...source, skills });
      changed = true;
    }
    if (changed) await this.persist();
  }

  async setSourceCommit(repo: string, commitSha: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.sourcesByRepo.get(repo);
    if (existing === undefined) return;
    this.sourcesByRepo.set(repo, { ...existing, commitSha });
    await this.persist();
  }

  async setSourceRef(repo: string, ref: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.sourcesByRepo.get(repo);
    if (existing === undefined || ref.trim() === '') return;
    this.sourcesByRepo.set(repo, { ...existing, ref: ref.trim() });
    await this.persist();
  }

  async mergeSourceManifest(repo: string, manifest: Record<string, number>, dir?: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.sourcesByRepo.get(repo);
    if (existing === undefined || Object.keys(manifest).length === 0) return;
    const base: Record<string, number> = { ...(existing.manifest ?? {}) };
    if (dir !== undefined && dir !== '') {
      const prefix = dir + '/';
      for (const path of Object.keys(base)) {
        if (path.startsWith(prefix)) delete base[path];
      }
    }
    this.sourcesByRepo.set(repo, { ...existing, manifest: { ...base, ...manifest } });
    await this.persist();
  }

  async listOrigins(): Promise<Record<string, string>> {
    await this.ensureLoaded();
    const origins: Record<string, string> = {};
    for (const source of this.sourcesByRepo.values()) {
      for (const name of source.skills) origins[name] = source.repo;
    }
    return origins;
  }

  async listMarketSources(): Promise<MarketSourceRecord[]> {
    await this.ensureLoaded();
    return [...this.marketSources];
  }

  async getMarketSource(repo: string): Promise<MarketSourceRecord | undefined> {
    await this.ensureLoaded();
    return this.marketSources.find((entry) => entry.repo === repo);
  }

  async addMarketSource(repo: string, ref?: string): Promise<MarketSourceRecord[]> {
    await this.ensureLoaded();
    const existing = this.marketSources.find((entry) => entry.repo === repo);
    if (existing === undefined) {
      this.marketSources.push(ref !== undefined && ref !== '' ? { repo, ref } : { repo });
    } else if (ref !== undefined && ref !== '' && existing.ref !== ref) {
      existing.ref = ref;
    }
    await this.persist();
    return [...this.marketSources];
  }

  async removeMarketSource(repo: string): Promise<MarketSourceRecord[]> {
    await this.ensureLoaded();
    const index = this.marketSources.findIndex((entry) => entry.repo === repo);
    if (index === -1) return [...this.marketSources];
    this.marketSources.splice(index, 1);
    await this.persist();
    return [...this.marketSources];
  }

  async setMarketSourceRef(repo: string, ref: string): Promise<MarketSourceRecord | undefined> {
    await this.ensureLoaded();
    const entry = this.marketSources.find((item) => item.repo === repo);
    if (entry === undefined || ref.trim() === '') return entry;
    entry.ref = ref.trim();
    delete entry.commitSha;
    await this.persist();
    return entry;
  }

  async setMarketSourceCommit(repo: string, commitSha: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.marketSources.find((item) => item.repo === repo);
    if (entry === undefined || commitSha === '') return;
    entry.commitSha = commitSha;
    await this.persist();
  }

  async listTrash(): Promise<TrashEntry[]> {
    await this.ensureLoaded();
    return [...this.trashByName.values()].sort((a, b) => b.movedAt - a.movedAt);
  }

  async getTrash(name: string): Promise<TrashEntry | undefined> {
    await this.ensureLoaded();
    return this.trashByName.get(name);
  }

  async addTrash(entry: TrashEntry): Promise<void> {
    await this.ensureLoaded();
    this.trashByName.set(entry.name, entry);
    await this.persist();
  }

  async removeTrash(name: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.trashByName.delete(name)) return;
    await this.persist();
  }

  async getSkillStatsState(): Promise<SkillStatsCheckpoint | undefined> {
    await this.ensureLoaded();
    return this.skillStats !== undefined
      ? { ...this.skillStats, frozenSessions: { ...this.skillStats.frozenSessions } }
      : undefined;
  }

  async saveSkillStatsState(state: SkillStatsCheckpoint): Promise<void> {
    await this.ensureLoaded();
    this.skillStats = {
      windowDays: state.windowDays,
      frozenBefore: state.frozenBefore,
      frozenSessions: { ...state.frozenSessions },
      lastFullReconcile: state.lastFullReconcile,
    };
    await this.persist();
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      const payload: StoreFile = {
        version: STORE_VERSION,
        disabled: [...this.entries.values()],
        config: this.config,
        ...(this.tagsById.size > 0 ? { tags: [...this.tagsById.values()] } : {}),
        ...(this.sourcesByRepo.size > 0 ? { sources: [...this.sourcesByRepo.values()] } : {}),
        ...(this.marketSources.length > 0 ? { marketSources: [...this.marketSources] } : {}),
        ...(this.trashByName.size > 0 ? { trash: [...this.trashByName.values()] } : {}),
        ...(this.skillStats !== undefined ? { skillStats: this.skillStats } : {}),
        ...(this.collectionOrder.length > 0 ? { collectionOrder: [...this.collectionOrder] } : {}),
        ...(this.sourceGroupOrder.length > 0 ? { sourceGroupOrder: [...this.sourceGroupOrder] } : {}),
      };
      const tmp = this.file + '.tmp';
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      await rename(tmp, this.file);
    });
    this.writeChain = run.catch(() => {});
    return run;
  }
}

let defaultStoreInstance: SkillHubStore | null = null;
export function getSkillHubStore(): SkillHubStore {
  if (!defaultStoreInstance) {
    defaultStoreInstance = new SkillHubStore();
  }
  return defaultStoreInstance;
}
