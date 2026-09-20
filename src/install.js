/**
 * `cmdguard install` — wire the hook into a Claude Code settings file.
 *
 * The merge is additive: an existing settings file keeps everything it had,
 * and running install twice does not duplicate the hook.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_COMMAND = 'npx -y github:CedricPoint/cmdguard hook';

export function settingsPath(scope, cwd = process.cwd()) {
  if (scope === 'global') return join(homedir(), '.claude', 'settings.json');
  if (scope === 'local') return join(cwd, '.claude', 'settings.local.json');
  return join(cwd, '.claude', 'settings.json');
}

/**
 * Add the PreToolUse hook to a settings object.
 *
 * @param {object} settings
 * @param {string} [command]
 * @returns {{ settings: object, changed: boolean }}
 */
export function addHook(settings, command = HOOK_COMMAND) {
  const next = structuredClone(settings ?? {});
  next.hooks = next.hooks ?? {};
  const events = Array.isArray(next.hooks.PreToolUse) ? [...next.hooks.PreToolUse] : [];

  const alreadyThere = events.some((entry) =>
    (entry?.hooks ?? []).some((hook) => typeof hook?.command === 'string' && hook.command.includes('cmdguard')),
  );
  if (alreadyThere) return { settings: next, changed: false };

  const bashEntry = events.find((entry) => entry?.matcher === 'Bash');
  if (bashEntry) {
    bashEntry.hooks = [...(bashEntry.hooks ?? []), { type: 'command', command }];
  } else {
    events.push({ matcher: 'Bash', hooks: [{ type: 'command', command }] });
  }

  next.hooks.PreToolUse = events;
  return { settings: next, changed: true };
}

/**
 * Read, merge and write the settings file.
 *
 * @param {string} file
 * @param {string} [command]
 * @returns {{ file: string, changed: boolean, backup: string | null }}
 */
export function install(file, command = HOOK_COMMAND) {
  let current = {};
  let backup = null;

  if (existsSync(file)) {
    current = JSON.parse(readFileSync(file, 'utf8'));
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }

  const { settings, changed } = addHook(current, command);
  if (changed) writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { file, changed, backup: changed ? backup : null };
}

/** The snippet printed by `cmdguard install --print`. */
export function snippet(command = HOOK_COMMAND) {
  return JSON.stringify(
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } },
    null,
    2,
  );
}

export const CONFIG_TEMPLATE = `{
  // How strictly the built-in severities are applied:
  //   "strict"   warn -> ask, ask -> deny
  //   "balanced" the defaults (recommended)
  //   "loose"    deny -> ask, ask -> warn
  "profile": "balanced",

  // Override any built-in rule: "deny" | "ask" | "warn" | "allow".
  // Run \`npx cmdguard rules\` to see every id.
  "rules": {
    // "fs.rm-recursive": "warn"
  },

  // Your own patterns, matched against the whole command line.
  "deny": [],
  "ask": [],
  "warn": [],

  // Escape hatch: commands matching these are always allowed.
  "allow": [
    "^rm -rf (\\\\./)?(node_modules|dist|build|\\\\.next|coverage)/?$"
  ]
}
`;
