import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

interface SessionPreferencesFile {
  version: 1;
  sessions: Record<string, { advisorEnabled?: boolean }>;
}

const EMPTY: SessionPreferencesFile = { version: 1, sessions: {} };

function preferencesPath(): string {
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"));
  return process.env.OMP_WEB_SESSION_PREFERENCES ?? join(agentDir, "session-preferences.json");
}

function readFile(): SessionPreferencesFile {
  const path = preferencesPath();
  if (!existsSync(path)) return { ...EMPTY, sessions: {} };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY, sessions: {} };
  const sessions = "sessions" in parsed && parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
    ? Object.fromEntries(Object.entries(parsed.sessions).flatMap(([id, value]) =>
        value && typeof value === "object" && !Array.isArray(value) && "advisorEnabled" in value && typeof value.advisorEnabled === "boolean"
          ? [[id, { advisorEnabled: value.advisorEnabled }]]
          : [],
      ))
    : {};
  return { version: 1, sessions };
}

function writeFile(value: SessionPreferencesFile): void {
  const path = preferencesPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function getSessionAdvisorEnabled(sessionId: string): boolean {
  return readFile().sessions[sessionId]?.advisorEnabled === true;
}

export function setSessionAdvisorEnabled(sessionId: string, enabled: boolean): void {
  const preferences = readFile();
  preferences.sessions[sessionId] = { advisorEnabled: enabled };
  writeFile(preferences);
}
