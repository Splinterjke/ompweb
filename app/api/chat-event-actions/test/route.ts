import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  ChatEventActionStoreError,
  createChatEventAction,
  getChatEventAction,
  removeChatEventAction,
  saveChatEventActionFile,
  validateActionSpec,
} from "@/lib/chat-event-action-store";
import { executeChatAction } from "@/lib/chat-event-actions-executors";
import type { ActionSpec, ChatActionRun } from "@/lib/chat-event-action-types";

const MAX_REQUEST_BYTES = 8_192;
// Bound a test run (mirrors the executors' own caps: 60s bash + 5s kill
// grace, 10s http).
const TEST_TIMEOUT_MS = 75_000;
const POLL_MS = 150;
async function waitForRun(id: string): Promise<ChatActionRun> {
  const start = Date.now();
  for (;;) {
    const run = getChatEventAction(id)?.lastRun;
    if (run) return run;
    if (Date.now() - start > TEST_TIMEOUT_MS) {
      return { at: new Date().toISOString(), ok: false, detail: `timeout after ${TEST_TIMEOUT_MS / 1000}s` };
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, POLL_MS);
    await promise;
  }
}

// POST /api/chat-event-actions/test
// body: { action: ActionSpec } — runs the spec once and returns its outcome.
// Used by the modal's "Test" button so a user can verify an action works
// before saving. The spec is written to a throwaway store entry, executed,
// read back, and deleted — nothing persists, and the real action's lastRun
// is never touched.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ action?: unknown }>(req, MAX_REQUEST_BYTES);
    let spec: ActionSpec;
    try {
      spec = validateActionSpec(body.action);
    } catch (err) {
      if (err instanceof ChatEventActionStoreError) {
        return NextResponse.json({ error: String(err), code: err.code }, { status: 400 });
      }
      throw err;
    }

    // Throwaway entry: createChatEventAction mints a unique id we then use to
    // read the result back, and delete it when done.
    const { file, action } = createChatEventAction({
      name: "__test__",
      events: ["conversation_completed"],
      action: spec,
      enabled: true,
    });
    saveChatEventActionFile(file);

    try {
      executeChatAction(action, { sessionId: "test", sessionName: "Test" });
      const run = await waitForRun(action.id);
      return NextResponse.json({ ok: run.ok, ...(run.detail ? { detail: run.detail } : {}) });
    } finally {
      // Always remove the throwaway entry, even on failure/timeout.
      const cur = getChatEventAction(action.id);
      if (cur) saveChatEventActionFile(removeChatEventAction(action.id));
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: String(error), code: "request_too_large" }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
