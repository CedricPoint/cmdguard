/**
 * The rule set.
 *
 * Every rule declares the severity it reports when it matches:
 *
 *   deny  the command should never run unattended
 *   ask   the command is legitimate but needs a human to confirm
 *   warn  worth mentioning, does not block anything
 *
 * A rule with `scope: 'segment'` is evaluated once per command in the line;
 * a rule with `scope: 'line'` sees the whole line, which is what pipelines
 * such as `cat .env | curl …` need.
 */

const SENSITIVE_FILES =
  /(^|[\s"'=/])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.git-credentials|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|service-account.*\.json|[\w.-]+\.(pem|p12|pfx|key|keystore|jks))(\s|$|["'])/i;

const SENSITIVE_DIRS = /(^|[\s"'])(~|\$HOME)?\/?\.(ssh|aws|gnupg|kube|docker|config\/gcloud)(\/|\s|$|["'])/;

const READERS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'strings', 'base64', 'xxd', 'od', 'bat', 'grep', 'rg',
]);

const NETWORK_SENDERS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'scp', 'sftp', 'rsync', 'ftp', 'mail',
  'mailx', 'sendmail', 'http', 'httpie', 'xh',
]);

const ROOT_PATHS = new Set([
  '/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}', '/home', '/home/*',
  '/Users', '/usr', '/usr/*', '/etc', '/etc/*', '/var', '/var/*', '/bin', '/sbin', '/lib', '/opt',
  '/boot', '/System', 'C:\\', 'C:/', '/mnt', '/srv', '/root', '/data',
]);

const PROTECTED_BRANCHES = /(^|[:/])(main|master|prod|production|release|develop)$/i;

/* ------------------------------------------------------------------ utils */

/** Short flag letters used in a command, e.g. `-rf` -> `r`, `f`. */
function shortFlags(args) {
  const letters = new Set();
  for (const arg of args) {
    if (/^-[A-Za-z]+$/.test(arg)) for (const letter of arg.slice(1)) letters.add(letter);
  }
  return letters;
}

