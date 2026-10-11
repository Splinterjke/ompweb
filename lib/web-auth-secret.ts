import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "./omp/paths";

/**
 * Signing material for the web session cookie (issue #239).
 *
 * Sessions used to be an HMAC keyed by the plaintext password. Once the server
 * only holds a password *hash*, that trick becomes a liability in the other
 * direction: anyone who reads the hash out of `web-service.env` could forge a
 * session. So the key is generated on first start, stored beside the other
 * web-auth state at mode 0600, and mixed with the password hash — changing the
 * password still invalidates every session, without any stored value being
 * sufficient on its own.
 */
export interface WebAuthSecret {
  /** Stable per-installation random salt. */
  salt: string;
  /** Random key the signing key is derived from. */
  key: string;
}

/** Absolute path of the secret file; `PI_CODING_AGENT_DIR` moves it with the rest of the agent state. */
export function webAuthSecretPath(): string {
  return resolve(getAgentDir(), "omp-web", "web-auth-secret.json");
}

let cached: { path: string; mtimeMs: number; secret: WebAuthSecret } | null = null;
let cachedFresh: { path: string; secret: WebAuthSecret } | null = null;

function isBase64Url(value: unknown, bytes: number): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === bytes;
}

function parseSecret(raw: string): WebAuthSecret | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { salt, key } = parsed as Partial<WebAuthSecret>;
  if (!isBase64Url(salt, 32) || !isBase64Url(key, 32)) return null;
  return { salt, key };
}

function createSecret(path: string): WebAuthSecret {
  const secret: WebAuthSecret = {
    salt: randomBytes(32).toString("base64url"),
    key: randomBytes(32).toString("base64url"),
  };
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write, user-readable only: this file is the session-forging secret.
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(secret, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows has no POSIX mode bits; the file is still user-scoped by ACL.
  }
  renameSync(temporary, path);
  return secret;
}

/**
 * Read (or create) the installation's secret. The file is re-read whenever it
 * changes on disk: an installed server and `npm run dev` can share the agent
 * directory, and the second one must not keep signing with a key the first
 * has replaced.
 */
export function resolveWebAuthSecret(path = webAuthSecretPath()): WebAuthSecret {
  if (cachedFresh && cachedFresh.path === path) return cachedFresh.secret;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.secret;

  if (mtimeMs > 0) {
    try {
      const existing = parseSecret(readFileSync(path, "utf8"));
      if (existing) {
        cached = { path, mtimeMs, secret: existing };
        return existing;
      }
    } catch {
      // Unreadable: fall through and replace it rather than locking everyone out.
    }
  }

  const secret = createSecret(path);
  let writtenMtimeMs = mtimeMs;
  try {
    writtenMtimeMs = statSync(path).mtimeMs;
  } catch {
    // Keep the previous stamp; the next call re-reads the file anyway.
  }
  cached = { path, mtimeMs: writtenMtimeMs, secret };
  return secret;
}

/**
 * Derive the cookie-signing key from the installation secret and the
 * configured password hash; both must change for the key to stay the same.
 */
export function deriveSessionSigningKey(passwordHash: string, secret = resolveWebAuthSecret()): string {
  return createHmac("sha256", Buffer.from(secret.key, "base64url"))
    .update(`omp-web-session-v1\0${secret.salt}\0${passwordHash}`, "utf8")
    .digest("base64url");
}

/** Test seam: forget the memoized secret and read the file again. */
export function resetWebAuthSecretCache(): void {
  cached = null;
  cachedFresh = null;
}

/**
 * Test seam: pin the secret for the lifetime of the process without touching
 * the user's agent directory. Named "pin" rather than "use…" on purpose — the
 * `react-hooks/rules-of-hooks` lint rule treats any `use*` function as a hook.
 */
export function pinWebAuthSecretForTests(secret?: WebAuthSecret): void {
  cachedFresh = secret ? { path: webAuthSecretPath(), secret } : null;
}
