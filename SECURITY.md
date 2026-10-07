# Security Policy

## Supported versions

Security fixes are made for the latest release only.

| Version | Supported |
| --- | --- |
| 0.5.x | ✅ |
| < 0.5 | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report it privately through [GitHub's private vulnerability reporting](https://github.com/aieo-product/claude_qamods/security/advisories/new). Include:

- what the problem is and its impact
- steps to reproduce, or a proof of concept
- your Claude Code version and operating system

You should get a first response within 7 days. Once a fix is ready, we will publish an advisory and credit you unless you prefer to stay anonymous.

## Scope notes

qa-guide is a Claude Code mod: event handlers that run inside Claude Code with the user's permissions. It makes no network requests of its own, starts no processes and writes no files. Its only external effect is a model request through Claude Code's own API, on the account the session already uses:

- `$.model.complete` with `model: 'haiku'` (the default): a prompt capped at 12,000 characters with qa-guide's instructions, the user's last 3 prompts, the end of Claude's reply, a summary of recent tool calls and the question. It runs for each `AskUserQuestion` dialog while AI explanations are on, and for a plain-text question only when the user asks for an explanation
- `$.model.fork` on the session's model: only for **Full context** or `context: full`, over the session's existing conversation

Prompts, questions, answers and explanations stay in session state (`$.state`) and are gone when the session ends. The [plugin README](plugins/qa-guide/README.md#what-it-reads-sends-and-stores) lists everything the mod reads.

Please consider especially:

- prompt injection through question text, Claude's reply or quoted prompts that changes the AI explanation in a harmful way
- a `??` or other prompt that reaches Claude when qa-guide should have handled it locally, or a prompt that qa-guide drops by mistake
- any path where conversation content leaves the session other than the requests above, or persists after the session ends
