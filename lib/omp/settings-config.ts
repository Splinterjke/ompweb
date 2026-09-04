import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isMap, parseDocument, stringify } from "yaml";
import { getSettingsPath } from "./paths";
import { isRecord } from "../type-guards";

export type NativeSettings = {
  defaultThinkingLevel?: "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  hideThinkingBlock?: boolean;
  externalThinking?: boolean;
  textVerbosity?: "low" | "medium" | "high";
  personality?: "default" | "friendly" | "pragmatic" | "none";
  advisor?: { enabled?: boolean; subagents?: boolean; syncBacklog?: "off" | "1" | "3" | "5"; immuneTurns?: number };
  tools?: { approvalMode?: "always-ask" | "write" | "yolo"; approval?: { bash?: "allow" | "prompt" | "deny"; extension?: "allow" | "prompt" } };
  enabledModels?: string[];
  disabledProviders?: string[];
  modelProviderOrder?: string[];
  registryHasScopedEntries?: boolean;
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    modelFallback?: boolean;
    fallbackRevertPolicy?: "cooldown-expiry" | "never";
    fallbackChains?: Record<string, string[]>;
  };
  compaction?: {
    enabled?: boolean;
    midTurnEnabled?: boolean;
    methodOrder?: CompactionMethod[];
    thresholdPercent?: number;
    thresholdTokens?: number;
    reserveTokens?: number | null;
    keepRecentTokens?: number;
    autoContinue?: boolean;
    asyncEnabled?: boolean;
    remoteStreamingV2Enabled?: boolean;
    remoteEndpoint?: string | null;
    v2RetainedMessageBudget?: number;
    idleEnabled?: boolean;
    idleThresholdTokens?: number;
    idleTimeoutSeconds?: number;
    supersedeReads?: boolean;
    dropUseless?: boolean;
    handoffSaveToDisk?: boolean;
  };
  branchSummary?: { enabled?: boolean; reserveTokens?: number };
  memory?: { backend?: "off" | "local" | "mnemopi" | "hindsight" };
  autolearn?: { enabled?: boolean; autoContinue?: boolean; minToolCalls?: number };
  mnemopi?: { scoping?: "global" | "per-project" | "per-project-tagged"; autoRecall?: boolean; autoRetain?: boolean; noEmbeddings?: boolean };
  mcp?: { enableProjectConfig?: boolean; renderMarkdownResults?: boolean; notifications?: boolean; notificationDebounceMs?: number };
  modelRoles?: Record<string, string>;
  generateImage?: { enabled?: boolean };
  computer?: { enabled?: boolean };
  skills?: { enableCodexUser?: boolean; enableAgentsUser?: boolean; enableClaudeUser?: boolean; enableClaudeProject?: boolean };
  bash?: { autoBackground?: { enabled?: boolean } };
  providers?: { memoryModel?: string | null; webSearchOrder?: string[] };
  security?: { enabled?: boolean };
  github?: { enabled?: boolean };
  colorBlindMode?: boolean;
  contextPromotion?: { enabled?: boolean };
  snapcompact?: { toolResults?: boolean };
  edit?: { mode?: string | null };
  composer?: { shape?: string | null };
  dev?: { autoqaConsent?: string | null };
  symbolPreset?: string | null;
};

const THINKING_LEVELS = new Set(["auto", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TEXT_VERBOSITIES = new Set(["low", "medium", "high"]);
const PERSONALITIES = new Set(["default", "friendly", "pragmatic", "none"]);
const BACKLOGS = new Set(["off", "1", "3", "5"]);
const APPROVAL_MODES = new Set(["always-ask", "write", "yolo"]);
const APPROVAL_POLICIES = new Set(["allow", "prompt", "deny"]);
const FALLBACK_REVERT_POLICIES = new Set(["cooldown-expiry", "never"]);
const COMPACTION_METHOD_ORDER = ["remote", "snapcompact", "handoff", "soft", "shake"] as const;
export type CompactionMethod = (typeof COMPACTION_METHOD_ORDER)[number];
const MEMORY_BACKENDS = new Set(["off", "local", "mnemopi", "hindsight"]);
const MEMORY_SCOPES = new Set(["global", "per-project", "per-project-tagged"]);

function configPath(): string {
  return getSettingsPath();
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function assertOptionalRecord(value: unknown, name: string): asserts value is Record<string, unknown> | undefined {
  if (value !== undefined && !isRecord(value)) throw new Error(`${name} must be an object`);
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}
function methodOrderArray(value: unknown): CompactionMethod[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > COMPACTION_METHOD_ORDER.length) return undefined;
  const seen = new Set<string>();
  const out: CompactionMethod[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !(COMPACTION_METHOD_ORDER as readonly string[]).includes(item)) return undefined;
    if (seen.has(item)) return undefined;
    seen.add(item);
    out.push(item as CompactionMethod);
  }
  return out;
}

function isTokenBudget(value: unknown, nullable = false): boolean {
  if (nullable && value === null) return true;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
}

function isThresholdPercent(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 100;
}

function isSeconds(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 86_400;
}

/** Strips values that cannot exist in a freshly created document (undefined,
 * and null, which only means "delete the key"). */
function filterNullish(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item != null).map(filterNullish);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item != null) out[key] = filterNullish(item);
    }
    return out;
  }
  return value;
}

