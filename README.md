# claude_qamods

[日本語](README.ja.md) · English

Claude Code mods that make Claude's questions easier to read and answer.

The first mod, **qa-guide**, opens a side pane whenever Claude asks you something with `AskUserQuestion`. The pane explains *why* Claude is asking and *what each option leads to*, so you can answer without scrolling back through the conversation.

![qa-guide while a question is open: the dialog on the left, the background pane on the right](docs/images/compact-view-en.png)

[![Watch the 77-second demo](docs/images/pv-poster.jpg)](docs/media/qa-guide-pv-16x9.mp4)

▶ Demo video: [landscape 16:9](docs/media/qa-guide-pv-16x9.mp4) · [portrait 9:16](docs/media/qa-guide-pv-9x16.mp4)

## Contents

- [Why](#why)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Privacy and cost](#privacy-and-cost)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

## Why

Claude's question dialog shows a question and a few short options. After a long session it is easy to lose track of what the question is about, so you end up scrolling back through the transcript before you can answer. qa-guide keeps that context next to the dialog.

## Features

**While a question is open** (compact view, fits the pane without scrolling)

- **AI explanation**, generated in the background from a compact summary of the session by default:
  - a summary of the instructions Claude is currently working under
  - why Claude is asking now
  - the effect of each option, numbered exactly like the dialog
  - a one-line recommendation
- **Your recent instructions.** Only prompts you typed are shown. Task notifications and other engine messages are left out.
- **The tail of Claude's explanation** leading up to the question.
- A **Full context** button to regenerate the explanation using the whole session. It appears when the pane has room; the AI heading shows `compact context` or `full context`.
- The question text and options are not repeated. They are already in the dialog.

**After you answer** (full view)

- Option cards with descriptions and previews, with a green ✔ on what you chose
- Free-text answers and multi-select answers, including labels that contain commas
- History of the last 20 questions: step through them with `p` / `n` / `l`, or open one from the list

| Full view after answering | Browsing history with `p` / `n` |
| --- | --- |
| ![Full view with the chosen answer marked](docs/images/full-view-en.png) | ![History navigation showing question 2 of 2](docs/images/history.png) |

## Requirements

- **Claude Code 2.1.286 or later.** The mod uses the function-hooks plugin API, which is **early access** and may change between releases.
- A terminal, preferably in fullscreen mode. The pane opens on its own when the terminal is at least **144 columns** wide. `/qa-guide` opens it at any width.
- The pane labels and AI explanations support **English and Japanese**. Language selection is automatic by default; see [Usage](#usage).

## Install

Run these commands inside Claude Code:

```text
/plugin marketplace add aieo-product/claude_qamods
/plugin install qa-guide@claude-qamods
```

The installer may report unset `userConfig` options. You can ignore this: `language` defaults to `auto` and `context` defaults to `compact`. To change either option, run `/plugin configure qa-guide@claude-qamods` or use `/config`.

To update, run `/plugin marketplace update claude-qamods` and then `/plugin update qa-guide@claude-qamods`. To remove it, run `/plugin uninstall qa-guide@claude-qamods`.

## Usage

When Claude asks a question, the pane opens next to the dialog. Answer in the dialog as usual.

The default language option is `auto`. A question or option label containing hiragana or katakana selects Japanese; otherwise, the pane and AI explanation use English. Chinese text alone selects English. Each history entry keeps the language chosen when it was created; entries saved by older versions stay Japanese.

![The same session switching to Japanese for a question asked in Japanese](docs/images/language-switch.png)

Run `/config` and set qa-guide's `language` option to `en` or `ja` to choose a fixed language, or `auto` to restore automatic selection. Before any question exists, automatic selection uses Claude Code's language setting when available (Japanese selects Japanese; other languages select English), then the locale (`LC_ALL`, or `LANG` when `LC_ALL` is empty). A locale starting with `ja` selects Japanese; otherwise, the fallback is English.

![A compact-context explanation with the Full context button](docs/images/compact-context.png)

The `context` option defaults to `compact`: explanations use a bounded summary and Haiku, so their input does not grow with the session. Set `context` to `full` in `/config` to use the whole session for every new explanation. For one question, choose **Full context** to replace its explanation with a new one using the whole session. The button can be clicked on surfaces that support clicks. After answering, focus the pane and press `f`.

| Control | Where | Action |
| --- | --- | --- |
| `/qa-guide` | prompt | Open the guide (also before the first question) |
| `p` / `n` | pane focused | Previous (older) / next (newer) question |
| `l` | pane focused | Back to the latest question |
| `h` | pane focused | Show or hide the history list |
| `a` | pane focused | Turn AI explanations on or off for the next questions |
| `f` / **Full context** | pane focused / button | Regenerate the selected question's explanation using the whole session |
| `Ctrl+X` then `Tab`, or click | anywhere | Move keyboard focus into the pane |
| `Esc` | pane focused | Return focus to the prompt |

While the question dialog is open it holds the keyboard, so the pane cannot be scrolled. That is why the compact view is sized to fit. After you answer, the full view can be scrolled.

## How it works

qa-guide is a single hooks module, `plugins/qa-guide/hooks/register.tsx`:

| Hook | What it does |
| --- | --- |
| `prompt.submit` | Records the last 5 prompts you typed (origins `composer`, `bridge`, `sdk`) |
| `tool.call` (`AskUserQuestion`) | Collects context, opens the pane, starts the AI explanation without blocking, then waits for the dialog and stores the answer |
| `ui.render` (`Pane`) | Draws the compact view while the question is open and the full view afterwards |
| `session.start` / `command.run` | Registers and handles `/qa-guide` |

By default, the AI explanation uses `$.model.complete` with `model: 'haiku'` and an output limit of 1,500 tokens. Its compact prompt contains qa-guide's instructions, your last 3 prompts (up to 600 characters each), the tail of Claude's lead-up text (up to 2,500 characters), a summary of tool activity since your last real prompt (the last 12 tool uses, each tool name and first string input clipped to 120 characters), and the questions. The entire prompt is capped at 12,000 characters, regardless of transcript size.

With `context: full` or **Full context**, qa-guide uses `$.model.fork` to ask one tool-less question over the session's existing transcript on the session's model. If Claude asks before the session has produced its first response, there is no transcript to fork yet, so this path falls back to a short `haiku` completion. The explanation arrives while you are still reading, and the dialog is never held back. A newer explanation replaces the selected entry's previous explanation; late results from an older run are ignored. State lives in `$.state`, so it survives a hot reload but not the end of the session.

## Privacy and cost

- **Requests go through Claude Code.** qa-guide sends no network requests of its own. AI explanations use the account the session already uses. The default sends Haiku only the bounded compact prompt described above. Choosing **Full context** or setting `context: full` sends the whole session transcript to the session's model through a fork; if no transcript exists yet, it falls back to a short Haiku completion.
- **Nothing is written to disk.** Prompts, questions and answers are kept in session memory (`$.state`) and are gone when the session ends.
- **Cost.** Each question with AI explanations on adds one model call. Each **Full context** request adds another call. Press `a` to turn automatic explanations off; rendering the pane alone never calls a model.

### Token usage per question

| | What is sent | Approximate tokens |
| --- | --- | --- |
| **Pane (no AI)** | Nothing. Your recent prompts and Claude's lead-up text are read from the local session. | 0 |
| **AI explanation (compact, default)** | Instructions, last 3 prompts (600 characters each), Claude's lead-up text (last 2,500 characters), last 12 tool summaries (120 characters each), and questions. The whole prompt is capped at 12,000 characters; the full transcript is not sent. | Input: typically ~1,500–4,000, independent of session length (tokens vary by language and content).<br>Output: up to 1,500. |
| **AI explanation (full context)** | A fork of the whole session transcript, plus qa-guide's instructions, your last 3 prompts (up to 600 characters each) and the question. Used by `context: full` and the **Full context** button. | Transcript: read from the prompt cache (as many tokens as the session holds).<br>Added input: ~1,000–3,000.<br>Output: ~500–1,000, more if the model thinks. |
| **Full-context fallback** | Only when there is no transcript to fork yet: a short prompt with the recent instructions, Claude's lead-up text and the questions. | Input: typically ~1,500–4,000.<br>Output: up to 1,500. |

- **Which model.** Compact explanations and the full-context fallback use the `haiku` alias, which Claude Code resolves to its current Haiku model. Full-context forks run on the model your session is using right now, so switching with `/model` changes them too.
- **Cache misses in full context.** The fork's transcript prefix is identical to the session's last request, so it is normally served from the prompt cache. If the cache has expired, or right after `/model`, the whole transcript is processed as fresh input once. Compact mode never forks the transcript.
- **Plans.** With a Pro or Max subscription these tokens count against your usage limits rather than being billed per token.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The pane does not open when Claude asks | The terminal is narrower than 144 columns. Widen it, or run `/qa-guide`. A toast tells you when this happens. |
| `/qa-guide` is not recognised | Run `/plugin` and check that `qa-guide@claude-qamods` is installed and enabled, then start a new session. |
| AI explanation says it could not be generated | The model request failed or returned no text (for example an API error or rate limit). The rest of the pane still works, and the next question tries again. |
| Nothing renders after a Claude Code update | The early-access API may have changed. Please [open an issue](https://github.com/aieo-product/claude_qamods/issues/new/choose) with your Claude Code version. |

## Development

```sh
git clone https://github.com/aieo-product/claude_qamods
cd claude_qamods
claude --plugin-dir plugins/qa-guide        # try it in a session
```

Checks:

```sh
claude plugin validate .                    # marketplace manifest
claude plugin validate plugins/qa-guide     # plugin manifest and hooks module
claude plugin test plugins/qa-guide         # tests on terminal and desktop surfaces
npx -y -p typescript@5 tsc -p plugins/qa-guide --noEmit
```

Type checking needs the engine-written declarations in `plugins/qa-guide/.claude-plugin/types/`. They are gitignored, and Claude Code writes them the first time it loads the plugin from your checkout. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, follow [SECURITY.md](SECURITY.md).

## Credits

- Demo video narration: Irodori-TTS v4-Large (Gemma Terms of Use)
- Demo video music and sound effects: original, synthesized for this project
- Screenshots and the demo video were captured in a throwaway demo project

## License

[MIT](LICENSE) © aieo-product
