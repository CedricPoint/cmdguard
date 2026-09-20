/**
 * Configuration loading.
 *
 * cmdguard runs with no config at all. A project can drop a `.cmdguard.json`
 * next to its package.json to tune severities, add its own patterns, or
 * allow-list the commands it runs all day.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, parse as parsePath, resolve } from 'node:path';
import { ruleIds } from './rules.js';

export const CONFIG_FILES = ['.cmdguard.json', 'cmdguard.config.json', '.cmdguard.jsonc'];

export const SEVERITIES = ['off', 'warn', 'ask', 'deny'];

export const defaultConfig = {
  profile: 'balanced',
  rules: {},
  deny: [],
  ask: [],
  warn: [],
  allow: [],
};

/**
 * Walk up from `startDir` looking for a config file, then merge it over the
 * defaults. Returns the config plus the path it came from (null when none).
 *
 * @param {string} [startDir]
 * @returns {{ config: typeof defaultConfig, path: string | null, errors: string[] }}
 */
export function loadConfig(startDir = process.cwd()) {
  const errors = [];
  let dir = resolve(startDir);
  const root = parsePath(dir).root;

  for (;;) {
    for (const name of CONFIG_FILES) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      try {
        const raw = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(stripComments(raw));
        return { config: mergeConfig(parsed, errors), path: candidate, errors };
      } catch (error) {
        errors.push(`${candidate}: ${error.message}`);
        return { config: { ...defaultConfig }, path: candidate, errors };
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }

  return { config: { ...defaultConfig }, path: null, errors };
}

/**
 * Validate and normalize a config object.
 *
 * @param {object} input
 * @param {string[]} [errors] collects non-fatal problems
 */
export function mergeConfig(input, errors = []) {
  const config = { ...defaultConfig, rules: {}, deny: [], ask: [], warn: [], allow: [] };
  if (!input || typeof input !== 'object') return config;

  if (input.profile) {
    if (['strict', 'balanced', 'loose'].includes(input.profile)) config.profile = input.profile;
    else errors.push(`unknown profile "${input.profile}", falling back to "balanced"`);
  }

  if (input.rules && typeof input.rules === 'object') {
    for (const [id, severity] of Object.entries(input.rules)) {
      if (!ruleIds.has(id)) {
        errors.push(`unknown rule id "${id}"`);
        continue;
      }
      const value = severity === 'allow' ? 'off' : severity;
      if (!SEVERITIES.includes(value)) {
        errors.push(`rule "${id}": invalid severity "${severity}"`);
        continue;
      }
      config.rules[id] = value;
    }
  }

  for (const key of ['deny', 'ask', 'warn', 'allow']) {
    const patterns = input[key];
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns)) {
      errors.push(`"${key}" must be an array of regular expressions`);
      continue;
    }
    for (const pattern of patterns) {
      try {
        config[key].push(new RegExp(pattern, 'i').source);
      } catch (error) {
        errors.push(`"${key}": invalid pattern ${JSON.stringify(pattern)} (${error.message})`);
      }
    }
  }

  return config;
}

/** JSON with `//` and `/* *\/` comments, so config files can be annotated. */
export function stripComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }

  return out;
}
