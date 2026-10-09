# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Close after answering** (`closeAfterAnswer`, off by default): closes the pane once a question is answered, dismissed or interrupted, as long as no other question is still open

## [0.5.4] - 2026-10-07

### Added

- Directory listing fields in `plugin.json`: the display name **QA Guide**, and documentation, support and privacy links

## [0.5.3] - 2026-10-07

### Added

- Plugin icon (`.claude-plugin/icon.png`) for the Claude plugin directory listing
- The plugin README lists each hook the mod uses

### Changed

- The on/off settings are now toggles under new names: **API price estimate** (`priceEstimate`, was `showCost`) and **Plain-text questions** (`plainTextQuestions`, was `chatQuestions`). Both default to on; a value saved under the old name is ignored, so turn the setting off again if you had
- `language` and `context` are typed in instead of picked from a list, because the plugin directory does not accept `userConfig` pickers yet. Their descriptions list the accepted values, and the values are read case-insensitively

## [0.5.2] - 2026-10-07

### Added

- README inside the plugin folder (`plugins/qa-guide/README.md`) for the Claude plugin directory listing, including what the mod reads, sends and stores

### Changed

- Requirements now say Claude Code v2.1.287 or later in the terminal and v2.1.286 or later in the Desktop app's Code tab; mods are no longer early access
- The security policy describes the current model requests and supported versions

## [0.5.1] - 2026-10-06

### Changed

- Plain-text question detection is now on by default (`chatQuestions` defaults to `on`). Detection uses no tokens; an explanation runs only when you press **Explain** / **AI要約** or send `??`. Set `chatQuestions` to `off` in `/config` to turn it off

## [0.5.0] - 2026-10-06

### Added

- Opt-in plain-text question detection with a question band above the prompt; `chatQuestions` defaults to `off`
- **Explain** / **AI要約** button, `??` + Enter and the band's `e` shortcut to request one compact Haiku explanation; pending-question `??` is handled locally and never sent to Claude
- **In-text question** / **文章での質問** history entries that record the next prompt as the answer, with measured usage and cost included in session totals
- **×** button to dismiss a pending plain-text question

### Changed

- Plain-text question explanations use dedicated instructions for Claude's reply and its explicit options, including **Full context** re-runs
- English and Japanese documentation now explains how to enable plain-text questions, request explanations and dismiss the band, with token costs and heuristic limitations

## [0.4.0] - 2026-10-05

### Added

- Measured token usage for each AI explanation: input, cache read, cache write and output, with `haiku` or `session` model labels
- Session token total in the full-view toolbar, including re-runs and completed superseded calls
- API-price estimates beside measured usage and the session total, using built-in USD list prices as of 2026-09; `showCost` defaults to `on` and can be set to `off`

### Changed

- **Full context** re-runs replace the selected entry's usage while adding to the session total
- Compact views show the usage line only when a row is available
- English and Japanese token documentation now explains measured usage and session totals

## [0.3.0] - 2026-10-05

### Added

- `context` option in `/config`: `compact` (default) or `full`
- **Full context** / **全文脈で解説** button (`f`) to replace the selected question's explanation using the whole session
- Context mode labels on AI explanations: `compact context` / `full context` and 「要点のみ」 / 「全文脈」; older entries display as full context

### Changed

- Default AI explanations use Haiku with a compact prompt capped at 12,000 characters and output capped at 1,500 tokens, independent of session length
- Compact context includes the last 3 user prompts, Claude's lead-up text, the last 12 tool summaries since the latest real user prompt, and the questions
- Full context retains the session-model fork and the Haiku fallback when no transcript exists yet
- English and Japanese documentation now explain context settings, the button, privacy and token usage

### Fixed

- Late results from superseded explanation runs no longer replace a newer explanation

## [0.2.0] - 2026-10-04

### Added

- English and Japanese pane labels, notifications and AI explanations, with automatic selection from question text and option labels
- `language` option in `/config`: `auto` (default), `en` or `ja`; automatic selection before a question uses Claude Code's language setting, then `LC_ALL` / `LANG`, then English
- Language stored per history entry, with Japanese rendering for entries saved by earlier versions
- AI explanation for a question asked before the session's first response: falls back to a short `haiku` completion when there is no transcript to fork yet
- English screenshots and a language-switch screenshot in `docs/images/`
- OSS documentation: README (English and Japanese), contributing guide, code of conduct, security policy, issue and pull request templates
- `hygiene` workflow that checks the manifests and scans for personal data
- Screenshots and demo videos in `docs/`

### Fixed

- English text in the compact view wraps at spaces instead of inside words
- A late AI explanation no longer raises an unhandled rejection after the session or module has ended

## [0.1.0] - 2026-10-04

### Added

- **qa-guide** mod: a side pane for Claude's `AskUserQuestion` prompts
  - compact background view while a question is open: AI summary of the current instructions, why Claude asks, the effect of each option numbered like the dialog, a recommendation, your latest instruction and the tail of Claude's lead text
  - full view after answering: option cards, previews, ✔ on the chosen answer, free-text answers
  - history of the last 20 questions with `p` / `n` / `l` navigation and a history list (`h`)
  - `/qa-guide` command, AI explanation toggle (`a`)
- Marketplace manifest `claude-qamods`

[Unreleased]: https://github.com/aieo-product/claude_qamods/compare/v0.5.4...HEAD
[0.5.4]: https://github.com/aieo-product/claude_qamods/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/aieo-product/claude_qamods/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/aieo-product/claude_qamods/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/aieo-product/claude_qamods/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/aieo-product/claude_qamods/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/aieo-product/claude_qamods/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aieo-product/claude_qamods/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aieo-product/claude_qamods/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aieo-product/claude_qamods/releases/tag/v0.1.0
