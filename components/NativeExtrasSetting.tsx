"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n";
import type { NativeSettings, TinyModelDevice, TinyModelDtype } from "@/lib/omp/settings-config";
import { ToggleSwitch } from "./ui/field";

interface Props {
  settings: NativeSettings;
  /** The curated native settings fetch is in flight: render a placeholder. */
  loading?: boolean;
  /** The fetch failed and there is no data to render. */
  error?: string | null;
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

const cardTitleStyle: React.CSSProperties = {
  fontSize: "calc(12.5px * var(--ui-font-scale-lg, 1))",
  fontWeight: 600,
};

const subHeadingStyle: React.CSSProperties = {
  fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
  color: "var(--text-dim)",
  marginTop: 2,
};

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
  color: "var(--text-muted)",
};

/** `providers.tinyModelDevice` choices, mirroring omp's own picker. */
const TINY_DEVICE_OPTIONS: ReadonlyArray<{ value: TinyModelDevice; label: string }> = [
  { value: "default", label: "Default (CPU-only ONNX)" },
  { value: "gpu", label: "GPU (WebGPU/Metal/CUDA/DirectML)" },
  { value: "cpu", label: "CPU" },
  { value: "mlx", label: "MLX (Apple silicon, macOS arm64)" },
  { value: "metal", label: "Metal (alias for MLX)" },
  { value: "webgpu", label: "WebGPU" },
  { value: "cuda", label: "CUDA (Linux x64)" },
  { value: "dml", label: "DirectML (Windows)" },
  { value: "coreml", label: "CoreML (opt-in)" },
  { value: "auto", label: "Auto (ONNX Runtime chooses)" },
  { value: "wasm", label: "WASM" },
  { value: "webnn", label: "WebNN" },
  { value: "webnn-gpu", label: "WebNN GPU" },
  { value: "webnn-cpu", label: "WebNN CPU" },
  { value: "webnn-npu", label: "WebNN NPU" },
];

/** `providers.tinyModelDtype` choices, mirroring omp's own picker. */
const TINY_DTYPE_OPTIONS: ReadonlyArray<{ value: TinyModelDtype; label: string }> = [
  { value: "default", label: "Default (shipped dtype, q4)" },
  { value: "q4", label: "q4 (smallest, fastest)" },
  { value: "q4f16", label: "q4f16" },
  { value: "q8", label: "q8" },
  { value: "fp16", label: "fp16" },
  { value: "fp32", label: "fp32" },
  { value: "int8", label: "int8" },
  { value: "uint8", label: "uint8" },
  { value: "bnb4", label: "bnb4" },
  { value: "q2", label: "q2" },
  { value: "q2f16", label: "q2f16" },
  { value: "q1", label: "q1" },
  { value: "q1f16", label: "q1f16" },
  { value: "auto", label: "Auto" },
];

/** One setting row: label + what it does on the left, switch on the right. */
function SwitchRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const labelId = useId();
  const descId = useId();
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <span id={labelId} style={cardTitleStyle}>{label}</span>
        <span id={descId} style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)", lineHeight: 1.45 }}>{description}</span>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} aria-labelledby={labelId} aria-describedby={descId} />
    </div>
  );
}

/** Native OMP internal settings that live in config.yml but were not yet
 *  surfaced in the UI: feature toggles, the goal continuation knob, and
 *  advanced strings. */
