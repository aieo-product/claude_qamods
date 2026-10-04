## Summary

<!-- What does this change and why? Link the issue: Closes #123 -->

## Checks

- [ ] `claude plugin validate .` and `claude plugin validate plugins/qa-guide` pass
- [ ] `claude plugin test plugins/qa-guide` passes (new behaviour has tests on terminal and desktop)
- [ ] `npx -y -p typescript@5 tsc -p plugins/qa-guide --noEmit` passes
- [ ] Tried in a real session with `claude --plugin-dir plugins/qa-guide`
- [ ] `CHANGELOG.md` updated under `Unreleased`
- [ ] No personal data (paths, names, emails, session IDs) in files, screenshots or commit metadata

## Screenshots

<!-- For UI changes. Capture them in a throwaway project. -->
