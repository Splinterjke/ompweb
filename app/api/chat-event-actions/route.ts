import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ChatEventActionStoreError, createChatEventAction, listChatEventActions, saveChatEventActionFile } from "@/lib/chat-event-action-store";
import type { ActionSpec, ChatEventType } from "@/lib/chat-event-action-types";

const MAX_REQUEST_BYTES = 8_192;

// GET /api/chat-event-actions  →  { actions: ChatEventAction[] }
export async function GET() {
  try {
    return NextResponse.json({ actions: listChatEventActions() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/chat-event-actions
// body: { name, events, action, enabled? }
// Validates the name, the event list, and the action spec (http url/method,
// bash script, scheduled id) and returns the created entry. 400 on any
// validation failure with a stable `code` (chatActions.error.* key).
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{
      name?: unknown;
      events?: unknown;
      action?: unknown;
      enabled?: unknown;
    }>(req, MAX_REQUEST_BYTES);

    const { file, action } = createChatEventAction({
      name: typeof body.name === "string" ? body.name : "",
      events: (Array.isArray(body.events) ? body.events : []) as ChatEventType[],
      action: body.action as ActionSpec,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    saveChatEventActionFile(file);
    return NextResponse.json({ action }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error instanceof ChatEventActionStoreError) {
      const code = error instanceof ChatEventActionStoreError ? error.code : "request_too_large";
      return NextResponse.json({ error: String(error), code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