function readDocument() {
  const path = configPath();
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  return { path, doc };
}

/** Returns the persisted native OMP values only; omitted keys keep OMP defaults. */
export function readNativeSettings(): { path: string; settings: NativeSettings } {
  const { path, doc } = readDocument();
  const data = doc.toJS();
  if (!isRecord(data)) return { path, settings: {} };
  const advisor = isRecord(data.advisor) ? data.advisor : {};
  const tools = isRecord(data.tools) ? data.tools : {};
  const approval = isRecord(tools.approval) ? tools.approval : {};
  const retry = isRecord(data.retry) ? data.retry : {};
  const fallbackChains = isRecord(retry.fallbackChains)
    ? Object.fromEntries(Object.entries(retry.fallbackChains).filter((entry): entry is [string, string[]] => typeof entry[0] === "string" && stringArray(entry[1]) !== undefined))
    : {};
  const compaction = isRecord(data.compaction) ? data.compaction : {};
  const branchSummary = isRecord(data.branchSummary) ? data.branchSummary : {};
  const memory = isRecord(data.memory) ? data.memory : {};
  const autolearn = isRecord(data.autolearn) ? data.autolearn : {};
  const mnemopi = isRecord(data.mnemopi) ? data.mnemopi : {};
  const mcp = isRecord(data.mcp) ? data.mcp : {};
  const generateImage = isRecord(data.generate_image) ? data.generate_image : {};
  const computer = isRecord(data.computer) ? data.computer : {};
  const skills = isRecord(data.skills) ? data.skills : {};
  const bash = isRecord(data.bash) ? data.bash : {};
  const bashAutoBackground = isRecord(bash.autoBackground) ? bash.autoBackground : {};
  const providers = isRecord(data.providers) ? data.providers : {};
  const security = isRecord(data.security) ? data.security : {};
  const github = isRecord(data.github) ? data.github : {};
  const contextPromotion = isRecord(data.contextPromotion) ? data.contextPromotion : {};
  const snapcompact = isRecord(data.snapcompact) ? data.snapcompact : {};
  const edit = isRecord(data.edit) ? data.edit : {};
  const composer = isRecord(data.composer) ? data.composer : {};
  const dev = isRecord(data.dev) ? data.dev : {};
  const registryHasScopedEntries = [data.enabledModels, data.disabledProviders, data.modelProviderOrder]
    .some((value) => Array.isArray(value) && !value.every((item) => typeof item === "string"));
  return {
    path,
    settings: {
      ...(THINKING_LEVELS.has(data.defaultThinkingLevel as string) ? { defaultThinkingLevel: data.defaultThinkingLevel as NativeSettings["defaultThinkingLevel"] } : {}),
      ...(typeof data.hideThinkingBlock === "boolean" ? { hideThinkingBlock: data.hideThinkingBlock } : {}),
      ...(typeof data.externalThinking === "boolean" ? { externalThinking: data.externalThinking } : {}),
      ...(TEXT_VERBOSITIES.has(data.textVerbosity as string) ? { textVerbosity: data.textVerbosity as NativeSettings["textVerbosity"] } : {}),
      ...(PERSONALITIES.has(data.personality as string) ? { personality: data.personality as NativeSettings["personality"] } : {}),
      ...(Object.keys(advisor).length ? {
        advisor: {
          ...(typeof advisor.enabled === "boolean" ? { enabled: advisor.enabled } : {}),
          ...(typeof advisor.subagents === "boolean" ? { subagents: advisor.subagents } : {}),
          ...(BACKLOGS.has(advisor.syncBacklog as string) ? { syncBacklog: advisor.syncBacklog as "off" | "1" | "3" | "5" } : {}),
          ...(typeof advisor.immuneTurns === "number" && Number.isInteger(advisor.immuneTurns) ? { immuneTurns: advisor.immuneTurns } : {}),
        },
      } : {}),
      ...(Object.keys(tools).length ? { tools: {
        ...(APPROVAL_MODES.has(tools.approvalMode as string) ? { approvalMode: tools.approvalMode as "always-ask" | "write" | "yolo" } : {}),
        ...(APPROVAL_POLICIES.has(approval.bash as string) || approval.extension === "allow" || approval.extension === "prompt" ? { approval: {
          ...(APPROVAL_POLICIES.has(approval.bash as string) ? { bash: approval.bash as "allow" | "prompt" | "deny" } : {}),
          ...(approval.extension === "allow" || approval.extension === "prompt" ? { extension: approval.extension } : {}),
        } } : {}),
      } } : {}),
      ...(stringArray(data.enabledModels) ? { enabledModels: stringArray(data.enabledModels) } : {}),
      ...(stringArray(data.disabledProviders) ? { disabledProviders: stringArray(data.disabledProviders) } : {}),
      ...(stringArray(data.modelProviderOrder) ? { modelProviderOrder: stringArray(data.modelProviderOrder) } : {}),
      ...(registryHasScopedEntries ? { registryHasScopedEntries: true } : {}),
      ...(Object.keys(retry).length ? { retry: {
        ...(typeof retry.enabled === "boolean" ? { enabled: retry.enabled } : {}),
        ...(typeof retry.maxRetries === "number" && Number.isInteger(retry.maxRetries) ? { maxRetries: retry.maxRetries } : {}),
        ...(typeof retry.modelFallback === "boolean" ? { modelFallback: retry.modelFallback } : {}),
        ...(FALLBACK_REVERT_POLICIES.has(retry.fallbackRevertPolicy as string) ? { fallbackRevertPolicy: retry.fallbackRevertPolicy as "cooldown-expiry" | "never" } : {}),
        ...(Object.keys(fallbackChains).length ? { fallbackChains } : {}),
      } } : {}),
      ...(Object.keys(compaction).length ? { compaction: {
        ...(typeof compaction.enabled === "boolean" ? { enabled: compaction.enabled } : {}),
        ...(typeof compaction.midTurnEnabled === "boolean" ? { midTurnEnabled: compaction.midTurnEnabled } : {}),
        ...(methodOrderArray(compaction.methodOrder) ? { methodOrder: methodOrderArray(compaction.methodOrder)! } : {}),
        ...(isThresholdPercent(compaction.thresholdPercent) ? { thresholdPercent: compaction.thresholdPercent as number } : {}),
        ...(isTokenBudget(compaction.thresholdTokens) ? { thresholdTokens: compaction.thresholdTokens as number } : {}),
        ...(isTokenBudget(compaction.reserveTokens, true) ? { reserveTokens: compaction.reserveTokens as number | null } : {}),
        ...(isTokenBudget(compaction.keepRecentTokens) ? { keepRecentTokens: compaction.keepRecentTokens as number } : {}),
        ...(typeof compaction.autoContinue === "boolean" ? { autoContinue: compaction.autoContinue } : {}),
        ...(typeof compaction.asyncEnabled === "boolean" ? { asyncEnabled: compaction.asyncEnabled } : {}),
        ...(typeof compaction.remoteStreamingV2Enabled === "boolean" ? { remoteStreamingV2Enabled: compaction.remoteStreamingV2Enabled } : {}),
        ...(typeof compaction.remoteEndpoint === "string" ? { remoteEndpoint: compaction.remoteEndpoint } : compaction.remoteEndpoint === null ? { remoteEndpoint: null } : {}),
        ...(isTokenBudget(compaction.v2RetainedMessageBudget) ? { v2RetainedMessageBudget: compaction.v2RetainedMessageBudget as number } : {}),
        ...(typeof compaction.idleEnabled === "boolean" ? { idleEnabled: compaction.idleEnabled } : {}),
        ...(isTokenBudget(compaction.idleThresholdTokens) ? { idleThresholdTokens: compaction.idleThresholdTokens as number } : {}),
        ...(isSeconds(compaction.idleTimeoutSeconds) ? { idleTimeoutSeconds: compaction.idleTimeoutSeconds as number } : {}),
        ...(typeof compaction.supersedeReads === "boolean" ? { supersedeReads: compaction.supersedeReads } : {}),
        ...(typeof compaction.dropUseless === "boolean" ? { dropUseless: compaction.dropUseless } : {}),
        ...(typeof compaction.handoffSaveToDisk === "boolean" ? { handoffSaveToDisk: compaction.handoffSaveToDisk } : {}),
      } } : {}),
      ...(Object.keys(branchSummary).length ? { branchSummary: {
        ...(typeof branchSummary.enabled === "boolean" ? { enabled: branchSummary.enabled } : {}),
        ...(isTokenBudget(branchSummary.reserveTokens) ? { reserveTokens: branchSummary.reserveTokens as number } : {}),
      } } : {}),
      ...(Object.keys(memory).length ? { memory: { ...(MEMORY_BACKENDS.has(memory.backend as string) ? { backend: memory.backend as "off" | "local" | "mnemopi" | "hindsight" } : {}) } } : {}),
      ...(Object.keys(autolearn).length ? { autolearn: {
        ...(typeof autolearn.enabled === "boolean" ? { enabled: autolearn.enabled } : {}),
        ...(typeof autolearn.autoContinue === "boolean" ? { autoContinue: autolearn.autoContinue } : {}),
        ...(typeof autolearn.minToolCalls === "number" && Number.isInteger(autolearn.minToolCalls) ? { minToolCalls: autolearn.minToolCalls } : {}),
      } } : {}),
      ...(Object.keys(mnemopi).length ? { mnemopi: {
        ...(MEMORY_SCOPES.has(mnemopi.scoping as string) ? { scoping: mnemopi.scoping as "global" | "per-project" | "per-project-tagged" } : {}),
        ...(typeof mnemopi.autoRecall === "boolean" ? { autoRecall: mnemopi.autoRecall } : {}),
        ...(typeof mnemopi.autoRetain === "boolean" ? { autoRetain: mnemopi.autoRetain } : {}),
        ...(typeof mnemopi.noEmbeddings === "boolean" ? { noEmbeddings: mnemopi.noEmbeddings } : {}),
      } } : {}),
      ...(Object.keys(mcp).length ? { mcp: {
        ...(typeof mcp.enableProjectConfig === "boolean" ? { enableProjectConfig: mcp.enableProjectConfig } : {}),
        ...(typeof mcp.renderMarkdownResults === "boolean" ? { renderMarkdownResults: mcp.renderMarkdownResults } : {}),
        ...(typeof mcp.notifications === "boolean" ? { notifications: mcp.notifications } : {}),
        ...(typeof mcp.notificationDebounceMs === "number" && Number.isInteger(mcp.notificationDebounceMs) ? { notificationDebounceMs: mcp.notificationDebounceMs } : {}),
      } } : {}),
      ...(modelRolesRecord(data.modelRoles) ? { modelRoles: modelRolesRecord(data.modelRoles)! } : {}),
      ...(Object.keys(generateImage).length ? { generateImage: { ...(typeof generateImage.enabled === "boolean" ? { enabled: generateImage.enabled } : {}) } } : {}),
      ...(Object.keys(computer).length ? { computer: { ...(typeof computer.enabled === "boolean" ? { enabled: computer.enabled } : {}) } } : {}),
      ...(Object.keys(skills).length ? { skills: {
        ...(typeof skills.enableCodexUser === "boolean" ? { enableCodexUser: skills.enableCodexUser } : {}),
        ...(typeof skills.enableAgentsUser === "boolean" ? { enableAgentsUser: skills.enableAgentsUser } : {}),
        ...(typeof skills.enableClaudeUser === "boolean" ? { enableClaudeUser: skills.enableClaudeUser } : {}),
        ...(typeof skills.enableClaudeProject === "boolean" ? { enableClaudeProject: skills.enableClaudeProject } : {}),
      } } : {}),
      ...(Object.keys(bash).length ? { bash: { ...(Object.keys(bashAutoBackground).length ? { autoBackground: { ...(typeof bashAutoBackground.enabled === "boolean" ? { enabled: bashAutoBackground.enabled } : {}) } } : {}) } } : {}),
      ...(Object.keys(providers).length ? { providers: {
        ...(typeof providers.memoryModel === "string" && providers.memoryModel ? { memoryModel: providers.memoryModel } : {}),
        ...(stringArray(providers.webSearchOrder) ? { webSearchOrder: stringArray(providers.webSearchOrder) } : {}),
      } } : {}),
      ...(Object.keys(security).length ? { security: { ...(typeof security.enabled === "boolean" ? { enabled: security.enabled } : {}) } } : {}),
      ...(Object.keys(github).length ? { github: { ...(typeof github.enabled === "boolean" ? { enabled: github.enabled } : {}) } } : {}),
      ...(typeof data.colorBlindMode === "boolean" ? { colorBlindMode: data.colorBlindMode } : {}),
      ...(Object.keys(contextPromotion).length ? { contextPromotion: { ...(typeof contextPromotion.enabled === "boolean" ? { enabled: contextPromotion.enabled } : {}) } } : {}),
      ...(Object.keys(snapcompact).length ? { snapcompact: { ...(typeof snapcompact.toolResults === "boolean" ? { toolResults: snapcompact.toolResults } : {}) } } : {}),
      ...(Object.keys(edit).length && typeof edit.mode === "string" && edit.mode ? { edit: { mode: edit.mode } } : {}),
      ...(Object.keys(composer).length && typeof composer.shape === "string" && composer.shape ? { composer: { shape: composer.shape } } : {}),
      ...(Object.keys(dev).length && typeof dev.autoqaConsent === "string" && dev.autoqaConsent ? { dev: { autoqaConsent: dev.autoqaConsent } } : {}),
      ...(typeof data.symbolPreset === "string" && data.symbolPreset ? { symbolPreset: data.symbolPreset } : {}),
    },
  };
}

function modelRolesRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key && typeof item === "string" && item) out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validates and applies a reviewed subset of OMP's global config schema. */
export function writeNativeSettings(settings: NativeSettings): void {
  if (!isRecord(settings)) throw new Error("Settings must be an object");
  assertOptionalRecord(settings.advisor, "advisor");
  assertOptionalRecord(settings.tools, "tools");
  assertOptionalRecord(settings.tools?.approval, "tools.approval");
  assertOptionalRecord(settings.retry, "retry");
  assertOptionalRecord(settings.compaction, "compaction");
  assertOptionalRecord(settings.branchSummary, "branchSummary");
  assertOptionalRecord(settings.memory, "memory");
  assertOptionalRecord(settings.autolearn, "autolearn");
  assertOptionalRecord(settings.mnemopi, "mnemopi");
  assertOptionalRecord(settings.mcp, "mcp");
  assertOptionalRecord(settings.modelRoles, "modelRoles");
  assertOptionalRecord(settings.generateImage, "generateImage");
  assertOptionalRecord(settings.computer, "computer");
  assertOptionalRecord(settings.skills, "skills");
  assertOptionalRecord(settings.bash, "bash");
  assertOptionalRecord(settings.bash?.autoBackground, "bash.autoBackground");
  assertOptionalRecord(settings.providers, "providers");
  assertOptionalRecord(settings.security, "security");
  assertOptionalRecord(settings.github, "github");
  assertOptionalRecord(settings.contextPromotion, "contextPromotion");
  assertOptionalRecord(settings.snapcompact, "snapcompact");
  assertOptionalRecord(settings.edit, "edit");
  assertOptionalRecord(settings.composer, "composer");
  assertOptionalRecord(settings.dev, "dev");
  for (const [name, value] of Object.entries({
    hideThinkingBlock: settings.hideThinkingBlock,
    externalThinking: settings.externalThinking,
    "advisor.enabled": settings.advisor?.enabled,
    "advisor.subagents": settings.advisor?.subagents,
    "retry.enabled": settings.retry?.enabled,
    "retry.modelFallback": settings.retry?.modelFallback,
    "compaction.enabled": settings.compaction?.enabled,
    "compaction.midTurnEnabled": settings.compaction?.midTurnEnabled,
    "compaction.autoContinue": settings.compaction?.autoContinue,
    "compaction.asyncEnabled": settings.compaction?.asyncEnabled,
    "compaction.remoteStreamingV2Enabled": settings.compaction?.remoteStreamingV2Enabled,
    "compaction.idleEnabled": settings.compaction?.idleEnabled,
    "compaction.supersedeReads": settings.compaction?.supersedeReads,
    "compaction.dropUseless": settings.compaction?.dropUseless,
    "compaction.handoffSaveToDisk": settings.compaction?.handoffSaveToDisk,
    "branchSummary.enabled": settings.branchSummary?.enabled,
    "autolearn.enabled": settings.autolearn?.enabled,
    "autolearn.autoContinue": settings.autolearn?.autoContinue,
    "mnemopi.autoRecall": settings.mnemopi?.autoRecall,
    "mnemopi.autoRetain": settings.mnemopi?.autoRetain,
    "mnemopi.noEmbeddings": settings.mnemopi?.noEmbeddings,
    "mcp.enableProjectConfig": settings.mcp?.enableProjectConfig,
    "mcp.renderMarkdownResults": settings.mcp?.renderMarkdownResults,
    "mcp.notifications": settings.mcp?.notifications,
    "generateImage.enabled": settings.generateImage?.enabled,
    "computer.enabled": settings.computer?.enabled,
    "skills.enableCodexUser": settings.skills?.enableCodexUser,
    "skills.enableAgentsUser": settings.skills?.enableAgentsUser,
    "skills.enableClaudeUser": settings.skills?.enableClaudeUser,
    "skills.enableClaudeProject": settings.skills?.enableClaudeProject,
    "bash.autoBackground.enabled": settings.bash?.autoBackground?.enabled,
    "security.enabled": settings.security?.enabled,
    "github.enabled": settings.github?.enabled,
    "colorBlindMode": settings.colorBlindMode,
    "contextPromotion.enabled": settings.contextPromotion?.enabled,
    "snapcompact.toolResults": settings.snapcompact?.toolResults,
  })) assertOptionalBoolean(value, name);
  if (settings.modelRoles !== undefined) {
    for (const [role, model] of Object.entries(settings.modelRoles)) {
      if (!role.trim() || typeof model !== "string" || !model.trim()) throw new Error("Model roles require non-empty role and model values");
    }
  }
  if (settings.providers?.webSearchOrder !== undefined && (!Array.isArray(settings.providers.webSearchOrder) || settings.providers.webSearchOrder.some((value) => typeof value !== "string"))) {
    throw new Error("providers.webSearchOrder must be an array of strings");
  }
  if (settings.providers?.memoryModel !== undefined && settings.providers.memoryModel !== null && typeof settings.providers.memoryModel !== "string") throw new Error("providers.memoryModel must be a string");
  for (const [key, value] of Object.entries({ "edit.mode": settings.edit?.mode, "composer.shape": settings.composer?.shape, "dev.autoqaConsent": settings.dev?.autoqaConsent, symbolPreset: settings.symbolPreset, "compaction.remoteEndpoint": settings.compaction?.remoteEndpoint })) {
    if (value === null) continue;
    if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`${key} must be a non-empty string`);
  }
  if (settings.defaultThinkingLevel !== undefined && !THINKING_LEVELS.has(settings.defaultThinkingLevel)) throw new Error("Invalid default thinking level");
  if (settings.textVerbosity !== undefined && !TEXT_VERBOSITIES.has(settings.textVerbosity)) throw new Error("Invalid text verbosity");
  if (settings.personality !== undefined && !PERSONALITIES.has(settings.personality)) throw new Error("Invalid personality");
  if (settings.advisor?.syncBacklog !== undefined && !BACKLOGS.has(settings.advisor.syncBacklog)) throw new Error("Invalid advisor sync backlog");
  if (settings.advisor?.immuneTurns !== undefined && (!Number.isInteger(settings.advisor.immuneTurns) || settings.advisor.immuneTurns < 0 || settings.advisor.immuneTurns > 20)) throw new Error("Advisor immune turns must be an integer between 0 and 20");
  if (settings.tools?.approvalMode !== undefined && !APPROVAL_MODES.has(settings.tools.approvalMode)) throw new Error("Invalid approval mode");
  if (settings.tools?.approval?.bash !== undefined && !APPROVAL_POLICIES.has(settings.tools.approval.bash)) throw new Error("Invalid Bash approval policy");
  if (settings.tools?.approval?.extension !== undefined && settings.tools.approval.extension !== "allow" && settings.tools.approval.extension !== "prompt") throw new Error("Invalid extension tool approval policy");
  if (settings.retry?.maxRetries !== undefined && (!Number.isInteger(settings.retry.maxRetries) || settings.retry.maxRetries < 0 || settings.retry.maxRetries > 20)) throw new Error("Retry attempts must be an integer between 0 and 20");
  if (settings.retry?.fallbackRevertPolicy !== undefined && !FALLBACK_REVERT_POLICIES.has(settings.retry.fallbackRevertPolicy)) throw new Error("Invalid fallback revert policy");
  if (settings.retry?.fallbackChains !== undefined) {
    for (const [role, chain] of Object.entries(settings.retry.fallbackChains)) {
      if (!role.trim() || !Array.isArray(chain) || chain.some((selector) => typeof selector !== "string" || !selector.trim())) throw new Error("Fallback chains require non-empty role and model selectors");
    }
  }
  if (settings.compaction?.methodOrder !== undefined && methodOrderArray(settings.compaction.methodOrder) === undefined) throw new Error("Invalid compaction methodOrder: expected 1-5 unique values from remote, snapcompact, handoff, soft, shake");
  if (settings.compaction?.thresholdPercent !== undefined && !isThresholdPercent(settings.compaction.thresholdPercent)) throw new Error("compaction.thresholdPercent must be an integer between -1 and 100");
  if (settings.compaction?.thresholdTokens !== undefined && !isTokenBudget(settings.compaction.thresholdTokens)) throw new Error("compaction.thresholdTokens must be an integer between 0 and 1,000,000");
  if (settings.compaction?.reserveTokens !== undefined && !isTokenBudget(settings.compaction.reserveTokens, true)) throw new Error("compaction.reserveTokens must be null or an integer between 0 and 1,000,000");
  if (settings.compaction?.keepRecentTokens !== undefined && !isTokenBudget(settings.compaction.keepRecentTokens)) throw new Error("compaction.keepRecentTokens must be an integer between 0 and 1,000,000");
  if (settings.compaction?.v2RetainedMessageBudget !== undefined && !isTokenBudget(settings.compaction.v2RetainedMessageBudget)) throw new Error("compaction.v2RetainedMessageBudget must be an integer between 0 and 1,000,000");
  if (settings.compaction?.idleThresholdTokens !== undefined && !isTokenBudget(settings.compaction.idleThresholdTokens)) throw new Error("compaction.idleThresholdTokens must be an integer between 0 and 1,000,000");
  if (settings.compaction?.idleTimeoutSeconds !== undefined && !isSeconds(settings.compaction.idleTimeoutSeconds)) throw new Error("compaction.idleTimeoutSeconds must be an integer between 1 and 86,400");
  if (settings.compaction?.keepRecentTokens !== undefined && (!Number.isInteger(settings.compaction.keepRecentTokens) || settings.compaction.keepRecentTokens < 1_000 || settings.compaction.keepRecentTokens > 1_000_000)) throw new Error("compaction.keepRecentTokens must be an integer between 1,000 and 1,000,000");
  if (settings.branchSummary?.reserveTokens !== undefined && !isTokenBudget(settings.branchSummary.reserveTokens)) throw new Error("branchSummary.reserveTokens must be an integer between 0 and 1,000,000");
  if (settings.memory?.backend !== undefined && !MEMORY_BACKENDS.has(settings.memory.backend)) throw new Error("Invalid memory backend");
  if (settings.autolearn?.minToolCalls !== undefined && (!Number.isInteger(settings.autolearn.minToolCalls) || settings.autolearn.minToolCalls < 0 || settings.autolearn.minToolCalls > 100)) throw new Error("Auto-learn minimum tool calls must be an integer between 0 and 100");
  if (settings.mnemopi?.scoping !== undefined && !MEMORY_SCOPES.has(settings.mnemopi.scoping)) throw new Error("Invalid Mnemopi memory scope");
  if (settings.mcp?.notificationDebounceMs !== undefined && (!Number.isInteger(settings.mcp.notificationDebounceMs) || settings.mcp.notificationDebounceMs < 0 || settings.mcp.notificationDebounceMs > 60_000)) throw new Error("MCP notification debounce must be an integer between 0 and 60,000");
  for (const [key, values] of Object.entries({ enabledModels: settings.enabledModels, disabledProviders: settings.disabledProviders, modelProviderOrder: settings.modelProviderOrder })) {
    if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim()))) throw new Error(`${key} must contain non-empty strings`);
  }

  const { path, doc } = readDocument();
  mkdirSync(dirname(path), { recursive: true });
  if (doc.contents === null) {
    // The YAML key differs from the settings name for one field; map it
    // before serializing so the very first write matches OMP's schema.
    // nulls mean "delete" and cannot exist in an empty document — drop them.
    const { generateImage, compaction: compactionForWrite, branchSummary: branchSummaryForWrite, ...rest } = settings;
    const mapped = filterNullish({
      ...rest,
      ...(generateImage !== undefined ? { generate_image: generateImage } : {}),
      ...(compactionForWrite !== undefined ? { compaction: compactionForWrite } : {}),
      ...(branchSummaryForWrite !== undefined ? { branchSummary: branchSummaryForWrite } : {}),
    }) as Record<string, unknown>;
    for (const key of Object.keys(mapped)) {
      if (mapped[key] === null || mapped[key] === undefined) delete mapped[key];
    }
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, stringify(mapped), "utf8");
    renameSync(temp, path);
    return;
  }
  if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
  if (settings.defaultThinkingLevel !== undefined) doc.set("defaultThinkingLevel", settings.defaultThinkingLevel);
  if (settings.hideThinkingBlock !== undefined) doc.set("hideThinkingBlock", settings.hideThinkingBlock);
  if (settings.externalThinking !== undefined) doc.set("externalThinking", settings.externalThinking);
  if (settings.textVerbosity !== undefined) doc.set("textVerbosity", settings.textVerbosity);
  if (settings.personality !== undefined) doc.set("personality", settings.personality);
  for (const [key, value] of Object.entries(settings.advisor ?? {})) doc.setIn(["advisor", key], value);
  if (settings.tools?.approvalMode !== undefined) doc.setIn(["tools", "approvalMode"], settings.tools.approvalMode);
  if (settings.tools?.approval?.bash !== undefined) doc.setIn(["tools", "approval", "bash"], settings.tools.approval.bash);
  if (settings.tools?.approval?.extension !== undefined) doc.setIn(["tools", "approval", "extension"], settings.tools.approval.extension);
  if (settings.enabledModels !== undefined) doc.set("enabledModels", settings.enabledModels);
  if (settings.disabledProviders !== undefined) doc.set("disabledProviders", settings.disabledProviders);
  if (settings.modelProviderOrder !== undefined) doc.set("modelProviderOrder", settings.modelProviderOrder);
  for (const [key, value] of Object.entries(settings.retry ?? {})) doc.setIn(["retry", key], value);
  for (const [key, value] of Object.entries(settings.compaction ?? {})) {
    if (value === null) doc.deleteIn(["compaction", key]);
    else doc.setIn(["compaction", key], value);
  }
  for (const [key, value] of Object.entries(settings.branchSummary ?? {})) {
    if (value === null) doc.deleteIn(["branchSummary", key]);
    else doc.setIn(["branchSummary", key], value);
  }
  for (const [key, value] of Object.entries(settings.memory ?? {})) doc.setIn(["memory", key], value);
  for (const [key, value] of Object.entries(settings.autolearn ?? {})) doc.setIn(["autolearn", key], value);
  for (const [key, value] of Object.entries(settings.mnemopi ?? {})) doc.setIn(["mnemopi", key], value);
  for (const [key, value] of Object.entries(settings.mcp ?? {})) doc.setIn(["mcp", key], value);
  if (settings.modelRoles !== undefined) doc.set("modelRoles", settings.modelRoles);
  if (settings.generateImage?.enabled !== undefined) doc.setIn(["generate_image", "enabled"], settings.generateImage.enabled);
  if (settings.computer?.enabled !== undefined) doc.setIn(["computer", "enabled"], settings.computer.enabled);
  for (const [key, value] of Object.entries(settings.skills ?? {})) doc.setIn(["skills", key], value);
  if (settings.bash?.autoBackground?.enabled !== undefined) doc.setIn(["bash", "autoBackground", "enabled"], settings.bash.autoBackground.enabled);
  // null deletes the key (used when the UI clears a field); undefined leaves it untouched.
  if (settings.providers?.memoryModel !== undefined) {
    if (settings.providers.memoryModel === null) doc.deleteIn(["providers", "memoryModel"]);
    else doc.setIn(["providers", "memoryModel"], settings.providers.memoryModel);
  }
  if (settings.providers?.webSearchOrder !== undefined) doc.setIn(["providers", "webSearchOrder"], settings.providers.webSearchOrder);
  if (settings.security?.enabled !== undefined) doc.setIn(["security", "enabled"], settings.security.enabled);
  if (settings.github?.enabled !== undefined) doc.setIn(["github", "enabled"], settings.github.enabled);
  if (settings.colorBlindMode !== undefined) doc.set("colorBlindMode", settings.colorBlindMode);
  if (settings.contextPromotion?.enabled !== undefined) doc.setIn(["contextPromotion", "enabled"], settings.contextPromotion.enabled);
  if (settings.snapcompact?.toolResults !== undefined) doc.setIn(["snapcompact", "toolResults"], settings.snapcompact.toolResults);
  if (settings.edit?.mode !== undefined) {
    if (settings.edit.mode === null) doc.deleteIn(["edit", "mode"]);
    else doc.setIn(["edit", "mode"], settings.edit.mode);
  }
  if (settings.composer?.shape !== undefined) {
    if (settings.composer.shape === null) doc.deleteIn(["composer", "shape"]);
    else doc.setIn(["composer", "shape"], settings.composer.shape);
  }
  if (settings.dev?.autoqaConsent !== undefined) {
    if (settings.dev.autoqaConsent === null) doc.deleteIn(["dev", "autoqaConsent"]);
    else doc.setIn(["dev", "autoqaConsent"], settings.dev.autoqaConsent);
  }
  if (settings.symbolPreset !== undefined) {
    if (settings.symbolPreset === null) doc.delete("symbolPreset");
    else doc.set("symbolPreset", settings.symbolPreset);
  }
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, doc.toString(), "utf8");
  renameSync(temp, path);
}
