/**
 * Shell parsing helpers.
 *
 * The goal is not to be a POSIX-complete shell. It is to break a command line
 * into the individual commands that would actually run, so a rule that looks
 * for `rm -rf /` still fires when it is hidden behind `true && sudo rm -rf /`
 * or inside `bash -c "..."`.
 */

/** Commands that run another command passed as an argument. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);

/** Commands that wrap another command and can be stripped away. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'nohup',
  'nice',
  'ionice',
  'time',
  'command',
  'builtin',
  'exec',
  'setsid',
  'stdbuf',
  'env',
  'xargs',
  'watch',
]);

/** Wrappers that take a value argument before the real command. */
const WRAPPER_VALUE_FLAGS = {
  sudo: new Set(['-u', '--user', '-g', '--group', '-C', '-p', '--prompt']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set([]),
  xargs: new Set(['-n', '-P', '-I', '-d', '-s', '-a', '-E']),
  watch: new Set(['-n', '--interval']),
};

/**
 * Split a command line into the segments that would run as separate commands.
 * Operators `;` `&&` `||` `|` `&` and newlines are cut points. Quoted text and
 * command substitutions are preserved, and substitution bodies are returned as
 * extra segments so `eval "$(curl … | sh)"` is inspected too.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitSegments(line) {
  if (typeof line !== 'string' || line.trim() === '') return [];

  const segments = [];
  const nested = [];
  let current = '';
  let quote = null;
  let depth = 0;
  let i = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };

  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];

    if (quote) {
      if (c === '\\' && quote === '"' && next !== undefined) {
        current += c + next;
        i += 2;
        continue;
      }
      // Substitutions still expand inside double quotes: "$(curl … | sh)".
      if (quote === '"' && ((c === '$' && next === '(') || c === '`')) {
        const opener = c === '`' ? '`' : '(';
        const start = c === '$' ? i + 2 : i + 1;
        const end = findClosing(line, start, opener);
        nested.push(line.slice(start, end));
        current += line.slice(i, Math.min(end + 1, line.length));
        i = end + 1;
        continue;
      }
      current += c;
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (c === '\\' && next !== undefined) {
      current += c + next;
      i += 2;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      i += 1;
      continue;
    }

    // Command substitution and subshells: capture the body, keep the text.
    if ((c === '$' && next === '(') || c === '`' || (c === '(' && depth === 0)) {
      const opener = c === '`' ? '`' : '(';
      const start = c === '$' ? i + 2 : i + 1;
      const end = findClosing(line, start, opener);
      const body = line.slice(start, end);
      nested.push(body);
      current += line.slice(i, Math.min(end + 1, line.length));
      i = end + 1;
      continue;
    }

    if (c === '&' && next === '&') {
      flush();
      i += 2;
      continue;
    }
    if (c === '|' && next === '|') {
      flush();
      i += 2;
      continue;
    }
    if (c === '|' || c === ';' || c === '&' || c === '\n') {
      flush();
      i += 1;
      continue;
    }

    current += c;
    i += 1;
  }
  flush();

  for (const body of nested) {
    for (const segment of splitSegments(body)) {
      if (!segments.includes(segment)) segments.push(segment);
    }
  }

  return segments;
}

/**
 * Find the index of the character closing a substitution opened at `start`.
 * Falls back to the end of the string when the command line is unbalanced.
 */
function findClosing(line, start, opener) {
  const close = opener === '`' ? '`' : ')';
  let depth = 1;
  let quote = null;
  for (let i = start; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (opener === '(' && c === '(') depth += 1;
    if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return line.length;
}

/**
 * Split a segment into argv-style tokens, dropping one level of quoting.
 *
 * @param {string} segment
 * @returns {string[]}
 */
export function tokenize(segment) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  let i = 0;

  const push = () => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };

  while (i < segment.length) {
    const c = segment[i];
    const next = segment[i + 1];

    if (quote) {
      if (c === '\\' && quote === '"' && next !== undefined) {
        current += next;
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i += 1;
        continue;
      }
      current += c;
      i += 1;
      continue;
    }

    if (c === '\\' && next !== undefined) {
      current += next;
      started = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      i += 1;
      continue;
    }

    current += c;
    started = true;
    i += 1;
  }
  push();

  return tokens;
}

/**
 * Turn a segment into `{ cmd, args }`, stripping redirections, leading
 * environment assignments and wrappers such as `sudo` or `env`.
 *
 * @param {string} segment
 * @returns {{ raw: string, cmd: string, args: string[], privileged: boolean }}
 */
export function normalize(segment) {
  let tokens = stripRedirections(tokenize(segment));
  let privileged = false;

  for (;;) {
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (!tokens.length) break;

    const head = basename(tokens[0]);
    if (head === 'sudo' || head === 'doas') privileged = true;

    if (head === 'timeout') {
      tokens.shift();
      while (tokens.length && tokens[0].startsWith('-')) tokens.shift();
      if (tokens.length) tokens.shift(); // the duration
      continue;
    }

    if (WRAPPERS.has(head)) {
      const valueFlags = WRAPPER_VALUE_FLAGS[head] ?? new Set();
      tokens.shift();
      while (tokens.length && tokens[0].startsWith('-')) {
        const flag = tokens.shift();
        if (valueFlags.has(flag) && tokens.length && !tokens[0].startsWith('-')) tokens.shift();
      }
      continue;
    }

    break;
  }

  const cmd = tokens.length ? basename(tokens[0]) : '';
  return { raw: segment.trim(), cmd, args: tokens.slice(1), privileged };
}

/**
 * Commands nested inside a segment: `bash -c "…"`, `ssh host "…"`,
 * `docker exec c sh -c "…"`. Returned as raw command strings.
 *
 * @param {{ cmd: string, args: string[] }} parsed
 * @returns {string[]}
 */
export function nestedCommands(parsed) {
  const { cmd, args } = parsed;
  const out = [];

  if (SHELLS.has(cmd)) {
    const flagIndex = args.findIndex((a) => a === '-c' || a === '-lc' || a === '-cl');
    if (flagIndex !== -1 && args[flagIndex + 1]) out.push(args[flagIndex + 1]);
  }

  if (cmd === 'ssh') {
    const rest = args.filter((a, index) => {
      if (a.startsWith('-')) return false;
      // Skip the value of option flags such as `-p 22` or `-i key`.
      const previous = args[index - 1];
      return !(previous && /^-[ipoFlLRDbcEJQSWw]$/.test(previous));
    });
    if (rest.length > 1) out.push(rest.slice(1).join(' '));
  }

  if (cmd === 'eval') out.push(args.join(' '));

  return out.filter(Boolean);
}

/**
 * Remove redirections and their targets: `> out.log`, `2>&1`, `>>file`, `< in`.
 */
function stripRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\d*(>>|>|<<<|<<|<)&?\d*$/.test(token)) {
      // A bare operator swallows the following word, `2>&1` does not.
      if (!/&\d*$/.test(token) && i + 1 < tokens.length) i += 1;
      continue;
    }
    if (/^\d*(>>|>|<<<|<<|<)\S+$/.test(token)) continue; // glued form: `>file`
    out.push(token);
  }
  return out;
}

/** Last path component of a command word (`/usr/bin/rm` -> `rm`). */
export function basename(word) {
  if (!word) return '';
  const cleaned = word.replace(/^["']|["']$/g, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

export const _internals = { SHELLS, WRAPPERS };
