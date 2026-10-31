import { authGatewayRequest } from "./auth-gateway";

/**
 * Web-side mirror of omp's automatic session titling
 * (`packages/coding-agent/src/utils/title-generator.ts`, direct mode — verified
 * against the omp 18.16.0 binary), run through `omp auth-gateway stdio`'s
 * `/v1/chat/completions` route (lib/omp/auth-gateway.ts).
 *
 * Why this exists: omp's instant titling — generate the title the moment the
 * first assistant reply starts and set it mid-run — is wired ONLY for the
 * interactive TUI: the session is constructed with `autoTitle: <interactive>`
 * (`p.autoTitle = S`, `S` = no `--mode` flag), so an `omp --mode rpc-ui` child
 * never runs it, and no released omp exposes a title-generation RPC (command
 * surface verified through 18.16.0: the only title command is
 * `set_session_name`; `generate_title` was never shipped). omp-web's settle
 * path therefore waits for a run to finish, because its quiet `/rename`
 * fallback is a prompt run and can't ride beside one. This mirror restores the
 * TUI's timing: generate DURING the first run from the same input the TUI uses
 * (the opening user message) and apply the result with `set_session_name` —
 * the same mid-run apply the TUI's generator performs.
 *
 * Model choice delegates to omp itself: the gateway resolves the `@tiny`,
 * `@commit` and `@smol` role selectors against the user's native `modelRoles`
 * config and catalog — the same role chain the native generator walks — and
 * plain `provider/id` for the session model. A selector that cannot resolve or
 * has no credential fails with a structured status and the chain continues,
 * exactly like the native per-model continue-on-error loop.
 *
 * Deliberate approximations (omp's internals are not readable from a host):
 * - The native system prompt is a bundled resource the compiled binary does
 *   not expose; the prompt below states the output contract the parser below
 *   validates instead of byte-copying omp's text. Titles come out equivalent,
 *   not identical.
 * - Native "fork" mode (the default `title.generator`) names the conversation
 *   with the session model in a forked ephemeral turn. At first-reply start
 *   the only conversation content is the opener, so the web calls the session
 *   model first with the opener alone; `title.generator: "tiny"` puts the
 *   session model last, mirroring the native chain order there.
 * - Card/emoji styling (`title.icons`, the `🧪 CODE:` prefix) is applied by
 *   omp's rename/fork paths only — an early web title stays a plain title.
 *   The wand's `/rename` and the settle path's quiet `/rename` still produce
 *   natively styled titles.
 */

/** Gateway route resolving model selectors, roles (`@tiny`) and `provider/id`. */
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
/** The native generator pins `maxTokens: 1024` (`Te`) and `temperature: 0`. */
const TITLE_MAX_TOKENS = 1024;
/** Per-candidate request budget; the shared gateway answers in ~1s when warm. */
const DEFAULT_PER_MODEL_TIMEOUT_MS = 25_000;
/** The validator's caps, verbatim from the native module (`m` / `w`). */
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;
/** The native "untitlable" answer (`T`). */
const NONE_ANSWER = "none";

/** The native word tokenizer (`a`). */
const WORD_RE = /[\p{L}\p{N}]+/gu;
/** Greetings / acknowledgements / pleasantries — a session opener made only of
 *  these words carries nothing to name (the native `h` set). Membership runs
 *  against arbitrary user words, so checks use `Object.hasOwn`. */
const LOW_SIGNAL_WORDS: Record<string, true> = {
  hi: true, hii: true, hiii: true, hiya: true, hey: true, heya: true, hello: true,
  helo: true, hullo: true, yo: true, ya: true, sup: true, wassup: true,
  whatsup: true, howdy: true, greetings: true, hola: true, ciao: true, aloha: true,
  gm: true, gn: true, good: true, morning: true, afternoon: true, evening: true,
  night: true, day: true, thanks: true, thank: true, thx: true, ty: true,
  tysm: true, cheers: true, please: true, pls: true, plz: true, ok: true,
  okay: true, okey: true, k: true, kk: true, yep: true, yes: true, yeah: true,
  yup: true, nope: true, no: true, nah: true, sure: true, cool: true, nice: true,
  great: true, awesome: true, perfect: true, lol: true, lmao: true, haha: true,
  hehe: true, test: true, tests: true, testing: true, ping: true, pong: true,
  there: true, you: true, u: true, hmm: true, hmmm: true, um: true, uh: true,
  so: true, well: true, anyway: true,
};
/** Pointers to something not in the text ("look at this [Image #1]") — the
 *  native weak-opener vocabulary (the `L` set, on top of the greeting set). */
