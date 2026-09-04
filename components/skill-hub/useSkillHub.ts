/**
 * useSkillHub — the panel's state owner.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  CatalogResponse,
  CatalogSkill,
  DisabledSkill,
  GroupsResponse,
  HubConfig,
  MarketCheckResponse,
  MarketSourceRecord,
  RepoDiscoverResponse,
  RepoImportProgressResponse,
  SkillDetail,
  SkillTag,
  SourceCheckResult,
  SourcesResponse,
  UpdateCheckResponse,
  WritableRoot,
} from '@/lib/skill-hub/protocol'
import type { SkillHubApi } from './api'
import { errorMessage, tt } from './helpers'
import { conflictsOnClose, isProjectSource, PRIVATE_SOURCE, sortSkills, type SortKey, type GroupSwitchState } from './grouping'
import type { BranchChoiceState, ConfirmDialogState, ConflictDialogState, MarketSyncDialogState, VersionChoiceState } from './dialogs'

const POLL_MS = 5000
const SLOW_POLL_MS = 60_000

const AUTO_CHECK_KEY = 'skill-hub.last-auto-check'
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60_000

function shouldAutoCheck(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_CHECK_KEY)
    const last = raw === null ? NaN : Number(raw)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= AUTO_CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

function markAutoChecked(): void {
  try {
    localStorage.setItem(AUTO_CHECK_KEY, String(Date.now()))
  } catch {
    // Ignore in sandbox/private browsing
  }
}

type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; data: UpdateCheckResponse }
  | { status: 'error'; message: string }

type RepoDiscoverState =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'ready'; data: RepoDiscoverResponse }
  | { status: 'error'; message: string }

type MarketState = { status: 'loading' | 'ready' | 'error'; repos: MarketSourceRecord[] }
type MarketCheckResult = MarketCheckResponse['results'][number]

export type SkillHubState = ReturnType<typeof useSkillHub>

export function useSkillHub(api: SkillHubApi, initialWorkspace?: string) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [successBanner, setSuccessBanner] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [repoDiscoverState, setRepoDiscoverState] = useState<RepoDiscoverState>({ status: 'idle' })
  const [scanningRepo, setScanningRepo] = useState<string | null>(null)
  const [repoSelected, setRepoSelected] = useState<ReadonlySet<string>>(new Set())
  const [repoImporting, setRepoImporting] = useState(false)
  const [repoResult, setRepoResult] = useState<RepoImportProgressResponse | null>(null)
  const [importJobId, setImportJobId] = useState<string | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  const [search, setSearch] = useState('')
  const [workspace, setWorkspace] = useState(initialWorkspace ?? '')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  // Default to user-agents (C:\Users\zhang\.agents\skills)
  const [formRoot, setFormRoot] = useState<WritableRoot>('user-agents')
  const [formBusy, setFormBusy] = useState(false)
  const [formMessage, setFormMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [uses, setUses] = useState<ReadonlyMap<string, { count: number; lastUsed?: number }>>(new Map())
  const [hubConfig, setHubConfig] = useState<HubConfig | null>(null)
  const [tab, setTab] = useState<'sources' | 'scenes' | 'market'>('sources')
  const [skillView, setSkillView] = useState<'flat' | 'groups'>('groups')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [invocationFilter, setInvocationFilter] = useState<'all' | 'model' | 'user'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [marketState, setMarketState] = useState<MarketState>({ status: 'loading', repos: [] })
  const [marketCheck, setMarketCheck] = useState<Readonly<Record<string, MarketCheckResult>>>({})
  const [branchChoice, setBranchChoice] = useState<BranchChoiceState | null>(null)
  const [branchBusy, setBranchBusy] = useState(false)
  const [marketSyncDialog, setMarketSyncDialog] = useState<MarketSyncDialogState | null>(null)
  const [syncingMarket, setSyncingMarket] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [newSourceName, setNewSourceName] = useState('')
  const [groupsState, setGroupsState] = useState<GroupsResponse | null>(null)
  const [sourcesState, setSourcesState] = useState<SourcesResponse | null>(null)
  const [sourceCheck, setSourceCheck] = useState<Readonly<Record<string, SourceCheckResult>>>({})
  const [checkingSource, setCheckingSource] = useState<string | null>(null)
  const [syncingSource, setSyncingSource] = useState<string | null>(null)
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [deleteSkillDialog, setDeleteSkillDialog] = useState<string | null>(null)
  const [deleteGroupDialog, setDeleteGroupDialog] = useState<{ name: string; skillNames: string[] } | null>(null)
  const [confirmClearTrash, setConfirmClearTrash] = useState(false)
  const [updateAllDialog, setUpdateAllDialog] = useState(false)
  const [editingTag, setEditingTag] = useState<SkillTag | null>(null)
  const [editName, setEditName] = useState('')
  const [membersDraft, setMembersDraft] = useState<ReadonlySet<string>>(new Set())
  const [newTagName, setNewTagName] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [editSearch, setEditSearch] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())
  const autoCollapsedPersonal = useRef(false)
  const [subdividedProjects, setSubdividedProjects] = useState<ReadonlySet<string>>(new Set())
  const [showLegend, setShowLegend] = useState(false)
  const [editMode, setEditMode] = useState(false)

  const toggleGroupCollapse = useCallback((key: string): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleSubdivide = useCallback((key: string): void => {
    setSubdividedProjects((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.catalog(workspace !== '' ? { cwd: workspace } : undefined)
      setCatalog(next)
      if (!autoCollapsedPersonal.current && next.skills.length + next.disabled.length > 80) {
        autoCollapsedPersonal.current = true
        setCollapsedGroups((previous) => new Set(previous).add('uncategorized-source'))
      }
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [api, workspace])

  const loadUses = useCallback(async (): Promise<void> => {
    try {
      const result = await api.stats()
      if (result.available) setUses(new Map(result.stats.map((stat) => [stat.name, { count: stat.count, ...(stat.lastUsed !== undefined ? { lastUsed: stat.lastUsed } : {}) }])))
    } catch {
      // stats failure is non-fatal
    }
  }, [api])

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      setHubConfig((await api.config()).config)
    } catch {
      // config failure falls back to default
    }
  }, [api])

  const checkUpdate = useCallback(async (): Promise<void> => {
    setUpdateState({ status: 'checking' })
    try {
      setUpdateState({ status: 'ready', data: await api.updateCheck() })
    } catch (error) {
      setUpdateState({ status: 'error', message: errorMessage(error) })
    }
  }, [api])

  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      setGroupsState(await api.groups())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  const loadSources = useCallback(async (): Promise<void> => {
    try {
      setSourcesState(await api.sources())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  const loadMarket = useCallback(async (): Promise<void> => {
    try {
      const next = await api.market()
      setMarketState({ status: 'ready', repos: next.repos })
    } catch (error) {
      setMarketState({ status: 'error', repos: [] })
      setLoadError(errorMessage(error))
    }
  }, [api])

  const applyTags = useCallback((tags: SkillTag[]): void => {
    setGroupsState((previous) => previous === null
      ? { ok: true, tags, collections: [], origins: {} }
      : { ...previous, tags })
  }, [])

  useEffect(() => {
    void load()
    void loadUses()
    void loadGroups()
    void loadSources()
    void loadConfig()
    const fast = window.setInterval(() => { void load() }, POLL_MS)
    const slow = window.setInterval(() => { void loadUses(); void loadGroups(); void loadSources(); void loadConfig() }, SLOW_POLL_MS)
    return () => { window.clearInterval(fast); window.clearInterval(slow) }
  }, [load, loadUses, loadGroups, loadSources, loadConfig])

  const openDetail = useCallback(async (name: string): Promise<void> => {
    setDetailLoading(true)
    setLoadError(null)
    try {
      setDetail(await api.skill(name, workspace !== '' ? { cwd: workspace } : undefined))
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setDetailLoading(false)
    }
  }, [api, workspace])

  const toggle = useCallback(async (skill: CatalogSkill, enabled: boolean): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(skill.name))
    setLoadError(null)
    try {
      const next = await api.toggle(skill.name, enabled, workspace !== '' ? { cwd: workspace } : undefined)
      setCatalog(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(skill.name)
        return next
      })
    }
  }, [api, workspace])

  const enableDisabled = useCallback(async (record: DisabledSkill): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(record.name))
    setLoadError(null)
    try {
      const next = await api.toggle(record.name, true, workspace !== '' ? { cwd: workspace } : undefined)
      setCatalog(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(record.name)
        return next
      })
    }
  }, [api, workspace])

  const batchToggleNames = useCallback(async (names: string[], enabled: boolean): Promise<void> => {
    if (names.length === 0) return
    setBatchBusy(true)
    setLoadError(null)
    try {
      const next = await api.toggleBatch(names, enabled, workspace !== '' ? { cwd: workspace } : undefined)
      setCatalog(next.catalog)
      if (next.failures.length > 0) {
        setLoadError('toggle-batch: ' + next.failures.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBatchBusy(false)
    }
  }, [api, workspace])

  const groupMap = useCallback((): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    for (const tag of groupsState?.tags ?? []) map.set('tag:' + tag.id, tag.skillNames)
    for (const collection of groupsState?.collections ?? []) map.set('col:' + collection.name, collection.skillNames)
    const origins = groupsState?.origins ?? {}
    const personalSkills = (catalog?.skills ?? []).filter((s) => origins[s.name] === undefined && !isProjectSource(s.source))
    const personalDisabled = (catalog?.disabled ?? []).filter((d) => origins[d.name] === undefined && !isProjectSource(d.root))

    // Legacy fallback key for personal as a whole
    const allPersonal = [...personalSkills.map((s) => s.name), ...personalDisabled.map((d) => d.name)]
    if (allPersonal.length > 0) {
      map.set('uncategorized-source', allPersonal)
    }

    // Per-root keys for independent management
    const roots = new Set<string>([
      ...personalSkills.map((s) => s.source),
      ...personalDisabled.map((d) => d.root),
    ])
    for (const r of roots) {
      const names = [
        ...personalSkills.filter((s) => s.source === r).map((s) => s.name),
        ...personalDisabled.filter((d) => d.root === r).map((d) => d.name),
      ]
      if (names.length > 0) {
        map.set('root:' + r, names)
      }
    }
    return map
  }, [groupsState, catalog])

  const actionNames = useMemo(() => new Set((catalog?.skills ?? []).filter((skill) => skill.writable).map((skill) => skill.name)), [catalog])
  const viewNames = useMemo(() => new Set((catalog?.skills ?? []).map((skill) => skill.name)), [catalog])

  const toggleGroup = useCallback((key: string, name: string, view: GroupSwitchState): void => {
    const members = groupMap().get(key) ?? []
    if (members.length === 0) return
    if (view === 'off') {
      void batchToggleNames(members, true)
      return
    }
    const others = [...groupMap().entries()].filter(([otherKey]) => otherKey !== key).map(([, memberNames]) => ({ members: memberNames }))
    const conflicts = conflictsOnClose(members, actionNames, others)
    if (conflicts.length > 0) {
      setConflictDialog({ key, name, conflicts })
    } else {
      void batchToggleNames(members.filter((member) => actionNames.has(member)), false)
    }
  }, [groupMap, actionNames, batchToggleNames])

  const resolveConflict = useCallback(async (closeAll: boolean): Promise<void> => {
    const dialog = conflictDialog
    if (dialog === null) return
    setConflictDialog(null)
    const members = groupMap().get(dialog.key) ?? []
    if (closeAll) {
      await batchToggleNames(members.filter((member) => actionNames.has(member)), false)
    } else {
      await batchToggleNames(
        members.filter((member) => actionNames.has(member) && !dialog.conflicts.includes(member)),
        false,
      )
    }
  }, [conflictDialog, groupMap, actionNames, batchToggleNames])

  const runConfirmed = useCallback(async (): Promise<void> => {
    const dialog = confirmDialog
    if (dialog === null) return
    setConfirmDialog(null)
    if (dialog.kind === 'sync') {
      setSyncingSource(dialog.repo)
      setLoadError(null)
      try {
        const result = await api.syncSource(dialog.repo, dialog.skills)
        await Promise.all([load(), loadGroups(), loadSources()])
        if (result.failed.length > 0) {
          setLoadError('sync: ' + result.failed.map((failure) => failure.name + ': ' + failure.error).join('; '))
        }
      } catch (error) {
        setLoadError(errorMessage(error))
      } finally {
        setSyncingSource(null)
      }
    } else {
      setLoadError(null)
      try {
        await api.confirmDeleteSource(dialog.repo, dialog.skills)
        await Promise.all([load(), loadGroups(), loadSources()])
      } catch (error) {
        setLoadError(errorMessage(error))
      }
    }
  }, [confirmDialog, api, load, loadGroups, loadSources])

  const checkSources = useCallback(async (repo?: string): Promise<void> => {
    setCheckingSource(repo ?? 'all')
    setLoadError(null)
    try {
      const result = await api.checkSources(repo)
      const next: Record<string, SourceCheckResult> = { ...sourceCheck }
      for (const item of result.results) next[item.repo] = item
      setSourceCheck(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setCheckingSource(null)
    }
  }, [api, sourceCheck])

  const requestSync = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'sync', repo, skills })
  }, [])

  const requestDelete = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'delete', repo, skills })
  }, [])

  const restoreTrash = useCallback(async (name: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      await api.restoreSource(name)
      await Promise.all([load(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, load, loadGroups, loadSources])

  const clearTrash = useCallback(async (): Promise<void> => {
    setConfirmClearTrash(false)
    setTagBusy(true)
    setLoadError(null)
    try {
      const result = await api.clearTrash()
      if (result.failed.length > 0) {
        setLoadError('clear trash: ' + result.failed.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
      await Promise.all([load(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, load, loadSources])

  const [fixingPaths, setFixingPaths] = useState<ReadonlySet<string>>(new Set())
  const fixDiagnostic = useCallback(async (path: string): Promise<void> => {
    setFixingPaths((previous) => new Set(previous).add(path))
    setLoadError(null)
    try {
      const confirmed = window.confirm(tt('diag.fixConfirm', { path }))
      if (!confirmed) return
      await api.fixDiagnostic(path)
      await load()
      setSuccessBanner(tt('diag.fixed'))
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setFixingPaths((previous) => {
        const next = new Set(previous)
        next.delete(path)
        return next
      })
    }
  }, [api, load])

  const requestDeleteSkill = useCallback((name: string): void => {
    setDeleteSkillDialog(name)
  }, [])

  const runDeleteSkill = useCallback(async (): Promise<void> => {
    const name = deleteSkillDialog
    if (name === null) return
    setDeleteSkillDialog(null)
    setTagBusy(true)
    setLoadError(null)
    try {
      await api.deleteSkill(name)
      await Promise.all([load(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, deleteSkillDialog, load, loadGroups, loadSources])

  const requestDeleteGroup = useCallback((name: string, skillNames: string[]): void => {
    setDeleteGroupDialog({ name, skillNames })
  }, [])

  const runDeleteGroup = useCallback(async (): Promise<void> => {
    const dialog = deleteGroupDialog
    if (dialog === null) return
    setDeleteGroupDialog(null)
    setTagBusy(true)
    setLoadError(null)
    const failures: string[] = []
    let done = 0
    for (const name of dialog.skillNames) {
      try {
        await api.deleteSkill(name)
        done += 1
      } catch (error) {
        failures.push(name + ': ' + errorMessage(error))
      }
    }
    await Promise.all([load(), loadGroups(), loadSources()])
    setTagBusy(false)
    if (failures.length > 0) {
      setLoadError(`删除整组 "${dialog.name}"：成功 ${done} 个，失败 ${failures.length} 个：` + failures.join('; '))
    } else if (done > 0) {
      setSuccessBanner(`已删除整组 "${dialog.name}"：${done} 个技能已移入回收站`)
    }
  }, [api, deleteGroupDialog, load, loadGroups, loadSources])

  const createTag = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newTagName.trim()
    if (name === '') return
    setTagBusy(true)
    setLoadError(null)
    try {
      applyTags(await api.saveTag({ name }))
      setNewTagName('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags, newTagName])

  const deleteTag = useCallback(async (id: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      applyTags(await api.deleteTag(id))
      setEditingTag(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags])

  const saveTag = useCallback(async (id: string, name: string, memberNames: string[] | null): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const safeName = name.trim()
      let tags: SkillTag[] | null = null
      if (safeName !== '') tags = await api.saveTag({ id, name: safeName })
      if (memberNames !== null) tags = await api.setTagMembers(id, memberNames)
      if (tags === null) return
      applyTags(tags)
      setEditingTag(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags])

  const reorderTags = useCallback(async (orderedIds: string[]): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const tags = await api.reorderTags(orderedIds)
      applyTags(tags)
    } catch (error) {
      const msg = errorMessage(error)
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        const byId = new Map(groupsState?.tags.map((t) => [t.id, t] as const) ?? [])
        const reordered = orderedIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => t !== undefined)
        if (reordered.length === orderedIds.length) {
          applyTags(reordered)
          setSuccessBanner('已临时调整顺序（本地生效）')
        } else {
          setLoadError(msg)
        }
      } else {
        setLoadError(msg)
      }
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags, groupsState])

  const reorderCollections = useCallback(async (orderedNames: string[]): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const collections = await api.reorderCollections(orderedNames)
      setGroupsState((prev) => prev === null ? prev : { ...prev, collections })
      void loadGroups()
    } catch (error) {
      const msg = errorMessage(error)
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        setGroupsState((prev) => {
          if (prev === null) return prev
          const map = new Map(prev.collections.map((c) => [c.name, c] as const))
          const reordered = orderedNames.map((n) => map.get(n)).filter((c): c is NonNullable<typeof c> => c !== undefined)
          for (const c of prev.collections) if (!reordered.some((r) => r.name === c.name)) reordered.push(c)
          return { ...prev, collections: reordered }
        })
        setSuccessBanner('已临时调整顺序（本地生效）')
      } else {
        setLoadError(msg)
      }
    } finally {
      setTagBusy(false)
    }
  }, [api, loadGroups])

  const reorderSourceGroups = useCallback(async (orderedKeys: string[]): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      await api.reorderSourceGroups(orderedKeys)
      await loadGroups()
    } catch (error) {
      const msg = errorMessage(error)
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        setGroupsState((prev) => {
          if (prev === null) return prev
          const colOrder = orderedKeys.filter((k) => k.startsWith('col:')).map((k) => k.slice(4))
          const map = new Map(prev.collections.map((c) => [c.name, c] as const))
          const reordered = colOrder.map((n) => map.get(n)).filter((c): c is NonNullable<typeof c> => c !== undefined)
          for (const c of prev.collections) if (!reordered.some((r) => r.name === c.name)) reordered.push(c)
          return { ...prev, collections: reordered, sourceGroupOrder: orderedKeys }
        })
        setSuccessBanner('已临时调整顺序（本地生效）')
      } else {
        setLoadError(msg)
      }
    } finally {
      setTagBusy(false)
    }
  }, [api, loadGroups])

  const addSource = useCallback(async (input: string): Promise<void> => {
    const value = input.trim()
    if (value === '') return
    setLoadError(null)
    try {
      const result = await api.addMarketSource(value)
      setMarketState({ status: 'ready', repos: result.repos })
      setNewSourceName('')
      setRepoResult(null)
      setRepoSelected(new Set())
      const slug = result.repos[result.repos.length - 1].repo
      setScanningRepo(slug)
      setRepoDiscoverState({ status: 'scanning' })
      try {
        const data = await api.repoDiscover(slug)
        setRepoDiscoverState({ status: 'ready', data })
      } catch (error) {
        setRepoDiscoverState({ status: 'error', message: errorMessage(error) })
      } finally {
        setScanningRepo(null)
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  const addMarketSource = useCallback(async (): Promise<void> => {
    await addSource(newSourceName)
  }, [addSource, newSourceName])

  const removeMarketSource = useCallback(async (repo: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const result = await api.removeMarketSource(repo)
      setMarketState({ status: 'ready', repos: result.repos })
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api])

  const scanRepo = useCallback(async (input: string): Promise<void> => {
    const value = input.trim()
    if (value === '') return
    setRepoResult(null)
    setRepoSelected(new Set())
    setScanningRepo(value)
    setRepoDiscoverState({ status: 'scanning' })
    setLoadError(null)
    try {
      const data = await api.repoDiscover(value)
      if (data.ref === null) {
        setBranchChoice({ repo: data.repo, branches: data.branches ?? [], selected: (data.branches ?? [])[0] ?? 'main' })
        setRepoDiscoverState({ status: 'idle' })
        return
      }
      setRepoDiscoverState({ status: 'ready', data })
      void loadMarket()
    } catch (error) {
      setRepoDiscoverState({ status: 'error', message: errorMessage(error) })
    } finally {
      setScanningRepo(null)
    }
  }, [api, loadMarket])

  const confirmBranchChoice = useCallback(async (): Promise<void> => {
    if (branchChoice === null) return
    setBranchBusy(true)
    setLoadError(null)
    try {
      await api.setMarketSourceRef(branchChoice.repo, branchChoice.selected)
      setBranchChoice(null)
      await scanRepo(branchChoice.repo)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBranchBusy(false)
    }
  }, [api, branchChoice, scanRepo])

  const [versionDialog, setVersionDialog] = useState<VersionChoiceState | null>(null)
  const [versionBusy, setVersionBusy] = useState(false)
  const openVersionDialog = useCallback(async (repo: string): Promise<void> => {
    const current = marketState.repos.find((item) => item.repo === repo)?.ref
    setVersionDialog({ repo, ...(current !== undefined ? { current } : {}), releases: [], branches: [], selected: current ?? '', custom: '', loading: true })
    setLoadError(null)
    try {
      const data = await api.marketSourceVersions(repo)
      setVersionDialog({
        repo,
        ...(data.current !== undefined ? { current: data.current } : {}),
        releases: data.releases,
        branches: data.branches,
        selected: data.current ?? data.releases[0] ?? data.branches[0] ?? '',
        custom: '',
        loading: false,
      })
    } catch (error) {
      setLoadError(errorMessage(error))
      setVersionDialog(null)
    }
  }, [api, marketState])

  const confirmVersionDialog = useCallback(async (): Promise<void> => {
    if (versionDialog === null) return
    const ref = versionDialog.custom.trim() !== '' ? versionDialog.custom.trim() : versionDialog.selected
    if (ref === '') return
    setVersionBusy(true)
    setLoadError(null)
    try {
      await api.setMarketSourceRef(versionDialog.repo, ref)
      setVersionDialog(null)
      await loadMarket()
      await scanRepo(versionDialog.repo)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setVersionBusy(false)
    }
  }, [api, versionDialog, loadMarket, scanRepo])

  const toggleRepoSelected = useCallback((path: string, checked: boolean): void => {
    setRepoSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const importRepo = useCallback(async (): Promise<void> => {
    if (repoDiscoverState.status !== 'ready') return
    setRepoImporting(true)
    setRepoResult(null)
    setImportJobId(null)
    setLoadError(null)
    let finalProgress: RepoImportProgressResponse | null = null
    try {
      const created = await api.repoImport(repoDiscoverState.data.repo, [...repoSelected], repoDiscoverState.data.ref ?? undefined)
      setImportJobId(created.jobId)
      setRepoResult({ ok: true, jobId: created.jobId, status: 'running', total: created.total, done: 0, totalBytes: created.totalBytes, downloadedBytes: 0, imported: [], skipped: [], failed: [] })
      pollAbortRef.current?.abort()
      pollAbortRef.current = new AbortController()
      const signal = pollAbortRef.current.signal
      let attempt = 0
      for (;;) {
        if (signal.aborted) break
        const delay = Math.min(2000, 800 + attempt * 200)
        await new Promise((r) => setTimeout(r, delay))
        if (signal.aborted) break
        try {
          const progress = await api.repoImportProgress(created.jobId)
          setRepoResult(progress)
          finalProgress = progress
          if (progress.status !== 'running') {
            break
          }
          attempt = 0
        } catch (pollError) {
          const msg = errorMessage(pollError)
          if (msg.includes('not found')) break
          attempt += 1
          if (attempt > 8) break
        }
      }
      await Promise.all([load(), loadMarket(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      if (finalProgress !== null && (finalProgress.imported.length > 0 || finalProgress.skipped.length > 0)) {
        const doneNames = new Set([...finalProgress.imported.map((r) => r.name), ...finalProgress.skipped.map((r) => r.name)])
        const donePaths = new Set(
          repoDiscoverState.data.entries.filter((e) => doneNames.has(e.name)).map((e) => e.path),
        )
        setRepoSelected((prev) => {
          const next = new Set(prev)
          for (const p of donePaths) next.delete(p)
          return next
        })
        setRepoDiscoverState((prev) => {
          if (prev.status !== 'ready') return prev
          return {
            ...prev,
            data: {
              ...prev.data,
              entries: prev.data.entries.map((e) => doneNames.has(e.name) ? { ...e, existing: true } : e),
            },
          }
        })
      }
      setRepoImporting(false)
    }
  }, [api, repoDiscoverState, repoSelected, load, loadMarket, loadGroups, loadSources])

  useEffect(() => {
    return () => { pollAbortRef.current?.abort() }
  }, [])

  const cancelImport = useCallback(async (): Promise<void> => {
    if (importJobId === null) return
    pollAbortRef.current?.abort()
    try {
      const res = await api.repoImportCancel(importJobId)
      try {
        const progress = await api.repoImportProgress(importJobId)
        setRepoResult(progress)
      } catch {
        setRepoResult((prev) => prev !== null ? { ...prev, status: res.status as 'cancelled' } : prev)
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setRepoImporting(false)
    }
  }, [api, importJobId])

  const clearScan = useCallback((): void => {
    setRepoDiscoverState({ status: 'idle' })
    setScanningRepo(null)
    setRepoResult(null)
    setRepoSelected(new Set())
    setImportJobId(null)
    pollAbortRef.current?.abort()
  }, [])

  const checkMarket = useCallback(async (): Promise<void> => {
    try {
      const result = await api.marketCheck()
      const next: Record<string, MarketCheckResult> = {}
      for (const item of result.results) next[item.repo] = item
      setMarketCheck(next)
    } catch {
      // market check failure non-fatal
    }
  }, [api])

  const syncMarketSource = useCallback(async (repo: string): Promise<void> => {
    setSyncingMarket(repo)
    setLoadError(null)
    try {
      const result = await api.marketSync(repo)
      setMarketSyncDialog({ repo: result.repo, ref: result.ref, skills: result.skills, selected: new Set(result.skills) })
      await loadMarket()
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setSyncingMarket(null)
    }
  }, [api, loadMarket])

  const confirmMarketSync = useCallback(async (): Promise<void> => {
    if (marketSyncDialog === null) return
    const selected = [...marketSyncDialog.selected]
    setSyncBusy(true)
    setLoadError(null)
    try {
      if (selected.length > 0) {
        const result = await api.syncSource(marketSyncDialog.repo, selected)
        if (result.failed.length > 0) setLoadError(result.failed.map((item) => item.name + ': ' + item.error).join('\n'))
      }
      setMarketSyncDialog(null)
      await Promise.all([load(), loadGroups(), loadSources()])
      void checkMarket()
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setSyncBusy(false)
    }
  }, [api, marketSyncDialog, load, loadGroups, loadSources, checkMarket])

  const updateAll = useCallback(async (): Promise<void> => {
    setUpdateAllDialog(false)
    setBatchBusy(true)
    setLoadError(null)
    const failures: string[] = []
    let done = 0
    try {
      for (const [repo, check] of Object.entries(sourceCheck)) {
        if (!check.changed || check.updated.length === 0) continue
        try {
          const result = await api.syncSource(repo, check.updated)
          done += 1
          if (result.failed.length > 0) {
            failures.push(tt('market.updateAllItem', { repo, count: result.failed.length }) + ': ' + result.failed.map((item) => item.name + ': ' + item.error).join('; '))
          }
        } catch (error) {
          failures.push(repo + ': ' + errorMessage(error))
        }
      }
      await Promise.all([load(), loadGroups(), loadSources()])
      await checkSources()
      void checkMarket()
      if (failures.length > 0) setLoadError(failures.join('\n'))
      else if (done > 0) setSuccessBanner(tt('market.updateAllDone', { count: done }))
    } finally {
      setBatchBusy(false)
    }
  }, [api, sourceCheck, checkSources, checkMarket, load, loadGroups, loadSources])

  useEffect(() => {
    if (!shouldAutoCheck()) return
    markAutoChecked()
    void checkUpdate()
    void checkSources()
    void checkMarket()
  }, [checkUpdate, checkSources, checkMarket])

  const create = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setFormBusy(true)
    setFormMessage(null)
    setSuccessBanner(null)
    try {
      const result = await api.create({ name: formName, description: formDesc, root: formRoot })
      setSuccessBanner(tt('form.success') + result.path)
      setFormName('')
      setFormDesc('')
      setShowForm(false)
      await load()
    } catch (error) {
      setFormMessage({ kind: 'error', text: tt('form.error') + errorMessage(error) })
    } finally {
      setFormBusy(false)
    }
  }, [api, formName, formDesc, formRoot, load])

  const normalized = search.trim().toLocaleLowerCase()
  const origins = groupsState?.origins ?? {}
  const sourceOptions = useMemo(() => {
    const skills = catalog?.skills ?? []
    const repos = [...new Set(skills.map((skill) => origins[skill.name]).filter((repo): repo is string => repo !== undefined))].sort()
    const userRoots = [...new Set(skills.filter((skill) => origins[skill.name] === undefined && !isProjectSource(skill.source)).map((skill) => skill.source))].sort()
    return [...repos, ...userRoots]
  }, [catalog, origins])

  const filtered = useMemo(() => (catalog?.skills ?? []).filter((skill) => {
    if (invocationFilter === 'model' && !skill.invocation.modelInvocable) return false
    if (invocationFilter === 'user' && !skill.invocation.userInvocable) return false
    if (normalized.length === 0) return true
    return skill.name.toLocaleLowerCase().includes(normalized)
      || skill.description.toLocaleLowerCase().includes(normalized)
      || skill.displayName?.toLocaleLowerCase().includes(normalized)
      || skill.shortDescription?.toLocaleLowerCase().includes(normalized)
  }), [catalog, normalized, invocationFilter])

  const shortenedCount = useMemo(() => filtered.filter((skill) => skill.shortDescription !== undefined).length, [filtered])
  const sorted = useMemo(() => sortSkills(filtered, sortKey, (name) => uses.get(name)?.count), [filtered, sortKey, uses])

  const clearListFilters = useCallback((): void => {
    setSearch('')
    setSourceFilter('all')
    setInvocationFilter('all')
  }, [])

  return {
    catalog, loading, loadError, successBanner, updateState, repoDiscoverState, scanningRepo, repoSelected, repoImporting, repoResult, importJobId,
    search, workspace, detail, detailLoading, busyNames, batchBusy, showForm, formName, formDesc, formRoot, formBusy, formMessage,
    uses, hubConfig, tab, skillView, sourceFilter, invocationFilter, sortKey, marketState, marketCheck, branchChoice, branchBusy,
    marketSyncDialog, syncingMarket, syncBusy, newSourceName, groupsState, sourcesState, sourceCheck, checkingSource, syncingSource,
    conflictDialog, confirmDialog, deleteSkillDialog, deleteGroupDialog, confirmClearTrash, updateAllDialog, editingTag, editName, membersDraft, newTagName, tagBusy,
    editSearch, collapsedGroups, subdividedProjects, showLegend, editMode, versionDialog, versionBusy,
    actionNames, viewNames, normalized, origins, sourceOptions, filtered, sorted, shortenedCount,
    setLoadError, setSuccessBanner, setSearch, setWorkspace, setDetail, setShowForm, setFormName, setFormDesc, setFormRoot, setFormMessage,
    setRepoSelected, setTab, setSkillView,
    setSourceFilter, setInvocationFilter, setSortKey, setBranchChoice, setMarketSyncDialog, setNewSourceName, setConflictDialog, setConfirmDialog,
    setDeleteSkillDialog, setDeleteGroupDialog, setConfirmClearTrash, setUpdateAllDialog, setEditingTag, setEditName, setMembersDraft, setNewTagName, setEditSearch, setShowLegend, setEditMode, setVersionDialog,
    toggleGroupCollapse, toggleSubdivide, checkUpdate, loadMarket, openDetail, toggle, enableDisabled, batchToggleNames, toggleGroup, resolveConflict,
    runConfirmed, checkSources, requestSync, requestDelete, restoreTrash, clearTrash, fixingPaths, fixDiagnostic, clearListFilters, openVersionDialog, confirmVersionDialog, requestDeleteSkill, runDeleteSkill, requestDeleteGroup, runDeleteGroup, createTag,
    deleteTag, saveTag, reorderTags, reorderCollections, reorderSourceGroups, addSource, addMarketSource, removeMarketSource, scanRepo, confirmBranchChoice, toggleRepoSelected, importRepo, cancelImport, clearScan,
    checkMarket, syncMarketSource, confirmMarketSync, updateAll, create,
  }
}
