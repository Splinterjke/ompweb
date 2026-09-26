import { Tooltip } from "../ui/primitives";
/**
 * One enabled skill row: name + invocation dots + usage meta, delete and disable actions.
 */

import type { JSX, KeyboardEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { CatalogSkill } from '@/lib/skill-hub/protocol';
import { isDisplayNameDistinct, tt } from './helpers';
import { dotStyle, relativeTimeText } from './format';
import type { SkillHubState } from './useSkillHub';
import css from './panel.module.css';

export function SkillRow(props: { skill: CatalogSkill; hub: SkillHubState }): JSX.Element {
  const { skill, hub } = props;
  const stat = hub.uses.get(skill.name);
  const count = stat?.count ?? 0;
  const lastUsed = stat?.lastUsed;
  const isDuplicate = hub.catalog?.duplicateNames?.includes(skill.name) === true;

  const dot = skill.invocation.modelInvocable ? (
    <span
      className={`${css.dot} ${css.dotModel}`}
      style={dotStyle(hub.hubConfig?.dotModelColor)}
      aria-label={tt('legend.model')}
    />
  ) : skill.invocation.userInvocable ? (
    <span
      className={`${css.dot} ${css.dotUser}`}
      style={dotStyle(hub.hubConfig?.dotUserColor)}
      aria-label={tt('legend.user')}
    />
  ) : null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void hub.openDetail(skill.name);
    }
  };

  return (
    <div
      className={css.row}
      role="button"
      tabIndex={0}
      aria-label={skill.name}
      onClick={() => {
        void hub.openDetail(skill.name);
      }}
      onKeyDown={onKeyDown}
    >
      <div className={css.rowMain}>
        <div className={css.rowName}>
          <span className={css.rowNameText}>{skill.name}</span>
          {isDisplayNameDistinct(skill.name, skill.displayName) ? (
            <span className={css.displayName}>
              {skill.displayName}
            </span>
          ) : null}
          {count > 0 ? <span className={css.useCount}>{count}</span> : null}
          {dot}
          {isDuplicate ? (
            <Tooltip content={tt('row.duplicateHint')}>
              <span className={`${css.badge} ${css.statusError}`}>
              {tt('row.duplicate')}
            </span>
            </Tooltip>
          ) : null}
          {skill.priority ? (
            <Tooltip content={tt('row.duplicateHint')}>
              <span className={`${css.badge} ${css.badgePriority}`} style={{ marginLeft: 6 }}>
              {tt('row.priority')}
            </span>
            </Tooltip>
          ) : null}
          {lastUsed !== undefined ? (
            <span className={css.useTime}>{relativeTimeText(lastUsed)}</span>
          ) : null}
        </div>
        <div className={css.rowDesc}>
          {skill.shortDescription ?? skill.description}
        </div>
      </div>
      {skill.writable ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            role="switch"
            aria-checked={true}
            aria-label="Disable skill"
            className={`${css.switch} ${css.switchOn}`}
            disabled={hub.busyNames.has(skill.name)}
            onClick={(event) => {
              event.stopPropagation();
              void hub.toggle(skill, false);
            }}
          >
            <span className={css.switchThumb} />
          </button>
          {hub.editMode ? (
            <button
              type="button"
              className={`${css.opBtn} ${css.opDanger} ${css.iconBtn}`}
              disabled={hub.busyNames.has(skill.name) || hub.tagBusy}
              aria-label="Delete skill"
              onClick={(event) => {
                event.stopPropagation();
                hub.requestDeleteSkill(skill.name);
              }}
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
      ) : (
        <span className={`${css.badge} ${css.badgeReadonly}`}>{tt('row.readonly')}</span>
      )}
    </div>
  );
}
