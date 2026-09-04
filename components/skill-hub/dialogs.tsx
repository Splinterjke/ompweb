/**
 * Shared dialog family for the skill hub panel: overlay shell plus
 * conflict dialog, confirm dialog, branch picker, version picker, and market sync.
 */

import { useEffect, type ReactNode } from 'react'
import type { CollectionGroup, SkillTag } from '@/lib/skill-hub/protocol'
import { tt } from './helpers'
import { groupNamesOf } from './grouping'
import css from './panel.module.css'

export interface ConflictDialogState {
  key: string
  name: string
  conflicts: string[]
}

export interface ConfirmDialogState {
  kind: 'sync' | 'delete'
  repo: string
  skills: string[]
}

export interface BranchChoiceState {
  repo: string
  branches: string[]
  selected: string
}

export interface VersionChoiceState {
  repo: string
  current?: string
  releases: string[]
  branches: string[]
  selected: string
  custom: string
  loading: boolean
}

export interface MarketSyncDialogState {
  repo: string
  ref: string
  skills: string[]
  selected: ReadonlySet<string>
}

function DialogShell(props: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  })
  return (
    <div className={css.dialogOverlay} onClick={props.onClose}>
      <div className={css.dialog} role="alertdialog" aria-modal="true" onClick={(event) => { event.stopPropagation() }}>
        {props.children}
      </div>
    </div>
  )
}

