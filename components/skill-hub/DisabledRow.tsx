import { Tooltip } from "../ui/primitives";
/**
 * One disabled skill row (name + description + root badge + enable switch).
 */

import type { JSX, KeyboardEvent } from 'react';
import type { DisabledSkill, WritableRoot } from '@/lib/skill-hub/protocol';
import { tt } from './helpers';
import css from './panel.module.css';

function disabledSourceLabel(root: WritableRoot): string {
  switch (root) {
    case 'user-agents':
      return 'user-agents';
    case 'user-omp':
      return 'user-omp';
    case 'user-dsh':
      return 'user-dsh';
    case 'user-codex':
      return 'user-codex';
    case 'project-agents':
    case 'project-omp':
      return 'project-omp';
    default:
      return String(root);
  }
}

export function DisabledRow(props: {
  record: DisabledSkill;
  busy: boolean;
  onEnable: () => void;
  duplicate?: boolean;
  onOpen?: () => void;
}): JSX.Element {
  const { record, busy, onEnable, duplicate, onOpen } = props;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (onOpen === undefined || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      className={`${css.row} ${onOpen === undefined ? css.rowStatic : ''}`}
      role={onOpen === undefined ? undefined : 'button'}
      tabIndex={onOpen === undefined ? undefined : 0}
      aria-label={record.name}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <div className={css.rowMain}>
        <div className={css.rowName}>
          <span className={css.rowNameText}>{record.name}</span>
          {duplicate === true ? (
            <Tooltip content={tt('row.duplicateHint')}>
              <span className={`${css.badge} ${css.statusError}`} style={{ marginLeft: 6 }}>
              {tt('row.duplicate')}
            </span>
            </Tooltip>
          ) : null}
        </div>
        <div className={css.rowDesc}>
          {record.description}
        </div>
      </div>
      <span className={css.badges}>
        <span className={`${css.badge} ${css.badgeSource}`}>{disabledSourceLabel(record.root)}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={false}
        aria-label="Enable skill"
        className={css.switch}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onEnable();
        }}
      >
        <span className={css.switchThumb} />
      </button>
    </div>
  );
}
