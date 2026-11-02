/**
 * Parser for the `loom.md` workflow format.
 *
 * A workflow is plain markdown:
 *   - every `## Heading` starts a task (except reserved settings sections);
 *   - `key: value` lines are fields;
 *   - a ```sh fenced block is a multi-line script (alternative to `cmd:`);
 *   - every other non-empty line is free-text description (ignored);
 *   - a reserved `## loom` section holds global settings.
 *
 * The grammar is deliberately tiny: no YAML, no front matter, no magic.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoomSettings, TaskDef, Workflow } from './types.js';
import { parseBool, parseKvList, parseList, sha1, slugify } from './util.js';

export interface ParseIssue {
  severity: 'error' | 'warning';
  line?: number;
  message: string;
}

export interface ParseResult {
  workflow: Workflow;
  issues: ParseIssue[];
}

export const WORKFLOW_FILE = 'loom.md';

const RESERVED = new Set(['loom', 'settings', 'dagloom', 'dag-loom']);
const ALIASES: Record<string, string> = {
  depends_on: 'depends',
  needs: 'depends',
  after: 'depends',
  retries: 'retry',
};
const TASK_KEYS = new Set([
  'cmd',
  'agent',
  'agent_cmd',
  'depends',
  'retry',
  'backoff',
  'timeout',
  'allow_fail',
  'outputs',
  'env',
  'cwd',
  'id',
]);
const LOOM_KEYS = new Set([
  'concurrency',
  'fail_fast',
  'agent_cmd',
  'env',
  'task_timeout',
]);
const FENCE_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'powershell', 'ps1']);

interface RawSection {
  title: string;
  titleLine: number;
  body: { text: string; line: number }[];
}

interface FieldValue {
  value: string;
  line: number;
}

const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Parse a workflow from its full text. Never throws — problems come back as issues. */
export function parseWorkflowSource(source: string, filePath: string): ParseResult {
  const issues: ParseIssue[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const file = path.resolve(filePath);

  // Reject YAML front matter up front, then parse what follows it.
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (lines[start]?.trim() === '---') {
    let close = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        close = i;
        break;
      }
    }
    issues.push({
      severity: 'error',
      line: start + 1,
      message:
        "YAML front matter is not supported. Put global settings in a '## loom' section instead.",
    });
    if (close >= 0) start = close + 1;
  }

  // Pass 1: split into `##` sections, treating fenced blocks as opaque text.
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inFence = false;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i]!;
    const trimmed = text.trim();
    if (!inFence && trimmed.startsWith('```')) {
      inFence = true;
      current?.body.push({ text, line: i + 1 });
      continue;
    }
    if (inFence) {
      if (trimmed.startsWith('```')) inFence = false;
      current?.body.push({ text, line: i + 1 });
      continue;
    }
    const heading = trimmed.match(HEADING_RE);
    if (heading && heading[1] === '##') {
      current = { title: heading[2]!.trim(), titleLine: i + 1, body: [] };
      sections.push(current);
      continue;
    }
    // `#` doc titles, `###` sub-headings, prose, blanks — outside sections
    // they are ignored; inside a section they become description.
    current?.body.push({ text, line: i + 1 });
  }
  if (inFence) {
    issues.push({
      severity: 'error',
      message: 'Unterminated fenced code block (a ``` block was never closed).',
    });
  }

  // Pass 2: interpret each section.
  const settings: LoomSettings = {
    concurrency: 4,
    failFast: false,
    env: {},
  };
  const tasks = new Map<string, TaskDef>();
  const order: string[] = [];
  const titleIndex = new Map<string, string>();

  for (const section of sections) {
    const titleLower = section.title.toLowerCase();
    if (RESERVED.has(titleLower) || RESERVED.has(slugify(section.title))) {
      parseSettingsSection(section, settings, issues);
      continue;
    }
    parseTaskSection(section, tasks, order, titleIndex, issues);
  }

  const workflow: Workflow = {
    file,
    dir: path.dirname(file),
    settings,
    tasks,
    order,
    titleIndex,
  };
  if (sections.length === 0) {
    issues.push({
      severity: 'error',
      message: `No '## task' sections found. Every '## Heading' in the file is a task — see 'dagloom init'.`,
    });
  }
  return { workflow, issues };
}

export async function parseWorkflowFile(filePath: string): Promise<ParseResult> {
  const source = await readFile(filePath, 'utf8');
  return parseWorkflowSource(source, filePath);
}