export function ConfirmDialog(props: {
  title: string
  text: string
  items?: readonly string[]
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { title, text, items, confirmLabel, danger, onCancel, onConfirm } = props
  return (
    <DialogShell onClose={onCancel}>
      <h3 className={css.dialogTitle}>{title}</h3>
      <p className={css.dialogText}>{text}</p>
      {items !== undefined ? (
        <ul className={css.dialogList}>
          {items.map((name) => <li key={name}><span className={css.rowNameText}>{name}</span></li>)}
        </ul>
      ) : null}
      <div className={css.dialogActions}>
        <button type="button" className={css.button} onClick={onCancel}>{tt('form.cancel')}</button>
        <button type="button" className={css.button + (danger === true ? ' ' + css.danger : ' ' + css.primary)} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  )
}

export function ConflictDialog(props: {
  dialog: ConflictDialogState
  tags: readonly SkillTag[]
  collections: readonly CollectionGroup[]
  onClose: () => void
  onKeepOn: () => void
  onCloseAll: () => void
}) {
  const { dialog, tags, collections, onClose, onKeepOn, onCloseAll } = props
  return (
    <DialogShell onClose={onClose}>
      <h3 className={css.dialogTitle}>{tt('groups.conflictTitle')}</h3>
      <p className={css.dialogText}>{tt('groups.conflictText')}</p>
      <ul className={css.dialogList}>
        {dialog.conflicts.map((name) => (
          <li key={name}>
            <span className={css.rowNameText}>{name}</span>
            {' — ' + groupNamesOf(name, [...tags], [...collections]).join(', ')}
          </li>
        ))}
      </ul>
      <div className={css.dialogActions}>
        <button type="button" className={css.button} onClick={onKeepOn}>{tt('groups.keepOn')}</button>
        <button type="button" className={css.button + ' ' + css.primary} onClick={onCloseAll}>{tt('groups.closeAll')}</button>
      </div>
    </DialogShell>
  )
}

export function BranchChoiceDialog(props: {
  choice: BranchChoiceState
  busy: boolean
  onSelect: (branch: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { choice, busy, onSelect, onCancel, onConfirm } = props
  return (
    <DialogShell onClose={onCancel}>
      <h3 className={css.dialogTitle}>{tt('market.branchTitle')}</h3>
      <p className={css.dialogText}>{tt('market.branchHint')}</p>
      <select className={css.select + ' ' + css.dialogSelect} value={choice.selected}
        onChange={(event) => { onSelect(event.target.value) }}>
        {choice.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
      </select>
      <div className={css.dialogActions}>
        <button type="button" className={css.button} onClick={onCancel}>{tt('form.cancel')}</button>
        <button type="button" className={css.button + ' ' + css.primary} disabled={busy} onClick={onConfirm}>{tt('market.branchConfirm')}</button>
      </div>
    </DialogShell>
  )
}

export function VersionChoiceDialog(props: {
  choice: VersionChoiceState
  busy: boolean
  onSelect: (ref: string) => void
  onCustom: (custom: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { choice, busy, onSelect, onCustom, onCancel, onConfirm } = props
  const effective = choice.custom.trim() !== '' ? choice.custom.trim() : choice.selected
  return (
    <DialogShell onClose={onCancel}>
      <h3 className={css.dialogTitle}>{tt('market.versionTitle')}</h3>
      <p className={css.dialogText}>{tt('market.versionText', { repo: choice.repo })}{choice.current !== undefined ? ` (${tt('market.versionCurrent', { ref: choice.current })})` : ''}</p>
      {choice.loading ? <p className={css.dialogText}>{tt('market.scanning')}</p> : (
        <>
          {choice.releases.length > 0 ? (
            <>
              <p className={css.dialogText} style={{ marginBottom: 4 }}>{tt('market.versionReleases')}</p>
              <select className={css.select + ' ' + css.dialogSelect} value={choice.releases.includes(choice.selected) ? choice.selected : choice.releases[0]}
                onChange={(event) => { onSelect(event.target.value); onCustom('') }}>
                {choice.releases.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            </>
          ) : null}
          {choice.branches.length > 0 ? (
            <>
              <p className={css.dialogText} style={{ marginBottom: 4 }}>{tt('market.versionBranches')}</p>
              <select className={css.select + ' ' + css.dialogSelect} value={choice.branches.includes(choice.selected) ? choice.selected : choice.branches[0]}
                onChange={(event) => { onSelect(event.target.value); onCustom('') }}>
                {choice.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
              </select>
            </>
          ) : null}
          <p className={css.dialogText} style={{ marginBottom: 4 }}>{tt('market.versionCustom')}</p>
          <input className={css.input + ' ' + css.dialogSelect} value={choice.custom}
            onChange={(event) => { onCustom(event.target.value) }} placeholder="v1.2.3 / main / abc1234" />
        </>
      )}
      <div className={css.dialogActions}>
        <button type="button" className={css.button} onClick={onCancel}>{tt('form.cancel')}</button>
        <button type="button" className={css.button + ' ' + css.primary} disabled={busy || choice.loading || effective === ''} onClick={onConfirm}>
          {busy ? tt('source.syncing') : tt('market.versionConfirm', { ref: effective })}
        </button>
      </div>
    </DialogShell>
  )
}

export function MarketSyncDialog(props: {
  dialog: MarketSyncDialogState
  busy: boolean
  onToggle: (name: string, checked: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { dialog, busy, onToggle, onCancel, onConfirm } = props
  return (
    <DialogShell onClose={onCancel}>
      <h3 className={css.dialogTitle}>{tt('market.syncTitle')}</h3>
      <p className={css.dialogText}>{tt('market.syncText', { ref: dialog.ref })}</p>
      {dialog.skills.length === 0 ? (
        <p className={css.dialogText}>{tt('market.syncNone')}</p>
      ) : (
        <div className={css.dialogList}>
          {dialog.skills.map((name) => (
            <label key={name} className={css.dialogRow}>
              <input type="checkbox" checked={dialog.selected.has(name)}
                onChange={(event) => { onToggle(name, event.target.checked) }} />
              <span className={css.rowNameText}>{name}</span>
            </label>
          ))}
        </div>
      )}
      <div className={css.dialogActions}>
        <button type="button" className={css.button} onClick={onCancel}>{tt('market.syncCancel')}</button>
        <button type="button" className={css.button + ' ' + css.primary} disabled={busy || dialog.skills.length === 0} onClick={onConfirm}>
          {busy ? tt('source.syncing') : tt('source.sync')}
        </button>
      </div>
    </DialogShell>
  )
}
