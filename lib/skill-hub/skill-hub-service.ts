/**
 * Skill filesystem and service operations for the Skill Hub ("技能中枢").
 * Scans user and project skill roots, parses SKILL.md, detects disabled states,
 * supports toggle (via .disabled rename + store checkpoint), scaffolding, and trash.
 */

import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getAgentDir } from '@/lib/omp/paths';
import { loadProjectRegistry } from '@/lib/project-registry';
import { comparableProjectPath } from '@/lib/comparable-path';
import { setDisableModelInvocation } from '@/lib/skills-service';
import {
  parseFrontmatter,
  repairFrontmatterFileText,
} from './skill-hub-diagnostics';
import {
  getSkillHubStore,
  StoreError,
} from './skill-hub-store';
import type {
  CatalogResponse,
  CatalogSkill,
  CreateResponse,
  DiagnosticEntry,
  DisabledSkill,
  HubInvocation,
  SkillDetail,
  ToggleBatchResponse,
  ToggleResponse,
  TrashEntry,
  WritableRoot,
} from './protocol';

export const WRITABLE_ROOTS: readonly WritableRoot[] = [
  'user-agents',
  'user-omp',
  'user-dsh',
  'user-codex',
  'project-agents',
  'project-omp',
];

/** OMP discovery precedence for the hub's roots (highest first): .omp
 *  (project copies via walk-up, then user), then .agents (project walk-up,
 *  then user), then the user compat dirs. Mirrors the scan order of
 *  buildScanRoots in lib/skills-service.ts for the roots the hub covers. */
const PRIORITY_ROOT_ORDER: readonly WritableRoot[] = [
  'project-omp',
  'user-omp',
  'project-agents',
  'user-agents',
  'user-dsh',
];

export function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 80;
}

/** Resolve the absolute directory for a given root. */
export function resolveRootPath(
  root: WritableRoot,
  options?: { cwd?: string; home?: string }
): string {
  const home = options?.home ?? homedir();
  const cwd = options?.cwd;
  switch (root) {
    case 'user-agents': {
      const agentsHome = process.env.AGENTS_HOME ?? join(home, '.agents');
      return join(agentsHome, 'skills');
    }
    case 'user-omp': {
      return join(getAgentDir(), 'skills');
    }
    case 'user-dsh': {
      return join(home, '.dsh', 'skills');
    }
    case 'user-codex': {
      return join(home, '.codex', 'skills');
    }
    case 'project-agents': {
      if (!cwd) return join(home, '.agents', 'skills');
      return join(resolve(cwd), '.agents', 'skills');
    }
    case 'project-omp': {
      if (!cwd) return join(getAgentDir(), 'skills');
      return join(resolve(cwd), '.omp', 'skills');
    }
    default:
      throw new TypeError(`Unknown root: ${String(root)}`);
  }
}

/** Determine which root owns a given file path. */
export function detectRootOfPath(
  filePath: string,
  options?: { cwd?: string; home?: string }
): WritableRoot | undefined {
  const normPath = resolve(filePath);
  for (const root of WRITABLE_ROOTS) {
    try {
      const base = resolve(resolveRootPath(root, options));
      if (process.platform === 'win32') {
        const n = normPath.toLowerCase();
        const b = base.toLowerCase();
        if (n === b || n.startsWith(b + '\\') || n.startsWith(b + '/')) return root;
      } else {
        if (normPath === base || normPath.startsWith(base + sep)) return root;
      }
    } catch {
      // Ignore root resolve errors
    }
  }
  return undefined;
}

export const rootOfPath = detectRootOfPath;

/** Scanned skill entry on disk */
export interface ScannedSkillEntry {
  name: string;
  discoveryPath: string; // SKILL.md or <name>.md (or .disabled)
  directory: string;
  kind: 'directory' | 'flat';
  isDisabledFile: boolean;
  root: WritableRoot;
  addedAt?: number;
  updatedAt?: number;
  /** Workspace path the entry was scanned from (project roots only). */
  workspace?: string;
  /** Optional display title for the workspace (registry alias). */
  workspaceTitle?: string;
}

