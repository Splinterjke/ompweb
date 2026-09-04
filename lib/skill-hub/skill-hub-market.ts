/**
 * GitHub repository discovery, download, and sync helpers for Skill Hub.
 * Discovers skills from GitHub repositories (e.g. anthropics/skills, mattpocock/skills),
 * scans releases/branches, and downloads skills into the user root (~/.agents/skills).
 */

import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  MarketSourceRecord,
  RepoDiscoverResponse,
  RepoFile,
  RepoImportProgressResponse,
  RepoImportRequest,
  RepoRef,
  RepoSkillEntry,
  RepoTreeItem,
  WritableRoot,
} from './protocol';
import { parseFrontmatter } from './skill-hub-diagnostics';
import { getSkillHubStore } from './skill-hub-store';
import { resolveRootPath } from './skill-hub-service';

export class RepoFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'RepoFetchError';
    this.status = status;
  }
}

let githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

export function setGithubToken(token: string | undefined): void {
  githubToken = token !== undefined && token !== '' ? token : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '');
}

export function githubAuthHeaders(): Record<string, string> {
  return githubToken === '' ? {} : { authorization: 'Bearer ' + githubToken };
}

const ROOT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

export function normalizeRepoInput(input: string): RepoRef | null {
  let value = input.trim();
  if (value === '') return null;

  let ref: string | undefined;
  const urlMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/#?@]+)(?:\/tree\/([^/?#]+))?/.exec(value);
  if (urlMatch !== null) {
    value = `${urlMatch[1]}/${urlMatch[2]}`;
    ref = urlMatch[3];
  } else {
    if (/^https?:\/\//.test(value)) return null;
    const at = value.indexOf('@');
    if (at !== -1) {
      ref = value.slice(at + 1).trim();
      value = value.slice(0, at).trim();
    }
  }

  value = value.replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (owner === '' || repo === '' || owner.includes('..') || repo.includes('..')) return null;
  return { owner, repo, ...(ref !== undefined && ref !== '' ? { ref } : {}) };
}

export async function fetchJsonCached(
  url: string,
  fetchImpl: typeof fetch = fetch,
  context = 'fetch failed'
): Promise<{ json: unknown; response: Response }> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    ...githubAuthHeaders(),
  };
  let response: Response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (err) {
    throw new RepoFetchError(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const reset = response.headers.get('x-ratelimit-reset');
      if (reset) {
        const at = new Date(Number(reset) * 1000);
        throw new RepoFetchError(
          `GitHub rate limit exceeded. Retry after ${at.toLocaleTimeString()} or configure GITHUB_TOKEN`,
          403
        );
      }
    }
    throw new RepoFetchError(`${context} (HTTP ${response.status})`, response.status);
  }
  try {
    const json = await response.json();
    return { json, response };
  } catch {
    throw new RepoFetchError(`Invalid JSON response for ${url}`);
  }
}

