"use client";

import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Field, Select, TextInput } from "./ui/field";
import { detailNode, toast } from "./ui/toast";
import { useI18n } from "@/lib/i18n";
import { createOmpwebClient } from "@/lib/client";
import { CHAT_EVENT_TYPES, type ActionSpec, type ChatEventAction, type ChatEventType } from "@/lib/chat-event-action-types";
import type { SchedulerWithState } from "@/lib/scheduler-types";

// Chat event action calls go through the OmpWebClient facade (doc 01 contract).
const client = createOmpwebClient("legacy-http");

const ACTION_TYPES = ["notification", "http", "bash", "scheduled"] as const;
type ActionType = (typeof ACTION_TYPES)[number];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
const BODY_TYPES = ["json", "xml", "text"] as const;
type BodyType = (typeof BODY_TYPES)[number];

/** Map a server error `code` from /api/chat-event-actions to a localized
 * message (same pattern as SchedulerModal.errorText). */
function errorText(t: (key: string) => string, code: string): string {
  const key = `chatActions.error.${code}`;
  const translated = t(key);
  return translated === key ? t("chatActions.error.generic") : translated;
}

/** A textarea styled like the input shell, for multi-line fields. */
function TextArea({
  value,
  onChange,
  placeholder,
  mono,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        padding: "6px 9px",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        color: "var(--text)",
        fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
        outline: "none",
        width: "100%",
        boxSizing: "border-box",
        resize: "vertical",
        fontFamily: mono ? "var(--font-mono)" : undefined,
        transition: "border-color var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
      }}
    />
  );
}