export function NativeExtrasSetting({ settings, loading = false, error = null, onPatch, onPatchSection }: Props) {
  const { t } = useI18n();

  const toggle = (key: keyof NativeSettings, value: boolean) => onPatch({ [key]: value } as Partial<NativeSettings>);

  const hasData = Object.keys(settings).length > 0;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
      <div style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("settingsConfig.internalSettings")}</div>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>{t("settingsConfig.internalSettingsDesc")}</p>

      {loading ? (
        <div role="status" style={{ ...cardStyle, color: "var(--text-muted)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>
          {t("settingsConfig.internalSettingsLoading")}
        </div>
      ) : !hasData ? (
        <div role="status" style={{ ...cardStyle, color: "var(--text-muted)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>
          {t("settingsConfig.internalSettingsError")}{error ? ` (${error})` : ""}
        </div>
      ) : (
        <>
          {/* Feature toggles */}
          <div style={cardStyle}>
            <span style={cardTitleStyle}>{t("settingsConfig.featureToggles")}</span>
            <SwitchRow
              label={t("settingsConfig.generateImageEnabled")}
              description={t("settingsConfig.generateImageEnabledDesc")}
              checked={settings.generateImage?.enabled ?? true}
              onChange={(v) => onPatchSection("generateImage", { enabled: v })}
            />
            <SwitchRow
              label={t("settingsConfig.computerEnabled")}
              description={t("settingsConfig.computerEnabledDesc")}
              checked={settings.computer?.enabled ?? true}
              onChange={(v) => onPatchSection("computer", { enabled: v })}
            />
            <SwitchRow
              label={t("settingsConfig.securityEnabled")}
              description={t("settingsConfig.securityEnabledDesc")}
              checked={settings.security?.enabled ?? false}
              onChange={(v) => onPatchSection("security", { enabled: v })}
            />
            <SwitchRow
              label={t("settingsConfig.githubEnabled")}
              description={t("settingsConfig.githubEnabledDesc")}
              checked={settings.github?.enabled ?? true}
              onChange={(v) => onPatchSection("github", { enabled: v })}
            />
            <SwitchRow
              label={t("settingsConfig.colorBlindMode")}
              description={t("settingsConfig.colorBlindModeDesc")}
              checked={settings.colorBlindMode ?? false}
              onChange={(v) => toggle("colorBlindMode", v)}
            />
            <SwitchRow
              label={t("settingsConfig.contextPromotionEnabled")}
              description={t("settingsConfig.contextPromotionEnabledDesc")}
              checked={settings.contextPromotion?.enabled ?? false}
              onChange={(v) => onPatchSection("contextPromotion", { enabled: v })}
            />
            <SwitchRow
              label={t("settingsConfig.snapcompactToolResults")}
              description={t("settingsConfig.snapcompactToolResultsDesc")}
              checked={settings.snapcompact?.toolResults ?? false}
              onChange={(v) => onPatchSection("snapcompact", { toolResults: v })}
            />
            <SwitchRow
              label={t("settingsConfig.bashAutoBackgroundEnabled")}
              description={t("settingsConfig.bashAutoBackgroundEnabledDesc")}
              checked={settings.bash?.autoBackground?.enabled ?? true}
              onChange={(v) => onPatchSection("bash", { autoBackground: { enabled: v } })}
            />
            <SwitchRow
              label={t("settingsConfig.speculativeLaunch")}
              description={t("settingsConfig.speculativeLaunchDesc")}
              checked={settings.task?.speculativeLaunch ?? true}
              onChange={(v) => onPatchSection("task", { speculativeLaunch: v })}
            />
            <SwitchRow
              label={t("settingsConfig.otlpExportEnabled")}
              description={t("settingsConfig.otlpExportEnabledDesc")}
              checked={settings.telemetry?.otlpExportEnabled ?? true}
              onChange={(v) => onPatchSection("telemetry", { otlpExportEnabled: v })}
            />
            {/* Goal continuation. Only the web knob is offered: "interactive"
                is the TUI process's own mode and is preserved on every write
                — managing it from a web page would silently change TUI
                behavior the user is not looking at. */}
            <SwitchRow
              label={t("settingsConfig.goalAutonomous")}
              description={t("settingsConfig.goalAutonomousDesc")}
              checked={(settings.goal?.continuationModes ?? ["interactive"]).includes("rpc")}
              onChange={(v) => {
                const modes = settings.goal?.continuationModes ?? ["interactive"];
                const next = v ? Array.from(new Set([...modes, "rpc"])) : modes.filter((m) => m !== "rpc");
                onPatchSection("goal", { continuationModes: next.length > 0 ? next : ["interactive"] });
              }}
            />
            <span style={subHeadingStyle}>{t("settingsConfig.skillCompat")}</span>
            <SwitchRow
              label={t("settingsConfig.enableCodexUser")}
              description={t("settingsConfig.enableCodexUserDesc")}
              checked={settings.skills?.enableCodexUser ?? false}
              onChange={(v) => onPatchSection("skills", { enableCodexUser: v })}
            />
            <SwitchRow
              label={t("settingsConfig.enableAgentsUser")}
              description={t("settingsConfig.enableAgentsUserDesc")}
              checked={settings.skills?.enableAgentsUser ?? false}
              onChange={(v) => onPatchSection("skills", { enableAgentsUser: v })}
            />
            <SwitchRow
              label={t("settingsConfig.enableClaudeUser")}
              description={t("settingsConfig.enableClaudeUserDesc")}
              checked={settings.skills?.enableClaudeUser ?? false}
              onChange={(v) => onPatchSection("skills", { enableClaudeUser: v })}
            />
            <SwitchRow
              label={t("settingsConfig.enableClaudeProject")}
              description={t("settingsConfig.enableClaudeProjectDesc")}
              checked={settings.skills?.enableClaudeProject ?? false}
              onChange={(v) => onPatchSection("skills", { enableClaudeProject: v })}
            />
          </div>

          {/* Session titles: omp's own generator knobs (`title.*`). The web's
              generateTitle() fully delegates to omp (generate_title RPC, /rename
              fallback), so these decide what a generated title actually is. */}
          <div style={cardStyle}>
            <span style={cardTitleStyle}>{t("settingsConfig.sessionTitlesCard")}</span>
            <label style={fieldLabelStyle}>
              {t("settingsConfig.titleGenerator")}
              <select
                value={settings.title?.generator ?? "fork"}
                onChange={(e) => onPatchSection("title", { generator: e.target.value as "fork" | "tiny" })}
                style={inputStyle}
              >
                <option value="fork">{t("settingsConfig.titleGeneratorFork")}</option>
                <option value="tiny">{t("settingsConfig.titleGeneratorTiny")}</option>
              </select>
            </label>
            <label style={fieldLabelStyle}>
              {t("settingsConfig.titleIcons")}
              <select
                value={settings.title?.icons ?? "nf+emoji"}
                onChange={(e) => onPatchSection("title", { icons: e.target.value as "nf+emoji" | "emoji" | "boring" })}
                style={inputStyle}
              >
                <option value="nf+emoji">{t("settingsConfig.titleIconsNfEmoji")}</option>
                <option value="emoji">{t("settingsConfig.titleIconsEmoji")}</option>
                <option value="boring">{t("settingsConfig.titleIconsBoring")}</option>
              </select>
            </label>
            <SwitchRow
              label={t("settingsConfig.titleRefreshOnReplan")}
              description={t("settingsConfig.titleRefreshOnReplanDesc")}
              checked={settings.title?.refreshOnReplan ?? true}
              onChange={(v) => onPatchSection("title", { refreshOnReplan: v })}
            />
          </div>

          {/* Local tiny model (providers.tinyModelDevice / tinyModelDtype):
              the inference backend omp runs its local title + memory models on. */}
          <div style={cardStyle}>
            <span style={cardTitleStyle}>{t("settingsConfig.tinyModelCard")}</span>
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>{t("settingsConfig.tinyModelCardDesc")}</p>
            <label style={fieldLabelStyle}>
              {t("settingsConfig.tinyModelDevice")}
              <select
                value={settings.providers?.tinyModelDevice ?? "default"}
                onChange={(e) => onPatchSection("providers", { tinyModelDevice: e.target.value as TinyModelDevice })}
                style={inputStyle}
              >
                {TINY_DEVICE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label style={fieldLabelStyle}>
              {t("settingsConfig.tinyModelDtype")}
              <select
                value={settings.providers?.tinyModelDtype ?? "default"}
                onChange={(e) => onPatchSection("providers", { tinyModelDtype: e.target.value as TinyModelDtype })}
                style={inputStyle}
              >
                {TINY_DTYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Advanced strings */}
          <div style={cardStyle}>
            <span style={cardTitleStyle}>{t("settingsConfig.advancedStrings")}</span>
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
        </>
      )}
    </section>
  );
}
