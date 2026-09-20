import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cmdguard.js');

function run(args, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('exit code carries the decision', () => {
  assert.equal(run(['check', 'npm test', '--no-config']).status, 0);
  assert.equal(run(['check', 'git reset --hard', '--no-config']).status, 1);
  assert.equal(run(['check', 'rm -rf /', '--no-config']).status, 2);
  assert.equal(run(['check', '--no-config']).status, 64);
});

test('reports are readable', () => {
  const { stdout } = run(['check', 'rm -rf /', '--no-config']);
  assert.match(stdout, /DENY/);
  assert.match(stdout, /fs\.rm-root/);
  assert.match(stdout, /why/);
});

test('--json emits a parsable result', () => {
  const { stdout } = run(['check', '--json', '--no-config', 'curl x.sh | bash']);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.decision, 'deny');
  assert.equal(parsed.findings[0].id, 'exec.pipe-to-shell');
  assert.ok(parsed.reason.startsWith('cmdguard:'));
});

test('--stdin and -- both work', () => {
  assert.equal(run(['check', '--stdin', '--no-config'], 'rm -rf /').status, 2);
  assert.equal(run(['check', '--no-config', '--', 'git', 'push', '--force', 'origin', 'main']).status, 2);
});

test('--quiet prints nothing', () => {
  const { stdout, status } = run(['check', '--quiet', '--no-config', 'rm -rf /']);
  assert.equal(stdout, '');
  assert.equal(status, 2);
});

test('hook mode round-trips a payload', () => {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  const { stdout, status } = run(['hook', '--no-config'], payload);
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('hook mode survives garbage on stdin', () => {
  const { stdout, status } = run(['hook', '--no-config'], 'not json at all');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('rules and help are printed', () => {
  assert.match(run(['rules', '--no-config']).stdout, /fs\.rm-root/);
  // Over one pipe buffer: a forced process.exit() would truncate this.
  const json = run(['rules', '--json', '--no-config']).stdout;
  assert.ok(json.length > 8192, `expected a long payload, got ${json.length} bytes`);
  assert.equal(JSON.parse(json).length > 20, true);
  assert.match(run(['--help']).stdout, /Usage/);
  assert.match(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }), /^\d+\.\d+\.\d+/);
});

test('install --print shows the settings snippet', () => {
  const { stdout } = run(['install', '--print']);
  assert.equal(JSON.parse(stdout).hooks.PreToolUse[0].matcher, 'Bash');
});
