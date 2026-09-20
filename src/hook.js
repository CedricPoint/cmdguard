/**
 * Claude Code PreToolUse hook.
 *
 * Reads the hook payload on stdin, evaluates `tool_input.command`, and writes
 * a permission decision on stdout.
 *
 * On `allow` it deliberately prints nothing: saying "allow" would short-circuit
 * the user's own permission rules, and a guard should never grant more than it
 * was asked to. Silence means "I have no objection, carry on as usual".
 */

import { evaluate } from './engine.js';
import { renderReason } from './format.js';

/** Tools whose input carries a shell command. */
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'Shell', 'run_command', 'execute_command']);

export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * Build the hook response for a payload. Returns `null` when nothing should be
 * printed.
 *
 * @param {object} payload
 * @param {object} config
 */
export function decide(payload, config) {
  const toolName = payload?.tool_name ?? payload?.toolName ?? '';
  if (toolName && !COMMAND_TOOLS.has(toolName)) return null;

  const command = payload?.tool_input?.command ?? payload?.toolInput?.command ?? '';
  if (typeof command !== 'string' || !command.trim()) return null;

  const result = evaluate(command, config);
  if (result.decision === 'allow') return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: renderReason(result),
    },
  };
}

/**
 * Entry point for `cmdguard hook`.
 *
 * Any unexpected input is treated as "no opinion": a guard that crashes must
 * not be able to wedge the agent it protects.
 */
export async function runHook(config) {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return 0;
  }

  const response = decide(payload, config);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  return 0;
}