/** True when any of the given long flags is present (`--force`, `--force=1`). */
function hasLong(args, ...names) {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

/** Arguments that are not flags. */
function operands(args) {
  return args.filter((arg) => !arg.startsWith('-'));
}

function isRootPath(path) {
  const cleaned = path.replace(/\/+$/, (match) => (path === match ? match : '')).trim();
  if (ROOT_PATHS.has(cleaned) || ROOT_PATHS.has(path.trim())) return true;
  return /^(\/|~\/?|\$\{?HOME\}?\/?)(\*|\.\*)?$/.test(path.trim());
}

/** `rm -rf "$DIR"/build` is fine until `$DIR` is empty. */
function startsWithVariable(path) {
  return /^(["']?\$\{?\w+\}?["']?)\//.test(path);
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/* ------------------------------------------------------------------ rules */

export const rules = [
  /* ---------------------------------------------------------- filesystem */
  {
    id: 'fs.rm-root',
    severity: 'deny',
    scope: 'segment',
    tags: ['filesystem'],
    title: 'Recursive delete of a system or home directory',
    why: 'This removes an entire tree that the machine (or the user) depends on. There is no undo.',
    safer: 'Delete the specific subdirectory you mean, with an absolute path you printed first.',
    test({ cmd, args }) {
      if (cmd !== 'rm') return false;
      const flags = shortFlags(args);
      const recursive = flags.has('r') || flags.has('R') || hasLong(args, '--recursive');
      if (!recursive) return false;
      const target = operands(args).find((path) => isRootPath(path));
      return target ? { detail: `target: ${target}` } : false;
    },
  },
  {
    id: 'fs.rm-unset-variable',
    severity: 'ask',
    scope: 'segment',
    tags: ['filesystem'],
    title: 'Recursive delete rooted in a shell variable',
    why: 'If the variable is empty the path collapses to `/`, and the command deletes the filesystem.',
    safer: 'Guard it first: `[ -n "$DIR" ] && rm -rf "$DIR/build"`.',
    test({ cmd, args }) {
      if (cmd !== 'rm') return false;
      const flags = shortFlags(args);
      if (!(flags.has('r') || flags.has('R') || hasLong(args, '--recursive'))) return false;
      const target = operands(args).find((path) => startsWithVariable(path));
      return target ? { detail: `target: ${target}` } : false;
    },
  },
  {
    id: 'fs.rm-recursive',
    severity: 'ask',
    scope: 'segment',
    tags: ['filesystem'],
    title: 'Recursive delete',
    why: 'Recursive deletes are the most common way an automated run loses work.',
    safer: 'List what would go first: `find <dir> -maxdepth 1`.',
    test({ cmd, args }) {
      if (cmd !== 'rm') return false;
      const flags = shortFlags(args);
      return flags.has('r') || flags.has('R') || hasLong(args, '--recursive');
    },
  },
  {
    id: 'fs.raw-device-write',
    severity: 'deny',
    scope: 'segment',
    tags: ['filesystem'],
    title: 'Write to a raw device or format a filesystem',
    why: 'Writing to a block device destroys every partition on it, instantly and completely.',
    test({ cmd, args, raw }) {
      if (/^mkfs(\.\w+)?$/.test(cmd) || cmd === 'wipefs') return true;
      if (cmd === 'dd' && args.some((arg) => /^of=\/dev\/(sd|nvme|hd|disk|mmcblk)/.test(arg))) return true;
      if (cmd === 'shred' && operands(args).some((path) => path.startsWith('/dev/'))) return true;
      return /(^|\s)>\s*\/dev\/(sd|nvme|hd|disk|mmcblk)/.test(raw);
    },
  },
  {
    id: 'fs.permissions-wide',
    severity: 'ask',
    scope: 'segment',
    tags: ['filesystem'],
    title: 'Recursive permission or ownership change',
    why: 'A recursive chmod/chown on a shared path breaks services and is tedious to reverse.',
    safer: 'Scope it to the directory that actually needs it, without `-R` when possible.',
    test({ cmd, args }) {
      if (cmd !== 'chmod' && cmd !== 'chown' && cmd !== 'chgrp') return false;
      const recursive = shortFlags(args).has('R') || hasLong(args, '--recursive');
      const targets = operands(args);
      if (cmd === 'chmod' && targets.includes('777')) return { detail: 'mode 777' };
      return recursive && targets.some((path) => isRootPath(path));
    },
  },
  {
    id: 'fs.overwrite-system-file',
    severity: 'ask',
    scope: 'segment',
    tags: ['filesystem'],
    title: 'Redirect output over a system file',
    why: 'A single `>` replaces the file; /etc and /boot files are rarely backed up.',
    test({ raw }) {
      return /(^|\s)>\s*\/(etc|boot|usr|bin|sbin|lib)\//.test(raw);
    },
  },

  /* ---------------------------------------------------------------- git */
  {
    id: 'git.force-push-protected',
    severity: 'deny',
    scope: 'segment',
    tags: ['git'],
    title: 'Force push to a protected branch',
    why: 'Rewriting a shared branch discards commits for everyone who already pulled it.',
    safer: 'Push a new branch and open a pull request instead.',
    test({ cmd, args }) {
      if (cmd !== 'git' || args[0] !== 'push') return false;
      const forced = shortFlags(args).has('f') || hasLong(args, '--force', '--mirror');
      if (!forced) return false;
      const target = operands(args.slice(1)).find((arg) => PROTECTED_BRANCHES.test(arg));
      return target ? { detail: `branch: ${target}` } : false;
    },
  },
  {
    id: 'git.force-push',
    severity: 'ask',
    scope: 'segment',
    tags: ['git'],
    title: 'Force push',
    why: 'Force pushing overwrites remote history; anything not fetched elsewhere is gone.',
    safer: 'Use `--force-with-lease`, which refuses to clobber commits you have not seen.',
    test({ cmd, args }) {
      if (cmd !== 'git' || args[0] !== 'push') return false;
      if (hasLong(args, '--force-with-lease')) return false;
      return shortFlags(args).has('f') || hasLong(args, '--force', '--mirror');
    },
  },
  {
    id: 'git.reset-hard',
    severity: 'ask',
    scope: 'segment',
    tags: ['git'],
    title: 'Hard reset',
    why: 'Uncommitted changes in the working tree are destroyed and are not in the reflog.',
    safer: 'Run `git stash -u` first; the reset then costs nothing.',
    test({ cmd, args }) {
      return cmd === 'git' && args[0] === 'reset' && hasLong(args, '--hard');
    },
  },
  {
    id: 'git.discard-changes',
    severity: 'ask',
    scope: 'segment',
    tags: ['git'],
    title: 'Discard working tree changes',
    why: 'Checking out or restoring a whole path throws away edits that were never committed.',
    safer: 'Commit to a scratch branch first, or `git stash -u`.',
    test({ cmd, args }) {
      if (cmd !== 'git') return false;
      if (args[0] === 'checkout' && operands(args.slice(1)).some((a) => a === '.' || a === '--')) return true;
      if (args[0] === 'restore' && !hasLong(args, '--staged')) {
        return operands(args.slice(1)).some((a) => a === '.' || a === './');
      }
      return false;
    },
  },
  {
    id: 'git.clean',
    severity: 'ask',
    scope: 'segment',
    tags: ['git'],
    title: 'Delete untracked files',
    why: '`git clean -fdx` removes local config, .env files and build caches that git never saw.',
    safer: 'Dry run it: `git clean -nd`.',
    test({ cmd, args }) {
      if (cmd !== 'git' || args[0] !== 'clean') return false;
      const flags = shortFlags(args);
      const forced = flags.has('f') || hasLong(args, '--force');
      return forced && (flags.has('d') || flags.has('x') || flags.has('X'));
    },
  },
  {
    id: 'git.rewrite-history',
    severity: 'ask',
    scope: 'segment',
    tags: ['git'],
    title: 'Rewrite repository history',
    why: 'Every commit hash changes, which breaks open pull requests and existing clones.',
    test({ cmd, args, raw }) {
      if (cmd === 'git-filter-repo') return true;
      if (cmd !== 'git') return false;
      return args[0] === 'filter-branch' || args[0] === 'filter-repo' || /\bfilter-repo\b/.test(raw);
    },
  },
  {
    id: 'git.skip-hooks',
    severity: 'warn',
    scope: 'segment',
    tags: ['git'],
    title: 'Hooks bypassed',
    why: 'Linters, tests and secret scanners that run on commit are skipped.',
    test({ cmd, args }) {
      return cmd === 'git' && hasLong(args, '--no-verify');
    },
  },

  /* ------------------------------------------------------- remote code */
  {
    id: 'exec.pipe-to-shell',
    severity: 'deny',
    scope: 'line',
    tags: ['supply-chain'],
    title: 'Downloaded script piped straight into an interpreter',
    why: 'Whatever the server returns runs immediately, with no chance to read it first.',
    safer: 'Download to a file, read it, then run it.',
    test({ line }) {
      return /\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|perl|ruby|node|php|pwsh)\b/i.test(
        line,
      );
    },
  },
  {
    id: 'exec.process-substitution',
    severity: 'deny',
    scope: 'line',
    tags: ['supply-chain'],
    title: 'Remote script executed through substitution',
    why: 'Same as piping into a shell, only harder to spot in a log.',
    test({ line }) {
      return (
        /\b(sh|bash|zsh|source|\.)\s+<\(\s*(curl|wget)/.test(line) ||
        /\beval\s+["']?\$\(\s*(curl|wget)/.test(line) ||
        /\beval\s+["']?`\s*(curl|wget)/.test(line)
      );
    },
  },

  /* ---------------------------------------------------------- secrets */
  {
    id: 'secrets.exfiltration',
    severity: 'deny',
    scope: 'line',
    tags: ['secrets'],
    title: 'Secret material sent to the network',
    why: 'Credentials leaving the machine cannot be called back; treat them as compromised.',
    test({ line, parsedSegments }) {
      const touchesSecret =
        SENSITIVE_FILES.test(line) || SENSITIVE_DIRS.test(line) || /\b(printenv|env)\b/.test(line);
      if (!touchesSecret) return false;
      const sender = parsedSegments.find((segment) => NETWORK_SENDERS.has(segment.cmd));
      if (!sender) return false;
      // `curl https://…` alone is fine; the secret must be part of the pipeline.
      const piped = /\|/.test(line) || /@[^\s]*(\.env|id_rsa|id_ed25519|credentials|\.pem)/i.test(line);
      return piped ? { detail: `via ${sender.cmd}` } : false;
    },
  },
  {
    id: 'secrets.read',
    severity: 'ask',
    scope: 'segment',
    tags: ['secrets'],
    title: 'Reading credential files',
    why: 'Keys and tokens end up in the transcript, the scrollback and any log that captures it.',
    test({ cmd, raw }) {
      if (!READERS.has(cmd)) return false;
      return SENSITIVE_FILES.test(raw) || SENSITIVE_DIRS.test(raw);
    },
  },

  /* --------------------------------------------------------- databases */
  {
    id: 'db.drop',
    severity: 'deny',
    scope: 'segment',
    tags: ['database'],
    title: 'Dropping a database or schema',
    why: 'The data is gone the moment the statement commits, backup or not.',
    test({ raw }) {
      return /\bdrop\s+(database|schema)\b/i.test(raw);
    },
  },
  {
    id: 'db.destructive-statement',
    severity: 'ask',
    scope: 'segment',
    tags: ['database'],
    title: 'Unbounded write or table drop',
    why: 'A `DELETE`/`UPDATE` without `WHERE` rewrites every row in the table.',
    safer: 'Run the matching `SELECT COUNT(*)` first, then add the `WHERE` clause.',
    test({ raw }) {
      if (/\b(drop|truncate)\s+table\b/i.test(raw)) return { detail: 'table drop' };
      if (/\bdelete\s+from\s+[\w."`]+\s*(;|$)/i.test(raw)) return { detail: 'DELETE without WHERE' };
      if (/\bupdate\s+[\w."`]+\s+set\b(?![\s\S]*\bwhere\b)/i.test(raw)) {
        return { detail: 'UPDATE without WHERE' };
      }
      return false;
    },
  },
  {
    id: 'db.flush',
    severity: 'deny',
    scope: 'segment',
    tags: ['database'],
    title: 'Flushing a datastore',
    why: 'Clears every key or collection at once, including sessions and queues in flight.',
    test({ cmd, raw }) {
      if (cmd === 'redis-cli' && /\bflush(all|db)\b/i.test(raw)) return true;
      return /\bdb\.dropDatabase\(/.test(raw) || /\bdropDatabase\b/.test(raw);
    },
  },

  /* ------------------------------------------------------------ system */
  {
    id: 'sys.fork-bomb',
    severity: 'deny',
    scope: 'line',
    tags: ['system'],
    title: 'Fork bomb',
    why: 'Exhausts the process table; the machine usually needs a hard reboot.',
    test({ line }) {
      return /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&?\s*\}\s*;?\s*:/.test(line.replace(/\s+/g, ' '));
    },
  },
  {
    id: 'sys.power',
    severity: 'deny',
    scope: 'segment',
    tags: ['system'],
    title: 'Shutdown or reboot',
    why: 'Ends the session and everything running on the host, including this one.',
    test({ cmd, args }) {
      if (['shutdown', 'reboot', 'poweroff', 'halt'].includes(cmd)) return true;
      if (cmd === 'systemctl' && ['poweroff', 'reboot', 'halt'].includes(args[0])) return true;
      return cmd === 'init' && ['0', '6'].includes(args[0]);
    },
  },
  {
    id: 'sys.service-disruption',
    severity: 'ask',
    scope: 'segment',
    tags: ['system'],
    title: 'Stopping or disabling a service',
    why: 'Production traffic stops with it, and `disable`/`mask` survives the next reboot.',
    test({ cmd, args }) {
      if (cmd !== 'systemctl' && cmd !== 'service') return false;
      const action = cmd === 'service' ? args[1] : args.find((a) => !a.startsWith('-'));
      return ['stop', 'disable', 'mask', 'kill'].includes(action);
    },
  },
  {
    id: 'sys.kill-broad',
    severity: 'ask',
    scope: 'segment',
    tags: ['system'],
    title: 'Broad process kill',
    why: 'Matches far more than intended; `kill -9 -1` takes down the whole session.',
    test({ cmd, args }) {
      if (cmd === 'kill') return args.includes('-1') || args.includes('1');
      if (cmd === 'killall' || cmd === 'pkill') {
        return args.some((a) => a === '-9' || a === '-f') || operands(args).length === 0;
      }
      return false;
    },
  },
  {
    id: 'sys.crontab-wipe',
    severity: 'deny',
    scope: 'segment',
    tags: ['system'],
    title: 'Deleting the crontab',
    why: '`crontab -r` removes every scheduled job without confirmation and without a backup.',
    safer: 'Back it up first: `crontab -l > crontab.bak`.',
    test({ cmd, args }) {
      return cmd === 'crontab' && args.includes('-r');
    },
  },
  {
    id: 'sys.security-off',
    severity: 'ask',
    scope: 'segment',
    tags: ['system'],
    title: 'Disabling a security control',
    why: 'Leaves the host exposed, and the change is easy to forget to undo.',
    test({ cmd, args, raw }) {
      if (cmd === 'ufw' && ['disable', 'reset'].includes(args[0])) return true;
      if (cmd === 'iptables' && (args.includes('-F') || args.includes('--flush'))) return true;
      if (cmd === 'setenforce' && args[0] === '0') return true;
      return /\bsystemctl\s+(stop|disable)\s+(firewalld|fail2ban|apparmor)/.test(raw);
    },
  },
  {
    id: 'pkg.system-remove',
    severity: 'ask',
    scope: 'segment',
    tags: ['system'],
    title: 'Removing system packages',
    why: '`autoremove` and `purge` routinely take dependencies of unrelated services with them.',
    test({ cmd, args }) {
      const action = args.find((a) => !a.startsWith('-'));
      if (['apt', 'apt-get', 'aptitude'].includes(cmd)) {
        return ['remove', 'purge', 'autoremove'].includes(action);
      }
      if (['yum', 'dnf', 'zypper'].includes(cmd)) return ['remove', 'erase'].includes(action);
      if (cmd === 'pacman') return args.some((a) => /^-R/.test(a));
      if (cmd === 'brew') return action === 'uninstall';
      return false;
    },
  },

  /* ------------------------------------------------ containers & cloud */
  {
    id: 'docker.data-loss',
    severity: 'ask',
    scope: 'segment',
    tags: ['containers'],
    title: 'Removing container volumes or images',
    why: 'Named volumes hold databases; pruning them deletes the data, not just the container.',
    test({ cmd, args, raw }) {
      if (cmd !== 'docker' && cmd !== 'docker-compose' && cmd !== 'podman') return false;
      if (/\b(down)\b/.test(raw) && (args.includes('-v') || hasLong(args, '--volumes'))) {
        return { detail: 'compose down -v' };
      }
      if (args[0] === 'volume' && ['rm', 'prune'].includes(args[1])) return true;
      if (args[0] === 'system' && args[1] === 'prune') {
        return args.includes('-a') || hasLong(args, '--all', '--volumes');
      }
      return false;
    },
  },
  {
    id: 'k8s.delete',
    severity: 'ask',
    scope: 'segment',
    tags: ['cloud'],
    title: 'Deleting Kubernetes resources',
    why: 'Deleting a namespace or using `--all` cascades to everything inside it.',
    test({ cmd, args }) {
      if (cmd !== 'kubectl' || args[0] !== 'delete') return false;
      if (args.includes('namespace') || args.includes('ns')) return { detail: 'namespace delete' };
      if (hasLong(args, '--all')) return { detail: '--all' };
      return true;
    },
  },
  {
    id: 'iac.destroy',
    severity: 'ask',
    scope: 'segment',
    tags: ['cloud'],
    title: 'Tearing down infrastructure',
    why: 'Terraform/Pulumi destroy removes real resources, including databases with data in them.',
    test({ cmd, args }) {
      const destroying =
        (cmd === 'terraform' || cmd === 'tofu') && (args[0] === 'destroy' || hasLong(args, '-destroy'));
      const pulumi = cmd === 'pulumi' && args[0] === 'destroy';
      if (!destroying && !pulumi) return false;
      const auto = hasLong(args, '-auto-approve', '--yes', '-y', '--skip-preview');
      return auto ? { detail: 'unattended (auto-approve)', severity: 'deny' } : true;
    },
  },
  {
    id: 'cloud.destructive',
    severity: 'ask',
    scope: 'segment',
    tags: ['cloud'],
    title: 'Destructive cloud API call',
    why: 'Terminating instances or emptying buckets is billed as done and cannot be rolled back.',
    test({ cmd, args, raw }) {
      if (cmd === 'aws') {
        if (/\bs3\s+(rm|rb)\b/.test(raw) && (hasLong(args, '--recursive', '--force'))) return true;
        return /\b(terminate-instances|delete-db-instance|delete-table|delete-bucket|delete-stack)\b/.test(raw);
      }
      if (cmd === 'gcloud' || cmd === 'az' || cmd === 'doctl' || cmd === 'flyctl' || cmd === 'fly') {
        return /\b(delete|destroy)\b/.test(raw);
      }
      return false;
    },
  },

  /* ---------------------------------------------------- supply chain */
  {
    id: 'release.publish',
    severity: 'ask',
    scope: 'segment',
    tags: ['supply-chain'],
    title: 'Publishing a package or image',
    why: 'Publishing is public and, on most registries, effectively permanent.',
    test({ cmd, args, raw }) {
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && args[0] === 'publish') return true;
      if (cmd === 'cargo' && args[0] === 'publish') return true;
      if (cmd === 'twine' && args[0] === 'upload') return true;
      if (cmd === 'poetry' && args[0] === 'publish') return true;
      if (cmd === 'gem' && args[0] === 'push') return true;
      if (cmd === 'docker' && args[0] === 'push') return true;
      if (cmd === 'gh' && /\brelease\s+create\b/.test(raw)) return true;
      return false;
    },
  },
  {
    id: 'release.version-tag-push',
    severity: 'warn',
    scope: 'segment',
    tags: ['supply-chain'],
    title: 'Pushing tags',
    why: 'Tags are what CI releases from; a wrong tag ships a wrong build.',
    test({ cmd, args }) {
      return cmd === 'git' && args[0] === 'push' && hasLong(args, '--tags');
    },
  },
  {
    id: 'net.listen-public',
    severity: 'warn',
    scope: 'segment',
    tags: ['network'],
    title: 'Service bound to every interface',
    why: 'Binding to 0.0.0.0 exposes a development server to the network it is on.',
    test({ raw }) {
      return /(--host[= ]0\.0\.0\.0|-b\s+0\.0\.0\.0|0\.0\.0\.0:\d+)/.test(raw) && !/127\.0\.0\.1/.test(raw);
    },
  },
];

export const ruleIds = new Set(rules.map((rule) => rule.id));

export const helpers = {
  shortFlags,
  hasLong,
  operands,
  isRootPath,
  matchesAny,
  SENSITIVE_FILES,
  NETWORK_SENDERS,
  PROTECTED_BRANCHES,
};
