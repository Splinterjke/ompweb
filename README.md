# ompweb

<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="ompweb logo" />
</p>

<p align="center">
  <strong>Web UI app for <a href="https://github.com/can1357/oh-my-pi">oh-my-pi (omp)</a> coding agent.</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.ru.md">Русский</a>
</p>

ompweb provides a browser workspace for your local omp runtime: session browsing with branch navigation and forking, real-time chat over the omp RPC protocol, model / MCP / skill management, Git worktree switching, and rich file previews.

<details>
<summary>📸 I believe screenshots sometimes describe better than words</summary>

| | |
| :---: | :---: |
| Main workspace<br>![](screenshots/screenshot-main-workspace.png) | New-session composer<br>![](screenshots/new-session-composer.png) |
| Expanded process details (tool calls)<br>![](screenshots/chat-expanded-details.png) | Composer task panel<br>![](screenshots/composer-tasks-expanded.png) |
| Slash-command menu<br>![](screenshots/slash-command-popover.png) | Session-info / context popover<br>![](screenshots/session-info-popover.png) |
| Command palette<br>![](screenshots/command-palette.png) | Git Graph modal<br>![](screenshots/gitgraph-commit-log.png) |
| Git Graph — commit diff<br>![](screenshots/gitgraph-commit-diff.png) | File Viewer tab<br>![](screenshots/fileviewer-tab.png) |
| Session list (expanded)<br>![](screenshots/sidebar-sessions-full.png) | Archived sessions browser<br>![](screenshots/archived-sessions.png) |
| Explorer (hover + mention)<br>![](screenshots/explorer-hover-mention.png) | Sub-agents panel (Tasks)<br>![](screenshots/rightpanel-taskmanager.png) |
| Git panel (changed files)<br>![](screenshots/rightpanel-git.png) | Goal & Subagents hub (expanded)<br>![](screenshots/composer-goal-subagents.png) |
| Side chat panel<br>![](screenshots/rightpanel-sidechat.png) | Side chat (empty state)<br>![](screenshots/rightpanel-sidechat-empty.png) |
| Files panel<br>![](screenshots/rightpanel-files.png) | Chat minimap hover tooltip<br>![](screenshots/minimap-tooltip.png) |
| Service-error recovery queue<br>![](screenshots/service-error-recovery.png) | Chat event actions<br>![](screenshots/chat-event-actions-section.png) |
| Chat events actions modals<br>![](screenshots/chat-event-actions-modals.png) | Scheduler edit dialog<br>![](screenshots/scheduler-edit-modal.png) |
| Embedded terminal (open)<br>![](screenshots/embedded-terminal.png) | Theme Palette — Static<br>![](screenshots/themepalette-static.png) |
| Theme Palette — Flowing<br>![](screenshots/themepalette-flowing.png) | Theme Palette — Motion<br>![](screenshots/themepalette-motion.png) |
| Theme Palette — Font<br>![](screenshots/themepalette-font.png) | Theme Palette - UI Font Scale<br>![](screenshots/theme-palette-ui-scale-settings.png) |
| Settings — Interface & Behavior<br>![](screenshots/settings-interface-behavior.png) | Settings — Safety & Approvals<br>![](screenshots/settings-safety-approvals.png) |
| Settings — AI Model Defaults<br>![](screenshots/settings-ai-model-defaults.png) | Settings — Agent & Intelligence<br>![](screenshots/settings-agent-intelligence.png) |
| Settings — Agents<br>![](screenshots/settings-agents.png) | Settings — Extensions & Tools<br>![](screenshots/settings-extensions-tools.png) |
| Settings — OMP Native<br>![](screenshots/settings-omp-native.png) | Settings — Remote Access<br>![](screenshots/settings-remote-access.png) |
| Settings — Skill Hub<br>![](screenshots/settings-skill-hub.png) | Settings — System & Updates<br>![](screenshots/settings-system-updates.png) |
| Settings — search<br>![](screenshots/settings-search.png) | Settings — Diagnostics & Recovery<br>![](screenshots/settings-diagnostics.png) |
| Theme: Light (Warm Paper)<br>![](screenshots/screenshot-theme-light.png) | Theme: omp Midnight<br>![](screenshots/screenshot-theme-omp-midnight.png) |
| Theme: Oatmeal Latte<br>![](screenshots/screenshot-theme-oatmeal-latte.png) | Theme: Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro.png) |
| Theme: Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum.png) | Theme: Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai.png) |
| Theme: Monochrome (Codex)<br>![](screenshots/screenshot-theme-monochrome-codex.png) | Theme: Monokai Pro Light Sun<br>![](screenshots/screenshot-theme-monokai-pro-light-sun.png) |
| Theme: Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn.png) | Theme: Harbor<br>![](screenshots/screenshot-theme-harbor.png) |
| Theme: Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha.png) | Mobile: Harbor<br>![](screenshots/screenshot-theme-harbor-mobile.png) |
| Theme: Nord Arctic<br>![](screenshots/screenshot-theme-nord.png) | Theme: Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha.png) |
| Theme: OLED Obsidian<br>![](screenshots/screenshot-theme-oled.png) | Theme: Warm Ember<br>![](screenshots/screenshot-theme-dark.png) |
| Theme: Antique Vellum<br>![](screenshots/screenshot-theme-sepia.png) | Theme: Dracula Velvet<br>![](screenshots/screenshot-theme-dracula.png) |
| Theme: Pine Forest<br>![](screenshots/screenshot-theme-pine.png) | Theme: Horizon Navy<br>![](screenshots/screenshot-theme-navy.png) |
| Theme: Monokai Classic<br>![](screenshots/screenshot-theme-monokai.png) | Theme: Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon.png) |
| Theme: Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine.png) | Theme: Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto.png) |
| Theme: Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light.png) | Theme: One Light<br>![](screenshots/screenshot-theme-one-light.png) |
| Theme: One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro.png) | Theme: Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte.png) |
| Theme: Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark.png) | Theme: Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night.png) |
| Theme: Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine.png) | Mobile: Light (Warm Paper)<br>![](screenshots/screenshot-theme-light-mobile.png) |
| Mobile: Nord Arctic<br>![](screenshots/screenshot-theme-nord-mobile.png) | Mobile: Oatmeal Latte<br>![](screenshots/screenshot-theme-oatmeal-mobile.png) |
| Mobile: Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha-mobile.png) | Mobile: OLED Obsidian<br>![](screenshots/screenshot-theme-oled-mobile.png) |
| Mobile: Monochrome (Codex)<br>![](screenshots/screenshot-theme-codex-mobile.png) | Mobile: Warm Ember<br>![](screenshots/screenshot-theme-dark-mobile.png) |
| Mobile: Antique Vellum<br>![](screenshots/screenshot-theme-sepia-mobile.png) | Mobile: Dracula Velvet<br>![](screenshots/screenshot-theme-dracula-mobile.png) |
| Mobile: Pine Forest<br>![](screenshots/screenshot-theme-pine-mobile.png) | Mobile: Horizon Navy<br>![](screenshots/screenshot-theme-navy-mobile.png) |
| Mobile: Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai-mobile.png) | Mobile: Monokai Classic<br>![](screenshots/screenshot-theme-monokai-mobile.png) |
| Mobile: Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro-mobile.png) | Mobile: Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon-mobile.png) |
| Mobile: Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine-mobile.png) | Mobile: Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto-mobile.png) |
| Mobile: Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum-mobile.png) | Mobile: Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light-mobile.png) |
| Mobile: Monokai Pro Light Sun<br>![](screenshots/screenshot-theme-monokai-pro-light-sun-mobile.png) | Mobile: omp Midnight<br>![](screenshots/screenshot-theme-omp-mobile.png) |
| Mobile: One Light<br>![](screenshots/screenshot-theme-one-light-mobile.png) | Mobile: One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro-mobile.png) |
| Mobile: Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte-mobile.png) | Mobile: Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha-mobile.png) |
| Mobile: Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark-mobile.png) | Mobile: Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night-mobile.png) |
| Mobile: Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine-mobile.png) | Mobile: Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn-mobile.png) |
</details>

