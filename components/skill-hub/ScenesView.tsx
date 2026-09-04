/**
 * Scenes tab: user tag groups (one card per scene with tri-state switch,
 * edit entry, and member management).
 */

import { useState } from 'react'
import { skillKey, tt } from './helpers'
import { groupSwitchView } from './grouping'
import { SkillRow } from './SkillRow'
import { DisabledRow } from './DisabledRow'
import { DEFAULT_SCENE_NAME } from '@/lib/skill-hub/protocol'
import { GroupSummary } from './GroupSummary'
import type { SkillHubState } from './useSkillHub'
import css from './panel.module.css'

export function ScenesView(props: { hub: SkillHubState }) {
  const { hub } = props
  const {
    catalog, groupsState, sorted, normalized, collapsedGroups, viewNames,
    actionNames, batchBusy, busyNames, newTagName, setNewTagName, tagBusy,
    createTag, toggleGroupCollapse, toggleGroup, setEditingTag, setEditName,
    setMembersDraft, setEditSearch, enableDisabled,
  } = hub
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const handleDrop = (targetId: string): void => {
    if (dragId === null || dragId === targetId || groupsState === null) return
    const ids = groupsState.tags.map((t) => t.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    void hub.reorderTags(next)
  }

  return (
    <>
      <form className={css.form} onSubmit={(event) => { void createTag(event) }}>
        <div className={css.buttons}>
          <input
            className={css.input + ' ' + css.grow}
            value={newTagName}
            onChange={(event) => { setNewTagName(event.target.value) }}
            placeholder={tt('groups.namePlaceholder')}
          />
          <button type="submit" className={css.button + ' ' + css.primary} disabled={tagBusy || newTagName.trim() === ''}>{tt('groups.new')}</button>
        </div>
      </form>

      {groupsState !== null && groupsState.tags.length === 0 ? <div className={css.empty}>{tt('groups.empty')}</div> : null}
      {groupsState?.tags.map((tag) => {
        const skills = sorted.filter((skill) => tag.skillNames.includes(skill.name))
        const disabledMembers = (catalog?.disabled ?? []).filter((record) => tag.skillNames.includes(record.name) && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized)))
        const collapsed = collapsedGroups.has('tag:' + tag.id)
        const view = groupSwitchView(tag.skillNames, viewNames)
        const hasWritable = tag.skillNames.some((name) => actionNames.has(name))
        const isDragging = dragId === tag.id
        const isOver = overId === tag.id && dragId !== tag.id
        return (
          <section
            key={'tag:' + tag.id}
            className={css.section + (isDragging ? ' ' + css.dragging : '') + (isOver ? ' ' + css.dragOver : '')}
            draggable
            onDragStart={(e) => { setDragId(tag.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tag.id) }}
            onDragOver={(e) => { e.preventDefault(); if (overId !== tag.id) setOverId(tag.id) }}
            onDragLeave={() => { if (overId === tag.id) setOverId(null) }}
            onDrop={(e) => { e.preventDefault(); handleDrop(tag.id); setOverId(null) }}
            onDragEnd={() => { setDragId(null); setOverId(null) }}
          >
            <div className={css.groupHead}>
              <span className={css.dragHandle} aria-hidden>⋮⋮</span>
              <button type="button" className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('tag:' + tag.id) }}>
                <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                <span className={css.groupTitle}>
                  {tag.name === DEFAULT_SCENE_NAME ? tt('scene.default') : tag.name} · {tag.skillNames.length}
                  <GroupSummary members={tag.skillNames} hub={hub} />
                </span>
              </button>
              <span className={css.groupOps}>
                <button type="button" role="switch" aria-checked={view.state !== 'off'} aria-label={tag.name}
                  className={css.switch + (view.state === 'on' ? ' ' + css.switchOn : view.state === 'mixed' ? ' ' + css.switchMixed : '')}
                  disabled={batchBusy || tag.skillNames.length === 0 || (view.state !== 'off' && !hasWritable)}
                  title={view.state !== 'off' && !hasWritable ? tt('groups.noWritable') : undefined}
                  onClick={(event) => { event.stopPropagation(); toggleGroup('tag:' + tag.id, tag.name, view.state) }}>
                  <span className={css.switchThumb} />
                </button>
                <button type="button" className={css.opBtn} onClick={() => { setEditingTag(tag); setEditName(tag.name); setMembersDraft(new Set(tag.skillNames)); setEditSearch('') }}>{tt('groups.edit')}</button>
              </span>
            </div>
            {!collapsed ? (
              <>
                {skills.map((skill) => <SkillRow key={skillKey(skill)} skill={skill} hub={hub} />)}
                {disabledMembers.map((record) => (
                  <DisabledRow key={record.name} record={record} busy={busyNames.has(record.name)} duplicate={hub.catalog?.duplicateNames?.includes(record.name) === true} onEnable={() => { void enableDisabled(record) }} onOpen={() => { void hub.openDetail(record.name) }} />
                ))}
              </>
            ) : null}
          </section>
        )
      })}
    </>
  )
}
