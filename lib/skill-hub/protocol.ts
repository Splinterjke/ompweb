/**
 * Shared API contract for ompweb skill-hub: the route paths and payload shapes
 * both the server and the browser client import.
 */

/** Browser-facing base paths of the skill-hub API family. */
export const SKILL_HUB_API = {
  catalog: '/api/skill-hub/catalog',
  skill: '/api/skill-hub/skill',
  skillDelete: '/api/skill-hub/skill/delete',
  toggle: '/api/skill-hub/toggle',
  toggleBatch: '/api/skill-hub/toggle-batch',
  create: '/api/skill-hub/create',
  stats: '/api/skill-hub/stats',
  config: '/api/skill-hub/config',
  market: '/api/skill-hub/market',
  marketSource: '/api/skill-hub/market/source',
  marketSourceDelete: '/api/skill-hub/market/source/delete',
  marketSourceRef: '/api/skill-hub/market/source/ref',
  marketCheck: '/api/skill-hub/market/check',
  marketSync: '/api/skill-hub/market/source/sync',
  repo: '/api/skill-hub/repo',
  repoImport: '/api/skill-hub/repo/import',
  repoImportProgress: '/api/skill-hub/repo/import/progress',
  repoImportCancel: '/api/skill-hub/repo/import/cancel',
  update: '/api/skill-hub/update',
  groups: '/api/skill-hub/groups',
  tag: '/api/skill-hub/tag',
  tagDelete: '/api/skill-hub/tag/delete',
  tagMembers: '/api/skill-hub/tag/members',
  tagReorder: '/api/skill-hub/tag/reorder',
  collectionReorder: '/api/skill-hub/collections/reorder',
  sourceGroupReorder: '/api/skill-hub/source-groups/reorder',
  sources: '/api/skill-hub/sources',
  sourceCheck: '/api/skill-hub/sources/check',
  sourceSync: '/api/skill-hub/sources/sync',
  sourceDelete: '/api/skill-hub/sources/delete',
  sourceRestore: '/api/skill-hub/sources/restore',
  sourceTrashClear: '/api/skill-hub/sources/trash/clear',
  diagnosticFix: '/api/skill-hub/diagnostic/fix',
  marketSourceVersions: '/api/skill-hub/market/source/versions',
} as const;

/** User-level and project-level roots the hub may write to. */
export type WritableRoot =
  | 'user-agents'
  | 'user-omp'
  | 'user-dsh'
  | 'user-codex'
  | 'project-agents'
  | 'project-omp';
/** Invocation policy resolved by the registry, re-spelled for the wire. */
export interface HubInvocation {
  /** Whether model-facing catalogs may load this skill. */
  modelInvocable: boolean;
  /** Whether human-facing command catalogs may load this skill. */
  userInvocable: boolean;
}

/** One enabled skill row in the catalog. */
export interface CatalogSkill {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: HubInvocation;
  provider: string;
  /** Whether the hub may toggle this skill (user-level filesystem skills only). */
  writable: boolean;
  /** 技能来源标识（user-agents/user-omp/user-dsh/project-agents/project-omp/...）。 */
  source: string;
  /** SKILL.md creation time (epoch ms); used for "added" sorting. Absent when unknown. */
  addedAt?: number;
  /** SKILL.md last-modified time (epoch ms); used for "updated" display. Absent when unknown. */
  updatedAt?: number;
  /** 项目技能的所属工作区路径。 */
  workspace?: string;
  /** 工作区显示标题。 */
  workspaceTitle?: string;
  /** True when this enabled copy is the one OMP loads for a duplicated name
   *  (highest provider priority among the name's enabled copies). */
  priority?: boolean;
  displayName?: string;
  shortDescription?: string;
  brandColor?: string;
  iconSmall?: string;
  iconLarge?: string;
  defaultPrompt?: string;
}

/** One disabled skill tracked by the hub sidecar (SKILL.md renamed away or frontmatter disabled). */
export interface DisabledSkill {
  name: string;
  description: string;
  /** Absolute path of the disabled file. */
  path: string;
  root: WritableRoot;
  disabledAt: number;
}

/** One discovery diagnostic: a file the filesystem provider skips, with the reason. */
export interface DiagnosticEntry {
  path: string;
  root: string;
  reason: string;
  /** Whether this diagnostic can be auto-fixed (e.g. unquoted colon). */
  fixable?: boolean;
}