## 🐳 Running in Docker

The project is primarily adapted to run inside Docker (Linux): the `docker-compose.yaml` at the repository root builds the image, mounts the repository, and maps the launcher ports. Start it with a single command:

```bash
docker compose up -d --build
```

then open [http://127.0.0.1:6767](http://127.0.0.1:6767) (see **Environment variables** below for the password).
Note: the compose file binds `c:/users/dev/.omp` to `/root/.omp` inside the container by default — please update this `source:` path to the `.omp` store of your own user (`~/.omp` on Linux, or `c:/users/{user}/.omp` on Windows) before starting the container, so that the container uses your existing credentials, sessions, and settings.

The mobile web version is a full-featured PWA: add it to your phone's home screen and it behaves like a native app.
Building and running it as a standalone Windows / Linux / macOS application is equally supported.
Forking the project and extending it is explicitly encouraged.

## ⚙️ Ports

The launcher probes the sibling ports `SIBLING_PORTS = [30177, 30178, 30179]` (hardcoded in `bin/omp-web.js`); `docker-compose.yaml` maps all three into the container. Use these ports when an agent starts a dev server inside the container and you want to reach / debug it from a browser on the host.

## 🔑 Default password

The compose file ships with `OMP_WEB_PASSWORD=asdf1234` by default — use it at the login screen, or override it to your own value.

## 🔄 Rebuild & restart (bound repository)

When the repository is mounted into the container (the compose default), a `ompweb-rebuild-restart.sh` script is registered in the **Script schedulers** settings as a *manual-launch* scheduler — a convenient way to rebuild and redeploy ompweb after your agent has modified the source. Only a page refresh is needed afterwards to pick up the new build. Once a fresh build is deployed and OmpWeb has started, you receive an in-UI notification offering a **Refresh page** button. Note: a concurrently running ompweb dev server instance may occasionally make the main instance's build stale.

## 🤖 Agents MCP

The bundled multi-agent **Agent MCP** server is disabled by default. Enable it (Settings → Extensions & Tools → MCP) if you intend to let the OMP agent spawn and coordinate different agents.

## 🙏 Credits & Improvements

The project incorporates improvements originally contributed by the `kahme247` and `37chengshan` forks, elegantly merged into the codebase with only the useful features retained; the majority of fixes were provided by Splinterjke. Selected improvements:

- Major bugs with files exploring, scrollbar weird behaviour and so on mostly solved, but some left specifically for you, hehe
- Configurable Context Compaction settings and priority
- A large set of new themes and palettes (Monokai family, Omarchy Monokai, Catppuccin, Rosé Pine, Harbor, omp Midnight, Oatmeal Latte an many others) with corrected surface tokens and themed text selection
- Git Graph modal — visual repository history with per-commit file diff browsing
- Improved RPC / IPC communication, including session restoration and turn continuation after server restarts
- OmpWeb rebuild & restart fixes: refresh notification with an explicit refresh button, loopback `/api/ui/refresh` exemption, manual scheduler seeding
- Chat minimap / scrollbar improvements: full-height rail, gradient accent beam, rail-height-bounded thumb, larger hover tooltips
- Clockwise gradient border beam on the chat input
- Unified, generalized font-size settings across the interface
- Expandable and resizable sections in the left sidebar, plus resizable sidebar / workbench panes
- Script schedulers functionality (interval, daily, weekly, cron, manual) with a dedicated settings panel
- Chat event actions — named automations (notification, HTTP request, bash command, scheduled script) triggered by chat lifecycle events, with event data variables in the payload
- Improved Skill Hub and Agents pages in Settings - Skill hub and Agents show instances not only from active workspace, but from each one
- Better new-session composer with workspace picker, plus-menu attachments, and context ring
- Expandable thinking and detail blocks with inline expansion of complete tool inputs
- 3-zone top bar with a center workspace / session breadcrumb, session-info popover, and sub-agents hub in the composer
- Removal of unnecessary extras, with layout / gutter and performance cleanups

## 🛠️ Environment variables

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `PORT` / `-p` / `--port` | Server port | `6767` |
| `OMP_WEB_HOSTNAME` / `-H` / `--hostname` | Bind hostname | `127.0.0.1` |
| `OMP_WEB_PASSWORD` / `--password` | Web sign-in password (compose default: `asdf1234`) | *(None / disabled)* |
| `OMP_WEB_ALLOWED_HOSTS` | Comma-separated non-loopback hosts allowed to reach the app | *(empty — loopback only)* |
| `OMP_WEB_NO_OPEN` | Skip opening browser automatically | `0` (`1` to skip) |
| `OMP_WEB_DISABLE_AUTOUPDATE` | Set to `1` to disable update checks and in-app updates; restart after changing | `0` |
| `OMP_WEB_OMP_BIN` | Absolute path to `omp` binary | Resolved from `PATH` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI-compatible transcription endpoint URL | _None (disabled)_ |
| `OMP_WEB_STT_KEY` | Optional API key for the STT endpoint | _None_ |
| `OMP_WEB_STT_MODEL` | Optional model name for the STT endpoint | _None_ |
| `PI_CODING_AGENT_DIR` | OMP agent home directory | `~/.omp/agent` |
| `HTTP_PROXY` / `HTTPS_PROXY` | Proxies for server-side requests | *(System default)* |

## 📄 License

Licensed under the [MIT License](./LICENSE).
