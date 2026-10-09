// Replacements for the VS Code extension host modules (utils.ts, logger.ts, config.ts, askpass/) used by
// the ported DataSource. Only the symbols consumed by lib/git-graph/dataSource.ts are implemented.

import * as cp from 'child_process';
import * as fs from 'fs';
import { DateType, SquashMessageFormat } from '@/vendor/vscode-git-graph/types';


/* General Constants */

export const UNCOMMITTED = '*';

/**
 * Error message used when no Git executable is available. Adapted from the upstream message to the
 * ompweb environment (the `OMPWEB_GIT_BIN` environment variable replaces the VS Code "git.path" setting).
 */
export const UNABLE_TO_FIND_GIT_MSG = 'Unable to find a Git executable. Either: Set the "OMPWEB_GIT_BIN" environment variable to the path and filename of an existing Git executable, or install Git and restart the server.';


/* Git Executable & Version Handling */

export interface GitExecutable {
	readonly path: string;
	readonly version: string;
}

export enum GitVersionRequirement {
	FetchAndPruneTags = '2.17.0',
	GpgInfo = '2.4.0',
	PushStash = '2.13.2',
	TagDetails = '1.7.8'
}

/**
 * Checks whether a version is at least a required version.
 * @param version The version to check.
 * @param requiredVersion The minimum required version.
 * @returns TRUE => `version` is at least `requiredVersion`, FALSE => `version` is older than `requiredVersion`.
 */
export function doesVersionMeetRequirement(version: string, requiredVersion: GitVersionRequirement) {
	const v1 = parseVersion(version);
	const v2 = parseVersion(requiredVersion);

	if (v1 === null || v2 === null) {
		// Unable to parse a version number
		return true;
	}

	if (v1.major > v2.major) return true; // Git major version is newer
	if (v1.major < v2.major) return false; // Git major version is older

	if (v1.minor > v2.minor) return true; // Git minor version is newer
	if (v1.minor < v2.minor) return false; // Git minor version is older

	if (v1.patch > v2.patch) return true; // Git patch version is newer
	if (v1.patch < v2.patch) return false; // Git patch version is older

	return true; // Versions are the same
}

/**
 * Parse a version number from a string.
 * @param version The string version number.
 * @returns The `major`.`minor`.`patch` version numbers.
 */
function parseVersion(version: string) {
	const match = version.trim().match(/^[0-9]+(\.[0-9]+|)(\.[0-9]+|)/);
	if (match === null) {
		// Unable to find a valid version number
		return null;
	}

	const comps = match[0].split('.');
	return {
		major: parseInt(comps[0], 10),
		minor: comps.length > 1 ? parseInt(comps[1], 10) : 0,
		patch: comps.length > 2 ? parseInt(comps[2], 10) : 0
	};
}

/**
 * Construct a message that explains that the Git executable is not compatible with a feature.
 * @param executable The Git executable.
 * @param version The minimum required version.
 * @param feature An optional name for the feature.
 * @returns The message for the user.
 */
export function constructIncompatibleGitVersionMessage(executable: GitExecutable, version: GitVersionRequirement, feature?: string) {
	return 'A newer version of Git (>= ' + version + ') is required for ' + (feature ? feature : 'this feature') + '. Git ' + executable.version + ' is currently installed. Please install a newer version of Git to use this feature.';
}


/* Path Manipulation */

const FS_REGEX = /\\/g;

/**
 * Get the normalised path of a string.
 * @param str The string.
 * @returns The normalised path.
 */
export function getPathFromStr(str: string) {
	return str.replace(FS_REGEX, '/');
}

/**
 * Get the normalised path of a URI. The port only ever passes plain string paths (the upstream
 * `vscode.Uri.file(x)` call sites were replaced with plain path handling), so this simply
 * normalises the string.
 * @param uri The path.
 * @returns The normalised path.
 */
export function getPathFromUri(uri: string) {
	return getPathFromStr(uri);
}

/**
 * Get the path with a trailing slash.
 * @param path The path.
 * @returns The path with a trailing slash.
 */
export function pathWithTrailingSlash(path: string) {
	return path.endsWith('/') ? path : path + '/';
}

/**
 * Get the normalised canonical absolute path (i.e. resolves symlinks in `path`).
 * @param path The path.
 * @param native Use the native realpath.
 * @returns The normalised canonical absolute path.
 */
export function realpath(path: string, native: boolean = false) {
	const { promise, resolve } = Promise.withResolvers<string>();
	(native ? fs.realpath.native : fs.realpath)(path, (err, resolvedPath) => resolve(err !== null ? path : getPathFromStr(resolvedPath)));
	return promise;
}


/* General Methods */

/**
 * Abbreviate a commit hash to the first eight characters.
 * @param commitHash The full commit hash.
 * @returns The abbreviated commit hash.
 */
export function abbrevCommit(commitHash: string) {
	return commitHash.substring(0, 8);
}

/**
 * Resolve the output of a spawned child process.
 * @param cmd The Child Process.
 * @returns Promise that resolves to [{code, error}, stdout, stderr]
 */
export function resolveSpawnOutput(cmd: cp.ChildProcess) {
	// status promise
	const status = Promise.withResolvers<{ code: number, error: Error | null }>();
	let statusResolved = false;
	cmd.on('error', (error) => {
		if (statusResolved) return;
		status.resolve({ code: -1, error: error });
		statusResolved = true;
	});
	cmd.on('exit', (code) => {
		if (statusResolved) return;
		status.resolve({ code: code ?? -1, error: null });
		statusResolved = true;
	});

	// stdout promise
	const stdout = Promise.withResolvers<Buffer>();
	const buffers: Buffer[] = [];
	cmd.stdout!.on('data', (b: Buffer) => { buffers.push(b); });
	cmd.stdout!.on('close', () => stdout.resolve(Buffer.concat(buffers)));

	// stderr promise
	const stderr = Promise.withResolvers<string>();
	let stderrText = '';
	cmd.stderr!.on('data', (d) => { stderrText += d; });
	cmd.stderr!.on('close', () => stderr.resolve(stderrText));

	return Promise.all([status.promise, stdout.promise, stderr.promise]);
}

