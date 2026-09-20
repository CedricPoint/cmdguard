import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../src/hook.js';
import { addHook, snippet } from '../src/install.js';
import { mergeConfig, stripComments } from '../src/config.js';
import { CONFIG_TEMPLATE } from '../src/install.js';

const payload = (command, tool = 'Bash') => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: { command },
});

test('denies with a reason the agent can read', () => {
  const response = decide(payload('rm -rf /'), {});
  assert.equal(response.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(response.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /fs\.rm-root/);
});

test('asks for confirmation on recoverable damage', () => {
  assert.equal(decide(payload('git reset --hard'), {}).hookSpecificOutput.permissionDecision, 'ask');
});

test('stays silent on safe commands so normal permissions still apply', () => {
  assert.equal(decide(payload('npm test'), {}), null);
});

test('ignores tools that do not run commands', () => {
  assert.equal(decide(payload('rm -rf /', 'Read'), {}), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: {} }, {}), null);
  assert.equal(decide(null, {}), null);
});

test('install is additive and idempotent', () => {
  const existing = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'lint' }] }] },
  };

  const first = addHook(existing);
  assert.equal(first.changed, true);
  assert.deepEqual(first.settings.permissions, existing.permissions);
  assert.equal(first.settings.hooks.PreToolUse.length, 2);

  const second = addHook(first.settings);
  assert.equal(second.changed, false);
  assert.equal(second.settings.hooks.PreToolUse.length, 2);
});

test('the printed snippet is valid JSON', () => {
  assert.doesNotThrow(() => JSON.parse(snippet()));
});

test('the config template parses and validates', () => {
  const parsed = JSON.parse(stripComments(CONFIG_TEMPLATE));
  const errors = [];
  const config = mergeConfig(parsed, errors);
  assert.deepEqual(errors, []);
  assert.equal(config.profile, 'balanced');
  assert.equal(config.allow.length, 1);
});

test('unknown rule ids and bad patterns are reported, not thrown', () => {
  const errors = [];
  mergeConfig({ rules: { 'does.not.exist': 'deny' }, deny: ['('] }, errors);
  assert.equal(errors.length, 2);
});