export async function loadRepoTree(
  repo: string,
  ref?: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ref: string; tree: RepoTreeItem[]; truncated: boolean }> {
  const metaUrl = `https://api.github.com/repos/${repo}`;
  const { json: metaJson } = await fetchJsonCached(metaUrl, fetchImpl, 'GitHub repo not found');
  const meta = typeof metaJson === 'object' && metaJson !== null ? (metaJson as Record<string, unknown>) : {};
  const defaultBranch = typeof meta.default_branch === 'string' && meta.default_branch !== '' ? meta.default_branch : 'main';
  const treeRef = ref !== undefined && ref !== '' ? ref : defaultBranch;

  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`;
  const { json: treeJson } = await fetchJsonCached(treeUrl, fetchImpl, 'GitHub tree not found');
  const treeRecord = typeof treeJson === 'object' && treeJson !== null ? (treeJson as Record<string, unknown>) : {};
  const truncated = treeRecord.truncated === true;
  const tree = Array.isArray(treeRecord.tree) ? (treeRecord.tree as RepoTreeItem[]) : [];

  return { ref: treeRef, tree, truncated };
}

export function collectRepoSkillFiles(tree: readonly RepoTreeItem[], dir: string): RepoFile[] {
  const prefix = dir + '/';
  return tree
    .filter((item) => item.type === 'blob' && item.path.startsWith(prefix))
    .map((item) => ({ path: item.path, size: typeof item.size === 'number' ? item.size : 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 80;
}

export function originForRoot(repo: string, rootsPresent: ReadonlySet<string>, root: string): string {
  return rootsPresent.size > 1 ? `${repo}/${root}` : repo;
}

export function discoverRepoEntries(
  tree: readonly RepoTreeItem[],
  repo: string,
  existingNames: ReadonlySet<string> = new Set()
): RepoSkillEntry[] {
  const candidates: Array<{ root: string; dir: string; name: string; path: string }> = [];
  const rootsPresent = new Set<string>();

  for (const item of tree) {
    if (item.type !== 'blob') continue;
    const slash = item.path.indexOf('/');
    if (slash === -1) continue;
    if (!item.path.endsWith('/SKILL.md')) continue;
    const root = item.path.slice(0, slash);
    if (!ROOT_RE.test(root)) continue;
    const dir = item.path.slice(0, -'/SKILL.md'.length);
    if (dir === root || dir.length <= root.length + 1) continue;
    const name = dir.slice(dir.lastIndexOf('/') + 1);
    if (!isSkillName(name)) continue;

    rootsPresent.add(root);
    candidates.push({ root, dir, name, path: item.path });
  }

  return candidates
    .map((candidate) => {
      const files = collectRepoSkillFiles(tree, candidate.dir);
      return {
        name: candidate.name,
        dir: candidate.dir,
        path: candidate.path,
        root: candidate.root,
        origin: originForRoot(repo, rootsPresent, candidate.root),
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        existing: existingNames.has(candidate.name),
      } satisfies RepoSkillEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('aborted') || error.message.includes('Abort'))
  );
}

export async function downloadGitHubFile(
  repo: string,
  ref: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<Buffer> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodedPath}`;

  let response: Response | null = null;
  let firstError: string | null = null;
  try {
    response = await fetchImpl(rawUrl, {
      headers: githubAuthHeaders(),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    firstError = err instanceof Error ? err.message : String(err);
  }

  if (response === null || !response.ok) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodedPath}`;
    try {
      response = await fetchImpl(apiUrl, {
        headers: { accept: 'application/vnd.github.raw', ...githubAuthHeaders() },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new RepoFetchError(`Download failed: ${firstError ?? (err instanceof Error ? err.message : String(err))}`);
    }
  }

  if (response === null || !response.ok) {
    throw new RepoFetchError(`Download failed (HTTP ${response?.status ?? 502})`);
  }

  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new RepoFetchError(`Download read error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function downloadRepoSkill(
  repo: string,
  ref: string,
  entry: RepoSkillEntry,
  files: readonly RepoFile[],
  targetRoot: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  onProgress?: (bytes: number, file: string) => void
): Promise<{ targetDir: string; skillPath: string }> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const targetDir = join(targetRoot, entry.name);
  await fs.mkdir(targetRoot, { recursive: true });

  const tempDir = await fs.mkdtemp(join(targetRoot, `.${entry.name}.import-`));
  let renamed = false;

  try {
    await mapConcurrent(files, 5, async (file) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const relative = file.path.slice(entry.dir.length + 1);
      if (relative === '' || relative.includes('..')) {
        throw new RepoFetchError('Unsafe repo path: ' + file.path);
      }
      const target = join(tempDir, relative);
      const buffer = await downloadGitHubFile(repo, ref, file.path, fetchImpl, signal);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, buffer);
      onProgress?.(buffer.length, relative);
    });

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    const skillPath = join(tempDir, 'SKILL.md');
    let text: string;
    try {
      text = await fs.readFile(skillPath, 'utf8');
    } catch {
      throw new RepoFetchError('Downloaded skill has no SKILL.md');
    }

    const parsed = parseFrontmatter(text);
    if ('error' in parsed) {
      throw new RepoFetchError(`Downloaded skill rejected: ${parsed.error}`, 422);
    }

    // Rename tempDir into targetDir
    if (existsSync(targetDir)) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
    await fs.rename(tempDir, targetDir);
    renamed = true;
    return { targetDir, skillPath: join(targetDir, 'SKILL.md') };
  } finally {
    if (!renamed) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function getLatestReleaseTag(
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', ...githubAuthHeaders() },
    });
  } catch (err) {
    throw new RepoFetchError('GitHub release lookup failed: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (response.status === 404) return undefined;
  if (!response.ok) return undefined;
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    const tag = payload.tag_name;
    return typeof tag === 'string' && tag !== '' ? tag : undefined;
  } catch {
    return undefined;
  }
}

export async function listRepoReleases(
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers: { accept: 'application/vnd.github+json', ...githubAuthHeaders() },
    });
  } catch (err) {
    throw new RepoFetchError('GitHub releases request failed: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (!response.ok) return [];
  try {
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(payload)) return [];
    return payload
      .filter((item) => item.draft !== true)
      .map((item) => item.tag_name)
      .filter((tag): tag is string => typeof tag === 'string' && tag !== '');
  } catch {
    return [];
  }
}