/** POST /api/skill-hub/diagnostic/fix — repair a fixable diagnostic in place. */
export interface DiagnosticFixRequest {
  path: string;
}
export interface DiagnosticFixResponse {
  ok: true;
  path: string;
}

/** GET /api/skill-hub/catalog */
export interface CatalogResponse {
  ok: true;
  pluginVersion: string;
  complete: boolean;
  skills: CatalogSkill[];
  disabled: DisabledSkill[];
  diagnostics: DiagnosticEntry[];
  duplicateNames?: string[];
}

/** GET /api/skill-hub/skill */
export interface SkillDetail {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: HubInvocation;
  provider: string;
  /** Absolute file path when the skill came from disk. */
  path?: string;
  enabled?: boolean;
  source?: string;
  diagnostic?: string;
  fixable?: boolean;
  addedAt?: number;
  updatedAt?: number;
  /** Markdown instruction body. */
  content: string;
  displayName?: string;
  shortDescription?: string;
  brandColor?: string;
  iconSmall?: string;
  iconLarge?: string;
  defaultPrompt?: string;
}

export interface SkillDetailResponse {
  ok: true;
  skill: SkillDetail;
}

/** POST /api/skill-hub/skill/delete — 把单个技能移入回收站（可恢复）。 */
export interface SkillDeleteRequest {
  name: string;
}

export interface SkillDeleteResponse {
  ok: true;
  name: string;
  path: string;
}

/** POST /api/skill-hub/toggle */
export interface ToggleRequest {
  name: string;
  enabled: boolean;
}

export interface ToggleResponse {
  ok: true;
  catalog: CatalogResponse;
}

/** POST /api/skill-hub/toggle-batch */
export interface ToggleBatchRequest {
  names: string[];
  enabled: boolean;
}

export interface ToggleBatchResponse {
  ok: true;
  catalog: CatalogResponse;
  failures: Array<{ name: string; error: string }>;
}

/** POST /api/skill-hub/create */
export interface CreateRequest {
  name: string;
  description?: string;
  root?: WritableRoot;
}

export interface CreateResponse {
  ok: true;
  path: string;
  root: WritableRoot;
}

/** One skill's invocation stats across the local session logs. */
export interface SkillStat {
  name: string;
  count: number;
  lastUsed?: number;
}

/** GET /api/skill-hub/stats */
export interface StatsResponse {
  ok: true;
  available: boolean;
  stats: SkillStat[];
}

export interface SkillStatsCheckpoint {
  windowDays: number;
  frozenBefore: number;
  frozenSessions: Record<string, { createdAt: number; counts: Record<string, { count: number; lastUsed: number }> }>;
  lastFullReconcile: number;
}

/** JSON error body shared by every route. */
export interface ErrorResponse {
  error: string;
}

/** The skill hub's own runtime configuration. */
export interface HubConfig {
  enabled: boolean;
  announceToAgent: boolean;
  dotModelColor?: string;
  dotUserColor?: string;
  showUseCount?: boolean;
  showUseTime?: boolean;
  showGroupSummary?: boolean;
  statsWindowDays?: number;
  statsScanMinutes?: number;
}

export type HubSettingsValue = {
  enabled: boolean;
  announceToAgent: boolean;
  showUseCount: boolean;
  showUseTime: boolean;
  showGroupSummary: boolean;
  dotModelColor?: string;
  dotUserColor?: string;
  statsWindowDays?: number;
  statsScanMinutes?: number;
};

export const HUB_CONFIG_DEFAULTS: HubConfig = {
  enabled: true,
  announceToAgent: true,
  showUseCount: true,
  showUseTime: true,
  showGroupSummary: true,
  statsWindowDays: 14,
  statsScanMinutes: 5,
};

export function resolveHubConfig(saved: Partial<HubConfig>, base: Partial<HubConfig> = {}): HubConfig {
  const dotModelColor = saved.dotModelColor !== undefined ? saved.dotModelColor : base.dotModelColor;
  const dotUserColor = saved.dotUserColor !== undefined ? saved.dotUserColor : base.dotUserColor;
  const windowDays = clampNumber(saved.statsWindowDays ?? base.statsWindowDays, 0) ?? HUB_CONFIG_DEFAULTS.statsWindowDays;
  const scanMinutes = clampNumber(saved.statsScanMinutes ?? base.statsScanMinutes, 1) ?? HUB_CONFIG_DEFAULTS.statsScanMinutes;
  return {
    enabled: saved.enabled ?? base.enabled ?? HUB_CONFIG_DEFAULTS.enabled,
    announceToAgent: saved.announceToAgent ?? base.announceToAgent ?? HUB_CONFIG_DEFAULTS.announceToAgent,
    showUseCount: saved.showUseCount ?? base.showUseCount ?? HUB_CONFIG_DEFAULTS.showUseCount,
    showUseTime: saved.showUseTime ?? base.showUseTime ?? HUB_CONFIG_DEFAULTS.showUseTime,
    showGroupSummary: saved.showGroupSummary ?? base.showGroupSummary ?? HUB_CONFIG_DEFAULTS.showGroupSummary,
    statsWindowDays: windowDays,
    statsScanMinutes: scanMinutes,
    ...(dotModelColor !== undefined ? { dotModelColor } : {}),
    ...(dotUserColor !== undefined ? { dotUserColor } : {}),
  };
}

