import { Ban, CheckCircle2, CircleAlert } from "lucide-react";

/** Terminal/live status icon shared by the composer roster (SubagentHub), the
 * right-panel agent card (SubagentCard), and the in-message task summary
 * (MessageView), which previously each rendered their own copy.
 *
 * Terminal statuses always render a real status glyph (check / alert / ban) so
 * a finished agent reads as "done" rather than a mysterious marker. `live`
 * refines the "started" state: `true` = actively running (pulsing dot),
 * `false` = orphaned/history entry (plain running dot), omitted = plain running
 * dot (MessageView's mid-run snapshot). History entries (`live === false`) dim
 * the terminal glyphs to `--text-dim`. */
export function SubagentStatusIcon({ status, live, size = 12, strokeWidth = 2 }: {
  status: "started" | "completed" | "failed" | "aborted";
  live?: boolean;
  /** Icon box size for terminal lucide icons (default 12, matching the compact
   *  in-message roster). The composer hub passes 14 to match the Tasks bar. */
  size?: number;
  strokeWidth?: number;
}) {
  const props = { size, strokeWidth, "aria-hidden": true as const };
  const dimmed = live === false;
  if (status === "completed") return <CheckCircle2 {...props} color={dimmed ? "var(--text-dim)" : "var(--accent)"} />;
  if (status === "failed") return <CircleAlert {...props} color={dimmed ? "var(--text-dim)" : "var(--accent-strong)"} />;
  if (status === "aborted") return <Ban {...props} color="var(--text-dim)" />;
  if (live === true) {
    return <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />;
  }
  return <span aria-hidden className="live-status-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />;
}
