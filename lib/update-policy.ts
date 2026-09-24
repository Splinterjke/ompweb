const TRUTHY_ENV_VALUES = ["1", "true", "yes", "on"];

export const DISABLE_AUTOUPDATE_ENV_VAR = "OMP_WEB_DISABLE_AUTOUPDATE";

/** Whether update checks and in-app self-update are disabled for this process. */
export function isUpdateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DISABLE_AUTOUPDATE_ENV_VAR];
  return typeof value === "string" && TRUTHY_ENV_VALUES.includes(value.trim().toLowerCase());
}