/** Scan a directory for skill bundles or flat files */
export async function scanDirectoryForSkills(
  dirPath: string,
  root: WritableRoot
): Promise<ScannedSkillEntry[]> {
  const entries: ScannedSkillEntry[] = [];
  let dirItems: string[];
  try {
    dirItems = await fs.readdir(dirPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return entries;
    throw err;
  }

  for (const item of dirItems) {
    if (item.startsWith('.')) continue; // ignore .trash, .git, etc.
    const fullItemPath = join(dirPath, item);
    let st;
    try {
      st = await fs.stat(fullItemPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      // Check for SKILL.md or SKILL.md.disabled
      const skillMd = join(fullItemPath, 'SKILL.md');
      const skillMdDisabled = join(fullItemPath, 'SKILL.md.disabled');
      if (existsSync(skillMd)) {
        let birthtime = st.birthtimeMs;
        let mtime = st.mtimeMs;
        try {
          const fileSt = await fs.stat(skillMd);
          birthtime = fileSt.birthtimeMs || st.birthtimeMs;
          mtime = fileSt.mtimeMs || st.mtimeMs;
        } catch {}
        entries.push({
          name: item,
          discoveryPath: skillMd,
          directory: fullItemPath,
          kind: 'directory',
          isDisabledFile: false,
          root,
          addedAt: birthtime,
          updatedAt: mtime,
        });
      } else if (existsSync(skillMdDisabled)) {
        let birthtime = st.birthtimeMs;
        let mtime = st.mtimeMs;
        try {
          const fileSt = await fs.stat(skillMdDisabled);
          birthtime = fileSt.birthtimeMs || st.birthtimeMs;
          mtime = fileSt.mtimeMs || st.mtimeMs;
        } catch {}
        entries.push({
          name: item,
          discoveryPath: skillMdDisabled,
          directory: fullItemPath,
          kind: 'directory',
          isDisabledFile: true,
          root,
          addedAt: birthtime,
          updatedAt: mtime,
        });
      }
    } else if (item.endsWith('.md')) {
      const skillName = basename(item, '.md');
      entries.push({
        name: skillName,
        discoveryPath: fullItemPath,
        directory: dirPath,
        kind: 'flat',
        isDisabledFile: false,
        root,
        addedAt: st.birthtimeMs,
        updatedAt: st.mtimeMs,
      });
    } else if (item.endsWith('.md.disabled')) {
      const skillName = basename(item, '.md.disabled');
      entries.push({
        name: skillName,
        discoveryPath: fullItemPath,
        directory: dirPath,
        kind: 'flat',
        isDisabledFile: true,
        root,
        addedAt: st.birthtimeMs,
        updatedAt: st.mtimeMs,
      });
    }
  }

  return entries;
}

/** Read UI metadata from `agents/openai.yaml` beside a directory skill. */
export async function readSkillInterface(directory: string): Promise<{
  displayName?: string;
  shortDescription?: string;
  brandColor?: string;
  iconSmall?: string;
  iconLarge?: string;
  defaultPrompt?: string;
} | undefined> {
  const yamlPath = join(directory, 'agents', 'openai.yaml');
  let text: string;
  try {
    text = await fs.readFile(yamlPath, 'utf8');
  } catch {
    return undefined;
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const iface = (record.interface ?? record) as Record<string, unknown>;
  const ifaceObj =
    typeof record.interface === 'object' && record.interface !== null && !Array.isArray(record.interface)
      ? (record.interface as Record<string, unknown>)
      : iface;

  const cleanStr = (value: unknown, maxLen: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const cleaned = value.split(/\s+/).join(' ').trim();
    if (cleaned === '' || cleaned.length > maxLen) return undefined;
    return cleaned;
  };
  const hexColor = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : undefined;
  };
  const iconPath = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const trimmed = value.trim().replace(/\\/g, '/');
    if (trimmed.startsWith('/') || trimmed.includes('..')) return undefined;
    if (!trimmed.startsWith('assets/')) return undefined;
    return trimmed;
  };

  const displayName = cleanStr(ifaceObj.display_name, 64);
  const shortDescription = cleanStr(ifaceObj.short_description, 1024);
  const brandColor = hexColor(ifaceObj.brand_color);
  const defaultPrompt = cleanStr(ifaceObj.default_prompt, 1024);
  const iconSmall = iconPath(ifaceObj.icon_small);
  const iconLarge = iconPath(ifaceObj.icon_large);

  const hasAny =
    displayName !== undefined ||
    shortDescription !== undefined ||
    brandColor !== undefined ||
    iconSmall !== undefined ||
    iconLarge !== undefined ||
    defaultPrompt !== undefined;
  if (!hasAny) return undefined;

  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(shortDescription !== undefined ? { shortDescription } : {}),
    ...(brandColor !== undefined ? { brandColor } : {}),
    ...(iconSmall !== undefined ? { iconSmall } : {}),
    ...(iconLarge !== undefined ? { iconLarge } : {}),
    ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
  };
}