function clampNumber(value: unknown, min: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return undefined;
  return Math.floor(value);
}

export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** GET /api/skill-hub/config */
export interface ConfigResponse {
  ok: true;
  pluginVersion: string;
  config: HubConfig;
  saved: Partial<HubConfig>;
}

/** POST /api/skill-hub/config */
export interface ConfigRequest {
  enabled?: boolean | null;
  announceToAgent?: boolean | null;
  showUseCount?: boolean | null;
  showUseTime?: boolean | null;
  showGroupSummary?: boolean | null;
  dotModelColor?: string | null;
  dotUserColor?: string | null;
  statsWindowDays?: number | null;
  statsScanMinutes?: number | null;
}

/** One market source: a tracked upstream repo plus its pinned version. */
export interface MarketSourceRecord {
  repo: string;
  ref?: string;
  commitSha?: string;
}

/** GET /api/skill-hub/market */
export interface MarketSourcesResponse {
  ok: true;
  repos: MarketSourceRecord[];
}

/** POST /api/skill-hub/market/source */
export interface MarketSourceRequest {
  repo: string;
}

export interface MarketSourceResponse {
  ok: true;
  repos: MarketSourceRecord[];
}

/** POST /api/skill-hub/market/source/ref */
export interface MarketSourceRefRequest {
  repo: string;
  ref: string;
}

/** GET /api/skill-hub/market/source/versions?repo= */
export interface MarketSourceVersionsResponse {
  ok: true;
  repo: string;
  current?: string;
  releases: string[];
  branches: string[];
}

/** GET /api/skill-hub/market/check */
export interface MarketCheckResponse {
  ok: true;
  results: Array<{
    repo: string;
    ref?: string;
    latestTag?: string;
    updateAvailable: boolean;
    commitSha: string;
    throttled?: boolean;
    error?: string;
  }>;
}

/** POST /api/skill-hub/market/source/sync */
export interface MarketSyncResponse {
  ok: true;
  repo: string;
  ref: string;
  commitSha: string;
  skills: string[];
}

export interface RepoSkillEntry {
  name: string;
  dir: string;
  path: string;
  root: RepoRoot;
  origin: string;
  fileCount: number;
  totalBytes: number;
  existing: boolean;
}

export type RepoRoot = string;

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

