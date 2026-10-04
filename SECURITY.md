# Security Policy

## Supported versions

Security fixes are made for the latest release only.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report it privately through [GitHub's private vulnerability reporting](https://github.com/aieo-product/claude_qamods/security/advisories/new). Include:

- what the problem is and its impact
- steps to reproduce, or a proof of concept
- your Claude Code version and operating system

You should get a first response within 7 days. Once a fix is ready, we will publish an advisory and credit you unless you prefer to stay anonymous.

## Scope notes

qa-guide runs inside Claude Code's plugin sandbox. It sends no network requests of its own and writes nothing to disk. The only external effect is one extra request through `$.model.fork`, which goes to the same model the session already uses. Please consider especially:

- prompt injection through question text or quoted prompts that changes the AI explanation in a harmful way
- any path where conversation content leaves the session or persists after it ends
