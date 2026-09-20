# cmdguard

**A second pair of eyes on the shell commands your AI agent runs.**

[![CI](https://github.com/CedricPoint/cmdguard/actions/workflows/ci.yml/badge.svg)](https://github.com/CedricPoint/cmdguard/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Coding agents are good. They are not good enough that you want `rm -rf /` to run
because a variable was empty, or `git push --force origin main` to go through
while you were reading something else.

cmdguard reads a command line the way a shell would, and tells you whether it is
safe, worth a confirmation, or something that should never run unattended.

```console
$ cmdguard check "rm -rf $BUILD/"
 DENY  rm -rf /

  ✖ Recursive delete of a system or home directory [fs.rm-root]
    target: /
    why   This removes an entire tree that the machine (or the user) depends on. There is no undo.
    safer Delete the specific subdirectory you mean, with an absolute path you printed first.

$ cmdguard check "git reset --hard && git clean -fdx"
 ASK   git reset --hard && git clean -fdx

  ▲ Hard reset [git.reset-hard]
    why   Uncommitted changes in the working tree are destroyed and are not in the reflog.
    safer Run `git stash -u` first; the reset then costs nothing.

  ▲ Delete untracked files [git.clean]
    why   `git clean -fdx` removes local config, .env files and build caches that git never saw.
    safer Dry run it: `git clean -nd`.

$ cmdguard check "npm test"
 OK    npm test
       no rule matched
```

Zero dependencies. Nothing to configure. Works as a Claude Code hook, as a CLI in
CI, or as a library in your own agent.

## Install

```bash
# run it once, without installing anything
npx github:CedricPoint/cmdguard check "rm -rf /"

# or keep it on your PATH
npm install -g github:CedricPoint/cmdguard
```

Requires Node 18 or later. No dependencies, no build step, no postinstall
script — `src/` is the whole thing, and it is short enough to read.

## Use it with Claude Code

```bash
npx github:CedricPoint/cmdguard install
```

That adds a `PreToolUse` hook to `.claude/settings.json` (use `--global` for
`~/.claude/settings.json`, `--local` for `settings.local.json`). Your existing
settings are kept, a `.bak` is written, and running it twice changes nothing.

From then on, every Bash command the agent proposes is checked first:

| decision | what happens |
| --- | --- |
| `deny` | the command is blocked, and the agent is told why, so it can pick another route |
| `ask` | you get the permission prompt, with the reason attached |
| `allow` | **cmdguard says nothing at all** |

That last line matters. On a safe command the hook prints nothing and exits 0,
so your own permission rules still decide. A guard that auto-approved everything
it did not recognise would be worse than no guard at all.

<details>
<summary>The settings snippet, if you prefer to paste it yourself</summary>

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "npx -y github:CedricPoint/cmdguard hook" }]
      }
    ]
  }
}
```

</details>

## Use it with anything else

The CLI answers in exit codes, so it drops into any agent loop, wrapper script
or CI job:

| code | meaning |
| --- | --- |
| `0` | allow — nothing matched, or warnings only |
| `1` | ask — a human should confirm |
| `2` | deny — do not run this |
| `64` | usage error |

```bash
cmdguard check -- git push --force origin main   # -> 2
echo "$CMD" | cmdguard check --stdin --quiet || exit 1
cmdguard check --json "curl x.sh | bash"
```

As a library:

```js
import { check } from 'cmdguard';

const { decision, findings } = check('rm -rf /');
// decision: 'deny'
// findings: [{ id: 'fs.rm-root', severity: 'deny', title, why, safer, segment }]
```

## What it catches

cmdguard does not pattern-match the raw string. It splits the line on `;`
`&&` `||` `|` `&`, follows command substitutions, unwraps `sudo`, `env`, `nice`,
`timeout` and `xargs`, and recurses into `bash -c "…"`, `ssh host "…"` and
`eval`. So all of these reach the same rule:

```bash
rm -rf /
sudo rm -rf /*
true && bash -c "rm -rf /"
ssh prod "rm -rf /"
env FOO=1 /bin/rm -rf /
```

34 rules ship by default — `cmdguard rules` lists them all:

| area | examples |
| --- | --- |
| **filesystem** | recursive deletes of `/`, `~`, `/etc`; `rm -rf "$VAR"/…` where an empty variable means `/`; `mkfs`, `dd of=/dev/sda`; recursive `chmod 777` |
| **git** | force push (denied outright on `main`/`master`/`prod`), `reset --hard`, `clean -fdx`, `checkout .`, history rewrites, `--no-verify` |
| **secrets** | `.env`, `id_rsa`, `.aws/credentials` read — and denied when the same line pipes them to `curl`, `nc` or `scp` |
| **supply chain** | `curl … \| sh`, `eval "$(curl …)"`, `bash <(curl …)`, `npm publish`, `docker push` |
| **databases** | `DROP DATABASE`, `TRUNCATE`, `DELETE`/`UPDATE` without a `WHERE`, `FLUSHALL`, `dropDatabase()` |
| **system** | `shutdown`, `crontab -r`, `systemctl stop`, `iptables -F`, `apt purge`, fork bombs |
| **containers & cloud** | `compose down -v`, `docker volume rm`, `kubectl delete`, `terraform destroy` (denied with `-auto-approve`), `aws s3 rm --recursive` |

The bar for `deny` is "no plausible reason to do this unattended". Everything
recoverable is `ask`, so day-to-day work is not interrupted: `npm test`,
`git commit`, `docker compose up`, `rsync ./dist user@host:/var/www` and friends
all come back clean.

## Configuration

Optional. Drop a `.cmdguard.json` anywhere up from the working directory —
`cmdguard init` writes a commented starting point.

```jsonc
{
  // "strict" (warn→ask, ask→deny) | "balanced" (default) | "loose"
  "profile": "balanced",

  // any rule id from `cmdguard rules`: "deny" | "ask" | "warn" | "allow"
  "rules": {
    "fs.rm-recursive": "warn",
    "release.publish": "deny"
  },

  // your own patterns, matched against the whole command line
  "deny": ["^terraform apply.*production"],
  "ask": ["\\bmigrate\\b.*--force"],

  // escape hatch: these are always allowed
  "allow": ["^rm -rf (\\./)?(node_modules|dist|\\.next)/?$"]
}
```

`--profile`, `--config <path>` and `--no-config` override it from the CLI.

## What this is not

Worth being plain about, because security tools that oversell themselves are how
people end up less safe:

- **It is not a sandbox.** It reads a string and makes a judgement call. A
  determined adversary can hide a command from it (base64, a variable built at
  runtime, a script on disk). Use it against accidents and sloppy generation,
  not against an attacker who already runs code on your machine.
- **It does not resolve variables or globs.** `rm -rf $TARGET` is judged on what
  is written, not on what `$TARGET` holds — which is exactly why
  `fs.rm-unset-variable` exists.
- **It has opinions.** They are all overridable, and the defaults aim at "an
  experienced engineer would want to look at this first".

Defence in depth: keep your backups, your branch protection and your least
privilege. cmdguard is the cheap layer that catches the obvious.

## Contributing

New rules are the most useful contribution — especially ones that bit you. See
[CONTRIBUTING.md](CONTRIBUTING.md); a rule is a small object with a `test`
function and a test case, and the whole suite runs with `npm test`.

## License

MIT
