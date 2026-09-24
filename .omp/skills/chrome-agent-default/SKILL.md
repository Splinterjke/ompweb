---
name: chrome-agent-default
description: Default browser path for this machine. Use chrome-agent (bash CLI) for web navigation, inspection, scraping, forms, screenshots and downloads instead of the built-in browser tool. Reuses an existing Chrome on the box (e.g. OMP's) and downloads a standalone copy only if none is present. The built-in browser tool is only a last resort.
---

# chrome-agent — first-choice browser path

For any web task on this box, drive `chrome-agent` via `bash` before reaching for the built-in
`browser` device. Full command reference and verdict table: read `skill://chrome-agent`.
Record extraction: read `skill://scrape-structured-data`.

## Container conventions (this machine)

- Always pass BOTH `--chrome-arg --no-sandbox --chrome-arg --disable-dev-shm-usage`:
  - `--no-sandbox`: we run as root; Chrome refuses root without it.
  - `--disable-dev-shm-usage`: `/dev/shm` here is 64 MB; without this flag Chrome pages
    render BLANK intermittently under repeated navigations (the web app never mounts, ~half the
    JS modules are fetched, body length 0). Verified 30/30 loads with the flag, ~1-in-3 flakes
    without it.
- Chrome: a SINGLE Chrome-for-Testing 150 copy lives on the LOCAL volume at
  `/root/.chrome-agent/chrome/chrome-linux64/chrome` (fast — a cold launch is ~1 s, vs ~6 s if the
  ~380 MB binary had to be read off the slow `D:\` 9p/SMB bind where OMP keeps it). OMP's 9p Chrome
  dir is a SYMLINK to this local copy, so the browser is never physically duplicated — both
  chrome-agent and OMP's managed browser resolve to the same fast binary. It is exposed as
  `google-chrome` on PATH; `entrypoint.sh` re-seeds/links it on every container start, so a rebuild
  or a removed copy self-heals.
- If `google-chrome --version` fails: re-run the container (entrypoint re-resolves the link), or
  point it at any working Chrome manually, e.g.
  `ln -sf /root/.chrome-agent/chrome/chrome-linux64/chrome /usr/local/bin/google-chrome`. If it
  then fails on missing `.so` libs, install the headless-Chrome apt set
  (`libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64
  libpango-1.0-0 libcairo2`).
- Parallel/subagent work: give each task `--browser <unique-name>`; sharing `default` corrupts
  sessions. Close browsers when done: `--browser <name> close --purge`.
- **Multi-step / repeated navigations:** use `pipe` mode (one persistent CDP connection, stable
  uids, no per-command session churn):
  `printf '{"cmd":"goto","url":"..."}\n{"cmd":"wait","what":"text","pattern":"...","timeout":30}\n{"cmd":"eval","expression":"..."}\n' | chrome-agent --json --chrome-arg --no-sandbox --chrome-arg --disable-dev-shm-usage --browser <name> pipe`
- **Stray-process leaks:** leftover Chrome processes exhaust resources (`ERR_INSUFFICIENT_RESOURCES`)
  and cause blank pages. Before benchmarking/long sessions: `pkill -f 'chrome-linux64/chrome'`.

## Core loop

```bash
# (both --chrome-arg flags required here; see Container conventions)
chrome-agent --json --chrome-arg --no-sandbox --chrome-arg --disable-dev-shm-usage goto <url> --inspect
chrome-agent --json --chrome-arg --no-sandbox --chrome-arg --disable-dev-shm-usage fill --uid nN "text"
chrome-agent --json --chrome-arg --no-sandbox --chrome-arg --disable-dev-shm-usage click nN
chrome-agent --chrome-arg --no-sandbox --chrome-arg --disable-dev-shm-usage assert url --matches "..."
```

Rules that matter (full set in `skill://chrome-agent`):
- `ok:true` means the command ran, not that the page complied. Branch on `next`; read `verdict`,
  `value.actual`, `delivery`.
- Prove the end state with `assert` (exit 0) before reporting success; exit 2 = the page is not
  in the claimed state.
- Re-`inspect` after `navigated` or any SPA route change — uids are reassigned.
- Never repeat an action on `unknown` (the first one may have landed).
- `serving: challenge|error` is a bot block or HTTP error — report it, don't retry blind.
  Datacenter-IP Google bot checks (`/sorry/index`) are IP-based; `--stealth` does not clear them
  and `--connect` to a real Chrome is unavailable here. For search, use a non-Google engine
  (e.g. DuckDuckGo HTML) or fall back to the `read` tool.
- **Blank page (`body.innerText` length 0, Vue app not mounted, ~half the JS modules fetched, no
  console errors):** if you are NOT already passing `--disable-dev-shm-usage`, that is the cause —
  add it and re-navigate. If you are, suspect stray Chrome processes
  (`pkill -f 'chrome-linux64/chrome'`, then re-run) or the app itself resetting on rapid
  re-navigation (single `pipe` session, `wait text` before acting).

## Iterating against a local dev server (repeat test rounds)

Reuse ONE named browser for the whole test session — never `pkill` it between probes:

- **One browser per session** (e.g. `--browser dev`): the profile persists across separate
  `pipe` invocations, so log in once and set state once; every later probe reuses the cookie
  and localStorage. A fresh browser per probe forces re-login and re-setup every time.
- **After a server restart/rebuild, re-navigate with `{"cmd":"goto","url":...}`** — a fresh
  document fetches fresh HTML + JS. A soft `location.reload()` inside an `eval` may serve a
  cached document; if stale behavior persists after a fresh goto, bust the cache once with a
  one-off `?v=<timestamp>` query param (cookies and SPA state are unaffected).
- **`CDP error -32000: Inspected target navigated or closed`** right after a `location.reload()`
  or `goto` inside an `eval` is expected and harmless — the page navigated, the browser is
  alive. Just re-issue the next command; do not kill the browser over it.
- **Reset state in place** instead of starting a fresh browser: `eval`
  `localStorage.removeItem("key")` (or `localStorage.clear()`) + a fresh goto. Create a
  brand-new browser only when a pristine first-run is required (first login, onboarding).
- `pkill -9 -f chrome-agent/linux-x64` is for sweeping *stray leftover* browsers before starting
  a session, never between tests within one.
- When the session is done: `--browser dev close --purge`.

## Fallback to the built-in browser device (last resort only)

chrome-agent reuses an existing Chrome (OMP's, or a standalone fallback it downloaded if OMP's is
absent), so it is self-sufficient for normal web work — you do NOT need the built-in `browser` tool.
Reach for the built-in `browser` tool only when chrome-agent genuinely cannot:
- raw puppeteer/JS you need beyond `eval` (e.g. request interception, custom waits)
- driving the user's real logged-in Chrome via relay (not present on this box today)
- `chrome-agent` errors on launch *after* you've confirmed a working Chrome is linked (see
  Container conventions) and the `.so` libs are installed.
