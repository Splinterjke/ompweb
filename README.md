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

ompweb provides a browser workspace for your local omp runtime: session browsing with branch navigation and forking, real-time chat over the omp RPC protocol, model / MCP / skill management, Git worktree switching, and rich file previews. One ompweb can also link other machines and run sessions there, with the sidebar grouping sessions by host (see **Run sessions on another machine**). Skill conflicts and redundant installations appear above the composer when an omp session starts; **×** dismisses the notice for that session until the report changes, and **Turn off** and **Settings → Skill startup notices** disable it.

<details>
<summary>📸 I believe screenshots sometimes describe better than words</summary>

| | |
| :---: | :---: |
| Main workspace<br>![](screenshots/screenshot-main-workspace.png) | Memory panel (Mnemopi)<br>![](screenshots/side-panel-workspace-mnemopi-memories.png) |
| Automation tasks (scheduled prompts)<br>![](screenshots/automation-tasks-prompt-type-list.png) | Automation task edit dialog (prompt)<br>![](screenshots/automation-tasks-prompt-type-modal.png) |
| Compact hub bars (row layout)<br>![](screenshots/compact-hub-bars.png) | New-session composer<br>![](screenshots/new-session-composer.png) |
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
| Theme: Deep Seek<br>![](screenshots/screenshot-theme-deep-seek-dark.png) | Theme: Qwen Chat<br>![](screenshots/screenshot-theme-qwen-dark.png) |
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

The compose file ships a default `OMP_WEB_PASSWORD_HASH` — the hash of the dev
password `asdf1234`. Use that password at the login screen, or generate your
own (`ompweb hash-password`) and set `OMP_WEB_PASSWORD_HASH` in a `.env` file
next to the compose file (`.env` values are literal; only an inline compose
default needs its `$` written as `$$`). A legacy plaintext `OMP_WEB_PASSWORD`
still works: the container entrypoint hashes it once, persists the hash under
the bound `.omp` store and clears the plaintext, so restarts keep sign-ins.

omp-web no longer hands a plaintext password to the server: every `omp`
session inherits the server's environment, so an agent running `env` could
print the password into its transcript and off to the model provider.
`ompweb` hashes a lone `OMP_WEB_PASSWORD` at startup, keeps the plaintext out
of the server's environment, and warns with the `OMP_WEB_PASSWORD_HASH` to set
instead. `--password` was removed, and setting both variables stops `ompweb`;
remove `OMP_WEB_PASSWORD`. Generate a hash with:

```bash
ompweb hash-password                                 # prompts twice, input hidden
echo "a-long-random-password" | ompweb hash-password # or pipe it in
OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' ompweb
```

`ompweb hash-password` reads the password from stdin — never from a command
line argument — so it stays out of your shell history and out of `ps`. The
hash is scrypt (N = 2^15, r = 8, p = 1) with a fresh 16-byte salt, printed as
`scrypt$<ln>$<r>$<p>$<salt>$<digest>`; anyone who reads it can neither sign in
with it nor turn it back into the password. Sessions are not signed with the
hash: a random per-installation key at
`~/.omp/agent/omp-web/web-auth-secret.json` (mode `0600`) is mixed with it, so
a copied hash cannot forge a session and changing the password still signs
every browser out.

### Skipping the password on trusted networks

omp-web cannot see the client's address itself, so it leaves the decision to
your reverse proxy. The proxy sends a secret in the `X-Omp-Web-Auth` header,
and omp-web holds only that secret's SHA-256 digest in
`OMP_WEB_TRUSTED_HEADER_SHA256`. A request whose header hashes to that digest
is treated as signed in; everyone else still signs in with the password.
Without a configured password hash there is nothing to skip and the header is
ignored. Keep omp-web bound to `127.0.0.1` so only the proxy reaches it.

Generate the secret without typing it on a command line, so it never lands in
shell history — this writes it into an nginx include and prints only the
digest:

