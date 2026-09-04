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
