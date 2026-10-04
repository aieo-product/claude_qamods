# Contributing

Thanks for helping improve claude_qamods. This guide covers how to set up the project, what a good change looks like, and how to send it.

## Ground rules

- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Open an issue before a large change, so we can agree on the approach first.
- Keep personal data out of the repository. That includes test data, screenshots, logs and commit metadata (see [Privacy hygiene](#privacy-hygiene)).

## Setup

You need Claude Code 2.1.286 or later and Node.js 18+ (only for `npx tsc`).

```sh
git clone https://github.com/aieo-product/claude_qamods
cd claude_qamods
claude --plugin-dir plugins/qa-guide
```

The first time Claude Code loads the plugin from your checkout, it writes the plugin API's type declarations to `plugins/qa-guide/.claude-plugin/types/`. That folder is gitignored, so do not commit it.

## Project layout

```text
.claude-plugin/marketplace.json     marketplace manifest (claude-qamods)
plugins/qa-guide/
  .claude-plugin/plugin.json        plugin manifest
  hooks/hooks.json                  points at the hooks module
  hooks/register.tsx                the mod: hooks and the pane UI
  hooks/register.test.ts            tests for `claude plugin test`
  types/index.d.ts                  $.state contract
docs/                               screenshots and demo videos
```

## Making a change

1. Create a branch from `main`, for example `fix/history-wrap` or `feat/english-output`.
2. Make the change. Match the style of the surrounding code.
3. Add or update tests in `hooks/register.test.ts`. Every behaviour change needs a test. Run each test on both the `terminal` and `desktop` surfaces.
4. Run all checks:

   ```sh
   claude plugin validate .
   claude plugin validate plugins/qa-guide
   claude plugin test plugins/qa-guide
   npx -y -p typescript@5 tsc -p plugins/qa-guide --noEmit
   ```

5. Try the change in a real session with `claude --plugin-dir plugins/qa-guide`, and make Claude ask a question. For UI changes, attach a screenshot from a throwaway project.
6. Add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
7. Open a pull request using the template.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Write the subject in the imperative mood, for example `fix: keep multi-line answers on one line in history`.

## Privacy hygiene

This project is public. Before you push, check that:

- your commits use a GitHub `noreply` address. To keep your email private, set `git config user.email "<id>+<login>@users.noreply.github.com"`
- no file contains absolute local paths (`/Users/...`, `/home/...`, `C:\Users\...`), real names, email addresses or session IDs
- screenshots come from a throwaway project, with your terminal's status line and the paths in them hidden

The `hygiene` workflow checks the files in every pull request. Commit metadata is your responsibility.

## Releasing (maintainers)

1. Update `version` in `plugins/qa-guide/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version.
3. Tag the release (`git tag v0.2.0`) and push the tag.