export async function listRepoBranches(
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/branches?per_page=100`, {
      headers: { accept: 'application/vnd.github+json', ...githubAuthHeaders() },
    });
  } catch (err) {
    throw new RepoFetchError('GitHub branches request failed: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (!response.ok) return [];
  try {
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(payload)) return [];
    return payload
      .map((item) => item.name)
      .filter((name): name is string => typeof name === 'string' && name !== '');
  } catch {
    return [];
  }
}

export async function getLatestCommit(
  repo: string,
  ref?: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ commitSha: string; treeSha: string }> {
  const url =
    ref !== undefined && ref !== ''
      ? `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`
      : `https://api.github.com/repos/${repo}/commits?per_page=1`;
  const { json: payload } = await fetchJsonCached(url, fetchImpl, 'GitHub commit lookup failed');
  const record = Array.isArray(payload)
    ? ((payload[0] ?? {}) as Record<string, unknown>)
    : ((payload ?? {}) as Record<string, unknown>);
  const commitSha = typeof record.sha === 'string' ? record.sha : '';
  const tree = typeof record.commit === 'object' && record.commit !== null ? (record.commit as Record<string, unknown>).tree as Record<string, unknown> | undefined : undefined;
  const treeSha = typeof tree?.sha === 'string' ? tree.sha : '';
  if (!commitSha || !treeSha) {
    throw new RepoFetchError('GitHub commit response missing sha or tree');
  }
  return { commitSha, treeSha };
}

export function skillManifest(tree: readonly RepoTreeItem[], dir: string): Record<string, number> {
  const prefix = dir + '/';
  const manifest: Record<string, number> = {};
  for (const item of tree) {
    if (item.type === 'blob' && item.path.startsWith(prefix)) {
      manifest[item.path] = typeof item.size === 'number' ? item.size : 0;
    }
  }
  return manifest;
}

