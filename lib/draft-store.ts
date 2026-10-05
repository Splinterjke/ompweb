export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

/** Content to put back in a composer. `replace` merges a later recovery with
 *  an earlier one in order: while the draft still starts with `lead` (the
 *  earlier block), it becomes `text`; otherwise only `fallback` is prepended.
 *  `images` are appended to the draft's attachments. */
export interface DraftRecovery {
  text: string;
  replace?: { lead: string; fallback: string };
  images?: ChatDraftImage[];
}

/** The `{ data, mimeType }` images in an omp RPC payload; anything else is dropped. */
export function toDraftImages(value: unknown): ChatDraftImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image: unknown) => (
    image && typeof image === "object" && "data" in image && "mimeType" in image
      && typeof image.data === "string" && typeof image.mimeType === "string"
      ? [{ data: image.data, mimeType: image.mimeType }]
      : []
  ));
}

export function mergeRecoveredText(current: string, { text, replace }: DraftRecovery): string {
  if (!text) return current;
  if (replace && current.startsWith(replace.lead)) return text + current.slice(replace.lead.length);
  const lead = replace ? replace.fallback : text;
  return current ? `${lead}\n\n${current}` : lead;
}

const drafts = new Map<string, ChatDraft>();

const listeners = new Set<() => void>();

// Replays text recovered from a dismissed/edited control back into the
// composer that owns the draft key, without clobbering pending edits.
const recoveryListeners = new Set<(key: string, recovery: DraftRecovery) => void>();

/** Whether any unsent draft exists — used to guard the PWA Back button. */
export function hasUnsentDrafts(): boolean {
  return drafts.size > 0;
}

/** Subscribe to draft mutations (add/update/clear); returns an unsubscribe. */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}


export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
  } else {
    drafts.set(key, cloneDraft(draft));
  }
  for (const listener of listeners) listener();
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  for (const listener of listeners) listener();
}

/** Subscribe to draft text recovery (question answers / edited queued
 *  messages returned to the composer); returns an unsubscribe. */
export function subscribeDraftRecovery(listener: (key: string, recovery: DraftRecovery) => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

/** Merge recovered text in front of the stored draft for `key` and notify
 *  recovery subscribers so the mounted composer can merge it into its live
 *  value (which may have newer edits than the store). */
export function recoverDraft(key: string, recovery: DraftRecovery): void {
  if (key) {
    const draft = getDraft(key) ?? { value: "", images: [] };
    setDraft(key, {
      ...draft,
      value: mergeRecoveredText(draft.value, recovery),
      images: [...draft.images, ...(recovery.images ?? [])],
    });
  }
  // Publish the recovery intent separately: ordinary persistence must not
  // reapply it, and the mounted composer may have React updates still queued.
  for (const listener of recoveryListeners) {
    try {
      listener(key, recovery);
    } catch {
      // A failing subscriber must not stop the others.
    }
  }
}