export interface RepoTreeItem {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

export interface RepoFile {
  path: string;
  size: number;
}

/** GET /api/skill-hub/repo */
export interface RepoDiscoverResponse {
  ok: true;
  repo: string;
  ref: string | null;
  branches?: string[];
  entries: RepoSkillEntry[];
  truncated?: boolean;
}

/** POST /api/skill-hub/repo/import */
export interface RepoImportRequest {
  repo: string;
  paths: string[];
  ref?: string;
}

export interface RepoImportResponse {
  ok: true;
  jobId: string;
  total: number;
  totalBytes: number;
}

/** GET /api/skill-hub/repo/import/progress?jobId=xxx */
export interface RepoImportProgressResponse {
  ok: true;
  jobId: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  total: number;
  done: number;
  current?: string;
  currentFile?: string;
  totalBytes: number;
  downloadedBytes: number;
  bytesPerSecond?: number;
  imported: Array<{ name: string; origin: string; path: string }>;
  skipped: Array<{ name: string; reason: 'exists' }>;
  failed: Array<{ name: string; error: string }>;
  error?: string;
}

/** POST /api/skill-hub/repo/import/cancel */
export interface RepoImportCancelRequest {
  jobId: string;
}
export interface RepoImportCancelResponse {
  ok: true;
  jobId: string;
  status: 'cancelled' | 'done';
}

/** GET /api/skill-hub/update */
export interface UpdateCheckResponse {
  ok: true;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  url: string | null;
  error?: string;
}

/** 用户自定义 tag 分组 */
export interface SkillTag {
  id: string;
  name: string;
  skillNames: string[];
  default?: boolean;
  color?: string;
  icon?: string;
}

/** 系统集合组 */
export interface CollectionGroup {
  name: string;
  skillNames: string[];
}

/** GET /api/skill-hub/groups */
export interface GroupsResponse {
  ok: true;
  tags: SkillTag[];
  collections: CollectionGroup[];
  origins: Record<string, string>;
  sourceGroupOrder?: string[];
  collectionOrder?: string[];
}

/** POST /api/skill-hub/tag */
export interface TagSaveRequest {
  id?: string;
  name: string;
}

export interface TagSaveResponse {
  ok: true;
  tags: SkillTag[];
}

/** POST /api/skill-hub/tag/delete */
export interface TagDeleteRequest {
  id: string;
}

export interface TagDeleteResponse {
  ok: true;
  tags: SkillTag[];
}

/** POST /api/skill-hub/tag/members */
export interface TagMembersRequest {
  id: string;
  skillNames: string[];
}

export interface TagMembersResponse {
  ok: true;
  tags: SkillTag[];
}

/** POST /api/skill-hub/tag/reorder */
export interface TagReorderRequest {
  orderedIds: string[];
}
export interface TagReorderResponse {
  ok: true;
  tags: SkillTag[];
}

/** POST /api/skill-hub/collections/reorder */
export interface CollectionReorderRequest {
  orderedNames: string[];
}
export interface CollectionReorderResponse {
  ok: true;
  collections: CollectionGroup[];
  order: string[];
}

/** POST /api/skill-hub/source-groups/reorder */
export interface SourceGroupReorderRequest {
  orderedKeys: string[];
}
export interface SourceGroupReorderResponse {
  ok: true;
  order: string[];
}

/** 来源跟踪记录 */
export interface SourceRecord {
  repo: string;
  ref?: string;
  root: RepoRoot;
  commitSha: string;
  skills: string[];
  manifest?: Record<string, number>;
}

/** 回收站条目 */
export interface TrashEntry {
  name: string;
  path: string;
  movedAt: number;
  sourcePath?: string;
  origin?: {
    repo: string;
    root: RepoRoot;
    ref?: string;
    commitSha: string;
  };
  tagIds?: string[];
}

/** GET /api/skill-hub/sources */
export interface SourcesResponse {
  ok: true;
  sources: SourceRecord[];
  origins: Record<string, string>;
  collections: CollectionGroup[];
  trash: TrashEntry[];
}

/** POST /api/skill-hub/sources/check */
export interface SourceCheckRequest {
  repo?: string;
}

export interface SourceCheckResult {
  repo: string;
  ref?: string;
  error?: string;
  changed: boolean;
  commitSha?: string;
  updated: string[];
  deleted: string[];
  throttled?: boolean;
  unverified?: boolean;
}

export interface SourceCheckResponse {
  ok: true;
  results: SourceCheckResult[];
}

/** POST /api/skill-hub/sources/sync */
export interface SourceSyncRequest {
  repo: string;
  skills?: string[];
}

export interface SourceSyncResponse {
  ok: true;
  repo: string;
  commitSha: string;
  synced: string[];
  failed: Array<{ name: string; error: string }>;
}

/** POST /api/skill-hub/sources/delete */
export interface SourceDeleteRequest {
  repo: string;
  skills: string[];
}

export interface SourceDeleteResponse {
  ok: true;
  trashed: string[];
  failed: Array<{ name: string; error: string }>;
}

/** POST /api/skill-hub/sources/restore */
export interface SourceRestoreRequest {
  name: string;
}

export interface SourceRestoreResponse {
  ok: true;
  name: string;
  path: string;
}

/** POST /api/skill-hub/sources/trash/clear */
export interface SourceTrashClearResponse {
  ok: true;
  deleted: string[];
  failed: Array<{ name: string; error: string }>;
}

/** 项目级技能来源 */
export function isProjectSource(source: string): boolean {
  return source === 'project-agents' || source === 'project-omp' || source === 'project-dsh' || source.startsWith('project-');
}

/** 默认场景名（系统预置的兜底场景，新技能自动归入）。
 *  Defined in this module (no node builtins) so it is safe to import from
 *  client components. */
export const DEFAULT_SCENE_NAME = '通用';
