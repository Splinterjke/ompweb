"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Sliders,
  Sparkles,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

type McpServer = { name: string; config: Record<string, unknown> };
type McpWorkspace = { cwd: string; name: string; path: string | null; exists: boolean; servers: McpServer[] };
type BuiltinMcpPreset = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  author: string;
  version: string;
  tools: string[];
  config: Record<string, unknown>;
  isAvailable: boolean;
  installedPath?: string;
};
type McpUserConfig = { path: string; servers: Array<{ name: string; status: string; type: string; enabled: boolean; valid: boolean }>; disabledServers: string[]; error?: string };
type McpLiveStatus = "connected" | "connecting" | "not_connected" | "inactive" | "disabled" | "configured";
type McpLiveServer = { name: string; source: string; status: McpLiveStatus; type?: string };

const inputStyle = {
  width: "100%",
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
  fontFamily: "var(--font-mono)",
} as const;

function serverSummary(config: Record<string, unknown>): { type: string; target: string; enabled: boolean; valid: boolean } {
  const type = typeof config.type === "string" && config.type !== "stdio" ? config.type : "stdio";
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const url = typeof config.url === "string" ? config.url.trim() : "";
  const hasCommand = command.length > 0;
  const hasUrl = url.length > 0;
  const valid = (hasCommand || hasUrl) && !(hasCommand && hasUrl) && (type === "http" || type === "sse" ? hasUrl : hasCommand);
  return {
    type,
    target: type === "http" || type === "sse" ? url : `${command}${Array.isArray(config.args) ? " " + config.args.join(" ") : ""}`.trim(),
    enabled: config.enabled !== false,
    valid,
  };
}

