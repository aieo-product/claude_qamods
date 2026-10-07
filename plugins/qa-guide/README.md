# qa-guide

A Claude Code mod that makes Claude's questions easier to answer.

When Claude asks you something with the `AskUserQuestion` dialog, qa-guide opens a side pane that explains why Claude is asking, what each option leads to, and which option it would pick. You can decide without scrolling back through the conversation. When Claude ends a reply with a question written in plain text instead, a band above the prompt offers the same kind of explanation on demand.

Screenshots, a demo video and the Japanese documentation are in the [repository README](https://github.com/aieo-product/claude_qamods#readme).

## Features

- **Question pane**: Claude's lead-up text, your recent instructions, every option with its description and preview, and an AI explanation with a recommendation
- **Plain-text questions**: a band shows the question with an **Explain** button. You can also type `??` and press Enter, which is handled locally and never sent to Claude, or press Ctrl+X → Tab, then `e`
- **History**: earlier questions and the answers you gave, browsable with `p` / `n`
- **Token usage**: measured tokens for every explanation, with an API-price estimate and a session total
- **English and Japanese**, chosen automatically for each question

## Requirements

- Claude Code v2.1.287 or later in the terminal, or the Code tab of the Claude Desktop app v2.1.286 or later. Mods are on by default in these versions.
- The pane opens on its own when the terminal is at least 144 columns wide. `/qa-guide` opens it at any width.

## Options

Change these in `/config` or with `/plugin configure qa-guide@<marketplace>`:

| Option | Default | What it does |
| --- | --- | --- |
| `language` | `auto` | Language for the pane and explanations. Type `auto`, `en` or `ja` |
| `context` | `compact` | Type `compact` to send a bounded summary to Haiku, or `full` to ask the session's model over the whole conversation |
| `priceEstimate` | on | Shows an API-price estimate beside measured tokens |
| `plainTextQuestions` | on | Detects plain-text questions and shows the band above the prompt |

## What it reads, sends and stores

qa-guide makes no network requests of its own, starts no processes, and writes no files.

- **Reads**, inside the session: your last 5 typed prompts, Claude's reply and question text, the names and first text input of recent tool calls, the session's model ID, Claude Code's language setting, and the `LC_ALL` / `LANG` environment variables for choosing a language.
- **Sends**, only through Claude Code's own model API and on the account the session already uses:
  - Each dialog question, while AI explanations are on (press `a` to turn them off), and each plain-text question when you ask for an explanation: one Haiku request with a prompt capped at 12,000 characters. It holds qa-guide's instructions, your last 3 prompts, the end of Claude's reply, a short summary of recent tool calls and the question. Measured cost is about $0.001–0.004 per explanation at API list prices; on Pro and Max plans it counts against your usage limits instead.
  - **Full context** button or `context: full`: one tool-less request on the session's model over the existing conversation.
- **Stores**: questions, answers, explanations and token totals in the session's memory only. They are gone when the session ends.

Detecting plain-text questions and drawing the pane or band never call a model.

## Hooks

- `prompt.submit`: records your last 5 prompts. When a plain-text question is waiting and you send exactly `??`, qa-guide explains the question and drops `??`, so it is never sent to Claude. Every other prompt passes through unchanged and, when a question is waiting, is recorded as its answer.
- `tool.call` for `AskUserQuestion`: opens the pane and starts the explanation, then lets the dialog run as usual and records your answer. It never answers the dialog for you.
- `turn.complete`: checks the end of Claude's reply for a plain-text question, without calling a model.
- `ui.render` for the pane and the band above the prompt, and `session.start` / `command.run` for `/qa-guide`.

The mod does not change any Claude Code setting.

## License

MIT
