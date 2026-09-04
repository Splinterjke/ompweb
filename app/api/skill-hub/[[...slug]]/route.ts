import { NextResponse } from 'next/server';
import {
  clearTrashSkill,
  createSkill,
  deleteSkill,
  fixDiagnostic,
  getSkillDetail,
  resolveRootPath,
  restoreTrashSkill,
  scanAllRoots,
  toggleBatch,
  toggleSkill,
} from '@/lib/skill-hub/skill-hub-service';
import { restartAllRpcSessions } from '@/lib/rpc-manager';
import {
  getSkillHubStore,
  StoreError,
} from '@/lib/skill-hub/skill-hub-store';
import {
  cancelImportJob,
  collectRepoSkillFiles,
  diffRemoteSkills,
  discoverRepoEntries,
  downloadRepoSkill,
  getImportJob,
  getLatestCommit,
  getLatestReleaseTag,
  listRepoBranches,
  listRepoReleases,
  loadRepoTree,
  loadRepoTreeAt,
  normalizeRepoInput,
  repoSkillEntry,
  repoSlug,
  skillDirOf,
  skillManifest,
  startImportJob,
} from '@/lib/skill-hub/skill-hub-market';
import type {
  CollectionGroup,
  GroupsResponse,
  MarketCheckResponse,
  MarketSourcesResponse,
  MarketSourceVersionsResponse,
  RepoDiscoverResponse,
  RepoImportCancelResponse,
  RepoImportProgressResponse,
  RepoImportResponse,
  SourceCheckResponse,
  SourceCheckResult,
  SourceDeleteResponse,
  SourceRestoreResponse,
  SourceSyncResponse,
  SourceTrashClearResponse,
  SourcesResponse,
  WritableRoot,
} from '@/lib/skill-hub/protocol';

export const dynamic = 'force-dynamic';

