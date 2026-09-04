/**
 * Full-page skill detail view: metadata, upstream source card with
 * check/sync/follow-delete actions, diagnostics auto-repair banner, and the raw SKILL.md body.
 */

import { useEffect, useRef, useState } from 'react'
import type { GroupsResponse, HubConfig, SkillDetail, SourceCheckResult, SourcesResponse } from '@/lib/skill-hub/protocol'
import { copyTextToClipboard, isDisplayNameDistinct, tt } from './helpers'
import css from './panel.module.css'
import { dotStyle, formatDateTime, shortSha } from './format'
import { SourceStatusBadge } from './SourceStatusBadge'

export interface SkillDetailViewProps {
  detail: SkillDetail
  hubConfig: HubConfig | null
  uses: ReadonlyMap<string, { count: number; lastUsed?: number }>
  groupsState: GroupsResponse | null
  sourcesState: SourcesResponse | null
  sourceCheck: Readonly<Record<string, SourceCheckResult>>
  checkingSource: string | null
  syncingSource: string | null
  loading: boolean
  disabled?: boolean
  onEnable?: () => void
  onBack: () => void
  onCheck: (repo: string) => void
  onSync: (repo: string, skills: string[]) => void
  onFollowDelete: (repo: string, skills: string[]) => void
  onFixDiagnostic?: (path: string) => void
  isFixingDiagnostic?: boolean
}

export function SkillDetailView(props: SkillDetailViewProps) {
  const {
    detail, hubConfig, uses, groupsState, sourcesState, sourceCheck,
    checkingSource, syncingSource, loading, disabled, onEnable, onBack,
    onCheck, onSync, onFollowDelete, onFixDiagnostic, isFixingDiagnostic,
  } = props

  const detailSource = sourcesState?.sources.find((source) => source.skills.includes(detail.name))
  const detailCheck = detailSource !== undefined ? sourceCheck[detailSource.repo] : undefined
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => { window.clearTimeout(copyTimer.current) }, [])

  const copyText = (text: string, key: string): void => {
    void copyTextToClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(key)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => { setCopied(null) }, 1200)
    })
  }

  return (
    <div className={css.panel}>
      <div className={css.detailHead}>
        <button type="button" className={css.back} onClick={onBack}>{tt('detail.back')}</button>
        <span className={css.detailName} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {detail.name}
          {isDisplayNameDistinct(detail.name, detail.displayName) ? <span className={css.displayName} style={{ fontSize: 13, marginLeft: 0 }}>{detail.displayName}</span> : null}
          {detail.invocation.modelInvocable
            ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} aria-label={tt('legend.model')} />
            : detail.invocation.userInvocable
              ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} aria-label={tt('legend.user')} />
              : null}
        </span>
        <span className={css.actions} style={{ marginLeft: 'auto', gap: 6 }}>
          {disabled === true && onEnable !== undefined ? <button type="button" className={css.opBtn} role="switch" aria-checked={false} aria-label={tt('row.enable')} onClick={onEnable}>{tt('row.enable')}</button> : null}
          <button type="button" className={css.opBtn} onClick={() => { copyText('$' + detail.name, 'mention') }}>{copied === 'mention' ? tt('detail.copied') : tt('detail.copyMention')}</button>
          {detail.path !== undefined ? <button type="button" className={css.opBtn} onClick={() => { const path = detail.path; if (path !== undefined) copyText(path, 'path') }}>{copied === 'path' ? tt('detail.copied') : tt('detail.copyPath')}</button> : null}
        </span>
      </div>

      {detail.diagnostic ? (
        <div className={css.diagRow} style={{ margin: '8px 0', border: '1px solid var(--accent, #e5534b)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={css.diagReason} style={{ fontWeight: 600, color: 'var(--accent, #e5534b)' }}>
              ⚠ 格式诊断提示：{detail.diagnostic}
            </div>
            {detail.path ? <div className={css.diagPath}>{detail.path}</div> : null}
          </div>
          {detail.fixable === true && detail.path && onFixDiagnostic ? (
            <button
              type="button"
              className={css.button + ' ' + css.primary}
              disabled={isFixingDiagnostic}
              onClick={() => onFixDiagnostic(detail.path!)}
              style={{ flex: 'none', alignSelf: 'center', fontSize: 12, padding: '4px 10px' }}
            >
              {isFixingDiagnostic ? tt('diag.fixing') : tt('diag.fix')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={css.detailMeta}>
        <div className={css.detailMetaLine}>{tt('detail.provider')}: {detail.provider}</div>
        {detail.addedAt !== undefined ? <div className={css.detailMetaLine}>{tt('detail.addedAt')}: {formatDateTime(detail.addedAt)}</div> : null}
        {detail.updatedAt !== undefined ? <div className={css.detailMetaLine}>{tt('detail.updatedAt')}: {formatDateTime(detail.updatedAt)}</div> : null}
        {detail.path !== undefined ? <div className={css.detailMetaLine}>{tt('detail.path')}: {detail.path}</div> : null}
        {detail.whenToUse !== undefined ? <div className={css.detailMetaLine}>{tt('detail.whenToUse')}: {detail.whenToUse}</div> : null}
        {(() => {
          const stat = uses.get(detail.name)
          if (stat === undefined || stat.count === 0) return null
          const at = stat.lastUsed !== undefined ? ' · ' + new Date(stat.lastUsed).toLocaleString() : ''
          return <div className={css.detailMetaLine}>{tt('detail.uses')}: {stat.count}{at}</div>
        })()}
        {(() => {
          const tags = (groupsState?.tags ?? []).filter((tag) => tag.skillNames.includes(detail.name)).map((tag) => tag.name)
          return tags.length > 0 ? <div className={css.detailMetaLine}>{tt('detail.groups')}: {tags.join(', ')}</div> : null
        })()}
      </div>

      {detailSource !== undefined ? (
        <div className={css.sourceCard}>
          <div className={css.sourceCardTitle}>
            <a className={css.sourceLink} href={'https://github.com/' + detailSource.repo} target="_blank" rel="noreferrer">{detailSource.repo}</a>
            {detailSource.ref !== undefined ? <span className={css.badge + ' ' + css.badgeSource}>{detailSource.ref}</span> : null}
            <SourceStatusBadge check={detailCheck} />
          </div>
          <div className={css.detailMetaLine}>
            {tt('source.commit')}: {detailSource.commitSha === '' ? tt('source.unverified') : shortSha(detailSource.commitSha)}
          </div>
          <div className={css.buttons + ' ' + css.actionsTop}>
            <button type="button" className={css.opBtn} disabled={checkingSource !== null} onClick={() => { onCheck(detailSource.repo) }}>
              {checkingSource === detailSource.repo ? tt('source.checking') : tt('source.check')}
            </button>
            {disabled !== true ? (
              <>
                <button type="button" className={css.opBtn} disabled={syncingSource !== null} onClick={() => { onSync(detailSource.repo, [detail.name]) }}>
                  {syncingSource === detailSource.repo ? tt('source.syncing') : tt('source.sync')}
                </button>
                {detailCheck?.deleted.includes(detail.name) === true
                  ? <button type="button" className={css.opBtn + ' ' + css.opDanger} onClick={() => { onFollowDelete(detailSource.repo, [detail.name]) }}>{tt('source.followDelete')}</button>
                  : null}
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <p className={css.hintLine}>{tt('source.private')}</p>
      )}

      {loading ? <div className={css.muted}>{tt('detail.loading')}</div> : null}
      <pre className={css.detailContent}>{detail.content}</pre>
    </div>
  )
}
