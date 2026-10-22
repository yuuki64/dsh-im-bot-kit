// IM persona (人设提示词) for QQ / WeChat bot conversations.
//
// The persona lives in one plain Markdown file:
//   <DSH_HOME>/integrations/dsh-im/persona.md
//
// It is appended to the source guidance the channel already publishes for each
// IM session, so every QQ/WeChat conversation gets it without touching local
// DSH sessions. Edit the file (or use `/persona use <name>`) and the next
// message picks it up — no restart.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_CHARS = 12_000;

function home() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function personaDir() {
  return join(home(), 'integrations', 'dsh-im', 'personas');
}

export function activePersonaPath() {
  return join(home(), 'integrations', 'dsh-im', 'persona.md');
}

let cache = { mtime: -1, text: '' };

/** Active persona text (empty when not configured). Cached by mtime. */
export function readPersona() {
  try {
    const path = activePersonaPath();
    const info = statSync(path);
    if (info.mtimeMs !== cache.mtime) {
      const text = readFileSync(path, 'utf8').trim().slice(0, MAX_CHARS);
      cache = { mtime: info.mtimeMs, text };
    }
    return cache.text;
  } catch {
    return '';
  }
}

/** Append the persona to channel guidance; no-op when the persona is empty. */
export function applyPersona(guidance) {
  const persona = readPersona();
  if (!persona) return guidance ?? '';
  const block = `<dsh_im_persona>\n${persona}\n</dsh_im_persona>`;
  const base = typeof guidance === 'string' ? guidance.trim() : '';
  return base ? `${base}\n\n${block}` : block;
}

/** Personas available in the personas directory (name without .md). */
export function listPersonas() {
  try {
    return readdirSync(personaDir())
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Copy `personas/<name>.md` over the active persona. Returns false if missing. */
export function usePersona(name) {
  const clean = String(name ?? '').trim().replace(/[\\/]+/gu, '');
  if (!clean) return false;
  const source = join(personaDir(), `${clean}.md`);
  if (!existsSync(source)) return false;
  const text = readFileSync(source, 'utf8').trim().slice(0, MAX_CHARS);
  writeFileSync(activePersonaPath(), `${text}\n`, 'utf8');
  cache = { mtime: -1, text: '' };
  return true;
}