const POINTER_WORDS: Record<string, true> = {
  fix: true, this: true, that: true, these: true, those: true, it: true,
  here: true, look: true, at: true, see: true, check: true, investigate: true,
  what: true, whats: true, s: true, is: true, are: true, why: true, do: true,
  does: true, i: true, we: true, get: true, wrong: true, broken: true,
  break: true, did: true, help: true, can: true, could: true, the: true,
  a: true, thing: true, issue: true, bug: true, me: true, now: true,
  again: true, still: true, oh: true,
};
/** omp's attachment placeholders in message text (the native `p`). */
const MEDIA_MARKER_RE = /\[(?:Image|Video) #\d+[^\]]*\]/g;
/** Chat-wrapped inputs pass through the native wrapper untouched (`bl`). */
const CHAT_BLOCK_RE = /^<chat>[\s\S]*<\/chat>\s*$/;
const CHAT_TAG_RE = /<\/?(?:chat|user|assistant|think)>/g;
/** The title the model may wrap its answer in (native `G`, simplified: the
 *  web prompt does not use the private visible-title marker). */
const TITLE_TAG_RE = /<title>([\s\S]*?)<\/title>|<title\s*\/>|<title>\s*$/gi;
const THINK_TAG_BLOCK_RE = /<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>/gi;
const THINK_FENCE_BLOCK_RE = /```(?:thinking|reasoning)\b[\s\S]*?```/gi;
const LEADING_THINK_TAG_RE = /^\s*<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>\s*/i;
const LEADING_THINK_FENCE_RE = /^\s*```(?:thinking|reasoning)\b[\s\S]*?```\s*/i;
const THINKING_PREAMBLE_RE = /^[ \t]*(?:(?:here(?:['’]s| is)[ \t]+(?:a|the|my)[ \t]+)|my[ \t]+)?(?:thinking|thought|reasoning)[ \t]+process[ \t]*:?[ \t]*(?:\r?\n|$)/i;

/** The native input normalization (`R2`) plus chat-tag stripping (`KOt`). */
function normalizeOpener(text: string): string {
  const stripped = CHAT_BLOCK_RE.test(text) ? text.replace(CHAT_TAG_RE, " ") : text;
  return stripped.replace(/\s+/g, " ").trim();
}

/** The native low-signal gate (`eE`): no real words, or only greetings / bare
 *  numbers. omp declines to title such openers (and the settle path retries
 *  once a real turn exists). */
export function isLowSignalOpener(text: string): boolean {
  const words = normalizeOpener(text).toLowerCase().match(WORD_RE) ?? [];
  if (words.length === 0) return true;
  return words.every((word) => Object.hasOwn(LOW_SIGNAL_WORDS, word) || /^\d+$/.test(word));
}

/** The native weak-pointer gate (`wRt`): the text only says "look at this"
 *  ABOUT an inline attachment, with nothing to name. */
export function isWeakPointerOpener(text: string): boolean {
  const stripped = text.replace(MEDIA_MARKER_RE, " ");
  if (stripped === text) return false;
  const words = normalizeOpener(stripped).toLowerCase().match(WORD_RE) ?? [];
  return words.every((word) => Object.hasOwn(LOW_SIGNAL_WORDS, word) || Object.hasOwn(POINTER_WORDS, word));
}

/** The native user-message wrapper (`Cwe`): chat-shaped input passes through,
 *  anything else becomes one escaped `<user> … </user>` block. */
export function wrapOpener(text: string): string {
  if (CHAT_BLOCK_RE.test(text)) return text;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<user> ${escaped} </user>`;
}

/** The native final validator (`$$` minus the acronym-case restoration): first
 *  line, no quotes, no bare `<title/>`, no trailing sentence punctuation, never
 *  the literal "None", at most 80 characters and 12 words. */
export function validateTitleCandidate(text: string): string | null {
  const first = text?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!first) return null;
  let candidate = first.replace(/^["']|["']$/g, "").trim();
  if (/^<title\s*\/>$/i.test(candidate)) return null;
  candidate = candidate
    .replace(/^<title>/i, "")
    .replace(/<\/title>$/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/[.!?]$/, "")
    .trim();
  if (!candidate || candidate.toLowerCase() === NONE_ANSWER) return null;
  const words = candidate.match(WORD_RE)?.length ?? 0;
  if (words === 0 || candidate.length > MAX_TITLE_CHARS || words > MAX_TITLE_WORDS) return null;
  return candidate;
}

/** The native JSON answer unwrap (`z`): a fenced or bare `{ "title": … }` body
 *  replaces the whole text; anything else passes through untouched. */
function unwrapJsonTitle(text: string): string {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!unfenced.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(unfenced);
    if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") {
      return parsed.title.trim();
    }
  } catch {
    // Not JSON after all — the plain-text validation continues.
  }
  return text;
}

/** The native response extraction (`Ee` minus its final `z`/`$$` tail): a
 *  `<title>…</title>` outside thinking blocks wins; otherwise the text with
 *  thinking removed and tags stripped; a "here's my thinking process:"
 *  lead-in means no title. */
export function extractTitleText(raw: string): string {
  TITLE_TAG_RE.lastIndex = 0;
  let match = TITLE_TAG_RE.exec(raw);
  while (match !== null) {
    if (!insideThinking(raw, match.index)) return match[1]?.trim() ?? "";
    match = TITLE_TAG_RE.exec(raw);
  }
  let text = raw;
  for (;;) {
    const stripped = text.replace(LEADING_THINK_TAG_RE, "").replace(LEADING_THINK_FENCE_RE, "");
    if (stripped === text) break;
    text = stripped;
  }
  text = text.replace(THINK_TAG_BLOCK_RE, "").replace(THINK_FENCE_BLOCK_RE, "").replace(/<\/?title>/gi, "").trim();
  if (THINKING_PREAMBLE_RE.test(text)) return "";
  return text;
}

function insideThinking(text: string, index: number): boolean {
  return coveredBy(THINK_TAG_BLOCK_RE, text, index) || coveredBy(THINK_FENCE_BLOCK_RE, text, index);
}

function coveredBy(re: RegExp, text: string, index: number): boolean {
  re.lastIndex = 0;
  let match = re.exec(text);
  while (match !== null) {
    if (index > match.index && index < match.index + match[0].length) return true;
    if (match.index > index) return false;
    match = re.exec(text);
  }
  return false;
}

export function parseGeneratedTitle(raw: string): string | null {
  return validateTitleCandidate(unwrapJsonTitle(extractTitleText(raw)));
}

/** The native role chain (`["tiny","commit","smol"]`, as gateway selectors). */
export const TITLE_ROLE_SELECTORS = ["@tiny", "@commit", "@smol"] as const;

/**
 * The model chain for one generation, mirroring the native shape for the
 * user's `title.generator` knob: the default `fork` mode names with the
 * session model first (its side turn on the opener), `tiny` walks the role
 * chain first and falls back to the session model last.
 */
export function buildTitleModelChain(opts: {
  sessionModel?: string | null;
  generator?: "fork" | "tiny";
}): string[] {
  const roles: string[] = [...TITLE_ROLE_SELECTORS];
  const session = opts.sessionModel?.trim();
  if (!session) return roles;
  const chain = opts.generator === "tiny" ? [...roles, session] : [session, ...roles];
  return [...new Set(chain)];
}

/**
 * The system prompt. omp's own text is a bundled resource unreadable from the
 * compiled binary, so this states the same contract the parser validates: a
 * short plain line, "None" for untitlable openers, nothing else.
 */
const TITLE_SYSTEM_PROMPT = [
  "You name agent sessions. The user message below is the opening message of a new conversation, wrapped in <user> tags.",
  `Reply with ONE line holding a short title for the conversation: at most 6 words and at most ${MAX_TITLE_CHARS} characters.`,
  "Name the concrete subject (the file, tool, error, feature or goal). Keep product names and acronyms (API, CLI, JSON, TUI) as written.",
  "Never wrap the title in quotes or <title> tags, never end it with punctuation, never add a preamble or explanation.",
  "If the message gives nothing concrete to name (a bare greeting, an acknowledgement, or only a pointer at an attachment), reply with exactly: None",
].join(" ");

export interface OpenerTitleRequest {
  /** The opening user message text (already capped by the caller). */
  text: string;
  /** Model candidates in order: role selectors (`@tiny`) or `provider/id`. */
  modelChain: readonly string[];
  perModelTimeoutMs?: number;
}

export interface OpenerTitleResult {
  title: string;
  /** The candidate that produced it (for logs). */
  model: string;
}

/** Read one OpenAI-shaped completion's text content (string or block array).
 *  The gateway body is out-of-control data: every field is narrowed, not cast. */
function completionText(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("choices" in body)) return null;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!first || typeof first !== "object") return null;
  const message: unknown = "message" in first ? first.message : undefined;
  const content: unknown =
    message && typeof message === "object" && "content" in message
      ? message.content
      : "text" in first
        ? first.text
        : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) =>
        block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block
          ? String(block.text ?? "")
          : "")
      .join("");
  }
  return null;
}

/**
 * Name the opener with the first model of the chain that answers with a
 * usable title. Every candidate miss (gateway error, unresolvable role,
 * missing credential, empty or invalid answer) continues to the next one —
 * the native generator's per-model loop. Never throws.
 */
export async function generateOpenerTitle(request: OpenerTitleRequest): Promise<OpenerTitleResult | null> {
  for (const model of request.modelChain) {
    try {
      const response = await authGatewayRequest(
        CHAT_COMPLETIONS_PATH,
        {
          model,
          messages: [
            { role: "system", content: TITLE_SYSTEM_PROMPT },
            { role: "user", content: wrapOpener(request.text) },
          ],
          max_tokens: TITLE_MAX_TOKENS,
          temperature: 0,
          stream: false,
        },
        AbortSignal.timeout(request.perModelTimeoutMs ?? DEFAULT_PER_MODEL_TIMEOUT_MS),
      );
      if (response.status !== 200) continue;
      const raw = completionText(response.body);
      if (!raw) continue;
      const title = parseGeneratedTitle(raw);
      if (title) return { title, model };
    } catch {
      // Gateway start/IO trouble is a candidate miss: the chain moves on and
      // the settle path's quiet `/rename` remains the backstop.
    }
  }
  return null;
}
