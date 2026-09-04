/**
 * Group-header usage summary: invocation count chip + recent last-used time.
 */

import type { JSX } from 'react';
import { relativeTimeText } from './format';
import type { SkillHubState } from './useSkillHub';
import css from './panel.module.css';

export function GroupSummary(props: { members: readonly string[]; hub: SkillHubState }): JSX.Element {
  const { members, hub } = props;
  let total = 0;
  let latest: number | undefined;
  for (const name of members) {
    const stat = hub.uses.get(name);
    if (stat === undefined) continue;
    total += stat.count;
    if (stat.lastUsed !== undefined && (latest === undefined || stat.lastUsed > latest)) {
      latest = stat.lastUsed;
    }
  }
  return (
    <span className={css.groupTitleInner}>
      {total > 0 ? <span className={css.useCount}>{total}</span> : null}
      {latest !== undefined ? (
        <span className={`${css.useTime} ${css.groupTime}`}>{relativeTimeText(latest)}</span>
      ) : null}
    </span>
  );
}