/**
 * Surface an error message that the upstream extension would have shown in a VS Code notification.
 * There is no notification host in the server port, so the message is written to the server log.
 * @param message The error message.
 */
export function showErrorMessage(message: string) {
	console.error('[git-graph] ' + message);
}

/**
 * Open a new terminal with the Git executable set up. There is no terminal host in the server port,
 * so this is a no-op (kept so the DataSource method signatures and call sites remain unchanged).
 * @param _cwd The working directory the terminal would be opened in.
 * @param _gitPath The path of the Git executable.
 * @param _command The command that would be run.
 * @param _name The name for the terminal.
 */
export function openGitTerminal(_cwd: string, _gitPath: string, _command: string | null, _name: string) {
	// no-op: terminals are not available in the server port
}


/* Logger */

/**
 * Minimal Logger shim. The upstream Logger wrote to a VS Code Output Channel; in the server port all
 * methods are no-ops (kept so the DataSource call sites and method signatures remain unchanged).
 */
export class Logger {
	/**
	 * Log a message.
	 * @param _message The string to be logged.
	 */
	public log(_message: string) {
		// no-op
	}

	/**
	 * Log the execution of a spawned command.
	 * @param _cmd The command being spawned.
	 * @param _args The arguments passed to the command.
	 */
	public logCmd(_cmd: string, _args: string[]) {
		// no-op
	}

	/**
	 * Log an error message.
	 * @param _message The string to be logged.
	 */
	public logError(_message: string) {
		// no-op
	}
}


/* Askpass (no-TTY credential policy) */

export interface AskpassEnvironment {
	GIT_ASKPASS: string;
	GIT_TERMINAL_PROMPT: string;
	SSH_ASKPASS: string;
}

/**
 * Manages the environment variables that control Git credential prompting.
 *
 * Upstream spawned an in-process askpass server that relayed credential prompts to the VS Code UI.
 * There is no interactive host in the server port, so instead Git is always spawned in a fully
 * non-interactive ("no-TTY") mode:
 *  - `GIT_TERMINAL_PROMPT=0` (upstream-compatible standard Git variable) makes Git fail immediately
 *    instead of prompting on a terminal.
 *  - `GIT_ASKPASS` (upstream variable name) points at a fast-failing command so no GUI askpass helper
 *    is ever consulted (Git aborts the credential request when the helper exits non-zero).
 *  - `SSH_ASKPASS` is set to an empty string to suppress SSH passphrase prompts.
 *
 * Git operations that genuinely require credentials therefore fail quickly with an error message
 * (returned through the normal DataSource error paths) instead of hanging the server.
 */
export class AskpassManager {
	private readonly env: AskpassEnvironment;

	/** Resolves when the askpass manager shuts down; the no-TTY policy has no long-lived resources. */
	public readonly promise: Promise<{ code: number | null }>;

	constructor() {
		this.env = {
			GIT_ASKPASS: process.platform === 'win32' ? 'false' : '/bin/false', // non-zero exit => Git credential requests fail fast
			GIT_TERMINAL_PROMPT: '0',
			SSH_ASKPASS: ''
		};
		this.promise = Promise.resolve({ code: null });
	}

	/**
	 * Get the environment variables to spawn Git with.
	 * @returns The askpass environment variables.
	 */
	public getEnv(): AskpassEnvironment {
		return this.env;
	}

	/**
	 * Dispose the askpass manager (nothing to release for the no-TTY policy).
	 */
	public dispose() {
		// no-op
	}
}


/* Configuration */

/**
 * The subset of the upstream Git Graph configuration that the DataSource reads. Values are the
 * upstream extension defaults (from upstream src/config.ts); the webview communicates its own
 * rendering configuration separately, so these are static in the server port.
 */
export interface DataSourceConfig {
	readonly dateType: DateType;
	readonly useMailmap: boolean;
	readonly showSignatureStatus: boolean;
	readonly showCommitsOnlyReferencedByTags: boolean;
	readonly showRemoteHeads: boolean;
	readonly showUncommittedChanges: boolean;
	readonly showUntrackedFiles: boolean;
	readonly signCommits: boolean;
	readonly signTags: boolean;
	readonly squashMergeMessageFormat: SquashMessageFormat;
	readonly squashPullMessageFormat: SquashMessageFormat;
	readonly fileEncoding: string;
}

const DEFAULT_DATA_SOURCE_CONFIG: DataSourceConfig = Object.freeze({
	dateType: DateType.Author,
	useMailmap: false,
	showSignatureStatus: false,
	showCommitsOnlyReferencedByTags: true,
	showRemoteHeads: true,
	showUncommittedChanges: true,
	showUntrackedFiles: true,
	signCommits: false,
	signTags: false,
	squashMergeMessageFormat: SquashMessageFormat.Default,
	squashPullMessageFormat: SquashMessageFormat.Default,
	fileEncoding: 'utf8'
});

/**
 * Get the Git Graph configuration (frozen upstream defaults in the server port).
 * @param _repo The repository the configuration is requested for (unused; upstream supported per-repository overrides).
 * @returns The configuration object.
 */
export function getConfig(_repo?: string): DataSourceConfig {
	return DEFAULT_DATA_SOURCE_CONFIG;
}
