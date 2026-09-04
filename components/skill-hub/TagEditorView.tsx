/**
 * Full-page tag (scene) editor: rename / delete header, member checkbox
 * lists (enabled + disabled skills), and the save-members action.
 */

import type { CatalogResponse, CatalogSkill, SkillTag } from '@/lib/skill-hub/protocol'
import { tt } from './helpers'
import css from './panel.module.css'

export interface TagEditorViewProps {
  tag: SkillTag
  editName: string
  membersDraft: ReadonlySet<string>
  editSearch: string
  catalog: CatalogResponse | null
  tagBusy: boolean
  onBack: () => void
  onEditName: (value: string) => void
  onEditSearch: (value: string) => void
  onToggleMember: (name: string, checked: boolean) => void
  onRename: () => void
  onDelete: () => void
  onSaveMembers: () => void
}

export function TagEditorView(props: TagEditorViewProps) {
  const { tag, editName, membersDraft, editSearch, catalog, tagBusy, onBack, onEditName, onEditSearch, onToggleMember, onRename, onDelete, onSaveMembers } = props
  const editQuery = editSearch.trim().toLocaleLowerCase()
  const editSkills = (catalog?.skills ?? []).filter((skill) => editQuery.length === 0 || skill.name.toLocaleLowerCase().includes(editQuery) || skill.description.toLocaleLowerCase().includes(editQuery))
    .reduce<CatalogSkill[]>((acc, skill) => { if (acc.some((s) => s.name === skill.name)) return acc; return [...acc, skill] }, [])
  const editDisabled = (catalog?.disabled ?? []).filter((record) => editQuery.length === 0 || record.name.toLocaleLowerCase().includes(editQuery) || record.description.toLocaleLowerCase().includes(editQuery))
  return (
    <div className={css.panel}>
      <div className={css.detailHead}>
        <button type="button" className={css.back} onClick={onBack}>{tt('detail.back')}</button>
        <input
          className={css.input + ' ' + css.grow}
          value={editName}
          onChange={(event) => { onEditName(event.target.value) }}
          placeholder={tt('groups.namePlaceholder')}
        />
        <button type="button" className={css.opBtn} disabled={tagBusy || editName.trim() === ''} onClick={onRename}>{tt('groups.rename')}</button>
        {tag.default !== true
          ? <button type="button" className={css.opBtn} disabled={tagBusy} onClick={onDelete}>{tt('groups.delete')}</button>
          : null}
      </div>
      <p className={css.hintLine}>{tt('groups.membersHint')}</p>
      <input className={css.search} value={editSearch} onChange={(event) => { onEditSearch(event.target.value) }} placeholder={tt('panel.search')} />
      <div className={css.section}>
        {editSkills.map((skill) => (
          <label key={skill.name} className={css.row}>
            <input
              type="checkbox"
              checked={membersDraft.has(skill.name)}
              onChange={(event) => { onToggleMember(skill.name, event.target.checked) }}
            />
            <div className={css.rowMain}>
              <div className={css.rowName}>{skill.name}</div>
              <div className={css.rowDesc}>{skill.description}</div>
            </div>
          </label>
        ))}
        {editDisabled.map((record) => (
          <label key={record.name} className={css.row}>
            <input
              type="checkbox"
              checked={membersDraft.has(record.name)}
              onChange={(event) => { onToggleMember(record.name, event.target.checked) }}
            />
            <div className={css.rowMain}>
              <div className={css.rowName}>{record.name}</div>
              <div className={css.rowDesc}>{record.description} · {tt('panel.disabled')}</div>
            </div>
          </label>
        ))}
      </div>
      <div className={css.buttons}>
        <button type="button" className={css.button + ' ' + css.primary} disabled={tagBusy} onClick={onSaveMembers}>{tt('groups.saveMembers')}</button>
      </div>
    </div>
  )
}
