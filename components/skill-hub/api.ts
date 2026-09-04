/**
 * Browser-side API client for the /api/skill-hub route family.
 */
import {
  SKILL_HUB_API,
  type CatalogResponse,
  type CollectionGroup,
  type ConfigRequest,
  type ConfigResponse,
  type CreateRequest,
  type CreateResponse,
  type MarketCheckResponse,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type MarketSourceVersionsResponse,
  type MarketSyncResponse,
  type RepoDiscoverResponse,
  type RepoImportCancelResponse,
  type RepoImportProgressResponse,
  type RepoImportResponse,
  type SkillDeleteResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type SkillTag,
  type SourceCheckResponse,
  type SourceDeleteResponse,
  type SourceRestoreResponse,
  type SourceSyncResponse,
  type SourceTrashClearResponse,
  type SourcesResponse,
  type StatsResponse,
  type ToggleBatchResponse,
  type ToggleResponse,
  type UpdateCheckResponse,
} from '@/lib/skill-hub/protocol';

export class SkillHubApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillHubApiError';
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SkillHubApiError('HTTP ' + response.status + ': invalid JSON response');
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'HTTP ' + response.status;
    throw new SkillHubApiError(message);
  }
  return body as T;
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, ms = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class SkillHubApi {
  catalog(options?: { cwd?: string }): Promise<CatalogResponse> {
    const url =
      options?.cwd !== undefined && options.cwd !== ''
        ? SKILL_HUB_API.catalog + '?cwd=' + encodeURIComponent(options.cwd)
        : SKILL_HUB_API.catalog;
    return fetchWithTimeout(url).then((res) => readJson<CatalogResponse>(res));
  }

  skill(name: string, options?: { cwd?: string }): Promise<SkillDetail> {
    let url = SKILL_HUB_API.skill + '?name=' + encodeURIComponent(name);
    if (options?.cwd) url += '&cwd=' + encodeURIComponent(options.cwd);
    return fetchWithTimeout(url)
      .then((res) => readJson<SkillDetailResponse>(res))
      .then((r) => r.skill);
  }

  async toggle(name: string, enabled: boolean, options?: { cwd?: string }): Promise<CatalogResponse> {
    const res = await fetchWithTimeout(SKILL_HUB_API.toggle, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, enabled, ...(options?.cwd ? { cwd: options.cwd } : {}) }),
    }).then((r) => readJson<ToggleResponse>(r));
    if (res.catalog) return res.catalog;
    return this.catalog(options);
  }

  async toggleBatch(
    names: string[],
    enabled: boolean,
    options?: { cwd?: string }
  ): Promise<{ ok: true; catalog: CatalogResponse; failures: Array<{ name: string; error: string }> }> {
    const res = await fetchWithTimeout(SKILL_HUB_API.toggleBatch, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names, enabled, ...(options?.cwd ? { cwd: options.cwd } : {}) }),
    }).then((r) => readJson<ToggleBatchResponse>(r));
    const catalog = res.catalog ?? (await this.catalog(options));
    return { ok: true, catalog, failures: res.failures ?? [] };
  }

  create(request: CreateRequest & { cwd?: string }): Promise<CreateResponse> {
    return fetchWithTimeout(SKILL_HUB_API.create, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }).then((res) => readJson<CreateResponse>(res));
  }

  deleteSkill(name: string, cwd?: string): Promise<SkillDeleteResponse> {
    return fetchWithTimeout(SKILL_HUB_API.skillDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...(cwd ? { cwd } : {}) }),
    }).then((res) => readJson<SkillDeleteResponse>(res));
  }

  fixDiagnostic(path: string): Promise<{ ok: true; catalog: CatalogResponse }> {
    return fetchWithTimeout(SKILL_HUB_API.diagnosticFix, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((res) => readJson<{ ok: true; catalog: CatalogResponse }>(res));
  }

  groups(): Promise<{
    ok: true;
    tags: SkillTag[];
    collections: CollectionGroup[];
    origins: Record<string, string>;
    sourceGroupOrder?: string[];
    collectionOrder?: string[];
  }> {
    return fetchWithTimeout(SKILL_HUB_API.groups).then((res) => readJson(res));
  }

  async saveTag(input: { id?: string; name: string; color?: string; icon?: string }): Promise<SkillTag[]> {
    await fetchWithTimeout(SKILL_HUB_API.tag, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then((res) => readJson(res));
    return (await this.groups()).tags;
  }

  async deleteTag(id: string): Promise<SkillTag[]> {
    await fetchWithTimeout(SKILL_HUB_API.tagDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then((res) => readJson(res));
    return (await this.groups()).tags;
  }

  async setTagMembers(id: string, skillNames: string[]): Promise<SkillTag[]> {
    await fetchWithTimeout(SKILL_HUB_API.tagMembers, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, skillNames }),
    }).then((res) => readJson(res));
    return (await this.groups()).tags;
  }

  async reorderTags(orderedIds: string[]): Promise<SkillTag[]> {
    await fetchWithTimeout(SKILL_HUB_API.tagReorder, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }).then((res) => readJson(res));
    return (await this.groups()).tags;
  }

  async reorderCollections(orderedNames: string[]): Promise<CollectionGroup[]> {
    await fetchWithTimeout(SKILL_HUB_API.collectionReorder, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedNames }),
    }).then((res) => readJson(res));
    return (await this.groups()).collections;
  }

  async reorderSourceGroups(orderedNames: string[]): Promise<string[]> {
    const res = await fetchWithTimeout(SKILL_HUB_API.sourceGroupReorder, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedNames }),
    }).then((r) => readJson<{ ok: true; order: string[] }>(r));
    return res.order;
  }

  sources(): Promise<SourcesResponse> {
    return fetchWithTimeout(SKILL_HUB_API.sources).then((res) => readJson(res));
  }

  checkSources(repo?: string): Promise<SourceCheckResponse> {
    return fetchWithTimeout(SKILL_HUB_API.sourceCheck, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo }),
    }).then((res) => readJson(res));
  }

  syncSource(repo: string, skills: string[]): Promise<SourceSyncResponse> {
    return fetchWithTimeout(SKILL_HUB_API.sourceSync, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, skills }),
    }).then((res) => readJson(res));
  }

  confirmDeleteSource(repo: string, skills: string[]): Promise<SourceDeleteResponse> {
    return fetchWithTimeout(SKILL_HUB_API.sourceDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, skills }),
    }).then((res) => readJson(res));
  }

  restoreSource(name: string): Promise<SourceRestoreResponse> {
    return fetchWithTimeout(SKILL_HUB_API.sourceRestore, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((res) => readJson(res));
  }

  clearTrash(): Promise<SourceTrashClearResponse> {
    return fetchWithTimeout(SKILL_HUB_API.sourceTrashClear, {
      method: 'POST',
    }).then((res) => readJson(res));
  }

  market(): Promise<MarketSourcesResponse> {
    return fetchWithTimeout(SKILL_HUB_API.market).then((res) => readJson(res));
  }

  addMarketSource(repo: string): Promise<MarketSourceResponse> {
    return fetchWithTimeout(SKILL_HUB_API.marketSource, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo }),
    }).then((res) => readJson(res));
  }

  removeMarketSource(repo: string): Promise<MarketSourceResponse> {
    return fetchWithTimeout(SKILL_HUB_API.marketSourceDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo }),
    }).then((res) => readJson(res));
  }

  setMarketSourceRef(repo: string, ref: string): Promise<MarketSourceResponse> {
    return fetchWithTimeout(SKILL_HUB_API.marketSourceRef, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, ref }),
    }).then((res) => readJson(res));
  }

  marketSourceVersions(repo: string): Promise<MarketSourceVersionsResponse> {
    return fetchWithTimeout(SKILL_HUB_API.marketSourceVersions + '?repo=' + encodeURIComponent(repo)).then((res) =>
      readJson(res)
    );
  }

  marketCheck(): Promise<MarketCheckResponse> {
    return fetchWithTimeout(SKILL_HUB_API.marketCheck).then((res) => readJson(res));
  }

  marketSync(repo: string): Promise<MarketSyncResponse> {
    return fetchWithTimeout(SKILL_HUB_API.marketSync, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo }),
    }).then((res) => readJson(res));
  }

  repoDiscover(repo: string, ref?: string): Promise<RepoDiscoverResponse> {
    let url = SKILL_HUB_API.repo + '?repo=' + encodeURIComponent(repo);
    if (ref) url += '&ref=' + encodeURIComponent(ref);
    return fetchWithTimeout(url).then((res) => readJson(res));
  }

  repoImport(
    repo: string,
    paths: string[],
    ref?: string,
    options?: { root?: string; cwd?: string }
  ): Promise<RepoImportResponse> {
    return fetchWithTimeout(SKILL_HUB_API.repoImport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, paths, ref, ...(options ?? {}) }),
    }).then((res) => readJson(res));
  }

  repoImportProgress(jobId: string): Promise<RepoImportProgressResponse> {
    return fetchWithTimeout(SKILL_HUB_API.repoImportProgress + '?jobId=' + encodeURIComponent(jobId)).then((res) =>
      readJson(res)
    );
  }

  repoImportCancel(jobId: string): Promise<RepoImportCancelResponse> {
    return fetchWithTimeout(SKILL_HUB_API.repoImportCancel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }).then((res) => readJson(res));
  }

  updateCheck(): Promise<UpdateCheckResponse> {
    return fetchWithTimeout(SKILL_HUB_API.update).then((res) => readJson(res));
  }

  config(): Promise<ConfigResponse> {
    return fetchWithTimeout(SKILL_HUB_API.config).then((res) => readJson(res));
  }

  saveConfig(patch: ConfigRequest): Promise<ConfigResponse> {
    return fetchWithTimeout(SKILL_HUB_API.config, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((res) => readJson(res));
  }

  stats(): Promise<StatsResponse> {
    return fetchWithTimeout(SKILL_HUB_API.stats).then((res) => readJson(res));
  }
}

export const skillHubApi = new SkillHubApi();
