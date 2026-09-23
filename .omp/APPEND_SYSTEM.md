# Browser automation default: use chrome-agent

For browser tasks (rendered pages, local dev servers, click/fill forms, inspect rendered UI,
screenshots, multi-step navigation), use the `chrome-agent` CLI via `bash` — see
`skill://chrome-agent-default`. Prefer it over the managed `browser` (Eval) tool, which launches a
separate Puppeteer Chromium and is not this machine's default.
- chrome-agent is self-sufficient on its own standalone Chrome (`/root/.chrome-agent/chrome/...`,
  on PATH as `google-chrome`). Do NOT use or download the OMP `puppeteer/chrome` copy as a
  fallback.
- Always pass `--chrome-arg --no-sandbox --chrome-arg --disable-dev-shm-usage` (solves root + 64 MB
  `/dev/shm`).
- Static/public pages that need no JS or interaction: use the `read` tool with the URL first.
- Full reference: `skill://chrome-agent`. Record extraction: `skill://scrape-structured-data`.
- Use the managed `browser` tool only if chrome-agent truly cannot (raw puppeteer JS beyond
  `eval`); a real logged-in Chrome relay is not available here.

# Test suite: 20 pre-existing failures — ignore

`node --experimental-strip-types --test` over `components hooks lib desktop bin scripts`
reports **20 failing tests that are pre-existing environment issues**, not caused by any
changes in this repo's development. They fail identically on the unmodified tree (verified
2026-09-23 by stashing local changes and re-running the same files) and should be ignored
when verifying changes — judge your work by tests in files you touched:

- `components/AppShell.test.mjs` — top bar / model output capacity (1)
- `components/panels/RightWorkbench.test.mjs` — empty-state surfaces (1)
- `hooks/useDictation.behavior.test.mjs` — audio capture (4)
- `lib/backend-ownership.test.mjs` — ownership manifest (2)
- `lib/contracts/agent-contract.test.mjs` — error-codes golden (1)
- `lib/motion-manifest.test.mjs` — motion manifest golden (1)
- `lib/omp/host-bin.test.mjs` — "route 3: …" host-bin resolution (8)
- `lib/ui-request-contract.test.mjs` — execution matrix doc (1;
  `docs/refactor/ompweb-5.0/command-execution-matrix.md` is not present in this checkout)
