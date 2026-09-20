# Security policy

## What cmdguard protects against

Accidents and careless generation: a recursive delete rooted in an empty
variable, a force push to `main`, a `curl … | sh` in a README someone pasted.

## What it does not protect against

An adversary who already runs code on the machine. cmdguard inspects a command
string; it does not sandbox, does not resolve variables, and does not follow the
contents of scripts on disk. Anything that hides the real command — base64, a
string assembled at runtime, `. ./script.sh` — will get past it. Treat it as one
cheap layer, not as the boundary.

## Reporting a bypass

A bypass is a command that a reasonable person would call obviously destructive
and that cmdguard returns `allow` for.

Open a regular issue with the command line — there is nothing confidential in a
missing rule, and a public issue gets it fixed faster. If you believe you have
found something that should not be public (for example an arbitrary-code-execution
bug in cmdguard itself, not a missing rule), use GitHub's
[private vulnerability reporting](https://github.com/CedricPoint/cmdguard/security/advisories/new)
instead.

Supported: the latest release on the `main` branch.
