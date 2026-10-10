/* Git Graph webview bundle - built from vendor/vscode-git-graph regenerate with
   node scripts/build-git-graph.mjs */
"use strict";
(function (document, window) {
/* ==== ompweb-bridge.js ==== */
function ompwebGgPostToParent(msg) {
    if (window.parent !== window) {
        window.parent.postMessage(msg, window.location.origin);
    }
}
function ompwebGgRespond(msg) {
    window.postMessage(msg, window.location.origin);
}
function ompwebGgCopyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(null), () => done(ompwebGgCopyTextFallback(text)));
    }
    else {
        done(ompwebGgCopyTextFallback(text));
    }
}
function ompwebGgCopyTextFallback(text) {
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
    }
    catch (e) {
        return 'Unable to copy to clipboard';
    }
}
function ompwebGgJoinRepoPath(repo, filePath) {
    if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
        return filePath;
    }
    return repo.replace(/[\\/]+$/, '') + '/' + filePath;
}
function ompwebGgAwaitResult(resultCommand, onResult) {
    const timer = setTimeout(() => {
        window.removeEventListener('message', listener);
        onResult(false);
    }, 4000);
    const listener = (event) => {
        if (event.origin !== window.location.origin)
            return;
        const data = event.data;
        if (data !== null && typeof data === 'object' && data.type === resultCommand) {
            clearTimeout(timer);
            window.removeEventListener('message', listener);
            onResult(data.ok === true);
        }
    };
    window.addEventListener('message', listener);
}
function ompwebGgForwardToApi(msg) {
    const body = 'repo' in msg && typeof msg.repo === 'string' && msg.repo !== '' ? msg : Object.assign(Object.assign({}, msg), { repo: ompwebGgBoot.repo });
    fetch(ompwebGgBoot.apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then((response) => {
        return response.json().then((json) => ompwebGgRespond(typeof json === 'object' && json !== null ? json : { command: msg.command, error: 'Invalid response from the ompweb server' }), () => ompwebGgRespond({ command: msg.command, error: 'Invalid response from the ompweb server' }));
    }, () => ompwebGgRespond({ command: msg.command, error: 'Unable to reach the ompweb server' }));
}
function ompwebGgApplyTheme(msg) {
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
        }
        else {
            root.removeAttribute('data-omp-dark');
        }
    }
}
window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin)
        return;
    const data = event.data;
    if (data !== null && typeof data === 'object' && data.type === 'ompweb-gg-theme') {
        ompwebGgApplyTheme(data);
    }
});
const OMPWEB_GG_STATE_KEY = 'omp-web:git-graph:viewstate';
class OmpwebGgVsCodeApi {
    constructor() {
        this.state = null;
        this.saveTimer = null;
    }
    getState() {
        if (this.state === null) {
            try {
                const raw = localStorage.getItem(OMPWEB_GG_STATE_KEY);
                if (raw !== null) {
                    this.state = JSON.parse(raw);
                }
            }
            catch (e) {
                this.state = null;
            }
        }
        return this.state;
    }
    setState(state) {
        this.state = state;
        if (this.saveTimer !== null)
            return;
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            try {
                localStorage.setItem(OMPWEB_GG_STATE_KEY, JSON.stringify(this.state));
            }
            catch (e) {
            }
        }, 300);
    }
    postMessage(message) {
        switch (message.command) {
            case 'setGlobalViewState':
            case 'setWorkspaceViewState':
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
function acquireVsCodeApi() {
    return OMPWEB_GG_API;
}
ompwebGgPostToParent({ type: 'ompweb-gg-ready' });

/* ==== utils.js ==== */
const VSCODE_API = acquireVsCodeApi();
const SVG_ICONS = {
    alert: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8.893 1.5c-.183-.31-.52-.5-.887-.5s-.703.19-.886.5L.138 13.499a.98.98 0 0 0 0 1.001c.193.31.53.501.886.501h13.964c.367 0 .704-.19.877-.5a1.03 1.03 0 0 0 .01-1.002L8.893 1.5zm.133 11.497H6.987v-2.003h2.039v2.003zm0-3.004H6.987V5.987h2.039v4.006z"/></svg>',
    branch: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="16" viewBox="0 0 10 16"><path fill-rule="evenodd" d="M10 5c0-1.11-.89-2-2-2a1.993 1.993 0 0 0-1 3.72v.3c-.02.52-.23.98-.63 1.38-.4.4-.86.61-1.38.63-.83.02-1.48.16-2 .45V4.72a1.993 1.993 0 0 0-1-3.72C.88 1 0 1.89 0 3a2 2 0 0 0 1 1.72v6.56c-.59.35-1 .99-1 1.72 0 1.11.89 2 2 2 1.11 0 2-.89 2-2 0-.53-.2-1-.53-1.36.09-.06.48-.41.59-.47.25-.11.56-.17.94-.17 1.05-.05 1.95-.45 2.75-1.25S8.95 7.77 9 6.73h-.02C9.59 6.37 10 5.73 10 5zM2 1.8c.66 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2C1.35 4.2.8 3.65.8 3c0-.65.55-1.2 1.2-1.2zm0 12.41c-.66 0-1.2-.55-1.2-1.2 0-.65.55-1.2 1.2-1.2.65 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2zm6-8c-.66 0-1.2-.55-1.2-1.2 0-.65.55-1.2 1.2-1.2.65 0 1.2.55 1.2 1.2 0 .65-.55 1.2-1.2 1.2z"/></svg>',
    check: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="16" viewBox="0 0 12 16"><path fill-rule="evenodd" d="M12 5l-8 8-4-4 1.5-1.5L4 10l6.5-6.5L12 5z"></path></svg>',
    commit: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16"><path fill-rule="evenodd" d="M10.86 7c-.45-1.72-2-3-3.86-3-1.86 0-3.41 1.28-3.86 3H0v2h3.14c.45 1.72 2 3 3.86 3 1.86 0 3.41-1.28 3.86-3H14V7h-3.14zM7 10.2c-1.22 0-2.2-.98-2.2-2.2 0-1.22.98-2.2 2.2-2.2 1.22 0 2.2.98 2.2 2.2 0 1.22-.98 2.2-2.2 2.2z"/></svg>',
    copy: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16"><path fill-rule="evenodd" d="M2 13h4v1H2v-1zm5-6H2v1h5V7zm2 3V8l-3 3 3 3v-2h5v-2H9zM4.5 9H2v1h2.5V9zM2 12h2.5v-1H2v1zm9 1h1v2c-.02.28-.11.52-.3.7-.19.18-.42.28-.7.3H1c-.55 0-1-.45-1-1V4c0-.55.45-1 1-1h3c0-1.11.89-2 2-2 1.11 0 2 .89 2 2h3c.55 0 1 .45 1 1v5h-1V6H1v9h10v-2zM2 5h8c0-.55-.45-1-1-1H8c-.55 0-1-.45-1-1s-.45-1-1-1-1 .45-1 1-.45 1-1 1H3c-.55 0-1 .45-1 1z"/></svg>',
    current: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16">  <path d="M 8.5793251,3.9709273 C 5.7393555,3.9722573 3.3857785,6.1732278 3.1943505,9.0067388 H 4.7680416 C 4.9548119,7.0413876 6.6051194,5.5401404 8.5793251,5.5397007 10.693557,5.5401531 12.407367,7.2539644 12.407817,9.3681961 12.408725,11.483388 10.694517,13.198699 8.5793251,13.199151 6.603404,13.198471 4.9524361,11.694493 4.7680416,9.727194 H 3.1943505 c 0.188959,2.835453 2.5432332,5.039225 5.3849746,5.04073 2.9812129,-0.0014 5.3972349,-2.418515 5.3972659,-5.3997279 -0.0014,-2.980253 -2.417013,-5.3958792 -5.3972659,-5.3972688 z m 0,3.1375466 c -0.8665744,3.13e-5 -1.655905,0.5013756 -2.0285866,1.2884596 0.4371757,0.1661687 0.9045642,0.3506253 1.2589529,0.4991552 0.3227657,0.135276 0.9442147,0.3573058 0.9442147,0.4745662 0,0.1172591 -0.621449,0.3368301 -0.9442147,0.4721071 -0.3543887,0.14853 -0.8217772,0.332987 -1.2589529,0.499155 0.3726816,0.787084 1.1620121,1.288429 2.0285866,1.28846 1.2398219,-0.0012 2.2444269,-1.012386 2.2449659,-2.2597221 8.1e-4,-1.2482965 -1.0041896,-2.2610032 -2.2449659,-2.262181 z M 5.579476,8.4313581 c -0.052649,0.00816 -0.07526,0.1152306 0,0.159828 L 6.4769718,9.1223068 H 2.3625859 L 1.8806431,8.3507087 H 0.01849445 l 0.752421,1.0199462 -0.752421,1.0199461 H 1.8806431 L 2.3650449,9.6165442 H 2.6825055 6.4794307 L 5.579476,10.150124 c -0.07526,0.0446 -0.052649,0.15167 0,0.159828 0.2360449,0.03657 1.406845,-0.369239 2.0900586,-0.614723 0.2586305,-0.092928 0.7573385,-0.244023 0.7573385,-0.3245741 0,-0.080552 -0.498708,-0.2316459 -0.7573385,-0.3245738 C 6.986321,8.8005973 5.815521,8.3947939 5.579476,8.4313581 Z" /></svg>',
    download: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -0.5 16 16.5"><path fill-rule="evenodd" d="M9 12h2l-3 3-3-3h2V7h2v5zm3-8c0-.44-.91-3-4.5-3C5.08 1 3 2.92 3 5 1.02 5 0 6.52 0 8c0 1.53 1 3 3 3h3V9.7H3C1.38 9.7 1.3 8.28 1.3 8c0-.17.05-1.7 1.7-1.7h1.3V5c0-1.39 1.56-2.7 3.2-2.7 2.55 0 3.13 1.55 3.2 1.8v1.2H12c.81 0 2.7.22 2.7 2.2 0 2.09-2.25 2.2-2.7 2.2h-2V11h2c2.08 0 4-1.16 4-3.5C16 5.06 14.08 4 12 4z"/></svg>',
    eyeOpen: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8.06 2C3 2 0 8 0 8s3 6 8.06 6C13 14 16 8 16 8s-3-6-7.94-6zM8 12c-2.2 0-4-1.78-4-4 0-2.2 1.8-4 4-4 2.22 0 4 1.8 4 4 0 2.22-1.78 4-4 4zm2-4c0 1.11-.89 2-2 2-1.11 0-2-.89-2-2 0-1.11.89-2 2-2 1.11 0 2 .89 2 2z"/></svg>',
    eyeClosed: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 -1 16 16"><path fill-rule="evenodd" d="M14.822.854a.5.5 0 1 0-.707-.708l-2.11 2.11C10.89 1.483 9.565.926 8.06.926c-5.06 0-8.06 6-8.06 6s1.162 2.323 3.258 4.078l-2.064 2.065a.5.5 0 1 0 .707.707L14.822.854zM4.86 9.403L6.292 7.97A1.999 1.999 0 0 1 6 6.925c0-1.11.89-2 2-2 .384 0 .741.106 1.045.292l1.433-1.433A3.98 3.98 0 0 0 8 2.925c-2.2 0-4 1.8-4 4 0 .938.321 1.798.859 2.478zm7.005-3.514l1.993-1.992A14.873 14.873 0 0 1 16 6.925s-3 6-7.94 6a6.609 6.609 0 0 1-2.661-.57l1.565-1.566c.33.089.678.136 1.036.136 2.22 0 4-1.78 4-4 0-.358-.047-.705-.136-1.036zM9.338 8.415l.152-.151a1.996 1.996 0 0 1-.152.151z"/></svg>',
    gear: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="-1 -1 18 18"><path fill-rule="evenodd" d="M14 8.77v-1.6l-1.94-.64-.45-1.09.88-1.84-1.13-1.13-1.81.91-1.09-.45-.69-1.92h-1.6l-.63 1.94-1.11.45-1.84-.88-1.13 1.13.91 1.81-.45 1.09L0 7.23v1.59l1.94.64.45 1.09-.88 1.84 1.13 1.13 1.81-.91 1.09.45.69 1.92h1.59l.63-1.94 1.11-.45 1.84.88 1.13-1.13-.92-1.81.47-1.09L14 8.75v.02zM7 11c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/></svg>',
    info: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16"><path fill-rule="evenodd" d="M6.3 5.69a.942.942 0 0 1-.28-.7c0-.28.09-.52.28-.7.19-.18.42-.28.7-.28.28 0 .52.09.7.28.18.19.28.42.28.7 0 .28-.09.52-.28.7a1 1 0 0 1-.7.3c-.28 0-.52-.11-.7-.3zM8 7.99c-.02-.25-.11-.48-.31-.69-.2-.19-.42-.3-.69-.31H6c-.27.02-.48.13-.69.31-.2.2-.3.44-.31.69h1v3c.02.27.11.5.31.69.2.2.42.31.69.31h1c.27 0 .48-.11.69-.31.2-.19.3-.42.31-.69H8V7.98v.01zM7 2.3c-3.14 0-5.7 2.54-5.7 5.68 0 3.14 2.56 5.7 5.7 5.7s5.7-2.55 5.7-5.7c0-3.15-2.56-5.69-5.7-5.69v.01zM7 .98c3.86 0 7 3.14 7 7s-3.14 7-7 7-7-3.12-7-7 3.14-7 7-7z"/></svg>',
    openFile: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="16" viewBox="0 0 12 16"><path fill-rule="evenodd" d="M8.5 1H1c-.55 0-1 .45-1 1v12c0 .55.45 1 1 1h10c.55 0 1-.45 1-1V4.5L8.5 1zM11 14H1V2h7l3 3v9zM6 4.5l4 3-4 3v-2c-.98-.02-1.84.22-2.55.7-.71.48-1.19 1.25-1.45 2.3.02-1.64.39-2.88 1.13-3.73.73-.84 1.69-1.27 2.88-1.27v-2H6z"/></svg>',
    package: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M1 4.27v7.47c0 .45.3.84.75.97l6.5 1.73c.16.05.34.05.5 0l6.5-1.73c.45-.13.75-.52.75-.97V4.27c0-.45-.3-.84-.75-.97l-6.5-1.74a1.4 1.4 0 0 0-.5 0L1.75 3.3c-.45.13-.75.52-.75.97zm7 9.09l-6-1.59V5l6 1.61v6.75zM2 4l2.5-.67L11 5.06l-2.5.67L2 4zm13 7.77l-6 1.59V6.61l2-.55V8.5l2-.53V5.53L15 5v6.77zm-2-7.24L6.5 2.8l2-.53L15 4l-2 .53z"/></svg>',
    pencil: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16"><path fill-rule="evenodd" d="M0 12v3h3l8-8-3-3-8 8zm3 2H1v-2h1v1h1v1zm10.3-9.3L12 6 9 3l1.3-1.3a.996.996 0 0 1 1.41 0l1.59 1.59c.39.39.39 1.02 0 1.41z"/></svg>',
    search: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="-0.5 -2 18 18"><path fill-rule="evenodd" d="M15.7 13.3l-3.81-3.83A5.93 5.93 0 0 0 13 6c0-3.31-2.69-6-6-6S1 2.69 1 6s2.69 6 6 6c1.3 0 2.48-.41 3.47-1.11l3.83 3.81c.19.2.45.3.7.3.25 0 .52-.09.7-.3a.996.996 0 0 0 0-1.41v.01zM7 10.7c-2.59 0-4.7-2.11-4.7-4.7 0-2.59 2.11-4.7 4.7-4.7 2.59 0 4.7 2.11 4.7 4.7 0 2.59-2.11 4.7-4.7 4.7z"/></svg>',
    stash: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16"><path fill-rule="evenodd" d="M14 9l-1.13-7.14c-.08-.48-.5-.86-1-.86H2.13c-.5 0-.92.38-1 .86L0 9v5c0 .55.45 1 1 1h12c.55 0 1-.45 1-1V9zm-3.28.55l-.44.89c-.17.34-.52.56-.91.56H4.61c-.38 0-.72-.22-.89-.55l-.44-.91c-.17-.33-.52-.55-.89-.55H1l1-7h10l1 7h-1.38c-.39 0-.73.22-.91.55l.01.01z"/></svg>',
    tag: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="16" viewBox="0 0 15 16"><path fill-rule="evenodd" d="M7.73 1.73C7.26 1.26 6.62 1 5.96 1H3.5C2.13 1 1 2.13 1 3.5v2.47c0 .66.27 1.3.73 1.77l6.06 6.06c.39.39 1.02.39 1.41 0l4.59-4.59a.996.996 0 0 0 0-1.41L7.73 1.73zM2.38 7.09c-.31-.3-.47-.7-.47-1.13V3.5c0-.88.72-1.59 1.59-1.59h2.47c.42 0 .83.16 1.13.47l6.14 6.13-4.73 4.73-6.13-6.15zM3.01 3h2v2H3V3h.01z"/></svg>',
    terminal: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16"><path fill-rule="evenodd" d="M7 10h4v1H7v-1zm-3 1l3-3-3-3-.75.75L5.5 8l-2.25 2.25L4 11zm10-8v10c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V3c0-.55.45-1 1-1h12c.55 0 1 .45 1 1zm-1 0H1v10h12V3z"/></svg>',
    loading: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 12 16"><path fill-rule="evenodd" d="M10.24 7.4a4.15 4.15 0 0 1-1.2 3.6 4.346 4.346 0 0 1-5.41.54L4.8 10.4.5 9.8l.6 4.2 1.31-1.26c2.36 1.74 5.7 1.57 7.84-.54a5.876 5.876 0 0 0 1.74-4.46l-1.75-.34zM2.96 5a4.346 4.346 0 0 1 5.41-.54L7.2 5.6l4.3.6-.6-4.2-1.31 1.26c-2.36-1.74-5.7-1.57-7.85.54C.5 5.03-.06 6.65.01 8.26l1.75.35A4.17 4.17 0 0 1 2.96 5z"/></svg>',
    refresh: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M 8.244,15.672 C 11.441,15.558 14.868,13.024 14.828,8.55 14.773,6.644 13.911,4.852 12.456,3.619 l -1.648,1.198 c 1.265,0.861 2.037,2.279 2.074,3.809 0.016,2.25 -1.808,5.025 -4.707,5.077 -2.898,0.052 -4.933,-2.08 -5.047,-4.671 C 3.07,6.705 4.635,4.651 6.893,4.088 l 0.041,1.866 3.853,-3.126 -3.978,-2.772 0.032,2.077 c -3.294,0.616 -5.755,3.541 -5.667,6.982 -3.88e-4,4.233 3.873,6.670 7.07,6.557 z"/></svg>',
    openFolder: '<svg xmlns="http://www.w3.org/2000/svg" class="openFolderIcon" viewBox="0 0 30 30"><path d="M 5 4 C 3.895 4 3 4.895 3 6 L 3 9 L 3 11 L 22 11 L 27 11 L 27 8 C 27 6.895 26.105 6 25 6 L 12.199219 6 L 11.582031 4.9707031 C 11.221031 4.3687031 10.570187 4 9.8671875 4 L 5 4 z M 2.5019531 13 C 1.4929531 13 0.77040625 13.977406 1.0664062 14.941406 L 4.0351562 24.587891 C 4.2941563 25.426891 5.0692656 26 5.9472656 26 L 15 26 L 24.052734 26 C 24.930734 26 25.705844 25.426891 25.964844 24.587891 L 28.933594 14.941406 C 29.229594 13.977406 28.507047 13 27.498047 13 L 15 13 L 2.5019531 13 z"/></svg>',
    closedFolder: '<svg xmlns="http://www.w3.org/2000/svg" class="closedFolderIcon" viewBox="0 0 30 30"><path d="M 4 3 C 2.895 3 2 3.895 2 5 L 2 8 L 13 8 L 28 8 L 28 7 C 28 5.895 27.105 5 26 5 L 11.199219 5 L 10.582031 3.9707031 C 10.221031 3.3687031 9.5701875 3 8.8671875 3 L 4 3 z M 3 10 C 2.448 10 2 10.448 2 11 L 2 23 C 2 24.105 2.895 25 4 25 L 26 25 C 27.105 25 28 24.105 28 23 L 28 11 C 28 10.448 27.552 10 27 10 L 3 10 z"/></svg>',
    file: '<svg xmlns="http://www.w3.org/2000/svg" class="fileIcon" viewBox="0 0 30 30"><path d="M24.707,8.793l-6.5-6.5C18.019,2.105,17.765,2,17.5,2H7C5.895,2,5,2.895,5,4v22c0,1.105,0.895,2,2,2h16c1.105,0,2-0.895,2-2 V9.5C25,9.235,24.895,8.981,24.707,8.793z M18,10c-0.552,0-1-0.448-1-1V3.904L23.096,10H18z"/></svg>',
    arrowDown: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill-rule="evenodd" d="M6,1L6,10.1L2.7,6.8L1.3,8.2L7,13.9L12.7,8.2L11.3,6.8L8,10.1L8,1L6,1z"/></svg>',
    arrowUp: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill-rule="evenodd" d="M6,13L6,3.9L2.7,7.2L1.3,5.8L7,0.1L12.7,5.8L11.3,7.2L8,3.9L8,13L6,13z"/></svg>',
    cdv: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill-rule="evenodd" d="M0,2V3.5H2V2ZM3.5,2V3.5H14V2ZM0,5v7H14V5Zm1,1.5h5.5v4H1Zm6.5,0H13v4H7.5Z"/></svg>',
    close: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill-rule="evenodd" d="M3.8,2.4L2.4,3.8L5.7,7L2.4,10.2L3.8,11.6L7,8.3L10.2,11.6L11.6,10.2L8.3,7L11.6,3.8L10.2,2.4L7,5.7L3.8,2.4z"/></svg>',
    failed: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13"><path fill-rule="evenodd" d="M 6.5,0 A 6.5,6.5 0 0 0 0,6.5 6.5,6.5 0 0 0 6.5,13 6.5,6.5 0 0 0 13,6.5 6.5,6.5 0 0 0 6.5,0 Z M 4.1,2.54 6.5,4.95 8.9,2.54 10.46,4.1 8.05,6.5 10.46,8.9 8.9,10.46 6.5,8.05 4.1,10.46 2.54,8.9 4.95,6.5 2.54,4.1 Z"/></svg>',
    fileList: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M 2,3 V 4.5 H 4 V 3 Z M 5.5,3 V 4.5 H 18 V 3 Z M 2,7 V 8.5 H 4 V 7 Z M 5.5,7 V 8.5 H 18 V 7 Z M 2,11 v 1.5 H 4 V 11 Z m 3.5,0 v 1.5 H 18 V 11 Z M 2,15 v 1.5 H 4 V 15 Z m 3.5,0 v 1.5 H 18 V 15 Z"/></svg>',
    fileTree: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M 2,3 V 4.5 H 4 V 3 Z M 5.5,3 V 4.5 H 14 V 3 Z M 4,7 V 8.5 H 6 V 7 Z M 7.5,7 V 8.5 H 16 V 7 Z M 6,11 v 1.5 H 8 V 11 Z m 3.5,0 v 1.5 H 18 V 11 Z M 4,15 v 1.5 H 6 V 15 Z m 3.5,0 v 1.5 H 16 V 15 Z"/></svg>',
    inconclusive: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13"><path fill-rule="evenodd" d="M 6.5,0 C 2.91,0 0,2.91 0,6.5 0,10.09 2.91,13 6.5,13 10.09,13 13,10.09 13,6.5 13,2.91 10.09,0 6.5,0 Z m 0.03,2.35 v 0 c 0.47,0 0.88,0.05 1.24,0.14 0.36,0.1 0.67,0.23 0.93,0.41 0.24,0.18 0.43,0.4 0.58,0.67 0.14,0.27 0.2,0.58 0.2,0.93 0,0.23 0,0.45 -0.09,0.63 C 9.3,5.31 9.14,5.49 9.05,5.62 8.91,5.79 8.9,5.82 8.7,6.02 8.53,6.2 8.35,6.36 8.15,6.5 8.03,6.6 7.94,6.7 7.85,6.79 7.77,6.88 7.7,6.97 7.65,7.08 7.6,7.18 7.56,7.29 7.53,7.4 7.5,7.52 7.5,7.54 7.5,7.67 H 5.75 c 0,-0.23 0,-0.33 0.03,-0.51 C 5.81,6.96 5.86,6.78 5.93,6.61 5.99,6.46 6.08,6.31 6.2,6.16 6.32,6.02 6.44,5.89 6.64,5.76 6.93,5.56 7.02,5.44 7.15,5.21 7.28,4.98 7.36,4.81 7.36,4.58 7.36,4.29 7.3,4.1 7.15,3.96 7.01,3.82 6.82,3.76 6.53,3.76 6.43,3.76 6.33,3.78 6.21,3.81 6.09,3.84 6.03,3.9 5.94,3.98 5.86,4.05 5.79,4.1 5.73,4.19 5.66,4.27 5.63,4.38 5.64,4.49 H 3.52 C 3.52,4.09 3.66,3.9 3.81,3.61 3.96,3.32 4.18,3.07 4.44,2.89 4.71,2.71 5.02,2.58 5.38,2.49 5.75,2.4 6.14,2.35 6.53,2.35 Z M 6.14,8.72 H 7.2 c 0.3,0 0.53,0.24 0.53,0.53 v 1.07 0 c 0,0.3 -0.23,0.53 -0.53,0.53 H 6.14 c -0.29,0 -0.53,-0.24 -0.53,-0.53 V 9.25 c 0,-0.3 0.25,-0.53 0.53,-0.53 z"/></svg>',
    linkExternal: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3,3L3,17L17,17L17,13L15.5,13L15.5,15.5L4.5,15.5L4.5,4.5L7,4.5L7,3L3,3z M10,3L10,4.5L14.4,4.5L9.3,9.7L10.3,10.7L15.5,5.6L15.5,10L17,10L17,3L10,3z"/></svg>',
    passed: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13"><path fill-rule="evenodd" d="M 6.5,0 A 6.5,6.5 0 0 0 0,6.5 6.5,6.5 0 0 0 6.5,13 6.5,6.5 0 0 0 13,6.5 6.5,6.5 0 0 0 6.5,0 Z M 9.64,2.95 11.2,4.5 5.02,10.68 C 3.92,9.57 2.81,8.46 1.7,7.35 L 3.26,5.8 5.02,7.57 Z"/></svg>',
    plus: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill-rule="evenodd" d="M6,2V6H2v2h4v4H8V8h4V6H8V2Z"/></svg>',
    review: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill-rule="evenodd" d="m4,4.7 -4,7.3 4,7.3 2.5,0 -4,-7.3 4,-7.3zM11.5,6C9,5.5 6.6,7.1 6.1,9.6c-0.5,2.6 1.1,5 3.6,5.5 1,0.2 1.8,0.1 2.7,-0.3l2.5,3.3c0.1,0.1 0.3,0.2 0.5,0.3 0.2,0 0.4,0 0.6,-0.1 0.3,-0.2 0.4,-0.4 0.4,-0.6 0,-0.2 0,-0.4 -0.1,-0.6 0,-0.2 -2.4,-3.3 -2.4,-3.3 0.7,-0.6 1,-1.5 1.3,-2.4C15.7,8.9 14,6.5 11.5,6zm8.5,-1.3 -2.5,0 4,7.3 -4.2,7.3 2.5,0L24,12zm-8.8,3c1.6,0.3 2.6,1.8 2.3,3.4 -0.3,1.6 -1.8,2.6 -3.4,2.3C8.5,13 7.4,11.6 7.8,10 8,8.4 9.6,7.3 11.2,7.7z"/></svg>',
    collapseAll: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 9H4V10H9V9Z" fill="#C5C5C5"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3L6 2H13L14 3V10L13 11H11V13L10 14H3L2 13V6L3 5H5V3ZM6 5H10L11 6V10H13V3H6V5ZM10 6H3V13H10V6Z" fill="#C5C5C5"/></svg>',
    expandAll: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 9H4V10H9V9Z" fill="#C5C5C5"/><path d="M7 12L7 7L6 7L6 12L7 12Z" fill="#C5C5C5"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3L6 2H13L14 3V10L13 11H11V13L10 14H3L2 13V6L3 5H5V3ZM6 5H10L11 6V10H13V3H6V5ZM10 6H3V13H10V6Z" fill="#C5C5C5"/></svg>',
    collapse: '<svg style="transform: rotate(-90deg);" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd"  d="M14.207 1.707L13.5 1L7.49997 7L1.49997 1L0.792969 1.707L7.14597 8.061H7.85397L14.207 1.707ZM14.207 7.70688L13.5 6.99988L7.49997 12.9999L1.49997 6.99988L0.792969 7.70688L7.14597 14.0609H7.85397L14.207 7.70688Z"/></svg>'
};
const GIT_FILE_CHANGE_TYPES = { 'A': 'Added', 'M': 'Modified', 'D': 'Deleted', 'R': 'Renamed', 'U': 'Untracked' };
const GIT_SIGNATURE_STATUS_DESCRIPTIONS = {
    'G': 'Valid Signature',
    'U': 'Good Signature with Unknown Validity',
    'X': 'Good Signature that has Expired',
    'Y': 'Good Signature made by an Expired Key',
    'R': 'Good Signature made by a Revoked Key',
    'E': 'Signature could not be checked',
    'B': 'Bad Signature'
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REF_INVALID_REGEX = /^[-\/].*|[\\" ><~^:?*[]|\.\.|\/\/|\/\.|@{|[.\/]$|\.lock$|^@$/g;
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#x27;', '/': '&#x2F;' };
const HTML_UNESCAPES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': '\'', '&#x2F;': '/' };
const HTML_ESCAPER_REGEX = /[&<>"'\/]/g;
const HTML_UNESCAPER_REGEX = /&lt;|&gt;|&amp;|&quot;|&#x27;|&#x2F;/g;
const ELLIPSIS = '&#8230;';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const UNCOMMITTED = '*';
const SHOW_ALL_BRANCHES = '';
const PATH_FILTER_WS_ALL = '__ws_all__';
const COLUMN_HIDDEN = -100;
const COLUMN_AUTO = -101;
const COLUMN_MIN_WIDTH = 40;
const COLUMN_LEFT_RIGHT_PADDING = 24;
const CLASS_ACTIVE = 'active';
const CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH = 'branchLabelsAlignedToGraph';
const CLASS_COMMIT_DETAILS_OPEN = 'commitDetailsOpen';
const CLASS_DISABLED = 'disabled';
const CLASS_ENABLED = 'enabled';
const CLASS_FETCH_SUPPORTED = 'fetchSupported';
const CLASS_FOCUSSED = 'focussed';
const CLASS_LOADING = 'loading';
const CLASS_PENDING_REVIEW = 'pendingReview';
const CLASS_REFRESHING = 'refreshing';
const CLASS_REF_HEAD = 'head';
const CLASS_REF_REMOTE = 'remote';
const CLASS_REF_STASH = 'stash';
const CLASS_REF_TAG = 'tag';
const CLASS_SELECTED = 'selected';
const CLASS_TAG_LABELS_RIGHT_ALIGNED = 'tagLabelsRightAligned';
const CLASS_TRANSITION = 'transition';
const ID_EVENT_CAPTURE_ELEM = 'eventCaptureElem';
const CSS_PROP_FONT_FAMILY = '--vscode-font-family';
const CSS_PROP_EDITOR_FONT_FAMILY = '--vscode-editor-font-family';
const CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND = '--vscode-editor-findMatchHighlightBackground';
const CSS_PROP_SELECTION_BACKGROUND = '--vscode-selection-background';
const CSS_PROP_LIMIT_GRAPH_WIDTH = '--limitGraphWidth';
const ATTR_ERROR = 'data-error';
function arraysEqual(a, b, equalElements) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (!equalElements(a[i], b[i]))
            return false;
    }
    return true;
}
function arraysStrictlyEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
function arraysStrictlyEqualIgnoringOrder(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (b.indexOf(a[i]) === -1)
            return false;
    }
    return true;
}
function modifyColourOpacity(colour, opacity) {
    let fadedCol = 'rgba(0,0,0,0)', match;
    if ((match = colour.match(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)) !== null) {
        fadedCol = 'rgba(' + match[1] + ',' + match[2] + ',' + match[3] + ',' + (parseFloat(match[4]) * opacity).toFixed(2) + ')';
    }
    else if ((match = colour.match(/#\s*([0-9a-fA-F]+)/)) !== null) {
        let hex = match[1];
        let length = hex.length;
        if (length === 3 || length === 4 || length === 6 || length === 8) {
            let col = length < 5
                ? { r: hex[0] + hex[0], g: hex[1] + hex[1], b: hex[2] + hex[2], a: length === 4 ? hex[3] + hex[3] : 'ff' }
                : { r: hex[0] + hex[1], g: hex[2] + hex[3], b: hex[4] + hex[5], a: length === 8 ? hex[6] + hex[7] : 'ff' };
            fadedCol = 'rgba(' + parseInt(col.r, 16) + ',' + parseInt(col.g, 16) + ',' + parseInt(col.b, 16) + ',' + (parseInt(col.a, 16) * opacity / 255).toFixed(2) + ')';
        }
    }
    else if ((match = colour.match(/rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)) !== null) {
        fadedCol = 'rgba(' + match[1] + ',' + match[2] + ',' + match[3] + ',' + opacity + ')';
    }
    return fadedCol;
}
function pad2(i) {
    return i > 9 ? i : '0' + i;
}
function getRepoName(path) {
    const firstSep = path.indexOf('/');
    if (firstSep === path.length - 1 || firstSep === -1) {
        return path;
    }
    else {
        const p = path.endsWith('/') ? path.substring(0, path.length - 1) : path;
        return p.substring(p.lastIndexOf('/') + 1);
    }
}
function getSortedRepositoryPaths(repos, order) {
    const repoPaths = Object.keys(repos);
    if (order === 2) {
        return repoPaths.sort((a, b) => repos[a].workspaceFolderIndex === repos[b].workspaceFolderIndex
            ? a.localeCompare(b)
            : repos[a].workspaceFolderIndex === null
                ? 1
                : repos[b].workspaceFolderIndex === null
                    ? -1
                    : repos[a].workspaceFolderIndex - repos[b].workspaceFolderIndex);
    }
    else if (order === 0) {
        return repoPaths.sort((a, b) => a.localeCompare(b));
    }
    else {
        return repoPaths.map((path) => ({ name: repos[path].name || getRepoName(path), path: path }))
            .sort((a, b) => a.name !== b.name ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path))
            .map((x) => x.path);
    }
}
function escapeHtml(str) {
    return str.replace(HTML_ESCAPER_REGEX, (match) => HTML_ESCAPES[match]);
}
function unescapeHtml(str) {
    return str.replace(HTML_UNESCAPER_REGEX, (match) => HTML_UNESCAPES[match]);
}
function formatCommaSeparatedList(items) {
    let str = '';
    for (let i = 0; i < items.length; i++) {
        str += (i > 0 ? (i < items.length - 1 ? ', ' : ' & ') : '') + items[i];
    }
    return str;
}
function formatShortDate(unixTimestamp) {
    const date = new Date(unixTimestamp * 1000), format = initialState.config.dateFormat;
    let dateStr = format.iso
        ? date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
        : date.getDate() + ' ' + MONTHS[date.getMonth()] + ' ' + date.getFullYear();
    let hourMinsStr = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    let formatted;
    if (format.type === 0) {
        formatted = dateStr + ' ' + hourMinsStr;
    }
    else if (format.type === 1) {
        formatted = dateStr;
    }
    else {
        let diff = Math.round((new Date()).getTime() / 1000) - unixTimestamp, unit;
        if (diff < 60) {
            unit = 'second';
        }
        else if (diff < 3600) {
            unit = 'minute';
            diff /= 60;
        }
        else if (diff < 86400) {
            unit = 'hour';
            diff /= 3600;
        }
        else if (diff < 604800) {
            unit = 'day';
            diff /= 86400;
        }
        else if (diff < 2629800) {
            unit = 'week';
            diff /= 604800;
        }
        else if (diff < 31557600) {
            unit = 'month';
            diff /= 2629800;
        }
        else {
            unit = 'year';
            diff /= 31557600;
        }
        diff = Math.round(diff);
        formatted = diff + ' ' + unit + (diff !== 1 ? 's' : '') + ' ago';
    }
    return {
        title: dateStr + ' ' + hourMinsStr + ':' + pad2(date.getSeconds()),
        formatted: formatted
    };
}
function formatLongDate(unixTimestamp) {
    const date = new Date(unixTimestamp * 1000);
    if (initialState.config.dateFormat.iso) {
        let timezoneOffset = date.getTimezoneOffset();
        let absoluteTimezoneOffset = Math.abs(timezoneOffset);
        let timezone = timezoneOffset === 0 ? 'Z' : ' ' + (timezoneOffset < 0 ? '+' : '-') + pad2(Math.floor(absoluteTimezoneOffset / 60)) + pad2(absoluteTimezoneOffset % 60);
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) + timezone;
    }
    else {
        return date.toString();
    }
}
function addListenerToClass(className, event, eventListener) {
    addListenerToCollectionElems(document.getElementsByClassName(className), event, eventListener);
}
function addListenerToCollectionElems(elems, event, eventListener) {
    for (let i = 0; i < elems.length; i++) {
        elems[i].addEventListener(event, eventListener);
    }
}
function insertAfter(newNode, referenceNode) {
    referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
}
function insertBeforeFirstChildWithClass(newChild, parent, className) {
    let referenceNode = null;
    for (let i = 0; i < parent.children.length; i++) {
        if (parent.children[i].classList.contains(className)) {
            referenceNode = parent.children[i];
            break;
        }
    }
    parent.insertBefore(newChild, referenceNode);
}
function alterClass(elem, className, state) {
    if (elem.classList.contains(className) !== state) {
        if (state) {
            elem.classList.add(className);
        }
        else {
            elem.classList.remove(className);
        }
        return true;
    }
    return false;
}
function alterClassOfCollection(elems, className, state) {
    const lockedElems = [];
    for (let i = 0; i < elems.length; i++) {
        lockedElems.push(elems[i]);
    }
    for (let i = 0; i < lockedElems.length; i++) {
        alterClass(lockedElems[i], className, state);
    }
}
function getChildNodesWithTextContent(elem) {
    let textChildren = [];
    for (let i = 0; i < elem.childNodes.length; i++) {
        if (elem.childNodes[i].childNodes.length > 0) {
            textChildren.push(...getChildNodesWithTextContent(elem.childNodes[i]));
        }
        else if (elem.childNodes[i].textContent !== null && elem.childNodes[i].textContent !== '') {
            textChildren.push(elem.childNodes[i]);
        }
    }
    return textChildren;
}
function getChildrenWithClassName(elem, className) {
    let children = [];
    for (let i = 0; i < elem.children.length; i++) {
        if (elem.children[i].children.length > 0) {
            children.push(...getChildrenWithClassName(elem.children[i], className));
        }
        else if (elem.children[i].className === className) {
            children.push(elem.children[i]);
        }
    }
    return children;
}
function getChildUl(elem) {
    for (let i = 0; i < elem.children.length; i++) {
        if (elem.children[i].tagName === 'UL') {
            return elem.children[i];
        }
    }
    return null;
}
function observeElemScroll(id, initialScrollTop, onScroll, onScrolled) {
    const elem = document.getElementById(id);
    if (elem === null)
        return;
    let timeout = null;
    elem.scroll(0, initialScrollTop);
    elem.addEventListener('scroll', () => {
        const elem = document.getElementById(id);
        if (elem === null)
            return;
        onScroll(elem.scrollTop);
        if (timeout !== null)
            clearTimeout(timeout);
        timeout = setTimeout(() => {
            onScrolled();
            timeout = null;
        }, 250);
    });
}
function getCommitElems() {
    return document.getElementsByClassName('commit');
}
function handledEvent(event) {
    event.preventDefault();
    event.stopPropagation();
}
function updateGlobalViewState(key, value) {
    globalState[key] = value;
    sendMessage({ command: 'setGlobalViewState', state: globalState });
}
function updateWorkspaceViewState(key, value) {
    workspaceState[key] = value;
    sendMessage({ command: 'setWorkspaceViewState', state: workspaceState });
}
function sendMessage(msg) {
    VSCODE_API.postMessage(msg);
}
function showErrorMessage(message) {
    sendMessage({ command: 'showErrorMessage', message: message });
}
function getVSCodeStyle(name) {
    return document.documentElement.style.getPropertyValue(name);
}
class ImageResizer {
    constructor() {
        this.canvas = null;
        this.context = null;
    }
    resize(dataUri, callback) {
        if (this.canvas === null)
            this.canvas = document.createElement('canvas');
        if (this.context === null)
            this.context = this.canvas.getContext('2d');
        if (this.context === null) {
            callback(dataUri);
            return;
        }
        let image = new Image();
        image.onload = () => {
            let outputDataUri = '';
            if (this.canvas === null || this.context === null) {
                outputDataUri = dataUri;
            }
            else {
                let size = Math.ceil(18 * window.devicePixelRatio);
                if (this.canvas.width !== size)
                    this.canvas.width = size;
                if (this.canvas.height !== size)
                    this.canvas.height = size;
                this.context.clearRect(0, 0, size, size);
                this.context.drawImage(image, 0, 0, size, size);
                outputDataUri = this.canvas.toDataURL();
            }
            callback(outputDataUri);
        };
        image.src = dataUri;
    }
}
class EventOverlay {
    constructor() {
        this.move = null;
        this.stop = null;
    }
    create(className, move, stop) {
        if (document.getElementById(ID_EVENT_CAPTURE_ELEM) !== null)
            this.remove();
        const eventOverlayElem = document.createElement('div');
        eventOverlayElem.id = ID_EVENT_CAPTURE_ELEM;
        eventOverlayElem.className = className;
        this.move = move;
        this.stop = stop;
        if (this.move !== null) {
            eventOverlayElem.addEventListener('mousemove', this.move);
        }
        if (this.stop !== null) {
            eventOverlayElem.addEventListener('mouseup', this.stop);
            eventOverlayElem.addEventListener('mouseleave', this.stop);
        }
        if (contextMenu.isOpen()) {
            contextMenu.close();
        }
        document.body.appendChild(eventOverlayElem);
    }
    remove() {
        let eventOverlayElem = document.getElementById(ID_EVENT_CAPTURE_ELEM);
        if (eventOverlayElem === null)
            return;
        if (this.move !== null) {
            eventOverlayElem.removeEventListener('mousemove', this.move);
            this.move = null;
        }
        if (this.stop !== null) {
            eventOverlayElem.removeEventListener('mouseup', this.stop);
            eventOverlayElem.removeEventListener('mouseleave', this.stop);
            this.stop = null;
        }
        document.body.removeChild(eventOverlayElem);
    }
}

/* ==== contextMenu.js ==== */
const CLASS_CONTEXT_MENU_ACTIVE = 'contextMenuActive';
class ContextMenu {
    constructor() {
        this.elem = null;
        this.onClose = null;
        this.target = null;
        const listener = () => this.close();
        document.addEventListener('click', listener);
        document.addEventListener('contextmenu', listener);
    }
    show(actions, checked, target, event, frameElem, onClose = null, className = null) {
        let html = '', handlers = [], handlerId = 0;
        this.close();
        for (let i = 0; i < actions.length; i++) {
            let groupHtml = '';
            for (let j = 0; j < actions[i].length; j++) {
                if (actions[i][j].visible) {
                    groupHtml += '<li class="contextMenuItem" data-index="' + handlerId++ + '">' + (checked ? '<span class="contextMenuItemCheck">' + (actions[i][j].checked ? SVG_ICONS.check : '') + '</span>' : '') + actions[i][j].title + '</li>';
                    handlers.push((e) => actions[i][j].onClick(e));
                }
            }
            if (groupHtml !== '') {
                if (html !== '')
                    html += '<li class="contextMenuDivider"></li>';
                html += groupHtml;
            }
        }
        if (handlers.length === 0)
            return;
        const menu = document.createElement('ul');
        menu.className = 'contextMenu' + (checked ? ' checked' : '') + (className !== null ? ' ' + className : '');
        menu.style.opacity = '0';
        menu.innerHTML = html;
        frameElem.appendChild(menu);
        const menuBounds = menu.getBoundingClientRect(), frameBounds = frameElem.getBoundingClientRect();
        const relativeX = event.pageX + menuBounds.width < frameBounds.right
            ? -2
            : event.pageX - menuBounds.width > frameBounds.left
                ? 2 - menuBounds.width
                : -2 - (menuBounds.width - (frameBounds.width - (event.pageX - frameBounds.left)));
        const relativeY = event.pageY + menuBounds.height < frameBounds.bottom
            ? -2
            : event.pageY - menuBounds.height > frameBounds.top
                ? 2 - menuBounds.height
                : -2 - (menuBounds.height - (frameBounds.height - (event.pageY - frameBounds.top)));
        menu.style.left = (frameElem.scrollLeft + Math.max(event.pageX - frameBounds.left + relativeX, 2)) + 'px';
        menu.style.top = Math.max(event.clientY - frameBounds.top + relativeY, 2) + 'px';
        menu.style.opacity = '1';
        this.elem = menu;
        this.onClose = onClose;
        addListenerToClass('contextMenuItem', 'click', (e) => {
            e.stopPropagation();
            this.close();
            const handlerIndex = parseInt(e.target.closest('.contextMenuItem').dataset.index);
            const handler = handlers[handlerIndex];
            handler === null || handler === void 0 ? void 0 : handler(e instanceof MouseEvent ? e : undefined);
        });
        menu.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        menu.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
        });
        this.target = target;
        if (this.target !== null && this.target.type !== "repo") {
            alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
        }
    }
    close() {
        if (this.elem !== null) {
            this.elem.remove();
            this.elem = null;
        }
        alterClassOfCollection(document.getElementsByClassName(CLASS_CONTEXT_MENU_ACTIVE), CLASS_CONTEXT_MENU_ACTIVE, false);
        if (this.onClose !== null) {
            this.onClose();
            this.onClose = null;
        }
        this.target = null;
    }
    refresh(commits) {
        if (!this.isOpen() || this.target === null || this.target.type === "repo") {
            return;
        }
        if (this.target.index < commits.length && commits[this.target.index].hash === this.target.hash) {
            const commitElem = findCommitElemWithId(getCommitElems(), this.target.index);
            if (commitElem !== null) {
                if (typeof this.target.ref === 'undefined') {
                    if (this.target.type !== "cdv") {
                        this.target.elem = commitElem;
                        alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
                    }
                    return;
                }
                else {
                    const elems = commitElem.querySelectorAll('[data-fullref]');
                    for (let i = 0; i < elems.length; i++) {
                        if (elems[i].dataset.fullref === this.target.ref) {
                            this.target.elem = this.target.type === "ref" ? elems[i] : commitElem;
                            alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
                            return;
                        }
                    }
                }
            }
        }
        this.close();
    }
    isOpen() {
        return this.elem !== null;
    }
    isTargetDynamicSource() {
        return this.isOpen() && this.target !== null;
    }
}

/* ==== dialog.js ==== */
const CLASS_DIALOG_ACTIVE = 'dialogActive';
const CLASS_DIALOG_INPUT_INVALID = 'inputInvalid';
const CLASS_DIALOG_NO_INPUT = 'noInput';
class Dialog {
    constructor() {
        this.elem = null;
        this.target = null;
        this.actioned = null;
        this.type = null;
        this.customSelects = {};
        this.onCloseCallback = null;
    }
    showConfirmation(message, actionName, actioned, target) {
        this.show(0, message, actionName, 'Cancel', () => {
            this.close();
            actioned();
        }, null, target);
    }
    showTwoButtons(message, buttonLabel1, buttonAction1, buttonLabel2, buttonAction2, target) {
        this.show(0, message, buttonLabel1, buttonLabel2, () => {
            this.close();
            buttonAction1();
        }, () => {
            this.close();
            buttonAction2();
        }, target);
    }
    showRefInput(message, defaultValue, actionName, actioned, target) {
        this.showForm(message, [
            { type: 1, name: '', default: defaultValue }
        ], actionName, (values) => actioned(values[0]), target);
    }
    showCheckbox(message, checkboxLabel, checkboxValue, actionName, actioned, target) {
        this.showForm(message, [
            { type: 4, name: checkboxLabel, value: checkboxValue }
        ], actionName, (values) => actioned(values[0]), target);
    }
    showSelect(message, defaultValue, options, actionName, actioned, target) {
        this.showForm(message, [
            { type: 2, name: '', options: options, default: defaultValue }
        ], actionName, (values) => actioned(values[0]), target);
    }
    showMultiSelect(message, defaultValues, options, actionName, actioned, target) {
        this.showForm(message, [
            { type: 2, name: '', options: options, defaults: defaultValues, multiple: true }
        ], actionName, (values) => actioned(values[0]), target);
    }
    showForm(message, inputs, actionName, actioned, target, secondaryActionName = 'Cancel', secondaryActioned = null, includeLineBreak = true) {
        const multiElement = inputs.length > 1;
        const multiCheckbox = multiElement && inputs.every((input) => input.type === 4);
        const infoColRequired = inputs.some((input) => input.type !== 4 && input.type !== 3 && input.info);
        const inputRowsHtml = inputs.map((input, id) => {
            let inputHtml;
            if (input.type === 3) {
                inputHtml = '<td class="inputCol"' + (infoColRequired ? ' colspan="2"' : '') + '><span class="dialogFormRadio">' +
                    input.options.map((option, optionId) => '<label><input type="radio" name="dialogInput' + id + '" value="' + optionId + '"' + (option.value === input.default ? ' checked' : '') + ' tabindex="' + (id + 1) + '"/><span class="customRadio"></span>' + escapeHtml(option.name) + '</label>').join('<br>') +
                    '</span></td>';
            }
            else {
                const infoHtml = input.info ? '<span class="dialogInfo" title="' + escapeHtml(input.info) + '">' + SVG_ICONS.info + '</span>' : '';
                if (input.type === 2) {
                    inputHtml = '<td class="inputCol"><div id="dialogFormSelect' + id + '"></div></td>' + (infoColRequired ? '<td>' + infoHtml + '</td>' : '');
                }
                else if (input.type === 4) {
                    inputHtml = '<td class="inputCol"' + (infoColRequired ? ' colspan="2"' : '') + '><span class="dialogFormCheckbox"><label><input id="dialogInput' + id + '" type="checkbox"' + (input.value ? ' checked' : '') + ' tabindex="' + (id + 1) + '"/><span class="customCheckbox"></span>' + (multiElement && !multiCheckbox ? '' : input.name) + infoHtml + '</label></span></td>';
                }
                else {
                    inputHtml = '<td class="inputCol"><input id="dialogInput' + id + '" type="text" value="' + escapeHtml(input.default) + '"' + (input.type === 0 && input.placeholder !== null ? ' placeholder="' + escapeHtml(input.placeholder) + '"' : '') + ' tabindex="' + (id + 1) + '"/></td>' + (infoColRequired ? '<td>' + infoHtml + '</td>' : '');
                }
            }
            return '<tr' + (input.type === 3 ? ' class="mediumField"' : input.type !== 4 ? ' class="largeField"' : '') + '>' + (multiElement && !multiCheckbox ? '<td>' + input.name + ': </td>' : '') + inputHtml + '</tr>';
        });
        const html = message + (includeLineBreak ? '<br>' : '') +
            '<table class="dialogForm ' + (multiElement ? multiCheckbox ? 'multiCheckbox' : 'multi' : 'single') + '">' +
            inputRowsHtml.join('') +
            '</table>';
        const areFormValuesInvalid = () => this.elem === null || this.elem.classList.contains(CLASS_DIALOG_NO_INPUT) || this.elem.classList.contains(CLASS_DIALOG_INPUT_INVALID);
        const getFormValues = () => inputs.map((input, index) => {
            if (input.type === 3) {
                const elems = document.getElementsByName('dialogInput' + index);
                for (let i = 0; i < elems.length; i++) {
                    if (elems[i].checked) {
                        return input.options[parseInt(elems[i].value)].value;
                    }
                }
                return input.default;
            }
            else if (input.type === 2) {
                return this.customSelects[index.toString()].getValue();
            }
            else {
                const elem = document.getElementById('dialogInput' + index);
                return input.type === 4
                    ? elem.checked
                    : elem.value;
            }
        });
        this.show(0, html, actionName, secondaryActionName, () => {
            if (areFormValuesInvalid())
                return;
            const values = getFormValues();
            this.close();
            actioned(values);
        }, secondaryActioned !== null ? () => {
            if (areFormValuesInvalid())
                return;
            const values = getFormValues();
            this.close();
            secondaryActioned(values);
        } : null, target);
        inputs.forEach((input, index) => {
            if (input.type === 2) {
                this.customSelects[index.toString()] = new CustomSelect(input, 'dialogFormSelect' + index, index + 1, this.elem);
            }
        });
        const textRefInput = inputs.findIndex((input) => input.type === 1);
        if (textRefInput > -1) {
            let dialogInput = document.getElementById('dialogInput' + textRefInput), dialogAction = document.getElementById('dialogAction');
            if (dialogInput.value === '')
                this.elem.classList.add(CLASS_DIALOG_NO_INPUT);
            dialogInput.addEventListener('keyup', () => {
                if (this.elem === null)
                    return;
                if (initialState.config.dialogDefaults.general.referenceInputSpaceSubstitution !== null) {
                    const selectionStart = dialogInput.selectionStart, selectionEnd = dialogInput.selectionEnd;
                    dialogInput.value = dialogInput.value.replace(Dialog.WHITESPACE_REGEXP, initialState.config.dialogDefaults.general.referenceInputSpaceSubstitution);
                    dialogInput.selectionStart = selectionStart;
                    dialogInput.selectionEnd = selectionEnd;
                }
                const noInput = dialogInput.value === '', invalidInput = dialogInput.value.match(REF_INVALID_REGEX) !== null;
                alterClass(this.elem, CLASS_DIALOG_NO_INPUT, noInput);
                if (alterClass(this.elem, CLASS_DIALOG_INPUT_INVALID, !noInput && invalidInput)) {
                    dialogAction.title = invalidInput ? 'Unable to ' + actionName + ', one or more invalid characters entered.' : '';
                }
            });
        }
        if (inputs.length > 0 && (inputs[0].type === 0 || inputs[0].type === 1)) {
            document.getElementById('dialogInput0').focus();
        }
    }
    showMessage(html) {
        this.show(2, html, null, 'Close', null, null, null);
    }
    showError(message, reason, actionName, actioned) {
        this.show(2, '<span class="dialogAlert">' + SVG_ICONS.alert + 'Error: ' + message + '</span>' + (reason !== null ? '<br><span class="messageContent errorContent">' + escapeHtml(reason).split('\n').join('<br>') + '</span>' : ''), actionName, 'Dismiss', () => {
            this.close();
            if (actioned !== null)
                actioned();
        }, null, null);
    }
    showActionRunning(action) {
        this.show(1, '<span class="actionRunning">' + SVG_ICONS.loading + action + ' ...</span>', null, 'Dismiss', null, null, null);
    }
    showCustom(html, actionName, actioned, secondaryActionName, secondaryActioned, onClose) {
        this.show(0, html, actionName, secondaryActionName, actioned, secondaryActioned, null);
        this.onCloseCallback = onClose;
    }
    show(type, html, actionName, secondaryActionName, actioned, secondaryActioned, target) {
        closeDialogAndContextMenu();
        this.type = type;
        this.target = target;
        eventOverlay.create('dialogBacking', null, null);
        const dialog = document.createElement('div'), dialogContent = document.createElement('div');
        dialog.className = 'dialog';
        dialogContent.className = 'dialogContent';
        dialogContent.innerHTML = html + '<br>' + (actionName !== null ? '<div id="dialogAction" class="roundedBtn">' + actionName + '</div>' : '') + '<div id="dialogSecondaryAction" class="roundedBtn">' + secondaryActionName + '</div>';
        dialog.appendChild(dialogContent);
        this.elem = dialog;
        document.body.appendChild(dialog);
        let docHeight = document.body.clientHeight, dialogHeight = dialog.clientHeight + 2;
        if (type !== 0 && dialogHeight > 0.8 * docHeight) {
            dialogContent.style.height = Math.round(0.8 * docHeight - 22) + 'px';
            dialogHeight = Math.round(0.8 * docHeight);
        }
        dialog.style.top = Math.max(Math.round((docHeight - dialogHeight) / 2), 10) + 'px';
        if (actionName !== null && actioned !== null) {
            document.getElementById('dialogAction').addEventListener('click', actioned);
            this.actioned = actioned;
        }
        document.getElementById('dialogSecondaryAction').addEventListener('click', secondaryActioned !== null ? secondaryActioned : () => this.close());
        if (this.target !== null && this.target.type !== "repo") {
            alterClass(this.target.elem, CLASS_DIALOG_ACTIVE, true);
        }
    }
    close() {
        eventOverlay.remove();
        if (this.elem !== null) {
            this.elem.remove();
            this.elem = null;
        }
        alterClassOfCollection(document.getElementsByClassName(CLASS_DIALOG_ACTIVE), CLASS_DIALOG_ACTIVE, false);
        this.target = null;
        Object.keys(this.customSelects).forEach((index) => this.customSelects[index].remove());
        this.customSelects = {};
        this.actioned = null;
        this.type = null;
        if (this.onCloseCallback !== null) {
            this.onCloseCallback();
            this.onCloseCallback = null;
        }
    }
    closeActionRunning() {
        if (this.type === 1)
            this.close();
    }
    submit() {
        if (this.actioned !== null)
            this.actioned();
    }
    refresh(commits) {
        if (!this.isOpen() || this.target === null || this.target.type === "repo") {
            return;
        }
        const commitIndex = commits.findIndex((commit) => commit.hash === this.target.hash);
        if (commitIndex > -1) {
            const commitElem = findCommitElemWithId(getCommitElems(), commitIndex);
            if (commitElem !== null) {
                if (typeof this.target.ref === 'undefined') {
                    if (this.target.type !== "cdv") {
                        this.target.elem = commitElem;
                        alterClass(this.target.elem, CLASS_DIALOG_ACTIVE, true);
                    }
                    return;
                }
                else {
                    const elems = commitElem.querySelectorAll('[data-fullref]');
                    for (let i = 0; i < elems.length; i++) {
                        if (elems[i].dataset.fullref === this.target.ref) {
                            this.target.elem = this.target.type === "ref" ? elems[i] : commitElem;
                            alterClass(this.target.elem, CLASS_DIALOG_ACTIVE, true);
                            return;
                        }
                    }
                }
            }
        }
        this.close();
    }
    isOpen() {
        return this.elem !== null;
    }
    isTargetDynamicSource() {
        return this.isOpen() && this.target !== null;
    }
    getType() {
        return this.type;
    }
}
Dialog.WHITESPACE_REGEXP = /\s/gu;
class CustomSelect {
    constructor(data, containerId, tabIndex, dialogElem) {
        this.lastSelected = -1;
        this.focussed = -1;
        this.optionsElem = null;
        this.data = data;
        this.selected = data.options.map(() => false);
        this.open = false;
        this.dialogElem = dialogElem;
        const container = document.getElementById(containerId);
        container.className = 'customSelectContainer';
        this.elem = container;
        const currentElem = document.createElement('div');
        currentElem.className = 'customSelectCurrent';
        currentElem.tabIndex = tabIndex;
        this.currentElem = currentElem;
        container.appendChild(currentElem);
        this.clickHandler = (e) => {
            if (!e.target)
                return;
            const targetElem = e.target;
            if (targetElem.closest('.customSelectContainer') !== this.elem && (this.optionsElem === null || targetElem.closest('.customSelectOptions') !== this.optionsElem)) {
                this.render(false);
                return;
            }
            if (targetElem.className === 'customSelectCurrent') {
                this.render(!this.open);
            }
            else if (this.open) {
                const optionElem = targetElem.closest('.customSelectOption');
                if (optionElem !== null) {
                    const selectedOptionIndex = parseInt(optionElem.dataset.index);
                    this.setItemSelectedState(selectedOptionIndex, data.multiple ? !this.selected[selectedOptionIndex] : true);
                    if (!this.data.multiple) {
                        this.render(false);
                    }
                    if (this.currentElem !== null) {
                        this.currentElem.focus();
                    }
                }
            }
        };
        document.addEventListener('click', this.clickHandler, true);
        currentElem.addEventListener('keydown', (e) => {
            if (this.open && e.key === 'Tab') {
                this.render(false);
            }
            else if (this.open && (e.key === 'Enter' || e.key === 'Escape')) {
                this.render(false);
                handledEvent(e);
            }
            else if (this.data.multiple) {
                if (e.key === ' ' && this.focussed > -1) {
                    this.setItemSelectedState(this.focussed, !this.selected[this.focussed]);
                    handledEvent(e);
                }
                else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                    if (!this.open) {
                        this.render(true);
                    }
                    this.setFocussed(this.focussed > 0 ? this.focussed - 1 : this.data.options.length - 1);
                    this.scrollOptionIntoView(this.focussed);
                    handledEvent(e);
                }
                else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                    if (!this.open) {
                        this.render(true);
                    }
                    this.setFocussed(this.focussed < this.data.options.length - 1 ? this.focussed + 1 : 0);
                    this.scrollOptionIntoView(this.focussed);
                    handledEvent(e);
                }
            }
            else {
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                    this.setItemSelectedState(this.lastSelected > 0 ? this.lastSelected - 1 : this.data.options.length - 1, true);
                    this.scrollOptionIntoView(this.lastSelected);
                    handledEvent(e);
                }
                else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                    this.setItemSelectedState(this.lastSelected < this.data.options.length - 1 ? this.lastSelected + 1 : 0, true);
                    this.scrollOptionIntoView(this.lastSelected);
                    handledEvent(e);
                }
            }
        });
        if (data.multiple) {
            for (let i = data.options.length - 1; i >= 0; i--) {
                if (data.defaults.includes(data.options[i].value)) {
                    this.setItemSelectedState(i, true);
                }
            }
        }
        else {
            const defaultIndex = data.options.findIndex((option) => option.value === data.default);
            this.setItemSelectedState(defaultIndex > -1 ? defaultIndex : 0, true);
        }
        this.renderCurrentValue();
    }
    remove() {
        this.dialogElem = null;
        if (this.elem !== null) {
            this.elem.remove();
            this.elem = null;
        }
        if (this.currentElem !== null) {
            this.currentElem.remove();
            this.currentElem = null;
        }
        if (this.optionsElem !== null) {
            this.optionsElem.remove();
            this.optionsElem = null;
        }
        if (this.clickHandler !== null) {
            document.removeEventListener('click', this.clickHandler, true);
            this.clickHandler = null;
        }
    }
    getValue() {
        const values = this.data.options.map((option) => option.value).filter((_, index) => this.selected[index]);
        return this.data.multiple ? values : values[0];
    }
    setItemSelectedState(index, state) {
        if (!this.data.multiple && this.lastSelected > -1) {
            this.selected[this.lastSelected] = false;
        }
        this.selected[index] = state;
        this.lastSelected = index;
        this.renderCurrentValue();
        this.renderOptionsStates();
    }
    setFocussed(index) {
        if (this.focussed !== index) {
            if (this.focussed > -1) {
                const currentlyFocussedOption = this.getOptionElem(this.focussed);
                if (currentlyFocussedOption !== null) {
                    alterClass(currentlyFocussedOption, CLASS_FOCUSSED, false);
                }
            }
            this.focussed = index;
            const newlyFocussedOption = this.getOptionElem(this.focussed);
            if (newlyFocussedOption !== null) {
                alterClass(newlyFocussedOption, CLASS_FOCUSSED, true);
            }
        }
    }
    render(open) {
        if (this.elem === null || this.currentElem === null || this.dialogElem === null)
            return;
        if (this.open !== open) {
            this.open = open;
            if (open) {
                if (this.optionsElem !== null) {
                    this.optionsElem.remove();
                }
                this.optionsElem = document.createElement('div');
                const currentElemRect = this.currentElem.getBoundingClientRect(), dialogElemRect = this.dialogElem.getBoundingClientRect();
                this.optionsElem.style.top = (currentElemRect.top - dialogElemRect.top + currentElemRect.height - 2) + 'px';
                this.optionsElem.style.left = (currentElemRect.left - dialogElemRect.left - 1) + 'px';
                this.optionsElem.style.width = currentElemRect.width + 'px';
                this.optionsElem.style.maxHeight = Math.max(document.body.clientHeight - currentElemRect.top - currentElemRect.height - 2, 50) + 'px';
                this.optionsElem.className = 'customSelectOptions' + (this.data.multiple ? ' multiple' : '');
                const icon = this.data.multiple ? '<div class="selectedIcon">' + SVG_ICONS.check + '</div>' : '';
                this.optionsElem.innerHTML = this.data.options.map((option, index) => '<div class="customSelectOption" data-index="' + index + '">' + icon + escapeHtml(option.name) + '</div>').join('');
                addListenerToCollectionElems(this.optionsElem.children, 'mousemove', (e) => {
                    if (!e.target)
                        return;
                    const elem = e.target.closest('.customSelectOption');
                    if (elem === null)
                        return;
                    this.setFocussed(parseInt(elem.dataset.index));
                });
                this.optionsElem.addEventListener('mouseleave', () => this.setFocussed(-1));
                this.dialogElem.appendChild(this.optionsElem);
            }
            else {
                if (this.optionsElem !== null) {
                    this.optionsElem.remove();
                    this.optionsElem = null;
                }
                this.setFocussed(-1);
            }
            alterClass(this.elem, 'open', open);
        }
        if (open) {
            this.renderOptionsStates();
        }
    }
    renderCurrentValue() {
        if (this.currentElem === null)
            return;
        const value = formatCommaSeparatedList(this.data.options.filter((_, index) => this.selected[index]).map((option) => option.name)) || 'None';
        this.currentElem.title = value;
        this.currentElem.innerHTML = escapeHtml(value);
    }
    renderOptionsStates() {
        if (this.optionsElem !== null) {
            let optionElems = this.optionsElem.children, elemIndex;
            for (let i = 0; i < optionElems.length; i++) {
                elemIndex = parseInt(optionElems[i].dataset.index);
                alterClass(optionElems[i], CLASS_SELECTED, this.selected[elemIndex]);
                alterClass(optionElems[i], CLASS_FOCUSSED, this.focussed === elemIndex);
            }
        }
    }
    getOptionElem(index) {
        if (this.optionsElem !== null && index > -1) {
            const optionElems = this.optionsElem.children, indexStr = index.toString();
            for (let i = 0; i < optionElems.length; i++) {
                if (optionElems[i].dataset.index === indexStr) {
                    return optionElems[i];
                }
            }
        }
        return null;
    }
    scrollOptionIntoView(index) {
        const elem = this.getOptionElem(index);
        if (this.optionsElem !== null && elem !== null) {
            const elemOffsetTop = elem.offsetTop, elemHeight = elem.clientHeight;
            const optionsScrollTop = this.optionsElem.scrollTop, optionsHeight = this.optionsElem.clientHeight;
            if (elemOffsetTop < optionsScrollTop) {
                this.optionsElem.scroll(0, elemOffsetTop);
            }
            else if (elemOffsetTop + elemHeight > optionsScrollTop + optionsHeight) {
                this.optionsElem.scroll(0, Math.max(elemOffsetTop + elemHeight - optionsHeight, 0));
            }
        }
    }
}

/* ==== dropdown.js ==== */
class Dropdown {
    constructor(id, showInfo, multipleAllowed, dropdownType, changeCallback, selectMultipleWithCtrl = false, filterSubmitCallback = null) {
        this.options = [];
        this.optionsSelected = [];
        this.lastSelected = 0;
        this.dropdownVisible = false;
        this.lastClicked = 0;
        this.doubleClickTimeout = null;
        this.showInfo = showInfo;
        this.multipleAllowed = multipleAllowed;
        this.selectMultipleWithCtrl = selectMultipleWithCtrl;
        this.changeCallback = changeCallback;
        this.filterSubmitCallback = filterSubmitCallback;
        this.elem = document.getElementById(id);
        this.menuElem = document.createElement('div');
        this.menuElem.className = 'dropdownMenu';
        let filter = this.menuElem.appendChild(document.createElement('div'));
        filter.className = 'dropdownFilter';
        this.filterInput = filter.appendChild(document.createElement('input'));
        this.filterInput.className = 'dropdownFilterInput';
        this.filterInput.placeholder = 'Filter ' + dropdownType + '...';
        this.optionsElem = this.menuElem.appendChild(document.createElement('div'));
        this.optionsElem.className = 'dropdownOptions';
        this.noResultsElem = this.menuElem.appendChild(document.createElement('div'));
        this.noResultsElem.className = 'dropdownNoResults';
        this.noResultsElem.innerHTML = 'No results found.';
        this.currentValueElem = this.elem.appendChild(document.createElement('div'));
        this.currentValueElem.className = 'dropdownCurrentValue';
        alterClass(this.elem, 'multi', (multipleAllowed && !selectMultipleWithCtrl));
        this.elem.appendChild(this.menuElem);
        document.addEventListener('click', (e) => {
            if (!e.target)
                return;
            if (e.target === this.currentValueElem) {
                this.dropdownVisible = !this.dropdownVisible;
                if (this.dropdownVisible) {
                    this.filterInput.value = '';
                    this.filter();
                }
                this.elem.classList.toggle('dropdownOpen');
                if (this.dropdownVisible)
                    this.filterInput.focus();
            }
            else if (this.dropdownVisible) {
                if (e.target.closest('.dropdown') !== this.elem) {
                    this.close();
                }
                else {
                    const option = e.target.closest('.dropdownOption');
                    if (option !== null && option.parentNode === this.optionsElem && typeof option.dataset.id !== 'undefined') {
                        this.onOptionClick(parseInt(option.dataset.id), e);
                    }
                }
            }
        }, true);
        document.addEventListener('contextmenu', () => this.close(), true);
        this.filterInput.addEventListener('keyup', () => this.filter());
        this.filterInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.filterSubmitCallback !== null) {
                const value = this.filterInput.value.trim();
                if (value !== '') {
                    this.close();
                    this.filterSubmitCallback(value);
                }
            }
        });
    }
    setOptions(options, optionsSelected) {
        this.options = options;
        this.optionsSelected = [];
        let selectedOption = -1, isSelected;
        if (optionsSelected) {
            for (let i = 0; i < options.length; i++) {
                isSelected = optionsSelected.includes(options[i].value);
                this.optionsSelected[i] = isSelected;
                if (isSelected) {
                    selectedOption = i;
                }
            }
        }
        if (selectedOption === -1) {
            selectedOption = 0;
            this.optionsSelected[selectedOption] = true;
        }
        this.lastSelected = selectedOption;
        if (this.dropdownVisible && options.length <= 1)
            this.close();
        this.render();
        this.clearDoubleClickTimeout();
    }
    isSelected(value) {
        if (this.options.length > 0) {
            if (this.multipleAllowed && this.optionsSelected[0]) {
                return true;
            }
            const optionIndex = this.options.findIndex((option) => option.value === value);
            if (optionIndex > -1 && this.optionsSelected[optionIndex]) {
                return true;
            }
        }
        return false;
    }
    isShowAllSelected() {
        return this.optionsSelected[0];
    }
    selectOption(value, event) {
        const optionIndex = this.options.findIndex((option) => value === option.value);
        if (optionIndex < 0 && (this.optionsSelected[0] || this.optionsSelected[optionIndex]))
            return;
        if (this.multipleAllowed && !this.optionsSelected[0] && (!this.selectMultipleWithCtrl || (event && (event.ctrlKey || event.metaKey)))) {
            this.optionsSelected[optionIndex] = true;
        }
        else {
            for (let i = 0; i < this.optionsSelected.length; i++) {
                this.optionsSelected[i] = false;
            }
            this.optionsSelected[optionIndex] = true;
        }
        const menuScroll = this.menuElem.scrollTop;
        this.render();
        if (this.dropdownVisible) {
            this.menuElem.scroll(0, menuScroll);
        }
        this.changeCallback(this.getSelectedOptions(false));
    }
    unselectOption(value) {
        const optionIndex = this.options.findIndex((option) => value === option.value);
        if (optionIndex < 0 && (this.optionsSelected[0] || this.optionsSelected[optionIndex]))
            return;
        if (this.multipleAllowed) {
            if (this.optionsSelected[0]) {
                this.optionsSelected[0] = false;
                for (let i = 1; i < this.optionsSelected.length; i++) {
                    this.optionsSelected[i] = true;
                }
            }
            this.optionsSelected[optionIndex] = false;
            if (this.optionsSelected.every(selected => !selected)) {
                this.optionsSelected[0] = true;
            }
            const menuScroll = this.menuElem.scrollTop;
            this.render();
            if (this.dropdownVisible) {
                this.menuElem.scroll(0, menuScroll);
            }
            this.changeCallback(this.getSelectedOptions(false));
        }
    }
    refresh() {
        if (this.options.length > 0)
            this.render();
    }
    isOpen() {
        return this.dropdownVisible;
    }
    close() {
        this.elem.classList.remove('dropdownOpen');
        this.dropdownVisible = false;
        this.clearDoubleClickTimeout();
    }
    render() {
        this.elem.classList.add('loaded');
        const curValueText = formatCommaSeparatedList(this.getSelectedOptions(true));
        this.currentValueElem.title = curValueText;
        this.currentValueElem.innerHTML = escapeHtml(curValueText);
        let html = '';
        for (let i = 0; i < this.options.length; i++) {
            const escapedName = escapeHtml(this.options[i].name);
            html += '<div class="dropdownOption' + (this.optionsSelected[i] ? ' ' + CLASS_SELECTED : '') + '" data-id="' + i + '" title="' + escapedName + '">' +
                (this.multipleAllowed && !this.selectMultipleWithCtrl && this.optionsSelected[i] ? '<div class="dropdownOptionMultiSelected">' + SVG_ICONS.check + '</div>' : '') +
                escapedName + (typeof this.options[i].hint === 'string' && this.options[i].hint !== '' ? '<span class="dropdownOptionHint">' + escapeHtml(this.options[i].hint) + '</span>' : '') +
                (this.showInfo ? '<div class="dropdownOptionInfo" title="' + escapeHtml(this.options[i].value) + '">' + SVG_ICONS.info + '</div>' : '') +
                '</div>';
        }
        this.optionsElem.className = 'dropdownOptions' + (this.showInfo ? ' showInfo' : '');
        this.optionsElem.innerHTML = html;
        this.filterInput.style.display = 'none';
        this.noResultsElem.style.display = 'none';
        this.menuElem.style.cssText = 'left:0; overflow-y:auto; max-height:297px;';
        if (this.dropdownVisible)
            this.filter();
    }
    filter() {
        let val = this.filterInput.value.toLowerCase(), match, matches = false;
        for (let i = 0; i < this.options.length; i++) {
            match = this.options[i].name.toLowerCase().indexOf(val) > -1;
            this.optionsElem.children[i].style.display = match ? 'block' : 'none';
            if (match)
                matches = true;
        }
        this.filterInput.style.display = 'block';
        this.noResultsElem.style.display = matches ? 'none' : 'block';
    }
    getSelectedOptions(names) {
        let selected = [];
        if (this.multipleAllowed && this.optionsSelected[0]) {
            return [names ? this.options[0].name : this.options[0].value];
        }
        for (let i = 0; i < this.options.length; i++) {
            if (this.optionsSelected[i])
                selected.push(names ? this.options[i].name : this.options[i].value);
        }
        return selected;
    }
    onOptionClick(option, event) {
        let change = false;
        let doubleClick = this.doubleClickTimeout !== null && this.lastClicked === option;
        if (this.doubleClickTimeout !== null)
            this.clearDoubleClickTimeout();
        if (doubleClick) {
            if (this.multipleAllowed && option === 0) {
                for (let i = 1; i < this.optionsSelected.length; i++) {
                    this.optionsSelected[i] = !this.optionsSelected[i];
                }
                change = true;
            }
        }
        else {
            if (this.multipleAllowed && (!this.selectMultipleWithCtrl || (event && (event.ctrlKey || event.metaKey)))) {
                if (option === 0) {
                    if (!this.optionsSelected[0]) {
                        this.optionsSelected[0] = true;
                        for (let i = 1; i < this.optionsSelected.length; i++) {
                            this.optionsSelected[i] = false;
                        }
                        change = true;
                    }
                }
                else {
                    if (this.optionsSelected[0]) {
                        this.optionsSelected[0] = false;
                    }
                    this.optionsSelected[option] = !this.optionsSelected[option];
                    if (this.optionsSelected.every(selected => !selected)) {
                        this.optionsSelected[0] = true;
                    }
                    change = true;
                }
            }
            else {
                this.close();
                if (option === 0) {
                    if (!this.optionsSelected[0]) {
                        this.optionsSelected[0] = true;
                        for (let i = 1; i < this.optionsSelected.length; i++) {
                            this.optionsSelected[i] = false;
                        }
                        change = true;
                    }
                }
                else if (this.lastSelected !== option) {
                    for (let i = 0; i < this.optionsSelected.length; i++) {
                        this.optionsSelected[i] = false;
                    }
                    this.optionsSelected[this.lastSelected] = false;
                    this.optionsSelected[option] = true;
                    change = true;
                }
            }
            if (change) {
                this.lastSelected = option;
                this.changeCallback(this.getSelectedOptions(false));
            }
        }
        if (change) {
            let menuScroll = this.menuElem.scrollTop;
            this.render();
            if (this.dropdownVisible)
                this.menuElem.scroll(0, menuScroll);
        }
        this.lastClicked = option;
        this.doubleClickTimeout = setTimeout(() => {
            this.clearDoubleClickTimeout();
        }, 500);
    }
    clearDoubleClickTimeout() {
        if (this.doubleClickTimeout !== null) {
            clearTimeout(this.doubleClickTimeout);
            this.doubleClickTimeout = null;
        }
    }
}

/* ==== findWidget.js ==== */
const CLASS_FIND_CURRENT_COMMIT = 'findCurrentCommit';
const CLASS_FIND_MATCH = 'findMatch';
class FindWidget {
    constructor(view) {
        this.text = '';
        this.matches = [];
        this.position = -1;
        this.visible = false;
        this.view = view;
        this.widgetElem = document.createElement('div');
        this.widgetElem.className = 'findWidget';
        this.widgetElem.innerHTML = '<input id="findInput" type="text" placeholder="Find" disabled/><span id="findCaseSensitive" class="findModifier" title="Match Case">Aa</span><span id="findRegex" class="findModifier" title="Use Regular Expression">.*</span><span id="findPosition"></span><span id="findPrev" title="Previous match (Shift+Enter)"></span><span id="findNext" title="Next match (Enter)"></span><span id="findOpenCdv" title="Open the Commit Details View for the current match"></span><span id="findClose" title="Close (Escape)"></span>';
        document.body.appendChild(this.widgetElem);
        this.inputElem = document.getElementById('findInput');
        let keyupTimeout = null;
        this.inputElem.addEventListener('keyup', (e) => {
            if ((e.keyCode ? e.keyCode === 13 : e.key === 'Enter') && this.text !== '') {
                if (e.shiftKey) {
                    this.prev();
                }
                else {
                    this.next();
                }
                handledEvent(e);
            }
            else {
                if (keyupTimeout !== null)
                    clearTimeout(keyupTimeout);
                keyupTimeout = setTimeout(() => {
                    keyupTimeout = null;
                    if (this.text !== this.inputElem.value) {
                        this.text = this.inputElem.value;
                        this.clearMatches();
                        this.findMatches(this.getCurrentHash(), true);
                        this.openCommitDetailsViewForCurrentMatchIfEnabled();
                    }
                }, 200);
            }
        });
        this.caseSensitiveElem = document.getElementById('findCaseSensitive');
        alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
        this.caseSensitiveElem.addEventListener('click', () => {
            updateWorkspaceViewState('findIsCaseSensitive', !workspaceState.findIsCaseSensitive);
            alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
            this.clearMatches();
            this.findMatches(this.getCurrentHash(), true);
            this.openCommitDetailsViewForCurrentMatchIfEnabled();
        });
        this.regexElem = document.getElementById('findRegex');
        alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
        this.regexElem.addEventListener('click', () => {
            updateWorkspaceViewState('findIsRegex', !workspaceState.findIsRegex);
            alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
            this.clearMatches();
            this.findMatches(this.getCurrentHash(), true);
            this.openCommitDetailsViewForCurrentMatchIfEnabled();
        });
        this.positionElem = document.getElementById('findPosition');
        this.prevElem = document.getElementById('findPrev');
        this.prevElem.classList.add(CLASS_DISABLED);
        this.prevElem.innerHTML = SVG_ICONS.arrowUp;
        this.prevElem.addEventListener('click', () => this.prev());
        this.nextElem = document.getElementById('findNext');
        this.nextElem.classList.add(CLASS_DISABLED);
        this.nextElem.innerHTML = SVG_ICONS.arrowDown;
        this.nextElem.addEventListener('click', () => this.next());
        const openCdvElem = document.getElementById('findOpenCdv');
        openCdvElem.innerHTML = SVG_ICONS.cdv;
        alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
        openCdvElem.addEventListener('click', () => {
            updateWorkspaceViewState('findOpenCommitDetailsView', !workspaceState.findOpenCommitDetailsView);
            alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
            this.openCommitDetailsViewForCurrentMatchIfEnabled();
        });
        const findCloseElem = document.getElementById('findClose');
        findCloseElem.innerHTML = SVG_ICONS.close;
        findCloseElem.addEventListener('click', () => this.close());
    }
    show(transition) {
        if (!this.visible) {
            this.visible = true;
            this.inputElem.value = this.text;
            this.inputElem.disabled = false;
            this.updatePosition(-1, false);
            alterClass(this.widgetElem, CLASS_TRANSITION, transition);
            this.widgetElem.classList.add(CLASS_ACTIVE);
        }
        this.inputElem.focus();
    }
    close() {
        if (!this.visible)
            return;
        this.visible = false;
        this.widgetElem.classList.add(CLASS_TRANSITION);
        this.widgetElem.classList.remove(CLASS_ACTIVE);
        this.clearMatches();
        this.text = '';
        this.matches = [];
        this.position = -1;
        this.inputElem.value = this.text;
        this.inputElem.disabled = true;
        this.widgetElem.removeAttribute(ATTR_ERROR);
        this.prevElem.classList.add(CLASS_DISABLED);
        this.nextElem.classList.add(CLASS_DISABLED);
        this.view.saveState();
    }
    refresh() {
        if (this.visible) {
            this.findMatches(this.getCurrentHash(), false);
        }
    }
    setColour(colour) {
        document.body.style.setProperty('--git-graph-findMatch', colour);
        document.body.style.setProperty('--git-graph-findMatchCommit', modifyColourOpacity(colour, 0.5));
    }
    getState() {
        return {
            text: this.text,
            currentHash: this.getCurrentHash(),
            visible: this.visible
        };
    }
    getCurrentHash() {
        return this.position > -1 ? this.matches[this.position].hash : null;
    }
    restoreState(state) {
        if (!state.visible)
            return;
        this.text = state.text;
        this.show(false);
        if (this.text !== '')
            this.findMatches(state.currentHash, false);
    }
    isVisible() {
        return this.visible;
    }
    findMatches(goToCommitHash, scrollToCommit) {
        this.matches = [];
        this.position = -1;
        if (this.text !== '') {
            let colVisibility = this.view.getColumnVisibility(), findPattern, findGlobalPattern;
            const regexText = workspaceState.findIsRegex ? this.text : this.text.replace(/[\\\[\](){}|.*+?^$]/g, '\\$&'), flags = 'u' + (workspaceState.findIsCaseSensitive ? '' : 'i');
            try {
                findPattern = new RegExp(regexText, flags);
                findGlobalPattern = new RegExp(regexText, 'g' + flags);
                this.widgetElem.removeAttribute(ATTR_ERROR);
            }
            catch (e) {
                findPattern = null;
                findGlobalPattern = null;
                this.widgetElem.setAttribute(ATTR_ERROR, e.message);
            }
            if (findPattern !== null && findGlobalPattern !== null) {
                let commitElems = getCommitElems(), j = 0, commit, zeroLengthMatch = false;
                const commits = this.view.getCommits();
                for (let i = 0; i < commits.length; i++) {
                    commit = commits[i];
                    let branchLabels = getBranchLabels(commit.heads, commit.remotes);
                    if (commit.hash !== UNCOMMITTED && ((colVisibility.author && findPattern.test(commit.author))
                        || (colVisibility.commit && (commit.hash.search(findPattern) === 0 || findPattern.test(abbrevCommit(commit.hash))))
                        || findPattern.test(commit.message)
                        || branchLabels.heads.some(head => findPattern.test(head.name) || head.remotes.some(remote => findPattern.test(remote)))
                        || branchLabels.remotes.some(remote => findPattern.test(remote.name))
                        || commit.tags.some(tag => findPattern.test(tag.name))
                        || (colVisibility.date && findPattern.test(formatShortDate(commit.date).formatted))
                        || (commit.stash !== null && findPattern.test(commit.stash.selector)))) {
                        let idStr = i.toString();
                        while (j < commitElems.length && commitElems[j].dataset.id !== idStr)
                            j++;
                        if (j === commitElems.length)
                            continue;
                        this.matches.push({ hash: commit.hash, elem: commitElems[j] });
                        let textElems = getChildNodesWithTextContent(commitElems[j]), textElem;
                        for (let k = 0; k < textElems.length; k++) {
                            textElem = textElems[k];
                            let matchStart = 0, matchEnd = 0, text = textElem.textContent, match;
                            findGlobalPattern.lastIndex = 0;
                            while (match = findGlobalPattern.exec(text)) {
                                if (match[0].length === 0) {
                                    zeroLengthMatch = true;
                                    break;
                                }
                                if (matchEnd !== match.index) {
                                    if (matchStart !== matchEnd) {
                                        textElem.parentNode.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
                                    }
                                    textElem.parentNode.insertBefore(document.createTextNode(text.substring(matchEnd, match.index)), textElem);
                                    matchStart = match.index;
                                }
                                matchEnd = findGlobalPattern.lastIndex;
                            }
                            if (matchEnd > 0) {
                                if (matchStart !== matchEnd) {
                                    textElem.parentNode.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
                                }
                                if (matchEnd !== text.length) {
                                    textElem.textContent = text.substring(matchEnd);
                                }
                                else {
                                    textElem.parentNode.removeChild(textElem);
                                }
                            }
                            if (zeroLengthMatch)
                                break;
                        }
                        if (colVisibility.commit && commit.hash.search(findPattern) === 0 && !findPattern.test(abbrevCommit(commit.hash)) && textElems.length > 0) {
                            let commitNode = textElems[textElems.length - 1];
                            commitNode.parentNode.replaceChild(FindWidget.createMatchElem(commitNode.textContent), commitNode);
                        }
                        if (zeroLengthMatch)
                            break;
                    }
                }
                if (zeroLengthMatch) {
                    this.widgetElem.setAttribute(ATTR_ERROR, 'Cannot use a regular expression which has zero length matches');
                    this.clearMatches();
                    this.matches = [];
                }
            }
        }
        else {
            this.widgetElem.removeAttribute(ATTR_ERROR);
        }
        alterClass(this.prevElem, CLASS_DISABLED, this.matches.length === 0);
        alterClass(this.nextElem, CLASS_DISABLED, this.matches.length === 0);
        let newPos = -1;
        if (this.matches.length > 0) {
            newPos = 0;
            if (goToCommitHash !== null) {
                let pos = this.matches.findIndex(match => match.hash === goToCommitHash);
                if (pos > -1)
                    newPos = pos;
            }
        }
        this.updatePosition(newPos, scrollToCommit);
    }
    clearMatches() {
        for (let i = 0; i < this.matches.length; i++) {
            if (i === this.position)
                this.matches[i].elem.classList.remove(CLASS_FIND_CURRENT_COMMIT);
            let matchElems = getChildrenWithClassName(this.matches[i].elem, CLASS_FIND_MATCH), matchElem;
            for (let j = 0; j < matchElems.length; j++) {
                matchElem = matchElems[j];
                let text = matchElem.childNodes[0].textContent;
                let node = matchElem.previousSibling, elem = matchElem.previousElementSibling;
                while (node !== null && node !== elem && node.textContent !== null) {
                    text = node.textContent + text;
                    matchElem.parentNode.removeChild(node);
                    node = matchElem.previousSibling;
                }
                node = matchElem.nextSibling;
                elem = matchElem.nextElementSibling;
                while (node !== null && node !== elem && node.textContent !== null) {
                    text = text + node.textContent;
                    matchElem.parentNode.removeChild(node);
                    node = matchElem.nextSibling;
                }
                matchElem.parentNode.replaceChild(document.createTextNode(text), matchElem);
            }
        }
    }
    updatePosition(position, scrollToCommit) {
        if (this.position > -1)
            this.matches[this.position].elem.classList.remove(CLASS_FIND_CURRENT_COMMIT);
        this.position = position;
        if (this.position > -1) {
            this.matches[this.position].elem.classList.add(CLASS_FIND_CURRENT_COMMIT);
            if (scrollToCommit)
                this.view.scrollToCommit(this.matches[position].hash, false);
        }
        this.positionElem.innerHTML = this.matches.length > 0 ? (this.position + 1) + ' of ' + this.matches.length : 'No Results';
        this.view.saveState();
    }
    prev() {
        if (this.matches.length === 0)
            return;
        this.updatePosition(this.position > 0 ? this.position - 1 : this.matches.length - 1, true);
        this.openCommitDetailsViewForCurrentMatchIfEnabled();
    }
    next() {
        if (this.matches.length === 0)
            return;
        this.updatePosition(this.position < this.matches.length - 1 ? this.position + 1 : 0, true);
        this.openCommitDetailsViewForCurrentMatchIfEnabled();
    }
    openCommitDetailsViewForCurrentMatchIfEnabled() {
        if (workspaceState.findOpenCommitDetailsView) {
            const commitHash = this.getCurrentHash();
            if (commitHash !== null && !this.view.isCdvOpen(commitHash, null)) {
                const commitElem = findCommitElemWithId(getCommitElems(), this.view.getCommitId(commitHash));
                if (commitElem !== null) {
                    this.view.loadCommitDetails(commitElem);
                }
            }
        }
    }
    static createMatchElem(text) {
        const span = document.createElement('span');
        span.className = CLASS_FIND_MATCH;
        span.innerHTML = text;
        return span;
    }
}

/* ==== graph.js ==== */
const CLASS_GRAPH_VERTEX_ACTIVE = 'graphVertexActive';
const NULL_VERTEX_ID = -1;
class Branch {
    constructor(colour) {
        this.end = 0;
        this.lines = [];
        this.numUncommitted = 0;
        this.colour = colour;
    }
    addLine(p1, p2, isCommitted, lockedFirst, isDashed = false) {
        this.lines.push({ p1: p1, p2: p2, lockedFirst: lockedFirst, isDashed: isDashed });
        if (isCommitted) {
            if (p2.x === 0 && p2.y < this.numUncommitted)
                this.numUncommitted = p2.y;
        }
        else {
            this.numUncommitted++;
        }
    }
    getColour() {
        return this.colour;
    }
    getEnd() {
        return this.end;
    }
    setEnd(end) {
        this.end = end;
    }
    draw(svg, config, expandAt) {
        let colour = 'var(--git-graph-color' + (this.colour % config.colours.length) + ')', i, x1, y1, x2, y2, lines = [], curPath = '', d = config.grid.y * (config.style === 1 ? 0.38 : 0.8), line, nextLine;
        for (i = 0; i < this.lines.length; i++) {
            line = this.lines[i];
            x1 = line.p1.x * config.grid.x + config.grid.offsetX;
            y1 = line.p1.y * config.grid.y + config.grid.offsetY;
            x2 = line.p2.x * config.grid.x + config.grid.offsetX;
            y2 = line.p2.y * config.grid.y + config.grid.offsetY;
            if (expandAt > -1) {
                if (line.p1.y > expandAt) {
                    y1 += config.grid.expandY;
                    y2 += config.grid.expandY;
                }
                else if (line.p2.y > expandAt) {
                    if (x1 === x2) {
                        y2 += config.grid.expandY;
                    }
                    else if (line.lockedFirst) {
                        lines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst, isDashed: line.isDashed });
                        lines.push({ p1: { x: x2, y: y1 + config.grid.y }, p2: { x: x2, y: y2 + config.grid.expandY }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst, isDashed: line.isDashed });
                        continue;
                    }
                    else {
                        lines.push({ p1: { x: x1, y: y1 }, p2: { x: x1, y: y2 - config.grid.y + config.grid.expandY }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst, isDashed: line.isDashed });
                        y1 += config.grid.expandY;
                        y2 += config.grid.expandY;
                    }
                }
            }
            lines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst, isDashed: line.isDashed });
        }
        i = 0;
        while (i < lines.length - 1) {
            line = lines[i];
            nextLine = lines[i + 1];
            if (line.p1.x === line.p2.x && line.p2.x === nextLine.p1.x && nextLine.p1.x === nextLine.p2.x && line.p2.y === nextLine.p1.y && line.isCommitted === nextLine.isCommitted && line.isDashed === nextLine.isDashed) {
                line.p2.y = nextLine.p2.y;
                lines.splice(i + 1, 1);
            }
            else {
                i++;
            }
        }
        for (i = 0; i < lines.length; i++) {
            line = lines[i];
            x1 = line.p1.x;
            y1 = line.p1.y;
            x2 = line.p2.x;
            y2 = line.p2.y;
            if (curPath !== '' && i > 0 && (line.isCommitted !== lines[i - 1].isCommitted || line.isDashed !== lines[i - 1].isDashed)) {
                Branch.drawPath(svg, curPath, lines[i - 1].isCommitted, colour, config.uncommittedChanges, lines[i - 1].isDashed);
                curPath = '';
            }
            if (curPath === '' || (i > 0 && (x1 !== lines[i - 1].p2.x || y1 !== lines[i - 1].p2.y)))
                curPath += 'M' + x1.toFixed(0) + ',' + y1.toFixed(1);
            if (x1 === x2) {
                curPath += 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
            }
            else {
                if (config.style === 1) {
                    curPath += 'L' + (line.lockedFirst ? (x2.toFixed(0) + ',' + (y2 - d).toFixed(1)) : (x1.toFixed(0) + ',' + (y1 + d).toFixed(1))) + 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
                }
                else {
                    curPath += 'C' + x1.toFixed(0) + ',' + (y1 + d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + (y2 - d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + y2.toFixed(1);
                }
            }
        }
        if (curPath !== '') {
            Branch.drawPath(svg, curPath, lines[lines.length - 1].isCommitted, colour, config.uncommittedChanges, lines[lines.length - 1].isDashed);
        }
    }
    static drawPath(svg, path, isCommitted, colour, uncommittedChanges, isDashed = false) {
        const shadow = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path')), line = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path'));
        shadow.setAttribute('class', 'shadow');
        shadow.setAttribute('d', path);
        line.setAttribute('class', 'line');
        line.setAttribute('d', path);
        line.setAttribute('stroke', isCommitted ? colour : '#808080');
        if (isDashed) {
            line.setAttribute('stroke-dasharray', '4 2');
            line.setAttribute('stroke-opacity', '0.6');
        }
        else if (!isCommitted && uncommittedChanges === 1) {
            line.setAttribute('stroke-dasharray', '2px');
        }
    }
}
class Vertex {
    constructor(id, isStash) {
        this.x = 0;
        this.children = [];
        this.parents = [];
        this.nextParent = 0;
        this.onBranch = null;
        this.isCommitted = true;
        this.isCurrent = false;
        this.syntheticParent = false;
        this.pathFilterDimmed = false;
        this.nextX = 0;
        this.connections = [];
        this.id = id;
        this.isStash = isStash;
    }
    addChild(vertex) {
        this.children.push(vertex);
    }
    getChildren() {
        return this.children;
    }
    addParent(vertex) {
        this.parents.push(vertex);
    }
    getParents() {
        return this.parents;
    }
    hasParents() {
        return this.parents.length > 0;
    }
    getNextParent() {
        if (this.nextParent < this.parents.length)
            return this.parents[this.nextParent];
        return null;
    }
    getLastParent() {
        if (this.nextParent < 1)
            return null;
        return this.parents[this.nextParent - 1];
    }
    registerParentProcessed() {
        this.nextParent++;
    }
    isMerge() {
        return this.parents.length > 1;
    }
    addToBranch(branch, x) {
        if (this.onBranch === null) {
            this.onBranch = branch;
            this.x = x;
        }
    }
    isNotOnBranch() {
        return this.onBranch === null;
    }
    isOnThisBranch(branch) {
        return this.onBranch === branch;
    }
    getBranch() {
        return this.onBranch;
    }
    getPoint() {
        return { x: this.x, y: this.id };
    }
    getNextPoint() {
        return { x: this.nextX, y: this.id };
    }
    getPointConnectingTo(vertex, onBranch) {
        for (let i = 0; i < this.connections.length; i++) {
            if (this.connections[i].connectsTo === vertex && this.connections[i].onBranch === onBranch) {
                return { x: i, y: this.id };
            }
        }
        return null;
    }
    registerUnavailablePoint(x, connectsToVertex, onBranch) {
        if (x === this.nextX) {
            this.nextX = x + 1;
            this.connections[x] = { connectsTo: connectsToVertex, onBranch: onBranch };
        }
    }
    getColour() {
        return this.onBranch !== null ? this.onBranch.getColour() : 0;
    }
    getIsCommitted() {
        return this.isCommitted;
    }
    setNotCommitted() {
        this.isCommitted = false;
    }
    setCurrent() {
        this.isCurrent = true;
    }
    hasSyntheticParent() {
        return this.syntheticParent;
    }
    setSyntheticParent(value) {
        this.syntheticParent = value;
    }
    isPathFilterDimmed() {
        return this.pathFilterDimmed;
    }
    setPathFilterDimmed(value) {
        this.pathFilterDimmed = value;
    }
    draw(svg, config, expandOffset, overListener, outListener) {
        if (this.onBranch === null)
            return;
        const colour = this.isCommitted ? 'var(--git-graph-color' + (this.onBranch.getColour() % config.colours.length) + ')' : '#808080';
        const cx = (this.x * config.grid.x + config.grid.offsetX).toString();
        const cy = (this.id * config.grid.y + config.grid.offsetY + (expandOffset ? config.grid.expandY : 0)).toString();
        const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
        circle.dataset.id = this.id.toString();
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', '4');
        if (this.isCurrent) {
            circle.setAttribute('class', 'current');
            circle.setAttribute('stroke', colour);
        }
        else {
            circle.setAttribute('fill', colour);
        }
        svg.appendChild(circle);
        if (this.pathFilterDimmed) {
            circle.setAttribute('opacity', '0.4');
        }
        if (this.isStash && !this.isCurrent) {
            circle.setAttribute('r', '4.5');
            circle.setAttribute('class', 'stashOuter');
            const innerCircle = document.createElementNS(SVG_NAMESPACE, 'circle');
            innerCircle.setAttribute('cx', cx);
            innerCircle.setAttribute('cy', cy);
            innerCircle.setAttribute('r', '2');
            innerCircle.setAttribute('class', 'stashInner');
            svg.appendChild(innerCircle);
        }
        circle.addEventListener('mouseover', overListener);
        circle.addEventListener('mouseout', outListener);
    }
}
class Graph {
    constructor(id, viewElem, config, muteConfig) {
        this.vertices = [];
        this.branches = [];
        this.availableColours = [];
        this.maxWidth = -1;
        this.commits = [];
        this.commitHead = null;
        this.commitLookup = {};
        this.onlyFollowFirstParent = false;
        this.pathFilterActive = false;
        this.expandedCommitIndex = -1;
        this.group = null;
        this.tooltipId = -1;
        this.tooltipElem = null;
        this.tooltipTimeout = null;
        this.tooltipVertex = null;
        this.viewElem = viewElem;
        this.config = config;
        this.muteConfig = muteConfig;
        const elem = document.getElementById(id);
        this.contentElem = elem.parentElement;
        this.svg = document.createElementNS(SVG_NAMESPACE, 'svg');
        let defs = this.svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'defs'));
        let linearGradient = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'linearGradient'));
        linearGradient.setAttribute('id', 'GraphGradient');
        this.gradientStop1 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
        this.gradientStop1.setAttribute('stop-color', 'white');
        this.gradientStop2 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
        this.gradientStop2.setAttribute('stop-color', 'black');
        let mask = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'mask'));
        mask.setAttribute('id', 'GraphMask');
        this.maskRect = mask.appendChild(document.createElementNS(SVG_NAMESPACE, 'rect'));
        this.maskRect.setAttribute('fill', 'url(#GraphGradient)');
        this.setDimensions(0, 0);
        elem.appendChild(this.svg);
    }
    loadCommits(commits, commitHead, commitLookup, onlyFollowFirstParent, pathFilterActive = false) {
        this.commits = commits;
        this.commitHead = commitHead;
        this.commitLookup = commitLookup;
        this.onlyFollowFirstParent = onlyFollowFirstParent;
        this.pathFilterActive = pathFilterActive;
        this.vertices = [];
        this.branches = [];
        this.availableColours = [];
        if (commits.length === 0)
            return;
        const nullVertex = new Vertex(NULL_VERTEX_ID, false);
        let i, j;
        for (i = 0; i < commits.length; i++) {
            const v = new Vertex(i, commits[i].stash !== null);
            this.vertices.push(v);
        }
        for (i = 0; i < commits.length; i++) {
            for (j = 0; j < commits[i].parents.length; j++) {
                let parentHash = commits[i].parents[j];
                if (typeof commitLookup[parentHash] === 'number') {
                    this.vertices[i].addParent(this.vertices[commitLookup[parentHash]]);
                    this.vertices[commitLookup[parentHash]].addChild(this.vertices[i]);
                    if (pathFilterActive && commits[i].isSyntheticParent) {
                        this.vertices[i].setSyntheticParent(true);
                    }
                }
                else if (!this.onlyFollowFirstParent || j === 0) {
                    this.vertices[i].addParent(nullVertex);
                }
            }
        }
        if (pathFilterActive) {
            for (i = 0; i < commits.length; i++) {
                if (!commits[i].isPathFilterMatch) {
                    this.vertices[i].setPathFilterDimmed(true);
                }
            }
        }
        if (commits[0].hash === UNCOMMITTED) {
            this.vertices[0].setNotCommitted();
        }
        if (commits[0].hash === UNCOMMITTED && this.config.uncommittedChanges === 0) {
            this.vertices[0].setCurrent();
        }
        else if (commitHead !== null && typeof commitLookup[commitHead] === 'number') {
            this.vertices[commitLookup[commitHead]].setCurrent();
        }
        i = 0;
        while (i < this.vertices.length) {
            if (this.vertices[i].getNextParent() !== null || this.vertices[i].isNotOnBranch()) {
                const prevParent = this.vertices[i].getNextParent();
                this.determinePath(i);
                if (!this.vertices[i].isNotOnBranch() && this.vertices[i].getNextParent() !== null
                    && this.vertices[i].getNextParent() === prevParent) {
                    this.vertices[i].registerParentProcessed();
                }
            }
            else {
                i++;
            }
        }
    }
    render(expandedCommit) {
        this.expandedCommitIndex = expandedCommit !== null ? expandedCommit.index : -1;
        let group = document.createElementNS(SVG_NAMESPACE, 'g'), i, contentWidth = this.getContentWidth();
        group.setAttribute('mask', 'url(#GraphMask)');
        for (i = 0; i < this.branches.length; i++) {
            this.branches[i].draw(group, this.config, this.expandedCommitIndex);
        }
        const overListener = (e) => this.vertexOver(e), outListener = (e) => this.vertexOut(e);
        for (i = 0; i < this.vertices.length; i++) {
            this.vertices[i].draw(group, this.config, expandedCommit !== null && i > expandedCommit.index, overListener, outListener);
        }
        if (this.group !== null)
            this.svg.removeChild(this.group);
        this.svg.appendChild(group);
        this.group = group;
        this.setDimensions(contentWidth, this.getHeight(expandedCommit));
        this.applyMaxWidth(contentWidth);
        this.closeTooltip();
    }
    getContentWidth() {
        let x = 0, i, p;
        for (i = 0; i < this.vertices.length; i++) {
            p = this.vertices[i].getNextPoint();
            if (p.x > x)
                x = p.x;
        }
        return 2 * this.config.grid.offsetX + (x - 1) * this.config.grid.x;
    }
    getHeight(expandedCommit) {
        return this.vertices.length * this.config.grid.y + this.config.grid.offsetY - this.config.grid.y / 2 + (expandedCommit !== null ? this.config.grid.expandY : 0);
    }
    getVertexColours() {
        let colours = [], i;
        for (i = 0; i < this.vertices.length; i++) {
            colours[i] = this.vertices[i].getColour() % this.config.colours.length;
        }
        return colours;
    }
    getWidthsAtVertices() {
        let widths = [], i;
        for (i = 0; i < this.vertices.length; i++) {
            widths[i] = this.config.grid.offsetX + this.vertices[i].getNextPoint().x * this.config.grid.x - 2;
        }
        return widths;
    }
    dropCommitPossible(i) {
        if (!this.vertices[i].hasParents()) {
            return false;
        }
        const isPossible = (v) => {
            if (v.isMerge()) {
                return null;
            }
            let children = v.getChildren();
            if (children.length > 1) {
                return null;
            }
            else if (children.length === 1) {
                const recursivelyPossible = isPossible(children[0]);
                if (recursivelyPossible !== false) {
                    return recursivelyPossible;
                }
            }
            return this.commits[v.id].hash === this.commitHead;
        };
        return isPossible(this.vertices[i]) || false;
    }
    getAllChildren(i) {
        let visited = {};
        const rec = (vertex) => {
            const idStr = vertex.id.toString();
            if (typeof visited[idStr] !== 'undefined')
                return;
            visited[idStr] = vertex.id;
            let children = vertex.getChildren();
            for (let i = 0; i < children.length; i++)
                rec(children[i]);
        };
        rec(this.vertices[i]);
        return Object.keys(visited).map((key) => visited[key]).sort((a, b) => a - b);
    }
    getMutedCommits(currentHash) {
        const muted = [];
        for (let i = 0; i < this.commits.length; i++) {
            muted[i] = false;
        }
        if (this.muteConfig.mergeCommits) {
            for (let i = 0; i < this.commits.length; i++) {
                if (this.vertices[i].isMerge() && this.commits[i].stash === null) {
                    muted[i] = true;
                }
            }
        }
        if (this.muteConfig.commitsNotAncestorsOfHead && currentHash !== null && typeof this.commitLookup[currentHash] === 'number') {
            let ancestor = [];
            for (let i = 0; i < this.commits.length; i++) {
                ancestor[i] = false;
            }
            const rec = (vertex) => {
                if (vertex.id === NULL_VERTEX_ID || ancestor[vertex.id])
                    return;
                ancestor[vertex.id] = true;
                let parents = vertex.getParents();
                for (let i = 0; i < parents.length; i++)
                    rec(parents[i]);
            };
            rec(this.vertices[this.commitLookup[currentHash]]);
            for (let i = 0; i < this.commits.length; i++) {
                if (!ancestor[i] && (this.commits[i].stash === null || typeof this.commitLookup[this.commits[i].stash.baseHash] !== 'number' || !ancestor[this.commitLookup[this.commits[i].stash.baseHash]])) {
                    muted[i] = true;
                }
            }
        }
        return muted;
    }
    getPathFilterDimmedCommits() {
        const dimmed = [];
        for (let i = 0; i < this.commits.length; i++) {
            dimmed[i] = !this.commits[i].isPathFilterMatch;
        }
        return dimmed;
    }
    getFirstParentIndex(i) {
        const parents = this.vertices[i].getParents();
        return parents.length > 0
            ? parents[0].id
            : -1;
    }
    getAlternativeParentIndex(i) {
        const parents = this.vertices[i].getParents();
        return parents.length > 1
            ? parents[1].id
            : parents.length === 1
                ? parents[0].id
                : -1;
    }
    getFirstChildIndex(i) {
        const children = this.vertices[i].getChildren();
        if (children.length > 1) {
            const branch = this.vertices[i].getBranch();
            let childOnSameBranch;
            if (branch !== null && (childOnSameBranch = children.find((child) => child.isOnThisBranch(branch)))) {
                return childOnSameBranch.id;
            }
            else {
                return Math.max(...children.map((child) => child.id));
            }
        }
        else if (children.length === 1) {
            return children[0].id;
        }
        else {
            return -1;
        }
    }
    getAlternativeChildIndex(i) {
        const children = this.vertices[i].getChildren();
        if (children.length > 1) {
            const branch = this.vertices[i].getBranch();
            let childOnSameBranch;
            if (branch !== null && (childOnSameBranch = children.find((child) => child.isOnThisBranch(branch)))) {
                return Math.max(...children.filter(child => child !== childOnSameBranch).map((child) => child.id));
            }
            else {
                const childIndexes = children.map((child) => child.id).sort();
                return childIndexes[childIndexes.length - 2];
            }
        }
        else if (children.length === 1) {
            return children[0].id;
        }
        else {
            return -1;
        }
    }
    limitMaxWidth(maxWidth) {
        this.maxWidth = maxWidth;
        this.applyMaxWidth(this.getContentWidth());
    }
    setDimensions(contentWidth, height) {
        this.setSvgWidth(contentWidth);
        this.svg.setAttribute('height', height.toString());
        this.maskRect.setAttribute('width', contentWidth.toString());
        this.maskRect.setAttribute('height', height.toString());
    }
    applyMaxWidth(contentWidth) {
        this.setSvgWidth(contentWidth);
        let offset1 = this.maxWidth > -1 ? (this.maxWidth - 12) / contentWidth : 1;
        let offset2 = this.maxWidth > -1 ? this.maxWidth / contentWidth : 1;
        this.gradientStop1.setAttribute('offset', offset1.toString());
        this.gradientStop2.setAttribute('offset', offset2.toString());
    }
    setSvgWidth(contentWidth) {
        let width = this.maxWidth > -1 ? Math.min(contentWidth, this.maxWidth) : contentWidth;
        this.svg.setAttribute('width', width.toString());
    }
    determinePath(startAt) {
        let i = startAt;
        let vertex = this.vertices[i], parentVertex = this.vertices[i].getNextParent(), curVertex;
        let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint(), curPoint;
        if (parentVertex !== null && parentVertex.id !== NULL_VERTEX_ID && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
            let foundPointToParent = false, parentBranch = parentVertex.getBranch();
            for (i = startAt + 1; i < this.vertices.length; i++) {
                curVertex = this.vertices[i];
                curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch);
                if (curPoint !== null) {
                    foundPointToParent = true;
                }
                else {
                    curPoint = curVertex.getNextPoint();
                }
                parentBranch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), !foundPointToParent && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true, vertex.hasSyntheticParent());
                curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
                lastPoint = curPoint;
                if (foundPointToParent) {
                    vertex.registerParentProcessed();
                    break;
                }
            }
            if (!foundPointToParent) {
                vertex.registerParentProcessed();
            }
        }
        else {
            let branch = new Branch(this.getAvailableColour(startAt));
            vertex.addToBranch(branch, lastPoint.x);
            vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);
            if (parentVertex === null) {
                branch.setEnd(startAt);
                this.branches.push(branch);
                this.availableColours[branch.getColour()] = startAt;
                return;
            }
            for (i = startAt + 1; i < this.vertices.length; i++) {
                curVertex = this.vertices[i];
                curPoint = parentVertex === curVertex && !parentVertex.isNotOnBranch() ? curVertex.getPoint() : curVertex.getNextPoint();
                branch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), lastPoint.x < curPoint.x, vertex.hasSyntheticParent());
                curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
                lastPoint = curPoint;
                if (parentVertex === curVertex) {
                    vertex.registerParentProcessed();
                    let parentVertexOnBranch = !parentVertex.isNotOnBranch();
                    parentVertex.addToBranch(branch, curPoint.x);
                    vertex = parentVertex;
                    parentVertex = vertex.getNextParent();
                    if (parentVertex === null || parentVertexOnBranch) {
                        break;
                    }
                }
            }
            if (i === this.vertices.length && parentVertex !== null) {
                if (parentVertex.id === NULL_VERTEX_ID && this.pathFilterActive) {
                    const continuationPoint = { x: lastPoint.x, y: this.vertices.length };
                    branch.addLine(lastPoint, continuationPoint, vertex.getIsCommitted(), true, true);
                }
                vertex.registerParentProcessed();
            }
            branch.setEnd(i);
            this.branches.push(branch);
            this.availableColours[branch.getColour()] = i;
        }
    }
    getAvailableColour(startAt) {
        for (let i = 0; i < this.availableColours.length; i++) {
            if (startAt > this.availableColours[i]) {
                return i;
            }
        }
        this.availableColours.push(0);
        return this.availableColours.length - 1;
    }
    vertexOver(event) {
        if (event.target === null)
            return;
        this.closeTooltip();
        const vertexElem = event.target;
        const id = parseInt(vertexElem.dataset.id);
        this.tooltipId = id;
        const commitElem = findCommitElemWithId(getCommitElems(), id);
        if (commitElem !== null)
            commitElem.classList.add(CLASS_GRAPH_VERTEX_ACTIVE);
        if (id < this.commits.length && this.commits[id].hash !== UNCOMMITTED) {
            this.tooltipTimeout = setTimeout(() => {
                this.tooltipTimeout = null;
                let vertexScreenY = vertexElem.getBoundingClientRect().top + 4;
                if (vertexScreenY >= 5 && vertexScreenY <= this.viewElem.clientHeight - 5) {
                    this.tooltipVertex = vertexElem;
                    closeDialogAndContextMenu();
                    this.showTooltip(id, vertexScreenY);
                }
            }, 100);
        }
    }
    vertexOut(event) {
        if (event.target === null)
            return;
        this.closeTooltip();
    }
    showTooltip(id, vertexScreenY) {
        if (this.tooltipVertex !== null) {
            this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '5.5' : '5');
        }
        const children = this.getAllChildren(id);
        let heads = [], remotes = [], stashes = [], tags = [], childrenIncludesHead = false;
        for (let i = 0; i < children.length; i++) {
            let commit = this.commits[children[i]];
            for (let j = 0; j < commit.heads.length; j++)
                heads.push(commit.heads[j]);
            for (let j = 0; j < commit.remotes.length; j++)
                remotes.push(commit.remotes[j]);
            for (let j = 0; j < commit.tags.length; j++)
                tags.push(commit.tags[j].name);
            if (commit.stash !== null)
                stashes.push(commit.stash.selector.substring(5));
            if (commit.hash === this.commitHead)
                childrenIncludesHead = true;
        }
        const getLimitedRefs = (htmlRefs) => {
            if (htmlRefs.length > 10)
                htmlRefs.splice(5, htmlRefs.length - 10, ' ' + ELLIPSIS + ' ');
            return htmlRefs.join('');
        };
        let html = '<div class="graphTooltipTitle">Commit ' + abbrevCommit(this.commits[id].hash) + '</div>';
        if (this.commitHead !== null && typeof this.commitLookup[this.commitHead] === 'number') {
            html += '<div class="graphTooltipSection">This commit is ' + (childrenIncludesHead ? '' : '<b><i>not</i></b> ') + 'included in <span class="graphTooltipRef">HEAD</span></div>';
        }
        if (heads.length > 0 || remotes.length > 0) {
            let branchLabels = getBranchLabels(heads, remotes), htmlRefs = [];
            branchLabels.heads.forEach((head) => {
                let html = head.remotes.reduce((prev, remote) => prev + '<span class="graphTooltipCombinedRef">' + escapeHtml(remote) + '</span>', '');
                htmlRefs.push('<span class="graphTooltipRef">' + escapeHtml(head.name) + html + '</span>');
            });
            branchLabels.remotes.forEach((remote) => htmlRefs.push('<span class="graphTooltipRef">' + escapeHtml(remote.name) + '</span>'));
            html += '<div class="graphTooltipSection">Branches: ' + getLimitedRefs(htmlRefs) + '</div>';
        }
        if (tags.length > 0) {
            let htmlRefs = tags.map((tag) => '<span class="graphTooltipRef">' + escapeHtml(tag) + '</span>');
            html += '<div class="graphTooltipSection">Tags: ' + getLimitedRefs(htmlRefs) + '</div>';
        }
        if (stashes.length > 0) {
            let htmlRefs = stashes.map((stash) => '<span class="graphTooltipRef">' + escapeHtml(stash) + '</span>');
            html += '<div class="graphTooltipSection">Stashes: ' + getLimitedRefs(htmlRefs) + '</div>';
        }
        const point = this.vertices[id].getPoint(), color = 'var(--git-graph-color' + (this.vertices[id].getColour() % this.config.colours.length) + ')';
        const anchor = document.createElement('div'), pointer = document.createElement('div'), content = document.createElement('div'), shadow = document.createElement('div');
        const pixel = {
            x: point.x * this.config.grid.x + this.config.grid.offsetX,
            y: point.y * this.config.grid.y + this.config.grid.offsetY + (this.expandedCommitIndex > -1 && id > this.expandedCommitIndex ? this.config.grid.expandY : 0)
        };
        anchor.setAttribute('id', 'graphTooltip');
        anchor.style.opacity = '0';
        pointer.setAttribute('id', 'graphTooltipPointer');
        pointer.style.backgroundColor = color;
        content.setAttribute('id', 'graphTooltipContent');
        content.style.borderColor = color;
        content.innerHTML = html;
        content.style.maxWidth = Math.min(this.contentElem.getBoundingClientRect().width - pixel.x - 35, 600) + 'px';
        shadow.setAttribute('id', 'graphTooltipShadow');
        anchor.appendChild(shadow);
        anchor.appendChild(pointer);
        anchor.appendChild(content);
        anchor.style.left = pixel.x + 'px';
        anchor.style.top = pixel.y + 'px';
        this.contentElem.appendChild(anchor);
        this.tooltipElem = anchor;
        let tooltipRect = content.getBoundingClientRect();
        let relativeOffset = -tooltipRect.height / 2;
        if (vertexScreenY + relativeOffset + tooltipRect.height > this.viewElem.clientHeight - 4) {
            relativeOffset = (this.viewElem.clientHeight - vertexScreenY - 4) - tooltipRect.height;
        }
        if (vertexScreenY + relativeOffset < 4) {
            relativeOffset = -vertexScreenY + 4;
        }
        pointer.style.top = (-relativeOffset) + 'px';
        anchor.style.top = (pixel.y + relativeOffset) + 'px';
        shadow.style.width = tooltipRect.width + 'px';
        shadow.style.height = tooltipRect.height + 'px';
        anchor.style.opacity = '1';
    }
    closeTooltip() {
        if (this.tooltipId > -1) {
            const commitElem = findCommitElemWithId(getCommitElems(), this.tooltipId);
            if (commitElem !== null)
                commitElem.classList.remove(CLASS_GRAPH_VERTEX_ACTIVE);
            this.tooltipId = -1;
        }
        if (this.tooltipElem !== null) {
            this.tooltipElem.remove();
            this.tooltipElem = null;
        }
        if (this.tooltipTimeout !== null) {
            clearTimeout(this.tooltipTimeout);
            this.tooltipTimeout = null;
        }
        if (this.tooltipVertex !== null) {
            this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '4.5' : '4');
            this.tooltipVertex = null;
        }
    }
}

/* ==== settingsWidget.js ==== */
class SettingsWidget {
    constructor(view) {
        this.currentRepo = null;
        this.repo = null;
        this.config = null;
        this.loading = false;
        this.scrollTop = 0;
        this.view = view;
        this.widgetElem = document.createElement('div');
        this.widgetElem.id = 'settingsWidget';
        this.widgetElem.innerHTML = '<h2>Repository Settings</h2><div id="settingsContent"></div><div id="settingsLoading"></div><div id="settingsClose"></div>';
        document.body.appendChild(this.widgetElem);
        observeElemScroll('settingsWidget', this.scrollTop, (scrollTop) => {
            this.scrollTop = scrollTop;
        }, () => {
            if (this.currentRepo !== null) {
                this.view.saveState();
            }
        });
        this.contentsElem = document.getElementById('settingsContent');
        this.loadingElem = document.getElementById('settingsLoading');
        const settingsClose = document.getElementById('settingsClose');
        settingsClose.innerHTML = SVG_ICONS.close;
        settingsClose.addEventListener('click', () => this.close());
    }
    show(currentRepo, isInitialLoad = true, scrollTop = 0) {
        if (this.currentRepo !== null)
            return;
        this.currentRepo = currentRepo;
        this.scrollTop = scrollTop;
        alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
        this.widgetElem.classList.add(CLASS_ACTIVE);
        this.view.saveState();
        this.refresh();
        if (isInitialLoad) {
            this.view.requestLoadConfig();
        }
    }
    refresh() {
        if (this.currentRepo === null)
            return;
        this.repo = this.view.getRepoState(this.currentRepo);
        this.config = this.view.getRepoConfig();
        this.loading = this.view.isConfigLoading();
        this.render();
    }
    close() {
        if (this.currentRepo === null)
            return;
        this.currentRepo = null;
        this.repo = null;
        this.config = null;
        this.loading = false;
        this.widgetElem.classList.add(CLASS_TRANSITION);
        this.widgetElem.classList.remove(CLASS_ACTIVE);
        this.widgetElem.classList.remove(CLASS_LOADING);
        this.contentsElem.innerHTML = '';
        this.loadingElem.innerHTML = '';
        this.view.saveState();
    }
    getState() {
        return {
            currentRepo: this.currentRepo,
            scrollTop: this.scrollTop
        };
    }
    restoreState(state) {
        if (state.currentRepo === null)
            return;
        this.show(state.currentRepo, false, state.scrollTop);
    }
    isVisible() {
        return this.currentRepo !== null;
    }
    render() {
        var _a, _b, _c, _d;
        if (this.currentRepo !== null && this.repo !== null) {
            const escapedRepoName = escapeHtml(this.repo.name || getRepoName(this.currentRepo));
            const initialBranchesLocallyConfigured = this.repo.onRepoLoadShowCheckedOutBranch !== 0 || this.repo.onRepoLoadShowSpecificBranches !== null;
            const initialBranches = [];
            if (getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch)) {
                initialBranches.push('Checked Out');
            }
            const branchOptions = this.view.getBranchOptions();
            getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches).forEach((branch) => {
                const option = branchOptions.find((option) => option.value === branch);
                if (option) {
                    initialBranches.push(option.name);
                }
            });
            const initialBranchesStr = initialBranches.length > 0
                ? escapeHtml(formatCommaSeparatedList(initialBranches))
                : 'Show All';
            let html = '<div class="settingsSection general"><h3>General</h3>' +
                '<table>' +
                '<tr class="lineAbove"><td class="left">Name:</td><td class="leftWithEllipsis" title="' + escapedRepoName + (this.repo.name === null ? ' (Default Name from the File System)' : '') + '">' + escapedRepoName + '</td><td class="btns right"><div id="editRepoName" title="Edit Name' + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (this.repo.name !== null ? ' <div id="deleteRepoName" title="Delete Name' + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</td></tr>' +
                '<tr class="lineAbove lineBelow"><td class="left">Initial Branches:</td><td class="leftWithEllipsis" title="' + initialBranchesStr + ' (' + (initialBranchesLocallyConfigured ? 'Local' : 'Global') + ')">' + initialBranchesStr + '</td><td class="btns right"><div id="editInitialBranches" title="Edit Initial Branches' + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (initialBranchesLocallyConfigured ? ' <div id="clearInitialBranches" title="Clear Initial Branches' + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</td></tr>' +
                '</table>' +
                '<label id="settingsShowStashes"><input type="checkbox" id="settingsShowStashesCheckbox" tabindex="-1"><span class="customCheckbox"></span>Show Stashes</label><br/>' +
                '<label id="settingsShowTags"><input type="checkbox" id="settingsShowTagsCheckbox" tabindex="-1"><span class="customCheckbox"></span>Show Tags</label><br/>' +
                '<label id="settingsIncludeCommitsMentionedByReflogs"><input type="checkbox" id="settingsIncludeCommitsMentionedByReflogsCheckbox" tabindex="-1"><span class="customCheckbox"></span>Include commits only mentioned by reflogs</label><span class="settingsWidgetInfo" title="Only applies when showing all branches.">' + SVG_ICONS.info + '</span><br/>' +
                '<label id="settingsOnlyFollowFirstParent"><input type="checkbox" id="settingsOnlyFollowFirstParentCheckbox" tabindex="-1"><span class="customCheckbox"></span>Only follow the first parent of commits</label><span class="settingsWidgetInfo" title="Instead of following all parents of commits, only follow the first parent when discovering the commits to load.">' + SVG_ICONS.info + '</span>' +
                '</div>';
            let userNameSet = false, userEmailSet = false;
            if (this.config !== null) {
                html += '<div class="settingsSection centered"><h3>User Details</h3>';
                const userName = this.config.user.name, userEmail = this.config.user.email;
                userNameSet = userName.local !== null || userName.global !== null;
                userEmailSet = userEmail.local !== null || userEmail.global !== null;
                if (userNameSet || userEmailSet) {
                    const escapedUserName = escapeHtml((_b = (_a = userName.local) !== null && _a !== void 0 ? _a : userName.global) !== null && _b !== void 0 ? _b : 'Not Set');
                    const escapedUserEmail = escapeHtml((_d = (_c = userEmail.local) !== null && _c !== void 0 ? _c : userEmail.global) !== null && _d !== void 0 ? _d : 'Not Set');
                    html += '<table>' +
                        '<tr><td class="left">User Name:</td><td class="leftWithEllipsis" title="' + escapedUserName + (userNameSet ? ' (' + (userName.local !== null ? 'Local' : 'Global') + ')' : '') + '">' + escapedUserName + '</td></tr>' +
                        '<tr><td class="left">User Email:</td><td class="leftWithEllipsis" title="' + escapedUserEmail + (userEmailSet ? ' (' + (userEmail.local !== null ? 'Local' : 'Global') + ')' : '') + '">' + escapedUserEmail + '</td></tr>' +
                        '</table>' +
                        '<div class="settingsSectionButtons"><div id="editUserDetails" class="editBtn">' + SVG_ICONS.pencil + 'Edit</div><div id="removeUserDetails" class="removeBtn">' + SVG_ICONS.close + 'Remove</div></div>';
                }
                else {
                    html += '<span>User Details (such as name and email) are used by Git to record the Author and Committer of commit objects.</span>' +
                        '<div class="settingsSectionButtons"><div id="editUserDetails" class="addBtn">' + SVG_ICONS.plus + 'Add User Details</div></div>';
                }
                html += '</div>';
                html += '<div class="settingsSection"><h3>Remote Configuration</h3><table><tr><th>Remote</th><th>URL</th><th>Type</th><th>Action</th></tr>';
                if (this.config.remotes.length > 0) {
                    const hideRemotes = this.repo.hideRemotes;
                    this.config.remotes.forEach((remote, i) => {
                        const hidden = hideRemotes.includes(remote.name);
                        const fetchUrl = escapeHtml(remote.url || 'Not Set'), pushUrl = escapeHtml(remote.pushUrl || remote.url || 'Not Set');
                        html += '<tr class="lineAbove">' +
                            '<td class="left" rowspan="2"><span class="hideRemoteBtn" data-index="' + i + '" title="Click to ' + (hidden ? 'show' : 'hide') + ' branches of this remote.">' + (hidden ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen) + '</span>' + escapeHtml(remote.name) + '</td>' +
                            '<td class="leftWithEllipsis" title="Fetch URL: ' + fetchUrl + '">' + fetchUrl + '</td><td>Fetch</td>' +
                            '<td class="btns remoteBtns" rowspan="2" data-index="' + i + '"><div class="fetchRemote" title="Fetch from Remote' + ELLIPSIS + '">' + SVG_ICONS.download + '</div> <div class="pruneRemote" title="Prune Remote' + ELLIPSIS + '">' + SVG_ICONS.branch + '</div><br><div class="editRemote" title="Edit Remote' + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div> <div class="deleteRemote" title="Delete Remote' + ELLIPSIS + '">' + SVG_ICONS.close + '</div></td>' +
                            '</tr><tr><td class="leftWithEllipsis" title="Push URL: ' + pushUrl + '">' + pushUrl + '</td><td>Push</td></tr>';
                    });
                }
                else {
                    html += '<tr class="lineAbove"><td colspan="4">There are no remotes configured for this repository.</td></tr>';
                }
                html += '</table><div class="settingsSectionButtons lineAbove"><div id="settingsAddRemote" class="addBtn">' + SVG_ICONS.plus + 'Add Remote</div></div></div>';
            }
            html += '<div class="settingsSection centered"><h3>Issue Linking</h3>';
            const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
            if (issueLinkingConfig !== null) {
                const escapedIssue = escapeHtml(issueLinkingConfig.issue), escapedUrl = escapeHtml(issueLinkingConfig.url);
                html += '<table><tr><td class="left">Issue Regex:</td><td class="leftWithEllipsis" title="' + escapedIssue + '">' + escapedIssue + '</td></tr><tr><td class="left">Issue URL:</td><td class="leftWithEllipsis" title="' + escapedUrl + '">' + escapedUrl + '</td></tr></table>' +
                    '<div class="settingsSectionButtons"><div id="editIssueLinking" class="editBtn">' + SVG_ICONS.pencil + 'Edit</div><div id="removeIssueLinking" class="removeBtn">' + SVG_ICONS.close + 'Remove</div></div>';
            }
            else {
                html += '<span>Issue Linking converts issue numbers in commit &amp; tag messages into hyperlinks, that open the issue in your issue tracking system. If a branch\'s name contains an issue number, the issue can be viewed via the branch\'s context menu.</span>' +
                    '<div class="settingsSectionButtons"><div id="editIssueLinking" class="addBtn">' + SVG_ICONS.plus + 'Add Issue Linking</div></div>';
            }
            html += '</div>';
            if (this.config !== null) {
                html += '<div class="settingsSection centered"><h3>Pull Request Creation</h3>';
                const pullRequestConfig = this.repo.pullRequestConfig;
                if (pullRequestConfig !== null) {
                    const provider = escapeHtml((pullRequestConfig.provider === 0
                        ? 'Bitbucket'
                        : pullRequestConfig.provider === 1
                            ? pullRequestConfig.custom.name
                            : pullRequestConfig.provider === 2
                                ? 'GitHub'
                                : 'GitLab') + ' (' + pullRequestConfig.hostRootUrl + ')');
                    const source = escapeHtml(pullRequestConfig.sourceOwner + '/' + pullRequestConfig.sourceRepo + ' (' + pullRequestConfig.sourceRemote + ')');
                    const destination = escapeHtml(pullRequestConfig.destOwner + '/' + pullRequestConfig.destRepo + (pullRequestConfig.destRemote !== null ? ' (' + pullRequestConfig.destRemote + ')' : ''));
                    const destinationBranch = escapeHtml(pullRequestConfig.destBranch);
                    html += '<table><tr><td class="left">Provider:</td><td class="leftWithEllipsis" title="' + provider + '">' + provider + '</td></tr>' +
                        '<tr><td class="left">Source Repo:</td><td class="leftWithEllipsis" title="' + source + '">' + source + '</td></tr>' +
                        '<tr><td class="left">Destination Repo:</td><td class="leftWithEllipsis" title="' + destination + '">' + destination + '</td></tr>' +
                        '<tr><td class="left">Destination Branch:</td><td class="leftWithEllipsis" title="' + destinationBranch + '">' + destinationBranch + '</td></tr></table>' +
                        '<div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="editBtn">' + SVG_ICONS.pencil + 'Edit</div><div id="removePullRequestIntegration" class="removeBtn">' + SVG_ICONS.close + 'Remove</div></div>';
                }
                else {
                    html += '<span>Pull Request Creation automates the opening and pre-filling of a Pull Request form, directly from a branch\'s context menu.</span>' +
                        '<div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="addBtn">' + SVG_ICONS.plus + 'Configure "Pull Request Creation" Integration</div></div>';
                }
                html += '</div>';
            }
            html += '<div class="settingsSection"><h3>Git Graph Configuration</h3><div class="settingsSectionButtons">' +
                '<div id="openExtensionSettings">' + SVG_ICONS.gear + 'Open Git Graph Extension Settings</div><br/>' +
                '<div id="exportRepositoryConfig">' + SVG_ICONS.package + 'Export Repository Configuration</div>' +
                '</div></div>';
            this.contentsElem.innerHTML = html;
            document.getElementById('editRepoName').addEventListener('click', () => {
                if (this.currentRepo === null || this.repo === null)
                    return;
                dialog.showForm('Specify a Name for this Repository:', [
                    { type: 0, name: 'Name', default: this.repo.name || '', placeholder: getRepoName(this.currentRepo) }
                ], 'Save Name', (values) => {
                    if (this.currentRepo === null)
                        return;
                    this.view.saveRepoStateValue(this.currentRepo, 'name', values[0] || null);
                    this.view.renderRepoDropdownOptions();
                    this.render();
                }, null);
            });
            if (this.repo.name !== null) {
                document.getElementById('deleteRepoName').addEventListener('click', () => {
                    if (this.currentRepo === null || this.repo === null || this.repo.name === null)
                        return;
                    dialog.showConfirmation('Are you sure you want to delete the manually configured name <b><i>' + escapeHtml(this.repo.name) + '</i></b> for this repository, and use the default name from the File System <b><i>' + escapeHtml(getRepoName(this.currentRepo)) + '</i></b>?', 'Yes, delete', () => {
                        if (this.currentRepo === null)
                            return;
                        this.view.saveRepoStateValue(this.currentRepo, 'name', null);
                        this.view.renderRepoDropdownOptions();
                        this.render();
                    }, null);
                });
            }
            document.getElementById('editInitialBranches').addEventListener('click', () => {
                if (this.repo === null)
                    return;
                const showCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch);
                const showSpecificBranches = getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches);
                dialog.showForm('<b>Configure Initial Branches</b><p style="margin:6px 0;">Configure the branches that are initially shown when this repository is loaded in the Git Graph View.</p><p style="font-size:12px; margin:6px 0 0 0;">Note: When "Checked Out Branch" is Disabled, and no "Specific Branches" are selected, all branches will be shown.</p>', [
                    { type: 4, name: 'Checked Out Branch', value: showCheckedOutBranch },
                    { type: 2, name: 'Specific Branches', options: this.view.getBranchOptions(), defaults: showSpecificBranches, multiple: true }
                ], 'Save Configuration', (values) => {
                    if (this.currentRepo === null)
                        return;
                    if (showCheckedOutBranch !== values[0] || !arraysStrictlyEqualIgnoringOrder(showSpecificBranches, values[1])) {
                        this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', values[0] ? 1 : 2);
                        this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', values[1]);
                        this.render();
                    }
                }, null, 'Cancel', null, false);
            });
            if (initialBranchesLocallyConfigured) {
                document.getElementById('clearInitialBranches').addEventListener('click', () => {
                    dialog.showConfirmation('Are you sure you want to clear the branches that are initially shown when this repository is loaded in the Git Graph View?', 'Yes, clear', () => {
                        if (this.currentRepo === null)
                            return;
                        this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', 0);
                        this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', null);
                        this.render();
                    }, null);
                });
            }
            const showStashesElem = document.getElementById('settingsShowStashesCheckbox');
            showStashesElem.checked = getShowStashes(this.repo.showStashes);
            showStashesElem.addEventListener('change', () => {
                if (this.currentRepo === null)
                    return;
                const elem = document.getElementById('settingsShowStashesCheckbox');
                if (elem === null)
                    return;
                this.view.saveRepoStateValue(this.currentRepo, 'showStashes', elem.checked ? 1 : 2);
                this.view.refresh(true);
            });
            const showTagsElem = document.getElementById('settingsShowTagsCheckbox');
            showTagsElem.checked = getShowTags(this.repo.showTags);
            showTagsElem.addEventListener('change', () => {
                if (this.currentRepo === null)
                    return;
                const elem = document.getElementById('settingsShowTagsCheckbox');
                if (elem === null)
                    return;
                this.view.saveRepoStateValue(this.currentRepo, 'showTags', elem.checked ? 1 : 2);
                this.view.refresh(true);
            });
            const includeCommitsMentionedByReflogsElem = document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
            includeCommitsMentionedByReflogsElem.checked = getIncludeCommitsMentionedByReflogs(this.repo.includeCommitsMentionedByReflogs);
            includeCommitsMentionedByReflogsElem.addEventListener('change', () => {
                if (this.currentRepo === null)
                    return;
                const elem = document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
                if (elem === null)
                    return;
                this.view.saveRepoStateValue(this.currentRepo, 'includeCommitsMentionedByReflogs', elem.checked ? 1 : 2);
                this.view.refresh(true);
            });
            const settingsOnlyFollowFirstParentElem = document.getElementById('settingsOnlyFollowFirstParentCheckbox');
            settingsOnlyFollowFirstParentElem.checked = getOnlyFollowFirstParent(this.repo.onlyFollowFirstParent);
            settingsOnlyFollowFirstParentElem.addEventListener('change', () => {
                if (this.currentRepo === null)
                    return;
                const elem = document.getElementById('settingsOnlyFollowFirstParentCheckbox');
                if (elem === null)
                    return;
                this.view.saveRepoStateValue(this.currentRepo, 'onlyFollowFirstParent', elem.checked ? 1 : 2);
                this.view.refresh(true);
            });
            if (this.config !== null) {
                document.getElementById('editUserDetails').addEventListener('click', () => {
                    var _a, _b, _c, _d;
                    if (this.config === null)
                        return;
                    const userName = this.config.user.name, userEmail = this.config.user.email;
                    dialog.showForm('Set the user name and email used by Git to record the Author and Committer of commit objects:', [
                        { type: 0, name: 'User Name', default: (_b = (_a = userName.local) !== null && _a !== void 0 ? _a : userName.global) !== null && _b !== void 0 ? _b : '', placeholder: null },
                        { type: 0, name: 'User Email', default: (_d = (_c = userEmail.local) !== null && _c !== void 0 ? _c : userEmail.global) !== null && _d !== void 0 ? _d : '', placeholder: null },
                        { type: 4, name: 'Use Globally', value: userName.local === null && userEmail.local === null, info: 'Use the "User Name" and "User Email" globally for all Git repositories (it can be overridden per repository).' }
                    ], 'Set User Details', (values) => {
                        if (this.currentRepo === null)
                            return;
                        const useGlobally = values[2];
                        runAction({
                            command: 'editUserDetails',
                            repo: this.currentRepo,
                            name: values[0],
                            email: values[1],
                            location: useGlobally ? "global" : "local",
                            deleteLocalName: useGlobally && userName.local !== null,
                            deleteLocalEmail: useGlobally && userEmail.local !== null
                        }, 'Setting User Details');
                    }, null);
                });
                if (userNameSet || userEmailSet) {
                    document.getElementById('removeUserDetails').addEventListener('click', () => {
                        if (this.config === null)
                            return;
                        const userName = this.config.user.name, userEmail = this.config.user.email;
                        const isGlobal = userName.local === null && userEmail.local === null;
                        dialog.showConfirmation('Are you sure you want to remove the <b>' + (isGlobal ? 'globally' : 'locally') + ' configured</b> user name and email, which are used by Git to record the Author and Committer of commit objects?', 'Yes, remove', () => {
                            if (this.currentRepo === null)
                                return;
                            runAction({
                                command: 'deleteUserDetails',
                                repo: this.currentRepo,
                                name: (isGlobal ? userName.global : userName.local) !== null,
                                email: (isGlobal ? userEmail.global : userEmail.local) !== null,
                                location: isGlobal ? "global" : "local"
                            }, 'Removing User Details');
                        }, null);
                    });
                }
                const pushUrlPlaceholder = 'Leave blank to use the Fetch URL';
                document.getElementById('settingsAddRemote').addEventListener('click', () => {
                    dialog.showForm('Add a new remote to this repository:', [
                        { type: 0, name: 'Name', default: '', placeholder: null },
                        { type: 0, name: 'Fetch URL', default: '', placeholder: null },
                        { type: 0, name: 'Push URL', default: '', placeholder: pushUrlPlaceholder },
                        { type: 4, name: 'Fetch Immediately', value: true }
                    ], 'Add Remote', (values) => {
                        if (this.currentRepo === null)
                            return;
                        runAction({ command: 'addRemote', repo: this.currentRepo, name: values[0], url: values[1], pushUrl: values[2] !== '' ? values[2] : null, fetch: values[3] }, 'Adding Remote');
                    }, { type: "repo" });
                });
                addListenerToClass('editRemote', 'click', (e) => {
                    const remote = this.getRemoteForBtnEvent(e);
                    if (remote === null)
                        return;
                    dialog.showForm('Edit the remote <b><i>' + escapeHtml(remote.name) + '</i></b>:', [
                        { type: 0, name: 'Name', default: remote.name, placeholder: null },
                        { type: 0, name: 'Fetch URL', default: remote.url !== null ? remote.url : '', placeholder: null },
                        { type: 0, name: 'Push URL', default: remote.pushUrl !== null ? remote.pushUrl : '', placeholder: pushUrlPlaceholder }
                    ], 'Save Changes', (values) => {
                        if (this.currentRepo === null)
                            return;
                        runAction({ command: 'editRemote', repo: this.currentRepo, nameOld: remote.name, nameNew: values[0], urlOld: remote.url, urlNew: values[1] !== '' ? values[1] : null, pushUrlOld: remote.pushUrl, pushUrlNew: values[2] !== '' ? values[2] : null }, 'Saving Changes to Remote');
                    }, { type: "repo" });
                });
                addListenerToClass('deleteRemote', 'click', (e) => {
                    const remote = this.getRemoteForBtnEvent(e);
                    if (remote === null)
                        return;
                    dialog.showConfirmation('Are you sure you want to delete the remote <b><i>' + escapeHtml(remote.name) + '</i></b>?', 'Yes, delete', () => {
                        if (this.currentRepo === null)
                            return;
                        runAction({ command: 'deleteRemote', repo: this.currentRepo, name: remote.name }, 'Deleting Remote');
                    }, { type: "repo" });
                });
                addListenerToClass('fetchRemote', 'click', (e) => {
                    const remote = this.getRemoteForBtnEvent(e);
                    if (remote === null)
                        return;
                    dialog.showForm('Are you sure you want to fetch from the remote <b><i>' + escapeHtml(remote.name) + '</i></b>?', [
                        { type: 4, name: 'Prune', value: initialState.config.dialogDefaults.fetchRemote.prune, info: 'Before fetching, remove any remote-tracking references that no longer exist on the remote.' },
                        { type: 4, name: 'Prune Tags', value: initialState.config.dialogDefaults.fetchRemote.pruneTags, info: 'Before fetching, remove any local tags that no longer exist on the remote. Requires Git >= 2.17.0, and "Prune" to be enabled.' }
                    ], 'Yes, fetch', (values) => {
                        if (this.currentRepo === null)
                            return;
                        runAction({ command: 'fetch', repo: this.currentRepo, name: remote.name, prune: values[0], pruneTags: values[1] }, 'Fetching from Remote');
                    }, { type: "repo" });
                });
                addListenerToClass('pruneRemote', 'click', (e) => {
                    const remote = this.getRemoteForBtnEvent(e);
                    if (remote === null)
                        return;
                    dialog.showConfirmation('Are you sure you want to prune remote-tracking references that no longer exist on the remote <b><i>' + escapeHtml(remote.name) + '</i></b>?', 'Yes, prune', () => {
                        if (this.currentRepo === null)
                            return;
                        runAction({ command: 'pruneRemote', repo: this.currentRepo, name: remote.name }, 'Pruning Remote');
                    }, { type: "repo" });
                });
                addListenerToClass('hideRemoteBtn', 'click', (e) => {
                    if (this.currentRepo === null || this.repo === null || this.config === null)
                        return;
                    const source = e.target.closest('.hideRemoteBtn');
                    const remote = this.config.remotes[parseInt(source.dataset.index)].name;
                    const hideRemote = !this.repo.hideRemotes.includes(remote);
                    source.title = 'Click to ' + (hideRemote ? 'show' : 'hide') + ' branches of this remote.';
                    source.innerHTML = hideRemote ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen;
                    if (hideRemote) {
                        this.repo.hideRemotes.push(remote);
                    }
                    else {
                        this.repo.hideRemotes.splice(this.repo.hideRemotes.indexOf(remote), 1);
                    }
                    this.view.saveRepoStateValue(this.currentRepo, 'hideRemotes', this.repo.hideRemotes);
                    this.view.refresh(true);
                });
            }
            document.getElementById('editIssueLinking').addEventListener('click', () => {
                if (this.repo === null)
                    return;
                const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
                if (issueLinkingConfig !== null) {
                    this.showIssueLinkingDialog(issueLinkingConfig.issue, issueLinkingConfig.url, this.repo.issueLinkingConfig === null && globalState.issueLinkingConfig !== null, true);
                }
                else {
                    this.showIssueLinkingDialog(null, null, false, false);
                }
            });
            if (this.repo.issueLinkingConfig !== null || globalState.issueLinkingConfig !== null) {
                document.getElementById('removeIssueLinking').addEventListener('click', () => {
                    if (this.repo === null)
                        return;
                    const locallyConfigured = this.repo.issueLinkingConfig !== null;
                    dialog.showConfirmation('Are you sure you want to remove ' + (locallyConfigured ? (globalState.issueLinkingConfig !== null ? 'the <b>locally configured</b> ' : '') + 'Issue Linking from this repository' : 'the <b>globally configured</b> Issue Linking in Git Graph') + '?', 'Yes, remove', () => {
                        this.setIssueLinkingConfig(null, !locallyConfigured);
                    }, null);
                });
            }
            if (this.config !== null) {
                document.getElementById('editPullRequestIntegration').addEventListener('click', () => {
                    if (this.repo === null || this.config === null)
                        return;
                    if (this.config.remotes.length === 0) {
                        dialog.showError('Unable to configure the "Pull Request Creation" Integration', 'The repository must have at least one remote to configure the "Pull Request Creation" Integration. There are no remotes in the current repository.', null, null);
                        return;
                    }
                    let config;
                    if (this.repo.pullRequestConfig === null) {
                        let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
                        let sourceRemoteUrl = this.config.remotes[originIndex > -1 ? originIndex : 0].url;
                        let provider;
                        if (sourceRemoteUrl !== null) {
                            if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*github/) !== null) {
                                provider = 2;
                            }
                            else if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*gitlab/) !== null) {
                                provider = 3;
                            }
                            else {
                                provider = 0;
                            }
                        }
                        else {
                            provider = 0;
                        }
                        config = {
                            provider: provider, hostRootUrl: '',
                            sourceRemote: '', sourceOwner: '', sourceRepo: '',
                            destRemote: '', destOwner: '', destRepo: '', destProjectId: '', destBranch: '',
                            custom: null
                        };
                    }
                    else {
                        config = Object.assign({}, this.repo.pullRequestConfig);
                    }
                    this.showCreatePullRequestIntegrationDialog1(config);
                });
                if (this.repo.pullRequestConfig !== null) {
                    document.getElementById('removePullRequestIntegration').addEventListener('click', () => {
                        dialog.showConfirmation('Are you sure you want to remove the configured "Pull Request Creation" Integration?', 'Yes, remove', () => {
                            this.setPullRequestConfig(null);
                        }, null);
                    });
                }
            }
            document.getElementById('openExtensionSettings').addEventListener('click', () => {
                sendMessage({ command: 'openExtensionSettings' });
            });
            document.getElementById('exportRepositoryConfig').addEventListener('click', () => {
                dialog.showConfirmation('Exporting the Git Graph Repository Configuration will generate a file that can be committed in this repository. It allows others working in this repository to use the same configuration.', 'Yes, export', () => {
                    if (this.currentRepo === null)
                        return;
                    runAction({ command: 'exportRepoConfig', repo: this.currentRepo }, 'Exporting Repository Configuration');
                }, null);
            });
        }
        alterClass(this.widgetElem, CLASS_LOADING, this.loading);
        this.loadingElem.innerHTML = this.loading ? '<span>' + SVG_ICONS.loading + 'Loading ...</span>' : '';
        this.widgetElem.scrollTop = this.scrollTop;
        this.loadingElem.style.top = (this.scrollTop + (this.widgetElem.clientHeight / 2) - 12) + 'px';
    }
    setIssueLinkingConfig(config, global) {
        if (this.currentRepo === null || this.repo === null)
            return;
        if (global) {
            if (this.repo.issueLinkingConfig !== null) {
                this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', null);
            }
            updateGlobalViewState('issueLinkingConfig', config);
        }
        else {
            this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', config);
        }
        this.view.refresh(true);
        this.render();
    }
    setPullRequestConfig(config) {
        if (this.currentRepo === null)
            return;
        this.view.saveRepoStateValue(this.currentRepo, 'pullRequestConfig', config);
        this.render();
    }
    showIssueLinkingDialog(defaultIssueRegex, defaultIssueUrl, defaultUseGlobally, isEdit) {
        let html = '<b>' + (isEdit ? 'Edit Issue Linking for' : 'Add Issue Linking to') + ' this Repository</b>';
        html += '<p style="font-size:12px; margin:6px 0;">The following example links <b>#123</b> in commit messages to <b>https://github.com/mhutchie/repo/issues/123</b>:</p>';
        html += '<table style="display:inline-table; width:360px; text-align:left; font-size:12px; margin-bottom:2px;"><tr><td>Issue Regex:</td><td>#(\\d+)</td></tr><tr><td>Issue URL:</td><td>https://github.com/mhutchie/repo/issues/$1</td></tr></tbody></table>';
        if (!isEdit && defaultIssueRegex === null && defaultIssueUrl === null) {
            defaultIssueRegex = SettingsWidget.autoDetectIssueRegex(this.view.getCommits());
            if (defaultIssueRegex !== null) {
                html += '<p style="font-size:12px"><i>The prefilled Issue Regex was detected in commit messages in this repository. Review and/or correct it if necessary.</i></p>';
            }
        }
        dialog.showForm(html, [
            { type: 0, name: 'Issue Regex', default: defaultIssueRegex !== null ? defaultIssueRegex : '', placeholder: null, info: 'A regular expression that matches your issue numbers, with one or more capturing groups ( ) that will be substituted into the "Issue URL".' },
            { type: 0, name: 'Issue URL', default: defaultIssueUrl !== null ? defaultIssueUrl : '', placeholder: null, info: 'The issue\'s URL in your issue tracking system, with placeholders ($1, $2, etc.) for the groups captured ( ) in the "Issue Regex".' },
            { type: 4, name: 'Use Globally', value: defaultUseGlobally, info: 'Use the "Issue Regex" and "Issue URL" for all repositories by default (it can be overridden per repository). Note: "Use Globally" is only suitable if identical Issue Linking applies to the majority of your repositories (e.g. when using JIRA or Pivotal Tracker).' }
        ], 'Save', (values) => {
            let issueRegex = values[0].trim(), issueUrl = values[1].trim(), useGlobally = values[2];
            let regExpParseError = null;
            try {
                if (issueRegex.indexOf('(') === -1 || issueRegex.indexOf(')') === -1) {
                    regExpParseError = 'The regular expression does not contain a capturing group ( ).';
                }
                else if (new RegExp(issueRegex, 'gu')) {
                    regExpParseError = null;
                }
            }
            catch (e) {
                regExpParseError = e.message;
            }
            if (regExpParseError !== null) {
                dialog.showError('Invalid Issue Regex', regExpParseError, 'Go Back', () => {
                    this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
                });
            }
            else if (!(/\$([1-9][0-9]*)/.test(issueUrl))) {
                dialog.showError('Invalid Issue URL', 'The Issue URL does not contain any placeholders ($1, $2, etc.) for the issue number components captured in the Issue Regex.', 'Go Back', () => {
                    this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
                });
            }
            else {
                this.setIssueLinkingConfig({ issue: issueRegex, url: issueUrl }, useGlobally);
            }
        }, null, 'Cancel', null, false);
    }
    showCreatePullRequestIntegrationDialog1(config) {
        if (this.config === null)
            return;
        let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
        let upstreamIndex = this.config.remotes.findIndex((remote) => remote.name === 'upstream');
        let sourceRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.sourceRemote);
        let destRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.destRemote);
        if (config.sourceRemote === '' || sourceRemoteIndex === -1) {
            sourceRemoteIndex = originIndex > -1 ? originIndex : 0;
        }
        if (config.destRemote === '') {
            destRemoteIndex = upstreamIndex > -1 ? upstreamIndex : originIndex > -1 ? originIndex : 0;
        }
        let defaultProvider = config.provider.toString();
        let providerOptions = [
            { name: 'Bitbucket', value: (0).toString() },
            { name: 'GitHub', value: (2).toString() },
            { name: 'GitLab', value: (3).toString() }
        ];
        let providerTemplateLookup = {};
        initialState.config.customPullRequestProviders.forEach((provider) => {
            providerOptions.push({ name: provider.name, value: (providerOptions.length + 1).toString() });
            providerTemplateLookup[provider.name] = provider.templateUrl;
        });
        if (config.provider === 1) {
            if (!providerOptions.some((provider) => provider.name === config.custom.name)) {
                providerOptions.push({ name: config.custom.name, value: (providerOptions.length + 1).toString() });
                providerTemplateLookup[config.custom.name] = config.custom.templateUrl;
            }
            defaultProvider = providerOptions.find((provider) => provider.name === config.custom.name).value;
        }
        providerOptions.sort((a, b) => a.name.localeCompare(b.name));
        let sourceRemoteOptions = this.config.remotes.map((remote, index) => ({ name: remote.name, value: index.toString() }));
        let destRemoteOptions = sourceRemoteOptions.map((option) => option);
        destRemoteOptions.push({ name: 'Not a remote', value: '-1' });
        dialog.showForm('Configure "Pull Request Creation" Integration (Step&nbsp;1/2)', [
            {
                type: 2, name: 'Provider',
                options: providerOptions, default: defaultProvider,
                info: 'In addition to the built-in publicly hosted Pull Request providers, custom providers can be configured using the Extension Setting "git-graph.customPullRequestProviders" (e.g. for use with privately hosted Pull Request providers).'
            },
            {
                type: 2, name: 'Source Remote',
                options: sourceRemoteOptions, default: sourceRemoteIndex.toString(),
                info: 'The remote that corresponds to the source of the Pull Request.'
            },
            {
                type: 2, name: 'Destination Remote',
                options: destRemoteOptions, default: destRemoteIndex.toString(),
                info: 'The remote that corresponds to the destination / target of the Pull Request.'
            }
        ], 'Next', (values) => {
            if (this.config === null)
                return;
            let newProvider = parseInt(values[0]);
            if (newProvider > 3)
                newProvider = 1;
            const newSourceRemoteIndex = parseInt(values[1]);
            const newDestRemoteIndex = parseInt(values[2]);
            const newSourceRemote = this.config.remotes[newSourceRemoteIndex].name;
            const newDestRemote = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].name : null;
            const newSourceUrl = this.config.remotes[newSourceRemoteIndex].url;
            const newDestUrl = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].url : null;
            if (config.hostRootUrl === '' || config.provider !== newProvider) {
                const remoteUrlForHost = newSourceUrl !== null ? newSourceUrl : newDestUrl;
                if (remoteUrlForHost !== null) {
                    const match = remoteUrlForHost.match(/^(https?:\/\/|git@)((?=[^/]+@)[^@]+@|(?![^/]+@))([^/:]+)/);
                    config.hostRootUrl = match !== null ? 'https://' + match[3] : '';
                }
                else {
                    config.hostRootUrl = '';
                }
            }
            if (newProvider === 1) {
                const customProviderName = providerOptions.find((provider) => provider.value === values[0]).name;
                config.custom = { name: customProviderName, templateUrl: providerTemplateLookup[customProviderName] };
            }
            else {
                config.custom = null;
            }
            config.provider = newProvider;
            if (config.sourceRemote !== newSourceRemote) {
                config.sourceRemote = newSourceRemote;
                const match = newSourceUrl !== null ? newSourceUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
                config.sourceOwner = match !== null ? match[2] : '';
                config.sourceRepo = match !== null ? match[3] : '';
            }
            if (config.provider !== 3 || config.destRemote !== newDestRemote) {
                config.destProjectId = '';
            }
            if (config.destRemote !== newDestRemote) {
                config.destRemote = newDestRemote;
                if (newDestRemote !== null) {
                    const match = newDestUrl !== null ? newDestUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
                    config.destOwner = match !== null ? match[2] : '';
                    config.destRepo = match !== null ? match[3] : '';
                    const branches = this.view.getBranches()
                        .filter((branch) => branch.startsWith('remotes/' + newDestRemote + '/') && branch !== ('remotes/' + newDestRemote + '/HEAD'))
                        .map((branch) => branch.substring(newDestRemote.length + 9));
                    config.destBranch = branches.length > 0 ? branches.includes('master') ? 'master' : branches[0] : '';
                }
                else {
                    config.destOwner = '';
                    config.destRepo = '';
                    config.destBranch = '';
                }
            }
            this.showCreatePullRequestIntegrationDialog2(config);
        }, { type: "repo" });
    }
    showCreatePullRequestIntegrationDialog2(config) {
        if (this.config === null)
            return;
        const destBranches = config.destRemote !== null
            ? this.view.getBranches()
                .filter((branch) => branch.startsWith('remotes/' + config.destRemote + '/') && branch !== ('remotes/' + config.destRemote + '/HEAD'))
                .map((branch) => branch.substring(config.destRemote.length + 9))
            : [];
        const destBranchInfo = 'The name of the branch that is the destination / target of the Pull Request.';
        const updateConfigWithFormValues = (values) => {
            const hostRootUri = values[0];
            config.hostRootUrl = hostRootUri.endsWith('/') ? hostRootUri.substring(0, hostRootUri.length - 1) : hostRootUri;
            config.sourceOwner = values[1];
            config.sourceRepo = values[2];
            config.destOwner = values[3];
            config.destRepo = values[4];
            config.destProjectId = config.provider === 3 ? values[5] : '';
            const destBranch = values[config.provider === 3 ? 6 : 5];
            config.destBranch = config.destRemote === null || destBranches.length === 0
                ? destBranch
                : destBranches[parseInt(destBranch)];
        };
        const inputs = [
            { type: 0, name: 'Host Root URL', default: config.hostRootUrl, placeholder: null, info: 'The Pull Request provider\'s Host Root URL (e.g. https://github.com).' },
            { type: 0, name: 'Source Owner', default: config.sourceOwner, placeholder: null, info: 'The owner of the repository that is the source of the Pull Request.' },
            { type: 0, name: 'Source Repo', default: config.sourceRepo, placeholder: null, info: 'The name of the repository that is the source of the Pull Request.' },
            { type: 0, name: 'Destination Owner', default: config.destOwner, placeholder: null, info: 'The owner of the repository that is the destination / target of the Pull Request.' },
            { type: 0, name: 'Destination Repo', default: config.destRepo, placeholder: null, info: 'The name of the repository that is the destination / target of the Pull Request.' }
        ];
        if (config.provider === 3) {
            inputs.push({ type: 0, name: 'Destination Project ID', default: config.destProjectId, placeholder: null, info: 'The GitLab Project ID of the destination / target of the Pull Request. Leave this field blank to use the default destination / target configured in GitLab.' });
        }
        inputs.push(config.destRemote === null || destBranches.length === 0
            ? { type: 0, name: 'Destination Branch', default: config.destBranch, placeholder: null, info: destBranchInfo }
            : {
                type: 2,
                name: 'Destination Branch',
                options: destBranches.map((branch, index) => ({ name: branch, value: index.toString() })),
                default: destBranches.includes(config.destBranch) ? destBranches.indexOf(config.destBranch).toString() : '0',
                info: destBranchInfo
            });
        dialog.showForm('Configure "Pull Request Creation" Integration (Step&nbsp;2/2)', inputs, 'Save Configuration', (values) => {
            updateConfigWithFormValues(values);
            this.setPullRequestConfig(config);
        }, { type: "repo" }, 'Back', (values) => {
            updateConfigWithFormValues(values);
            this.showCreatePullRequestIntegrationDialog1(config);
        });
    }
    getRemoteForBtnEvent(e) {
        return this.config !== null
            ? this.config.remotes[parseInt(e.target.closest('.remoteBtns').dataset.index)]
            : null;
    }
    static autoDetectIssueRegex(commits) {
        const patterns = ['#(\\d+)', '^(\\d+)\\.(?=\\s|$)', '^(\\d+):(?=\\s|$)', '([A-Za-z]+-\\d+)'].map((pattern) => {
            const regexp = new RegExp(pattern);
            return {
                pattern: pattern,
                matches: commits.filter((commit) => regexp.test(commit.message)).length
            };
        }).sort((a, b) => b.matches - a.matches);
        if (patterns[0].matches > 0.1 * commits.length) {
            return patterns[0].pattern;
        }
        return null;
    }
}

/* ==== textFormatter.js ==== */
const CLASS_EXTERNAL_URL = 'externalUrl';
const CLASS_INTERNAL_URL = 'internalUrl';
class TextFormatter {
    constructor(commits, repoIssueLinkingConfig, config) {
        this.issueLinking = null;
        this.config = Object.assign({ commits: false, emoji: false, issueLinking: false, markdown: false, multiline: false, urls: false }, config);
        this.commits = commits;
        const issueLinkingConfig = repoIssueLinkingConfig !== null
            ? repoIssueLinkingConfig
            : globalState.issueLinkingConfig;
        if (this.config.issueLinking) {
            this.issueLinking = parseIssueLinkingConfig(issueLinkingConfig);
        }
    }
    format(input) {
        if (this.config.multiline) {
            let html = [], lines = input.split('\n'), i, j, match;
            for (i = 0; i < lines.length; i++) {
                if (i > 0) {
                    html.push('<br/>');
                }
                j = 0;
                if (match = lines[i].match(TextFormatter.INDENT_REGEXP)) {
                    for (j = 0; j < match[0].length; j++) {
                        html.push(match[0][j] === '\t' ? '&nbsp;&nbsp;&nbsp;&nbsp;' : '&nbsp;');
                    }
                }
                html.push(this.formatLine(j > 0 ? lines[i].substring(j) : lines[i]));
            }
            return html.join('');
        }
        else {
            return this.formatLine(input);
        }
    }
    formatLine(input) {
        const tree = {
            type: 7,
            start: -1,
            end: input.length,
            contains: []
        };
        let match;
        if (this.config.markdown) {
            const backTickStack = [];
            TextFormatter.BACKTICK_REGEXP.lastIndex = 0;
            while (match = TextFormatter.BACKTICK_REGEXP.exec(input)) {
                let backtick = { index: match.index + match[1].length, run: match[2] }, i;
                if (backTickStack.length === 0) {
                    if (match[1].length % 2 === 1) {
                        if (backtick.run.length > 1) {
                            backtick.index++;
                            backtick.run = backtick.run.substring(1);
                        }
                        else {
                            continue;
                        }
                    }
                }
                for (i = backTickStack.length - 1; i >= 0; i--) {
                    if (backTickStack[i].run === backtick.run) {
                        let value = input.substring(backTickStack[i].index + backtick.run.length, backtick.index);
                        if (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value)) {
                            value = value.substring(1, value.length - 1);
                        }
                        TextFormatter.insertIntoTree(tree, {
                            type: 1,
                            start: backTickStack[i].index,
                            end: backtick.index + backtick.run.length - 1,
                            value: value,
                            contains: []
                        });
                        backTickStack.splice(i);
                        break;
                    }
                }
                if (i === -1) {
                    backTickStack.push(backtick);
                }
            }
        }
        if (this.config.urls) {
            TextFormatter.URL_REGEXP.lastIndex = 0;
            while (match = TextFormatter.URL_REGEXP.exec(input)) {
                let url = match[0];
                const suffix = url.substring(url.length - 1);
                if (match.index > 0 && typeof TextFormatter.ENCLOSING_GROUPS[suffix] === 'string' && input.substring(match.index - 1, match.index) === TextFormatter.ENCLOSING_GROUPS[suffix]) {
                    url = url.substring(0, url.length - 1);
                    TextFormatter.URL_REGEXP.lastIndex--;
                }
                TextFormatter.insertIntoTreeIfNoOverlap(tree, {
                    type: 9,
                    start: match.index,
                    end: TextFormatter.URL_REGEXP.lastIndex - 1,
                    url: url,
                    displayText: url,
                    contains: []
                });
            }
        }
        if (this.issueLinking !== null) {
            this.issueLinking.regexp.lastIndex = 0;
            while (match = this.issueLinking.regexp.exec(input)) {
                if (match[0].length === 0)
                    break;
                TextFormatter.insertIntoTreeIfNoOverlap(tree, {
                    type: 9,
                    start: match.index,
                    end: this.issueLinking.regexp.lastIndex - 1,
                    url: generateIssueLinkFromMatch(match, this.issueLinking),
                    displayText: match[0],
                    contains: []
                });
            }
        }
        if (this.config.commits) {
            TextFormatter.COMMIT_REGEXP.lastIndex = 0;
            while (match = TextFormatter.COMMIT_REGEXP.exec(input)) {
                const hash = match[0].toLowerCase();
                const commit = this.commits.find((commit) => commit.hash.toLowerCase().startsWith(hash));
                if (commit) {
                    TextFormatter.insertIntoTreeIfNoOverlap(tree, {
                        type: 2,
                        commit: commit.hash,
                        start: match.index,
                        end: TextFormatter.COMMIT_REGEXP.lastIndex - 1,
                        contains: []
                    });
                }
            }
        }
        if (this.config.markdown) {
            TextFormatter.BACKSLASH_ESCAPE_REGEXP.lastIndex = 0;
            while (match = TextFormatter.BACKSLASH_ESCAPE_REGEXP.exec(input)) {
                TextFormatter.insertIntoTreeIfNoOverlap(tree, {
                    type: 6,
                    start: match.index,
                    end: TextFormatter.BACKSLASH_ESCAPE_REGEXP.lastIndex - 1,
                    value: match[0].substring(1),
                    contains: []
                });
            }
        }
        if (this.config.emoji) {
            TextFormatter.EMOJI_REGEXP.lastIndex = 0;
            while (match = TextFormatter.EMOJI_REGEXP.exec(input)) {
                if (typeof TextFormatter.EMOJI_MAPPINGS[match[1]] === 'string') {
                    TextFormatter.insertIntoTreeIfNoOverlap(tree, {
                        type: 5,
                        start: match.index,
                        end: TextFormatter.EMOJI_REGEXP.lastIndex - 1,
                        emoji: TextFormatter.EMOJI_MAPPINGS[match[1]],
                        contains: []
                    });
                }
            }
        }
        if (this.config.markdown) {
            const emphasisTokens = [], emphasisRuns = [];
            let runLength, whitespaceBefore, whitespaceAfter, punctuationBefore, punctuationAfter, isLeft, isRight, isOpen, isClosed;
            TextFormatter.EMPHASIS_REGEXP.lastIndex = 0;
            while (match = TextFormatter.EMPHASIS_REGEXP.exec(input)) {
                let prev = 0, cur = 1, next = 2, index = match.index;
                const seq = [match[1]];
                seq.push(...match[2].split(''));
                seq.push(match[3]);
                if (seq[0].startsWith('\\')) {
                    if (seq[0].length % 2 === 1) {
                        index += seq[0].length;
                        seq.shift();
                    }
                    else {
                        index += seq[0].length - 1;
                        seq[0] = '\\';
                    }
                }
                index += seq[prev].length;
                while (cur < seq.length - 1) {
                    while (next < seq.length - 1 && seq[cur] === seq[next])
                        next++;
                    runLength = next - cur;
                    whitespaceBefore = TextFormatter.WHITESPACE_REGEXP.test(seq[prev]);
                    whitespaceAfter = TextFormatter.WHITESPACE_REGEXP.test(seq[next]);
                    punctuationBefore = TextFormatter.PUNCTUATION_REGEXP.test(seq[prev]);
                    punctuationAfter = TextFormatter.PUNCTUATION_REGEXP.test(seq[next]);
                    isLeft = !whitespaceAfter && (!punctuationAfter || (punctuationAfter && (whitespaceBefore || punctuationBefore)));
                    isRight = !whitespaceBefore && (!punctuationBefore || (punctuationBefore && (whitespaceAfter || punctuationAfter)));
                    if (seq[cur] === "*") {
                        isOpen = isLeft;
                        isClosed = isRight;
                    }
                    else {
                        isOpen = isLeft && (!isRight || punctuationBefore);
                        isClosed = isRight && (!isLeft || punctuationAfter);
                    }
                    for (let i = 0; i < runLength; i++) {
                        if (!TextFormatter.isInTree(tree, index + i, index + i)) {
                            emphasisTokens.push({ index: index + i, run: emphasisRuns.length });
                        }
                    }
                    emphasisRuns.push({
                        type: seq[cur],
                        size: runLength,
                        open: isOpen,
                        close: isClosed,
                        both: isOpen && isClosed
                    });
                    index += runLength;
                    prev = cur;
                    cur = next;
                    next = cur + 1;
                }
                TextFormatter.EMPHASIS_REGEXP.lastIndex -= seq[seq.length - 1].length;
            }
            const emphasisStack = [];
            let stackMatch;
            for (let i = 0; i < emphasisTokens.length; i++) {
                const delimiter = emphasisTokens[i];
                const run = emphasisRuns[delimiter.run];
                if (run.close && (stackMatch = TextFormatter.findOpenEmphasis(delimiter, run, emphasisRuns, emphasisStack)) > -1) {
                    TextFormatter.insertIntoTree(tree, {
                        type: emphasisRuns[emphasisStack[stackMatch].run].type === "*" ? 0 : 8,
                        start: emphasisStack[stackMatch].index,
                        end: delimiter.index,
                        contains: []
                    });
                    emphasisStack.splice(stackMatch);
                }
                else if (run.open) {
                    emphasisStack.push(delimiter);
                }
            }
            TextFormatter.combineNestedEmphasis(tree);
        }
        const html = [];
        let nextHtmlIndex = 0;
        const rec = (node) => {
            if (nextHtmlIndex < node.start) {
                html.push(escapeHtml(input.substring(nextHtmlIndex, node.start)));
            }
            switch (node.type) {
                case 0:
                case 8:
                    nextHtmlIndex = node.start + 1;
                    html.push('<em>');
                    node.contains.forEach(rec);
                    if (nextHtmlIndex < node.end) {
                        html.push(escapeHtml(input.substring(nextHtmlIndex, node.end)));
                    }
                    html.push('</em>');
                    break;
                case 3:
                case 4:
                    nextHtmlIndex = node.start + 2;
                    html.push('<strong>');
                    node.contains.forEach(rec);
                    if (nextHtmlIndex < node.end - 1) {
                        html.push(escapeHtml(input.substring(nextHtmlIndex, node.end - 1)));
                    }
                    html.push('</strong>');
                    break;
                case 6:
                    html.push(escapeHtml(node.value));
                    break;
                case 1:
                    html.push('<code>', escapeHtml(node.value), '</code>');
                    break;
                case 2:
                    html.push('<span class="', CLASS_INTERNAL_URL, '" data-type="commit" data-value="', escapeHtml(node.commit), '" tabindex="-1">', escapeHtml(input.substring(node.start, node.end + 1)), '</span>');
                    break;
                case 9:
                    html.push('<a class="', CLASS_EXTERNAL_URL, '" href="', escapeHtml(node.url), '" tabindex="-1">', escapeHtml(node.displayText), '</a>');
                    break;
                case 5:
                    html.push(node.emoji);
                    break;
            }
            nextHtmlIndex = node.end + 1;
        };
        tree.contains.forEach(rec);
        if (nextHtmlIndex < input.length) {
            html.push(escapeHtml(input.substring(nextHtmlIndex)));
        }
        return html.join('');
    }
    static registerCustomEmojiMappings(mappings) {
        const validShortcodeRegExp = /^:[A-Za-z0-9-_]+:$/;
        for (let i = 0; i < mappings.length; i++) {
            if (validShortcodeRegExp.test(mappings[i].shortcode)) {
                TextFormatter.EMOJI_MAPPINGS[mappings[i].shortcode.substring(1, mappings[i].shortcode.length - 1)] = mappings[i].emoji;
            }
        }
    }
    static findOpenEmphasis(delimiter, run, runs, stack) {
        let i = stack.length - 1;
        while (i >= 0) {
            if (stack[i].run !== delimiter.run && runs[stack[i].run].type === run.type && (!(runs[stack[i].run].both || run.both) || ((runs[stack[i].run].size + run.size) % 3 !== 0) || ((runs[stack[i].run].size % 3 === 0) && (run.size % 3 === 0)))) {
                return i;
            }
            i--;
        }
        return -1;
    }
    static combineNestedEmphasis(tree) {
        tree.contains.forEach(TextFormatter.combineNestedEmphasis);
        if (tree.contains.length === 1 && tree.type === tree.contains[0].type && (tree.type === 0 || tree.type === 8) && tree.start + 1 === tree.contains[0].start && tree.contains[0].end === tree.end - 1) {
            tree.type = tree.type === 0
                ? 3
                : 4;
            tree.contains = tree.contains[0].contains;
        }
    }
    static insertIntoTree(tree, node) {
        let firstChildIndexOfNode = -1, lastChildIndexOfNode = -1, curNode;
        for (let i = 0; i < tree.contains.length; i++) {
            curNode = tree.contains[i];
            if (node.start < curNode.start && firstChildIndexOfNode === -1) {
                firstChildIndexOfNode = i;
            }
            if (curNode.end < node.end) {
                lastChildIndexOfNode = i;
            }
            else {
                break;
            }
        }
        if (firstChildIndexOfNode === -1) {
            tree.contains.push(node);
        }
        else if (lastChildIndexOfNode === -1) {
            tree.contains.unshift(node);
        }
        else {
            node.contains = tree.contains.slice(firstChildIndexOfNode, lastChildIndexOfNode + 1);
            tree.contains.splice(firstChildIndexOfNode, lastChildIndexOfNode - firstChildIndexOfNode + 1, node);
        }
    }
    static insertIntoTreeIfNoOverlap(tree, node) {
        let curNode, insertAtIndex = tree.contains.length;
        for (let i = 0; i < tree.contains.length; i++) {
            curNode = tree.contains[i];
            if ((curNode.start <= node.start && node.start <= curNode.end) || (curNode.start <= node.end && node.end <= curNode.end) || (node.start <= curNode.start && curNode.end <= node.end)) {
                return;
            }
            else if (node.end < curNode.start) {
                insertAtIndex = i;
                break;
            }
        }
        tree.contains.splice(insertAtIndex, 0, node);
    }
    static isInTree(tree, start, end) {
        return tree.contains.some((node) => (node.start <= start && start <= node.end) || (node.start <= end && end <= node.end) || (start <= node.start && node.end <= end));
    }
}
TextFormatter.BACKTICK_REGEXP = /(\\*)(`+)/gu;
TextFormatter.BACKSLASH_ESCAPE_REGEXP = /\\[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/gu;
TextFormatter.COMMIT_REGEXP = /\b([0-9a-fA-F]{6,})\b/gu;
TextFormatter.EMOJI_REGEXP = /:([A-Za-z0-9-_]+):/gu;
TextFormatter.EMPHASIS_REGEXP = /(\\+|[^*_]?)([*_]+)(.?)/gu;
TextFormatter.INDENT_REGEXP = /^[ \t]+/u;
TextFormatter.PUNCTUATION_REGEXP = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1\u00A7\u00AB\u00B6\u00B7\u00BB\u00BF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061E\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]/u;
TextFormatter.URL_REGEXP = /https?:\/\/\S+[^,.?!'":;\s]/gu;
TextFormatter.WHITESPACE_REGEXP = /^([\u0009\u000A\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|)$/u;
TextFormatter.EMOJI_MAPPINGS = { 'adhesive_bandage': '🩹', 'alembic': '⚗', 'alien': '👽', 'ambulance': '🚑', 'apple': '🍎', 'arrow_down': '⬇️', 'arrow_up': '⬆️', 'art': '🎨', 'beers': '🍻', 'bento': '🍱', 'bookmark': '🔖', 'books': '📚', 'boom': '💥', 'bug': '🐛', 'building_construction': '🏗', 'bulb': '💡', 'busts_in_silhouette': '👥', 'camera_flash': '📸', 'card_file_box': '🗃', 'card_index': '📇', 'chart_with_upwards_trend': '📈', 'checkered_flag': '🏁', 'children_crossing': '🚸', 'clown_face': '🤡', 'construction': '🚧', 'construction_worker': '👷', 'dizzy': '💫', 'egg': '🥚', 'exclamation': '❗', 'fire': '🔥', 'globe_with_meridians': '🌐', 'goal_net': '🥅', 'green_apple': '🍏', 'green_heart': '💚', 'hammer': '🔨', 'heavy_check_mark': '✔️', 'heavy_minus_sign': '➖', 'heavy_plus_sign': '➕', 'iphone': '📱', 'label': '🏷️', 'lipstick': '💄', 'lock': '🔒', 'loud_sound': '🔊', 'mag': '🔍', 'memo': '📝', 'mute': '🔇', 'new': '🆕', 'ok_hand': '👌', 'package': '📦', 'page_facing_up': '📄', 'passport_control': '🛂', 'pencil': '📝', 'pencil2': '✏️', 'penguin': '🐧', 'poop': '💩', 'pushpin': '📌', 'racehorse': '🐎', 'recycle': '♻️', 'rewind': '⏪', 'robot': '🤖', 'rocket': '🚀', 'rotating_light': '🚨', 'see_no_evil': '🙈', 'seedling': '🌱', 'shirt': '👕', 'sparkles': '✨', 'speech_balloon': '💬', 'tada': '🎉', 'triangular_flag_on_post': '🚩', 'triangular_ruler': '📐', 'truck': '🚚', 'twisted_rightwards_arrows': '🔀', 'video_game': '🎮', 'wastebasket': '🗑', 'whale': '🐳', 'wheel_of_dharma': '☸️', 'wheelchair': '♿️', 'white_check_mark': '✅', 'wrench': '🔧', 'zap': '⚡️' };
TextFormatter.ENCLOSING_GROUPS = { ')': '(', ']': '[', '}': '{', '>': '<', '*': '*', '_': '_' };
function isUrlElem(elem) {
    return elem.classList.contains(CLASS_EXTERNAL_URL) || elem.classList.contains(CLASS_INTERNAL_URL);
}
function isExternalUrlElem(elem) {
    return elem.classList.contains(CLASS_EXTERNAL_URL);
}
function isInternalUrlElem(elem) {
    return elem.classList.contains(CLASS_INTERNAL_URL);
}
const ISSUE_LINKING_ARGUMENT_REGEXP = /\$([1-9][0-9]*)/g;
function parseIssueLinkingConfig(issueLinkingConfig) {
    if (issueLinkingConfig !== null) {
        try {
            return {
                regexp: new RegExp(issueLinkingConfig.issue, 'gu'),
                url: issueLinkingConfig.url
            };
        }
        catch (_) { }
    }
    return null;
}
function generateIssueLinkFromMatch(match, issueLinking) {
    return match.length > 1
        ? issueLinking.url.replace(ISSUE_LINKING_ARGUMENT_REGEXP, (placeholder, index) => {
            const i = parseInt(index);
            return i < match.length ? match[i] : placeholder;
        })
        : issueLinking.url;
}

/* ==== main.js ==== */
class GitGraphView {
    constructor(viewElem, prevState) {
        this.gitBranches = [];
        this.gitBranchHead = null;
        this.gitConfig = null;
        this.gitRemotes = [];
        this.gitStashes = [];
        this.gitTags = [];
        this.commits = [];
        this.commitHead = null;
        this.commitLookup = {};
        this.onlyFollowFirstParent = false;
        this.avatars = {};
        this.currentBranches = null;
        this.currentAuthors = null;
        this.currentRepoLoading = true;
        this.loadViewTo = null;
        this.moreCommitsAvailable = false;
        this.expandedCommit = null;
        this.selectedCommits = new Set();
        this.scrollTop = 0;
        this.renderedGitBranchHead = null;
        this.lastScrollToStash = { time: 0, hash: null };
        this.pendingRebaseTodo = null;
        this.todoDialogDragAbort = null;
        this.gitRepos = initialState.repos;
        this.config = initialState.config;
        this.maxCommits = this.config.initialLoadCommits;
        this.viewElem = viewElem;
        this.currentRepoRefreshState = {
            inProgress: false,
            hard: true,
            loadRepoInfoRefreshId: initialState.loadRepoInfoRefreshId,
            loadCommitsRefreshId: initialState.loadCommitsRefreshId,
            repoInfoChanges: false,
            configChanges: false,
            requestingRepoInfo: false,
            requestingConfig: false
        };
        this.controlsElem = document.getElementById('controls');
        this.tableElem = document.getElementById('commitTable');
        this.tableColHeadersElem = document.getElementById('tableColHeaders');
        this.footerElem = document.getElementById('footer');
        viewElem.focus();
        this.graph = new Graph('commitGraph', viewElem, this.config.graph, this.config.mute);
        this.repoDropdown = new Dropdown('repoDropdown', true, false, 'Repos', (values) => {
            this.loadRepo(values[0]);
        });
        this.branchDropdown = new Dropdown('branchDropdown', false, true, 'Branches', (values) => {
            this.currentBranches = values;
            this.maxCommits = this.config.initialLoadCommits;
            this.saveState();
            this.clearCommits();
            this.requestLoadRepoInfoAndCommits(true, true);
        }, this.config.singleBranchSelect);
        this.authorDropdown = new Dropdown('authorDropdown', false, true, 'Authors', (values) => {
            this.currentAuthors = values;
            this.maxCommits = this.config.initialLoadCommits;
            this.saveState();
            this.clearCommits();
            this.requestLoadRepoInfoAndCommits(true, true);
        }, this.config.singleAuthorSelect);
        this.showRemoteBranchesElem = document.getElementById('showRemoteBranchesCheckbox');
        this.showRemoteBranchesElem.addEventListener('change', () => {
            this.saveRepoStateValue(this.currentRepo, 'showRemoteBranchesV2', this.showRemoteBranchesElem.checked ? 1 : 2);
            this.refresh(true);
        });
        this.simplifyByDecorationElem = document.getElementById('simplifyByDecorationCheckbox');
        this.simplifyByDecorationElem.addEventListener('change', () => {
            this.saveRepoStateValue(this.currentRepo, 'simplifyByDecoration', this.simplifyByDecorationElem.checked ? 1 : 2);
            this.refresh(true);
        });
        this.workspaceFolderPaths = initialState.workspaceFolderPaths;
        this.pathFilterDropdown = new Dropdown('pathFilterDropdown', false, false, 'Paths', (values) => {
            this.handlePathFilterChange(values[0]);
        }, false, (value) => {
            this.saveRepoStateValue(this.currentRepo, 'pathFilter', value);
            this.maxCommits = this.config.initialLoadCommits;
            this.refresh(true);
            this.restorePathFilterState(this.currentRepo);
        });
        this.refreshBtnElem = document.getElementById('refreshBtn');
        this.refreshBtnElem.addEventListener('click', () => {
            if (!this.refreshBtnElem.classList.contains(CLASS_REFRESHING)) {
                this.refresh(true, true);
            }
        });
        this.renderRefreshButton();
        this.findWidget = new FindWidget(this);
        this.settingsWidget = new SettingsWidget(this);
        alterClass(document.body, CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH, this.config.referenceLabels.branchLabelsAlignedToGraph);
        alterClass(document.body, CLASS_TAG_LABELS_RIGHT_ALIGNED, this.config.referenceLabels.tagLabelsOnRight);
        this.observeWindowSizeChanges();
        this.observeWebviewStyleChanges();
        this.observeViewScroll();
        this.observeKeyboardEvents();
        this.observeUrls();
        this.observeTableEvents();
        if (prevState && !prevState.currentRepoLoading && typeof this.gitRepos[prevState.currentRepo] !== 'undefined') {
            this.currentRepo = prevState.currentRepo;
            this.currentBranches = prevState.currentBranches;
            this.currentAuthors = prevState.currentAuthors;
            this.maxCommits = prevState.maxCommits;
            this.expandedCommit = prevState.expandedCommit;
            this.avatars = prevState.avatars;
            this.gitConfig = prevState.gitConfig;
            this.selectedCommits = new Set(prevState.selectedCommits || []);
            this.loadRepoInfo(prevState.gitBranches, prevState.gitBranchHead, prevState.gitRemotes, prevState.gitStashes, true);
            this.loadCommits(prevState.commits, prevState.commitHead, prevState.gitTags, prevState.moreCommitsAvailable, prevState.onlyFollowFirstParent);
            this.findWidget.restoreState(prevState.findWidget);
            this.settingsWidget.restoreState(prevState.settingsWidget);
            this.showRemoteBranchesElem.checked = getShowRemoteBranches(this.gitRepos[prevState.currentRepo].showRemoteBranchesV2);
            this.simplifyByDecorationElem.checked = getSimplifyByDecoration(this.gitRepos[prevState.currentRepo].simplifyByDecoration);
            this.restorePathFilterState(prevState.currentRepo);
        }
        let loadViewTo = initialState.loadViewTo;
        if (loadViewTo === null && prevState && prevState.currentRepoLoading && typeof prevState.currentRepo !== 'undefined') {
            loadViewTo = { repo: prevState.currentRepo };
        }
        if (!this.loadRepos(this.gitRepos, initialState.lastActiveRepo, loadViewTo)) {
            if (prevState) {
                this.scrollTop = prevState.scrollTop;
                this.viewElem.scroll(0, this.scrollTop);
            }
            this.requestLoadRepoInfoAndCommits(false, false);
        }
        const currentBtn = document.getElementById('currentBtn'), fetchBtn = document.getElementById('fetchBtn'), findBtn = document.getElementById('findBtn'), settingsBtn = document.getElementById('settingsBtn'), terminalBtn = document.getElementById('terminalBtn');
        currentBtn.innerHTML = SVG_ICONS.current;
        currentBtn.addEventListener('click', () => {
            if (this.commitHead) {
                this.scrollToCommit(this.commitHead, true, true);
            }
        });
        fetchBtn.title = 'Fetch' + (this.config.fetchAndPrune ? ' & Prune' : '') + ' from Remote(s)';
        fetchBtn.innerHTML = SVG_ICONS.download;
        fetchBtn.addEventListener('click', () => this.fetchFromRemotesAction());
        findBtn.innerHTML = SVG_ICONS.search;
        findBtn.addEventListener('click', () => this.findWidget.show(true));
        settingsBtn.innerHTML = SVG_ICONS.gear;
        settingsBtn.addEventListener('click', () => this.settingsWidget.show(this.currentRepo));
        terminalBtn.innerHTML = SVG_ICONS.terminal;
        terminalBtn.addEventListener('click', () => {
            runAction({
                command: 'openTerminal',
                repo: this.currentRepo,
                name: this.gitRepos[this.currentRepo].name || getRepoName(this.currentRepo)
            }, 'Opening Terminal');
        });
    }
    loadRepos(repos, lastActiveRepo, loadViewTo, workspaceFolderPaths) {
        this.gitRepos = repos;
        if (workspaceFolderPaths) {
            this.workspaceFolderPaths = workspaceFolderPaths;
        }
        this.saveState();
        let newRepo;
        if (loadViewTo !== null && this.currentRepo !== loadViewTo.repo && typeof repos[loadViewTo.repo] !== 'undefined') {
            newRepo = loadViewTo.repo;
        }
        else if (typeof repos[this.currentRepo] === 'undefined') {
            newRepo = lastActiveRepo !== null && typeof repos[lastActiveRepo] !== 'undefined'
                ? lastActiveRepo
                : getSortedRepositoryPaths(repos, this.config.repoDropdownOrder)[0];
        }
        else {
            newRepo = this.currentRepo;
        }
        alterClass(this.controlsElem, 'singleRepo', Object.keys(repos).length === 1);
        this.renderRepoDropdownOptions(newRepo);
        if (loadViewTo !== null) {
            if (loadViewTo.repo === newRepo) {
                this.loadViewTo = loadViewTo;
            }
            else {
                this.loadViewTo = null;
                showErrorMessage('Unable to load the Git Graph View for the repository "' + loadViewTo.repo + '". It is not currently included in Git Graph.');
            }
        }
        else {
            this.loadViewTo = null;
        }
        if (this.loadViewTo !== null && this.loadViewTo.pathFilter !== undefined) {
            this.gitRepos[this.loadViewTo.repo].pathFilter = this.loadViewTo.pathFilter;
            sendMessage({ command: 'setRepoState', repo: this.loadViewTo.repo, state: this.gitRepos[this.loadViewTo.repo] });
        }
        if (this.currentRepo !== newRepo) {
            this.loadRepo(newRepo);
            return true;
        }
        else {
            this.restorePathFilterState(this.currentRepo);
            if (this.loadViewTo !== null && this.loadViewTo.pathFilter !== undefined) {
                this.maxCommits = this.config.initialLoadCommits;
                this.refresh(true);
            }
            else {
                this.finaliseRepoLoad(false);
            }
            return false;
        }
    }
    loadRepo(repo) {
        this.currentRepo = repo;
        this.currentRepoLoading = true;
        this.showRemoteBranchesElem.checked = getShowRemoteBranches(this.gitRepos[this.currentRepo].showRemoteBranchesV2);
        this.simplifyByDecorationElem.checked = getSimplifyByDecoration(this.gitRepos[this.currentRepo].simplifyByDecoration);
        this.restorePathFilterState(this.currentRepo);
        this.maxCommits = this.config.initialLoadCommits;
        this.gitConfig = null;
        this.gitRemotes = [];
        this.gitStashes = [];
        this.gitTags = [];
        this.currentBranches = null;
        this.currentAuthors = [];
        this.renderFetchButton();
        this.closeCommitDetails(false);
        this.settingsWidget.close();
        this.saveState();
        this.refresh(true);
    }
    restorePathFilterState(repo) {
        const repoState = this.gitRepos[repo];
        const options = this.getPathFilterOptions();
        const wsPaths = this.workspaceFolderPaths[repo] || [];
        let selectedValue;
        if (repoState.pathFilter === PATH_FILTER_WS_ALL && wsPaths.length > 0) {
            selectedValue = wsPaths.length === 1 ? wsPaths[0] : PATH_FILTER_WS_ALL;
        }
        else if (repoState.pathFilter !== null && repoState.pathFilter !== PATH_FILTER_WS_ALL) {
            const matchingOption = options.find((o) => o.value === repoState.pathFilter);
            selectedValue = matchingOption ? repoState.pathFilter : SHOW_ALL_BRANCHES;
        }
        else {
            selectedValue = SHOW_ALL_BRANCHES;
        }
        this.pathFilterDropdown.setOptions(options, [selectedValue]);
        this.updateSimplifyState();
    }
    isPathFilterActive() {
        const repoState = this.gitRepos[this.currentRepo];
        if (repoState.pathFilter === PATH_FILTER_WS_ALL) {
            const paths = this.workspaceFolderPaths[this.currentRepo] || [];
            return paths.length > 0;
        }
        return repoState.pathFilter !== null;
    }
    updateSimplifyState() {
        const pathActive = this.isPathFilterActive();
        this.simplifyByDecorationElem.disabled = pathActive;
        const label = document.getElementById('simplifyByDecorationControl');
        if (pathActive) {
            label.classList.add(CLASS_DISABLED);
        }
        else {
            label.classList.remove(CLASS_DISABLED);
        }
    }
    getPathFilterOptions() {
        const options = [{ name: 'All', value: SHOW_ALL_BRANCHES }];
        const wsPaths = this.workspaceFolderPaths[this.currentRepo] || [];
        if (wsPaths.length > 1) {
            options.push({ name: 'Workspace (all)', value: PATH_FILTER_WS_ALL });
        }
        for (const p of wsPaths) {
            options.push({ name: p, value: p });
        }
        const repoState = this.gitRepos[this.currentRepo];
        if (repoState.pathFilter !== null && repoState.pathFilter !== PATH_FILTER_WS_ALL && !wsPaths.includes(repoState.pathFilter)) {
            options.push({ name: repoState.pathFilter, value: repoState.pathFilter });
        }
        return options;
    }
    handlePathFilterChange(selected) {
        if (selected === SHOW_ALL_BRANCHES) {
            this.saveRepoStateValue(this.currentRepo, 'pathFilter', null);
        }
        else if (selected === PATH_FILTER_WS_ALL) {
            this.saveRepoStateValue(this.currentRepo, 'pathFilter', PATH_FILTER_WS_ALL);
        }
        else {
            this.saveRepoStateValue(this.currentRepo, 'pathFilter', selected);
        }
        this.maxCommits = this.config.initialLoadCommits;
        this.updateSimplifyState();
        this.refresh(true);
    }
    getWorkspacePathsForCurrentRepo() {
        const paths = this.workspaceFolderPaths[this.currentRepo] || [];
        return paths.length > 0 ? paths.join(', ') : null;
    }
    loadRepoInfo(branchOptions, branchHead, remotes, stashes, isRepo) {
        this.gitStashes = stashes;
        if (!isRepo || (!this.currentRepoRefreshState.hard && arraysStrictlyEqual(this.gitBranches, branchOptions) && this.gitBranchHead === branchHead && arraysStrictlyEqual(this.gitRemotes, remotes))) {
            this.saveState();
            this.finaliseLoadRepoInfo(false, isRepo);
            return;
        }
        this.gitBranches = branchOptions;
        this.gitBranchHead = branchHead;
        this.gitRemotes = remotes;
        this.renderFetchButton();
        const filterCurrentBranches = () => {
            if (this.currentBranches !== null && !(this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES)) {
                const globPatterns = this.config.customBranchGlobPatterns.map((pattern) => pattern.glob);
                this.currentBranches = this.currentBranches.filter((branch) => this.gitBranches.includes(branch) || globPatterns.includes(branch) || branch === 'HEAD');
            }
        };
        filterCurrentBranches();
        if (this.currentBranches === null || this.currentBranches.length === 0) {
            const onRepoLoadShowCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.gitRepos[this.currentRepo].onRepoLoadShowCheckedOutBranch);
            const onRepoLoadShowSpecificBranches = getOnRepoLoadShowSpecificBranches(this.gitRepos[this.currentRepo].onRepoLoadShowSpecificBranches);
            this.currentBranches = [];
            if (onRepoLoadShowSpecificBranches.length > 0) {
                const globPatterns = this.config.customBranchGlobPatterns.map((pattern) => pattern.glob);
                this.currentBranches.push(...onRepoLoadShowSpecificBranches.filter((branch) => this.gitBranches.includes(branch) || globPatterns.includes(branch)));
            }
            if (onRepoLoadShowCheckedOutBranch && this.gitBranchHead !== null && !this.currentBranches.includes(this.gitBranchHead)) {
                this.currentBranches.push(this.gitBranchHead);
            }
            if (this.currentBranches.length === 0) {
                this.currentBranches.push(SHOW_ALL_BRANCHES);
            }
        }
        filterCurrentBranches();
        this.saveState();
        this.branchDropdown.setOptions(this.getBranchOptions(true), this.currentBranches);
        this.authorDropdown.setOptions(this.getAuthorOptions(), this.currentAuthors);
        let hiddenRemotes = this.gitRepos[this.currentRepo].hideRemotes;
        let hideRemotes = hiddenRemotes.filter((hiddenRemote) => remotes.includes(hiddenRemote));
        if (hiddenRemotes.length !== hideRemotes.length) {
            this.saveRepoStateValue(this.currentRepo, 'hideRemotes', hideRemotes);
        }
        this.finaliseLoadRepoInfo(true, isRepo);
    }
    finaliseLoadRepoInfo(repoInfoChanges, isRepo) {
        const refreshState = this.currentRepoRefreshState;
        if (refreshState.inProgress) {
            if (isRepo) {
                refreshState.repoInfoChanges = refreshState.repoInfoChanges || repoInfoChanges;
                refreshState.requestingRepoInfo = false;
                this.requestLoadCommits();
            }
            else {
                dialog.closeActionRunning();
                refreshState.inProgress = false;
                this.loadViewTo = null;
                this.renderRefreshButton();
                sendMessage({ command: 'loadRepos', check: true });
            }
        }
    }
    loadCommits(commits, commitHead, tags, moreAvailable, onlyFollowFirstParent, pathFilterActive = false) {
        const tagsChanged = !arraysStrictlyEqual(this.gitTags, tags);
        this.gitTags = tags;
        if (!this.currentRepoLoading && !this.currentRepoRefreshState.hard && this.moreCommitsAvailable === moreAvailable && this.onlyFollowFirstParent === onlyFollowFirstParent && this.commitHead === commitHead && commits.length > 0 && arraysEqual(this.commits, commits, (a, b) => a.hash === b.hash &&
            arraysStrictlyEqual(a.heads, b.heads) &&
            arraysEqual(a.tags, b.tags, (a, b) => a.name === b.name && a.annotated === b.annotated) &&
            arraysEqual(a.remotes, b.remotes, (a, b) => a.name === b.name && a.remote === b.remote) &&
            arraysStrictlyEqual(a.parents, b.parents) &&
            ((a.stash === null && b.stash === null) || (a.stash !== null && b.stash !== null && a.stash.selector === b.stash.selector))) && this.renderedGitBranchHead === this.gitBranchHead) {
            if (this.commits[0].hash === UNCOMMITTED) {
                this.commits[0] = commits[0];
                this.saveState();
                this.renderUncommittedChanges();
                if (this.expandedCommit !== null && this.expandedCommit.commitElem !== null) {
                    if (this.expandedCommit.compareWithHash === null) {
                        if (this.expandedCommit.commitHash === UNCOMMITTED) {
                            this.requestCommitDetails(this.expandedCommit.commitHash, true);
                        }
                    }
                    else {
                        if (this.expandedCommit.compareWithElem !== null && (this.expandedCommit.commitHash === UNCOMMITTED || this.expandedCommit.compareWithHash === UNCOMMITTED)) {
                            this.requestCommitComparison(this.expandedCommit.commitHash, this.expandedCommit.compareWithHash, true);
                        }
                    }
                }
            }
            else if (tagsChanged) {
                this.saveState();
            }
            this.finaliseLoadCommits();
            return;
        }
        const currentRepoLoading = this.currentRepoLoading;
        this.currentRepoLoading = false;
        this.moreCommitsAvailable = moreAvailable;
        this.onlyFollowFirstParent = onlyFollowFirstParent;
        this.commits = commits;
        this.commitHead = commitHead;
        this.commitLookup = {};
        let i, expandedCommitVisible = false, expandedCompareWithCommitVisible = false, avatarsNeeded = {}, commit;
        for (i = 0; i < this.commits.length; i++) {
            commit = this.commits[i];
            this.commitLookup[commit.hash] = i;
            if (this.expandedCommit !== null) {
                if (this.expandedCommit.commitHash === commit.hash) {
                    expandedCommitVisible = true;
                }
                else if (this.expandedCommit.compareWithHash === commit.hash) {
                    expandedCompareWithCommitVisible = true;
                }
            }
            if (this.config.fetchAvatars && typeof this.avatars[commit.email] !== 'string' && commit.email !== '') {
                if (typeof avatarsNeeded[commit.email] === 'undefined') {
                    avatarsNeeded[commit.email] = [commit.hash];
                }
                else {
                    avatarsNeeded[commit.email].push(commit.hash);
                }
            }
        }
        if (this.expandedCommit !== null && (!expandedCommitVisible || (this.expandedCommit.compareWithHash !== null && !expandedCompareWithCommitVisible))) {
            this.closeCommitDetails(false);
        }
        this.saveState();
        this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent, pathFilterActive);
        this.render();
        if (currentRepoLoading && this.config.onRepoLoad.scrollToHead && this.commitHead !== null) {
            this.scrollToCommit(this.commitHead, true);
        }
        this.finaliseLoadCommits();
        this.requestAvatars(avatarsNeeded);
    }
    finaliseLoadCommits() {
        const refreshState = this.currentRepoRefreshState;
        if (refreshState.inProgress) {
            dialog.closeActionRunning();
            if (dialog.isTargetDynamicSource()) {
                if (refreshState.repoInfoChanges) {
                    dialog.close();
                }
                else {
                    dialog.refresh(this.getCommits());
                }
            }
            if (contextMenu.isTargetDynamicSource()) {
                if (refreshState.repoInfoChanges) {
                    contextMenu.close();
                }
                else {
                    contextMenu.refresh(this.getCommits());
                }
            }
            refreshState.inProgress = false;
            this.renderRefreshButton();
        }
        this.finaliseRepoLoad(true);
    }
    finaliseRepoLoad(didLoadRepoData) {
        if (this.loadViewTo !== null && this.currentRepo === this.loadViewTo.repo) {
            if (this.loadViewTo.commitDetails && (this.expandedCommit === null || this.expandedCommit.commitHash !== this.loadViewTo.commitDetails.commitHash || this.expandedCommit.compareWithHash !== this.loadViewTo.commitDetails.compareWithHash)) {
                const commitIndex = this.getCommitId(this.loadViewTo.commitDetails.commitHash);
                const compareWithIndex = this.loadViewTo.commitDetails.compareWithHash !== null ? this.getCommitId(this.loadViewTo.commitDetails.compareWithHash) : null;
                const commitElems = getCommitElems();
                const commitElem = findCommitElemWithId(commitElems, commitIndex);
                const compareWithElem = findCommitElemWithId(commitElems, compareWithIndex);
                if (commitElem !== null && (this.loadViewTo.commitDetails.compareWithHash === null || compareWithElem !== null)) {
                    if (compareWithElem !== null) {
                        this.loadCommitComparison(commitElem, compareWithElem);
                    }
                    else {
                        this.loadCommitDetails(commitElem);
                    }
                }
                else {
                    showErrorMessage('Unable to resume Code Review, it could not be found in the latest ' + this.maxCommits + ' commits that were loaded in this repository.');
                }
            }
            else if (this.loadViewTo.runCommandOnLoad) {
                switch (this.loadViewTo.runCommandOnLoad) {
                    case 'fetch':
                        this.fetchFromRemotesAction();
                        break;
                }
            }
        }
        this.loadViewTo = null;
        if (this.gitConfig === null || (didLoadRepoData && this.currentRepoRefreshState.configChanges)) {
            this.requestLoadConfig();
        }
    }
    clearCommits() {
        closeDialogAndContextMenu();
        this.moreCommitsAvailable = false;
        this.commits = [];
        this.commitHead = null;
        this.commitLookup = {};
        this.renderedGitBranchHead = null;
        this.closeCommitDetails(false);
        this.saveState();
        this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent);
        this.tableElem.innerHTML = '';
        this.footerElem.innerHTML = '';
        this.renderGraph();
        this.findWidget.refresh();
    }
    processLoadRepoInfoResponse(msg) {
        if (msg.error === null) {
            const refreshState = this.currentRepoRefreshState;
            if (refreshState.inProgress && refreshState.loadRepoInfoRefreshId === msg.refreshId) {
                this.loadRepoInfo(msg.branches, msg.head, msg.remotes, msg.stashes, msg.isRepo);
            }
        }
        else {
            this.displayLoadDataError('Unable to load Repository Info', msg.error);
        }
    }
    processLoadCommitsResponse(msg) {
        if (msg.error === null) {
            const refreshState = this.currentRepoRefreshState;
            if (refreshState.inProgress && refreshState.loadCommitsRefreshId === msg.refreshId) {
                this.loadCommits(msg.commits, msg.head, msg.tags, msg.moreCommitsAvailable, msg.onlyFollowFirstParent, msg.pathFilterActive);
            }
        }
        else {
            const error = this.gitBranches.length === 0 && msg.error.indexOf('bad revision \'HEAD\'') > -1
                ? 'There are no commits in this repository.'
                : msg.error;
            this.displayLoadDataError('Unable to load Commits', error);
        }
    }
    processLoadConfig(msg) {
        this.currentRepoRefreshState.requestingConfig = false;
        if (msg.config !== null && this.currentRepo === msg.repo) {
            this.gitConfig = msg.config;
            this.saveState();
            this.renderCdvExternalDiffBtn();
        }
        this.settingsWidget.refresh();
        this.authorDropdown.setOptions(this.getAuthorOptions(), this.currentAuthors);
    }
    displayLoadDataError(message, reason) {
        this.clearCommits();
        this.currentRepoRefreshState.inProgress = false;
        this.loadViewTo = null;
        this.renderRefreshButton();
        dialog.showError(message, reason, 'Retry', () => {
            this.refresh(true);
        });
    }
    loadAvatar(email, image) {
        this.avatars[email] = image;
        this.saveState();
        let avatarsElems = document.getElementsByClassName('avatar'), escapedEmail = escapeHtml(email);
        for (let i = 0; i < avatarsElems.length; i++) {
            if (avatarsElems[i].dataset.email === escapedEmail) {
                avatarsElems[i].innerHTML = '<img class="avatarImg" src="' + image + '">';
            }
        }
    }
    getBranches() {
        return this.gitBranches;
    }
    getBranchOptions(includeShowAll) {
        const options = [];
        if (includeShowAll) {
            options.push({ name: 'Show All', value: SHOW_ALL_BRANCHES });
        }
        options.push({ name: 'HEAD', value: 'HEAD' });
        for (let i = 0; i < this.config.customBranchGlobPatterns.length; i++) {
            options.push({ name: 'Glob: ' + this.config.customBranchGlobPatterns[i].name, value: this.config.customBranchGlobPatterns[i].glob });
        }
        for (let i = 0; i < this.gitBranches.length; i++) {
            options.push({ name: this.gitBranches[i].indexOf('remotes/') === 0 ? this.gitBranches[i].substring(8) : this.gitBranches[i], value: this.gitBranches[i] });
        }
        return options;
    }
    getAuthorOptions() {
        const options = [];
        options.push({ name: 'All', value: SHOW_ALL_BRANCHES });
        if (this.gitConfig && this.gitConfig.authors) {
            for (let i = 0; i < this.gitConfig.authors.length; i++) {
                const author = this.gitConfig.authors[i];
                options.push({ name: author.name, value: author.name });
            }
        }
        return options;
    }
    getCommitId(hash) {
        return typeof this.commitLookup[hash] === 'number' ? this.commitLookup[hash] : null;
    }
    getCommitOfElem(elem) {
        let id = parseInt(elem.dataset.id);
        if (id >= this.commits.length)
            return null;
        const commit = this.commits[id];
        return commit;
    }
    getCommits() {
        return this.commits;
    }
    getPushRemote(branch = null) {
        const possibleRemotes = [];
        if (this.gitConfig !== null) {
            if (branch !== null && typeof this.gitConfig.branches[branch] !== 'undefined') {
                possibleRemotes.push(this.gitConfig.branches[branch].pushRemote, this.gitConfig.branches[branch].remote);
            }
            possibleRemotes.push(this.gitConfig.pushDefault);
        }
        possibleRemotes.push('origin');
        return possibleRemotes.find((remote) => remote !== null && this.gitRemotes.includes(remote)) || this.gitRemotes[0];
    }
    getRemoteForBranch(branchName) {
        if (!this.gitConfig || !this.gitConfig.branches[branchName]) {
            return null;
        }
        return this.gitConfig.branches[branchName].remote;
    }
    getRepoConfig() {
        return this.gitConfig;
    }
    getRepoState(repo) {
        return typeof this.gitRepos[repo] !== 'undefined'
            ? this.gitRepos[repo]
            : null;
    }
    isConfigLoading() {
        return this.currentRepoRefreshState.requestingConfig;
    }
    refresh(hard, configChanges = false) {
        if (hard) {
            this.clearCommits();
        }
        this.requestLoadRepoInfoAndCommits(hard, false, configChanges);
    }
    requestLoadRepoInfo() {
        const repoState = this.gitRepos[this.currentRepo];
        sendMessage({
            command: 'loadRepoInfo',
            repo: this.currentRepo,
            refreshId: ++this.currentRepoRefreshState.loadRepoInfoRefreshId,
            showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
            simplifyByDecoration: getSimplifyByDecoration(repoState.simplifyByDecoration),
            showStashes: getShowStashes(repoState.showStashes),
            hideRemotes: repoState.hideRemotes
        });
    }
    requestLoadCommits() {
        const repoState = this.gitRepos[this.currentRepo];
        sendMessage({
            command: 'loadCommits',
            repo: this.currentRepo,
            refreshId: ++this.currentRepoRefreshState.loadCommitsRefreshId,
            branches: this.currentBranches === null || (this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES) ? null : this.currentBranches,
            authors: this.currentAuthors === null || (this.currentAuthors.length === 1 && this.currentAuthors[0] === SHOW_ALL_BRANCHES) ? null : this.currentAuthors,
            maxCommits: this.maxCommits,
            showTags: getShowTags(repoState.showTags),
            showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
            simplifyByDecoration: this.isPathFilterActive() ? false : getSimplifyByDecoration(repoState.simplifyByDecoration),
            includeCommitsMentionedByReflogs: getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs),
            onlyFollowFirstParent: getOnlyFollowFirstParent(repoState.onlyFollowFirstParent),
            commitOrdering: getCommitOrdering(repoState.commitOrdering),
            remotes: this.gitRemotes,
            hideRemotes: repoState.hideRemotes,
            stashes: this.gitStashes,
            pathFilter: repoState.pathFilter === PATH_FILTER_WS_ALL
                ? this.getWorkspacePathsForCurrentRepo()
                : repoState.pathFilter
        });
    }
    requestLoadRepoInfoAndCommits(hard, skipRepoInfo, configChanges = false) {
        const refreshState = this.currentRepoRefreshState;
        if (refreshState.inProgress) {
            refreshState.hard = refreshState.hard || hard;
            refreshState.configChanges = refreshState.configChanges || configChanges;
            if (!skipRepoInfo) {
                refreshState.loadCommitsRefreshId++;
            }
        }
        else {
            refreshState.hard = hard;
            refreshState.inProgress = true;
            refreshState.repoInfoChanges = false;
            refreshState.configChanges = configChanges;
            refreshState.requestingRepoInfo = false;
        }
        this.renderRefreshButton();
        if (this.commits.length === 0) {
            this.tableElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + 'Loading ...</h2>';
        }
        if (skipRepoInfo) {
            if (!refreshState.requestingRepoInfo) {
                this.requestLoadCommits();
            }
        }
        else {
            refreshState.requestingRepoInfo = true;
            this.requestLoadRepoInfo();
        }
    }
    requestLoadConfig() {
        this.currentRepoRefreshState.requestingConfig = true;
        sendMessage({ command: 'loadConfig', repo: this.currentRepo, remotes: this.gitRemotes });
        this.settingsWidget.refresh();
    }
    requestCommitDetails(hash, refresh) {
        let commit = this.commits[this.commitLookup[hash]];
        sendMessage({
            command: 'commitDetails',
            repo: this.currentRepo,
            commitHash: hash,
            hasParents: commit.parents.length > 0,
            stash: commit.stash,
            avatarEmail: this.config.fetchAvatars && hash !== UNCOMMITTED ? commit.email : null,
            refresh: refresh
        });
    }
    requestCommitComparison(hash, compareWithHash, refresh) {
        let commitOrder = this.getCommitOrder(hash, compareWithHash);
        sendMessage({
            command: 'compareCommits',
            repo: this.currentRepo,
            commitHash: hash, compareWithHash: compareWithHash,
            fromHash: commitOrder.from, toHash: commitOrder.to,
            refresh: refresh
        });
    }
    requestAvatars(avatars) {
        let emails = Object.keys(avatars), remote = this.gitRemotes.length > 0 ? this.gitRemotes.includes('origin') ? 'origin' : this.gitRemotes[0] : null;
        for (let i = 0; i < emails.length; i++) {
            sendMessage({ command: 'fetchAvatar', repo: this.currentRepo, remote: remote, email: emails[i], commits: avatars[emails[i]] });
        }
    }
    saveState() {
        let expandedCommit;
        if (this.expandedCommit !== null) {
            expandedCommit = Object.assign({}, this.expandedCommit);
            expandedCommit.commitElem = null;
            expandedCommit.compareWithElem = null;
            expandedCommit.contextMenuOpen = {
                summary: false,
                fileView: -1
            };
        }
        else {
            expandedCommit = null;
        }
        VSCODE_API.setState({
            currentRepo: this.currentRepo,
            currentRepoLoading: this.currentRepoLoading,
            gitRepos: this.gitRepos,
            gitBranches: this.gitBranches,
            gitBranchHead: this.gitBranchHead,
            gitConfig: this.gitConfig,
            gitRemotes: this.gitRemotes,
            gitStashes: this.gitStashes,
            gitTags: this.gitTags,
            commits: this.commits,
            commitHead: this.commitHead,
            avatars: this.avatars,
            currentBranches: this.currentBranches,
            currentAuthors: this.currentAuthors,
            moreCommitsAvailable: this.moreCommitsAvailable,
            maxCommits: this.maxCommits,
            onlyFollowFirstParent: this.onlyFollowFirstParent,
            expandedCommit: expandedCommit,
            scrollTop: this.scrollTop,
            selectedCommits: Array.from(this.selectedCommits),
            findWidget: this.findWidget.getState(),
            settingsWidget: this.settingsWidget.getState()
        });
    }
    saveRepoState() {
        sendMessage({ command: 'setRepoState', repo: this.currentRepo, state: this.gitRepos[this.currentRepo] });
    }
    saveColumnWidths(columnWidths) {
        this.gitRepos[this.currentRepo].columnWidths = [columnWidths[0], columnWidths[2], columnWidths[3], columnWidths[4]];
        this.saveRepoState();
    }
    saveExpandedCommitLoading(index, commitHash, commitElem, compareWithHash, compareWithElem) {
        this.expandedCommit = {
            index: index,
            commitHash: commitHash,
            commitElem: commitElem,
            compareWithHash: compareWithHash,
            compareWithElem: compareWithElem,
            commitDetails: null,
            fileChanges: null,
            fileTree: null,
            avatar: null,
            codeReview: null,
            lastViewedFile: null,
            loading: true,
            scrollTop: {
                summary: 0,
                fileView: 0
            },
            contextMenuOpen: {
                summary: false,
                fileView: -1
            }
        };
        this.saveState();
    }
    saveRepoStateValue(repo, key, value) {
        if (repo === this.currentRepo) {
            this.gitRepos[this.currentRepo][key] = value;
            this.saveRepoState();
        }
    }
    toggleCommitSelection(commitHash, commitElem) {
        if (this.selectedCommits.has(commitHash)) {
            this.selectedCommits.delete(commitHash);
            commitElem.classList.remove('commitSelected');
        }
        else {
            this.selectedCommits.add(commitHash);
            commitElem.classList.add('commitSelected');
        }
    }
    clearCommitSelection() {
        const selectedElems = document.querySelectorAll('.commitSelected');
        selectedElems.forEach(elem => elem.classList.remove('commitSelected'));
        this.selectedCommits.clear();
    }
    selectCommitRange(fromHash, toHash) {
        const fromIndex = this.commitLookup[fromHash];
        const toIndex = this.commitLookup[toHash];
        if (fromIndex === undefined || toIndex === undefined)
            return;
        this.clearCommitSelection();
        const startIndex = Math.min(fromIndex, toIndex);
        const endIndex = Math.max(fromIndex, toIndex);
        for (let i = startIndex; i <= endIndex; i++) {
            const commit = this.commits[i];
            if (commit) {
                this.selectedCommits.add(commit.hash);
                const commitElem = document.querySelector(`tr.commit[data-id="${i}"]`);
                if (commitElem) {
                    commitElem.classList.add('commitSelected');
                }
            }
        }
    }
    getSelectedCommitsArray() {
        return Array.from(this.selectedCommits).sort((a, b) => {
            const indexA = this.commitLookup[a];
            const indexB = this.commitLookup[b];
            return indexA - indexB;
        });
    }
    areSelectedCommitsContiguous() {
        if (this.selectedCommits.size < 2)
            return true;
        const sortedCommits = this.getSelectedCommitsArray();
        for (let i = 0; i < sortedCommits.length - 1; i++) {
            const currentIndex = this.commitLookup[sortedCommits[i]];
            const nextIndex = this.commitLookup[sortedCommits[i + 1]];
            if (nextIndex - currentIndex !== 1) {
                return false;
            }
        }
        return true;
    }
    areSelectedCommitsOnCurrentBranch() {
        if (this.selectedCommits.size === 0 || !this.gitBranchHead) {
            return false;
        }
        let currentBranchCommitIndex = -1;
        for (let i = 0; i < this.commits.length; i++) {
            if (this.commits[i].heads && this.commits[i].heads.includes(this.gitBranchHead)) {
                currentBranchCommitIndex = i;
                break;
            }
        }
        if (currentBranchCommitIndex === -1) {
            return false;
        }
        const branchCommits = new Set();
        const queue = [currentBranchCommitIndex];
        const visited = new Set();
        while (queue.length > 0) {
            const index = queue.shift();
            if (visited.has(index))
                continue;
            visited.add(index);
            const commit = this.commits[index];
            branchCommits.add(commit.hash);
            for (const parentHash of commit.parents) {
                const parentIndex = this.commitLookup[parentHash];
                if (parentIndex !== undefined && !visited.has(parentIndex)) {
                    queue.push(parentIndex);
                }
            }
        }
        for (const hash of Array.from(this.selectedCommits)) {
            if (!branchCommits.has(hash)) {
                return false;
            }
        }
        return true;
    }
    dropCommitsPossible() {
        if (this.selectedCommits.size === 0)
            return false;
        for (const hash of Array.from(this.selectedCommits)) {
            const index = this.commitLookup[hash];
            if (!this.graph.dropCommitPossible(index)) {
                return false;
            }
        }
        return true;
    }
    squashCommitsAction(target) {
        const selectedCommits = this.getSelectedCommitsArray();
        if (selectedCommits.length < 2)
            return;
        const newestCommit = selectedCommits[0];
        const newestCommitData = this.commits[this.commitLookup[newestCommit]];
        const commitsList = selectedCommits.map(hash => {
            const commitData = this.commits[this.commitLookup[hash]];
            return `<b>${abbrevCommit(hash)}</b> - ${escapeHtml(commitData.message)}`;
        }).join('<br>');
        dialog.showForm(`Are you sure you want to squash ${selectedCommits.length} commits into one?<br><br>` +
            `${commitsList}`, [{
                type: 0,
                name: 'Commit Message',
                default: newestCommitData.message,
                placeholder: 'Enter the commit message for the squashed commit'
            }, { type: 4, name: 'No Verify', value: false }], 'Yes, squash commits', (values) => {
            const commitMessage = values[0];
            const noVerify = values[1];
            runAction({
                command: 'squashCommits',
                repo: this.currentRepo,
                commits: selectedCommits,
                commitMessage: commitMessage,
                noVerify: noVerify
            }, 'Squashing Commits');
            this.clearCommitSelection();
        }, target);
    }
    dropSelectedCommitsAction(target) {
        const selectedCommits = this.getSelectedCommitsArray();
        if (selectedCommits.length === 0)
            return;
        const commitsList = selectedCommits.map(hash => {
            const commitData = this.commits[this.commitLookup[hash]];
            return `<b>${abbrevCommit(hash)}</b> - ${escapeHtml(commitData.message)}`;
        }).join('<br>');
        dialog.showConfirmation(`Are you sure you want to permanently drop ${selectedCommits.length} commit${selectedCommits.length > 1 ? 's' : ''}?<br><br>${commitsList}` +
            (this.onlyFollowFirstParent ? '<br/><br/><i>Note: By enabling "Only follow the first parent of commits", some commits may have been hidden from the Git Graph View that could affect the outcome of performing this action.</i>' : ''), 'Yes, drop', () => {
            runAction({
                command: 'dropCommits',
                repo: this.currentRepo,
                commits: selectedCommits
            }, 'Dropping Commits');
            this.clearCommitSelection();
        }, target);
    }
    editCommitMessageAction(target) {
        const hash = target.hash;
        const commit = this.commits[this.commitLookup[hash]];
        dialog.showForm(`Edit commit message for <b><i>${abbrevCommit(hash)}</i></b>:`, [{
                type: 0,
                name: 'Commit Message',
                default: commit.message,
                placeholder: 'Enter the new commit message'
            },
            { type: 4, name: 'No Verify', value: false }], 'Update Message', (values) => {
            const newMessage = values[0];
            if (newMessage.trim() === '') {
                dialog.showError('Commit message cannot be empty.', null, null, null);
                return;
            }
            if (newMessage === commit.message) {
                return;
            }
            runAction({
                command: 'editCommitMessage',
                repo: this.currentRepo,
                commitHash: hash,
                message: newMessage,
                noVerify: values[1]
            }, 'Editing Commit Message');
        }, target);
    }
    render() {
        this.renderTable();
        this.renderGraph();
    }
    renderGraph() {
        if (typeof this.currentRepo === 'undefined') {
            return;
        }
        const colHeadersElem = document.getElementById('tableColHeaders');
        const cdvHeight = this.gitRepos[this.currentRepo].isCdvSummaryHidden ? 0 : this.gitRepos[this.currentRepo].cdvHeight;
        const headerHeight = colHeadersElem !== null ? colHeadersElem.clientHeight + 1 : 0;
        const expandedCommit = this.isCdvDocked() ? null : this.expandedCommit;
        const expandedCommitElem = expandedCommit !== null ? document.getElementById('cdv') : null;
        this.config.graph.grid.expandY = expandedCommitElem !== null
            ? expandedCommitElem.getBoundingClientRect().height
            : cdvHeight;
        this.config.graph.grid.y = this.commits.length > 0 && this.tableElem.children.length > 0
            ? (this.tableElem.children[0].clientHeight - headerHeight - (expandedCommit !== null ? cdvHeight : 0)) / this.commits.length
            : this.config.graph.grid.y;
        this.config.graph.grid.offsetY = headerHeight + this.config.graph.grid.y / 2;
        this.graph.render(expandedCommit);
    }
    renderTable() {
        const colVisibility = this.getColumnVisibility();
        const currentHash = this.commits.length > 0 && this.commits[0].hash === UNCOMMITTED ? UNCOMMITTED : this.commitHead;
        const vertexColours = this.graph.getVertexColours();
        const widthsAtVertices = this.config.referenceLabels.branchLabelsAlignedToGraph ? this.graph.getWidthsAtVertices() : [];
        const mutedCommits = this.graph.getMutedCommits(currentHash);
        const dimmedCommits = this.graph.getPathFilterDimmedCommits();
        const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
            emoji: true,
            issueLinking: true,
            markdown: this.config.markdown
        });
        let html = '<tr id="tableColHeaders"><th id="tableHeaderGraphCol" class="tableColHeader" data-col="0">Graph</th><th class="tableColHeader" data-col="1">Description</th>' +
            (colVisibility.date ? '<th class="tableColHeader dateCol" data-col="2">Date</th>' : '') +
            (colVisibility.author ? '<th class="tableColHeader authorCol" data-col="3">Author</th>' : '') +
            (colVisibility.commit ? '<th class="tableColHeader" data-col="4">Commit</th>' : '') +
            '</tr>';
        for (let i = 0; i < this.commits.length; i++) {
            let commit = this.commits[i];
            let message = '<span class="text">' + textFormatter.format(commit.message) + '</span>';
            let date = formatShortDate(commit.date);
            let branchLabels = getBranchLabels(commit.heads, commit.remotes);
            let refBranches = '', refTags = '', j, k, refName, remoteName, refActive, refHtml, branchCheckedOutAtCommit = null;
            for (j = 0; j < branchLabels.heads.length; j++) {
                refName = escapeHtml(branchLabels.heads[j].name);
                refActive = branchLabels.heads[j].name === this.gitBranchHead;
                refHtml = '<span class="gitRef head' + (refActive ? ' active' : '') + '" data-name="' + refName + '">' + SVG_ICONS.branch + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span>';
                for (k = 0; k < branchLabels.heads[j].remotes.length; k++) {
                    remoteName = escapeHtml(branchLabels.heads[j].remotes[k]);
                    refHtml += '<span class="gitRefHeadRemote" data-remote="' + remoteName + '" data-fullref="' + escapeHtml(branchLabels.heads[j].remotes[k] + '/' + branchLabels.heads[j].name) + '">' + remoteName + '</span>';
                }
                refHtml += '</span>';
                refBranches = refActive ? refHtml + refBranches : refBranches + refHtml;
                if (refActive)
                    branchCheckedOutAtCommit = this.gitBranchHead;
            }
            for (j = 0; j < branchLabels.remotes.length; j++) {
                refName = escapeHtml(branchLabels.remotes[j].name);
                refBranches += '<span class="gitRef remote" data-name="' + refName + '" data-remote="' + (branchLabels.remotes[j].remote !== null ? escapeHtml(branchLabels.remotes[j].remote) : '') + '">' + SVG_ICONS.branch + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span></span>';
            }
            for (j = 0; j < commit.tags.length; j++) {
                refName = escapeHtml(commit.tags[j].name);
                refTags += '<span class="gitRef tag" data-name="' + refName + '" data-tagtype="' + (commit.tags[j].annotated ? 'annotated' : 'lightweight') + '">' + SVG_ICONS.tag + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span></span>';
            }
            if (commit.stash !== null) {
                refName = escapeHtml(commit.stash.selector);
                refBranches = '<span class="gitRef stash" data-name="' + refName + '">' + SVG_ICONS.stash + '<span class="gitRefName" data-fullref="' + refName + '">' + escapeHtml(commit.stash.selector.substring(5)) + '</span></span>' + refBranches;
            }
            const commitDot = commit.hash === this.commitHead
                ? '<span class="commitHeadDot" title="' + (branchCheckedOutAtCommit !== null
                    ? 'The branch ' + escapeHtml('"' + branchCheckedOutAtCommit + '"') + ' is currently checked out at this commit'
                    : 'This commit is currently checked out') + '."></span>'
                : '';
            html += '<tr class="commit' + (commit.hash === currentHash ? ' current' : '') + (mutedCommits[i] ? ' mute' : '') + (dimmedCommits[i] ? ' pathDimmed' : '') + '"' + (commit.hash !== UNCOMMITTED ? '' : ' id="uncommittedChanges"') + ' data-id="' + i + '" data-color="' + vertexColours[i] + '">' +
                (this.config.referenceLabels.branchLabelsAlignedToGraph ? '<td>' + getResizeColHtml(0) + (refBranches !== '' ? '<span style="margin-left:' + (widthsAtVertices[i] - 4) + 'px"' + refBranches.substring(5) : '') + '</td><td>' + getResizeColHtml(1) + '<span class="description">' + commitDot : '<td>' + getResizeColHtml(0) + '</td><td>' + getResizeColHtml(1) + '<span class="description">' + commitDot + refBranches) + (this.config.referenceLabels.tagLabelsOnRight ? message + refTags : refTags + message) + '</span></td>' +
                (colVisibility.date ? '<td class="dateCol text" title="' + date.title + '">' + getResizeColHtml(2) + date.formatted + '</td>' : '') +
                (colVisibility.author ? '<td class="authorCol text" title="' + escapeHtml(commit.author + ' <' + commit.email + '>') + '">' + getResizeColHtml(3) + (this.config.fetchAvatars ? '<span class="avatar" data-email="' + escapeHtml(commit.email) + '">' + (typeof this.avatars[commit.email] === 'string' ? '<img class="avatarImg" src="' + this.avatars[commit.email] + '">' : '') + '</span>' : '') + escapeHtml(commit.author) + '</td>' : '') +
                (colVisibility.commit ? '<td class="text" title="' + escapeHtml(commit.hash) + '">' + getResizeColHtml(4) + abbrevCommit(commit.hash) + '</td>' : '') +
                '</tr>';
        }
        function getResizeColHtml(col) {
            return (col > 0 ? '<span class="resizeCol left" data-col="' + (col - 1) + '"></span>' : '') + (col < 4 ? '<span class="resizeCol right" data-col="' + col + '"></span>' : '');
        }
        this.tableElem.innerHTML = '<table>' + html + '</table>';
        this.footerElem.innerHTML = this.moreCommitsAvailable ? '<div id="loadMoreCommitsBtn" class="roundedBtn">Load More Commits</div>' : '';
        this.makeTableResizable();
        this.findWidget.refresh();
        this.renderedGitBranchHead = this.gitBranchHead;
        if (this.moreCommitsAvailable) {
            document.getElementById('loadMoreCommitsBtn').addEventListener('click', () => {
                this.loadMoreCommits();
            });
        }
        if (this.expandedCommit !== null) {
            const expandedCommit = this.expandedCommit, elems = getCommitElems();
            const commitElem = findCommitElemWithId(elems, this.getCommitId(expandedCommit.commitHash));
            const compareWithElem = expandedCommit.compareWithHash !== null ? findCommitElemWithId(elems, this.getCommitId(expandedCommit.compareWithHash)) : null;
            if (commitElem === null || (expandedCommit.compareWithHash !== null && compareWithElem === null)) {
                this.closeCommitDetails(false);
                this.saveState();
            }
            else {
                expandedCommit.index = parseInt(commitElem.dataset.id);
                expandedCommit.commitElem = commitElem;
                expandedCommit.compareWithElem = compareWithElem;
                this.saveState();
                if (expandedCommit.compareWithHash === null) {
                    if (!expandedCommit.loading && expandedCommit.commitDetails !== null && expandedCommit.fileTree !== null) {
                        this.showCommitDetails(expandedCommit.commitDetails, expandedCommit.fileTree, expandedCommit.avatar, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
                        if (expandedCommit.commitHash === UNCOMMITTED) {
                            this.requestCommitDetails(expandedCommit.commitHash, true);
                        }
                    }
                    else {
                        this.loadCommitDetails(commitElem);
                    }
                }
                else {
                    if (!expandedCommit.loading && expandedCommit.fileChanges !== null && expandedCommit.fileTree !== null) {
                        this.showCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, expandedCommit.fileChanges, expandedCommit.fileTree, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
                        if (expandedCommit.commitHash === UNCOMMITTED || expandedCommit.compareWithHash === UNCOMMITTED) {
                            this.requestCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, true);
                        }
                    }
                    else {
                        this.loadCommitComparison(commitElem, compareWithElem);
                    }
                }
            }
        }
        if (this.selectedCommits.size > 0) {
            this.selectedCommits.forEach(commitHash => {
                const commitIndex = this.commitLookup[commitHash];
                if (commitIndex !== undefined) {
                    const commitElem = document.querySelector(`tr.commit[data-id="${commitIndex}"]`);
                    if (commitElem) {
                        commitElem.classList.add('commitSelected');
                    }
                }
            });
        }
        if (this.config.stickyHeader) {
            this.tableColHeadersElem = document.getElementById('tableColHeaders');
            this.alignTableHeaderToControls();
        }
    }
    renderUncommittedChanges() {
        const colVisibility = this.getColumnVisibility(), date = formatShortDate(this.commits[0].date);
        document.getElementById('uncommittedChanges').innerHTML = '<td></td><td><b>' + escapeHtml(this.commits[0].message) + '</b></td>' +
            (colVisibility.date ? '<td class="dateCol text" title="' + date.title + '">' + date.formatted + '</td>' : '') +
            (colVisibility.author ? '<td class="authorCol text" title="* <>">*</td>' : '') +
            (colVisibility.commit ? '<td class="text" title="*">*</td>' : '');
    }
    renderFetchButton() {
        alterClass(this.controlsElem, CLASS_FETCH_SUPPORTED, this.gitRemotes.length > 0);
    }
    renderRefreshButton() {
        const enabled = !this.currentRepoRefreshState.inProgress;
        this.refreshBtnElem.title = enabled ? 'Refresh' : 'Refreshing';
        this.refreshBtnElem.innerHTML = enabled ? SVG_ICONS.refresh : SVG_ICONS.loading;
        alterClass(this.refreshBtnElem, CLASS_REFRESHING, !enabled);
    }
    renderTagDetails(tagName, commitHash, details) {
        const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
            commits: true,
            emoji: true,
            issueLinking: true,
            markdown: this.config.markdown,
            multiline: true,
            urls: true
        });
        dialog.showMessage('Tag <b><i>' + escapeHtml(tagName) + '</i></b><br><span class="messageContent">' +
            '<b>Object: </b>' + escapeHtml(details.hash) + '<br>' +
            '<b>Commit: </b>' + escapeHtml(commitHash) + '<br>' +
            '<b>Tagger: </b>' + escapeHtml(details.taggerName) + ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(details.taggerEmail) + '" tabindex="-1">' + escapeHtml(details.taggerEmail) + '</a>&gt;' + (details.signature !== null ? generateSignatureHtml(details.signature) : '') + '<br>' +
            '<b>Date: </b>' + formatLongDate(details.taggerDate) + '<br><br>' +
            textFormatter.format(details.message) +
            '</span>');
    }
    renderRepoDropdownOptions(repo) {
        this.repoDropdown.setOptions(getRepoDropdownOptions(this.gitRepos), [repo || this.currentRepo]);
    }
    getBranchContextMenuActions(target) {
        const refName = target.ref, visibility = this.config.contextMenuActionsVisibility.branch;
        const isSelectedInBranchesDropdown = this.branchDropdown.isSelected(refName);
        return [[
                {
                    title: 'Checkout Branch',
                    visible: visibility.checkout && this.gitBranchHead !== refName,
                    onClick: () => this.checkoutBranchAction(refName, null, null, target)
                }, {
                    title: 'Rename Branch' + ELLIPSIS,
                    visible: visibility.rename,
                    onClick: () => {
                        dialog.showRefInput('Enter the new name for branch <b><i>' + escapeHtml(refName) + '</i></b>:', refName, 'Rename Branch', (newName) => {
                            runAction({ command: 'renameBranch', repo: this.currentRepo, oldName: refName, newName: newName }, 'Renaming Branch');
                        }, target);
                    }
                }, {
                    title: 'Create Branch' + ELLIPSIS,
                    visible: visibility.createBranch,
                    onClick: () => this.createBranchAction(target.hash, '', true, target)
                }, {
                    title: 'Delete Branch' + ELLIPSIS,
                    visible: visibility.delete && this.gitBranchHead !== refName,
                    onClick: () => {
                        let remotesWithBranch = this.gitRemotes.filter(remote => this.gitBranches.includes('remotes/' + remote + '/' + refName));
                        let inputs = [{ type: 4, name: 'Force Delete', value: this.config.dialogDefaults.deleteBranch.forceDelete }];
                        if (remotesWithBranch.length > 0) {
                            inputs.push({
                                type: 4,
                                name: 'Delete this branch on the remote' + (this.gitRemotes.length > 1 ? 's' : ''),
                                value: false,
                                info: 'This branch is on the remote' + (remotesWithBranch.length > 1 ? 's: ' : ' ') + formatCommaSeparatedList(remotesWithBranch.map((remote) => '"' + remote + '"'))
                            });
                        }
                        dialog.showForm('Are you sure you want to delete the branch <b><i>' + escapeHtml(refName) + '</i></b>?', inputs, 'Yes, delete', (values) => {
                            runAction({ command: 'deleteBranch', repo: this.currentRepo, branchName: refName, forceDelete: values[0], deleteOnRemotes: remotesWithBranch.length > 0 && values[1] ? remotesWithBranch : [] }, 'Deleting Branch');
                        }, target);
                    }
                }, {
                    title: 'Merge into current branch' + ELLIPSIS,
                    visible: visibility.merge && this.gitBranchHead !== refName,
                    onClick: () => this.mergeAction(refName, refName, "Branch", target)
                }, {
                    title: 'Rebase current Branch on Branch' + ELLIPSIS,
                    visible: visibility.rebase && this.gitBranchHead !== refName,
                    onClick: () => this.rebaseAction(refName, refName, "Branch", target)
                }, {
                    title: 'Push Branch' + ELLIPSIS,
                    visible: visibility.push && this.gitRemotes.length > 0,
                    onClick: () => {
                        const multipleRemotes = this.gitRemotes.length > 1;
                        const inputs = [
                            { type: 4, name: 'Set Upstream', value: true },
                            { type: 4, name: 'No Verify', value: false },
                            {
                                type: 3,
                                name: 'Push Mode',
                                options: [
                                    { name: 'Normal', value: "" },
                                    { name: 'Force With Lease', value: "force-with-lease" },
                                    { name: 'Force', value: "force" }
                                ],
                                default: ""
                            }
                        ];
                        if (multipleRemotes) {
                            inputs.unshift({
                                type: 2,
                                name: 'Push to Remote(s)',
                                defaults: [this.getPushRemote(refName)],
                                options: this.gitRemotes.map((remote) => ({ name: remote, value: remote })),
                                multiple: true
                            });
                        }
                        dialog.showForm('Are you sure you want to push the branch <b><i>' + escapeHtml(refName) + '</i></b>' + (multipleRemotes ? '' : ' to the remote <b><i>' + escapeHtml(this.gitRemotes[0]) + '</i></b>') + '?', inputs, 'Yes, push', (values) => {
                            const remotes = multipleRemotes ? values.shift() : [this.gitRemotes[0]];
                            const setUpstream = values[0];
                            const noVerify = values[1];
                            runAction({
                                command: 'pushBranch',
                                repo: this.currentRepo,
                                branchName: refName,
                                remotes: remotes,
                                setUpstream: setUpstream,
                                mode: values[2],
                                noVerify: noVerify,
                                willUpdateBranchConfig: setUpstream && remotes.length > 0 && (this.gitConfig === null || typeof this.gitConfig.branches[refName] === 'undefined' || this.gitConfig.branches[refName].remote !== remotes[remotes.length - 1])
                            }, 'Pushing Branch');
                        }, target);
                    }
                }, {
                    title: 'Pull Branch' + ELLIPSIS,
                    visible: visibility.pull && this.gitRemotes.length > 0,
                    onClick: () => {
                        const trackingRemote = this.getRemoteForBranch(refName);
                        if (!trackingRemote) {
                            dialog.showError('Cannot pull branch <b><i>' + escapeHtml(refName) + '</i></b> because it is not tracking a remote branch. You may need to set an upstream branch first.', 'Pull Branch', null, null);
                            return;
                        }
                        dialog.showForm('Are you sure you want to update the local branch <b><i>' + escapeHtml(refName) + '</i></b> with the latest changes from <b><i>' + escapeHtml(trackingRemote + '/' + refName) + '</i></b>?', [{
                                type: 4,
                                name: 'Force Update',
                                value: this.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,
                                info: 'Force the local branch to be reset to the remote branch (discard local commits).'
                            }], 'Yes, update', (values) => {
                            runAction({ command: 'fetchIntoLocalBranch', repo: this.currentRepo, remote: trackingRemote, remoteBranch: refName, localBranch: refName, force: values[0] }, 'Updating Branch');
                        }, target);
                    }
                }
            ], [
                this.getViewIssueAction(refName, visibility.viewIssue, target),
                {
                    title: 'Create Pull Request' + ELLIPSIS,
                    visible: visibility.createPullRequest && this.gitRepos[this.currentRepo].pullRequestConfig !== null,
                    onClick: () => {
                        const config = this.gitRepos[this.currentRepo].pullRequestConfig;
                        if (config === null)
                            return;
                        dialog.showCheckbox('Are you sure you want to create a Pull Request for branch <b><i>' + escapeHtml(refName) + '</i></b>?', 'Push branch before creating the Pull Request', true, 'Yes, create Pull Request', (push) => {
                            runAction({ command: 'createPullRequest', repo: this.currentRepo, config: config, sourceRemote: config.sourceRemote, sourceOwner: config.sourceOwner, sourceRepo: config.sourceRepo, sourceBranch: refName, push: push }, 'Creating Pull Request');
                        }, target);
                    }
                }
            ], [
                {
                    title: 'Create Archive',
                    visible: visibility.createArchive,
                    onClick: () => {
                        runAction({ command: 'createArchive', repo: this.currentRepo, ref: refName }, 'Creating Archive');
                    }
                },
                {
                    title: 'Select in Branches Dropdown',
                    visible: visibility.selectInBranchesDropdown && (!isSelectedInBranchesDropdown || this.branchDropdown.isShowAllSelected()),
                    onClick: (e) => this.branchDropdown.selectOption(refName, e)
                },
                {
                    title: 'Unselect in Branches Dropdown',
                    visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
                    onClick: () => this.branchDropdown.unselectOption(refName)
                }
            ], [
                {
                    title: 'Copy Branch Name to Clipboard',
                    visible: visibility.copyName,
                    onClick: () => {
                        sendMessage({ command: 'copyToClipboard', type: 'Branch Name', data: refName });
                    }
                }
            ]];
    }
    getMultiSelectCommitContextMenuActions(target) {
        const visibility = this.config.contextMenuActionsVisibility.commit;
        const multiSelectActions = [];
        if (this.areSelectedCommitsContiguous() && this.areSelectedCommitsOnCurrentBranch()) {
            multiSelectActions.push({
                title: 'Squash Selected Commits' + ELLIPSIS,
                visible: true,
                onClick: () => this.squashCommitsAction(target)
            });
        }
        if (this.dropCommitsPossible() && this.areSelectedCommitsOnCurrentBranch()) {
            multiSelectActions.push({
                title: 'Drop Selected Commits' + ELLIPSIS,
                visible: visibility.drop,
                onClick: () => this.dropSelectedCommitsAction(target)
            });
        }
        return multiSelectActions.length > 0 ? [multiSelectActions] : [];
    }
    getCommitContextMenuActions(target) {
        const hash = target.hash, visibility = this.config.contextMenuActionsVisibility.commit;
        const commit = this.commits[this.commitLookup[hash]];
        let actions = [];
        return [...actions, [
                {
                    title: 'Add Tag' + ELLIPSIS,
                    visible: visibility.addTag,
                    onClick: () => this.addTagAction(hash, '', this.config.dialogDefaults.addTag.type, '', null, target)
                }, {
                    title: 'Create Branch' + ELLIPSIS,
                    visible: visibility.createBranch,
                    onClick: () => this.createBranchAction(hash, '', this.config.dialogDefaults.createBranch.checkout, target)
                }
            ], [
                {
                    title: 'Checkout' + (globalState.alwaysAcceptCheckoutCommit ? '' : ELLIPSIS),
                    visible: visibility.checkout,
                    onClick: () => {
                        const checkoutCommit = () => runAction({ command: 'checkoutCommit', repo: this.currentRepo, commitHash: hash }, 'Checking out Commit');
                        if (globalState.alwaysAcceptCheckoutCommit) {
                            checkoutCommit();
                        }
                        else {
                            dialog.showCheckbox('Are you sure you want to checkout commit <b><i>' + abbrevCommit(hash) + '</i></b>? This will result in a \'detached HEAD\' state.', 'Always Accept', false, 'Yes, checkout', (alwaysAccept) => {
                                if (alwaysAccept) {
                                    updateGlobalViewState('alwaysAcceptCheckoutCommit', true);
                                }
                                checkoutCommit();
                            }, target);
                        }
                    }
                }, {
                    title: 'Cherry Pick' + ELLIPSIS,
                    visible: visibility.cherrypick,
                    onClick: () => {
                        const isMerge = commit.parents.length > 1;
                        let inputs = [];
                        if (isMerge) {
                            let options = commit.parents.map((hash, index) => ({
                                name: abbrevCommit(hash) + (typeof this.commitLookup[hash] === 'number' ? ': ' + this.commits[this.commitLookup[hash]].message : ''),
                                value: (index + 1).toString()
                            }));
                            inputs.push({
                                type: 2,
                                name: 'Parent Hash',
                                options: options,
                                default: '1',
                                info: 'Choose the parent hash on the main branch, to cherry pick the commit relative to.'
                            });
                        }
                        inputs.push({
                            type: 4,
                            name: 'Record Origin',
                            value: this.config.dialogDefaults.cherryPick.recordOrigin,
                            info: 'Record that this commit was the origin of the cherry pick by appending a line to the original commit message that states "(cherry picked from commit ...​)".'
                        }, {
                            type: 4,
                            name: 'No Commit',
                            value: this.config.dialogDefaults.cherryPick.noCommit,
                            info: 'Cherry picked changes will be staged but not committed, so that you can select and commit specific parts of this commit.'
                        });
                        dialog.showForm('Are you sure you want to cherry pick commit <b><i>' + abbrevCommit(hash) + '</i></b>?', inputs, 'Yes, cherry pick', (values) => {
                            let parentIndex = isMerge ? parseInt(values.shift()) : 0;
                            runAction({
                                command: 'cherrypickCommit',
                                repo: this.currentRepo,
                                commitHash: hash,
                                parentIndex: parentIndex,
                                recordOrigin: values[0],
                                noCommit: values[1]
                            }, 'Cherry picking Commit');
                        }, target);
                    }
                }, {
                    title: 'Revert' + ELLIPSIS,
                    visible: visibility.revert,
                    onClick: () => {
                        if (commit.parents.length > 1) {
                            let options = commit.parents.map((hash, index) => ({
                                name: abbrevCommit(hash) + (typeof this.commitLookup[hash] === 'number' ? ': ' + this.commits[this.commitLookup[hash]].message : ''),
                                value: (index + 1).toString()
                            }));
                            dialog.showSelect('Are you sure you want to revert merge commit <b><i>' + abbrevCommit(hash) + '</i></b>? Choose the parent hash on the main branch, to revert the commit relative to:', '1', options, 'Yes, revert', (parentIndex) => {
                                runAction({ command: 'revertCommit', repo: this.currentRepo, commitHash: hash, parentIndex: parseInt(parentIndex) }, 'Reverting Commit');
                            }, target);
                        }
                        else {
                            dialog.showConfirmation('Are you sure you want to revert commit <b><i>' + abbrevCommit(hash) + '</i></b>?', 'Yes, revert', () => {
                                runAction({ command: 'revertCommit', repo: this.currentRepo, commitHash: hash, parentIndex: 0 }, 'Reverting Commit');
                            }, target);
                        }
                    }
                }, {
                    title: 'Edit Message' + ELLIPSIS,
                    visible: visibility.editMessage && this.areSelectedCommitsOnCurrentBranch(),
                    onClick: () => this.editCommitMessageAction(target)
                }, {
                    title: 'Reset Last Commit' + ELLIPSIS,
                    visible: visibility.undo && hash === this.commitHead,
                    onClick: () => {
                        dialog.showConfirmation('Are you sure you want to reset the last commit? This will keep all changes from the commit as uncommitted changes.', 'Yes, reset the last commit', () => {
                            runAction({ command: 'undoLastCommit', repo: this.currentRepo }, 'Resetting Last Commit');
                        }, target);
                    }
                }, {
                    title: 'Drop' + ELLIPSIS,
                    visible: visibility.drop && this.graph.dropCommitPossible(this.commitLookup[hash]),
                    onClick: () => {
                        dialog.showConfirmation('Are you sure you want to permanently drop commit <b><i>' + abbrevCommit(hash) + '</i></b>?' + (this.onlyFollowFirstParent ? '<br/><i>Note: By enabling "Only follow the first parent of commits", some commits may have been hidden from the Git Graph View that could affect the outcome of performing this action.</i>' : ''), 'Yes, drop', () => {
                            runAction({ command: 'dropCommit', repo: this.currentRepo, commitHash: hash }, 'Dropping Commit');
                        }, target);
                    }
                }
            ], [
                {
                    title: 'Merge into current branch' + ELLIPSIS,
                    visible: visibility.merge,
                    onClick: () => this.mergeAction(hash, abbrevCommit(hash), "Commit", target)
                }, {
                    title: 'Rebase' + ELLIPSIS,
                    visible: visibility.rebase,
                    onClick: () => this.rebaseAction(hash, abbrevCommit(hash), "Commit", target)
                }, {
                    title: 'Reset current branch to this Commit' + ELLIPSIS,
                    visible: visibility.reset,
                    onClick: () => {
                        dialog.showSelect('Are you sure you want to reset ' + (this.gitBranchHead !== null ? '<b><i>' + escapeHtml(this.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + ' to commit <b><i>' + abbrevCommit(hash) + '</i></b>?', this.config.dialogDefaults.resetCommit.mode, [
                            { name: 'Soft - Keep all changes, but reset head', value: "soft" },
                            { name: 'Mixed - Keep working tree, but reset index', value: "mixed" },
                            { name: 'Hard - Discard all changes', value: "hard" }
                        ], 'Yes, reset', (mode) => {
                            runAction({ command: 'resetToCommit', repo: this.currentRepo, commit: hash, resetMode: mode }, 'Resetting to Commit');
                        }, target);
                    }
                }
            ], [
                {
                    title: 'Copy Commit Hash to Clipboard',
                    visible: visibility.copyHash,
                    onClick: () => {
                        sendMessage({ command: 'copyToClipboard', type: 'Commit Hash', data: hash });
                    }
                },
                {
                    title: 'Copy Commit Subject to Clipboard',
                    visible: visibility.copySubject,
                    onClick: () => {
                        sendMessage({ command: 'copyToClipboard', type: 'Commit Subject', data: commit.message });
                    }
                }
            ]];
    }
    getRemoteBranchContextMenuActions(remote, target) {
        const refName = target.ref, visibility = this.config.contextMenuActionsVisibility.remoteBranch;
        const branchName = remote !== '' ? refName.substring(remote.length + 1) : '';
        const prefixedRefName = 'remotes/' + refName;
        const isSelectedInBranchesDropdown = this.branchDropdown.isSelected(prefixedRefName);
        return [[
                {
                    title: 'Checkout Branch' + ELLIPSIS,
                    visible: visibility.checkout,
                    onClick: () => this.checkoutBranchAction(refName, remote, null, target)
                }, {
                    title: 'Create Branch' + ELLIPSIS,
                    visible: visibility.createBranch,
                    onClick: () => this.createBranchAction(target.hash, branchName, true, target)
                }, {
                    title: 'Delete Remote Branch' + ELLIPSIS,
                    visible: visibility.delete && remote !== '',
                    onClick: () => {
                        dialog.showConfirmation('Are you sure you want to delete the remote branch <b><i>' + escapeHtml(refName) + '</i></b>?', 'Yes, delete', () => {
                            runAction({ command: 'deleteRemoteBranch', repo: this.currentRepo, branchName: branchName, remote: remote }, 'Deleting Remote Branch');
                        }, target);
                    }
                }, {
                    title: 'Fetch into local branch' + ELLIPSIS,
                    visible: visibility.fetch && remote !== '' && this.gitBranches.includes(branchName) && this.gitBranchHead !== branchName,
                    onClick: () => {
                        dialog.showForm('Are you sure you want to fetch the remote branch <b><i>' + escapeHtml(refName) + '</i></b> into the local branch <b><i>' + escapeHtml(branchName) + '</i></b>?', [{
                                type: 4,
                                name: 'Force Fetch',
                                value: this.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,
                                info: 'Force the local branch to be reset to this remote branch.'
                            }], 'Yes, fetch', (values) => {
                            runAction({ command: 'fetchIntoLocalBranch', repo: this.currentRepo, remote: remote, remoteBranch: branchName, localBranch: branchName, force: values[0] }, 'Fetching Branch');
                        }, target);
                    }
                }, {
                    title: 'Merge into current branch' + ELLIPSIS,
                    visible: visibility.merge,
                    onClick: () => this.mergeAction(refName, refName, "Remote-tracking Branch", target)
                }, {
                    title: 'Pull into current branch' + ELLIPSIS,
                    visible: visibility.pull && remote !== '',
                    onClick: () => {
                        dialog.showForm('Are you sure you want to pull the remote branch <b><i>' + escapeHtml(refName) + '</i></b> into ' + (this.gitBranchHead !== null ? '<b><i>' + escapeHtml(this.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + '? If a merge is required:', [
                            { type: 4, name: 'Create a new commit even if fast-forward is possible', value: this.config.dialogDefaults.pullBranch.noFastForward },
                            { type: 4, name: 'Squash Commits', value: this.config.dialogDefaults.pullBranch.squash, info: 'Create a single commit on the current branch whose effect is the same as merging this remote branch.' },
                            { type: 4, name: 'No Verify', value: false, info: 'Skip Git hooks when creating the squash commit. Only applies when "Squash Commits" is enabled.' }
                        ], 'Yes, pull', (values) => {
                            runAction({ command: 'pullBranch', repo: this.currentRepo, branchName: branchName, remote: remote, createNewCommit: values[0], squash: values[1], noVerify: values[2] }, 'Pulling Branch');
                        }, target);
                    }
                }
            ], [
                this.getViewIssueAction(refName, visibility.viewIssue, target),
                {
                    title: 'Create Pull Request',
                    visible: visibility.createPullRequest && this.gitRepos[this.currentRepo].pullRequestConfig !== null && branchName !== 'HEAD' &&
                        (this.gitRepos[this.currentRepo].pullRequestConfig.sourceRemote === remote || this.gitRepos[this.currentRepo].pullRequestConfig.destRemote === remote),
                    onClick: () => {
                        const config = this.gitRepos[this.currentRepo].pullRequestConfig;
                        if (config === null)
                            return;
                        const isDestRemote = config.destRemote === remote;
                        runAction({
                            command: 'createPullRequest',
                            repo: this.currentRepo,
                            config: config,
                            sourceRemote: isDestRemote ? config.destRemote : config.sourceRemote,
                            sourceOwner: isDestRemote ? config.destOwner : config.sourceOwner,
                            sourceRepo: isDestRemote ? config.destRepo : config.sourceRepo,
                            sourceBranch: branchName,
                            push: false
                        }, 'Creating Pull Request');
                    }
                }
            ], [
                {
                    title: 'Create Archive',
                    visible: visibility.createArchive,
                    onClick: () => {
                        runAction({ command: 'createArchive', repo: this.currentRepo, ref: refName }, 'Creating Archive');
                    }
                },
                {
                    title: 'Select in Branches Dropdown',
                    visible: visibility.selectInBranchesDropdown && (!isSelectedInBranchesDropdown || this.branchDropdown.isShowAllSelected()),
                    onClick: (e) => this.branchDropdown.selectOption(prefixedRefName, e)
                },
                {
                    title: 'Unselect in Branches Dropdown',
                    visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
                    onClick: () => this.branchDropdown.unselectOption(prefixedRefName)
                }
            ], [
                {
                    title: 'Copy Branch Name to Clipboard',
                    visible: visibility.copyName,
                    onClick: () => {
                        sendMessage({ command: 'copyToClipboard', type: 'Branch Name', data: refName });
                    }
                }
            ]];
    }
    getStashContextMenuActions(target) {
        const hash = target.hash, selector = target.ref, visibility = this.config.contextMenuActionsVisibility.stash;
        return [[
                {
                    title: 'Apply Stash' + ELLIPSIS,
                    visible: visibility.apply,
                    onClick: () => {
                        dialog.showForm('Are you sure you want to apply the stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b>?', [{
                                type: 4,
                                name: 'Reinstate Index',
                                value: this.config.dialogDefaults.applyStash.reinstateIndex,
                                info: 'Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.'
                            }], 'Yes, apply stash', (values) => {
                            runAction({ command: 'applyStash', repo: this.currentRepo, selector: selector, reinstateIndex: values[0] }, 'Applying Stash');
                        }, target);
                    }
                }, {
                    title: 'Create Branch from Stash' + ELLIPSIS,
                    visible: visibility.createBranch,
                    onClick: () => {
                        dialog.showRefInput('Create a branch from stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b> with the name:', '', 'Create Branch', (branchName) => {
                            runAction({ command: 'branchFromStash', repo: this.currentRepo, selector: selector, branchName: branchName }, 'Creating Branch');
                        }, target);
                    }
                }, {
                    title: 'Pop Stash' + ELLIPSIS,
                    visible: visibility.pop,
                    onClick: () => {
                        dialog.showForm('Are you sure you want to pop the stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b>?', [{
                                type: 4,
                                name: 'Reinstate Index',
                                value: this.config.dialogDefaults.popStash.reinstateIndex,
                                info: 'Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.'
                            }], 'Yes, pop stash', (values) => {
                            runAction({ command: 'popStash', repo: this.currentRepo, selector: selector, reinstateIndex: values[0] }, 'Popping Stash');
                        }, target);
                    }
                }, {
                    title: 'Drop Stash' + ELLIPSIS,
                    visible: visibility.drop,
                    onClick: () => {
                        dialog.showConfirmation('Are you sure you want to drop the stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b>?', 'Yes, drop', () => {
                            runAction({ command: 'dropStash', repo: this.currentRepo, selector: selector }, 'Dropping Stash');
                        }, target);
                    }
                }
            ], [
                {
                    title: 'Copy Stash Name to Clipboard',
                    visible: visibility.copyName,
                    onClick: () => {
                        sendMessage({ command: 'copyToClipboard', type: 'Stash Name', data: selector });
                    }
                }, {
                    title: 'Copy Stash Hash to Clipboard',
                    visible: visibility.copyHash,
                    onClick: () => {
                        sendMessage({ command: 'copyToClipboard', type: 'Stash Hash', data: hash });
                    }
                }
            ]];
    }
    getTagContextMenuActions(isAnnotated, target) {
        const hash = target.hash, tagName = target.ref, visibility = this.config.contextMenuActionsVisibility.tag;
        return [[
                {
                    title: 'View Details',
                    visible: visibility.viewDetails && isAnnotated,
                    onClick: () => {
                        runAction({ command: 'tagDetails', repo: this.currentRepo, tagName: tagName, commitHash: hash }, 'Retrieving Tag Details');
                    }
                }, {
                    title: 'Delete Tag' + ELLIPSIS,
                    visible: visibility.delete,
                    onClick: () => {
                        let message = 'Are you sure you want to delete the tag <b><i>' + escapeHtml(tagName) + '</i></b>?';
                        if (this.gitRemotes.length > 1) {
                            let options = [{ name: 'Don\'t delete on any remote', value: '-1' }];
                            this.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
                            dialog.showSelect(message + '<br>Do you also want to delete the tag on a remote:', '-1', options, 'Yes, delete', remoteIndex => {
                                this.deleteTagAction(tagName, remoteIndex !== '-1' ? this.gitRemotes[parseInt(remoteIndex)] : null);
                            }, target);
                        }
                        else if (this.gitRemotes.length === 1) {
                            dialog.showCheckbox(message, 'Also delete on remote', false, 'Yes, delete', deleteOnRemote => {
                                this.deleteTagAction(tagName, deleteOnRemote ? this.gitRemotes[0] : null);
                            }, target);
                        }
                        else {
                            dialog.showConfirmation(message, 'Yes, delete', () => {
                                this.deleteTagAction(tagName, null);
                            }, target);
                        }
                    }
                }, {
                    title: 'Push Tag' + ELLIPSIS,
                    visible: visibility.push && this.gitRemotes.length > 0,
                    onClick: () => {
                        const runPushTagAction = (remotes) => {
                            runAction({
                                command: 'pushTag',
                                repo: this.currentRepo,
                                tagName: tagName,
                                remotes: remotes,
                                commitHash: hash,
                                skipRemoteCheck: globalState.pushTagSkipRemoteCheck
                            }, 'Pushing Tag');
                        };
                        if (this.gitRemotes.length === 1) {
                            dialog.showConfirmation('Are you sure you want to push the tag <b><i>' + escapeHtml(tagName) + '</i></b> to the remote <b><i>' + escapeHtml(this.gitRemotes[0]) + '</i></b>?', 'Yes, push', () => {
                                runPushTagAction([this.gitRemotes[0]]);
                            }, target);
                        }
                        else if (this.gitRemotes.length > 1) {
                            const defaults = [this.getPushRemote()];
                            const options = this.gitRemotes.map((remote) => ({ name: remote, value: remote }));
                            dialog.showMultiSelect('Are you sure you want to push the tag <b><i>' + escapeHtml(tagName) + '</i></b>? Select the remote(s) to push the tag to:', defaults, options, 'Yes, push', (remotes) => {
                                runPushTagAction(remotes);
                            }, target);
                        }
                    }
                }
            ], [
                {
                    title: 'Create Archive',
                    visible: visibility.createArchive,
                    onClick: () => {
                        runAction({ command: 'createArchive', repo: this.currentRepo, ref: tagName }, 'Creating Archive');
                    }
                },
                {
                    title: 'Copy Tag Name to Clipboard',
                    visible: visibility.copyName,
                    onClick: () => {
                        sendMessage({ command: 'copyToClipboard', type: 'Tag Name', data: tagName });
                    }
                }
            ]];
    }
    getUncommittedChangesContextMenuActions(target) {
        let visibility = this.config.contextMenuActionsVisibility.uncommittedChanges;
        return [[
                {
                    title: 'Stash uncommitted changes' + ELLIPSIS,
                    visible: visibility.stash,
                    onClick: () => {
                        dialog.showForm('Are you sure you want to stash the <b>uncommitted changes</b>?', [
                            { type: 0, name: 'Message', default: '', placeholder: 'Optional' },
                            { type: 4, name: 'Include Untracked', value: this.config.dialogDefaults.stashUncommittedChanges.includeUntracked, info: 'Include all untracked files in the stash, and then clean them from the working directory.' }
                        ], 'Yes, stash', (values) => {
                            runAction({ command: 'pushStash', repo: this.currentRepo, message: values[0], includeUntracked: values[1] }, 'Stashing uncommitted changes');
                        }, target);
                    }
                }
            ], [
                {
                    title: 'Reset uncommitted changes' + ELLIPSIS,
                    visible: visibility.reset,
                    onClick: () => {
                        dialog.showSelect('Are you sure you want to reset the <b>uncommitted changes</b> to <b>HEAD</b>?', this.config.dialogDefaults.resetUncommitted.mode, [
                            { name: 'Mixed - Keep working tree, but reset index', value: "mixed" },
                            { name: 'Hard - Discard all changes', value: "hard" }
                        ], 'Yes, reset', (mode) => {
                            runAction({ command: 'resetToCommit', repo: this.currentRepo, commit: 'HEAD', resetMode: mode }, 'Resetting uncommitted changes');
                        }, target);
                    }
                }, {
                    title: 'Clean untracked files' + ELLIPSIS,
                    visible: visibility.clean,
                    onClick: () => {
                        dialog.showCheckbox('Are you sure you want to clean all untracked files?', 'Clean untracked directories', true, 'Yes, clean', directories => {
                            runAction({ command: 'cleanUntrackedFiles', repo: this.currentRepo, directories: directories }, 'Cleaning untracked files');
                        }, target);
                    }
                }
            ], [
                {
                    title: 'Open Source Control View',
                    visible: visibility.openSourceControlView,
                    onClick: () => {
                        sendMessage({ command: 'viewScm' });
                    }
                }
            ]];
    }
    getViewIssueAction(refName, visible, target) {
        const issueLinks = [];
        let issueLinking, match;
        if (visible && (issueLinking = parseIssueLinkingConfig(this.gitRepos[this.currentRepo].issueLinkingConfig)) !== null) {
            issueLinking.regexp.lastIndex = 0;
            while (match = issueLinking.regexp.exec(refName)) {
                if (match[0].length === 0)
                    break;
                issueLinks.push({
                    url: generateIssueLinkFromMatch(match, issueLinking),
                    displayText: match[0]
                });
            }
        }
        return {
            title: 'View Issue' + (issueLinks.length > 1 ? ELLIPSIS : ''),
            visible: issueLinks.length > 0,
            onClick: () => {
                if (issueLinks.length > 1) {
                    dialog.showSelect('Select which issue you want to view for this branch:', '0', issueLinks.map((issueLink, i) => ({ name: issueLink.displayText, value: i.toString() })), 'View Issue', (value) => {
                        sendMessage({ command: 'openExternalUrl', url: issueLinks[parseInt(value)].url });
                    }, target);
                }
                else if (issueLinks.length === 1) {
                    sendMessage({ command: 'openExternalUrl', url: issueLinks[0].url });
                }
            }
        };
    }
    addTagAction(hash, initialName, initialType, initialMessage, initialPushToRemote, target, isInitialLoad = true) {
        let mostRecentTagsIndex = -1;
        for (let i = 0; i < this.commits.length; i++) {
            if (this.commits[i].tags.length > 0 && (mostRecentTagsIndex === -1 || this.commits[i].date > this.commits[mostRecentTagsIndex].date)) {
                mostRecentTagsIndex = i;
            }
        }
        const mostRecentTags = mostRecentTagsIndex > -1 ? this.commits[mostRecentTagsIndex].tags.map((tag) => '"' + tag.name + '"') : [];
        const inputs = [
            { type: 1, name: 'Name', default: initialName, info: mostRecentTags.length > 0 ? 'The most recent tag' + (mostRecentTags.length > 1 ? 's' : '') + ' in the loaded commits ' + (mostRecentTags.length > 1 ? 'are' : 'is') + ' ' + formatCommaSeparatedList(mostRecentTags) + '.' : undefined },
            { type: 2, name: 'Type', default: initialType === 0 ? 'annotated' : 'lightweight', options: [{ name: 'Annotated', value: 'annotated' }, { name: 'Lightweight', value: 'lightweight' }] },
            { type: 0, name: 'Message', default: initialMessage, placeholder: 'Optional', info: 'A message can only be added to an annotated tag.' }
        ];
        if (this.gitRemotes.length > 1) {
            const options = [{ name: 'Don\'t push', value: '-1' }];
            this.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
            const defaultOption = initialPushToRemote !== null
                ? this.gitRemotes.indexOf(initialPushToRemote)
                : isInitialLoad && this.config.dialogDefaults.addTag.pushToRemote
                    ? this.gitRemotes.indexOf(this.getPushRemote())
                    : -1;
            inputs.push({ type: 2, name: 'Push to remote', options: options, default: defaultOption.toString(), info: 'Once this tag has been added, push it to this remote.' });
        }
        else if (this.gitRemotes.length === 1) {
            const defaultValue = initialPushToRemote !== null || (isInitialLoad && this.config.dialogDefaults.addTag.pushToRemote);
            inputs.push({ type: 4, name: 'Push to remote', value: defaultValue, info: 'Once this tag has been added, push it to the repositories remote.' });
        }
        dialog.showForm('Add tag to commit <b><i>' + abbrevCommit(hash) + '</i></b>:', inputs, 'Add Tag', (values) => {
            const tagName = values[0];
            const type = values[1] === 'annotated' ? 0 : 1;
            const message = values[2];
            const pushToRemote = this.gitRemotes.length > 1 && values[3] !== '-1'
                ? this.gitRemotes[parseInt(values[3])]
                : this.gitRemotes.length === 1 && values[3]
                    ? this.gitRemotes[0]
                    : null;
            const runAddTagAction = (force) => {
                runAction({
                    command: 'addTag',
                    repo: this.currentRepo,
                    tagName: tagName,
                    commitHash: hash,
                    type: type,
                    message: message,
                    pushToRemote: pushToRemote,
                    pushSkipRemoteCheck: globalState.pushTagSkipRemoteCheck,
                    force: force
                }, 'Adding Tag');
            };
            if (this.gitTags.includes(tagName)) {
                dialog.showTwoButtons('A tag named <b><i>' + escapeHtml(tagName) + '</i></b> already exists, do you want to replace it with this new tag?', 'Yes, replace the existing tag', () => {
                    runAddTagAction(true);
                }, 'No, choose another tag name', () => {
                    this.addTagAction(hash, tagName, type, message, pushToRemote, target, false);
                }, target);
            }
            else {
                runAddTagAction(false);
            }
        }, target);
    }
    checkoutBranchAction(refName, remote, prefillName, target) {
        if (remote !== null) {
            dialog.showRefInput('Enter the name of the new branch you would like to create when checking out <b><i>' + escapeHtml(refName) + '</i></b>:', (prefillName !== null ? prefillName : (remote !== '' ? refName.substring(remote.length + 1) : refName)), 'Checkout Branch', newBranch => {
                if (this.gitBranches.includes(newBranch)) {
                    const canPullFromRemote = remote !== '';
                    dialog.showTwoButtons('The name <b><i>' + escapeHtml(newBranch) + '</i></b> is already used by another branch:', 'Choose another branch name', () => {
                        this.checkoutBranchAction(refName, remote, newBranch, target);
                    }, 'Checkout the existing branch' + (canPullFromRemote ? ' & pull changes' : ''), () => {
                        runAction({
                            command: 'checkoutBranch',
                            repo: this.currentRepo,
                            branchName: newBranch,
                            remoteBranch: null,
                            pullAfterwards: canPullFromRemote
                                ? {
                                    branchName: refName.substring(remote.length + 1),
                                    remote: remote,
                                    createNewCommit: this.config.dialogDefaults.pullBranch.noFastForward,
                                    squash: this.config.dialogDefaults.pullBranch.squash,
                                    noVerify: false
                                }
                                : null
                        }, 'Checking out Branch' + (canPullFromRemote ? ' & Pulling Changes' : ''));
                    }, target);
                }
                else {
                    runAction({ command: 'checkoutBranch', repo: this.currentRepo, branchName: newBranch, remoteBranch: refName, pullAfterwards: null }, 'Checking out Branch');
                }
            }, target);
        }
        else {
            runAction({ command: 'checkoutBranch', repo: this.currentRepo, branchName: refName, remoteBranch: null, pullAfterwards: null }, 'Checking out Branch');
        }
    }
    createBranchAction(hash, initialName, initialCheckOut, target) {
        dialog.showForm('Create branch at commit <b><i>' + abbrevCommit(hash) + '</i></b>:', [
            { type: 1, name: 'Name', default: initialName },
            { type: 4, name: 'Check out', value: initialCheckOut }
        ], 'Create Branch', (values) => {
            const branchName = values[0], checkOut = values[1];
            if (this.gitBranches.includes(branchName)) {
                dialog.showTwoButtons('A branch named <b><i>' + escapeHtml(branchName) + '</i></b> already exists, do you want to replace it with this new branch?', 'Yes, replace the existing branch', () => {
                    runAction({ command: 'createBranch', repo: this.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: true }, 'Creating Branch');
                }, 'No, choose another branch name', () => {
                    this.createBranchAction(hash, branchName, checkOut, target);
                }, target);
            }
            else {
                runAction({ command: 'createBranch', repo: this.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: false }, 'Creating Branch');
            }
        }, target);
    }
    deleteTagAction(refName, deleteOnRemote) {
        runAction({ command: 'deleteTag', repo: this.currentRepo, tagName: refName, deleteOnRemote: deleteOnRemote }, 'Deleting Tag');
    }
    fetchFromRemotesAction() {
        runAction({ command: 'fetch', repo: this.currentRepo, name: null, prune: this.config.fetchAndPrune, pruneTags: this.config.fetchAndPruneTags }, 'Fetching from Remote(s)');
    }
    mergeAction(obj, name, actionOn, target) {
        dialog.showForm('Are you sure you want to merge ' + actionOn.toLowerCase() + ' <b><i>' + escapeHtml(name) + '</i></b> into ' + (this.gitBranchHead !== null ? '<b><i>' + escapeHtml(this.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + '?', [
            { type: 4, name: 'Create a new commit even if fast-forward is possible', value: this.config.dialogDefaults.merge.noFastForward },
            { type: 4, name: 'Allow unrelated histories', value: this.config.dialogDefaults.merge.allowUnrelatedHistories, info: 'Allow merging branches from two completely different repositories or branches.' },
            { type: 4, name: 'Squash Commits', value: this.config.dialogDefaults.merge.squash, info: 'Create a single commit on the current branch whose effect is the same as merging this ' + actionOn.toLowerCase() + '.' },
            { type: 4, name: 'No Verify', value: false, info: 'Skip Git hooks when creating the squash commit. Only applies when "Squash Commits" is enabled.' },
            { type: 4, name: 'No Commit', value: this.config.dialogDefaults.merge.noCommit, info: 'The changes of the merge will be staged but not committed, so that you can review and/or modify the merge result before committing.' }
        ], 'Yes, merge', (values) => {
            runAction({ command: 'merge', repo: this.currentRepo, obj: obj, actionOn: actionOn, createNewCommit: values[0], allowUnrelatedHistories: values[1], squash: values[2], noVerify: values[3], noCommit: values[4] }, 'Merging ' + actionOn);
        }, target);
    }
    rebaseAction(obj, name, actionOn, target) {
        dialog.showForm('Are you sure you want to rebase ' + (this.gitBranchHead !== null ? '<b><i>' + escapeHtml(this.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + ' on ' + actionOn.toLowerCase() + ' <b><i>' + escapeHtml(name) + '</i></b>?', [
            {
                type: 3, name: 'Rebase Mode', options: [
                    { name: 'Rebase', value: 'standard' },
                    { name: 'Interactive Rebase (Todo Editor)', value: 'interactive-extension' },
                    { name: 'Interactive Rebase (New Terminal)', value: 'interactive-terminal' }
                ], default: this.config.dialogDefaults.rebase.interactive ? 'interactive-extension' : 'standard'
            },
            { type: 4, name: 'Ignore Date', value: this.config.dialogDefaults.rebase.ignoreDate, info: 'Only applicable to a non-interactive rebase.' },
            { type: 4, name: 'Signed-off-by', value: false, info: 'Add Signed-off-by trailer to rebased commits (--signoff).' }
        ], 'Yes, rebase', (values) => {
            const mode = values[0];
            const signoff = values[2];
            if (mode === 'interactive-extension') {
                this.pendingRebaseTodo = { repo: this.currentRepo, obj: obj, actionOn: actionOn, signoff: signoff };
                dialog.showActionRunning('Loading Rebase Todo List');
                sendMessage({ command: 'getRebaseTodoList', repo: this.currentRepo, obj: obj, actionOn: actionOn });
            }
            else {
                const interactive = mode === 'interactive-terminal';
                runAction({ command: 'rebase', repo: this.currentRepo, obj: obj, actionOn: actionOn, ignoreDate: values[1], interactive: interactive, signoff: signoff }, interactive ? 'Launching Interactive Rebase' : 'Rebasing on ' + actionOn);
            }
        }, target);
    }
    showRebaseTodoEditor(items) {
        if (this.pendingRebaseTodo === null)
            return;
        const ctx = this.pendingRebaseTodo;
        if (items.length === 0) {
            dialog.showError('Nothing to rebase', 'There are no commits in the rebase range.', null, null);
            this.pendingRebaseTodo = null;
            return;
        }
        let html = '<b>Interactive Rebase Todo</b><br><br>';
        html += '<table class="rebaseTodoEditor"><tbody>';
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            html += '<tr data-index="' + i + '" data-hash="' + escapeHtml(item.hash) + '" data-action="pick">'
                + '<td class="dragHandle" title="Drag to reorder">&#x2630;</td>'
                + '<td class="todoHash">' + escapeHtml(item.hash) + '</td>'
                + '<td class="todoAction"><select>'
                + '<option value="pick" selected>pick</option>'
                + '<option value="reword">reword</option>'
                + '<option value="edit">edit</option>'
                + '<option value="squash">squash</option>'
                + '<option value="fixup">fixup</option>'
                + '<option value="drop">drop</option>'
                + '</select></td>'
                + '<td class="todoSubject">' + escapeHtml(item.subject) + '</td>'
                + '</tr>';
        }
        html += '</tbody></table>';
        const cleanup = () => {
            this.pendingRebaseTodo = null;
            if (this.todoDialogDragAbort) {
                this.todoDialogDragAbort.abort();
                this.todoDialogDragAbort = null;
            }
        };
        dialog.showCustom(html, 'Rebase', () => {
            const actionBtn = document.getElementById('dialogAction');
            if (actionBtn && actionBtn.classList.contains('disabled'))
                return;
            const rows = document.querySelectorAll('.rebaseTodoEditor tbody tr');
            const entries = [];
            rows.forEach((row) => {
                const hash = row.dataset.hash;
                const action = row.querySelector('.todoAction select').value;
                entries.push({ hash: hash, action: action });
            });
            sendMessage({ command: 'rebaseInteractive', repo: ctx.repo, obj: ctx.obj, actionOn: ctx.actionOn, entries: entries, signoff: ctx.signoff });
            dialog.close();
            cleanup();
        }, 'Cancel', () => {
            dialog.close();
        }, cleanup);
        this.setupTodoDragAndDrop();
        this.setupTodoActionStyling();
        this.setupTodoDialogDrag();
    }
    setupTodoDragAndDrop() {
        const tbody = document.querySelector('.rebaseTodoEditor tbody');
        if (tbody === null)
            return;
        let dragRow = null;
        const handles = tbody.querySelectorAll('.dragHandle');
        handles.forEach((handle) => {
            handle.addEventListener('mousedown', (e) => {
                const evt = e;
                dragRow = handle.closest('tr');
                if (!dragRow)
                    return;
                dragRow.classList.add('dragging');
                evt.preventDefault();
                let lastInsertRef = dragRow.nextSibling;
                const onMouseMove = (me) => {
                    if (!dragRow)
                        return;
                    const rows = Array.from(tbody.querySelectorAll('tr'));
                    let newRef = null;
                    for (let i = 0; i < rows.length; i++) {
                        if (rows[i] === dragRow)
                            continue;
                        const rect = rows[i].getBoundingClientRect();
                        if (me.clientY < rect.top + rect.height / 2) {
                            newRef = rows[i];
                            break;
                        }
                    }
                    if (newRef === lastInsertRef)
                        return;
                    if (newRef) {
                        tbody.insertBefore(dragRow, newRef);
                    }
                    else {
                        tbody.appendChild(dragRow);
                    }
                    lastInsertRef = newRef;
                    this.updateTodoGrouping();
                };
                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    if (dragRow) {
                        dragRow.classList.remove('dragging');
                        dragRow = null;
                    }
                    this.updateTodoGrouping();
                };
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
    }
    setupTodoActionStyling() {
        const selects = document.querySelectorAll('.rebaseTodoEditor .todoAction select');
        selects.forEach((select) => {
            select.addEventListener('change', () => {
                const row = select.closest('tr');
                if (row) {
                    row.dataset.action = select.value;
                }
                this.updateTodoGrouping();
            });
        });
    }
    updateTodoGrouping() {
        const rows = document.querySelectorAll('.rebaseTodoEditor tbody tr');
        let hasError = false;
        rows.forEach((row) => {
            row.classList.remove('groupStart', 'groupMember', 'groupLast', 'todoError');
        });
        for (let i = 0; i < rows.length; i++) {
            const action = rows[i].dataset.action;
            if (action === 'squash' || action === 'fixup') {
                let hasParent = false;
                for (let j = i - 1; j >= 0; j--) {
                    const prevAction = rows[j].dataset.action;
                    if (prevAction !== 'squash' && prevAction !== 'fixup') {
                        hasParent = true;
                        rows[j].classList.add('groupStart');
                        break;
                    }
                }
                if (!hasParent) {
                    rows[i].classList.add('todoError');
                    hasError = true;
                }
                else {
                    rows[i].classList.add('groupMember');
                }
                const nextAction = i + 1 < rows.length ? rows[i + 1].dataset.action : null;
                if (nextAction !== 'squash' && nextAction !== 'fixup') {
                    rows[i].classList.add('groupLast');
                }
            }
        }
        const actionBtn = document.getElementById('dialogAction');
        if (actionBtn) {
            if (hasError) {
                actionBtn.classList.add('disabled');
                actionBtn.title = 'squash/fixup cannot be the first action — needs a preceding pick/reword/edit';
            }
            else {
                actionBtn.classList.remove('disabled');
                actionBtn.title = '';
            }
        }
    }
    setupTodoDialogDrag() {
        const dialogElem = document.querySelector('.dialog:has(.rebaseTodoEditor)');
        if (dialogElem === null)
            return;
        let isDragging = false, offsetX = 0, offsetY = 0;
        const ac = new AbortController();
        const titleElem = dialogElem.querySelector('.dialogContent > b');
        if (titleElem === null)
            return;
        titleElem.addEventListener('mousedown', (e) => {
            const me = e;
            isDragging = true;
            const rect = dialogElem.getBoundingClientRect();
            offsetX = me.clientX - rect.left;
            offsetY = me.clientY - rect.top;
            dialogElem.style.transform = 'none';
            dialogElem.style.left = rect.left + 'px';
            dialogElem.style.top = rect.top + 'px';
            me.preventDefault();
        }, { signal: ac.signal });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging)
                return;
            dialogElem.style.left = (e.clientX - offsetX) + 'px';
            dialogElem.style.top = (e.clientY - offsetY) + 'px';
        }, { signal: ac.signal });
        document.addEventListener('mouseup', () => {
            isDragging = false;
        }, { signal: ac.signal });
        this.todoDialogDragAbort = ac;
    }
    makeTableResizable() {
        let colHeadersElem = document.getElementById('tableColHeaders'), cols = document.getElementsByClassName('tableColHeader');
        let columnWidths, mouseX = -1, col = -1, colIndex = -1;
        const makeTableFixedLayout = () => {
            cols[0].style.width = columnWidths[0] + 'px';
            cols[0].style.padding = '';
            for (let i = 2; i < cols.length; i++) {
                cols[i].style.width = columnWidths[parseInt(cols[i].dataset.col)] + 'px';
            }
            this.tableElem.className = 'fixedLayout';
            this.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
            this.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
        };
        for (let i = 0; i < cols.length; i++) {
            let col = parseInt(cols[i].dataset.col);
            cols[i].innerHTML += (i > 0 ? '<span class="resizeCol left" data-col="' + (col - 1) + '"></span>' : '') + (i < cols.length - 1 ? '<span class="resizeCol right" data-col="' + col + '"></span>' : '');
        }
        let cWidths = this.gitRepos[this.currentRepo].columnWidths;
        if (cWidths === null) {
            let defaults = this.config.defaultColumnVisibility;
            columnWidths = [COLUMN_AUTO, COLUMN_AUTO, defaults.date ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.author ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.commit ? COLUMN_AUTO : COLUMN_HIDDEN];
            this.saveColumnWidths(columnWidths);
        }
        else {
            columnWidths = [cWidths[0], COLUMN_AUTO, cWidths[1], cWidths[2], cWidths[3]];
        }
        if (columnWidths[0] !== COLUMN_AUTO) {
            makeTableFixedLayout();
        }
        else {
            this.tableElem.className = 'autoLayout';
            let colWidth = cols[0].offsetWidth, graphWidth = this.graph.getContentWidth();
            let maxWidth = Math.round(this.viewElem.clientWidth * 0.333);
            if (Math.max(graphWidth, colWidth) > maxWidth) {
                this.graph.limitMaxWidth(maxWidth);
                graphWidth = maxWidth;
                this.tableElem.className += ' limitGraphWidth';
                this.tableElem.style.setProperty(CSS_PROP_LIMIT_GRAPH_WIDTH, maxWidth + 'px');
            }
            else {
                this.graph.limitMaxWidth(-1);
                this.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
            }
            if (colWidth < Math.max(graphWidth, 64)) {
                cols[0].style.padding = '6px ' + Math.floor((Math.max(graphWidth, 64) - (colWidth - COLUMN_LEFT_RIGHT_PADDING)) / 2) + 'px';
            }
        }
        const processResizingColumn = (e) => {
            if (col > -1) {
                let mouseEvent = e;
                let mouseDeltaX = mouseEvent.clientX - mouseX;
                if (col === 0) {
                    if (columnWidths[0] + mouseDeltaX < COLUMN_MIN_WIDTH)
                        mouseDeltaX = -columnWidths[0] + COLUMN_MIN_WIDTH;
                    if (cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - mouseDeltaX < COLUMN_MIN_WIDTH)
                        mouseDeltaX = cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - COLUMN_MIN_WIDTH;
                    columnWidths[0] += mouseDeltaX;
                    cols[0].style.width = columnWidths[0] + 'px';
                    this.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
                }
                else {
                    let colWidth = col !== 1 ? columnWidths[col] : cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING;
                    let nextCol = col + 1;
                    while (columnWidths[nextCol] === COLUMN_HIDDEN)
                        nextCol++;
                    if (colWidth + mouseDeltaX < COLUMN_MIN_WIDTH)
                        mouseDeltaX = -colWidth + COLUMN_MIN_WIDTH;
                    if (columnWidths[nextCol] - mouseDeltaX < COLUMN_MIN_WIDTH)
                        mouseDeltaX = columnWidths[nextCol] - COLUMN_MIN_WIDTH;
                    if (col !== 1) {
                        columnWidths[col] += mouseDeltaX;
                        cols[colIndex].style.width = columnWidths[col] + 'px';
                    }
                    columnWidths[nextCol] -= mouseDeltaX;
                    cols[colIndex + 1].style.width = columnWidths[nextCol] + 'px';
                }
                mouseX = mouseEvent.clientX;
            }
        };
        const stopResizingColumn = () => {
            if (col > -1) {
                col = -1;
                colIndex = -1;
                mouseX = -1;
                eventOverlay.remove();
                this.saveColumnWidths(columnWidths);
            }
        };
        addListenerToClass('resizeCol', 'mousedown', (e) => {
            if (e.target === null)
                return;
            col = parseInt(e.target.dataset.col);
            while (columnWidths[col] === COLUMN_HIDDEN)
                col--;
            mouseX = e.clientX;
            let isAuto = columnWidths[0] === COLUMN_AUTO;
            for (let i = 0; i < cols.length; i++) {
                let curCol = parseInt(cols[i].dataset.col);
                if (isAuto && curCol !== 1)
                    columnWidths[curCol] = cols[i].clientWidth - COLUMN_LEFT_RIGHT_PADDING;
                if (curCol === col)
                    colIndex = i;
            }
            if (isAuto)
                makeTableFixedLayout();
            eventOverlay.create('colResize', processResizingColumn, stopResizingColumn);
        });
        colHeadersElem.addEventListener('contextmenu', (e) => {
            handledEvent(e);
            const toggleColumnState = (col, defaultWidth) => {
                columnWidths[col] = columnWidths[col] !== COLUMN_HIDDEN ? COLUMN_HIDDEN : columnWidths[0] === COLUMN_AUTO ? COLUMN_AUTO : defaultWidth - COLUMN_LEFT_RIGHT_PADDING;
                this.saveColumnWidths(columnWidths);
                this.render();
            };
            const commitOrdering = getCommitOrdering(this.gitRepos[this.currentRepo].commitOrdering);
            const changeCommitOrdering = (repoCommitOrdering) => {
                this.saveRepoStateValue(this.currentRepo, 'commitOrdering', repoCommitOrdering);
                this.refresh(true);
            };
            contextMenu.show([
                [
                    {
                        title: 'Date',
                        visible: true,
                        checked: columnWidths[2] !== COLUMN_HIDDEN,
                        onClick: () => toggleColumnState(2, 128)
                    },
                    {
                        title: 'Author',
                        visible: true,
                        checked: columnWidths[3] !== COLUMN_HIDDEN,
                        onClick: () => toggleColumnState(3, 128)
                    },
                    {
                        title: 'Commit',
                        visible: true,
                        checked: columnWidths[4] !== COLUMN_HIDDEN,
                        onClick: () => toggleColumnState(4, 80)
                    }
                ],
                [
                    {
                        title: 'Commit Timestamp Order',
                        visible: true,
                        checked: commitOrdering === "date",
                        onClick: () => changeCommitOrdering("date")
                    },
                    {
                        title: 'Author Timestamp Order',
                        visible: true,
                        checked: commitOrdering === "author-date",
                        onClick: () => changeCommitOrdering("author-date")
                    },
                    {
                        title: 'Topological Order',
                        visible: true,
                        checked: commitOrdering === "topo",
                        onClick: () => changeCommitOrdering("topo")
                    }
                ]
            ], true, null, e, this.viewElem);
        });
    }
    getColumnVisibility() {
        let colWidths = this.gitRepos[this.currentRepo].columnWidths;
        if (colWidths !== null) {
            return { date: colWidths[1] !== COLUMN_HIDDEN, author: colWidths[2] !== COLUMN_HIDDEN, commit: colWidths[3] !== COLUMN_HIDDEN };
        }
        else {
            let defaults = this.config.defaultColumnVisibility;
            return { date: defaults.date, author: defaults.author, commit: defaults.commit };
        }
    }
    getNumColumns() {
        let colVisibility = this.getColumnVisibility();
        return 2 + (colVisibility.date ? 1 : 0) + (colVisibility.author ? 1 : 0) + (colVisibility.commit ? 1 : 0);
    }
    scrollToStash(next) {
        const stashCommits = this.commits.filter((commit) => commit.stash !== null);
        if (stashCommits.length > 0) {
            const curTime = (new Date()).getTime();
            if (this.lastScrollToStash.time < curTime - 5000) {
                this.lastScrollToStash.hash = null;
            }
            const lastScrollToStashCommitIndex = this.lastScrollToStash.hash !== null
                ? stashCommits.findIndex((commit) => commit.hash === this.lastScrollToStash.hash)
                : -1;
            let scrollToStashCommitIndex = lastScrollToStashCommitIndex + (next ? 1 : -1);
            if (scrollToStashCommitIndex >= stashCommits.length) {
                scrollToStashCommitIndex = 0;
            }
            else if (scrollToStashCommitIndex < 0) {
                scrollToStashCommitIndex = stashCommits.length - 1;
            }
            this.scrollToCommit(stashCommits[scrollToStashCommitIndex].hash, true, true);
            this.lastScrollToStash.time = curTime;
            this.lastScrollToStash.hash = stashCommits[scrollToStashCommitIndex].hash;
        }
    }
    scrollToCommit(hash, alwaysCenterCommit, flash = false) {
        const elem = findCommitElemWithId(getCommitElems(), this.getCommitId(hash));
        if (elem === null)
            return;
        let elemTop = this.controlsElem.clientHeight + elem.offsetTop;
        if (alwaysCenterCommit || elemTop - 8 < this.viewElem.scrollTop || elemTop + 32 - this.viewElem.clientHeight > this.viewElem.scrollTop) {
            this.viewElem.scroll(0, this.controlsElem.clientHeight + elem.offsetTop + 12 - this.viewElem.clientHeight / 2);
        }
        if (flash && !elem.classList.contains('flash')) {
            elem.classList.add('flash');
            setTimeout(() => {
                elem.classList.remove('flash');
            }, 850);
        }
    }
    loadMoreCommits() {
        this.footerElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + 'Loading ...</h2>';
        this.maxCommits += this.config.loadMoreCommits;
        this.saveState();
        this.requestLoadRepoInfoAndCommits(false, true);
    }
    alignTableHeaderToControls() {
        if (!this.tableColHeadersElem) {
            return;
        }
    }
    observeWindowSizeChanges() {
        let windowWidth = window.outerWidth, windowHeight = window.outerHeight;
        window.addEventListener('resize', () => {
            if (windowWidth === window.outerWidth && windowHeight === window.outerHeight) {
                this.renderGraph();
            }
            else {
                windowWidth = window.outerWidth;
                windowHeight = window.outerHeight;
            }
            if (this.config.stickyHeader) {
                this.alignTableHeaderToControls();
            }
        });
    }
    observeWebviewStyleChanges() {
        let fontFamily = getVSCodeStyle(CSS_PROP_FONT_FAMILY), editorFontFamily = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY), findMatchColour = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND), selectionBackgroundColor = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);
        const setFlashColour = (colour) => {
            document.body.style.setProperty('--git-graph-flashPrimary', modifyColourOpacity(colour, 0.7));
            document.body.style.setProperty('--git-graph-flashSecondary', modifyColourOpacity(colour, 0.5));
        };
        const setSelectionBackgroundColorExists = () => {
            alterClass(document.body, 'selection-background-color-exists', selectionBackgroundColor);
        };
        this.findWidget.setColour(findMatchColour);
        setFlashColour(findMatchColour);
        setSelectionBackgroundColorExists();
        (new MutationObserver(() => {
            let ff = getVSCodeStyle(CSS_PROP_FONT_FAMILY), eff = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY), fmc = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND), sbc = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);
            if (ff !== fontFamily || eff !== editorFontFamily) {
                fontFamily = ff;
                editorFontFamily = eff;
                this.repoDropdown.refresh();
                this.branchDropdown.refresh();
                this.authorDropdown.refresh();
            }
            if (fmc !== findMatchColour) {
                findMatchColour = fmc;
                this.findWidget.setColour(findMatchColour);
                setFlashColour(findMatchColour);
            }
            if (selectionBackgroundColor !== sbc) {
                selectionBackgroundColor = sbc;
                setSelectionBackgroundColorExists();
            }
        })).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    }
    observeViewScroll() {
        let active = this.viewElem.scrollTop > 0, timeout = null;
        this.viewElem.addEventListener('scroll', () => {
            const scrollTop = this.viewElem.scrollTop;
            if (active !== scrollTop > 0) {
                active = scrollTop > 0;
            }
            if (this.config.loadMoreCommitsAutomatically && this.moreCommitsAvailable && !this.currentRepoRefreshState.inProgress) {
                const viewHeight = this.viewElem.clientHeight, contentHeight = this.viewElem.scrollHeight;
                if (scrollTop > 0 && viewHeight > 0 && contentHeight > 0 && (scrollTop + viewHeight) >= contentHeight - 25) {
                    this.loadMoreCommits();
                }
            }
            if (timeout !== null)
                clearTimeout(timeout);
            timeout = setTimeout(() => {
                this.scrollTop = scrollTop;
                this.saveState();
                timeout = null;
            }, 250);
        });
    }
    observeKeyboardEvents() {
        document.addEventListener('keydown', (e) => {
            if (contextMenu.isOpen()) {
                if (e.key === 'Escape') {
                    contextMenu.close();
                    handledEvent(e);
                }
            }
            else if (dialog.isOpen()) {
                if (e.key === 'Escape') {
                    dialog.close();
                    handledEvent(e);
                }
                else if (e.keyCode ? e.keyCode === 13 : e.key === 'Enter') {
                    dialog.submit();
                    handledEvent(e);
                }
            }
            else if (this.expandedCommit !== null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                const curHashIndex = this.commitLookup[this.expandedCommit.commitHash];
                let newHashIndex = -1;
                if (e.ctrlKey || e.metaKey) {
                    if (e.shiftKey) {
                        if (e.key === 'ArrowUp') {
                            newHashIndex = this.graph.getAlternativeChildIndex(curHashIndex);
                        }
                        else if (e.key === 'ArrowDown') {
                            newHashIndex = this.graph.getAlternativeParentIndex(curHashIndex);
                        }
                    }
                    else {
                        if (e.key === 'ArrowUp') {
                            newHashIndex = this.graph.getFirstChildIndex(curHashIndex);
                        }
                        else if (e.key === 'ArrowDown') {
                            newHashIndex = this.graph.getFirstParentIndex(curHashIndex);
                        }
                    }
                }
                else {
                    if (e.key === 'ArrowUp' && curHashIndex > 0) {
                        newHashIndex = curHashIndex - 1;
                    }
                    else if (e.key === 'ArrowDown' && curHashIndex < this.commits.length - 1) {
                        newHashIndex = curHashIndex + 1;
                    }
                }
                if (newHashIndex > -1) {
                    handledEvent(e);
                    const elem = findCommitElemWithId(getCommitElems(), newHashIndex);
                    if (elem !== null)
                        this.loadCommitDetails(elem);
                }
            }
            else if (e.key && (e.ctrlKey || e.metaKey)) {
                const key = e.key.toLowerCase(), keybindings = this.config.keybindings;
                if (key === keybindings.scrollToStash) {
                    this.scrollToStash(!e.shiftKey);
                    handledEvent(e);
                }
                else if (!e.shiftKey) {
                    if (key === keybindings.refresh) {
                        this.refresh(true, true);
                        handledEvent(e);
                    }
                    else if (key === keybindings.find) {
                        this.findWidget.show(true);
                        handledEvent(e);
                    }
                    else if (key === keybindings.scrollToHead && this.commitHead !== null) {
                        this.scrollToCommit(this.commitHead, true, true);
                        handledEvent(e);
                    }
                }
            }
            else if (e.key === 'Escape') {
                if (this.repoDropdown.isOpen()) {
                    this.repoDropdown.close();
                    handledEvent(e);
                }
                else if (this.branchDropdown.isOpen()) {
                    this.branchDropdown.close();
                    handledEvent(e);
                }
                else if (this.authorDropdown.isOpen()) {
                    this.authorDropdown.close();
                    handledEvent(e);
                }
                else if (this.settingsWidget.isVisible()) {
                    this.settingsWidget.close();
                    handledEvent(e);
                }
                else if (this.findWidget.isVisible()) {
                    this.findWidget.close();
                    handledEvent(e);
                }
                else if (this.expandedCommit !== null) {
                    this.closeCommitDetails(true);
                    handledEvent(e);
                }
            }
        });
    }
    observeUrls() {
        const followInternalLink = (e) => {
            if (e.target !== null && isInternalUrlElem(e.target)) {
                const value = unescapeHtml(e.target.dataset.value);
                switch (e.target.dataset.type) {
                    case 'commit':
                        if (typeof this.commitLookup[value] === 'number' && (this.expandedCommit === null || this.expandedCommit.commitHash !== value || this.expandedCommit.compareWithHash !== null)) {
                            const elem = findCommitElemWithId(getCommitElems(), this.commitLookup[value]);
                            if (elem !== null)
                                this.loadCommitDetails(elem);
                        }
                        break;
                }
            }
        };
        document.body.addEventListener('click', followInternalLink);
        document.body.addEventListener('contextmenu', (e) => {
            if (e.target === null)
                return;
            const eventTarget = e.target;
            const isExternalUrl = isExternalUrlElem(eventTarget), isInternalUrl = isInternalUrlElem(eventTarget);
            if (isExternalUrl || isInternalUrl) {
                const viewElem = eventTarget.closest('#view');
                let eventElem;
                let target, isInDialog = false;
                if (this.expandedCommit !== null && eventTarget.closest('#cdv') !== null) {
                    target = {
                        type: "cdv",
                        hash: this.expandedCommit.commitHash,
                        index: this.commitLookup[this.expandedCommit.commitHash],
                        elem: eventTarget
                    };
                    GitGraphView.closeCdvContextMenuIfOpen(this.expandedCommit);
                    this.expandedCommit.contextMenuOpen.summary = true;
                }
                else if ((eventElem = eventTarget.closest('.commit')) !== null) {
                    const commit = this.getCommitOfElem(eventElem);
                    if (commit === null)
                        return;
                    target = {
                        type: "commit",
                        hash: commit.hash,
                        index: parseInt(eventElem.dataset.id),
                        elem: eventTarget
                    };
                }
                else {
                    target = {
                        type: "repo"
                    };
                    isInDialog = true;
                }
                handledEvent(e);
                contextMenu.show([
                    [
                        {
                            title: 'Open URL',
                            visible: isExternalUrl,
                            onClick: () => {
                                sendMessage({ command: 'openExternalUrl', url: eventTarget.href });
                            }
                        },
                        {
                            title: 'Follow Internal Link',
                            visible: isInternalUrl,
                            onClick: () => followInternalLink(e)
                        },
                        {
                            title: 'Copy URL to Clipboard',
                            visible: isExternalUrl,
                            onClick: () => {
                                sendMessage({ command: 'copyToClipboard', type: 'External URL', data: eventTarget.href });
                            }
                        }
                    ]
                ], false, target, e, viewElem || document.body, () => {
                    if (target.type === "cdv" && this.expandedCommit !== null) {
                        this.expandedCommit.contextMenuOpen.summary = false;
                    }
                }, isInDialog ? 'dialogContextMenu' : null);
            }
        });
    }
    observeTableEvents() {
        this.tableElem.addEventListener('click', (e) => {
            if (e.target === null)
                return;
            const eventTarget = e.target;
            if (isUrlElem(eventTarget))
                return;
            let eventElem;
            if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
                e.stopPropagation();
                if (contextMenu.isOpen()) {
                    contextMenu.close();
                }
            }
            else if ((eventElem = eventTarget.closest('.commit')) !== null) {
                const commit = this.getCommitOfElem(eventElem);
                if (commit === null)
                    return;
                const mouseEvent = e;
                if (mouseEvent.shiftKey) {
                    if (this.selectedCommits.size > 0) {
                        const anchorCommit = Array.from(this.selectedCommits)[0];
                        this.selectCommitRange(anchorCommit, commit.hash);
                        if (this.selectedCommits.size === 2) {
                            const selectedHashes = Array.from(this.selectedCommits);
                            const commitElems = selectedHashes.map(hash => {
                                const index = this.commitLookup[hash];
                                return document.querySelector(`tr.commit[data-id="${index}"]`);
                            }).filter(elem => elem !== null);
                            if (commitElems.length === 2) {
                                const [firstIndex, secondIndex] = selectedHashes.map(hash => this.commitLookup[hash]);
                                if (firstIndex < secondIndex) {
                                    this.loadCommitComparison(commitElems[1], commitElems[0]);
                                }
                                else {
                                    this.loadCommitComparison(commitElems[0], commitElems[1]);
                                }
                            }
                        }
                        else if (this.selectedCommits.size > 2) {
                            this.closeCommitDetails(true);
                        }
                    }
                    else {
                        this.toggleCommitSelection(commit.hash, eventElem);
                    }
                }
                else if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
                    this.toggleCommitSelection(commit.hash, eventElem);
                    if (this.selectedCommits.size === 2) {
                        const selectedHashes = Array.from(this.selectedCommits);
                        const commitElems = selectedHashes.map(hash => {
                            const index = this.commitLookup[hash];
                            return document.querySelector(`tr.commit[data-id="${index}"]`);
                        }).filter(elem => elem !== null);
                        if (commitElems.length === 2) {
                            const [firstIndex, secondIndex] = selectedHashes.map(hash => this.commitLookup[hash]);
                            if (firstIndex < secondIndex) {
                                this.loadCommitComparison(commitElems[1], commitElems[0]);
                            }
                            else {
                                this.loadCommitComparison(commitElems[0], commitElems[1]);
                            }
                        }
                    }
                    else if (this.selectedCommits.size > 2) {
                        this.closeCommitDetails(true);
                    }
                }
                else if (this.expandedCommit !== null) {
                    if (this.expandedCommit.commitHash === commit.hash) {
                        this.closeCommitDetails(true);
                    }
                    else {
                        this.clearCommitSelection();
                        this.toggleCommitSelection(commit.hash, eventElem);
                        this.loadCommitDetails(eventElem);
                    }
                }
                else {
                    this.clearCommitSelection();
                    this.toggleCommitSelection(commit.hash, eventElem);
                    this.loadCommitDetails(eventElem);
                }
            }
        });
        this.tableElem.addEventListener('dblclick', (e) => {
            if (e.target === null)
                return;
            const eventTarget = e.target;
            if (isUrlElem(eventTarget))
                return;
            let eventElem;
            if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
                e.stopPropagation();
                closeDialogAndContextMenu();
                const commitElem = eventElem.closest('.commit');
                const commit = this.getCommitOfElem(commitElem);
                if (commit === null)
                    return;
                if (eventElem.classList.contains(CLASS_REF_HEAD) || eventElem.classList.contains(CLASS_REF_REMOTE)) {
                    let sourceElem = eventElem.children[1];
                    let refName = unescapeHtml(eventElem.dataset.name), isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
                    if (isHead && isRemoteCombinedWithHead) {
                        refName = unescapeHtml(eventTarget.dataset.fullref);
                        sourceElem = eventTarget;
                        isHead = false;
                    }
                    const target = {
                        type: "ref",
                        hash: commit.hash,
                        index: parseInt(commitElem.dataset.id),
                        ref: refName,
                        elem: sourceElem
                    };
                    this.checkoutBranchAction(refName, isHead ? null : unescapeHtml((isRemoteCombinedWithHead ? eventTarget : eventElem).dataset.remote), null, target);
                }
            }
        });
        this.tableElem.addEventListener('contextmenu', (e) => {
            if (e.target === null)
                return;
            const eventTarget = e.target;
            if (isUrlElem(eventTarget))
                return;
            let eventElem;
            if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
                handledEvent(e);
                const commitElem = eventElem.closest('.commit');
                const commit = this.getCommitOfElem(commitElem);
                if (commit === null)
                    return;
                const target = {
                    type: "ref",
                    hash: commit.hash,
                    index: parseInt(commitElem.dataset.id),
                    ref: unescapeHtml(eventElem.dataset.name),
                    elem: eventElem.children[1]
                };
                let actions;
                if (eventElem.classList.contains(CLASS_REF_STASH)) {
                    actions = this.getStashContextMenuActions(target);
                }
                else if (eventElem.classList.contains(CLASS_REF_TAG)) {
                    actions = this.getTagContextMenuActions(eventElem.dataset.tagtype === 'annotated', target);
                }
                else {
                    let isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
                    if (isHead && isRemoteCombinedWithHead) {
                        target.ref = unescapeHtml(eventTarget.dataset.fullref);
                        target.elem = eventTarget;
                        isHead = false;
                    }
                    if (isHead) {
                        actions = this.getBranchContextMenuActions(target);
                    }
                    else {
                        const remote = unescapeHtml((isRemoteCombinedWithHead ? eventTarget : eventElem).dataset.remote);
                        actions = this.getRemoteBranchContextMenuActions(remote, target);
                    }
                }
                contextMenu.show(actions, false, target, e, this.viewElem);
            }
            else if ((eventElem = eventTarget.closest('.commit')) !== null) {
                handledEvent(e);
                const commit = this.getCommitOfElem(eventElem);
                if (commit === null)
                    return;
                if (this.expandedCommit !== null && this.expandedCommit.commitHash !== commit.hash) {
                    this.closeCommitDetails(false);
                }
                if (!this.selectedCommits.has(commit.hash)) {
                    this.clearCommitSelection();
                    this.toggleCommitSelection(commit.hash, eventElem);
                }
                const target = {
                    type: "commit",
                    hash: commit.hash,
                    index: parseInt(eventElem.dataset.id),
                    elem: eventElem
                };
                let actions;
                if (commit.hash === UNCOMMITTED) {
                    actions = this.getUncommittedChangesContextMenuActions(target);
                }
                else if (commit.stash !== null) {
                    target.ref = commit.stash.selector;
                    actions = this.getStashContextMenuActions(target);
                }
                else {
                    if (this.selectedCommits.size > 1 && this.selectedCommits.has(commit.hash)) {
                        actions = this.getMultiSelectCommitContextMenuActions(target);
                    }
                    else {
                        actions = this.getCommitContextMenuActions(target);
                    }
                }
                contextMenu.show(actions, false, target, e, this.viewElem);
            }
        });
    }
    loadCommitDetails(commitElem) {
        const commit = this.getCommitOfElem(commitElem);
        if (commit === null)
            return;
        this.closeCommitDetails(false);
        this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id), commit.hash, commitElem, null, null);
        commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
        this.renderCommitDetailsView(false);
        this.requestCommitDetails(commit.hash, false);
    }
    closeCommitDetails(saveAndRender) {
        const expandedCommit = this.expandedCommit;
        if (expandedCommit === null)
            return;
        const elem = document.getElementById('cdv'), isDocked = this.isCdvDocked();
        if (elem !== null) {
            elem.remove();
        }
        if (isDocked) {
            this.viewElem.style.bottom = '0px';
        }
        if (expandedCommit.commitElem !== null) {
            expandedCommit.commitElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
        }
        if (expandedCommit.compareWithElem !== null) {
            expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
        }
        GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
        this.expandedCommit = null;
        if (saveAndRender) {
            this.saveState();
            if (!isDocked) {
                this.renderGraph();
            }
        }
    }
    showCommitDetails(commitDetails, fileTree, avatar, codeReview, lastViewedFile, refresh) {
        const expandedCommit = this.expandedCommit;
        if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.commitHash !== commitDetails.hash || expandedCommit.compareWithHash !== null)
            return;
        if (!this.isCdvDocked()) {
            const elem = document.getElementById('cdv');
            if (elem !== null)
                elem.remove();
        }
        expandedCommit.commitDetails = commitDetails;
        if (haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges)) {
            expandedCommit.fileChanges = commitDetails.fileChanges;
            expandedCommit.fileTree = fileTree;
            GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
        }
        expandedCommit.avatar = avatar;
        expandedCommit.codeReview = codeReview;
        if (!refresh) {
            expandedCommit.lastViewedFile = lastViewedFile;
        }
        expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
        expandedCommit.loading = false;
        this.saveState();
        this.renderCommitDetailsView(refresh);
    }
    createFileTree(gitFiles, codeReview) {
        let contents = {}, i, j, path, absPath, cur;
        let files = { type: 'folder', name: '', folderPath: '', contents: contents, open: true, reviewed: true };
        for (i = 0; i < gitFiles.length; i++) {
            cur = files;
            path = gitFiles[i].newFilePath.split('/');
            absPath = this.currentRepo;
            for (j = 0; j < path.length; j++) {
                absPath += '/' + path[j];
                if (typeof this.gitRepos[absPath] !== 'undefined') {
                    if (typeof cur.contents[path[j]] === 'undefined') {
                        cur.contents[path[j]] = { type: 'repo', name: path[j], path: absPath };
                    }
                    break;
                }
                else if (j < path.length - 1) {
                    if (typeof cur.contents[path[j]] === 'undefined') {
                        contents = {};
                        cur.contents[path[j]] = { type: 'folder', name: path[j], folderPath: absPath.substring(this.currentRepo.length + 1), contents: contents, open: true, reviewed: true };
                    }
                    cur = cur.contents[path[j]];
                }
                else if (path[j] !== '') {
                    cur.contents[path[j]] = { type: 'file', name: path[j], index: i, reviewed: codeReview === null || !codeReview.remainingFiles.includes(gitFiles[i].newFilePath) };
                }
            }
        }
        if (codeReview !== null)
            calcFileTreeFoldersReviewed(files);
        return files;
    }
    loadCommitComparison(commitElem, compareWithElem) {
        const commit = this.getCommitOfElem(commitElem);
        const compareWithCommit = this.getCommitOfElem(compareWithElem);
        if (commit !== null && compareWithCommit !== null) {
            if (this.expandedCommit !== null) {
                if (this.expandedCommit.commitHash !== commit.hash) {
                    this.closeCommitDetails(false);
                }
                else if (this.expandedCommit.compareWithHash !== compareWithCommit.hash) {
                    this.closeCommitComparison(false);
                }
            }
            this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id), commit.hash, commitElem, compareWithCommit.hash, compareWithElem);
            commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
            compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
            this.renderCommitDetailsView(false);
            this.requestCommitComparison(commit.hash, compareWithCommit.hash, false);
        }
    }
    closeCommitComparison(saveAndRequestCommitDetails) {
        const expandedCommit = this.expandedCommit;
        if (expandedCommit === null || expandedCommit.compareWithHash === null)
            return;
        if (expandedCommit.compareWithElem !== null) {
            expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
        }
        GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
        if (saveAndRequestCommitDetails) {
            if (expandedCommit.commitElem !== null) {
                this.saveExpandedCommitLoading(expandedCommit.index, expandedCommit.commitHash, expandedCommit.commitElem, null, null);
                this.renderCommitDetailsView(false);
                this.requestCommitDetails(expandedCommit.commitHash, false);
            }
            else {
                this.closeCommitDetails(true);
            }
        }
    }
    showCommitComparison(commitHash, compareWithHash, fileChanges, fileTree, codeReview, lastViewedFile, refresh) {
        const expandedCommit = this.expandedCommit;
        if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.compareWithElem === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash)
            return;
        if (haveFilesChanged(expandedCommit.fileChanges, fileChanges)) {
            expandedCommit.fileChanges = fileChanges;
            expandedCommit.fileTree = fileTree;
            GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
        }
        expandedCommit.codeReview = codeReview;
        if (!refresh) {
            expandedCommit.lastViewedFile = lastViewedFile;
        }
        expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
        expandedCommit.compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
        expandedCommit.loading = false;
        this.saveState();
        this.renderCommitDetailsView(refresh);
    }
    renderCommitDetailsView(refresh) {
        const expandedCommit = this.expandedCommit;
        if (expandedCommit === null || expandedCommit.commitElem === null)
            return;
        let elem = document.getElementById('cdv'), html = '<div id="cdvContent">', isDocked = this.isCdvDocked();
        const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
        const codeReviewPossible = !expandedCommit.loading && commitOrder.to !== UNCOMMITTED;
        const externalDiffPossible = !expandedCommit.loading && (expandedCommit.compareWithHash !== null || this.commits[this.commitLookup[expandedCommit.commitHash]].parents.length > 0);
        if (elem === null) {
            elem = document.createElement(isDocked ? 'div' : 'tr');
            elem.id = 'cdv';
            elem.className = isDocked ? 'docked' : 'inline';
            this.setCdvHeight(elem, isDocked);
            if (isDocked) {
                document.body.appendChild(elem);
            }
            else {
                insertAfter(elem, expandedCommit.commitElem);
            }
        }
        if (expandedCommit.loading) {
            html += '<div id="cdvFiles"></div><div id="cdvLoading">' + SVG_ICONS.loading + ' Loading ' + (expandedCommit.compareWithHash === null ? expandedCommit.commitHash !== UNCOMMITTED ? 'Commit Details' : 'Uncommitted Changes' : 'Commit Comparison') + ' ...</div>';
        }
        else {
            html += '<div id="cdvSummary">';
            if (expandedCommit.compareWithHash === null) {
                if (expandedCommit.commitHash !== UNCOMMITTED) {
                    const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
                        commits: true,
                        emoji: true,
                        issueLinking: true,
                        markdown: this.config.markdown,
                        multiline: true,
                        urls: true
                    });
                    const commitDetails = expandedCommit.commitDetails;
                    const parents = commitDetails.parents.length > 0
                        ? commitDetails.parents.map((parent) => {
                            const escapedParent = escapeHtml(parent);
                            return typeof this.commitLookup[parent] === 'number'
                                ? '<span class="' + CLASS_INTERNAL_URL + '" data-type="commit" data-value="' + escapedParent + '" tabindex="-1">' + escapedParent + '</span>'
                                : escapedParent;
                        }).join(', ')
                        : 'None';
                    html += '<span class="cdvSummaryTop' + (expandedCommit.avatar !== null ? ' withAvatar' : '') + '"><span class="cdvSummaryTopRow"><span class="cdvSummaryKeyValues">'
                        + '<b>Commit: </b>' + escapeHtml(commitDetails.hash) + '<br>'
                        + '<b>Parents: </b>' + parents + '<br>'
                        + '<b>Author: </b>' + escapeHtml(commitDetails.author) + (commitDetails.authorEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.authorEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.authorEmail) + '</a>&gt;' : '') + '<br>'
                        + (commitDetails.authorDate !== commitDetails.committerDate ? '<b>Author Date: </b>' + formatLongDate(commitDetails.authorDate) + '<br>' : '')
                        + '<b>Committer: </b>' + escapeHtml(commitDetails.committer) + (commitDetails.committerEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.committerEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.committerEmail) + '</a>&gt;' : '') + (commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : '') + '<br>'
                        + '<b>' + (commitDetails.authorDate !== commitDetails.committerDate ? 'Committer ' : '') + 'Date: </b>' + formatLongDate(commitDetails.committerDate)
                        + '</span>'
                        + (expandedCommit.avatar !== null ? '<span class="cdvSummaryAvatar"><img src="' + expandedCommit.avatar + '"></span>' : '')
                        + '</span></span><br><br>' + textFormatter.format(commitDetails.body);
                }
                else {
                    html += 'Displaying all uncommitted changes.';
                }
            }
            else {
                html += 'Displaying all changes from <b>' + commitOrder.from + '</b> to <b>' + (commitOrder.to !== UNCOMMITTED ? commitOrder.to : 'Uncommitted Changes') + '</b>.';
            }
            html += '</div><div id="cdvFiles">' + (!isDocked ? '<div id="cdvSummaryToggleBtn">' + SVG_ICONS.collapse + '</div>' : '') + '<div id="cdvFilesViewWrapper"><div id="cdvFilesView">' + generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, this.getFileViewType(), commitOrder.to === UNCOMMITTED) + '</div></div></div><div id="cdvDivider"></div>';
        }
        html += '</div><div id="cdvControls"><div id="cdvClose" class="cdvControlBtn" title="Close">' + SVG_ICONS.close + '</div>' +
            (codeReviewPossible ? '<div id="cdvCodeReview" class="cdvControlBtn">' + SVG_ICONS.review + '</div>' : '') +
            (!expandedCommit.loading ? '<div id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="File List View">' + SVG_ICONS.fileList + '</div><div id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="File Tree View">' + SVG_ICONS.fileTree + '</div><div id="cdvCollapse" class="cdvControlBtn cdvFolderBtn" title="Collapse/Expand Folders">' + SVG_ICONS.collapseAll + '</div><div id="cdvExpand" class="cdvControlBtn cdvFolderBtn" title="Expand Folders">' + SVG_ICONS.expandAll + '</div>' : '') +
            (externalDiffPossible ? '<div id="cdvExternalDiff" class="cdvControlBtn">' + SVG_ICONS.linkExternal + '</div>' : '') +
            '</div><div class="cdvHeightResize"></div>';
        elem.innerHTML = isDocked ? html : '<td><div class="cdvHeightResize"></div></td><td colspan="' + (this.getNumColumns() - 1) + '"><div id="cdvContentWrapper">' + html + '</div></td>';
        this.setCdvDivider();
        this.setCdvHeight(elem, isDocked);
        if (!isDocked)
            this.renderGraph();
        if (!refresh) {
            if (isDocked) {
                if (!this.config.commitDetailsView.autoScroll) {
                }
                else {
                    let elemTop = this.controlsElem.clientHeight + expandedCommit.commitElem.offsetTop;
                    if (elemTop - 8 < this.viewElem.scrollTop) {
                        this.viewElem.scroll(0, elemTop - 8);
                    }
                    else if (elemTop - this.viewElem.clientHeight + 32 > this.viewElem.scrollTop) {
                        this.viewElem.scroll(0, elemTop - this.viewElem.clientHeight + 32);
                    }
                }
            }
            else {
                let elemTop = this.controlsElem.clientHeight + elem.offsetTop, cdvHeight = this.gitRepos[this.currentRepo].cdvHeight;
                if (!this.config.commitDetailsView.autoScroll) {
                }
                else if (this.config.commitDetailsView.autoCenter) {
                    this.viewElem.scroll(0, elemTop - 12 + (cdvHeight - this.viewElem.clientHeight) / 2);
                }
                else if (elemTop - 32 < this.viewElem.scrollTop) {
                    this.viewElem.scroll(0, elemTop - 32);
                }
                else if (elemTop + cdvHeight - this.viewElem.clientHeight + 8 > this.viewElem.scrollTop) {
                    this.viewElem.scroll(0, elemTop + cdvHeight - this.viewElem.clientHeight + 8);
                }
            }
        }
        this.makeCdvResizable();
        document.getElementById('cdvClose').addEventListener('click', () => {
            this.closeCommitDetails(true);
        });
        if (!expandedCommit.loading) {
            this.makeCdvFileViewInteractive();
            this.renderCdvFileViewTypeBtns();
            this.renderCdvExternalDiffBtn();
            this.makeCdvDividerDraggable();
            observeElemScroll('cdvSummary', expandedCommit.scrollTop.summary, (scrollTop) => {
                if (this.expandedCommit === null)
                    return;
                this.expandedCommit.scrollTop.summary = scrollTop;
                if (this.expandedCommit.contextMenuOpen.summary) {
                    this.expandedCommit.contextMenuOpen.summary = false;
                    contextMenu.close();
                }
            }, () => this.saveState());
            observeElemScroll('cdvFilesViewWrapper', expandedCommit.scrollTop.fileView, (scrollTop) => {
                if (this.expandedCommit === null)
                    return;
                this.expandedCommit.scrollTop.fileView = scrollTop;
                if (this.expandedCommit.contextMenuOpen.fileView > -1) {
                    this.expandedCommit.contextMenuOpen.fileView = -1;
                    contextMenu.close();
                }
            }, () => this.saveState());
            document.getElementById('cdvFileViewTypeTree').addEventListener('click', () => {
                this.changeFileViewType(1);
            });
            document.getElementById('cdvFileViewTypeList').addEventListener('click', () => {
                this.changeFileViewType(2);
            });
            document.getElementById('cdvCollapse').addEventListener('click', () => {
                this.openFolders(false);
            });
            document.getElementById('cdvExpand').addEventListener('click', () => {
                this.openFolders(true);
            });
            let cdvSummaryToggleBtn = document.getElementById('cdvSummaryToggleBtn');
            if (cdvSummaryToggleBtn !== null)
                cdvSummaryToggleBtn.addEventListener('click', () => {
                    this.gitRepos[this.currentRepo].isCdvSummaryHidden = !(this.gitRepos[this.currentRepo].isCdvSummaryHidden);
                    this.saveRepoState();
                    this.hideCdvSummary(this.gitRepos[this.currentRepo].isCdvSummaryHidden);
                });
            this.hideCdvSummary(this.gitRepos[this.currentRepo].isCdvSummaryHidden);
            if (codeReviewPossible) {
                this.renderCodeReviewBtn();
                document.getElementById('cdvCodeReview').addEventListener('click', (e) => {
                    const expandedCommit = this.expandedCommit;
                    if (expandedCommit === null || e.target === null)
                        return;
                    let sourceElem = e.target.closest('#cdvCodeReview');
                    if (sourceElem.classList.contains(CLASS_ACTIVE)) {
                        sendMessage({ command: 'endCodeReview', repo: this.currentRepo, id: expandedCommit.codeReview.id });
                        this.endCodeReview();
                    }
                    else {
                        const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
                        const id = expandedCommit.compareWithHash !== null ? commitOrder.from + '-' + commitOrder.to : expandedCommit.commitHash;
                        sendMessage({
                            command: 'startCodeReview',
                            repo: this.currentRepo,
                            id: id,
                            commitHash: expandedCommit.commitHash,
                            compareWithHash: expandedCommit.compareWithHash,
                            files: getFilesInTree(expandedCommit.fileTree, expandedCommit.fileChanges),
                            lastViewedFile: expandedCommit.lastViewedFile
                        });
                    }
                });
            }
            if (externalDiffPossible) {
                document.getElementById('cdvExternalDiff').addEventListener('click', () => {
                    const expandedCommit = this.expandedCommit;
                    if (expandedCommit === null || this.gitConfig === null || (this.gitConfig.diffTool === null && this.gitConfig.guiDiffTool === null))
                        return;
                    const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
                    runAction({
                        command: 'openExternalDirDiff',
                        repo: this.currentRepo,
                        fromHash: commitOrder.from,
                        toHash: commitOrder.to,
                        isGui: this.gitConfig.guiDiffTool !== null
                    }, 'Opening External Directory Diff');
                });
            }
        }
    }
    hideCdvSummary(hide) {
        var _a, _b, _c;
        let btnIcon = (_c = (_b = (_a = document.getElementById('cdvSummaryToggleBtn')) === null || _a === void 0 ? void 0 : _a.getElementsByTagName('svg')) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : null;
        let cdvSummary = document.getElementById('cdvSummary');
        if (hide && !this.isCdvDocked()) {
            if (btnIcon)
                btnIcon.style.transform = 'rotate(90deg)';
            cdvSummary.classList.add('hidden');
        }
        else {
            if (btnIcon)
                btnIcon.style.transform = 'rotate(-90deg)';
            cdvSummary.classList.remove('hidden');
        }
        let elem = document.getElementById('cdv');
        if (elem !== null)
            this.setCdvHeight(elem, this.isCdvDocked());
    }
    setCdvHeight(elem, isDocked) {
        let height = this.gitRepos[this.currentRepo].cdvHeight, windowHeight = window.innerHeight;
        if (height > windowHeight - 40) {
            height = Math.max(windowHeight - 40, 100);
            if (height !== this.gitRepos[this.currentRepo].cdvHeight) {
                this.gitRepos[this.currentRepo].cdvHeight = height;
                this.saveRepoState();
            }
        }
        let heightPx = height + 'px';
        if (isDocked) {
            this.viewElem.style.bottom = heightPx;
            elem.style.height = heightPx;
            return;
        }
        let inlineElem = document.getElementById('cdvContentWrapper');
        if (!inlineElem) {
            elem.style.height = heightPx;
            return;
        }
        if (this.gitRepos[this.currentRepo].isCdvSummaryHidden) {
            inlineElem.style.height = heightPx;
            elem.style.height = '0px';
        }
        else {
            inlineElem.style.removeProperty('height');
            elem.style.height = heightPx;
        }
        this.renderGraph();
    }
    setCdvDivider() {
        let percent = (this.gitRepos[this.currentRepo].cdvDivider * 100).toFixed(2) + '%';
        let summaryElem = document.getElementById('cdvSummary'), dividerElem = document.getElementById('cdvDivider'), filesElem = document.getElementById('cdvFiles');
        if (summaryElem !== null)
            summaryElem.style.width = percent;
        if (dividerElem !== null)
            dividerElem.style.left = percent;
        if (filesElem !== null)
            filesElem.style.left = percent;
    }
    makeCdvResizable() {
        let prevY = -1;
        const processResizingCdvHeight = (e) => {
            if (prevY < 0)
                return;
            let delta = e.pageY - prevY, isDocked = this.isCdvDocked(), windowHeight = window.innerHeight;
            prevY = e.pageY;
            let height = this.gitRepos[this.currentRepo].cdvHeight + (isDocked ? -delta : delta);
            if (height < 100)
                height = 100;
            else if (height > 600)
                height = 600;
            if (height > windowHeight - 40)
                height = Math.max(windowHeight - 40, 100);
            if (this.gitRepos[this.currentRepo].cdvHeight !== height) {
                this.gitRepos[this.currentRepo].cdvHeight = height;
                let elem = document.getElementById('cdv');
                if (elem !== null)
                    this.setCdvHeight(elem, isDocked);
                if (!isDocked)
                    this.renderGraph();
            }
        };
        const stopResizingCdvHeight = (e) => {
            if (prevY < 0)
                return;
            processResizingCdvHeight(e);
            this.saveRepoState();
            prevY = -1;
            eventOverlay.remove();
        };
        addListenerToClass('cdvHeightResize', 'mousedown', (e) => {
            prevY = e.pageY;
            eventOverlay.create('rowResize', processResizingCdvHeight, stopResizingCdvHeight);
        });
    }
    makeCdvDividerDraggable() {
        let minX = -1, width = -1;
        const processDraggingCdvDivider = (e) => {
            if (minX < 0)
                return;
            let percent = (e.clientX - minX) / width;
            if (percent < 0.2)
                percent = 0.2;
            else if (percent > 0.8)
                percent = 0.8;
            if (this.gitRepos[this.currentRepo].cdvDivider !== percent) {
                this.gitRepos[this.currentRepo].cdvDivider = percent;
                this.setCdvDivider();
            }
        };
        const stopDraggingCdvDivider = (e) => {
            if (minX < 0)
                return;
            processDraggingCdvDivider(e);
            this.saveRepoState();
            minX = -1;
            eventOverlay.remove();
        };
        document.getElementById('cdvDivider').addEventListener('mousedown', () => {
            const contentElem = document.getElementById('cdvContent');
            if (contentElem === null)
                return;
            const bounds = contentElem.getBoundingClientRect();
            minX = bounds.left;
            width = bounds.width;
            eventOverlay.create('colResize', processDraggingCdvDivider, stopDraggingCdvDivider);
        });
    }
    cdvUpdateFileState(file, fileElem, isReviewed, fileWasViewed) {
        const expandedCommit = this.expandedCommit, filesElem = document.getElementById('cdvFilesView'), filePath = file.newFilePath;
        if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null)
            return;
        if (fileWasViewed) {
            expandedCommit.lastViewedFile = filePath;
            let lastViewedElem = document.getElementById('cdvLastFileViewed');
            if (lastViewedElem !== null)
                lastViewedElem.remove();
            lastViewedElem = document.createElement('span');
            lastViewedElem.id = 'cdvLastFileViewed';
            lastViewedElem.title = 'Last File Viewed';
            lastViewedElem.innerHTML = SVG_ICONS.eyeOpen;
            insertBeforeFirstChildWithClass(lastViewedElem, fileElem, 'fileTreeFileAction');
        }
        if (expandedCommit.codeReview !== null) {
            if (isReviewed !== null) {
                if (isReviewed) {
                    expandedCommit.codeReview.remainingFiles = expandedCommit.codeReview.remainingFiles.filter((path) => path !== filePath);
                }
                else {
                    expandedCommit.codeReview.remainingFiles.push(filePath);
                }
                alterFileTreeFileReviewed(expandedCommit.fileTree, filePath, isReviewed);
                updateFileTreeHtmlFileReviewed(filesElem, expandedCommit.fileTree, filePath);
            }
            sendMessage({
                command: 'updateCodeReview',
                repo: this.currentRepo,
                id: expandedCommit.codeReview.id,
                remainingFiles: expandedCommit.codeReview.remainingFiles,
                lastViewedFile: expandedCommit.lastViewedFile
            });
            if (expandedCommit.codeReview.remainingFiles.length === 0) {
                expandedCommit.codeReview = null;
                this.renderCodeReviewBtn();
            }
        }
        this.saveState();
    }
    isCdvDocked() {
        return this.config.commitDetailsView.location === 1;
    }
    isCdvOpen(commitHash, compareWithHash) {
        return this.expandedCommit !== null && this.expandedCommit.commitHash === commitHash && this.expandedCommit.compareWithHash === compareWithHash;
    }
    getCommitOrder(hash1, hash2) {
        if (this.commitLookup[hash1] > this.commitLookup[hash2]) {
            return { from: hash1, to: hash2 };
        }
        else {
            return { from: hash2, to: hash1 };
        }
    }
    getFileViewType() {
        return this.gitRepos[this.currentRepo].fileViewType === 0
            ? this.config.commitDetailsView.fileViewType
            : this.gitRepos[this.currentRepo].fileViewType;
    }
    setFileViewType(type) {
        this.gitRepos[this.currentRepo].fileViewType = type;
        this.saveRepoState();
    }
    changeFileViewType(type) {
        const expandedCommit = this.expandedCommit, filesElem = document.getElementById('cdvFilesView');
        if (expandedCommit === null || expandedCommit.fileTree === null || expandedCommit.fileChanges === null || filesElem === null)
            return;
        GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
        this.setFileViewType(type);
        const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
        filesElem.innerHTML = generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED);
        this.makeCdvFileViewInteractive();
        this.renderCdvFileViewTypeBtns();
    }
    openFolders(open) {
        let expandedCommit = this.expandedCommit;
        if (expandedCommit === null || expandedCommit.fileTree === null)
            return;
        let folders = document.getElementsByClassName('fileTreeFolder');
        for (let i = 0; i < folders.length; i++) {
            let sourceElem = (folders[i]);
            let parent = sourceElem.parentElement;
            if (open) {
                parent.classList.remove('closed');
                sourceElem.children[0].children[0].innerHTML = SVG_ICONS.openFolder;
                parent.children[1].classList.remove('hidden');
                alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath), true);
            }
            else {
                parent.classList.add('closed');
                sourceElem.children[0].children[0].innerHTML = SVG_ICONS.closedFolder;
                parent.children[1].classList.add('hidden');
                alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath), false);
            }
        }
        this.saveState();
    }
    makeCdvFileViewInteractive() {
        const getFileElemOfEventTarget = (target) => target.closest('.fileTreeFileRecord');
        const getFileOfFileElem = (fileChanges, fileElem) => fileChanges[parseInt(fileElem.dataset.index)];
        const getCommitHashForFile = (file, expandedCommit) => {
            const commit = this.commits[this.commitLookup[expandedCommit.commitHash]];
            if (expandedCommit.compareWithHash !== null) {
                return this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash).to;
            }
            else if (commit.stash !== null && file.type === "U") {
                return commit.stash.untrackedFilesHash;
            }
            else {
                return expandedCommit.commitHash;
            }
        };
        const triggerViewFileDiff = (file, fileElem) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null)
                return;
            let commit = this.commits[this.commitLookup[expandedCommit.commitHash]], fromHash, toHash, fileStatus = file.type;
            if (expandedCommit.compareWithHash !== null) {
                const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash);
                fromHash = commitOrder.from;
                toHash = commitOrder.to;
            }
            else if (commit.stash !== null) {
                if (fileStatus === "U") {
                    fromHash = commit.stash.untrackedFilesHash;
                    toHash = commit.stash.untrackedFilesHash;
                    fileStatus = "A";
                }
                else {
                    fromHash = commit.stash.baseHash;
                    toHash = expandedCommit.commitHash;
                }
            }
            else {
                fromHash = expandedCommit.commitHash;
                toHash = expandedCommit.commitHash;
            }
            this.cdvUpdateFileState(file, fileElem, true, true);
            sendMessage({
                command: 'viewDiff',
                repo: this.currentRepo,
                fromHash: fromHash,
                toHash: toHash,
                oldFilePath: file.oldFilePath,
                newFilePath: file.newFilePath,
                type: fileStatus
            });
        };
        const triggerCopyFilePath = (file, absolute) => {
            sendMessage({ command: 'copyFilePath', repo: this.currentRepo, filePath: file.newFilePath, absolute: absolute });
        };
        const triggerResetFileToRevision = (file, fileElem) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null)
                return;
            const commitHash = getCommitHashForFile(file, expandedCommit);
            dialog.showConfirmation('Are you sure you want to reset <b><i>' + escapeHtml(file.newFilePath) + '</i></b> to it\'s state at commit <b><i>' + abbrevCommit(commitHash) + '</i></b>? Any uncommitted changes made to this file will be overwritten.', 'Yes, reset file', () => {
                runAction({ command: 'resetFileToRevision', repo: this.currentRepo, commitHash: commitHash, filePath: file.newFilePath }, 'Resetting file');
            }, {
                type: "cdv",
                hash: commitHash,
                elem: fileElem
            });
        };
        const triggerViewFileAtRevision = (file, fileElem) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null)
                return;
            this.cdvUpdateFileState(file, fileElem, true, true);
            sendMessage({ command: 'viewFileAtRevision', repo: this.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
        };
        const triggerViewFileDiffWithWorkingFile = (file, fileElem) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null)
                return;
            this.cdvUpdateFileState(file, fileElem, null, true);
            sendMessage({ command: 'viewDiffWithWorkingFile', repo: this.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
        };
        const triggerOpenFile = (file, fileElem) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null)
                return;
            this.cdvUpdateFileState(file, fileElem, true, true);
            sendMessage({ command: 'openFile', repo: this.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
        };
        addListenerToClass('fileTreeFolder', 'click', (e) => {
            let expandedCommit = this.expandedCommit;
            if (expandedCommit === null || expandedCommit.fileTree === null || e.target === null)
                return;
            let sourceElem = e.target.closest('.fileTreeFolder');
            let parent = sourceElem.parentElement;
            parent.classList.toggle('closed');
            let isOpen = !parent.classList.contains('closed');
            parent.children[0].children[0].innerHTML = isOpen ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder;
            parent.children[1].classList.toggle('hidden');
            alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath), isOpen);
            this.saveState();
        });
        addListenerToClass('fileTreeRepo', 'click', (e) => {
            if (e.target === null)
                return;
            this.loadRepos(this.gitRepos, null, {
                repo: decodeURIComponent(e.target.closest('.fileTreeRepo').dataset.path)
            });
        });
        addListenerToClass('fileTreeFile', 'click', (e) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null)
                return;
            const sourceElem = e.target.closest('.fileTreeFile'), fileElem = getFileElemOfEventTarget(e.target);
            if (!sourceElem.classList.contains('gitDiffPossible'))
                return;
            triggerViewFileDiff(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
        });
        addListenerToClass('copyGitFile', 'click', (e) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null)
                return;
            const fileElem = getFileElemOfEventTarget(e.target);
            triggerCopyFilePath(getFileOfFileElem(expandedCommit.fileChanges, fileElem), true);
        });
        addListenerToClass('viewGitFileAtRevision', 'click', (e) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null)
                return;
            const fileElem = getFileElemOfEventTarget(e.target);
            triggerViewFileAtRevision(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
        });
        addListenerToClass('openGitFile', 'click', (e) => {
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null)
                return;
            const fileElem = getFileElemOfEventTarget(e.target);
            triggerOpenFile(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
        });
        addListenerToClass('fileTreeFileRecord', 'contextmenu', (e) => {
            handledEvent(e);
            const expandedCommit = this.expandedCommit;
            if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null)
                return;
            const fileElem = getFileElemOfEventTarget(e.target);
            const file = getFileOfFileElem(expandedCommit.fileChanges, fileElem);
            const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
            const isUncommitted = commitOrder.to === UNCOMMITTED;
            GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
            expandedCommit.contextMenuOpen.fileView = parseInt(fileElem.dataset.index);
            const target = {
                type: "cdv",
                hash: expandedCommit.commitHash,
                index: this.commitLookup[expandedCommit.commitHash],
                elem: fileElem
            };
            const diffPossible = file.type === "U" || (file.additions !== null && file.deletions !== null);
            const fileExistsAtThisRevision = file.type !== "D" && !isUncommitted;
            const fileExistsAtThisRevisionAndDiffPossible = fileExistsAtThisRevision && diffPossible;
            const codeReviewInProgressAndNotReviewed = expandedCommit.codeReview !== null && expandedCommit.codeReview.remainingFiles.includes(file.newFilePath);
            const visibility = this.config.contextMenuActionsVisibility.commitDetailsViewFile;
            contextMenu.show([
                [
                    {
                        title: 'View Diff',
                        visible: visibility.viewDiff && diffPossible,
                        onClick: () => triggerViewFileDiff(file, fileElem)
                    },
                    {
                        title: 'View File at this Revision',
                        visible: visibility.viewFileAtThisRevision && fileExistsAtThisRevisionAndDiffPossible,
                        onClick: () => triggerViewFileAtRevision(file, fileElem)
                    },
                    {
                        title: 'View Diff with Working File',
                        visible: visibility.viewDiffWithWorkingFile && fileExistsAtThisRevisionAndDiffPossible,
                        onClick: () => triggerViewFileDiffWithWorkingFile(file, fileElem)
                    },
                    {
                        title: 'Open File',
                        visible: visibility.openFile && file.type !== "D",
                        onClick: () => triggerOpenFile(file, fileElem)
                    }
                ],
                [
                    {
                        title: 'Mark as Reviewed',
                        visible: visibility.markAsReviewed && codeReviewInProgressAndNotReviewed,
                        onClick: () => this.cdvUpdateFileState(file, fileElem, true, false)
                    },
                    {
                        title: 'Mark as Not Reviewed',
                        visible: visibility.markAsNotReviewed && expandedCommit.codeReview !== null && !codeReviewInProgressAndNotReviewed,
                        onClick: () => this.cdvUpdateFileState(file, fileElem, false, false)
                    }
                ],
                [
                    {
                        title: 'Reset File to this Revision' + ELLIPSIS,
                        visible: visibility.resetFileToThisRevision && fileExistsAtThisRevision && expandedCommit.compareWithHash === null,
                        onClick: () => triggerResetFileToRevision(file, fileElem)
                    }
                ],
                [
                    {
                        title: 'Copy Absolute File Path to Clipboard',
                        visible: visibility.copyAbsoluteFilePath,
                        onClick: () => triggerCopyFilePath(file, true)
                    },
                    {
                        title: 'Copy Relative File Path to Clipboard',
                        visible: visibility.copyRelativeFilePath,
                        onClick: () => triggerCopyFilePath(file, false)
                    }
                ]
            ], false, target, e, this.isCdvDocked() ? document.body : this.viewElem, () => {
                expandedCommit.contextMenuOpen.fileView = -1;
            });
        });
    }
    renderCdvFileViewTypeBtns() {
        if (this.expandedCommit === null)
            return;
        let treeBtnElem = document.getElementById('cdvFileViewTypeTree'), listBtnElem = document.getElementById('cdvFileViewTypeList');
        if (treeBtnElem === null || listBtnElem === null)
            return;
        let listView = this.getFileViewType() === 2;
        alterClass(treeBtnElem, CLASS_ACTIVE, !listView);
        alterClass(listBtnElem, CLASS_ACTIVE, listView);
        setFolderBtns();
        function setFolderBtns() {
            let btns = document.getElementsByClassName('cdvFolderBtn');
            for (let i = 0; i < btns.length; i++) {
                if (listView)
                    btns[i].classList.add('hidden');
                else
                    btns[i].classList.remove('hidden');
            }
        }
    }
    renderCdvExternalDiffBtn() {
        if (this.expandedCommit === null)
            return;
        const externalDiffBtnElem = document.getElementById('cdvExternalDiff');
        if (externalDiffBtnElem === null)
            return;
        alterClass(externalDiffBtnElem, CLASS_ENABLED, this.gitConfig !== null && (this.gitConfig.diffTool !== null || this.gitConfig.guiDiffTool !== null));
        const toolName = this.gitConfig !== null
            ? this.gitConfig.guiDiffTool !== null
                ? this.gitConfig.guiDiffTool
                : this.gitConfig.diffTool
            : null;
        externalDiffBtnElem.title = 'Open External Directory Diff' + (toolName !== null ? ' with "' + toolName + '"' : '');
    }
    static closeCdvContextMenuIfOpen(expandedCommit) {
        if (expandedCommit.contextMenuOpen.summary || expandedCommit.contextMenuOpen.fileView > -1) {
            expandedCommit.contextMenuOpen.summary = false;
            expandedCommit.contextMenuOpen.fileView = -1;
            contextMenu.close();
        }
    }
    startCodeReview(commitHash, compareWithHash, codeReview) {
        if (this.expandedCommit === null || this.expandedCommit.commitHash !== commitHash || this.expandedCommit.compareWithHash !== compareWithHash)
            return;
        this.saveAndRenderCodeReview(codeReview);
    }
    endCodeReview() {
        if (this.expandedCommit === null || this.expandedCommit.codeReview === null)
            return;
        this.saveAndRenderCodeReview(null);
    }
    saveAndRenderCodeReview(codeReview) {
        let filesElem = document.getElementById('cdvFilesView');
        if (this.expandedCommit === null || this.expandedCommit.fileTree === null || filesElem === null)
            return;
        this.expandedCommit.codeReview = codeReview;
        setFileTreeReviewed(this.expandedCommit.fileTree, codeReview === null);
        this.saveState();
        this.renderCodeReviewBtn();
        updateFileTreeHtml(filesElem, this.expandedCommit.fileTree);
    }
    renderCodeReviewBtn() {
        if (this.expandedCommit === null)
            return;
        let btnElem = document.getElementById('cdvCodeReview');
        if (btnElem === null)
            return;
        let active = this.expandedCommit.codeReview !== null;
        alterClass(btnElem, CLASS_ACTIVE, active);
        btnElem.title = (active ? 'End' : 'Start') + ' Code Review';
    }
}
const contextMenu = new ContextMenu(), dialog = new Dialog(), eventOverlay = new EventOverlay();
let loaded = false;
window.addEventListener('load', () => {
    if (loaded)
        return;
    loaded = true;
    TextFormatter.registerCustomEmojiMappings(initialState.config.customEmojiShortcodeMappings);
    const viewElem = document.getElementById('view');
    if (viewElem === null)
        return;
    const gitGraph = new GitGraphView(viewElem, VSCODE_API.getState());
    const imageResizer = new ImageResizer();
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
            case 'addRemote':
                refreshOrDisplayError(msg.error, 'Unable to Add Remote', true);
                break;
            case 'addTag':
                if (msg.pushToRemote !== null && msg.errors.length === 2 && msg.errors[0] === null && isExtensionErrorInfo(msg.errors[1], "VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:")) {
                    gitGraph.refresh(false);
                    handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.errors[1]);
                }
                else {
                    refreshAndDisplayErrors(msg.errors, 'Unable to Add Tag');
                }
                break;
            case 'applyStash':
                refreshOrDisplayError(msg.error, 'Unable to Apply Stash');
                break;
            case 'branchFromStash':
                refreshOrDisplayError(msg.error, 'Unable to Create Branch from Stash');
                break;
            case 'checkoutBranch':
                refreshAndDisplayErrors(msg.errors, 'Unable to Checkout Branch' + (msg.pullAfterwards !== null ? ' & Pull Changes' : ''));
                break;
            case 'checkoutCommit':
                refreshOrDisplayError(msg.error, 'Unable to Checkout Commit');
                break;
            case 'cherrypickCommit':
                refreshAndDisplayErrors(msg.errors, 'Unable to Cherry Pick Commit');
                break;
            case 'cleanUntrackedFiles':
                refreshOrDisplayError(msg.error, 'Unable to Clean Untracked Files');
                break;
            case 'commitDetails':
                if (msg.commitDetails !== null) {
                    gitGraph.showCommitDetails(msg.commitDetails, gitGraph.createFileTree(msg.commitDetails.fileChanges, msg.codeReview), msg.avatar, msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
                }
                else {
                    gitGraph.closeCommitDetails(true);
                    dialog.showError('Unable to load Commit Details', msg.error, null, null);
                }
                break;
            case 'compareCommits':
                if (msg.error === null) {
                    gitGraph.showCommitComparison(msg.commitHash, msg.compareWithHash, msg.fileChanges, gitGraph.createFileTree(msg.fileChanges, msg.codeReview), msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
                }
                else {
                    gitGraph.closeCommitComparison(true);
                    dialog.showError('Unable to load Commit Comparison', msg.error, null, null);
                }
                break;
            case 'copyFilePath':
                finishOrDisplayError(msg.error, 'Unable to Copy File Path to Clipboard');
                break;
            case 'copyToClipboard':
                finishOrDisplayError(msg.error, 'Unable to Copy ' + msg.type + ' to Clipboard');
                break;
            case 'createArchive':
                finishOrDisplayError(msg.error, 'Unable to Create Archive', true);
                break;
            case 'createBranch':
                refreshAndDisplayErrors(msg.errors, 'Unable to Create Branch');
                break;
            case 'createPullRequest':
                finishOrDisplayErrors(msg.errors, 'Unable to Create Pull Request', () => {
                    if (msg.push) {
                        gitGraph.refresh(false);
                    }
                }, true);
                break;
            case 'deleteBranch':
                handleResponseDeleteBranch(msg);
                break;
            case 'deleteRemote':
                refreshOrDisplayError(msg.error, 'Unable to Delete Remote', true);
                break;
            case 'deleteRemoteBranch':
                refreshOrDisplayError(msg.error, 'Unable to Delete Remote Branch');
                break;
            case 'deleteTag':
                refreshOrDisplayError(msg.error, 'Unable to Delete Tag');
                break;
            case 'deleteUserDetails':
                finishOrDisplayErrors(msg.errors, 'Unable to Remove Git User Details', () => gitGraph.requestLoadConfig(), true);
                break;
            case 'dropCommit':
                refreshOrDisplayError(msg.error, 'Unable to Drop Commit');
                break;
            case 'dropCommits':
                refreshOrDisplayError(msg.error, 'Unable to Drop Commits');
                break;
            case 'editCommitMessage':
                refreshOrDisplayError(msg.error, 'Unable to Edit Commit Message');
                break;
            case 'dropStash':
                refreshOrDisplayError(msg.error, 'Unable to Drop Stash');
                break;
            case 'editRemote':
                refreshOrDisplayError(msg.error, 'Unable to Save Changes to Remote', true);
                break;
            case 'editUserDetails':
                finishOrDisplayErrors(msg.errors, 'Unable to Save Git User Details', () => gitGraph.requestLoadConfig(), true);
                break;
            case 'exportRepoConfig':
                refreshOrDisplayError(msg.error, 'Unable to Export Repository Configuration');
                break;
            case 'fetch':
                refreshOrDisplayError(msg.error, 'Unable to Fetch from Remote(s)');
                break;
            case 'fetchAvatar':
                imageResizer.resize(msg.image, (resizedImage) => {
                    gitGraph.loadAvatar(msg.email, resizedImage);
                });
                break;
            case 'fetchIntoLocalBranch':
                refreshOrDisplayError(msg.error, 'Unable to Fetch into Local Branch');
                break;
            case 'loadCommits':
                gitGraph.processLoadCommitsResponse(msg);
                break;
            case 'loadConfig':
                gitGraph.processLoadConfig(msg);
                break;
            case 'loadRepoInfo':
                gitGraph.processLoadRepoInfoResponse(msg);
                break;
            case 'loadRepos':
                gitGraph.loadRepos(msg.repos, msg.lastActiveRepo, msg.loadViewTo, msg.workspaceFolderPaths);
                break;
            case 'merge':
                refreshOrDisplayError(msg.error, 'Unable to Merge ' + msg.actionOn);
                break;
            case 'openExtensionSettings':
                finishOrDisplayError(msg.error, 'Unable to Open Extension Settings');
                break;
            case 'openExternalDirDiff':
                finishOrDisplayError(msg.error, 'Unable to Open External Directory Diff', true);
                break;
            case 'openExternalUrl':
                finishOrDisplayError(msg.error, 'Unable to Open External URL');
                break;
            case 'openFile':
                finishOrDisplayError(msg.error, 'Unable to Open File');
                break;
            case 'openTerminal':
                finishOrDisplayError(msg.error, 'Unable to Open Terminal', true);
                break;
            case 'popStash':
                refreshOrDisplayError(msg.error, 'Unable to Pop Stash');
                break;
            case 'pruneRemote':
                refreshOrDisplayError(msg.error, 'Unable to Prune Remote');
                break;
            case 'pullBranch':
                refreshOrDisplayError(msg.error, 'Unable to Pull Branch');
                break;
            case 'pushBranch':
                refreshAndDisplayErrors(msg.errors, 'Unable to Push Branch', msg.willUpdateBranchConfig);
                break;
            case 'pushStash':
                refreshOrDisplayError(msg.error, 'Unable to Stash Uncommitted Changes');
                break;
            case 'pushTag':
                if (msg.errors.length === 1 && isExtensionErrorInfo(msg.errors[0], "VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:")) {
                    handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.errors[0]);
                }
                else {
                    refreshAndDisplayErrors(msg.errors, 'Unable to Push Tag');
                }
                break;
            case 'rebase':
                if (msg.error === null) {
                    if (msg.interactive) {
                        dialog.closeActionRunning();
                    }
                    else {
                        gitGraph.refresh(false);
                    }
                }
                else {
                    dialog.showError('Unable to Rebase current branch on ' + msg.actionOn, msg.error, null, null);
                }
                break;
            case 'getRebaseTodoList':
                if (msg.error === null && msg.items !== null) {
                    gitGraph.showRebaseTodoEditor(msg.items);
                }
                else {
                    dialog.showError('Unable to get Rebase Todo List', msg.error, null, null);
                }
                break;
            case 'rebaseInteractive':
                if (msg.error === null) {
                    gitGraph.refresh(false);
                }
                else {
                    dialog.showError('Interactive Rebase', msg.error, null, null);
                }
                break;
            case 'refresh':
                gitGraph.refresh(false);
                break;
            case 'renameBranch':
                refreshOrDisplayError(msg.error, 'Unable to Rename Branch');
                break;
            case 'resetFileToRevision':
                refreshOrDisplayError(msg.error, 'Unable to Reset File to Revision');
                break;
            case 'resetToCommit':
                refreshOrDisplayError(msg.error, 'Unable to Reset to Commit');
                break;
            case 'revertCommit':
                refreshOrDisplayError(msg.error, 'Unable to Revert Commit');
                break;
            case 'undoLastCommit':
                refreshOrDisplayError(msg.error, 'Unable to Reset Last Commit');
                break;
            case 'squashCommits':
                refreshOrDisplayError(msg.error, 'Unable to Squash Commits');
                break;
            case 'setGlobalViewState':
                finishOrDisplayError(msg.error, 'Unable to save the Global View State');
                break;
            case 'setWorkspaceViewState':
                finishOrDisplayError(msg.error, 'Unable to save the Workspace View State');
                break;
            case 'startCodeReview':
                if (msg.error === null) {
                    gitGraph.startCodeReview(msg.commitHash, msg.compareWithHash, msg.codeReview);
                }
                else {
                    dialog.showError('Unable to Start Code Review', msg.error, null, null);
                }
                break;
            case 'tagDetails':
                if (msg.details !== null) {
                    gitGraph.renderTagDetails(msg.tagName, msg.commitHash, msg.details);
                }
                else {
                    dialog.showError('Unable to retrieve Tag Details', msg.error, null, null);
                }
                break;
            case 'updateCodeReview':
                if (msg.error !== null) {
                    dialog.showError('Unable to update Code Review', msg.error, null, null);
                }
                break;
            case 'viewDiff':
                finishOrDisplayError(msg.error, 'Unable to View Diff');
                break;
            case 'viewDiffWithWorkingFile':
                finishOrDisplayError(msg.error, 'Unable to View Diff with Working File');
                break;
            case 'viewFileAtRevision':
                finishOrDisplayError(msg.error, 'Unable to View File at Revision');
                break;
            case 'viewScm':
                finishOrDisplayError(msg.error, 'Unable to open the Source Control View');
                break;
        }
    });
    function handleResponseDeleteBranch(msg) {
        if (msg.errors.length > 0 && msg.errors[0] !== null && msg.errors[0].includes('git branch -D')) {
            dialog.showConfirmation('The branch <b><i>' + escapeHtml(msg.branchName) + '</i></b> is not fully merged. Would you like to force delete it?', 'Yes, force delete branch', () => {
                runAction({ command: 'deleteBranch', repo: msg.repo, branchName: msg.branchName, forceDelete: true, deleteOnRemotes: msg.deleteOnRemotes }, 'Deleting Branch');
            }, { type: "repo" });
        }
        else {
            refreshAndDisplayErrors(msg.errors, 'Unable to Delete Branch');
        }
    }
    function handleResponsePushTagCommitNotOnRemote(repo, tagName, remotes, commitHash, error) {
        const remotesNotContainingCommit = parseExtensionErrorInfo(error, "VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:");
        const html = '<span class="dialogAlert">' + SVG_ICONS.alert + 'Warning: Commit is not on Remote' + (remotesNotContainingCommit.length > 1 ? 's ' : ' ') + '</span><br>' +
            '<span class="messageContent">' +
            '<p style="margin:0 0 6px 0;">The tag <b><i>' + escapeHtml(tagName) + '</i></b> is on a commit that isn\'t on any known branch on the remote' + (remotesNotContainingCommit.length > 1 ? 's' : '') + ' ' + formatCommaSeparatedList(remotesNotContainingCommit.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>')) + '.</p>' +
            '<p style="margin:0;">Would you like to proceed to push the tag to the remote' + (remotes.length > 1 ? 's' : '') + ' ' + formatCommaSeparatedList(remotes.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>')) + ' anyway?</p>' +
            '</span>';
        dialog.showForm(html, [{ type: 4, name: 'Always Proceed', value: false }], 'Proceed to Push', (values) => {
            if (values[0]) {
                updateGlobalViewState('pushTagSkipRemoteCheck', true);
            }
            runAction({
                command: 'pushTag',
                repo: repo,
                tagName: tagName,
                remotes: remotes,
                commitHash: commitHash,
                skipRemoteCheck: true
            }, 'Pushing Tag');
        }, { type: "repo" }, 'Cancel', null, true);
    }
    function refreshOrDisplayError(error, errorMessage, configChanges = false) {
        if (error === null) {
            gitGraph.refresh(false, configChanges);
        }
        else {
            dialog.showError(errorMessage, error, null, null);
        }
    }
    function refreshAndDisplayErrors(errors, errorMessage, configChanges = false) {
        const reducedErrors = reduceErrorInfos(errors);
        if (reducedErrors.error !== null) {
            dialog.showError(errorMessage, reducedErrors.error, null, null);
        }
        if (reducedErrors.partialOrCompleteSuccess) {
            gitGraph.refresh(false, configChanges);
        }
        else if (configChanges) {
            gitGraph.requestLoadConfig();
        }
    }
    function finishOrDisplayError(error, errorMessage, dismissActionRunning = false) {
        if (error !== null) {
            dialog.showError(errorMessage, error, null, null);
        }
        else if (dismissActionRunning) {
            dialog.closeActionRunning();
        }
    }
    function finishOrDisplayErrors(errors, errorMessage, partialOrCompleteSuccessCallback, dismissActionRunning = false) {
        const reducedErrors = reduceErrorInfos(errors);
        finishOrDisplayError(reducedErrors.error, errorMessage, dismissActionRunning);
        if (reducedErrors.partialOrCompleteSuccess) {
            partialOrCompleteSuccessCallback();
        }
    }
    function reduceErrorInfos(errors) {
        let error = null, partialOrCompleteSuccess = false;
        for (let i = 0; i < errors.length; i++) {
            if (errors[i] !== null) {
                error = error !== null ? error + '\n\n' + errors[i] : errors[i];
            }
            else {
                partialOrCompleteSuccess = true;
            }
        }
        return {
            error: error,
            partialOrCompleteSuccess: partialOrCompleteSuccess
        };
    }
    function isExtensionErrorInfo(error, prefix) {
        return error !== null && error.startsWith(prefix);
    }
    function parseExtensionErrorInfo(error, prefix) {
        return JSON.parse(error.substring(prefix.length));
    }
});
function generateFileViewHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, type, isUncommitted) {
    return type === 2
        ? generateFileListHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted)
        : generateFileTreeHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, true);
}
function generateFileTreeHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, topLevelFolder) {
    const curFolderInfo = topLevelFolder || !initialState.config.commitDetailsView.fileTreeCompactFolders
        ? { folder: folder, name: folder.name, pathSeg: folder.name }
        : getCurrentFolderInfo(folder, folder.name, folder.name);
    const children = sortFolderKeys(curFolderInfo.folder).map((key) => {
        const cur = curFolderInfo.folder.contents[key];
        return cur.type === 'folder'
            ? generateFileTreeHtml(cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, false)
            : generateFileTreeLeafHtml(cur.name, cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
    });
    return (topLevelFolder ? '' : '<li' + (curFolderInfo.folder.open ? '' : ' class="closed"') + ' data-pathseg="' + encodeURIComponent(curFolderInfo.pathSeg) + '"><span class="fileTreeFolder' + (curFolderInfo.folder.reviewed ? '' : ' pendingReview') + '" title="./' + escapeHtml(curFolderInfo.folder.folderPath) + '" data-folderpath="' + encodeURIComponent(curFolderInfo.folder.folderPath) + '"><span class="fileTreeFolderIcon">' + (curFolderInfo.folder.open ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder) + '</span><span class="gitFolderName">' + escapeHtml(curFolderInfo.name) + '</span></span>') +
        '<ul class="fileTreeFolderContents' + (curFolderInfo.folder.open ? '' : ' hidden') + '">' + children.join('') + '</ul>' +
        (topLevelFolder ? '' : '</li>');
}
function getCurrentFolderInfo(folder, name, pathSeg) {
    const keys = Object.keys(folder.contents);
    let child;
    return keys.length === 1 && (child = folder.contents[keys[0]]).type === 'folder'
        ? getCurrentFolderInfo(child, name + ' / ' + child.name, pathSeg + '/' + child.name)
        : { folder: folder, name: name, pathSeg: pathSeg };
}
function generateFileListHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted) {
    const sortLeaves = (folder, folderPath) => {
        let keys = sortFolderKeys(folder);
        let items = [];
        for (let i = 0; i < keys.length; i++) {
            let cur = folder.contents[keys[i]];
            let relPath = (folderPath !== '' ? folderPath + '/' : '') + cur.name;
            if (cur.type === 'folder') {
                items = items.concat(sortLeaves(cur, relPath));
            }
            else {
                items.push({ relPath: relPath, leaf: cur });
            }
        }
        return items;
    };
    let sortedLeaves = sortLeaves(folder, '');
    let html = '';
    for (let i = 0; i < sortedLeaves.length; i++) {
        html += generateFileTreeLeafHtml(sortedLeaves[i].relPath, sortedLeaves[i].leaf, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
    }
    return '<ul class="fileTreeFolderContents">' + html + '</ul>';
}
function generateFileTreeLeafHtml(name, leaf, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted) {
    let encodedName = encodeURIComponent(name), escapedName = escapeHtml(name);
    if (leaf.type === 'file') {
        const fileTreeFile = gitFiles[leaf.index];
        const textFile = fileTreeFile.additions !== null && fileTreeFile.deletions !== null;
        const diffPossible = fileTreeFile.type === "U" || textFile;
        const changeTypeMessage = GIT_FILE_CHANGE_TYPES[fileTreeFile.type] + (fileTreeFile.type === "R" ? ' (' + escapeHtml(fileTreeFile.oldFilePath) + ' → ' + escapeHtml(fileTreeFile.newFilePath) + ')' : '');
        return '<li data-pathseg="' + encodedName + '"><span class="fileTreeFileRecord' + (leaf.index === fileContextMenuOpen ? ' ' + CLASS_CONTEXT_MENU_ACTIVE : '') + '" data-index="' + leaf.index + '"><span class="fileTreeFile' + (diffPossible ? ' gitDiffPossible' : '') + (leaf.reviewed ? '' : ' ' + CLASS_PENDING_REVIEW) + '" title="' + (diffPossible ? 'Click to View Diff' : 'Unable to View Diff' + (fileTreeFile.type !== "D" ? ' (this is a binary file)' : '')) + ' • ' + changeTypeMessage + '"><span class="fileTreeFileIcon">' + SVG_ICONS.file + '</span><span class="gitFileName ' + fileTreeFile.type + '">' + escapedName + '</span></span>' +
            (initialState.config.enhancedAccessibility ? '<span class="fileTreeFileType" title="' + changeTypeMessage + '">' + fileTreeFile.type + '</span>' : '') +
            (fileTreeFile.type !== "A" && fileTreeFile.type !== "U" && fileTreeFile.type !== "D" && textFile ? '<span class="fileTreeFileAddDel">(<span class="fileTreeFileAdd" title="' + fileTreeFile.additions + ' addition' + (fileTreeFile.additions !== 1 ? 's' : '') + '">+' + fileTreeFile.additions + '</span>|<span class="fileTreeFileDel" title="' + fileTreeFile.deletions + ' deletion' + (fileTreeFile.deletions !== 1 ? 's' : '') + '">-' + fileTreeFile.deletions + '</span>)</span>' : '') +
            (fileTreeFile.newFilePath === lastViewedFile ? '<span id="cdvLastFileViewed" title="Last File Viewed">' + SVG_ICONS.eyeOpen + '</span>' : '') +
            '<span class="copyGitFile fileTreeFileAction" title="Copy Absolute File Path to Clipboard">' + SVG_ICONS.copy + '</span>' +
            (fileTreeFile.type !== "D"
                ? (diffPossible && !isUncommitted ? '<span class="viewGitFileAtRevision fileTreeFileAction" title="View File at this Revision">' + SVG_ICONS.commit + '</span>' : '') +
                    '<span class="openGitFile fileTreeFileAction" title="Open File">' + SVG_ICONS.openFile + '</span>'
                : '') + '</span></li>';
    }
    else {
        return '<li data-pathseg="' + encodedName + '"><span class="fileTreeRepo" data-path="' + encodeURIComponent(leaf.path) + '" title="Click to View Repository"><span class="fileTreeRepoIcon">' + SVG_ICONS.closedFolder + '</span>' + escapedName + '</span></li>';
    }
}
function alterFileTreeFolderOpen(folder, folderPath, open) {
    let path = folderPath.split('/'), i, cur = folder;
    for (i = 0; i < path.length; i++) {
        if (typeof cur.contents[path[i]] !== 'undefined') {
            cur = cur.contents[path[i]];
            if (i === path.length - 1)
                cur.open = open;
        }
        else {
            return;
        }
    }
}
function alterFileTreeFileReviewed(folder, filePath, reviewed) {
    let path = filePath.split('/'), i, cur = folder, folders = [folder];
    for (i = 0; i < path.length; i++) {
        if (typeof cur.contents[path[i]] !== 'undefined') {
            if (i < path.length - 1) {
                cur = cur.contents[path[i]];
                folders.push(cur);
            }
            else {
                cur.contents[path[i]].reviewed = reviewed;
            }
        }
        else {
            break;
        }
    }
    for (i = folders.length - 1; i >= 0; i--) {
        let keys = Object.keys(folders[i].contents), entireFolderReviewed = true;
        for (let j = 0; j < keys.length; j++) {
            let cur = folders[i].contents[keys[j]];
            if ((cur.type === 'folder' || cur.type === 'file') && !cur.reviewed) {
                entireFolderReviewed = false;
                break;
            }
        }
        folders[i].reviewed = entireFolderReviewed;
    }
}
function setFileTreeReviewed(folder, reviewed) {
    folder.reviewed = reviewed;
    let keys = Object.keys(folder.contents);
    for (let i = 0; i < keys.length; i++) {
        let cur = folder.contents[keys[i]];
        if (cur.type === 'folder') {
            setFileTreeReviewed(cur, reviewed);
        }
        else if (cur.type === 'file') {
            cur.reviewed = reviewed;
        }
    }
}
function calcFileTreeFoldersReviewed(folder) {
    const calc = (folder) => {
        let reviewed = true;
        let keys = Object.keys(folder.contents);
        for (let i = 0; i < keys.length; i++) {
            let cur = folder.contents[keys[i]];
            if ((cur.type === 'folder' && !calc(cur)) || (cur.type === 'file' && !cur.reviewed))
                reviewed = false;
        }
        folder.reviewed = reviewed;
        return reviewed;
    };
    calc(folder);
}
function updateFileTreeHtml(elem, folder) {
    let ul = getChildUl(elem);
    if (ul === null)
        return;
    for (let i = 0; i < ul.children.length; i++) {
        let li = ul.children[i];
        let pathSeg = decodeURIComponent(li.dataset.pathseg);
        let child = getChildByPathSegment(folder, pathSeg);
        if (child.type === 'folder') {
            alterClass(li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
            updateFileTreeHtml(li, child);
        }
        else if (child.type === 'file') {
            alterClass(li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
        }
    }
}
function updateFileTreeHtmlFileReviewed(elem, folder, filePath) {
    let path = filePath;
    const update = (elem, folder) => {
        let ul = getChildUl(elem);
        if (ul === null)
            return;
        for (let i = 0; i < ul.children.length; i++) {
            let li = ul.children[i];
            let pathSeg = decodeURIComponent(li.dataset.pathseg);
            if (path === pathSeg || path.startsWith(pathSeg + '/')) {
                let child = getChildByPathSegment(folder, pathSeg);
                if (child.type === 'folder') {
                    alterClass(li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
                    path = path.substring(pathSeg.length + 1);
                    update(li, child);
                }
                else if (child.type === 'file') {
                    alterClass(li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
                }
                break;
            }
        }
    };
    update(elem, folder);
}
function getFilesInTree(folder, gitFiles) {
    let files = [];
    const scanFolder = (folder) => {
        let keys = Object.keys(folder.contents);
        for (let i = 0; i < keys.length; i++) {
            let cur = folder.contents[keys[i]];
            if (cur.type === 'folder') {
                scanFolder(cur);
            }
            else if (cur.type === 'file') {
                files.push(gitFiles[cur.index].newFilePath);
            }
        }
    };
    scanFolder(folder);
    return files;
}
function sortFolderKeys(folder) {
    let keys = Object.keys(folder.contents);
    keys.sort((a, b) => folder.contents[a].type !== 'file' && folder.contents[b].type === 'file' ? -1 : folder.contents[a].type === 'file' && folder.contents[b].type !== 'file' ? 1 : folder.contents[a].name.localeCompare(folder.contents[b].name));
    return keys;
}
function getChildByPathSegment(folder, pathSeg) {
    let cur = folder, comps = pathSeg.split('/');
    for (let i = 0; i < comps.length; i++) {
        cur = cur.contents[comps[i]];
    }
    return cur;
}
function getCommitOrdering(repoValue) {
    switch (repoValue) {
        case "default":
            return initialState.config.commitOrdering;
        case "date":
            return "date";
        case "author-date":
            return "author-date";
        case "topo":
            return "topo";
    }
}
function getShowRemoteBranches(repoValue) {
    return repoValue === 0
        ? initialState.config.showRemoteBranches
        : repoValue === 1;
}
function getSimplifyByDecoration(repoValue) {
    return repoValue === 0
        ? initialState.config.simplifyByDecoration
        : repoValue === 1;
}
function getShowStashes(repoValue) {
    return repoValue === 0
        ? initialState.config.showStashes
        : repoValue === 1;
}
function getShowTags(repoValue) {
    return repoValue === 0
        ? initialState.config.showTags
        : repoValue === 1;
}
function getIncludeCommitsMentionedByReflogs(repoValue) {
    return repoValue === 0
        ? initialState.config.includeCommitsMentionedByReflogs
        : repoValue === 1;
}
function getOnlyFollowFirstParent(repoValue) {
    return repoValue === 0
        ? initialState.config.onlyFollowFirstParent
        : repoValue === 1;
}
function getOnRepoLoadShowCheckedOutBranch(repoValue) {
    return repoValue === 0
        ? initialState.config.onRepoLoad.showCheckedOutBranch
        : repoValue === 1;
}
function getOnRepoLoadShowSpecificBranches(repoValue) {
    return repoValue === null
        ? initialState.config.onRepoLoad.showSpecificBranches
        : repoValue;
}
function haveFilesChanged(oldFiles, newFiles) {
    if ((oldFiles === null) !== (newFiles === null)) {
        return true;
    }
    else if (oldFiles === null && newFiles === null) {
        return false;
    }
    else {
        return !arraysEqual(oldFiles, newFiles, (a, b) => a.additions === b.additions && a.deletions === b.deletions && a.newFilePath === b.newFilePath && a.oldFilePath === b.oldFilePath && a.type === b.type);
    }
}
function abbrevCommit(commitHash) {
    return commitHash.substring(0, 8);
}
function getRepoDropdownOptions(repos) {
    const repoPaths = getSortedRepositoryPaths(repos, initialState.config.repoDropdownOrder);
    const paths = [], names = [], distinctNames = [], firstSep = [];
    const resolveAmbiguous = (indexes) => {
        let firstOccurrence = {}, ambiguous = {};
        for (let i = 0; i < indexes.length; i++) {
            let name = distinctNames[indexes[i]];
            if (typeof firstOccurrence[name] === 'number') {
                if (typeof ambiguous[name] === 'undefined') {
                    ambiguous[name] = [firstOccurrence[name]];
                }
                ambiguous[name].push(indexes[i]);
            }
            else {
                firstOccurrence[name] = indexes[i];
            }
        }
        let ambiguousNames = Object.keys(ambiguous);
        for (let i = 0; i < ambiguousNames.length; i++) {
            let ambiguousIndexes = ambiguous[ambiguousNames[i]], retestIndexes = [];
            for (let j = 0; j < ambiguousIndexes.length; j++) {
                let ambiguousIndex = ambiguousIndexes[j];
                let nextSep = paths[ambiguousIndex].lastIndexOf('/', paths[ambiguousIndex].length - distinctNames[ambiguousIndex].length - 2);
                if (firstSep[ambiguousIndex] < nextSep) {
                    distinctNames[ambiguousIndex] = paths[ambiguousIndex].substring(nextSep + 1);
                    retestIndexes.push(ambiguousIndex);
                }
                else {
                    distinctNames[ambiguousIndex] = paths[ambiguousIndex];
                }
            }
            if (retestIndexes.length > 1) {
                resolveAmbiguous(retestIndexes);
            }
        }
    };
    const indexes = [];
    for (let i = 0; i < repoPaths.length; i++) {
        firstSep.push(repoPaths[i].indexOf('/'));
        const repo = repos[repoPaths[i]];
        if (repo.name) {
            paths.push(repoPaths[i]);
            names.push(repo.name);
            distinctNames.push(repo.name);
        }
        else if (firstSep[i] === repoPaths[i].length - 1 || firstSep[i] === -1) {
            paths.push(repoPaths[i]);
            names.push(repoPaths[i]);
            distinctNames.push(repoPaths[i]);
        }
        else {
            paths.push(repoPaths[i].endsWith('/') ? repoPaths[i].substring(0, repoPaths[i].length - 1) : repoPaths[i]);
            let name = paths[i].substring(paths[i].lastIndexOf('/') + 1);
            names.push(name);
            distinctNames.push(name);
            indexes.push(i);
        }
    }
    resolveAmbiguous(indexes);
    const options = [];
    for (let i = 0; i < repoPaths.length; i++) {
        let hint;
        if (names[i] === distinctNames[i]) {
            hint = '';
        }
        else {
            let hintPath = distinctNames[i].substring(0, distinctNames[i].length - names[i].length - 1);
            let hintComps = hintPath.split('/');
            let keepDirs = hintComps[0] !== '' ? 2 : 3;
            if (hintComps.length > keepDirs)
                hintComps.splice(keepDirs, hintComps.length - keepDirs, '...');
            hint = (distinctNames[i] !== paths[i] ? '.../' : '') + hintComps.join('/');
        }
        options.push({ name: names[i], value: repoPaths[i], hint: hint });
    }
    return options;
}
function runAction(msg, action) {
    dialog.showActionRunning(action);
    sendMessage(msg);
}
function getBranchLabels(heads, remotes) {
    let headLabels = [], headLookup = {}, remoteLabels;
    for (let i = 0; i < heads.length; i++) {
        headLabels.push({ name: heads[i], remotes: [] });
        headLookup[heads[i]] = i;
    }
    if (initialState.config.referenceLabels.combineLocalAndRemoteBranchLabels) {
        let remainingRemoteLabels = [];
        for (let i = 0; i < remotes.length; i++) {
            if (remotes[i].remote !== null) {
                let branchName = remotes[i].name.substring(remotes[i].remote.length + 1);
                if (typeof headLookup[branchName] === 'number') {
                    headLabels[headLookup[branchName]].remotes.push(remotes[i].remote);
                    continue;
                }
            }
            remainingRemoteLabels.push(remotes[i]);
        }
        remoteLabels = remainingRemoteLabels;
    }
    else {
        remoteLabels = remotes;
    }
    return { heads: headLabels, remotes: remoteLabels };
}
function findCommitElemWithId(elems, id) {
    if (id === null)
        return null;
    let findIdStr = id.toString();
    for (let i = 0; i < elems.length; i++) {
        if (findIdStr === elems[i].dataset.id)
            return elems[i];
    }
    return null;
}
function generateSignatureHtml(signature) {
    return '<span class="signatureInfo ' + signature.status + '" title="' + GIT_SIGNATURE_STATUS_DESCRIPTIONS[signature.status] + ':'
        + ' Signed by ' + escapeHtml(signature.signer !== '' ? signature.signer : '<Unknown>')
        + ' (GPG Key Id: ' + escapeHtml(signature.key !== '' ? signature.key : '<Unknown>') + ')">'
        + (signature.status === "G"
            ? SVG_ICONS.passed
            : signature.status === "B"
                ? SVG_ICONS.failed
                : SVG_ICONS.inconclusive)
        + '</span>';
}
function closeDialogAndContextMenu() {
    if (dialog.isOpen())
        dialog.close();
    if (contextMenu.isOpen())
        contextMenu.close();
}

})(document, window);
