# Contributing

Thanks for looking. The most valuable contribution is a rule for something that
actually bit you, with the command line that caused it.

## Getting started

```bash
git clone https://github.com/CedricPoint/cmdguard.git
cd cmdguard
npm test          # no install step: there are no dependencies
node bin/cmdguard.js check "rm -rf /"
```

## Adding a rule

Rules live in [`src/rules.js`](src/rules.js). One rule is one object:

```js
{
  id: 'area.short-name',        // stable: people put it in their config
  severity: 'deny',             // 'deny' | 'ask' | 'warn'
  scope: 'segment',             // 'segment' per command, 'line' for pipelines
  tags: ['filesystem'],
  title: 'Short sentence, no punctuation at the end',
  why: 'What is lost, in one sentence, in plain language.',
  safer: 'The command you should run instead.',   // optional
  test({ cmd, args, raw, line, privileged }) {
    return cmd === 'rm' && args.includes('--no-preserve-root');
  },
}
```

A `segment` rule is called once per command in the line, after `sudo`, `env` and
friends have been stripped, and after `bash -c "…"` / `ssh host "…"` have been
unwrapped — so match on `cmd` and `args`, not on the raw string, unless you need
SQL or shell syntax. A `line` rule sees `{ line, segments, parsedSegments }` and
is the right scope for anything about a pipeline.

Returning `{ detail: 'target: /' }` instead of `true` adds a line to the report.

### Choosing a severity

| severity | means |
| --- | --- |
| `deny` | no plausible reason to run this unattended, and nothing brings the data back |
| `ask` | legitimate, but a human should look at it first |
| `warn` | worth noting, never blocks |

When in doubt, `ask`. A guard people turn off because it cries wolf protects
nobody.

## Tests

Every rule needs at least one case in [`test/rules.test.js`](test/rules.test.js):
one command that must match, and — this is the important one — a realistic
command that must **not** match. Add it to the `allows ordinary work` list.

```bash
npm test
```

## Style

Plain ESM, no dependencies, no build step. That is a feature: `npx cmdguard`
must stay instant and auditable in one sitting. Please keep it that way.
