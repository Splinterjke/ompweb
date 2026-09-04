/**
 * Skill Frontmatter parser, validation and in-place diagnostic repair engine.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parse as loadYaml } from 'yaml';
import type { DiagnosticEntry, WritableRoot } from './protocol';
import { detectRootOfPath } from './skill-hub-service';

export function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export interface FrontmatterValue {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
  content: string;
}

export function parseFrontmatter(text: string): { value: FrontmatterValue } | { error: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (match === null) return { error: 'missing YAML frontmatter (--- block)' };
  let data: unknown;
  const rawFrontmatter = match[1];
  try {
    data = loadYaml(rawFrontmatter);
  } catch (error) {
    const repaired = repairFrontmatterScalarFields(rawFrontmatter);
    if (repaired !== null) {
      try {
        data = loadYaml(repaired);
      } catch {
        return { error: 'invalid YAML frontmatter: ' + (error instanceof Error ? error.message : String(error)) };
      }
    } else {
      return { error: 'invalid YAML frontmatter: ' + (error instanceof Error ? error.message : String(error)) };
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'frontmatter must be a YAML mapping' };
  }
  const record = data as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name === '') return { error: 'frontmatter requires a name field' };
  if (!isSkillName(name)) return { error: 'invalid skill name "' + name + '" (must be kebab-case)' };
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (description === '') return { error: 'frontmatter requires a description field' };
  const whenToUse = typeof record.whenToUse === 'string' && record.whenToUse.trim() !== '' ? record.whenToUse.trim() : undefined;

  let invocation: { modelInvocable: boolean; userInvocable: boolean };
  try {
    const disableModel = frontmatterBoolean(record, 'disable-model-invocation') ?? frontmatterBoolean(record, 'disableModelInvocation') ?? frontmatterBoolean(record, 'hide');
    const userInvocable = frontmatterBoolean(record, 'user-invocable') ?? frontmatterBoolean(record, 'userInvocable');
    invocation = { modelInvocable: disableModel !== true, userInvocable: userInvocable !== false };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  return { value: { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}), invocation, content: (match[2] ?? '').trim() } };
}

export function validateSkillFrontmatter(fm: Record<string, unknown>): string | null {
  if (typeof fm.name === 'string' && !isSkillName(fm.name.trim())) {
    return `invalid skill name "${fm.name}" (must be kebab-case)`;
  }
  return null;
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true;
      case 'false': case 'no': case 'off': return false;
    }
  }
  throw new TypeError('frontmatter field "' + key + '" must be a boolean');
}

export function repairFrontmatterScalarFields(frontmatter: string): string | null {
  let changed = false;
  let blockScalarIndent: number | null = null;
  const repairedLines: string[] = [];

  for (const line of frontmatter.split('\n')) {
    const indent = line.search(/[^ ]/);
    const effectiveIndent = indent === -1 ? line.length : indent;
    if (blockScalarIndent !== null) {
      if (line.trim() === '' || effectiveIndent > blockScalarIndent) {
        repairedLines.push(line);
        continue;
      }
      blockScalarIndent = null;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      repairedLines.push(line);
      continue;
    }
    const key = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1);
    if (key.trim() === '' || value.length === 0 || !/^\s/.test(value)) {
      repairedLines.push(line);
      continue;
    }
    const trimmedStart = value.trimStart();
    const leadingWhitespace = value.slice(0, value.length - trimmedStart.length);
    let scalar = trimmedStart;
    let comment = '';

    for (let idx = 0; idx < trimmedStart.length; idx += 1) {
      if (trimmedStart[idx] === '#') {
        const prev = idx === 0 ? ' ' : trimmedStart[idx - 1];
        const next = idx + 1 < trimmedStart.length ? trimmedStart[idx + 1] : ' ';
        if (/\s/.test(prev) && /\s/.test(next)) {
          const commentStart = trimmedStart.slice(0, idx).trimEnd().length;
          scalar = trimmedStart.slice(0, commentStart);
          comment = trimmedStart.slice(commentStart);
          break;
        }
      }
    }
    scalar = scalar.trimEnd();
    if (scalar === '') {
      repairedLines.push(line);
      continue;
    }
    const firstChar = scalar[0];
    if (firstChar === '|' || firstChar === '>') {
      blockScalarIndent = effectiveIndent;
      repairedLines.push(line);
      continue;
    }
    if (firstChar === "'" || firstChar === '"') {
      repairedLines.push(line);
      continue;
    }
    let hasColonSeparator = false;
    for (let i = 0; i < scalar.length - 1; i += 1) {
      if (scalar[i] === ':' && /\s/.test(scalar[i + 1])) {
        hasColonSeparator = true;
        break;
      }
    }
    let invalidFlowLike = false;
    if (firstChar === '[' || firstChar === '{' || firstChar === '@' || firstChar === '`') {
      try {
        loadYaml(scalar);
      } catch {
        invalidFlowLike = true;
      }
    }
    if (!hasColonSeparator && !invalidFlowLike) {
      repairedLines.push(line);
      continue;
    }
    const quotedScalar = "'" + scalar.replace(/'/g, "''") + "'";
    repairedLines.push(key + ':' + leadingWhitespace + quotedScalar + comment);
    changed = true;
  }
  return changed ? repairedLines.join('\n') : null;
}

export function repairFrontmatterFileText(text: string): string | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const repaired = repairFrontmatterScalarFields(match[1]);
  if (repaired === null) return null;
  try {
    loadYaml(repaired);
  } catch {
    return null;
  }
  const body = match[2] ?? '';
  return '---\n' + repaired + '\n---' + (body !== '' ? '\n' + body : '');
}

export async function fixDiagnosticFile(filePath: string): Promise<string> {
  const root = detectRootOfPath(filePath);
  if (root === undefined) throw new TypeError('Not a writable skill path: ' + filePath);
  const text = await readFile(filePath, 'utf8');
  const repairedText = repairFrontmatterFileText(text);
  if (repairedText === null) throw new TypeError('Diagnostic is not auto-fixable: ' + filePath);
  const parsed = parseFrontmatter(repairedText);
  if ('error' in parsed) throw new TypeError('Repaired frontmatter still invalid: ' + parsed.error);
  await writeFile(filePath, repairedText, 'utf8');
  return filePath;
}