/** Load the recursive git tree at an explicit tree SHA (one API request). */
export async function loadRepoTreeAt(
  repo: string,
  treeSha: string,
  fetchImpl: typeof fetch = fetch
): Promise<RepoTreeItem[]> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`;
  const { json } = await fetchJsonCached(url, fetchImpl, 'GitHub tree lookup failed');
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (record.truncated === true) throw new RepoFetchError('Repo tree is too large to scan');
  return Array.isArray(record.tree) ? (record.tree as RepoTreeItem[]) : [];
}

/**
 * The real upstream directory of one tracked skill.
 */
export function skillDirOf(
  source: { root: string; manifest?: Record<string, number> },
  name: string,
  treePaths?: readonly string[]
): string {
  if (treePaths !== undefined) {
    const rootPrefix = source.root + '/';
    const found = treePaths.find(
      (path) => path.startsWith(rootPrefix) && path.endsWith('/' + name + '/SKILL.md')
    );
    if (found !== undefined) return found.slice(0, found.lastIndexOf('/'));
  }
  const manifest = source.manifest ?? {};
  const fromManifest = Object.keys(manifest).find((path) =>
    path.endsWith('/' + name + '/SKILL.md')
  );
  if (fromManifest !== undefined) return fromManifest.slice(0, fromManifest.lastIndexOf('/'));
  if (treePaths !== undefined) {
    const found = treePaths.find((path) => path.endsWith('/' + name + '/SKILL.md'));
    if (found !== undefined) return found.slice(0, found.lastIndexOf('/'));
  }
  return source.root + '/' + name;
}

/**
 * Diff one source record against an upstream tree at treeSha.
 */
export function diffRemoteSkills(
  tree: readonly RepoTreeItem[],
  source: { root: string; skills: readonly string[]; manifest?: Record<string, number> }
): { updated: string[]; deleted: string[] } {
  const blobs = new Map<string, number>();
  for (const item of tree) {
    if (item.type === 'blob') blobs.set(item.path, typeof item.size === 'number' ? item.size : 0);
  }
  const treePaths = [...blobs.keys()];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const name of source.skills) {
    const prefix = skillDirOf(source, name, treePaths) + '/';
    const remote = new Map<string, number>();
    for (const [path, size] of blobs) {
      if (path.startsWith(prefix)) remote.set(path, size);
    }
    if (!remote.has(prefix + 'SKILL.md')) {
      deleted.push(name);
      continue;
    }
    const baseline = source.manifest ?? {};
    const baselineEntries = Object.entries(baseline).filter(([path]) => path.startsWith(prefix));
    if (baselineEntries.length === 0) {
      updated.push(name);
      continue;
    }
    let differs = baselineEntries.length !== remote.size;
    if (!differs) {
      for (const [path, size] of baselineEntries) {
        if (remote.get(path) !== size) {
          differs = true;
          break;
        }
      }
    }
    if (differs) updated.push(name);
  }
  return { updated, deleted };
}

/** Minimal RepoSkillEntry for a tracked skill name (sync re-downloads by name). */
export function repoSkillEntry(name: string, root: string, repo: string): RepoSkillEntry {
  return {
    name,
    dir: root + '/' + name,
    path: root + '/' + name + '/SKILL.md',
    root,
    origin: repo,
    fileCount: 0,
    totalBytes: 0,
    existing: false,
  };
}


// ------------------------------------------------------------------ Import Jobs

export interface ImportJobState {
  jobId: string;
  repo: string;
  ref: string;
  total: number;
  done: number;
  totalBytes: number;
  downloadedBytes: number;
  current?: string;
  currentFile?: string;
  startTime: number;
  imported: Array<{ name: string; origin: string; path: string }>;
  skipped: Array<{ name: string; reason: 'exists' }>;
  failed: Array<{ name: string; error: string }>;
  status: 'running' | 'done' | 'cancelled' | 'error';
  controller: AbortController;
  createdAt: number;
}

const importJobs = new Map<string, ImportJobState>();

export function getImportJob(jobId: string): ImportJobState | undefined {
  return importJobs.get(jobId);
}

export function cancelImportJob(jobId: string): boolean {
  const job = importJobs.get(jobId);
  if (!job) return false;
  if (job.status === 'running') {
    job.status = 'cancelled';
    job.controller.abort();
    return true;
  }
  return false;
}

export async function startImportJob(
  request: RepoImportRequest,
  options?: { targetRoot?: WritableRoot; cwd?: string }
): Promise<ImportJobState> {
  const parsed = normalizeRepoInput(request.repo);
  if (!parsed) throw new RepoFetchError('Invalid repo: ' + request.repo, 400);

  const repo = repoSlug(parsed);
  const ref = request.ref || parsed.ref;
  const { ref: resolvedRef, tree } = await loadRepoTree(repo, ref);
  const entries = discoverRepoEntries(tree, repo);

  const byPath = new Map(entries.map((e) => [e.path, e]));
  const selected = (request.paths || [])
    .map((p) => byPath.get(p))
    .filter((e): e is RepoSkillEntry => e !== undefined);

  if (selected.length === 0) throw new RepoFetchError('No matching skills for selected paths', 400);

  const totalBytes = selected.reduce((sum, e) => sum + e.totalBytes, 0);
  const jobId = 'imp_' + randomUUID().slice(0, 8);
  const controller = new AbortController();
  const now = Date.now();

  const job: ImportJobState = {
    jobId,
    repo,
    ref: resolvedRef,
    total: selected.length,
    done: 0,
    totalBytes,
    downloadedBytes: 0,
    startTime: now,
    imported: [],
    skipped: [],
    failed: [],
    status: 'running',
    controller,
    createdAt: now,
  };

  importJobs.set(jobId, job);

  // Background execution: target root defaults to user-agents (~/.agents/skills)
  const targetWritableRoot: WritableRoot = options?.targetRoot ?? 'user-agents';
  const targetDir = resolveRootPath(targetWritableRoot, options);

  void (async () => {
    const store = getSkillHubStore();
    await store.ensureLoaded();
    const defaultTag = await store.getDefaultTag();

    let commitSha = '';
    try {
      const latest = await getLatestCommit(repo, resolvedRef);
      commitSha = latest.commitSha;
    } catch {}

    for (const entry of selected) {
      if (controller.signal.aborted) {
        job.status = 'cancelled';
        break;
      }
      job.current = entry.name;
      job.currentFile = entry.dir + '/SKILL.md';

      if (existsSync(join(targetDir, entry.name))) {
        job.skipped.push({ name: entry.name, reason: 'exists' });
        job.downloadedBytes += entry.totalBytes;
        job.done += 1;
        continue;
      }

      const files = collectRepoSkillFiles(tree, entry.dir);
      try {
        const result = await downloadRepoSkill(
          repo,
          resolvedRef,
          entry,
          files,
          targetDir,
          fetch,
          controller.signal,
          (bytes, file) => {
            job.downloadedBytes += bytes;
            job.currentFile = entry.dir + '/' + file;
          }
        );

        await store.addSourceSkill(repo, entry.root, commitSha, resolvedRef, entry.name);
        await store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir);
        if (defaultTag) {
          await store.addSkillToTag(defaultTag.id, entry.name);
        }

        job.imported.push({ name: entry.name, origin: entry.origin, path: result.skillPath });
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) {
          job.status = 'cancelled';
          break;
        }
        job.failed.push({
          name: entry.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      job.done += 1;
    }

    if (job.status === 'running') {
      job.status = 'done';
    }
  })();

  return job;
}
