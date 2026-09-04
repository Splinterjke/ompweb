export const REDACTED_MODEL_CONFIG_VALUE = "__OMPWEB_REDACTED__";

export interface ModelConfigDraft {
  id?: unknown;
}

export interface ProviderConfigDraft {
  models?: ModelConfigDraft[];
}

export interface ModelsConfigDraft {
  providers?: Record<string, ProviderConfigDraft>;
}

export function modelConfigSecretInputValue(value: string | undefined): string {
  return value === REDACTED_MODEL_CONFIG_VALUE ? "" : (value ?? "");
}

export function preserveModelConfigSecret(
  nextValue: string,
  previousValue: string | undefined,
): string | undefined {
  if (nextValue) return nextValue;
  return previousValue === REDACTED_MODEL_CONFIG_VALUE ? REDACTED_MODEL_CONFIG_VALUE : undefined;
}

function isUntouchedModelDraft(model: ModelConfigDraft): boolean {
  return Object.entries(model).every(([key, value]) =>
    key === "id" ? typeof value === "string" && value.trim() === "" : value === undefined,
  );
}

/** Excludes only the empty row created by the editor's Add model control. */
export function omitUntouchedModelDrafts<T extends ModelsConfigDraft>(config: T): T {
  if (!config.providers) return config;

  let changed = false;
  const providers: Record<string, ProviderConfigDraft> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    const models = provider.models;
    if (!models?.some(isUntouchedModelDraft)) {
      providers[name] = provider;
      continue;
    }
    changed = true;
    const completeModels = models.filter((model) => !isUntouchedModelDraft(model));
    providers[name] = { ...provider, models: completeModels.length > 0 ? completeModels : undefined };
  }

  return changed ? { ...config, providers } as T : config;
}
