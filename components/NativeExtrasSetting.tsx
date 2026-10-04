"use client";

import { useI18n } from "@/lib/i18n";
import type { NativeSettings } from "@/lib/omp/settings-config";
import { Check } from "./ui/field";

interface Props {
  settings: NativeSettings;
  /** Patch top-level native settings (merged by the parent). */
  onPatch: (patch: Partial<NativeSettings>) => void;
  /** Patch a nested section (e.g. generateImage: { enabled }) */
  onPatchSection: (key: keyof NativeSettings, patch: Record<string, unknown>) => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
};

const cardStyle: React.CSSProperties = {
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

/** Native OMP internal settings that live in config.yml but were not yet
 *  surfaced in the UI: model roles, feature toggles, and advanced strings. */
export function NativeExtrasSetting({ settings, onPatch, onPatchSection }: Props) {
  const { t } = useI18n();

  const toggle = (key: keyof NativeSettings, value: boolean) => onPatch({ [key]: value } as Partial<NativeSettings>);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
      <div style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("settingsConfig.internalSettings")}</div>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>{t("settingsConfig.internalSettingsDesc")}</p>

      {/* Feature toggles */}
      <div style={cardStyle}>
        <span style={{ fontSize: "calc(12.5px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("settingsConfig.featureToggles")}</span>
        <Check checked={settings.generateImage?.enabled ?? true} onChange={(v) => onPatchSection("generateImage", { enabled: v })} label={t("settingsConfig.generateImageEnabled")} />
        <Check checked={settings.computer?.enabled ?? true} onChange={(v) => onPatchSection("computer", { enabled: v })} label={t("settingsConfig.computerEnabled")} />
        <Check checked={settings.security?.enabled ?? false} onChange={(v) => onPatchSection("security", { enabled: v })} label={t("settingsConfig.securityEnabled")} />
        <Check checked={settings.github?.enabled ?? true} onChange={(v) => onPatchSection("github", { enabled: v })} label={t("settingsConfig.githubEnabled")} />
        <Check checked={settings.colorBlindMode ?? false} onChange={(v) => toggle("colorBlindMode", v)} label={t("settingsConfig.colorBlindMode")} />
        <Check checked={settings.contextPromotion?.enabled ?? false} onChange={(v) => onPatchSection("contextPromotion", { enabled: v })} label={t("settingsConfig.contextPromotionEnabled")} />
        <Check checked={settings.snapcompact?.toolResults ?? false} onChange={(v) => onPatchSection("snapcompact", { toolResults: v })} label={t("settingsConfig.snapcompactToolResults")} />
        <Check checked={settings.bash?.autoBackground?.enabled ?? true} onChange={(v) => onPatchSection("bash", { autoBackground: { enabled: v } })} label={t("settingsConfig.bashAutoBackgroundEnabled")} />
        <Check checked={settings.task?.speculativeLaunch ?? true} onChange={(v) => onPatchSection("task", { speculativeLaunch: v })} label={t("settingsConfig.speculativeLaunch")} />
        <Check checked={settings.display?.subagentLivePreview ?? false} onChange={(v) => onPatchSection("display", { subagentLivePreview: v })} label={t("settingsConfig.subagentLivePreview")} />
        <Check checked={settings.telemetry?.otlpExportEnabled ?? true} onChange={(v) => onPatchSection("telemetry", { otlpExportEnabled: v })} label={t("settingsConfig.otlpExportEnabled")} />
        <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginTop: 2 }}>{t("settingsConfig.skillCompat")}</span>
        <Check checked={settings.skills?.enableCodexUser ?? false} onChange={(v) => onPatchSection("skills", { enableCodexUser: v })} label={t("settingsConfig.enableCodexUser")} />
        <Check checked={settings.skills?.enableAgentsUser ?? false} onChange={(v) => onPatchSection("skills", { enableAgentsUser: v })} label={t("settingsConfig.enableAgentsUser")} />
        <Check checked={settings.skills?.enableClaudeUser ?? false} onChange={(v) => onPatchSection("skills", { enableClaudeUser: v })} label={t("settingsConfig.enableClaudeUser")} />
        <Check checked={settings.skills?.enableClaudeProject ?? false} onChange={(v) => onPatchSection("skills", { enableClaudeProject: v })} label={t("settingsConfig.enableClaudeProject")} />
      </div>
      {/* Goal mode: drives the composer goal bar and native goal continuations */}
      <div style={cardStyle}>
        <span style={{ fontSize: "calc(12.5px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("settingsConfig.goalSection")}</span>
        <Check checked={settings.goal?.enabled ?? false} onChange={(v) => onPatchSection("goal", { enabled: v })} label={t("settingsConfig.goalEnabled")} />
        <Check checked={settings.goal?.statusInFooter ?? false} onChange={(v) => onPatchSection("goal", { statusInFooter: v })} label={t("settingsConfig.goalStatusInFooter")} />
        <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginTop: 2 }}>{t("settingsConfig.goalContinuationModes")}</span>
        {(["interactive", "rpc"] as const).map((mode) => {
          const modes = settings.goal?.continuationModes ?? ["interactive"];
          return (
            <Check
              key={mode}
              checked={modes.includes(mode)}
              onChange={(v) => {
                const next = v ? Array.from(new Set([...modes, mode])) : modes.filter((m) => m !== mode);
                onPatchSection("goal", { continuationModes: next.length > 0 ? next : ["interactive"] });
              }}
              label={mode === "interactive" ? t("settingsConfig.goalContinuationInteractive") : t("settingsConfig.goalContinuationRpc")}
            />
          );
        })}
      </div>

      {/* Advanced strings */}
      <div style={cardStyle}>
        <span style={{ fontSize: "calc(12.5px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("settingsConfig.advancedStrings")}</span>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)" }}>
          {t("settingsConfig.artifactMaxBytes")}
          <input
            type="number"
            min={0}
            max={1024}
            step={1}
            defaultValue={settings.tools?.artifactMaxBytes ?? ""}
            placeholder="16"
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const current = settings.tools?.artifactMaxBytes;
              if (raw === "") {
                if (current !== undefined) onPatchSection("tools", { artifactMaxBytes: 16 });
                return;
              }
              const value = Number(raw);
              if (Number.isInteger(value) && value >= 0 && value <= 1024 && value !== current) onPatchSection("tools", { artifactMaxBytes: value });
            }}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)" }}>
          {t("settingsConfig.cacheWarming")}
          <select
            value={settings.providers?.cacheWarming ?? "idle"}
            onChange={(e) => onPatchSection("providers", { cacheWarming: e.target.value as "off" | "streaming" | "idle" })}
            style={inputStyle}
          >
            <option value="off">{t("settingsConfig.cacheWarmingOff")}</option>
            <option value="streaming">{t("settingsConfig.cacheWarmingStreaming")}</option>
            <option value="idle">{t("settingsConfig.cacheWarmingIdle")}</option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)" }}>
          {t("settingsConfig.editMode")}
          <input
            type="text"
            defaultValue={settings.edit?.mode ?? ""}
            placeholder="hashline"
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== (settings.edit?.mode ?? "")) onPatchSection("edit", { mode: value || null });
            }}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)" }}>
          {t("settingsConfig.composerShape")}
          <input
            type="text"
            defaultValue={settings.composer?.shape ?? ""}
            placeholder="box"
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== (settings.composer?.shape ?? "")) onPatchSection("composer", { shape: value || null });
            }}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)" }}>
          {t("settingsConfig.autoqaConsent")}
          <input
            type="text"
            defaultValue={settings.dev?.autoqaConsent ?? ""}
            placeholder="granted"
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== (settings.dev?.autoqaConsent ?? "")) onPatchSection("dev", { autoqaConsent: value || null });
            }}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)" }}>
          {t("settingsConfig.symbolPreset")}
          <input
            type="text"
            defaultValue={settings.symbolPreset ?? ""}
            placeholder="unicode"
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== (settings.symbolPreset ?? "")) onPatch({ symbolPreset: value || null });
            }}
            style={inputStyle}
          />
        </label>
      </div>
    </section>
  );
}
