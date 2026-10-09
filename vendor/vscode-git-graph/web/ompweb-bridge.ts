/*
 * ompweb host bridge.
 *
 * Replaces the VS Code webview host API for the vendored Git Graph front-end. The
 * front-end talks to exactly three globals provided here:
 *   - acquireVsCodeApi()  -> { getState, setState, postMessage }
 *   - initialState / globalState / workspaceState (injected by /gitgraph)
 *
 * postMessage() either:
 *   - ignores setGlobalViewState/setWorkspaceViewState (extension-level
 *     settings persistence; the graph view state itself round-trips through
 *     getState/setState, which are stored in localStorage — the extension
 *     used VS Code workspaceState for that),
 *   - executes host hand-offs locally (clipboard, external links) or relays
 *     them to the embedding page (file open, diff open) and synthesizes the
 *     response message the front-end waits for, or
 *   - forwards the request as JSON to the ompweb API (POST ompwebGgBoot.apiBase),
 *     re-dispatching the JSON response as a window message — exactly the shape
 *     the front-end receives from VS Code.
 *
 * Host message protocol (window.parent <-> embedding page, same origin):
 *   iframe -> parent: ompweb-gg-ready
 *                     ompweb-gg-open-file {filePath}
 *                     ompweb-gg-open-diff {repo,mode,hash?,fromHash?,toHash?,oldPath,path}
 *   parent -> iframe: ompweb-gg-theme {vars,laneColors,dark}
 *                     ompweb-gg-open-file-result {ok} | ompweb-gg-open-diff-result {ok}
 */

interface OmpwebGgBoot {
	apiBase: string;
	repo: string;
}
declare const ompwebGgBoot: OmpwebGgBoot;

interface OmpwebGgThemeMessage {
	type: string;
	vars?: Record<string, string>;
	laneColors?: string[];
	dark?: boolean;
}

function ompwebGgPostToParent(msg: Record<string, unknown>) {
	if (window.parent !== window) {
		window.parent.postMessage(msg, window.location.origin);
	}
}

/** Re-dispatch a response message to the front-end's `window` message listener. */
function ompwebGgRespond(msg: object) {
	window.postMessage(msg, window.location.origin);
}

function ompwebGgCopyText(text: string, done: (error: string | null) => void) {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(
			() => done(null),
			() => done(ompwebGgCopyTextFallback(text))
		);
	} else {
		done(ompwebGgCopyTextFallback(text));
	}
}

function ompwebGgCopyTextFallback(text: string): string | null {
	try {
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(textarea);
		return ok ? null : 'Unable to copy to clipboard';
	} catch (e) {
		return 'Unable to copy to clipboard';
	}
}

/** Join a repo-relative path from the webview with its repo root (absolute paths pass through). */
function ompwebGgJoinRepoPath(repo: string, filePath: string): string {
	if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
		return filePath;
	}
	return repo.replace(/[\\/]+$/, '') + '/' + filePath;
}

/** Wait once for the embedding page's reply to a relayed request. */
function ompwebGgAwaitResult(resultCommand: string, onResult: (ok: boolean) => void) {
	const timer = setTimeout(() => {
		window.removeEventListener('message', listener);
		onResult(false);
	}, 4000);
	const listener = (event: MessageEvent) => {
		if (event.origin !== window.location.origin) return;
		const data: { type?: unknown; ok?: unknown } | null = event.data as { type?: unknown; ok?: unknown } | null;
		if (data !== null && typeof data === 'object' && data.type === resultCommand) {
			clearTimeout(timer);
			window.removeEventListener('message', listener);
			onResult(data.ok === true);
		}
	};
	window.addEventListener('message', listener);
}

function ompwebGgForwardToApi(msg: GG.RequestMessage) {
	const body: object = 'repo' in msg && typeof msg.repo === 'string' && msg.repo !== '' ? msg : { ...msg, repo: ompwebGgBoot.repo };
	fetch(ompwebGgBoot.apiBase, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}).then((response) => {
		return response.json().then(
			(json: unknown) => ompwebGgRespond(typeof json === 'object' && json !== null ? (json as object /* response payload is re-dispatched verbatim */) : { command: msg.command, error: 'Invalid response from the ompweb server' }),
			() => ompwebGgRespond({ command: msg.command, error: 'Invalid response from the ompweb server' })
		);
	}, () => ompwebGgRespond({ command: msg.command, error: 'Unable to reach the ompweb server' }));
}

function ompwebGgApplyTheme(msg: OmpwebGgThemeMessage) {
	const root = document.documentElement;
	if (msg.vars) {
		for (const name in msg.vars) {
			if (Object.prototype.hasOwnProperty.call(msg.vars, name)) {
				root.style.setProperty(name, msg.vars[name]);
			}
		}
	}
	if (msg.laneColors) {
		for (let i = 0; i < msg.laneColors.length; i++) {
			root.style.setProperty('--git-graph-color' + i, msg.laneColors[i]);
		}
	}
	if (msg.dark !== undefined) {
		if (msg.dark) {
			root.setAttribute('data-omp-dark', '1');
		} else {
			root.removeAttribute('data-omp-dark');
		}
	}
}

