/**
 * Persona prompt loader (Plan Unit 4).
 *
 * Reads markdown files under src/prompts/personas/<group>.md and
 * src/prompts/anchor-generator.md, parses simple YAML frontmatter, and
 * exposes a substitution helper that fails loudly if any `{{placeholder}}`
 * is left unreplaced.
 *
 * Caches by file mtime so editors can iterate the prompts without
 * restarting the server (Plan R3-style hot reload for prompt files).
 *
 * Hand-rolled frontmatter parser — keeps zero-dep. Only supports the
 * YAML subset we actually emit (string scalars, hyphenated lists).
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  PersonaGroup,
  PersonaPrompt,
  PersonaPromptMeta,
} from '../types';

const PROMPTS_DIR = path.join(__dirname, 'personas');
const ANCHOR_PROMPT_PATH = path.join(__dirname, 'anchor-generator.md');

interface CacheEntry {
  mtimeMs: number;
  prompt: PersonaPrompt;
}

const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Splits a markdown file with YAML frontmatter into [meta, body].
 * Returns null meta when no frontmatter is present.
 */
export function splitFrontmatter(raw: string): { meta: string | null; body: string } {
  if (!raw.startsWith('---')) return { meta: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: null, body: raw };
  const meta = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  return { meta, body };
}

/**
 * Tiny YAML parser supporting:
 *   key: value          (string scalar)
 *   key:                (then indented `- item` lines for a list)
 * Fails loudly on anything more complex (nested objects, multiline scalars).
 */
export function parseYamlFrontmatter(meta: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = meta.split('\n');
  let currentListKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith('#')) continue;

    // List item under a previously-declared key.
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentListKey) {
      const arr = out[currentListKey] as string[];
      arr.push(stripQuotes(listMatch[1]));
      continue;
    }

    // Top-level "key: value" or "key:".
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kvMatch) {
      throw new Error(`Cannot parse frontmatter line: "${line}"`);
    }
    const [, key, value] = kvMatch;
    if (value === '') {
      out[key] = [];
      currentListKey = key;
    } else {
      out[key] = stripQuotes(value);
      currentListKey = null;
    }
  }

  return out;
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Persona prompt loading
// ---------------------------------------------------------------------------

function metaToPersonaMeta(raw: Record<string, string | string[]>): PersonaPromptMeta {
  const persona = raw.persona;
  if (typeof persona !== 'string') {
    throw new Error('Persona prompt frontmatter missing "persona" string field');
  }
  if (!['tech_blogger', 'personal_essay', 'reviewer'].includes(persona)) {
    throw new Error(`Unknown persona group: ${persona}`);
  }
  const labelZh = raw.label_zh;
  if (typeof labelZh !== 'string') {
    throw new Error('Persona prompt frontmatter missing "label_zh" string field');
  }
  const toneKeywords = raw.tone_keywords;
  if (!Array.isArray(toneKeywords)) {
    throw new Error('Persona prompt frontmatter "tone_keywords" must be a list');
  }
  return {
    persona: persona as PersonaGroup,
    label_zh: labelZh,
    tone_keywords: toneKeywords,
    example_phrases: Array.isArray(raw.example_phrases) ? raw.example_phrases : undefined,
  };
}

function loadFromDisk(filePath: string): PersonaPrompt {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = splitFrontmatter(raw);
  if (!meta) {
    throw new Error(`Persona prompt at ${filePath} is missing YAML frontmatter`);
  }
  const parsed = parseYamlFrontmatter(meta);
  return { meta: metaToPersonaMeta(parsed), body };
}

/**
 * Returns the cached prompt for a persona group, reloading from disk
 * when the file's mtime has advanced.
 */
export function getPersonaPrompt(group: PersonaGroup): PersonaPrompt {
  const filePath = path.join(PROMPTS_DIR, `${group}.md`);
  const stat = fs.statSync(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.prompt;
  const prompt = loadFromDisk(filePath);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, prompt });
  return prompt;
}

/**
 * Returns the anchor-generator mini-prompt body. No frontmatter persona
 * checks (it's a different shape — purpose: anchor_generator).
 */
export function getAnchorGeneratorPrompt(): string {
  const stat = fs.statSync(ANCHOR_PROMPT_PATH);
  const cached = cache.get(ANCHOR_PROMPT_PATH);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.prompt.body;
  const raw = fs.readFileSync(ANCHOR_PROMPT_PATH, 'utf8');
  const { body } = splitFrontmatter(raw);
  // Stash under a dummy persona meta so the cache shape stays uniform.
  const dummy: PersonaPrompt = {
    meta: {
      persona: 'tech_blogger',
      label_zh: 'anchor-generator',
      tone_keywords: [],
    },
    body,
  };
  cache.set(ANCHOR_PROMPT_PATH, { mtimeMs: stat.mtimeMs, prompt: dummy });
  return body;
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

/**
 * Substitutes `{{key}}` placeholders in a template body. Throws when any
 * placeholder is missing from `vars` to catch silent rendering bugs.
 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  const rendered = body.replace(/\{\{(\w+)\}\}/g, (_full, name: string) => {
    if (!(name in vars)) {
      throw new Error(`Missing prompt variable: ${name}`);
    }
    return vars[name];
  });
  assertNoUnsubstitutedPlaceholders(rendered);
  return rendered;
}

/**
 * Defensive helper: scans the rendered string for any leftover `{{xxx}}`
 * that the regex above might have skipped (e.g., escaped, edge cases).
 */
export function assertNoUnsubstitutedPlaceholders(rendered: string): void {
  const m = rendered.match(/\{\{(\w+)\}\}/);
  if (m) throw new Error(`Unsubstituted placeholder remains: ${m[0]}`);
}

/**
 * Test-only — wipes the in-memory cache so reloads can be exercised.
 * Not exported through the package barrel; available via direct import.
 */
export function _clearCacheForTests(): void {
  cache.clear();
}
