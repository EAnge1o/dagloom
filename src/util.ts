/** Small zero-dependency helpers shared across dagloom. */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Short hex id for run identifiers. */
export function shortId(): string {
  return randomBytes(4).toString('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** "1. Install deps" → "install-deps"; "Build 🔧 core" → "build-core". */
export function slugify(s: string): string {
  const t = s
    .trim()
    .toLowerCase()
    .replace(/^\d+\s*[.、)）]\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return t || 'task';
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0']);

export function parseBool(v: string, what = 'value'): boolean {
  const t = v.trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  throw new Error(`invalid boolean ${what}: "${v}"`);
}

/** "a, b, c" → ["a", "b", "c"] */
export function parseList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "A=1, B=x=y" → { A: "1", B: "x=y" } */
export function parseKvList(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) throw new Error(`invalid KEY=VALUE pair: "${p}"`);
    out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return out;
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Write via a temp file + rename so readers never see a torn state.json. */
export async function atomicWriteFile(p: string, data: string): Promise<void> {
  const tmp = `${p}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
  } finally {
    await fh.close();
  }
  await rename(tmp, p);
}

/**
 * Find an executable on PATH without a dependency. Returns the absolute path,
 * or null. On Windows, PATHEXT extensions are probed (.exe, .cmd, .bat, ...).
 */
export async function which(bin: string): Promise<string | null> {
  const hasSep = bin.includes(path.sep) || bin.includes('/');
  const candidates: string[] = [];
  if (hasSep) {
    candidates.push(path.resolve(bin));
  } else {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const exts =
      process.platform === 'win32'
        ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
        : [''];
    for (const dir of dirs) {
      candidates.push(path.join(dir, bin));
      for (const ext of exts) {
        if (ext) candidates.push(path.join(dir, bin + ext.toLowerCase()));
      }
    }
  }
  for (const cand of candidates) {
    try {
      await access(cand, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      if (await isFile(cand)) return cand;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Kill a process and everything it spawned. */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // best effort — the process may already be gone
    }
    return;
  }
  // The child is spawned detached (own process group) on POSIX, so a single
  // negative-pid signal reaches the whole tree.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 3000).unref();
}

/** Last `n` lines of a text file; the whole file when it has fewer. */
export async function readTail(file: string, n = 20): Promise<string[]> {
  let data: string;
  try {
    data = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const lines = data.split('\n');
  return lines.slice(Math.max(0, lines.length - n));
}

/** HH:MM:SS in the local timezone, for event log lines. */
export function localTime(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