/**
 * Every workspace whose project skill roots should be scanned: the explicit
 * cwd plus all non-hidden registered projects (de-duplicated by comparable
 * path). Returns absolute path + optional registry alias for display.
 */
function listWorkspaceCwds(options?: { cwd?: string }): Array<{ path: string; title?: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; title?: string }> = [];
  const push = (path: string, title?: string): void => {
    if (!path) return;
    const abs = resolve(path);
    const key = comparableProjectPath(abs);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: abs, ...(title ? { title } : {}) });
  };
  if (options?.cwd) push(options.cwd);
  try {
    const registry = loadProjectRegistry();
    for (const project of registry.projects) {
      if (project.hidden) continue;
      push(project.path, project.alias);
    }
  } catch {
    // Registry unreadable — fall back to the explicit cwd only
  }
  return out;
}

/**
 * Scan all skill roots and construct the unified CatalogResponse.
 */
export async function scanAllRoots(options?: { cwd?: string }): Promise<CatalogResponse> {
  const store = getSkillHubStore();
  await store.ensureLoaded();

  const disabledFromStore = await store.listDisabled();
  const disabledMap = new Map<string, DisabledSkill>();
  for (const d of disabledFromStore) {
    disabledMap.set(d.name, d);
  }
  const rootsToScan: WritableRoot[] = ['user-agents', 'user-omp', 'user-dsh', 'user-codex', 'project-agents', 'project-omp'];
  const allScanned: ScannedSkillEntry[] = [];
  for (const root of rootsToScan) {
    if (root === 'project-agents' || root === 'project-omp') {
      // Project roots are scanned for every known workspace (the explicit cwd
      // plus all non-hidden registered projects) so the "Project" section can
      // show all workspaces at once. Each row carries its workspace for grouping.
      for (const ws of listWorkspaceCwds(options)) {
        try {
          const rootDir = resolveRootPath(root, { cwd: ws.path });
          if (existsSync(rootDir)) {
            const found = await scanDirectoryForSkills(rootDir, root);
            allScanned.push(...found.map((e) => ({ ...e, workspace: ws.path, workspaceTitle: ws.title })));
          }
        } catch {
          // Root might not exist, proceed silently
        }
      }
    } else {
      try {
        const rootDir = resolveRootPath(root, options);
        if (existsSync(rootDir)) {
          allScanned.push(...(await scanDirectoryForSkills(rootDir, root)));
        }
      } catch {
        // Root might not exist, proceed silently
      }
    }
  }

  const skills: CatalogSkill[] = [];
  const disabledList: DisabledSkill[] = [];
  const diagnostics: DiagnosticEntry[] = [];
  const nameOccurrences = new Map<string, number>();

  for (const entry of allScanned) {
    nameOccurrences.set(entry.name, (nameOccurrences.get(entry.name) ?? 0) + 1);

    let content = '';
    try {
      content = await fs.readFile(entry.discoveryPath, 'utf8');
    } catch (readErr) {
      diagnostics.push({
        path: entry.discoveryPath,
        root: entry.root,
        reason: `Cannot read file: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
      });
      continue;
    }

    const parsed = parseFrontmatter(content);
    let fmName = entry.name;
    let description = '';
    let whenToUse: string | undefined;
    let invocation: HubInvocation = { modelInvocable: true, userInvocable: true };

    if ('error' in parsed) {
      const fixable = repairFrontmatterFileText(content) !== null;
      diagnostics.push({
        path: entry.discoveryPath,
        root: entry.root,
        reason: parsed.error,
        fixable,
      });
    } else {
      const { value } = parsed;
      fmName = value.name;
      description = value.description;
      whenToUse = value.whenToUse;
      invocation = value.invocation;

      const repaired = repairFrontmatterFileText(content);
      if (repaired !== null) {
        diagnostics.push({
          path: entry.discoveryPath,
          root: entry.root,
          reason: 'frontmatter contains unquoted colon/bracket (auto-repaired in memory; click Fix to persist)',
          fixable: true,
        });
      }

      if (description && description.length < 10) {
        diagnostics.push({
          path: entry.discoveryPath,
          root: entry.root,
          reason: `description is only ${description.length} chars; write a one-line description so agents can auto-activate this skill`,
        });
      }
    }

    // Disabled check
    const isPhysicalDisabled = entry.isDisabledFile;
    const isStoreDisabled = disabledMap.has(entry.name);
    const isDisabled = isPhysicalDisabled || isStoreDisabled || !invocation.modelInvocable;

    if (isDisabled) {
      const existing = disabledMap.get(entry.name);
      disabledList.push({
        name: entry.name,
        description: description || existing?.description || '',
        path: entry.discoveryPath,
        root: entry.root,
        disabledAt: existing?.disabledAt ?? entry.updatedAt ?? Date.now(),
      });
      continue;
    }

    // Read UI metadata if bundle
    let uiMeta;
    if (entry.kind === 'directory') {
      try {
        uiMeta = await readSkillInterface(entry.directory);
      } catch {}
    }

    // Keep every occurrence (duplicates across roots/workspaces are all shown).
    skills.push({
      name: entry.name,
      description: description || fmName,
      whenToUse,
      invocation,
      provider: 'filesystem',
      writable: true,
      source: entry.root,
      addedAt: entry.addedAt,
      updatedAt: entry.updatedAt,
      workspace: entry.workspace,
      workspaceTitle: entry.workspaceTitle,
      ...uiMeta,
    });
  }

  // Include any store-disabled skills that might not have been found on disk
  for (const [name, disabledItem] of disabledMap.entries()) {
    if (!disabledList.some((d) => d.name === name) && !skills.some((s) => s.name === name)) {
      disabledList.push(disabledItem);
    }
  }

  const duplicateNames = [...nameOccurrences.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  // Tag the enabled copy OMP actually loads for each duplicated name: the
  // highest-precedence root wins, project copies beat user copies, and among
  // project copies the active workspace's own copy beats other workspaces.
  const rootRank = (s: CatalogSkill): number => {
    const base = PRIORITY_ROOT_ORDER.indexOf(s.source as WritableRoot);
    if (base === -1) return PRIORITY_ROOT_ORDER.length * 2;
    const isProject = s.source === 'project-omp' || s.source === 'project-agents';
    const otherWorkspace = isProject && options?.cwd !== undefined && s.workspace !== undefined && resolve(s.workspace) !== resolve(options.cwd) ? 1 : 0;
    return base * 2 + otherWorkspace;
  };
  for (const name of duplicateNames) {
    const copies = skills.filter((s) => s.name === name);
    if (copies.length === 0) continue;
    const winner = copies.reduce((best, s) => (rootRank(s) < rootRank(best) ? s : best), copies[0]);
    winner.priority = true;
  }

  return {
    ok: true,
    pluginVersion: '1.0.0',
    complete: true,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name) || (a.workspace ?? '').localeCompare(b.workspace ?? '')),
    disabled: disabledList.sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
    duplicateNames,
  };
}

/**
 * Get detailed view of a skill by name.
 */
export async function getSkillDetail(
  name: string,
  options?: { cwd?: string }
): Promise<SkillDetail | undefined> {
  const catalog = await scanAllRoots(options);
  const enabledItem = catalog.skills.find((s) => s.name === name);
  const disabledItem = catalog.disabled.find((s) => s.name === name);

  if (!enabledItem && !disabledItem) return undefined;

  const isEnabled = enabledItem !== undefined;
  const source = enabledItem?.source ?? disabledItem?.root ?? 'user-agents';
  const root = source as WritableRoot;

  // Locate the file on disk
  let targetPath = disabledItem?.path;
  let dirPath = '';

  if (!targetPath) {
    const rootDir = resolveRootPath(root, options);
    const candidateDir = join(rootDir, name);
    const candidateFile = join(candidateDir, 'SKILL.md');
    const candidateFlat = join(rootDir, `${name}.md`);
    if (existsSync(candidateFile)) {
      targetPath = candidateFile;
      dirPath = candidateDir;
    } else if (existsSync(candidateFlat)) {
      targetPath = candidateFlat;
      dirPath = rootDir;
    }
  } else {
    dirPath = dirname(targetPath);
  }

  let content = '';
  if (targetPath && existsSync(targetPath)) {
    try {
      content = await fs.readFile(targetPath, 'utf8');
    } catch {}
  }

  const parsed = parseFrontmatter(content);
  const body = 'value' in parsed ? parsed.value.content : content;
  const diag = catalog.diagnostics.find((d) => d.path === targetPath);

  let uiMeta;
  if (dirPath && existsSync(dirPath)) {
    try {
      uiMeta = await readSkillInterface(dirPath);
    } catch {}
  }

  return {
    name,
    description: enabledItem?.description ?? disabledItem?.description ?? '',
    whenToUse: enabledItem?.whenToUse,
    invocation: enabledItem?.invocation ?? { modelInvocable: true, userInvocable: true },
    content: body || content,
    path: targetPath,
    provider: 'filesystem',
    enabled: isEnabled,
    source,
    addedAt: enabledItem?.addedAt,
    updatedAt: enabledItem?.updatedAt ?? disabledItem?.disabledAt,
    diagnostic: diag?.reason,
    fixable: diag?.fixable,
    ...uiMeta,
  };
}

/**
 * Toggle a skill enabled/disabled.
 * Implements dsh-skill-hub rename pattern + store tracking.
 */
export async function toggleSkill(
  name: string,
  enabled: boolean,
  options?: { cwd?: string }
): Promise<ToggleResponse> {
  const store = getSkillHubStore();
  await store.ensureLoaded();

  const rootsToScan: WritableRoot[] = ['user-agents', 'user-omp', 'user-dsh', 'user-codex'];
  if (options?.cwd) {
    rootsToScan.push('project-agents', 'project-omp');
  }

  let targetPath: string | undefined;
  let targetRoot: WritableRoot = 'user-agents';
  let description = '';

  // 1. Check if tracked in store
  const disabledEntry = await store.getDisabled(name);
  if (disabledEntry) {
    if (existsSync(disabledEntry.path)) {
      targetPath = disabledEntry.path;
      targetRoot = disabledEntry.root;
      description = disabledEntry.description;
    } else if (disabledEntry.path.endsWith('.disabled') && existsSync(disabledEntry.path.slice(0, -'.disabled'.length))) {
      targetPath = disabledEntry.path.slice(0, -'.disabled'.length);
      targetRoot = disabledEntry.root;
      description = disabledEntry.description;
    } else if (!disabledEntry.path.endsWith('.disabled') && existsSync(disabledEntry.path + '.disabled')) {
      targetPath = disabledEntry.path + '.disabled';
      targetRoot = disabledEntry.root;
      description = disabledEntry.description;
    }
  }

  // 2. Search on disk if not found or if enabling
  if (!targetPath) {
    for (const r of rootsToScan) {
      try {
        const rootDir = resolveRootPath(r, options);
        const dirCandidate = join(rootDir, name);
        const skillMd = join(dirCandidate, 'SKILL.md');
        const skillMdDis = join(dirCandidate, 'SKILL.md.disabled');
        const flatMd = join(rootDir, `${name}.md`);
        const flatMdDis = join(rootDir, `${name}.md.disabled`);

        if (enabled) {
          if (existsSync(skillMdDis)) {
            targetPath = skillMdDis;
            targetRoot = r;
            break;
          }
          if (existsSync(flatMdDis)) {
            targetPath = flatMdDis;
            targetRoot = r;
            break;
          }
          if (existsSync(skillMd)) {
            targetPath = skillMd;
            targetRoot = r;
            break;
          }
          if (existsSync(flatMd)) {
            targetPath = flatMd;
            targetRoot = r;
            break;
          }
        } else {
          if (existsSync(skillMd)) {
            targetPath = skillMd;
            targetRoot = r;
            break;
          }
          if (existsSync(flatMd)) {
            targetPath = flatMd;
            targetRoot = r;
            break;
          }
          if (existsSync(skillMdDis)) {
            targetPath = skillMdDis;
            targetRoot = r;
            break;
          }
          if (existsSync(flatMdDis)) {
            targetPath = flatMdDis;
            targetRoot = r;
            break;
          }
        }
      } catch {}
    }
  }

  if (!targetPath || !existsSync(targetPath)) {
    throw new StoreError('not-found', `Skill file not found on disk for "${name}"`);
  }

  // Read description if empty
  if (!description) {
    try {
      const text = await fs.readFile(targetPath, 'utf8');
      const parsed = parseFrontmatter(text);
      if ('value' in parsed) {
        description = parsed.value.description;
      }
    } catch {}
  }

  if (enabled) {
    // 1. If physical filename ends with .disabled, rename back to active
    if (targetPath.endsWith('.disabled')) {
      const activePath = targetPath.slice(0, -'.disabled'.length);
      await fs.rename(targetPath, activePath);
      targetPath = activePath;
    }

    // 2. Surgically strip disable-model-invocation / disableModelInvocation / hide from frontmatter
    if (existsSync(targetPath)) {
      try {
        const text = await fs.readFile(targetPath, 'utf8');
        const updated = setDisableModelInvocation(text, false);
        if (updated !== text) {
          await fs.writeFile(targetPath, updated, 'utf8');
        }
      } catch (err) {
        console.warn(`[skill-hub] failed to update frontmatter when enabling ${name}:`, err);
      }
    }

    // 3. Clear from store
    await store.setDisabled(name, false);
  } else {
    // 1. Surgically add disable-model-invocation: true to frontmatter
    if (existsSync(targetPath)) {
      try {
        const text = await fs.readFile(targetPath, 'utf8');
        const updated = setDisableModelInvocation(text, true);
        if (updated !== text) {
          await fs.writeFile(targetPath, updated, 'utf8');
        }
      } catch (err) {
        console.warn(`[skill-hub] failed to update frontmatter when disabling ${name}:`, err);
      }
    }

    // 2. Rename to .disabled if not already
    let disabledPath = targetPath;
    if (!targetPath.endsWith('.disabled')) {
      disabledPath = targetPath + '.disabled';
      await fs.rename(targetPath, disabledPath);
    }

    // 3. Record in store
    await store.setDisabled(name, true, disabledPath, targetRoot, description);
  }

  const catalog = await scanAllRoots(options);
  return {
    ok: true,
    catalog,
  };
}

/**
 * Toggle a batch of skills at once.
 */
export async function toggleBatch(
  names: string[],
  enabled: boolean,
  options?: { cwd?: string }
): Promise<ToggleBatchResponse> {
  const failures: { name: string; error: string }[] = [];

  for (const name of names) {
    try {
      await toggleSkill(name, enabled, options);
    } catch (err) {
      failures.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const catalog = await scanAllRoots(options);
  return {
    ok: true,
    catalog,
    failures,
  };
}

/**
 * Create a new directory-bundle skill with compliant frontmatter.
 */
export async function createSkill(
  root: WritableRoot,
  name: string,
  description: string,
  options?: { cwd?: string }
): Promise<CreateResponse> {
  if (!isSkillName(name)) {
    throw new StoreError(
      'validation',
      `Skill name must be kebab-case (lowercase letters, numbers, hyphens): "${name}"`
    );
  }

  const baseDir = resolveRootPath(root, options);
  const skillDir = join(baseDir, name);
  const skillFile = join(skillDir, 'SKILL.md');

  if (existsSync(skillDir) || existsSync(skillFile)) {
    throw new StoreError('conflict', `Skill "${name}" already exists in ${root}`);
  }

  await fs.mkdir(skillDir, { recursive: true });

  const safeDesc = description.trim() || `Skill created from omp-web Skill Hub`;
  const template = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(safeDesc)}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Describe what this skill does, when the agent should use it, and what output is expected.',
    '',
  ].join('\n');

  await fs.writeFile(skillFile, template, 'utf8');

  return {
    ok: true,
    path: skillFile,
    root,
  };
}

/**
 * Move a skill to trash.
 */
export async function deleteSkill(
  name: string,
  options?: { cwd?: string }
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const store = getSkillHubStore();
  await store.ensureLoaded();

  const rootsToScan: WritableRoot[] = ['user-agents', 'user-omp', 'user-dsh', 'user-codex'];
  if (options?.cwd) rootsToScan.push('project-agents', 'project-omp');

  let sourcePath: string | undefined;

  for (const r of rootsToScan) {
    try {
      const rootDir = resolveRootPath(r, options);
      const dirCandidate = join(rootDir, name);
      const skillMd = join(dirCandidate, 'SKILL.md');
      const skillMdDis = join(dirCandidate, 'SKILL.md.disabled');
      const flatMd = join(rootDir, `${name}.md`);
      const flatMdDis = join(rootDir, `${name}.md.disabled`);

      if (existsSync(skillMd) || existsSync(skillMdDis)) {
        sourcePath = dirCandidate;
        break;
      }
      if (existsSync(flatMd)) {
        sourcePath = flatMd;
        break;
      }
      if (existsSync(flatMdDis)) {
        sourcePath = flatMdDis;
        break;
      }
    } catch {}
  }

  if (!sourcePath || !existsSync(sourcePath)) {
    return { ok: false, error: `Skill "${name}" not found` };
  }

  const trashDir = join(dirname(sourcePath), '.trash');
  await fs.mkdir(trashDir, { recursive: true });
  const target = join(trashDir, `${basename(sourcePath)}-${Date.now()}`);
  await fs.rename(sourcePath, target);

  // Record in store trash
  await store.addTrash({
    name,
    path: target,
    movedAt: Date.now(),
    sourcePath,
  });

  // If in disabled list, remove
  await store.setDisabled(name, false);

  return { ok: true, path: target };
}

/**
 * Fix diagnostic frontmatter errors in place.
 */
export async function fixDiagnostic(
  filePath: string
): Promise<{ ok: boolean; path: string; error?: string }> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const repaired = repairFrontmatterFileText(text);
    if (!repaired) {
      return { ok: false, path: filePath, error: 'File is not auto-fixable' };
    }
    await fs.writeFile(filePath, repaired, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Restore a trashed skill to its original location.
 */
export async function restoreTrashSkill(
  name: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const store = getSkillHubStore();
  await store.ensureLoaded();
  const entry = await store.getTrash(name);
  if (!entry) {
    return { ok: false, error: `Trash entry not found: ${name}` };
  }
  const target = entry.sourcePath ?? join(dirname(dirname(entry.path)), entry.name);
  if (existsSync(target)) {
    return { ok: false, error: `Destination already exists: ${target}` };
  }
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.rename(entry.path, target);

  if (entry.origin) {
    await store.addSourceSkill(
      entry.origin.repo,
      entry.origin.root,
      entry.origin.commitSha,
      entry.origin.ref,
      name
    );
  }
  for (const tagId of entry.tagIds ?? []) {
    await store.addSkillToTag(tagId, name);
  }
  await store.removeTrash(name);
  return { ok: true, path: target };
}

/**
 * Permanently delete one trashed skill directory/file.
 */
export async function clearTrashSkill(
  entry: TrashEntry
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (existsSync(entry.path)) {
      await fs.rm(entry.path, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

