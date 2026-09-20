import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  ChatEventActionStoreError,
  getChatEventAction,
  isValidActionId,
  patchChatEventAction,
  removeChatEventAction,
  saveChatEventActionFile,
} from "@/lib/chat-event-action-store";
import type { ActionSpec, ChatEventType } from "@/lib/chat-event-action-types";

const MAX_REQUEST_BYTES = 8_192;

function notFound(): NextResponse {
  return NextResponse.json({ error: "Chat event action not found", code: "not_found" }, { status: 404 });
}

// GET /api/chat-event-actions/[id]  →  { action: ChatEventAction }
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidActionId(id)) return notFound();
  const action = getChatEventAction(id);
  if (!action) return notFound();
  return NextResponse.json({ action });
}

// PATCH /api/chat-event-actions/[id]
// body: { name?, events?, action?, enabled? } — any subset, re-validated
// (the action spec is fully validated even when only `enabled` changes if
// `action` is present; an absent field keeps the stored value).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidActionId(id)) return notFound();
  try {
    const body = await parseJsonWithinLimit<{
      name?: unknown;
      events?: unknown;
      action?: unknown;
      enabled?: unknown;
    }>(req, MAX_REQUEST_BYTES);

    const patch: { name?: string; events?: ChatEventType[]; action?: ActionSpec; enabled?: boolean } = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (Array.isArray(body.events)) patch.events = body.events as ChatEventType[];
    if (body.action !== undefined) patch.action = body.action as ActionSpec;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

    const { file, action } = patchChatEventAction(id, patch);
    saveChatEventActionFile(file);
    return NextResponse.json({ action });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error instanceof ChatEventActionStoreError) {
      const code = error instanceof ChatEventActionStoreError ? error.code : "request_too_large";
      if (code === "not_found") return notFound();
      return NextResponse.json({ error: String(error), code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}

// DELETE /api/chat-event-actions/[id]  →  { success: true }
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidActionId(id)) return notFound();
  try {
    saveChatEventActionFile(removeChatEventAction(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ChatEventActionStoreError && error.code === "not_found") return notFound();
    return apiErrorResponse(error);
  }
}
