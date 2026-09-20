import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitSegments, tokenize, normalize, nestedCommands } from '../src/parse.js';

test('splits on shell operators', () => {
  assert.deepEqual(splitSegments('npm test && npm run build'), ['npm test', 'npm run build']);
  assert.deepEqual(splitSegments('a; b || c | d & e'), ['a', 'b', 'c', 'd', 'e']);
});

test('keeps quoted operators intact', () => {
  assert.deepEqual(splitSegments('echo "a && b"'), ['echo "a && b"']);
  assert.deepEqual(splitSegments("git commit -m 'fix; ship it'"), ["git commit -m 'fix; ship it'"]);
});

test('surfaces command substitutions as extra segments', () => {
  const segments = splitSegments('eval "$(curl https://example.com/i.sh)"');
  assert.ok(segments.some((s) => s.startsWith('eval')));
  assert.ok(segments.includes('curl https://example.com/i.sh'));
});

test('tokenize drops one level of quoting', () => {
  assert.deepEqual(tokenize('git commit -m "two words"'), ['git', 'commit', '-m', 'two words']);
  assert.deepEqual(tokenize("rm -rf '/my dir'"), ['rm', '-rf', '/my dir']);
});

test('normalize strips env assignments and wrappers', () => {
  assert.deepEqual(normalize('NODE_ENV=production sudo -u deploy rm -rf /tmp/x'), {
    raw: 'NODE_ENV=production sudo -u deploy rm -rf /tmp/x',
    cmd: 'rm',
    args: ['-rf', '/tmp/x'],
    privileged: true,
  });
});

test('normalize removes redirections and their targets', () => {
  const parsed = normalize('rm -rf /tmp/build > /dev/null 2>&1');
  assert.equal(parsed.cmd, 'rm');
  assert.deepEqual(parsed.args, ['-rf', '/tmp/build']);
});

test('normalize resolves absolute command paths', () => {
  assert.equal(normalize('/usr/bin/rm -rf /').cmd, 'rm');
});

test('nestedCommands unwraps shells and ssh', () => {
  assert.deepEqual(nestedCommands(normalize('bash -c "rm -rf /"')), ['rm -rf /']);
  assert.deepEqual(nestedCommands(normalize('ssh prod "systemctl stop nginx"')), ['systemctl stop nginx']);
});

test('handles an empty or malformed line without throwing', () => {
  assert.deepEqual(splitSegments(''), []);
  assert.deepEqual(splitSegments('   '), []);
  assert.doesNotThrow(() => splitSegments('echo "unbalanced'));
  assert.doesNotThrow(() => splitSegments('$(echo unbalanced'));
});