function parseSettingsSection(section: RawSection, settings: LoomSettings, issues: ParseIssue[]): void {
  const fields = collectFields(section, issues);
  for (const [rawKey, fv] of fields) {
    const key = rawKey.toLowerCase();
    if (!LOOM_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        line: fv.line,
        message: `unknown setting "${rawKey}" (known: ${[...LOOM_KEYS].join(', ')})`,
      });
      continue;
    }
    try {
      applySetting(settings, key, fv.value, issues, fv.line);
    } catch (e) {
      issues.push({ severity: 'error', line: fv.line, message: (e as Error).message });
    }
  }
}

function applySetting(
  settings: LoomSettings,
  key: string,
  value: string,
  issues: ParseIssue[],
  line: number,
): void {
  switch (key) {
    case 'concurrency': {
      const n = parseNonNegativeInt(value, 'concurrency');
      if (n < 1 || n > 64) throw new Error('concurrency must be between 1 and 64');
      settings.concurrency = n;
      break;
    }
    case 'fail_fast':
      settings.failFast = parseBool(value, 'fail_fast');
      break;
    case 'agent_cmd':
      settings.agentCmd = value;
      break;
    case 'env':
      settings.env = { ...settings.env, ...parseKvList(value) };
      break;
    case 'task_timeout': {
      const n = parseNonNegativeInt(value, 'task_timeout');
      settings.taskTimeout = n > 0 ? n : undefined;
      break;
    }
    default:
      issues.push({ severity: 'warning', line, message: `unknown setting "${key}"` });
  }
}