```bash
secret=$(openssl rand -hex 32)
printf 'map $ompweb_trusted $ompweb_auth {\n    1        "%s";\n    default  "";\n}\n' "$secret" \
  | sudo install -m 0640 -o root -g www-data /dev/stdin /etc/nginx/ompweb-auth.conf
printf %s "$secret" | sha256sum | cut -d' ' -f1
unset secret
```

Set the printed digest as `OMP_WEB_TRUSTED_HEADER_SHA256`. Always generate a
long random secret this way: omp-web stores only an unsalted SHA-256 digest,
which is safe only against dictionary attacks on a random value. In nginx,
pick the trusted clients with `geo` and always set the header — the empty
value replaces any `X-Omp-Web-Auth` a client sends itself:

```nginx
# http {} context
geo $ompweb_trusted {
    default       0;
    10.0.0.0/16   1;
}
include /etc/nginx/ompweb-auth.conf;  # the map written above

# the location that proxies to omp-web
proxy_set_header X-Omp-Web-Auth $ompweb_auth;
```

Serve omp-web only under an explicit `server_name`, with a `default_server`
block answering every other hostname with `return 444;` — otherwise any site a
trusted browser visits can point its own domain at your nginx (DNS rebinding)
and have it add the secret. `geo` checks `$remote_addr`; when clients reach
nginx through another proxy (Cloudflare, Cloudflare Tunnel, …), use the
[`realip` module](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
(`set_real_ip_from` the provider's published ranges + `real_ip_header
CF-Connecting-IP` for Cloudflare) so the geo check sees the real client
address.

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

## 📲 App installation behind authentication

To install the web app, sign in first and use your browser's installation menu.
The single manifest link requests `/api/manifest` with credentials; that endpoint
uses the existing web-password guard and private, revalidating caching. Its
192×192 and 512×512 PNG icons are embedded from the packaged favicon set because
Android's native installer fetches ordinary icon URLs without authentication
cookies. The app still launches at `/` with scope `/`. Its `theme_color` and
`background_color` come from the manifest link's `?theme=` parameter: Chrome
refreshes an installed app's manifest without cookies, so the server renders the
selected theme's color (remembered in the `omp-theme-color` cookie) into the
link. Chrome 153 and later color an installed app's Android navigation bar from
it after Chrome next checks the app for manifest updates.

No public manifest exception is needed; `/api/manifest` stays behind the same
password guard as every other API route. This does not add offline support.

## 🔔 Notifications

Turn on notifications in **Settings → Notifications**. Each browser keeps its own
settings: which events notify (task finished, waiting for input, run failed,
model switched automatically) and what happens while you use omp-web in another
tab (an in-app toast, or always a system notification). Nothing is shown for the
session you are viewing. Clicking a notification opens its session.

- **Push** reaches the browser even when no omp-web tab is open. It needs a
  secure context (HTTPS through your reverse proxy, or `localhost`), and the
  omp-web server needs outbound HTTPS access to the browser vendors' push
  services. omp-web generates its push (VAPID) keys on first use and stores them,
  with the device list and the notification history, in its data directory
  (owner-only), so they survive restarts.
- On **iPhone and iPad** (iOS 16.4 or later), push works only in the app added
  to the Home Screen.
- In a secure context without push support, system notifications appear while
  an omp-web tab is open. Over plain HTTP on a non-localhost address, browsers
  allow no system notifications: only the in-app toasts shown while you use
  omp-web remain.
- Desktop browsers show notifications through the operating system's
  notification center. Push delivery needs the browser process running.

Completion notifications use omp's `prompt_result` and `session_settled` RPC
frames (omp 18.3.1 or later).

## Two services: the web server and the local daemon

ompweb runs this machine's `omp` sessions through a small daemon, `ompweb host`,
linked to the web server over loopback.

**Running ompweb** (`ompweb` in a terminal, or `npx @kahme247/ompweb@latest`) does
not start the daemon itself, so nothing runs `ompweb host`: keep `ompweb host`
(with npx: `npx @kahme247/ompweb@latest host`) running in a second terminal.
Without it "This machine" stays offline. The web server writes
the daemon's link when it starts, so start the web server first.

- **Restarting or redeploying the web server does not interrupt runs.** The daemon
  keeps the omp processes running; the restarted web server takes them over, with
  no resume prompt, and dialogs or tool calls omp was waiting on reappear.
- **Restarting the daemon does end runs** (it owns the omp processes). With auto-resume
  on, sessions that were running resume once. Upgrades restart the daemon only when
  its link protocol version is outside the range the new release supports.
- **First start after an upgrade:** if no daemon has linked after about 90 seconds,
  ompweb shows a banner with the command to start the daemon. Until the daemon runs,
  "This machine" shows offline and new sessions on it cannot start.
- **It is a host like any other.** Rename "This machine" in **Settings → Hosts**
  (clear the name to reset it); it cannot be revoked. The web server writes the
  daemon's link (`~/.omp/agent/omp-web/host.json`, mode `600`) at startup, only
  for a loopback bind address.
- **Development:** `npm run dev` does not take the daemon: only the production web
  server writes the daemon's `host.json`, so "This machine" shows offline in dev
  and the daemon stays linked to your installed ompweb.

## 🖥️ Run sessions on another machine

One ompweb can start and watch omp sessions on other machines. Each machine keeps
its own `omp` install, `~/.omp/agent` directory, sessions, and credentials;
ompweb only routes. The remote machine needs `omp` and either Node 24 (for `npx`) or
the [single binary](#single-binary), and must be able to reach the ompweb server over
HTTP(S). It dials out, so it can sit behind NAT.

1. On the ompweb server, open **Settings → Hosts → Add host**, enter a name, and copy
   the token. The token is shown once; only its hash is stored.
2. On the remote machine, save the link. The token is read from stdin, never from
   an argument, so it does not show up in `ps`:

   ```bash
   ompweb host login --url https://your-ompweb.example.com
   ```

   Paste the token when prompted (or pipe it in). It is saved to
   `~/.omp/agent/omp-web/host.json` with mode `600`.
3. Start the link and leave it running:

   ```bash
   ompweb host
   ```

   The host shows **online** in Settings → Hosts, the sidebar gets a group for it,
   and the new-session screen gets a host picker.

**Settings → Hosts** also shows each machine's ompweb daemon and OMP runtime
versions, available updates and update actions, including **This machine**.
Checks and installations run on the selected host, not on the web server. A host
update whose link protocol is incompatible with the current web app stays visible
but is blocked with a reason; update the web server first. An unverifiable target
protocol is blocked too. OMP updates are independent of the link protocol.
Before updating a daemon, close its session processes: the updater refuses to
interrupt sessions or subagents. Updating OMP leaves existing processes on their
loaded version until they restart. **Settings → System** keeps the web server's
own application update and service settings.
Hosts need a daemon build that supports these update operations; older builds
show an unsupported message and need one manual update first. If the daemon
shares its installation with the web server, update the server first, then use
the host's restart-only update. Unsupported service wrappers and detected restart
scripts show a manual-update reason. Stop external restart loops before updating
a foreground daemon.

A daemon update is carried out by a separate updater process on the host. It
stops the daemon, swaps in the new release and starts it again, and on a failure
it restores the previous release. If that updater is itself killed after stopping
the daemon (a reboot, an out-of-memory kill), nothing restarts the host, which
stays offline. Recover on the host: in the folder containing the installation,
`.ompweb-backup-<id>` is the previous release. If it is there, move the
installation aside and rename the backup back to the installation's name; then
start `ompweb host` (or its service) again. Settings → Hosts reports the update
as interrupted.

`https://` is required. Plain `http://` is accepted only for loopback addresses, or
with `--allow-http` (for example on a tailnet):

```bash
ompweb host login --url http://100.64.0.1:6767
ompweb host --allow-http
```

If the connection drops, the daemon reconnects by itself (1 s backoff doubling to
60 s; 3 s at most for the web server on the same machine). After a failed dial it
re-reads its saved link, so a web server that came back on another port is found
without restarting the daemon. After a network drop, runs keep going on the remote machine; the chat shows
an offline banner and the runs reattach when the link returns. A laptop that goes
to sleep (closing the lid, usually) pauses the daemon and its omp runs along with
everything else on it: they resume when it wakes, and the link returns then. A
docked or no-sleep setup keeps running with the lid closed. Revoking a host in
Settings closes its link and the daemon stops its omp processes.

Behind a reverse proxy, forward WebSocket upgrades on `/api/events/link` (the browsers' live connection) and `/api/hosts/link` (nginx: `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";`, and a `proxy_read_timeout` well above 30 s). Without the upgrade, a browser falls back to server-sent events after a few seconds.

Update ompweb on the server before its hosts: a host from before this version shows **needs upgrade** until it is updated.

Notes:


- **The server's agent directory holds the host list** (`omp-web/hosts.json`).
  Starting the ompweb server with a different `PI_CODING_AGENT_DIR`, or losing
  that file, makes every host token unknown: each daemon is told it was revoked,
  stops its omp processes and exits. In Docker this is the `~/.omp` volume mounted
  into the container, so keep it persistent.
- **Trust:** a linked host runs omp with full tool access on that machine for
  whoever controls the ompweb server or the token. Keep the token private and
  revoke it when a machine is retired.
- **Workspace files on every host:** Explorer, previews, downloads, file search,
  @-mentions and live file watching use the owning machine's daemon, including
  This machine. Explorer uploads accept up to 2 GiB per file with no 100 MiB batch
  cap; preview limits remain 256 KiB for text and 10 MiB for images/DOCX.
  File tabs retain their source host when you switch chats. An unavailable or
  older daemon reports offline or asks for an update; main never substitutes its
  own filesystem.
- **Git and worktrees on every host:** status, diffs, GitHub issue links, and
  worktree creation, selection and removal run on the owning daemon. Dirty
  worktrees still require explicit force confirmation. Switching a worktree
  changes where new sessions start, not an open conversation.
- **Directory browsing and cloning on every host:** the Add workspace picker
  navigates that host's directories and clones HTTPS/SSH repositories there.
  Cancelling waits for the clone process and safe cleanup; interrupted connections
  report an unknown outcome rather than pretending the clone was cancelled.
  If the destination changes during cleanup, captured data is preserved in a
  private quarantine and the error gives its location; inspect it before removing
  or restoring anything.
- **Not available on remote hosts yet:** session archiving and the Skills,
  Plugins, Agents and MCP settings. Transcript search still scans this machine.
- **Agent-started sessions:** with agent tools enabled, an agent can pass a `host`
  to `new_session` (it defaults to the agent's own host). A remote host asks for
  confirmation each time unless **Agents can start sessions here without asking**
  is switched on for it in Settings → Hosts. An agent running on a remote host
  always asks before it starts or messages a session on this machine.
- The daemon exits with code `1` when the server revokes its token or when its
  link protocol version is outside the range the server supports (older than the
  server's oldest supported version, or newer than the server: update ompweb on
  the older side), and `0` when a newer link for the same host replaces it.
  SIGTERM or SIGINT stops the daemon and its omp processes. A link is one-per-host,
  so never run two daemons with the same token. To keep the link up across logouts
  or reboots, run `ompweb host` under a supervisor of your choice that restarts it
  after failure.

### Keep a host running as a service

These run the [single binary](#single-binary) in host mode. On Linux and Windows a
service keeps the link up across logouts and reboots; on macOS a script keeps it
running in a terminal (see below for why). Unpack the release for the machine first,
then save the link once with `ompweb host login --url …` as in step 2 (with the
binary's path in place of `npx @kahme247/ompweb@latest`). Each setup starts
`ompweb host` again 10 seconds after it fails, but not after exit 0: that means a
newer link with the same token replaced it, and restarting would take the link back
every 10 seconds. Add `--allow-http` after `host` if
the server URL is plain `http://`, and set `PI_CODING_AGENT_DIR` in the service too
if you saved the link with it set. A machine links to one server: do not also run an
ompweb web server on it, which writes the same link file for its own daemon. To
update, stop the service, replace the release directory, and start it again. After
revoking a host, stop and remove its service: it otherwise keeps retrying.

**Linux (systemd user service).** Create `~/.config/systemd/user/ompweb-host.service`
(adjust the release path, and add omp's directory to `PATH` or set `OMP_WEB_OMP_BIN`):

```ini
[Unit]
Description=ompweb host
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
# Exit 0: a newer link for this host replaced it. Restarting would take the link back.
RestartPreventExitStatus=0
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb-host
loginctl enable-linger "$USER"            # keep it running while you are logged out
journalctl --user -u ompweb-host -f       # logs
```

**macOS (from a terminal).** No launchd job can run a host that omp sessions can
fully use: a LaunchDaemon has no login keychain or SSH agent, which sessions need
for SSH keys and commit signing, and a LaunchAgent cannot reach LAN addresses. A
process started from a terminal inherits the terminal's keychain and SSH agent, so
run the host there, in tmux so it outlives the window.

tmux does not keep the terminal's Local Network permission, though: the tmux server
detaches from the terminal app, and macOS Local Network privacy then blocks the
ad-hoc signed `ompweb` binary from LAN addresses (`connect` fails with "No route to
host", which the daemon reports as `ECONNREFUSED`; Apple's own tools such as `curl`
are not blocked, so a `curl` test passes). Link the host to a URL that does not
resolve to a LAN address, for example the server's public URL, or its VPN or
tailnet name (a Tailscale MagicDNS name served by your reverse proxy with its own
certificate). Save this as `~/.local/bin/ompweb-host-run` (adjust `DIR`) and make
it executable with `chmod +x`:

```sh
#!/bin/sh
# Keeps `ompweb host` running in this terminal, which lends it its keychain and SSH agent.
# Restarts it 10 s after a crash; stops when the token is revoked or the link protocol is
# unsupported (exit 1), or on exit 0: a newer link replaced it, or it was stopped (Ctrl-C).
DIR=${OMPWEB_DIR:-$HOME/.local/share/ompweb-darwin-arm64}
# A tmux started over SSH sees the login keychain locked: unlock it while a terminal can ask.
security show-keychain-info login.keychain-db 2>/dev/null || security unlock-keychain login.keychain-db || exit 1
while :; do
	(cd "$DIR" && exec ./ompweb host)
	rc=$?
	case $rc in 0 | 1) exit "$rc" ;; esac
	echo "ompweb host exited $rc; restarting in 10 s" >&2
	sleep 10
done
```

Run `ompweb-host-run` in a tmux window; Ctrl-C stops the daemon and its sessions.
Start it again after a reboot or logout. If the login keychain locks itself after
inactivity or on sleep, SSH key passphrases and signing fail until you restart it.

**Windows (scheduled task at logon).** In PowerShell, with `$dir` set to the
unpacked release:

```powershell
$dir = "$env:LOCALAPPDATA\ompweb-windows-x64"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\logs" | Out-Null
Set-Content "$dir\ompweb-host.ps1" @'
# Starts `ompweb host` again 10 s after it fails, and stops on exit 0 (a newer link replaced it).
# Output goes to ~\.omp\agent\logs\ompweb-host.log, moved to .log.1 past 10 MB (checked between restarts).
# For a plain http:// server URL, put --allow-http after `host` below.
$log = "$env:USERPROFILE\.omp\agent\logs\ompweb-host.log"
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item $log "$log.1" -Force }
  & "$PSScriptRoot\ompweb.exe" host 2>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $log
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep 10
}
'@
Register-ScheduledTask -TaskName ompweb-host -Force `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") `
  -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\ompweb-host.ps1`"") `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries)
Start-ScheduledTask ompweb-host
```

Stop it with `Stop-ScheduledTask ompweb-host`, then end the running host with
`Get-Process ompweb | Where-Object Path -eq "$env:LOCALAPPDATA\ompweb-windows-x64\ompweb.exe" | Stop-Process`
(only this release's `ompweb.exe`; adjust the path as for `$dir`). Remove it with
`Unregister-ScheduledTask ompweb-host`.

## 🛠️ Environment variables

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `PORT` / `-p` / `--port` | Server port | `6767` |
| `OMP_WEB_HOSTNAME` / `-H` / `--hostname` | Bind hostname | `127.0.0.1` |
| `OMP_WEB_PASSWORD_HASH` | Scrypt hash of the web sign-in password, from `ompweb hash-password`; required for a non-loopback bind (compose ships a default hash for the dev password `asdf1234` — replace it for real deployments) | *(None / disabled)* |
| `OMP_WEB_TRUSTED_HEADER_SHA256` | SHA-256 hex digest of the secret a trusted reverse proxy sends in `X-Omp-Web-Auth` to skip the password for that request; see [Skipping the password on trusted networks](#skipping-the-password-on-trusted-networks) | *(None / disabled)* |
| `OMP_WEB_ALLOWED_HOSTS` | Comma-separated non-loopback hosts allowed to reach the app | *(empty — loopback only)* |
| `OMP_WEB_NO_OPEN` | Skip opening browser automatically | `0` (`1` to skip) |
| `OMP_WEB_DISABLE_AUTOUPDATE` | Set to `1` to disable update checks and in-app updates; restart after changing | `0` |
| `OMP_WEB_NAME` | Name shown in browser tabs and installed-app names. `url`, `host` or `domain` (any case) uses the hostname the browser connected to, without port; localhost and IP addresses keep `omp web`. Any other value is used as-is. Restart after changing | `omp web` |
| `OMP_WEB_OMP_BIN` | Path to `omp` binary if not on `PATH` | _auto-detected_ |
| `PI_CODING_AGENT_DIR` | Custom omp agent directory | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI-compatible transcription endpoint URL. Leave unset to transcribe with `OMP_WEB_STT_MODEL` through omp's own credentials | _None_ |
| `OMP_WEB_STT_KEY` | Optional API key for the STT endpoint | _None_ |
| `OMP_WEB_STT_MODEL` | Model name for the STT endpoint. Without an endpoint: an omp speech-to-text model run with omp's logins, such as `openai-codex/codex-transcribe` (ChatGPT subscription; needs an omp version with that model) | _None (disabled without an endpoint)_ |
| `PI_CODING_AGENT_DIR` | OMP agent home directory | `~/.omp/agent` |
| `HTTP_PROXY` / `HTTPS_PROXY` | Proxies for server-side requests | *(System default)* |

**`OMP_WEB_NAME` and installed apps.** An installed app (PWA) is usually named after the page it was installed from. If you later change `OMP_WEB_NAME`, or reach omp-web through a different address while `OMP_WEB_NAME` is `url`, `host` or `domain`, your operating system may rename the installed app as well. Leave `OMP_WEB_NAME` empty, or set a name that identifies this omp-web server whatever domain name or address is used to reach it.


`npm run dev` runs the server with Bun hot reload. `npm run build` bundles the browser app into `dist/`, and `npm start` serves it on port 30177 (`npm run smoke` checks the result). `npm run dev:lan` binds the dev server to all interfaces. `npm run build:binary` builds the [single binary](#single-binary) for this machine into `release/` (`-- --target bun-linux-arm64` and the like for another platform; `npm run smoke -- --binary release/ompweb-linux-x64/ompweb` checks it).

## 📄 License

Licensed under the [MIT License](./LICENSE).
