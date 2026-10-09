// Provides the process-wide Git executable probe and the singleton DataSource consumed by the API routes.

import { execFile } from 'child_process';
import { DataSource } from '@/lib/git-graph/dataSource';

export interface GitExecutableInfo {
	path: string;
	version: string;
}

let gitExecutablePromise: Promise<GitExecutableInfo | null> | null = null;
let dataSourcePromise: Promise<DataSource | null> | null = null;

/**
 * Probe a Git executable by running `<path> --version`.
 * @param gitPath The path (or bare program name) of the Git executable to probe.
 * @returns The Git executable info, or NULL if the executable is unavailable.
 */
function probeGitExecutable(gitPath: string): Promise<GitExecutableInfo | null> {
	const { promise, resolve } = Promise.withResolvers<GitExecutableInfo | null>();
	execFile(gitPath, ['--version'], (error, stdout) => {
		if (error !== null) {
			resolve(null);
			return;
		}
		const match = stdout.match(/[0-9]+\.[0-9]+(\.[0-9]+|)/);
		if (match === null) {
			// Unable to parse a version number from the `--version` output
			resolve(null);
			return;
		}
		resolve({ path: gitPath, version: match[0] });
	});
	return promise;
}

/**
 * Get the Git executable available to Git Graph, probing "git" on the PATH (or the path specified by
 * the "OMPWEB_GIT_BIN" environment variable) via `--version`. The result is cached per-process.
 * @returns The Git executable info, or NULL when Git is not available.
 */
export function getGitExecutable(): Promise<GitExecutableInfo | null> {
	if (gitExecutablePromise === null) {
		gitExecutablePromise = probeGitExecutable(process.env.OMPWEB_GIT_BIN !== undefined && process.env.OMPWEB_GIT_BIN !== '' ? process.env.OMPWEB_GIT_BIN : 'git');
	}
	return gitExecutablePromise;
}

/**
 * Get the process-wide singleton DataSource, backed by the Git executable found by `getGitExecutable()`.
 * @returns The DataSource, or NULL when no Git executable is available.
 */
export function getDataSource(): Promise<DataSource | null> {
	if (dataSourcePromise === null) {
		dataSourcePromise = getGitExecutable().then((gitExecutable) => gitExecutable !== null ? new DataSource(gitExecutable) : null);
	}
	return dataSourcePromise;
}
