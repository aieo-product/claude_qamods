# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/aieo-product/claude_qamods/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/aieo-product/claude_qamods/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aieo-product/claude_qamods/releases/tag/v0.1.0
