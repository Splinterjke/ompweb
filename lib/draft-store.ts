export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();

const listeners = new Set<() => void>();

// Replays text recovered from a dismissed/edited control back into the
// composer that owns the draft key, without clobbering pending edits.
const recoveryListeners = new Set<(key: string, text: string) => void>();

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
export function subscribeDraftRecovery(listener: (key: string, text: string) => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

/** Merge recovered text in front of the stored draft for `key` and notify
 *  recovery subscribers so the mounted composer can merge it into its live
 *  value (which may have newer edits than the store). */
export function recoverDraftText(key: string, text: string): void {
  if (!key || !text) return;
  const draft = getDraft(key) ?? { value: "", images: [] };
  setDraft(key, { ...draft, value: draft.value ? `${text}\n\n${draft.value}` : text });
  for (const listener of recoveryListeners) {
    try {
      listener(key, text);
    } catch {
      // A failing subscriber must not stop the others.
    }
  }
}
