"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, LoaderCircle, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { Field, NumInput, Select, TextInput, Textarea, Check } from "./ui/field";
import { toast } from "./ui/toast";
import { useI18n } from "@/lib/i18n";
import { createOmpwebClient } from "@/lib/client";
import { humanizeSchedule, type ScheduleSpec } from "@/lib/schedule";
import type { SchedulerWithState } from "@/lib/scheduler-types";
import { useIsMobile } from "@/hooks/useIsMobile";

// Script-scheduler calls go through the OmpWebClient facade (doc 16 route 1).
const client = createOmpwebClient("legacy-http");

const KINDS = ["manual", "interval", "daily", "weekdays", "weekly", "cron"] as const;
type ScheduleKind = (typeof KINDS)[number];
const UNIT_KEYS = ["minutes", "hours", "days"] as const;
type ScheduleUnitKey = (typeof UNIT_KEYS)[number];

function parseNum(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/** Map a server error `code` from /api/schedulers to a localized message. */
function errorText(t: (key: string) => string, code: string): string {
  const key = `schedulers.error.${code}`;
  const translated = t(key);
  return translated === key ? t("schedulers.error.generic") : translated;
}

export function SchedulerModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** When set, the modal edits this scheduler; otherwise it creates one. */
  initial: SchedulerWithState | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();

  const [name, setName] = useState("");
  const isMobile = useIsMobile();
  const [script, setScript] = useState("");
  const [args, setArgs] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("manual");
  const [every, setEvery] = useState("30");
  const [unit, setUnit] = useState<ScheduleUnitKey>("minutes");
  const [hour, setHour] = useState("09");
  const [minute, setMinute] = useState("00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [cronExpr, setCronExpr] = useState("");
  const [timeoutMin, setTimeoutMin] = useState("10");
  const [enabled, setEnabled] = useState(true);

  // Entry type: "script" (default) runs a script path; "prompt" runs `omp -p`.
  const [entryKind, setEntryKind] = useState<"script" | "prompt">("script");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [cwd, setCwd] = useState("");
  const [noSession, setNoSession] = useState(false);
  const [clearContext, setClearContext] = useState(false);
  const [compactContext, setCompactContext] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [models, setModels] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [projects, setProjects] = useState<{ path: string; alias?: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [scriptError, setScriptError] = useState<string | null>(null);
  const [checkingScript, setCheckingScript] = useState(false);
  const previewTimer = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ ok: boolean; human: string; nextRunAt: string | null } | null>(null);

  // (Re)initialize the form whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setEntryKind(initial.kind ?? "script");
      setScript(initial.script ?? "");
      setArgs(initial.args.join(" "));
      setPrompt(initial.prompt ?? "");
      setProvider(initial.provider ?? "");
      setModelId(initial.modelId ?? "");
      setCwd(initial.cwd ?? "");
      setNoSession(initial.noSession ?? false);
      setClearContext(initial.clearContext ?? false);
      setCompactContext(initial.compactContext ?? false);
      setPromptError(null);
      const s = initial.schedule;
      setKind(s.kind);
      if (s.kind === "interval") {
        setEvery(String(s.every));
        setUnit(s.unit);
      } else if (s.kind !== "cron" && s.kind !== "manual") {
        setHour(String(s.hour).padStart(2, "0"));
        setMinute(String(s.minute).padStart(2, "0"));
        if (s.kind === "weekly") setWeekdays(s.weekdays);
      }
      if (s.kind === "cron") setCronExpr(s.expr);
      // 0 = "never kill the run"; otherwise show whole minutes (min 1).
      setTimeoutMin(initial.timeoutMs === 0 ? "0" : String(Math.max(1, Math.round(initial.timeoutMs / 60_000))));
      setEnabled(initial.enabled);
    } else {
      setName("");
      setEntryKind("script");
      setScript("");
      setArgs("");
      setPrompt("");
      setProvider("");
      setModelId("");
      setNoSession(false);
      setCwd("");
      setClearContext(false);
      setCompactContext(false);
      setPromptError(null);
      setKind("manual");
      setEvery("30");
      setUnit("minutes");
      setHour("09");
      setMinute("00");
      setWeekdays([1, 2, 3, 4, 5]);
      setCronExpr("");
      setTimeoutMin("10");
      setEnabled(true);
    }
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setPreview(null);
  }, [open, initial]);

  // Load the model catalog and the managed-project list (workspace choices)
  // for the prompt-type dropdowns.
  useEffect(() => {
    if (!open || entryKind !== "prompt") return;
    let cancelled = false;
    setModelsLoading(true);
    fetch("/api/models", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setModels(Array.isArray(data?.modelList) ? data.modelList : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    let projectsCancelled = false;
    fetch("/api/projects", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (projectsCancelled) return;
        setProjects(Array.isArray(data?.projects) ? data.projects : []);
      })
      .catch(() => {
        if (!projectsCancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
      projectsCancelled = true;
    };
  }, [open, entryKind]);

  const buildSpec = (): ScheduleSpec | null => {
    const h = parseNum(hour);
    const m = parseNum(minute);
    const validTime = h !== null && h >= 0 && h <= 23 && m !== null && m >= 0 && m <= 59;
    switch (kind) {
      case "interval": {
        const n = parseNum(every);
        if (n === null || n < 1) return null;
        return { kind: "interval", every: n, unit };
      }
      case "daily":
        return validTime ? { kind: "daily", hour: h!, minute: m! } : null;
      case "weekdays":
        return validTime ? { kind: "weekdays", hour: h!, minute: m! } : null;
      case "weekly":
        return validTime && weekdays.length > 0 ? { kind: "weekly", hour: h!, minute: m!, weekdays } : null;
      case "cron":
        return cronExpr.trim() ? { kind: "cron", expr: cronExpr.trim() } : null;
      case "manual":
        return { kind: "manual" };
    }
  };

  // Live "next run" preview from the server (source of truth for cron).
  const spec = buildSpec();
  useEffect(() => {
    if (!open) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (kind === "manual") {
      setPreview(null);
      return;
    }
    if (!spec) {
      setPreview(null);
      return;
    }
    previewTimer.current = window.setTimeout(async () => {
      try {
        const data = await client.schedulers.preview(spec);
        setPreview(data);
      } catch {
        setPreview(null);
      }
    }, 350);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, every, unit, hour, minute, JSON.stringify(weekdays), cronExpr]);

  // Validate the script path against the server on blur.
  const checkScript = async () => {
    const trimmed = script.trim();
    if (!trimmed) {
      setScriptError(null);
      return;
    }
    setCheckingScript(true);
    try {
      await client.schedulers.validateScript(trimmed);
      setScriptError(null);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? "generic";
      setScriptError(errorText(t, code));
    } finally {
      setCheckingScript(false);
    }
  };

  const submit = async () => {
    const trimmedPrompt = prompt.trim();
    if (entryKind === "prompt" && !trimmedPrompt) {
      setPromptError(t("schedulers.error.instructions_required"));
      return;
    }
    const trimmed = script.trim();
    if (entryKind === "script" && !trimmed) {
      setScriptError(t("schedulers.error.script_required"));
      return;
    }
    if (!spec) {
      setPreview(null);
      return;
    }
    const timeoutNum = parseNum(timeoutMin);
    const timeoutMs = timeoutNum !== null && timeoutNum >= 0 ? timeoutNum * 60_000 : 10 * 60_000;
    const body = entryKind === "prompt"
      ? {
          name: name.trim() || undefined,
          kind: "prompt" as const,
          prompt: trimmedPrompt,
          provider: provider || undefined,
          modelId: modelId || undefined,
          cwd: cwd.trim(),
          noSession,
          clearContext,
          compactContext,
          schedule: spec,
          enabled,
          timeoutMs,
        }
      : {
          name: name.trim() || undefined,
          kind: "script" as const,
          script: trimmed,
          args: args.trim() ? args.trim().split(/\s+/) : [],
          schedule: spec,
          enabled,
          timeoutMs,
        };
    setSaving(true);
    try {
      if (initial) {
        await client.schedulers.update(initial.id, body);
      } else {
        await client.schedulers.create(body);
      }
      toast.success(t(initial ? "schedulers.toast.saved" : "schedulers.toast.created"));
      onSaved();
      onClose();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? "generic";
      toast.error(errorText(t, code));
    } finally {
      setSaving(false);
    }
  };

  // Localized weekday labels (0 = Sunday .. 6 = Saturday).
  const dayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // 2026-09-06 is a Sunday; offset from it.
    return Array.from({ length: 7 }, (_, d) => fmt.format(new Date(2026, 8, 6 + d)));
  }, [locale]);

  const timeFields = (
    <div style={{ display: "flex", gap: 8 }}>
      <div style={{ flex: 1 }}>
        <Field label={t("schedulers.time")}>
          <NumInput value={hour} onChange={setHour} invalid={parseNum(hour) === null || !(Number(hour) >= 0 && Number(hour) <= 23)} placeholder="09" />
        </Field>
      </div>
      <div style={{ flex: 1 }}>
        <Field label={t("schedulers.time")}>
          <NumInput value={minute} onChange={setMinute} invalid={parseNum(minute) === null || !(Number(minute) >= 0 && Number(minute) <= 59)} placeholder="00" />
        </Field>
      </div>
    </div>
  );

  const kindOptions = [
    t("schedulers.kind.manual"),
    t("schedulers.kind.interval"),
    t("schedulers.kind.daily"),
    t("schedulers.kind.weekdays"),
    t("schedulers.kind.weekly"),
    t("schedulers.kind.cron"),
  ];

  const unitOptions = UNIT_KEYS.map((k) => t(`schedulers.unit.${k}`));

  const entryKindOptions = [t("schedulers.type.script"), t("schedulers.type.prompt")];

  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of models) {
      if (!seen.has(m.provider)) {
        seen.add(m.provider);
        out.push(m.provider);
      }
    }
    return out;
  }, [models]);

  const modelOptions = useMemo(() => {
    const list = provider ? models.filter((m) => m.provider === provider) : models;
    return list.map((m) => ({
      value: m.provider ? `${m.provider}/${m.id}` : m.id,
      label: m.name || m.id,
    }));
  }, [models, provider]);

  // Managed projects as workspace choices; a saved cwd that is no longer in
  // the list (project removed) stays selectable so editing never drops it.
  const workspaceOptions = useMemo(() => {
    const opts = projects.map((p) => ({
      value: p.path,
      label: p.alias && p.alias.trim() ? `${p.alias.trim()} — ${p.path}` : p.path,
    }));
    if (cwd && !opts.some((o) => o.value === cwd)) opts.unshift({ value: cwd, label: cwd });
    return opts;
  }, [projects, cwd]);

  const nextRunText = useMemo(() => {
    if (!preview?.ok || !preview.nextRunAt) return null;
    const date = new Date(preview.nextRunAt);
    const withinWeek = date.getTime() - Date.now() < 7 * 86_400_000;
    const fmt = new Intl.DateTimeFormat(locale, withinWeek ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return fmt.format(date);
  }, [preview, locale]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent ariaLabel={t(initial ? "schedulers.editTitle" : "schedulers.addTitle")} style={{ width: "min(92vw, 480px)", ...(isMobile ? { maxHeight: "95dvh" } : {}) }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
          <DialogTitle style={{ margin: 0 }}>{t(initial ? "schedulers.editTitle" : "schedulers.addTitle")}</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("schedulers.cancel")}
            style={{ width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
          <Field label={t("schedulers.name")} hint={t("schedulers.nameHint")}>
            <TextInput
              value={name}
              onChange={setName}
              placeholder={t("schedulers.namePlaceholder")}
            />
          </Field>
          <Field label={t("schedulers.type")}>
            <Select
              value={entryKindOptions[entryKind === "prompt" ? 1 : 0]}
              onChange={(v) => {
                const idx = entryKindOptions.indexOf(v);
                if (idx >= 0) setEntryKind(idx === 1 ? "prompt" : "script");
              }}
              options={entryKindOptions}
            />
          </Field>

          {entryKind === "script" ? (
            <>
              <Field label={t("schedulers.script")} required hint={t("schedulers.scriptHint")}>
                <TextInput
                  value={script}
                  onChange={(v) => { setScript(v); setScriptError(null); }}
                  onBlurValidate={checkScript}
                  placeholder="/path/to/script.sh"
                  mono
                  invalid={Boolean(scriptError)}
                  error={checkingScript ? null : scriptError}
                />
              </Field>
              {checkingScript && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginTop: -8 }}>
                  <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
                  {t("schedulers.checkingScript")}
                </span>
              )}

              <Field label={t("schedulers.args")}>
                <TextInput value={args} onChange={setArgs} placeholder="--flag value" mono />
              </Field>
            </>
          ) : (
            <>
              <Field label={t("schedulers.instructions")} required hint={t("schedulers.instructionsHint")}>
                <Textarea
                  value={prompt}
                  onChange={(v) => { setPrompt(v); if (promptError) setPromptError(null); }}
                  placeholder={t("schedulers.instructionsPlaceholder")}
                  rows={5}
                  invalid={Boolean(promptError)}
                  error={promptError}
                />
              </Field>

              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label={t("schedulers.provider")}>
                    <Select
                      value={provider}
                      onChange={(v) => { setProvider(v); setModelId(""); }}
                      options={providerOptions}
                      placeholder={t("schedulers.providerPlaceholder")}
                      disabled={modelsLoading}
                    />
                  </Field>
                </div>
                <div style={{ flex: 1.4, minWidth: 0 }}>
                  <Field label={t("schedulers.model")}>
                    <Select
                      value={modelId}
                      onChange={setModelId}
                      options={modelOptions}
                      placeholder={t("schedulers.chooseModel")}
                      disabled={modelsLoading}
                    />
                  </Field>
                </div>
              </div>

              <Field label={t("schedulers.workspace")} hint={t("schedulers.workspaceHint")}>
                <Select
                  value={cwd}
                  onChange={setCwd}
                  options={workspaceOptions}
                  placeholder={t("schedulers.workspacePlaceholder")}
                />
              </Field>

              <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <Check label={t("schedulers.noSession")} checked={noSession} onChange={setNoSession} />
                  <span style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginLeft: 20, lineHeight: 1.4 }}>
                    {t("schedulers.noSessionDesc")}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <Check
                    label={t("schedulers.clearContext")}
                    checked={clearContext}
                    onChange={(v) => { setClearContext(v); if (v) setCompactContext(false); }}
                  />
                  <span style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginLeft: 20, lineHeight: 1.4 }}>
                    {t("schedulers.clearContextDesc")}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <Check
                    label={t("schedulers.compactContext")}
                    checked={compactContext}
                    onChange={(v) => { setCompactContext(v); if (v) setClearContext(false); }}
                    disabled={clearContext}
                  />
                  <span style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginLeft: 20, lineHeight: 1.4 }}>
                    {t("schedulers.compactContextDesc")}
                  </span>
                </div>
              </div>
            </>
          )}

          <Field label={t("schedulers.schedule")} required>
            <Select
              value={kindOptions[KINDS.indexOf(kind)]}
              onChange={(v) => {
                const idx = kindOptions.indexOf(v);
                if (idx >= 0) setKind(KINDS[idx]);
              }}
              options={kindOptions}
            />
          </Field>

          {kind === "interval" && (
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <Field label={t("schedulers.every")}>
                  <NumInput value={every} onChange={setEvery} placeholder="30" invalid={parseNum(every) === null || Number(every) < 1} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label={t("schedulers.unit")}>
                  <Select
                    value={unitOptions[UNIT_KEYS.indexOf(unit)]}
                    onChange={(v) => {
                      const idx = unitOptions.indexOf(v);
                      if (idx >= 0) setUnit(UNIT_KEYS[idx]);
                    }}
                    options={unitOptions}
                  />
                </Field>
              </div>
            </div>
          )}

          {(kind === "daily" || kind === "weekdays" || kind === "weekly") && timeFields}

          {kind === "weekly" && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {dayLabels.map((label, d) => {
                const active = weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setWeekdays((prev) => (active ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)))}
                    style={{
                      minWidth: 34,
                      height: 26,
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
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {kind === "cron" && (
            <Field label={t("schedulers.cronExpr")} hint={t("schedulers.cronHint")}>
              <TextInput value={cronExpr} onChange={setCronExpr} placeholder="0 9 * * 1-5" mono />
            </Field>
          )}

          {/* Live schedule description + next run from the server (not shown for manual). */}
          {kind !== "manual" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-subtle)",
              fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
              minHeight: 34,
            }}
          >
            <Clock size={13} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
            {spec ? (
              <>
                <span style={{ color: "var(--text)", fontWeight: 500 }}>{preview?.ok ? preview.human : humanizeSchedule(spec)}</span>
                {nextRunText && (
                  <span style={{ color: "var(--text-dim)" }}>
                    {t("schedulers.nextRun", { time: nextRunText })}
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: "var(--status-warning)" }}>{t("schedulers.invalidSchedule")}</span>
            )}
          </div>
          )}
          <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <Field label={t("schedulers.timeout")} hint={t("schedulers.timeoutHint")}>
                <NumInput value={timeoutMin} onChange={setTimeoutMin} placeholder="10" invalid={parseNum(timeoutMin) === null || Number(timeoutMin) < 0} />
              </Field>
            </div>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                color: "var(--text-muted)",
                cursor: "pointer",
                paddingBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
              />
              {t("schedulers.enabled")}
            </label>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button
            type="button"
            className="github-status-dialog-button"
            onClick={onClose}
            disabled={saving}
          >
            {t("schedulers.cancel")}
          </button>
          <button
            type="button"
            className="github-status-dialog-button github-status-dialog-primary"
            onClick={submit}
            disabled={saving || !spec}
          >
            {saving && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}
            {t(initial ? "schedulers.save" : "schedulers.add")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