function parseTaskSection(
  section: RawSection,
  tasks: Map<string, TaskDef>,
  order: string[],
  titleIndex: Map<string, string>,
  issues: ParseIssue[],
): void {
  const fields = collectFields(section, issues);
  const description: string[] = [];
  let script: { body: string; lang: string; line: number } | null = null;

  // Walk the raw body so fences and prose are handled in document order.
  let inFence = false;
  let fenceLang = '';
  let fenceLine = 0;
  let scriptLines: string[] = [];
  for (const { text, line } of section.body) {
    const trimmed = text.trim();
    if (inFence) {
      if (trimmed.startsWith('```')) {
        inFence = false;
        if (script) {
          issues.push({
            severity: 'error',
            line: fenceLine,
            message: 'a task can only have one fenced script block',
          });
        } else {
          script = { body: scriptLines.join('\n'), lang: fenceLang, line: fenceLine };
        }
        scriptLines = [];
      } else {
        scriptLines.push(text);
      }
      continue;
    }
    if (trimmed.startsWith('```')) {
      inFence = true;
      fenceLang = trimmed.slice(3).trim().toLowerCase();
      fenceLine = line;
      scriptLines = [];
      continue;
    }
    const m = trimmed.match(FIELD_RE);
    if (m) continue; // fields already collected by collectFields
    if (trimmed) description.push(trimmed);
  }
  if (inFence) {
    issues.push({
      severity: 'error',
      line: fenceLine,
      message: 'unterminated fenced code block in this task',
    });
  }

  // Normalize keys + aliases; remember where each field came from.
  const norm = new Map<string, { value: string; line: number; raw: string }>();
  for (const [rawKey, fv] of fields) {
    const key = rawKey.toLowerCase();
    const canonical = ALIASES[key] ?? key;
    if (!TASK_KEYS.has(canonical)) {
      issues.push({
        severity: 'warning',
        line: fv.line,
        message: `unknown field "${rawKey}" (known: ${[...TASK_KEYS].join(', ')})`,
      });
      continue;
    }
    if (norm.has(canonical)) {
      issues.push({
        severity: 'error',
        line: fv.line,
        message: `duplicate field "${canonical}"`,
      });
      continue;
    }
    norm.set(canonical, { value: fv.value, line: fv.line, raw: rawKey });
  }

  const get = (k: string) => norm.get(k);
  const boolField = (k: string, def: boolean): boolean => {
    const f = get(k);
    if (!f) return def;
    try {
      return parseBool(f.value, k);
    } catch (e) {
      issues.push({ severity: 'error', line: f.line, message: (e as Error).message });
      return def;
    }
  };
  const intField = (k: string): number | undefined => {
    const f = get(k);
    if (!f) return undefined;
    try {
      return parseNonNegativeInt(f.value, k);
    } catch (e) {
      issues.push({ severity: 'error', line: f.line, message: (e as Error).message });
      return undefined;
    }
  };
  const listField = (k: string): string[] => {
    const f = get(k);
    if (!f) return [];
    try {
      return parseList(f.value);
    } catch (e) {
      issues.push({ severity: 'error', line: f.line, message: (e as Error).message });
      return [];
    }
  };
  const kvField = (k: string): Record<string, string> => {
    const f = get(k);
    if (!f) return {};
    try {
      return parseKvList(f.value);
    } catch (e) {
      issues.push({ severity: 'error', line: f.line, message: (e as Error).message });
      return {};
    }
  };

  const agentField = get('agent');
  const cmdField = get('cmd');
  const hasScript = script !== null && FENCE_LANGS.has(script.lang);
  if (script && !hasScript) {
    issues.push({
      severity: 'warning',
      line: script.line,
      message: `fenced block language "${script.lang}" is not a shell language (use sh, bash, shell, powershell...) — ignored`,
    });
  }

  const hasCmd = Boolean(cmdField) || hasScript;
  if (agentField && hasCmd) {
    issues.push({
      severity: 'error',
      line: agentField.line,
      message: 'a task cannot have both "agent:" and a command (cmd:/script)',
    });
    return;
  }
  if (!agentField && !hasCmd) {
    issues.push({
      severity: 'error',
      line: section.titleLine,
      message: `task "${section.title}" has no command — add a cmd: line, a sh fenced block, or an agent: line`,
    });
    return;
  }

  // Resolve the task id: explicit `id:` field wins, else slug of the heading.
  const idField = get('id');
  let id = slugify(section.title);
  if (idField) {
    const explicit = slugify(idField.value);
    if (!explicit) {
      issues.push({ severity: 'error', line: idField.line, message: 'id: must not be empty' });
      return;
    }
    id = explicit;
  }
  if (tasks.has(id)) {
    issues.push({
      severity: 'error',
      line: section.titleLine,
      message: `duplicate task id "${id}" — ids must be unique (set a distinct id: field or rename the heading)`,
    });
    return;
  }

  const kind = agentField ? 'agent' : 'cmd';
  const def: TaskDef = {
    id,
    title: section.title,
    kind,
    cmd: kind === 'cmd' ? (cmdField?.value ?? script?.body) : undefined,
    agentPrompt: agentField?.value,
    agentCmd: get('agent_cmd')?.value,
    depends: [],
    dependsRaw: listField('depends'),
    retry: intField('retry') ?? 0,
    backoff: intField('backoff') ?? 2,
    timeout: intField('timeout'),
    allowFail: boolField('allow_fail', false),
    outputs: listField('outputs'),
    env: kvField('env'),
    cwd: get('cwd')?.value,
    description: description.join(' '),
    line: section.titleLine,
    hash: '',
  };
  if (def.cmd !== undefined && def.cmd.trim() === '') {
    issues.push({ severity: 'error', line: section.titleLine, message: `task "${id}" has an empty command` });
    return;
  }
  def.hash = sha1(
    JSON.stringify({
      kind: def.kind,
      cmd: def.cmd,
      agentPrompt: def.agentPrompt,
      agentCmd: def.agentCmd,
      dependsRaw: def.dependsRaw,
      retry: def.retry,
      backoff: def.backoff,
      timeout: def.timeout,
      allowFail: def.allowFail,
      outputs: def.outputs,
      env: def.env,
      cwd: def.cwd,
    }),
  );
  tasks.set(id, def);
  order.push(id);
  titleIndex.set(section.title.toLowerCase(), id);
}

/** Collect `key: value` lines, skipping fence bodies. */
function collectFields(section: RawSection, issues: ParseIssue[]): Map<string, FieldValue> {
  const fields = new Map<string, FieldValue>();
  let inFence = false;
  for (const { text, line } of section.body) {
    const trimmed = text.trim();
    if (inFence) {
      if (trimmed.startsWith('```')) inFence = false;
      continue;
    }
    if (trimmed.startsWith('```')) {
      inFence = true;
      continue;
    }
    const m = trimmed.match(FIELD_RE);
    if (!m) continue;
    const key = m[1]!;
    if (fields.has(key.toLowerCase())) {
      issues.push({ severity: 'error', line, message: `duplicate field "${key}"` });
      continue;
    }
    fields.set(key.toLowerCase(), { value: (m[2] ?? '').trim(), line });
  }
  return fields;
}

function parseNonNegativeInt(v: string, what: string): number {
  const t = v.trim();
  if (!/^\d+$/.test(t)) throw new Error(`${what} must be a non-negative integer, got "${v}"`);
  const n = Number(t);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is too large: "${v}"`);
  return n;
}
