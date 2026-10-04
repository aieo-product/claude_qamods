# claude_qamods

[日本語](README.ja.md) · English

Claude Code mods that make Claude's questions easier to read and answer.

The first mod, **qa-guide**, opens a side pane whenever Claude asks you something with `AskUserQuestion`. The pane explains *why* Claude is asking and *what each option leads to*, so you can answer without scrolling back through the conversation.

![qa-guide while a question is open: the dialog on the left, the background pane on the right](docs/images/compact-view.png)

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

- **AI explanation**, generated in the background from the session's own transcript:
  - a summary of the instructions Claude is currently working under
  - why Claude is asking now
  - the effect of each option, numbered exactly like the dialog
  - a one-line recommendation
- **Your recent instructions.** Only prompts you typed are shown. Task notifications and other engine messages are left out.
- **The tail of Claude's explanation** leading up to the question.
- The question text and options are not repeated. They are already in the dialog.

**After you answer** (full view)

- Option cards with descriptions and previews, with a green ✔ on what you chose
- Free-text answers and multi-select answers, including labels that contain commas
- History of the last 20 questions: step through them with `p` / `n` / `l`, or open one from the list

| Full view after answering | Browsing history with `p` / `n` |
| --- | --- |
| ![Full view with the chosen answer marked](docs/images/full-view.png) | ![History navigation showing question 2 of 2](docs/images/history.png) |

## Requirements

- **Claude Code 2.1.286 or later.** The mod uses the function-hooks plugin API, which is **early access** and may change between releases.
- A terminal, preferably in fullscreen mode. The pane opens on its own when the terminal is at least **144 columns** wide. `/qa-guide` opens it at any width.
- The pane labels and AI explanations are currently in **Japanese**. English output is planned.

## Install

Run these commands inside Claude Code:

```text
/plugin marketplace add aieo-product/claude_qamods
/plugin install qa-guide@claude-qamods
```

To remove it, run `/plugin uninstall qa-guide@claude-qamods`.

## Usage

Nothing to configure. When Claude asks a question, the pane opens next to the dialog. Answer in the dialog as usual.

| Control | Where | Action |
| --- | --- | --- |
| `/qa-guide` | prompt | Open the guide (also before the first question) |
| `p` / `n` | pane focused | Previous (older) / next (newer) question |
| `l` | pane focused | Back to the latest question |
| `h` | pane focused | Show or hide the history list |
| `a` | pane focused | Turn AI explanations on or off for the next questions |
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

The AI explanation uses `$.model.fork`, which asks one tool-less question over the session's existing transcript. The answer arrives while you are still reading, and the dialog is never held back. State lives in `$.state`, so it survives a hot reload but not the end of the session.

## Privacy and cost

- **Nothing leaves your session.** qa-guide sends no network requests of its own. The AI explanation is one extra request to the same model and account the session already uses, over the same transcript.
- **Nothing is written to disk.** Prompts, questions and answers are kept in session memory (`$.state`) and are gone when the session ends.
- **Cost.** Each question with AI explanations on adds one model call. The call reuses the session's prompt cache when it can, so it is usually cheap, but it is not free. An expired cache or a model switch can make it more expensive. Press `a` to turn explanations off.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The pane does not open when Claude asks | The terminal is narrower than 144 columns. Widen it, or run `/qa-guide`. A toast tells you when this happens. |
| `/qa-guide` is not recognised | Run `/plugin` and check that `qa-guide@claude-qamods` is installed and enabled, then start a new session. |
| AI explanation says it could not be generated | The fork had nothing to read (a brand-new session or right after `/clear`), or the API returned an error. The rest of the pane still works. |
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
claude plugin test plugins/qa-guide         # 50 tests on terminal and desktop surfaces
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