window.addEventListener('message', (event) => {
	if (event.origin !== window.location.origin) return;
	const data = event.data as OmpwebGgThemeMessage | null;
	if (data !== null && typeof data === 'object' && data.type === 'ompweb-gg-theme') {
		ompwebGgApplyTheme(data);
	}
});

const OMPWEB_GG_STATE_KEY = 'omp-web:git-graph:viewstate';

class OmpwebGgVsCodeApi {

	private state: WebViewState | null = null;
	private saveTimer: number | null = null;

	public getState(): WebViewState | null {
		if (this.state === null) {
			try {
				const raw = localStorage.getItem(OMPWEB_GG_STATE_KEY);
				if (raw !== null) {
					this.state = JSON.parse(raw) as WebViewState;
				}
			} catch (e) {
				this.state = null;
			}
		}
		return this.state;
	}

	public setState(state: WebViewState): void {
		this.state = state;
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			try {
				localStorage.setItem(OMPWEB_GG_STATE_KEY, JSON.stringify(this.state));
			} catch (e) {
				// Storage full or unavailable: view state is a nicety, never an error.
			}
		}, 300);
	}

	public postMessage(message: GG.RequestMessage): void {
		switch (message.command) {
			case 'setGlobalViewState':
			case 'setWorkspaceViewState':
				// Extension-level settings persistence; ompweb keeps its own settings, and the
				// graph view state round-trips through getState()/setState() above.
				break;
			case 'copyToClipboard':
				ompwebGgCopyText(message.data, (error) => ompwebGgRespond({ command: 'copyToClipboard', type: message.type, error }));
				break;
			case 'copyFilePath':
				ompwebGgCopyText(message.absolute ? message.filePath : ompwebGgJoinRepoPath(message.repo, message.filePath), (error) => ompwebGgRespond({ command: 'copyFilePath', error }));
				break;
			case 'openExternalUrl':
				window.open(message.url, '_blank', 'noopener');
				ompwebGgRespond({ command: 'openExternalUrl', error: null });
				break;
			case 'openFile':
				ompwebGgPostToParent({ type: 'ompweb-gg-open-file', filePath: ompwebGgJoinRepoPath(message.repo, message.filePath) });
				ompwebGgAwaitResult('ompweb-gg-open-file-result', (ok) => ompwebGgRespond({ command: 'openFile', error: ok ? null : 'Unable to open the file in ompweb' }));
				break;
			case 'viewFileAtRevision':
				// ompweb opens files (not revision blobs) in its file panel; the working-tree
				// file is shown when the exact revision content is unavailable.
				ompwebGgPostToParent({ type: 'ompweb-gg-open-file', filePath: ompwebGgJoinRepoPath(message.repo, message.filePath) });
				ompwebGgAwaitResult('ompweb-gg-open-file-result', (ok) => ompwebGgRespond({ command: 'viewFileAtRevision', error: ok ? null : 'Unable to open the file in ompweb' }));
				break;
			case 'viewDiff':
				ompwebGgPostToParent({ type: 'ompweb-gg-open-diff', repo: message.repo, mode: 'compare', fromHash: message.fromHash, toHash: message.toHash, oldPath: message.oldFilePath, path: message.newFilePath });
				ompwebGgAwaitResult('ompweb-gg-open-diff-result', (ok) => ompwebGgRespond({ command: 'viewDiff', error: ok ? null : 'Unable to display the diff in ompweb' }));
				break;
			case 'viewDiffWithWorkingFile':
				ompwebGgPostToParent({ type: 'ompweb-gg-open-diff', repo: message.repo, mode: 'working', hash: message.hash, oldPath: message.filePath, path: message.filePath });
				ompwebGgAwaitResult('ompweb-gg-open-diff-result', (ok) => ompwebGgRespond({ command: 'viewDiffWithWorkingFile', error: ok ? null : 'Unable to display the diff in ompweb' }));
				break;
			case 'fetchAvatar':
				// No remote avatar service: the front-end falls back to initials.
				ompwebGgRespond({ command: 'fetchAvatar', email: message.email, image: "" });
				break;
			case 'openTerminal':
				ompwebGgRespond({ command: 'openTerminal', error: 'Opening a terminal is not available from the ompweb Git graph. Use the workspace terminal.' });
				break;
			case 'openExtensionSettings':
			case 'viewScm':
			case 'rescanForRepos':
			case 'createArchive':
			case 'createPullRequest':
			case 'startCodeReview':
			case 'endCodeReview':
				ompwebGgRespond({ command: message.command, error: 'This Git Graph action is not available in ompweb' });
				break;
			default:
				ompwebGgForwardToApi(message);
		}
	}
}

const OMPWEB_GG_API = new OmpwebGgVsCodeApi();

function acquireVsCodeApi(): {
	getState: () => WebViewState | null,
	postMessage: (message: GG.RequestMessage) => void,
	setState: (state: WebViewState) => void
} {
	return OMPWEB_GG_API;
}

ompwebGgPostToParent({ type: 'ompweb-gg-ready' });
