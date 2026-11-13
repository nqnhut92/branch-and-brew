# Changelog

## Unreleased

First complete version.

- **Repositories view**: add folders or scan a folder, groups, live status, fetch, pull, push, branches, stash, Open submenu, Pull all, Git identity and identity profiles per group, optional background fetch.
- **Commit log**: graph table loaded 500 commits at a time, branch list and filter (up to six branches, Only current), search, detail area, uncommitted changes row, commit and file menus (checkout, branch, tag, cherry-pick, revert, reset, compare, history, blame).
- **Three-pane merge**: mine, editable result and theirs; per-chunk accept and ignore, accept both in either order, conflict navigation and counter; non-conflicting changes applied on open; saves with the file's line endings and encoding; whole-file Take Mine or Take Theirs; binary, large and one-sided files handled.
- **Interactive rebase**: an editable table of commits that stays editable while the rebase runs; Continue, Skip and Abort; messages for reword and squash; stash offer and remote warning before the start; conflicts open the merge; rebases started in a terminal show in the same panel.
- **Java and Maven**: Maven menu on repositories with a `pom.xml`; JDK picked from the pom; Install JDK and Install Maven on request with checksum verification and proxy support; installed JDKs, including IntelliJ's, are reused.
- **Accounts**: GitHub and Azure DevOps through VS Code's sign-in, other HTTPS hosts with a token in secret storage; Browse and Clone, Clone from URL; git credentials answered from the account; token expiry warnings.
- Settings: `branchAndBrew.fetchIntervalMinutes`, `branchAndBrew.merge.applyNonConflictingChanges`, `branchAndBrew.java.jdkFeedUrl`.

## 0.0.1

- Scaffold: activity bar container, git runner, editor bridge, downloader and three developer checks.