export function McpConfig({ cwd, sessionId }: { cwd: string | null; sessionId?: string | null }) {
  const { t } = useI18n();
  const [workspaces, setWorkspaces] = useState<McpWorkspace[]>([]);
  const [activeCwd, setActiveCwd] = useState<string | null>(cwd);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [builtinPresets, setBuiltinPresets] = useState<BuiltinMcpPreset[]>([]);
  const [userConfig, setUserConfig] = useState<McpUserConfig | null>(null);
  const [liveServers, setLiveServers] = useState<McpLiveServer[] | null>(null);
  const [inventory, setInventory] = useState<McpLiveServer[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [editorMode, setEditorMode] = useState<"form" | "json">("form");

  // Form Fields
  const [formType, setFormType] = useState<"stdio" | "http" | "sse">("stdio");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);

  const [source, setSource] = useState(() => JSON.stringify({ type: "stdio", command: "", args: [] }, null, 2));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Discovered Servers Filter & Fold
  const [filterQuery, setFilterQuery] = useState("");
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({
    "User level": true,
  });

  const syncFormFromConfig = (config: Record<string, unknown>) => {
    const type = (config.type === "http" || config.type === "sse" ? config.type : "stdio") as "stdio" | "http" | "sse";
    setFormType(type);
    setFormCommand(typeof config.command === "string" ? config.command : "");
    setFormArgs(Array.isArray(config.args) ? config.args.join(" ") : "");
    setFormUrl(typeof config.url === "string" ? config.url : "");
    setFormEnabled(config.enabled !== false);
  };

  const buildConfigFromForm = (): Record<string, unknown> => {
    if (formType === "http" || formType === "sse") {
      return {
        type: formType,
        url: formUrl.trim(),
        enabled: formEnabled,
      };
    }
    const args = formArgs.trim() ? formArgs.trim().split(/\s+/) : [];
    return {
      type: "stdio",
      command: formCommand.trim(),
      args,
      enabled: formEnabled,
    };
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (activeCwd) params.set("cwd", activeCwd);
      if (sessionId) params.set("sessionId", sessionId);
      const response = await fetch(`/api/mcp?${params}`);
      const data = (await response.json()) as {
        workspaces?: McpWorkspace[];
        user?: McpUserConfig;
        userServers?: McpServer[];
        builtinPresets?: BuiltinMcpPreset[];
        inventory?: McpLiveServer[];
        liveServers?: McpLiveServer[];
        liveError?: string;
        error?: string;
      };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      const all = data.workspaces ?? [];
      setWorkspaces(all);
      // Active scope: the requested workspace if present in the allow-listed set,
      // otherwise the first allow-listed workspace (the server always echoes the
      // requested cwd first when it is allowed, so an exact match is reliable).
      const active =
        activeCwd != null
          ? all.find((w) => w.cwd === activeCwd) ?? all[0] ?? null
          : null;
      const activeServers = active ? active.servers : (data.userServers ?? []);
      setServers(activeServers);
      setPath(active ? (active.path ?? active.cwd) : (data.user?.path ?? null));
      setBuiltinPresets(data.builtinPresets ?? []);
      setUserConfig(data.user ?? null);
      setLiveServers(Array.isArray(data.liveServers) ? data.liveServers : null);
      setInventory(Array.isArray(data.inventory) ? data.inventory : null);
      setLiveError(data.liveError ?? null);
      setSelected((current) => (current && activeServers.some((server) => server.name === current) ? current : null));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.loadError"), detail);
    } finally {
      setLoading(false);
    }
  }, [activeCwd, sessionId, t]);

  useEffect(() => {
    void load();
  }, [load]);
  // Follow the parent's project-workspace switch (load() re-runs on change).
  useEffect(() => {
    setActiveCwd(cwd);
  }, [cwd]);

  const choose = (server: McpServer) => {
    setSelected(server.name);
    setName(server.name);
    syncFormFromConfig(server.config);
    setSource(JSON.stringify(server.config, null, 2));
    setMessage(null);
  };

  const add = () => {
    setSelected(null);
    setName("");
    setFormType("stdio");
    setFormCommand("");
    setFormArgs("");
    setFormUrl("");
    setFormEnabled(true);
    setSource(JSON.stringify({ type: "stdio", command: "", args: [] }, null, 2));
    setMessage(null);
  };

  const applyTemplate = (type: "python" | "npx" | "http") => {
    if (type === "python") {
      setName(name || "python-mcp");
      setFormType("stdio");
      setFormCommand("python3");
      setFormArgs("server.py");
      setFormEnabled(true);
      setSource(JSON.stringify({ type: "stdio", command: "python3", args: ["server.py"] }, null, 2));
    } else if (type === "npx") {
      setName(name || "filesystem");
      setFormType("stdio");
      setFormCommand("npx");
      setFormArgs("-y @modelcontextprotocol/server-filesystem /tmp");
      setFormEnabled(true);
      setSource(JSON.stringify({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }, null, 2));
    } else if (type === "http") {
      setName(name || "remote-mcp");
      setFormType("http");
      setFormUrl("http://localhost:8000/mcp");
      setFormEnabled(true);
      setSource(JSON.stringify({ type: "http", url: "http://localhost:8000/mcp" }, null, 2));
    }
    setMessage(null);
  };

  const parse = (): Record<string, unknown> | null => {
    if (editorMode === "form") {
      return buildConfigFromForm();
    }
    try {
      const value = JSON.parse(source) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("mcpConfig.mustBeJsonObject"));
      return value as Record<string, unknown>;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("mcpConfig.invalidJson"));
      return null;
    }
  };

  const check = async () => {
    const server = parse();
    if (!server) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), server }),
      });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setMessage(data.message ?? t("mcpConfig.validConfig"));
      toast.success(t("mcpConfig.validConfig"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.invalidConfig"), detail);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const server = parse();
    if (!server || !name.trim()) {
      if (!name.trim()) setMessage("Please enter a server name");
      return;
    }
    setSaving(true);
    try {
      const payload = activeCwd
        ? { cwd: activeCwd, name: name.trim(), previousName: selected ?? undefined, server }
        : { scope: "user", name: name.trim(), previousName: selected ?? undefined, server };
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setSelected(name.trim());
      setMessage(t("mcpConfig.savedMsg"));
      toast.success(t("mcpConfig.serverSaved", { name: name.trim() }));
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.saveError"), detail);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const payload = activeCwd ? { cwd: activeCwd, name: selected } : { name: selected };
      const response = await fetch("/api/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      add();
      setMessage(t("mcpConfig.removedMsg"));
      toast.success(t("mcpConfig.serverRemoved", { name: selected }));
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.removeError"), detail);
    } finally {
      setSaving(false);
    }
  };

  const enablePreset = async (preset: BuiltinMcpPreset) => {
    setSaving(true);
    try {
      const payload = activeCwd
        ? { cwd: activeCwd, name: preset.name, server: preset.config }
        : { scope: "user", name: preset.name, server: preset.config };
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setSelected(preset.name);
      setName(preset.name);
      syncFormFromConfig(preset.config);
      setSource(JSON.stringify(preset.config, null, 2));
      toast.success(t("mcpConfig.serverSaved", { name: preset.displayName }));
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toast.error(t("mcpConfig.saveError"), detail);
    } finally {
      setSaving(false);
    }
  };

  const displayedServers = liveServers ?? inventory ?? [];

  const groupedDiscovered = useMemo(() => {
    const groups: Record<string, McpLiveServer[]> = {};
    for (const server of displayedServers) {
      if (filterQuery.trim()) {
        const q = filterQuery.toLowerCase();
        const matchName = server.name.toLowerCase().includes(q);
        const matchSource = server.source.toLowerCase().includes(q);
        if (!matchName && !matchSource) continue;
      }
      if (!groups[server.source]) groups[server.source] = [];
      groups[server.source].push(server);
    }
    return groups;
  }, [displayedServers, filterQuery]);

  const toggleSourceExpand = (source: string) => {
    setExpandedSources((prev) => ({ ...prev, [source]: !prev[source] }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
      {/* 1. Built-in Native MCP Showcase */}
      {builtinPresets.length > 0 && (
        <section
          style={{
            border: "1px solid color-mix(in srgb, var(--accent) 35%, var(--border))",
            borderRadius: "var(--radius-card)",
            overflow: "hidden",
            background: "color-mix(in srgb, var(--accent) 3%, var(--bg-panel))",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              borderBottom: "1px solid color-mix(in srgb, var(--accent) 20%, var(--border))",
              background: "color-mix(in srgb, var(--accent) 7%, transparent)",
            }}
          >
            <Sparkles size={15} style={{ color: "var(--accent)" }} />
            <strong style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", color: "var(--text)" }}>{t("mcpConfig.builtinServers") || "Built-in MCP Extensions"}</strong>
            <span
              style={{
                fontSize: "calc(10px * var(--ui-font-scale-sm, 1))",
                padding: "2px 7px",
                borderRadius: 4,
                background: "var(--accent)",
                color: "var(--on-accent)",
                fontWeight: 700,
                letterSpacing: "0.02em",
              }}
            >
              {t("mcpConfig.builtinTag") || "Built-in"}
            </span>
          </div>
          <div style={{ padding: 14, display: "grid", gap: 12 }}>
            {builtinPresets.map((preset) => {
              const isConfigured =
                servers.some((s) => s.name === preset.name) ||
                (userConfig?.servers ?? []).some((s) => s.name === preset.name) ||
                displayedServers.some((s) => s.name === preset.name && s.status !== "disabled");
              return (
                <div
                  key={preset.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    padding: "12px 14px",
                    borderRadius: 8,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: "calc(14px * var(--ui-font-scale-lg, 1))", fontWeight: 700, color: "var(--text)" }}>{preset.displayName}</span>
                      <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontFamily: "var(--font-mono)", color: "var(--text-dim)", padding: "1px 5px", background: "var(--bg-panel)", borderRadius: 4 }}>
                        {preset.version}
                      </span>
                      <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)" }}>by {preset.author}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {isConfigured ? (
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                            color: "var(--status-success)",
                            fontWeight: 600,
                            padding: "3px 8px",
                            borderRadius: 6,
                            background: "color-mix(in srgb, var(--status-success) 10%, transparent)",
                          }}
                        >
                          <Check size={13} />
                          <span>{t("mcpConfig.alreadyConfigured") || "Ready"}</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void enablePreset(preset)}
                          disabled={saving}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "5px 12px",
                            borderRadius: 6,
                            background: "var(--accent)",
                            color: "var(--on-accent)",
                            border: "none",
                            fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                            fontWeight: 600,
                            cursor: saving ? "wait" : "pointer",
                          }}
                        >
                          <Zap size={13} />
                          <span>{t("mcpConfig.enablePreset") || "Enable"}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(preset.name);
                          setName(preset.name);
                          syncFormFromConfig(preset.config);
                          setSource(JSON.stringify(preset.config, null, 2));
                        }}
                        style={{
                          padding: "5px 10px",
                          borderRadius: 6,
                          background: "transparent",
                          color: "var(--text)",
                          border: "1px solid var(--border)",
                          fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                          cursor: "pointer",
                        }}
                      >
                        {t("mcpConfig.editPreset") || "Edit"}
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)", lineHeight: 1.5 }}>{preset.description}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {preset.tools.map((tool) => (
                      <span
                        key={tool}
                        style={{
                          fontSize: "calc(10px * var(--ui-font-scale-sm, 1))",
                          fontFamily: "var(--font-mono)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "var(--bg-panel)",
                          border: "1px solid var(--border)",
                          color: "var(--text)",
                        }}
                      >
                        {tool}
                      </span>
                    ))}
                    <span style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", alignSelf: "center", marginLeft: 4 }}>+ 8 more advanced orchestration tools</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 2. MCP Server Configuration & Editor (Visual Form + JSON) */}
      <section
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
          overflow: "hidden",
          background: "var(--bg-panel)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--bg-hover) 50%, transparent)",
          }}
        >
          <Sliders size={15} style={{ color: "var(--accent)" }} />
          <strong style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", color: "var(--text)", flexShrink: 0 }}>
            {t("mcpConfig.serverManagement")}
          </strong>
          <select
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              maxWidth: 220,
              minWidth: 0,
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
              padding: "3px 6px",
              outline: "none",
            }}
            value={activeCwd ?? ""}
            title={t("mcpConfig.workspaceScopeHint")}
            onChange={(e) => {
              const value = e.target.value;
              const next = value === "" ? null : value;
              setSelected(null);
              add();
              if (next !== activeCwd) setActiveCwd(next);
              else void load();
            }}
          >
            <option value="">{t("mcpConfig.userLevelShort")}</option>
            {workspaces.map((w) => (
              <option key={w.cwd} value={w.cwd}>
                {w.name}
              </option>
            ))}
          </select>
          {path && (
            <code style={{ flex: 1, minWidth: 0, color: "var(--text-dim)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {path}
            </code>
          )}
          {(() => {
            const total = servers.length;
            if (total === 0) return null;
            const enabled = servers.filter((s) => serverSummary(s.config).enabled && serverSummary(s.config).valid).length;
            const invalid = servers.filter((s) => !serverSummary(s.config).valid).length;
            return (
              <span style={{ marginLeft: "auto", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                {t("mcpConfig.serverCounts", { enabled, total })}
                {invalid > 0 ? t("mcpConfig.invalidSuffix", { count: invalid }) : ""}
              </span>
            );
          })()}
        </div>

        <div className="mcp-editor-grid" style={{ display: "grid", gridTemplateColumns: "minmax(160px, 0.35fr) minmax(0, 1fr)", minHeight: 300 }}>
          {/* Server List */}
          <div style={{ borderRight: "1px solid var(--border)", padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", padding: "4px 6px" }}>
              Configured ({servers.length})
            </div>
            {servers.map((server) => {
              const summary = serverSummary(server.config);
              const isCurrent = selected === server.name;
              return (
                <button
                  key={server.name}
                  type="button"
                  onClick={() => choose(server)}
                  title={`${server.name} — ${summary.type} · ${summary.target || "invalid"}`}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 10px",
                    border: isCurrent ? "1px solid var(--accent)" : "1px solid transparent",
                    borderRadius: 6,
                    background: isCurrent ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                    color: "var(--text)",
                    textAlign: "left",
                    font: "12px var(--font-mono)",
                    cursor: "pointer",
                    overflow: "hidden",
                    transition: "background 0.15s ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: summary.valid ? (summary.enabled ? "var(--status-success)" : "var(--border)") : "var(--status-error)",
                      }}
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontWeight: isCurrent ? 700 : 500 }}>
                      {server.name}
                    </span>
                  </div>
                  <div style={{ marginTop: 2, fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {summary.type}
                    {summary.enabled ? "" : " · disabled"}
                    {!summary.valid ? " · invalid" : ""}
                    {summary.target ? ` · ${summary.target}` : ""}
                  </div>
                </button>
              );
            })}
            {!loading && servers.length === 0 && (
              <div style={{ padding: "10px 8px", color: "var(--text-dim)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", textAlign: "center" }}>
                {t("mcpConfig.noServers") || "No servers configured yet"}
              </div>
            )}
            <button
              type="button"
              onClick={add}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                width: "100%",
                marginTop: 6,
                padding: "8px 10px",
                border: selected === null ? "1px solid var(--accent)" : "1px dashed var(--border)",
                borderRadius: 6,
                background: selected === null ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
                color: selected === null ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                fontWeight: selected === null ? 700 : 500,
              }}
            >
              <Plus size={14} /> {t("mcpConfig.addServer") || "Add Server"}
            </button>
          </div>

          {/* Editor Form / JSON */}
          <div style={{ minWidth: 0, padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Header: Mode Switch & Template Shortcuts */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)" }}>Quick templates:</span>
                <button
                  type="button"
                  onClick={() => applyTemplate("python")}
                  style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", padding: "2px 6px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer" }}
                >
                  Python stdio
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("npx")}
                  style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", padding: "2px 6px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer" }}
                >
                  NPX stdio
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("http")}
                  style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", padding: "2px 6px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer" }}
                >
                  Remote HTTP
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--bg)", padding: 2, borderRadius: 6, border: "1px solid var(--border)" }}>
                <button
                  type="button"
                  onClick={() => setEditorMode("form")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "none",
                    background: editorMode === "form" ? "var(--accent)" : "transparent",
                    color: editorMode === "form" ? "var(--on-accent)" : "var(--text-muted)",
                    fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <Sliders size={12} /> Form
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditorMode("json");
                    setSource(JSON.stringify(buildConfigFromForm(), null, 2));
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "none",
                    background: editorMode === "json" ? "var(--accent)" : "transparent",
                    color: editorMode === "json" ? "var(--on-accent)" : "var(--text-muted)",
                    fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <Code size={12} /> JSON
                </button>
              </div>
            </div>

            {/* Server Name */}
            <div>
              <label style={{ display: "block", color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", marginBottom: 4 }}>
                {t("mcpConfig.serverName") || "Server name"}
              </label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. filesystem or python-runner"
                style={inputStyle}
              />
            </div>

            {/* Form Mode Inputs */}
            {editorMode === "form" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10 }}>
                  <div>
                    <label style={{ display: "block", color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", marginBottom: 4 }}>Transport</label>
                    <select
                      value={formType}
                      onChange={(e) => setFormType(e.target.value as "stdio" | "http" | "sse")}
                      style={{ ...inputStyle, cursor: "pointer" }}
                    >
                      <option value="stdio">stdio (local command)</option>
                      <option value="http">http (remote endpoint)</option>
                      <option value="sse">sse (streaming endpoint)</option>
                    </select>
                  </div>
                  {formType === "stdio" ? (
                    <div>
                      <label style={{ display: "block", color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", marginBottom: 4 }}>Command</label>
                      <input
                        value={formCommand}
                        onChange={(e) => setFormCommand(e.target.value)}
                        placeholder="e.g. python3, node, npx, uvx"
                        style={inputStyle}
                      />
                    </div>
                  ) : (
                    <div>
                      <label style={{ display: "block", color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", marginBottom: 4 }}>Remote URL (Endpoint)</label>
                      <input
                        value={formUrl}
                        onChange={(e) => setFormUrl(e.target.value)}
                        placeholder="e.g. http://localhost:8000/mcp"
                        style={inputStyle}
                      />
                    </div>
                  )}
                </div>

                {formType === "stdio" && (
                  <div>
                    <label style={{ display: "block", color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", marginBottom: 4 }}>Arguments</label>
                    <input
                      value={formArgs}
                      onChange={(e) => setFormArgs(e.target.value)}
                      placeholder="e.g. mcp_server.py or -y @modelcontextprotocol/server-filesystem /path"
                      style={inputStyle}
                    />
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    id="mcp-server-enabled"
                    checked={formEnabled}
                    onChange={(e) => setFormEnabled(e.target.checked)}
                    style={{ cursor: "pointer", width: 14, height: 14 }}
                  />
                  <label htmlFor="mcp-server-enabled" style={{ fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text)", cursor: "pointer" }}>
                    Enable this server (Enabled)
                  </label>
                </div>
              </div>
            ) : (
              <div>
                <label style={{ display: "block", color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", marginBottom: 4 }}>
                  {t("mcpConfig.serverConfigJson") || "OMP server config (JSON)"}
                </label>
                <textarea
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  spellCheck={false}
                  style={{ ...inputStyle, minHeight: 140, resize: "vertical", lineHeight: 1.45 }}
                />
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => void check()}
                disabled={saving}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "7px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  background: "transparent",
                  color: "var(--text)",
                  cursor: saving ? "wait" : "pointer",
                  fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                }}
              >
                <Check size={13} /> {t("mcpConfig.check") || "Validate"}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !name.trim()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "7px 14px",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  background: "var(--accent)",
                  color: "var(--on-accent)",
                  cursor: saving || !name.trim() ? "default" : "pointer",
                  fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                  fontWeight: 600,
                }}
              >
                {saving ? t("mcpConfig.saving") : t("mcpConfig.saveServer") || "Save"}
              </button>
              {selected && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={saving}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "7px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    background: "transparent",
                    color: "var(--status-error)",
                    cursor: saving ? "wait" : "pointer",
                    fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                    marginLeft: "auto",
                  }}
                >
                  <Trash2 size={13} /> {t("mcpConfig.remove") || "Remove"}
                </button>
              )}
            </div>
            {message && <div role="status" style={{ color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", lineHeight: 1.4 }}>{message}</div>}
          </div>
        </div>
      </section>

      {/* 3. Discovered Multi-Client MCP Servers (Collapsible Accordion by Source) */}
      <section
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
          overflow: "hidden",
          background: "var(--bg-panel)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Globe size={15} style={{ color: "var(--text-muted)" }} />
          <strong style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", color: "var(--text)" }}>
            {t("mcpConfig.configuredServers") || "Configured & auto-discovered MCP servers"}
          </strong>
          <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>({displayedServers.length})</span>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <Search size={12} style={{ position: "absolute", left: 7, color: "var(--text-dim)" }} />
              <input
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter MCP..."
                style={{
                  padding: "3px 8px 3px 24px",
                  fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  background: "var(--bg)",
                  color: "var(--text)",
                  width: 120,
                }}
              />
            </div>
            <button
              type="button"
              title={t("mcpConfig.refreshLiveStatus")}
              aria-label={t("mcpConfig.refreshLiveStatus")}
              onClick={() => void load()}
              disabled={loading}
              className="ui-focus-ring"
              style={{
                width: 24,
                height: 24,
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                borderRadius: 4,
                background: "transparent",
                color: "var(--text-muted)",
                cursor: loading ? "wait" : "pointer",
              }}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {Object.entries(groupedDiscovered).map(([sourceName, groupServers]) => {
            const isExpanded = expandedSources[sourceName] ?? true;
            return (
              <div
                key={sourceName}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  overflow: "hidden",
                  background: "var(--bg)",
                }}
              >
                <button
                  type="button"
                  onClick={() => toggleSourceExpand(sourceName)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "8px 12px",
                    background: "var(--bg-panel)",
                    border: "none",
                    borderBottom: isExpanded ? "1px solid var(--border)" : "none",
                    color: "var(--text)",
                    fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                    fontWeight: 600,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{sourceName}</span>
                  <span style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginLeft: "auto", fontWeight: 400 }}>
                    {groupServers.length} servers
                  </span>
                </button>
                {isExpanded && (
                  <div
                    style={{
                      padding: 10,
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                      gap: 8,
                    }}
                  >
                    {groupServers.map((server) => {
                      const active = server.status === "connected" || server.status === "configured";
                      return (
                        <div
                          key={`${sourceName}:${server.name}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 10px",
                            borderRadius: 5,
                            background: "var(--bg-panel)",
                            border: "1px solid var(--border)",
                            fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              flexShrink: 0,
                              background: active ? "var(--status-success)" : "var(--border)",
                            }}
                          />
                          <code style={{ color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {server.name}
                          </code>
                          <span style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", marginLeft: "auto" }}>
                            {server.type ? `[${server.type}]` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {!loading && Object.keys(groupedDiscovered).length === 0 && (
            <div style={{ color: "var(--text-dim)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", padding: 12, textAlign: "center" }}>
              {t("mcpConfig.noMcpServers") || "No MCP servers found"}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
