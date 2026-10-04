# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- OSS documentation: README (English and Japanese), contributing guide, code of conduct, security policy, issue and pull request templates
- `hygiene` workflow that checks the manifests and scans for personal data
- Screenshots and demo videos in `docs/`

## [0.1.0] - 2026-10-04

### Added

- **qa-guide** mod: a side pane for Claude's `AskUserQuestion` prompts
  - compact background view while a question is open: AI summary of the current instructions, why Claude asks, the effect of each option numbered like the dialog, a recommendation, your latest instruction and the tail of Claude's lead text
  - full view after answering: option cards, previews, ✔ on the chosen answer, free-text answers
  - history of the last 20 questions with `p` / `n` / `l` navigation and a history list (`h`)
  - `/qa-guide` command, AI explanation toggle (`a`)
- Marketplace manifest `claude-qamods`

[Unreleased]: https://github.com/aieo-product/claude_qamods/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aieo-product/claude_qamods/releases/tag/v0.1.0