function getCwdFromUrl(url: URL): string | undefined {
  const cwd = url.searchParams.get('cwd');
  return cwd && cwd.trim() !== '' ? cwd.trim() : undefined;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug?: string[] }> }
) {
  const { slug = [] } = await params;
  const path = slug.join('/');
  const url = new URL(req.url);
  const cwd = getCwdFromUrl(url);
  const store = getSkillHubStore();
  await store.ensureLoaded();

  try {
    switch (path) {
      case 'catalog': {
        const catalog = await scanAllRoots({ cwd });
        return NextResponse.json(catalog);
      }

      case 'skill': {
        const name = url.searchParams.get('name') ?? '';
        if (!name) {
          return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }
        const skill = await getSkillDetail(name, { cwd });
        if (!skill) {
          return NextResponse.json({ error: `Skill not found: ${name}` }, { status: 404 });
        }
        return NextResponse.json({ ok: true, skill });
      }

      case 'groups': {
        const [tags, origins, collectionOrder, sourceGroupOrder] = await Promise.all([
          store.listTags(),
          store.listOrigins(),
          store.getCollectionOrder(),
          store.getSourceGroupOrder(),
        ]);

        const byCollection = new Map<string, string[]>();
        for (const [skillName, origin] of Object.entries(origins)) {
          const list = byCollection.get(origin);
          if (list === undefined) byCollection.set(origin, [skillName]);
          else list.push(skillName);
        }

        const orderIndex = new Map(collectionOrder.map((name, i) => [name, i] as const));
        const collections: CollectionGroup[] = [...byCollection.entries()]
          .map(([name, skillNames]) => ({
            name,
            skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)),
          }))
          .sort((a, b) => {
            const ai = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Infinity;
            const bi = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Infinity;
            if (ai !== bi) return ai - bi;
            return a.name.localeCompare(b.name);
          });

        const res: GroupsResponse = {
          ok: true,
          tags,
          collections,
          origins,
          ...(sourceGroupOrder.length > 0 ? { sourceGroupOrder } : {}),
          ...(collectionOrder.length > 0 ? { collectionOrder } : {}),
        };
        return NextResponse.json(res);
      }

      case 'sources': {
        const [sources, trash, origins, collectionOrder] = await Promise.all([
          store.listSources(),
          store.listTrash(),
          store.listOrigins(),
          store.getCollectionOrder(),
        ]);

        const byCollection = new Map<string, string[]>();
        for (const [skillName, origin] of Object.entries(origins)) {
          const list = byCollection.get(origin);
          if (list === undefined) byCollection.set(origin, [skillName]);
          else list.push(skillName);
        }

        const orderIndex = new Map(collectionOrder.map((name, i) => [name, i] as const));
        const collections: CollectionGroup[] = [...byCollection.entries()]
          .map(([name, skillNames]) => ({
            name,
            skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)),
          }))
          .sort((a, b) => {
            const ai = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Infinity;
            const bi = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Infinity;
            if (ai !== bi) return ai - bi;
            return a.name.localeCompare(b.name);
          });

        return NextResponse.json({
          ok: true,
          sources,
          origins,
          collections,
          trash,
        } satisfies SourcesResponse);
      }

      case 'market': {
        const repos = await store.listMarketSources();
        return NextResponse.json({ ok: true, repos } satisfies MarketSourcesResponse);
      }

      case 'market/source/versions': {
        const repoParam = url.searchParams.get('repo') ?? '';
        const parsed = normalizeRepoInput(repoParam);
        if (!parsed) {
          return NextResponse.json({ error: 'Valid repo is required' }, { status: 400 });
        }
        const repo = repoSlug(parsed);
        const source = await store.getMarketSource(repo);
        const [releases, branches] = await Promise.all([
          listRepoReleases(repo),
          listRepoBranches(repo),
        ]);
        return NextResponse.json({
          ok: true,
          repo,
          ...(source?.ref ? { current: source.ref } : {}),
          releases,
          branches,
        } satisfies MarketSourceVersionsResponse);
      }

      case 'market/check': {
        const sources = await store.listMarketSources();
        const results: MarketCheckResponse['results'] = [];
        for (const s of sources) {
          try {
            const latestTag = await getLatestReleaseTag(s.repo);
            if (!s.ref) {
              results.push({
                repo: s.repo,
                updateAvailable: false,
                commitSha: s.commitSha ?? '',
                latestTag,
              });
              continue;
            }
            const latest = await getLatestCommit(s.repo, s.ref);
            const commitMoved = Boolean(s.commitSha && latest.commitSha !== s.commitSha);
            const newRelease = Boolean(latestTag && latestTag !== s.ref);
            results.push({
              repo: s.repo,
              ref: s.ref,
              updateAvailable: commitMoved || newRelease,
              commitSha: latest.commitSha,
              ...(newRelease ? { latestTag } : {}),
            });
          } catch (err) {
            results.push({
              repo: s.repo,
              ref: s.ref,
              updateAvailable: false,
              commitSha: s.commitSha ?? '',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return NextResponse.json({ ok: true, results } satisfies MarketCheckResponse);
      }

      case 'repo': {
        const repoParam = url.searchParams.get('repo') ?? '';
        const parsed = normalizeRepoInput(repoParam);
        if (!parsed) {
          return NextResponse.json({ error: 'Valid repo is required' }, { status: 400 });
        }
        const repo = repoSlug(parsed);
        let ref = parsed.ref;
        if (!ref) {
          const pinned = await store.getMarketSource(repo);
          if (pinned?.ref) ref = pinned.ref;
        }
        if (!ref) {
          const releaseTag = await getLatestReleaseTag(repo);
          if (releaseTag) {
            ref = releaseTag;
          } else {
            const branches = await listRepoBranches(repo);
            return NextResponse.json({
              ok: true,
              repo,
              ref: null,
              branches,
              entries: [],
            } satisfies RepoDiscoverResponse);
          }
        }
        const { ref: resolvedRef, tree, truncated } = await loadRepoTree(repo, ref);
        const catalog = await scanAllRoots({ cwd });
        const existingNames = new Set(catalog.skills.map((s) => s.name));
        for (const d of catalog.disabled) existingNames.add(d.name);

        const entries = discoverRepoEntries(tree, repo, existingNames);
        return NextResponse.json({
          ok: true,
          repo,
          ref: resolvedRef,
          entries,
          ...(truncated ? { truncated: true } : {}),
        } satisfies RepoDiscoverResponse);
      }

      case 'repo/import/progress': {
        const jobId = url.searchParams.get('jobId') ?? '';
        const job = getImportJob(jobId);
        if (!job) {
          return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        }
        const res: RepoImportProgressResponse = {
          ok: true,
          jobId: job.jobId,
          status: job.status,
          total: job.total,
          done: job.done,
          totalBytes: job.totalBytes,
          downloadedBytes: job.downloadedBytes,
          current: job.current,
          currentFile: job.currentFile,
          imported: job.imported,
          skipped: job.skipped,
          failed: job.failed,
        };
        return NextResponse.json(res);
      }

      case 'config': {
        const config = await store.getConfig();
        return NextResponse.json({ ok: true, pluginVersion: '1.0.0', config, saved: config });
      }

      case 'update': {
        return NextResponse.json({
          ok: true,
          currentVersion: '1.0.0',
          latestVersion: '1.0.0',
          updateAvailable: false,
          url: null,
        });
      }

      default:
        return NextResponse.json({ error: `Not found: ${path}` }, { status: 404 });
    }
  } catch (error) {
    console.error(`[api/skill-hub/${path} GET]`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof StoreError ? 400 : 500 }
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug?: string[] }> }
) {
  const { slug = [] } = await params;
  const path = slug.join('/');
  const store = getSkillHubStore();
  await store.ensureLoaded();

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Body might be empty for some endpoints
  }

  const cwd = typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : undefined;

  try {
    switch (path) {
      case 'toggle': {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const enabled = body.enabled === true;
        if (!name) {
          return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }
        const result = await toggleSkill(name, enabled, { cwd });
        void restartAllRpcSessions().catch(() => {});
        return NextResponse.json(result);
      }

      case 'toggle-batch': {
        const names = Array.isArray(body.names)
          ? body.names.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
          : [];
        const enabled = body.enabled === true;
        if (names.length === 0) {
          return NextResponse.json({ error: 'names must be non-empty array' }, { status: 400 });
        }
        const result = await toggleBatch(names, enabled, { cwd });
        void restartAllRpcSessions().catch(() => {});
        return NextResponse.json(result);
      }
      case 'create': {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        const root = (typeof body.root === 'string' ? body.root : 'user-agents') as WritableRoot;
        if (!name) {
          return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }
        const result = await createSkill(root, name, description, { cwd });
        return NextResponse.json(result);
      }

      case 'skill/delete': {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }
        const result = await deleteSkill(name, { cwd });
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        const catalog = await scanAllRoots({ cwd });
        return NextResponse.json({ ok: true, catalog });
      }

      case 'diagnostic/fix': {
        const filePath = typeof body.path === 'string' ? body.path.trim() : '';
        if (!filePath) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }
        const result = await fixDiagnostic(filePath);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        const catalog = await scanAllRoots({ cwd });
        return NextResponse.json({ ok: true, catalog });
      }

      case 'tag': {
        const id = typeof body.id === 'string' ? body.id.trim() : undefined;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const color = typeof body.color === 'string' ? body.color.trim() : undefined;
        const icon = typeof body.icon === 'string' ? body.icon.trim() : undefined;
        if (!name) {
          return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }
        const tag = await store.saveTag({ id, name, color, icon });
        return NextResponse.json({ ok: true, tag });
      }

      case 'tag/delete': {
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) {
          return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }
        await store.deleteTag(id);
        return NextResponse.json({ ok: true });
      }

      case 'tag/members': {
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        const skillNames = Array.isArray(body.skillNames)
          ? body.skillNames.filter((n): n is string => typeof n === 'string')
          : [];
        if (!id) {
          return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }
        const tag = await store.setTagSkills(id, skillNames);
        return NextResponse.json({ ok: true, tag });
      }

      case 'tag/reorder': {
        const orderedIds = Array.isArray(body.orderedIds)
          ? body.orderedIds.filter((id): id is string => typeof id === 'string')
          : [];
        const tags = await store.reorderTags(orderedIds);
        return NextResponse.json({ ok: true, tags });
      }

      case 'collections/reorder': {
        const orderedNames = Array.isArray(body.orderedNames)
          ? body.orderedNames.filter((n): n is string => typeof n === 'string')
          : [];
        const order = await store.setCollectionOrder(orderedNames);
        return NextResponse.json({ ok: true, collectionOrder: order });
      }

      case 'source-groups/reorder': {
        const orderedNames = Array.isArray(body.orderedNames)
          ? body.orderedNames.filter((n): n is string => typeof n === 'string')
          : [];
        const order = await store.setSourceGroupOrder(orderedNames);
        return NextResponse.json({ ok: true, sourceGroupOrder: order });
      }

      case 'market/source': {
        const input = typeof body.repo === 'string' ? body.repo.trim() : '';
        const parsed = normalizeRepoInput(input);
        if (!parsed) {
          return NextResponse.json({ error: 'Valid repo is required' }, { status: 400 });
        }
        const repos = await store.addMarketSource(repoSlug(parsed), parsed.ref);
        return NextResponse.json({ ok: true, repos });
      }

      case 'market/source/delete': {
        const input = typeof body.repo === 'string' ? body.repo.trim() : '';
        const parsed = normalizeRepoInput(input);
        if (!parsed) {
          return NextResponse.json({ error: 'Valid repo is required' }, { status: 400 });
        }
        const repos = await store.removeMarketSource(repoSlug(parsed));
        return NextResponse.json({ ok: true, repos });
      }

      case 'market/source/ref': {
        const input = typeof body.repo === 'string' ? body.repo.trim() : '';
        const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
        const parsed = normalizeRepoInput(input);
        if (!parsed || !ref) {
          return NextResponse.json({ error: 'repo and ref are required' }, { status: 400 });
        }
        const repo = repoSlug(parsed);
        const record = await store.setMarketSourceRef(repo, ref);
        if (!record) {
          return NextResponse.json({ error: 'Market source not found' }, { status: 404 });
        }
        const repos = await store.listMarketSources();
        return NextResponse.json({ ok: true, repos });
      }

      case 'market/source/sync': {
        const input = typeof body.repo === 'string' ? body.repo.trim() : '';
        const parsed = normalizeRepoInput(input);
        if (!parsed) {
          return NextResponse.json({ error: 'Valid repo is required' }, { status: 400 });
        }
        const repo = repoSlug(parsed);
        const source = await store.getMarketSource(repo);
        if (!source) {
          return NextResponse.json({ error: 'Market source not found' }, { status: 404 });
        }
        let ref = source.ref;
        if (!ref) {
          const latestTag = await getLatestReleaseTag(repo);
          if (!latestTag) {
            return NextResponse.json({ error: 'Repo has no release. Pick a branch first' }, { status: 409 });
          }
          ref = latestTag;
          await store.setMarketSourceRef(repo, ref);
        }
        const latest = await getLatestCommit(repo, ref);
        await store.setMarketSourceCommit(repo, latest.commitSha);
        await store.setSourceRef(repo, ref);
        const tracked = await store.getSource(repo);
        return NextResponse.json({
          ok: true,
          repo,
          ref,
          commitSha: latest.commitSha,
          skills: tracked ? [...tracked.skills] : [],
        });
      }

      case 'repo/import': {
        const repoInput = typeof body.repo === 'string' ? body.repo.trim() : '';
        const paths = Array.isArray(body.paths)
          ? body.paths.filter((p): p is string => typeof p === 'string')
          : [];
        const ref = typeof body.ref === 'string' ? body.ref.trim() : undefined;
        const targetRoot = (typeof body.root === 'string' ? body.root : 'user-agents') as WritableRoot;

        if (!repoInput || paths.length === 0) {
          return NextResponse.json({ error: 'repo and non-empty paths are required' }, { status: 400 });
        }

        const job = await startImportJob(
          { repo: repoInput, paths, ref },
          { targetRoot, cwd }
        );

        return NextResponse.json({
          ok: true,
          jobId: job.jobId,
          total: job.total,
          totalBytes: job.totalBytes,
        } satisfies RepoImportResponse);
      }

      case 'repo/import/cancel': {
        const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
        if (!jobId) {
          return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
        }
        const success = cancelImportJob(jobId);
        return NextResponse.json({
          ok: true,
          jobId,
          status: success ? 'cancelled' : 'done',
        } satisfies RepoImportCancelResponse);
      }

      case 'config': {
        const patch = body;
        const config = await store.updateConfig(patch);
        return NextResponse.json({ ok: true, config, saved: config });
      }

      case 'sources/check': {
        const repoInput = typeof body.repo === 'string' ? body.repo.trim() : '';
        let only: string | undefined;
        if (repoInput) {
          const parsed = normalizeRepoInput(repoInput);
          only = parsed ? repoSlug(parsed) : repoInput;
        }
        const sources = only
          ? [await store.getSource(only)].filter((s): s is NonNullable<typeof s> => Boolean(s))
          : await store.listSources();

        if (only && sources.length === 0) {
          return NextResponse.json({ error: `Source not found: ${only}` }, { status: 404 });
        }

        const results: SourceCheckResult[] = [];
        for (const item of sources) {
          const base = { repo: item.repo, ...(item.ref ? { ref: item.ref } : {}) };
          try {
            const latest = await getLatestCommit(item.repo, item.ref);
            if (!item.commitSha) {
              await store.setSourceCommit(item.repo, latest.commitSha);
              results.push({
                ...base,
                changed: false,
                updated: [],
                deleted: [],
                unverified: true,
                commitSha: latest.commitSha,
              });
              continue;
            }
            if (latest.commitSha === item.commitSha) {
              results.push({ ...base, changed: false, updated: [], deleted: [] });
              continue;
            }
            const tree = await loadRepoTreeAt(item.repo, latest.treeSha);
            const diff = diffRemoteSkills(tree, item);
            results.push({
              ...base,
              changed: true,
              commitSha: latest.commitSha,
              updated: diff.updated,
              deleted: diff.deleted,
            });
          } catch (err) {
            results.push({
              ...base,
              changed: false,
              updated: [],
              deleted: [],
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return NextResponse.json({ ok: true, results } satisfies SourceCheckResponse);
      }

      case 'sources/sync': {
        const repoInput = typeof body.repo === 'string' ? body.repo.trim() : '';
        if (!repoInput) {
          return NextResponse.json({ error: 'repo is required' }, { status: 400 });
        }
        const parsed = normalizeRepoInput(repoInput);
        const repo = parsed ? repoSlug(parsed) : repoInput;
        const source = await store.getSource(repo);
        if (!source) {
          return NextResponse.json({ error: `Source not found: ${repo}` }, { status: 404 });
        }
        const selected = Array.isArray(body.skills)
          ? body.skills.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
          : undefined;
        const targets = selected !== undefined ? selected : source.skills;
        const latest = await getLatestCommit(repo, source.ref);
        const tree = await loadRepoTreeAt(repo, latest.treeSha);
        const targetRoot = resolveRootPath('user-agents', { cwd });
        const synced: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];

        for (const name of targets) {
          if (!source.skills.includes(name)) {
            failed.push({ name, error: 'Skill is not tracked by this source' });
            continue;
          }
          try {
            const entry = repoSkillEntry(name, source.root, repo);
            entry.dir = skillDirOf(source, name, tree.map((i) => i.path));
            entry.path = entry.dir + '/SKILL.md';
            const files = collectRepoSkillFiles(tree, entry.dir);
            if (files.length === 0) {
              failed.push({ name, error: 'Skill missing upstream' });
              continue;
            }
            await downloadRepoSkill(repo, latest.commitSha, entry, files, targetRoot);
            await store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir);
            synced.push(name);
          } catch (err) {
            failed.push({ name, error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (failed.length === 0) {
          await store.setSourceCommit(repo, latest.commitSha);
        }

        return NextResponse.json({
          ok: true,
          repo,
          commitSha: latest.commitSha,
          synced,
          failed,
        } satisfies SourceSyncResponse);
      }

      case 'sources/delete': {
        const repoInput = typeof body.repo === 'string' ? body.repo.trim() : '';
        const parsed = normalizeRepoInput(repoInput);
        const repo = parsed ? repoSlug(parsed) : repoInput;
        const skills = Array.isArray(body.skills)
          ? body.skills.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
          : [];
        if (!repo) {
          return NextResponse.json({ error: 'repo is required' }, { status: 400 });
        }
        if (skills.length === 0) {
          return NextResponse.json({ error: 'skills must be non-empty array' }, { status: 400 });
        }
        const source = await store.getSource(repo);
        if (!source) {
          return NextResponse.json({ error: `Source not found: ${repo}` }, { status: 404 });
        }
        const trashed: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];

        for (const name of skills) {
          const res = await deleteSkill(name, { cwd });
          if (res.ok) {
            trashed.push(name);
          } else {
            failed.push({ name, error: res.error ?? 'Delete failed' });
          }
        }
        if (trashed.length > 0) {
          await store.setSourceSkills(repo, source.skills.filter((n) => !trashed.includes(n)));
        }
        return NextResponse.json({ ok: true, trashed, failed } satisfies SourceDeleteResponse);
      }

      case 'sources/restore': {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }
        const res = await restoreTrashSkill(name);
        if (!res.ok) {
          return NextResponse.json({ error: res.error ?? 'Restore failed' }, { status: 400 });
        }
        return NextResponse.json({ ok: true, name, path: res.path ?? '' } satisfies SourceRestoreResponse);
      }

      case 'sources/trash/clear': {
        const entries = await store.listTrash();
        const deleted: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];

        for (const entry of entries) {
          const res = await clearTrashSkill(entry);
          if (res.ok) {
            deleted.push(entry.name);
            await store.removeTrash(entry.name);
            await store.removeSkillFromTags(entry.name);
          } else {
            failed.push({ name: entry.name, error: res.error ?? 'Failed to delete' });
          }
        }
        return NextResponse.json({ ok: true, deleted, failed } satisfies SourceTrashClearResponse);
      }

      default:
        return NextResponse.json({ error: `Not found: ${path}` }, { status: 404 });
    }
  } catch (error) {
    console.error(`[api/skill-hub/${path} POST]`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof StoreError ? 400 : 500 }
    );
  }
}
