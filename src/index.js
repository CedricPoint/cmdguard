/**
 * Programmatic API.
 *
 *   import { check } from 'cmdguard';
 *   const { decision, findings } = check('rm -rf /');
 */

export { evaluate, EXIT_CODES } from './engine.js';
export { rules } from './rules.js';
export { loadConfig, mergeConfig, defaultConfig } from './config.js';
export { renderReason, renderReport } from './format.js';
export { decide } from './hook.js';
export { splitSegments, tokenize, normalize } from './parse.js';

import { evaluate } from './engine.js';
import { loadConfig } from './config.js';

/**
 * Evaluate a command using the config found next to `cwd`.
 *
 * @param {string} command
 * @param {{ cwd?: string, config?: object }} [options]
 */
export function check(command, options = {}) {
  const config = options.config ?? loadConfig(options.cwd).config;
  return evaluate(command, config);
}
