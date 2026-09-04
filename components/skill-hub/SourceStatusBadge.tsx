/**
 * Source check-status badges.
 */

import type { JSX } from 'react';
import type { SourceCheckResult } from '@/lib/skill-hub/protocol';
import { tt } from './helpers';
import css from './panel.module.css';

export function SourceStatusBadge(props: {
  check: SourceCheckResult | undefined;
  checking?: boolean;
  onCheck?: () => void;
}): JSX.Element | null {
  const { check, checking, onCheck } = props;
  if (checking === true) {
    return <span className={css.statusBadge}>{tt('market.checking')}</span>;
  }
  if (check === undefined) {
    if (onCheck === undefined) return null;
    return (
      <button type="button" className={`${css.statusBadge} ${css.statusButton}`} onClick={onCheck}>
        {tt('market.checkUpdate')}
      </button>
    );
  }
  const badges = ((): JSX.Element | null => {
    if (check.error !== undefined) {
      return <span className={`${css.statusBadge} ${css.statusError}`}>Error</span>;
    }
    if (check.throttled === true) {
      return <span className={css.statusBadge}>Throttled</span>;
    }
    if (check.changed) {
      return (
        <span className={css.statusBadges}>
          {check.updated.length > 0 ? (
            <span className={`${css.statusBadge} ${css.statusUpdated}`}>
              {tt('market.updated')} ({check.updated.length})
            </span>
          ) : null}
          {check.deleted.length > 0 ? (
            <span className={`${css.statusBadge} ${css.statusError}`}>
              Deleted ({check.deleted.length})
            </span>
          ) : null}
        </span>
      );
    }
    return <span className={`${css.statusBadge} ${css.statusOk}`}>{tt('market.upToDate')}</span>;
  })();

  if (onCheck === undefined) return badges;
  return (
    <button type="button" className={css.statusWrap} onClick={onCheck}>
      {badges}
    </button>
  );
}
