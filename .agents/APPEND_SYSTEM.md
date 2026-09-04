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