export function EventActionModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** When set, the modal edits this action; otherwise it creates one. */
  initial: ChatEventAction | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();

  const [name, setName] = useState("");
  const [events, setEvents] = useState<ChatEventType[]>([]);
  const [actionType, setActionType] = useState<ActionType>("notification");
  // notification
  const [notifTitle, setNotifTitle] = useState("");
  const [notifMessage, setNotifMessage] = useState("");
  // http
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [bodyType, setBodyType] = useState<BodyType>("json");
  const [headers, setHeaders] = useState("");
  // bash
  const [scriptPath, setScriptPath] = useState("");
  const [scriptText, setScriptText] = useState("");
  // scheduled
  const [schedulerId, setSchedulerId] = useState("");
  const [enabled, setEnabled] = useState(true);

  const [schedulers, setSchedulers] = useState<SchedulerWithState[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const isMobile = useIsMobile();

  // (Re)initialize the form whenever the modal opens, and load the scheduler
  // list for the "scheduled script" action type.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setEvents(initial.events);
      const spec = initial.action;
      setActionType(spec.type);
      setNotifTitle(spec.type === "notification" ? spec.title ?? "" : "");
      setNotifMessage(spec.type === "notification" ? spec.message ?? "" : "");
      if (spec.type === "http") {
        setMethod(spec.method);
        setUrl(spec.url);
        setBody(spec.body ?? "");
        setBodyType(spec.bodyContentType ?? "json");
        setHeaders(spec.headers ?? "");
      }
      if (spec.type === "bash") {
        setScriptPath(spec.scriptPath ?? "");
        setScriptText(spec.scriptText ?? "");
      }
      setSchedulerId(spec.type === "scheduled" ? spec.schedulerId : "");
      setEnabled(initial.enabled);
    } else {
      setName("");
      setEvents([]);
      setActionType("notification");
      setNotifTitle("");
      setNotifMessage("");
      setMethod("GET");
      setUrl("");
      setBody("");
      setBodyType("json");
      setHeaders("");
      setScriptPath("");
      setScriptText("");
      setSchedulerId("");
      setEnabled(true);
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    void client.schedulers
      .list()
      .then((data) => setSchedulers(data.schedulers))
      .catch(() => setSchedulers([]));
  }, [open]);

  const toggleEvent = (ev: ChatEventType) => {
    setEvents((prev) => (prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]));
  };

  const buildSpec = (): ActionSpec | null => {
    switch (actionType) {
      case "notification": {
        const spec: ActionSpec = { type: "notification" };
        if (notifTitle.trim()) spec.title = notifTitle.trim();
        if (notifMessage.trim()) spec.message = notifMessage.trim();
        return spec;
      }
      case "http": {
        const trimmed = url.trim();
        if (!trimmed) return null;
        const spec: ActionSpec = { type: "http", method, url: trimmed };
        const postOrPut = method === "POST" || method === "PUT";
        if (postOrPut && body) {
          spec.body = body;
          spec.bodyContentType = bodyType;
        }
        if (headers.trim()) spec.headers = headers.trim();
        return spec;
      }
      case "bash": {
        const path = scriptPath.trim();
        const text = scriptText.trim();
        if (!path && !text) return null;
        const spec: ActionSpec = { type: "bash" };
        // Both set: the path wins (documented in the helper text).
        if (path) spec.scriptPath = path;
        else spec.scriptText = text;
        return spec;
      }
      case "scheduled": {
        if (!schedulerId) return null;
        return { type: "scheduled", schedulerId };
      }
    }
  };

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t("chatActions.error.name_required"));
      return;
    }
    if (events.length === 0) {
      toast.error(t("chatActions.error.events_required"));
      return;
    }
    const spec = buildSpec();
    if (!spec) {
      // A required field is blank; the server message is the source of truth,
      // but a local toast keeps the user from staring at nothing.
      const code =
        actionType === "http"
          ? "url_required"
          : actionType === "bash"
            ? "script_required"
            : actionType === "scheduled"
              ? "scheduler_required"
              : "generic";
      toast.error(errorText(t, code));
      return;
    }
    setSaving(true);
    try {
      if (initial) {
        await client.chatActions.update(initial.id, {
          name: name.trim() || undefined,
          events,
          action: spec,
          enabled,
        });
      } else {
        await client.chatActions.create({
          name: name.trim(),
          events,
          action: spec,
          enabled,
        });
        // First save of a notification action: the browser may need to
        // prompt for Notification permission (the frame arrives later).
        if (actionType === "notification" && typeof Notification !== "undefined" && Notification.permission === "default") {
          void Notification.requestPermission().catch(() => {});
        }
      }
      toast.success(t(initial ? "chatActions.toast.saved" : "chatActions.toast.created"));
      onSaved();
      onClose();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? "generic";
      toast.error(errorText(t, code));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    const spec = buildSpec();
    if (!spec) {
      const code =
        actionType === "http"
          ? "url_required"
          : actionType === "bash"
            ? "script_required"
            : actionType === "scheduled"
              ? "scheduler_required"
              : "generic";
      toast.error(errorText(t, code));
      return;
    }
    if (!client.chatActions.test) {
      toast.error(t("chatActions.error.generic"));
      return;
    }
    setTesting(true);
    try {
      const result = await client.chatActions.test({ action: spec });
      if (result.ok) {
        toast.success(t("chatActions.testOk"), result.detail ? detailNode(result.detail) : undefined);
      } else {
        toast.error(t("chatActions.testFail"), result.detail ? detailNode(result.detail) : undefined);
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? "generic";
      toast.error(errorText(t, code));
    } finally {
      setTesting(false);
    }
  };

  const actionOptions = ACTION_TYPES.map((k) => t(`chatActions.action.${k}`));
  const methodOptions = HTTP_METHODS as readonly string[];
  const schedOptions = useMemo(
    () => (schedulers.length === 0 ? [] : schedulers.map((s) => `${s.name} — ${s.human}`)),
    [schedulers],
  );
  const postOrPut = method === "POST" || method === "PUT";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent ariaLabel={t(initial ? "chatActions.editTitle" : "chatActions.addTitle")} style={{ width: "min(92vw, 520px)", ...(isMobile ? { maxHeight: "95dvh" } : {}) }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
          <DialogTitle style={{ margin: 0 }}>{t(initial ? "chatActions.editTitle" : "chatActions.addTitle")}</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chatActions.cancel")}
            style={{ width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12, maxHeight: isMobile ? "95dvh" : "min(72vh, 680px)", overflowY: "auto" }}>
          {/* 1st line: name */}
          <Field label={t("chatActions.name")} required>
            <TextInput value={name} onChange={setName} placeholder={t("chatActions.namePlaceholder")} />
          </Field>

          {/* 2nd line: event selection (7 checkboxes, 2-column wrap grid) */}
          <Field label={t("chatActions.events")} required hint={t("chatActions.eventsHint")}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px" }}>
              {CHAT_EVENT_TYPES.map((ev) => (
                <label
                  key={ev}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)", cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={events.includes(ev)}
                    onChange={() => toggleEvent(ev)}
                    style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
                  />
                  {t(`chatActions.event.${ev}`)}
                </label>
              ))}
            </div>
          </Field>

          {/* 3rd line: action type */}
          <Field label={t("chatActions.action")} required>
            <Select
              value={actionOptions[ACTION_TYPES.indexOf(actionType)]}
              onChange={(v) => {
                const idx = actionOptions.indexOf(v);
                if (idx >= 0) setActionType(ACTION_TYPES[idx]);
              }}
              options={actionOptions}
            />
          </Field>

          {/* Conditional controls per action type */}
          {actionType === "notification" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label={t("chatActions.notifTitle")} hint={t("chatActions.notifTitleHint")}>
                <TextInput value={notifTitle} onChange={setNotifTitle} placeholder="e.g. Build finished" />
              </Field>
              <Field label={t("chatActions.notifMessage")} hint={t("chatActions.notifMessageHint")}>
                <TextArea value={notifMessage} onChange={setNotifMessage} rows={2} placeholder="e.g. Task finished." />
              </Field>
              <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", lineHeight: 1.5 }}>{t("chatActions.notifPermHint")}</span>
            </div>
          )}

          {actionType === "http" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ width: 110, flexShrink: 0 }}>
                  <Field label={t("chatActions.httpMethod")}>
                    <Select
                      value={methodOptions[HTTP_METHODS.indexOf(method)]}
                      onChange={(v) => {
                        const idx = methodOptions.indexOf(v);
                        if (idx >= 0) setMethod(HTTP_METHODS[idx]);
                      }}
                      options={methodOptions}
                    />
                  </Field>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label={t("chatActions.httpUrl")} required>
                    <TextInput value={url} onChange={setUrl} placeholder="https://example.com/hook" mono invalid={url !== "" && !/^https?:\/\/\S+$/.test(url.trim())} />
                  </Field>
                </div>
              </div>
              {postOrPut && (
                <>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", alignSelf: "center" }}>{t("chatActions.httpBody")}:</span>
                    {BODY_TYPES.map((bt) => {
                      const active = bodyType === bt;
                      return (
                        <button
                          key={bt}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setBodyType(bt)}
                          style={{
                            minWidth: 40,
                            height: 24,
                            padding: "0 8px",
                            fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                            fontWeight: 500,
                            border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "var(--border)"}`,
                            borderRadius: "var(--radius-control)",
                            background: active ? "color-mix(in srgb, var(--accent) 14%, var(--bg-panel))" : "var(--bg-panel)",
                            color: active ? "var(--accent-strong)" : "var(--text-muted)",
                            cursor: "pointer",
                          }}
                        >
                          {bt}
                        </button>
                      );
                    })}
                  </div>
                  <Field label={t("chatActions.httpBody")}>
                    <TextArea value={body} onChange={setBody} rows={3} mono placeholder="{&quot;key&quot;: &quot;value&quot;}" />
                  </Field>
                </>
              )}
              <Field label={t("chatActions.httpHeaders")} hint={t("chatActions.httpHeadersHint")}>
                <TextArea value={headers} onChange={setHeaders} rows={2} mono placeholder="Content-Type: application/json" />
              </Field>
            </div>
          )}

          {actionType === "bash" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label={t("chatActions.scriptPath")} hint={t("chatActions.scriptPathHint")}>
                <TextInput value={scriptPath} onChange={setScriptPath} placeholder="/path/to/script.sh" mono />
              </Field>
              <Field label={t("chatActions.scriptText")} hint={t("chatActions.scriptTextHint")}>
                <TextArea value={scriptText} onChange={setScriptText} rows={4} mono placeholder={"#!/bin/sh\necho done"} />
              </Field>
            </div>
          )}

          {actionType === "scheduled" && (
            <Field label={t("chatActions.scheduledPick")} required hint={t("chatActions.scheduledHint")}>
              <Select
                value={schedOptions[schedulers.findIndex((s) => s.id === schedulerId)] ?? ""}
                onChange={(v) => {
                  const idx = schedOptions.indexOf(v);
                  if (idx >= 0) setSchedulerId(schedulers[idx].id);
                }}
                options={schedulers.length === 0 ? [""] : schedOptions}
                required
                placeholder={schedulers.length === 0 ? t("chatActions.loading") : t("chatActions.error.scheduler_required")}
                invalid={schedulers.length > 0 && schedulerId === ""}
              />
            </Field>
          )}

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            {t("chatActions.enabled")}
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button
            type="button"
            className="github-status-dialog-button"
            onClick={() => void runTest()}
            disabled={testing || saving}
          >
            {testing && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}
            {t("chatActions.test")}
          </button>
          <button
            type="button"
            className="github-status-dialog-button"
            onClick={onClose}
            disabled={saving}
          >
            {t("chatActions.cancel")}
          </button>
          <button
            type="button"
            className="github-status-dialog-button github-status-dialog-primary"
            onClick={() => void submit()}
            disabled={saving || events.length === 0}
          >
            {saving && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}
            {t(initial ? "chatActions.save" : "chatActions.add")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
