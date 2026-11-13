# Features and usage

## Repositories

The **Repositories** view in the activity bar lists repositories by group with branch, ahead/behind, changed files and conflict or rebase state. A clean repository reads "up to date".

- Add a folder, or scan a folder for repositories (three levels deep, `node_modules` and `target` skipped).
- Fetch, pull, push, switch branch, new branch, stash, pop stash, and an **Open** submenu (this window, new window, terminal).
- **Pull all** for a group or everything: three repositories at a time, then one summary of failures and conflicts.
- **Git identity**: show the effective `user.name` and `user.email` in the tooltip, set them globally or per repository, and keep identity profiles (for example Work and Personal) that a group applies to every repository in it, including ones added later.
- Git's credential prompts appear as VS Code input boxes, so a fetch or push never hangs on a hidden prompt. Git's own credential helpers still answer first.
- Optional background fetch (`branchAndBrew.fetchIntervalMinutes`).

Destructive items (Remove from List, Discard, Reset hard, Drop, Abort) sit last in their menu and ask first.

## Commit log

**Show Log** on a repository opens a flat table of commits with a thin graph column, a branch list beside it and a detail area below. It starts with the current branch, its upstream and the main branch (`main`, `master` or `develop`); tick up to six branches in the list to change that, or press **Only current** to go back to one. Search by message, author or hash.

- Uncommitted changes are the first row, with stage, unstage and discard.
- Double-click a file (or press Enter) to see its change in VS Code's diff editor.
- Right-click a commit: checkout, create branch or tag, cherry-pick, revert, compare with the working tree or the previous commit, copy hash or message, reset (soft, mixed, hard), rebase current branch onto this, interactive rebase from here.
- Right-click a file: show diff, open file, stage, unstage, discard, history of the file, blame.
- From the keyboard, arrow keys move and the Menu key or Shift+F10 opens the menu.

## Three-pane merge

**Resolve Conflicts** on a repository with conflicts (also the merge icon on its row) lists the conflicted files. Picking one opens mine on the left, the editable result in the middle and theirs on the right. Changes that do not conflict are already applied (`branchAndBrew.merge.applyNonConflictingChanges`, or **Apply Non-Conflicting** on the toolbar).

- For each conflict, `»` or `«` in the gutter accepts a side; pressing the other one afterwards adds it below. `✕` leaves a side out.
- Next and previous conflict, and a counter of conflicts left.
- **Save** writes the file with its original line endings and encoding and stages it. Saving with conflicts left asks first.
- The buttons on a file in the list take mine or theirs for the whole file. Binary files, files over 2 MB and files added or deleted on one side only offer that, plus Delete where it applies.
- Closing the tab drops an unsaved result (a webview cannot stop itself from being closed); the conflict stays in git, and a warning says so.

## Interactive rebase

**Interactive Rebase** on a repository asks what the current branch goes onto (its upstream first) and opens a table of its commits, oldest first.

- Change each row's action (pick, reword, edit, squash, fixup, drop), reorder with the arrow buttons, Alt+Up/Down or dragging, and type the new message for a reword or squash. A line shows how many commits go in and out. **Squash All** and **Reset** are on the toolbar.
- **Start Rebase** runs it. Whenever it pauses (a conflict, an `edit`, a message to write) the same table comes back with **Continue**, **Skip** and **Abort**, progress as step N of M, and the rows not yet applied still editable.
- A conflict opens the conflict list and the three-pane merge.
- Before the start, uncommitted changes can be stashed for the rebase's duration, and commits already on a remote branch get a warning.
- From the log, **Interactive Rebase from Here** opens the table from that commit up to HEAD, and **Rebase Current Branch onto This** runs a plain rebase.
- A rebase started in a terminal shows in the same panel.

## Java and Maven

A repository with a `pom.xml` has a **Maven** menu: Build (`clean install`), Build Skipping Tests, Run Tests, Build Module, Custom Goals (the last 10 are remembered). Each runs as a VS Code task in the terminal panel with the JDK the repository needs; the row shows whether the last run passed. Open Terminal Here gets the same `JAVA_HOME` and `PATH`.

- The JDK comes from the `pom.xml` (`maven.compiler.release`, `source`/`target`, `java.version`, the compiler plugin, local parent poms). When nothing is found, you are asked once and the answer is remembered.
- When that Java version is not installed you are offered **Install JDK**: pick a version and a vendor (the list IntelliJ IDEA offers, Amazon Corretto first). It is downloaded, checked against its SHA-256 and stored in the extension's folder. Nothing downloads by itself.
- JDKs already on the machine are used as they are: IntelliJ's `~/.jdks`, `JAVA_HOME`, and the usual install folders.
- **Java Version…** fixes a JDK for one repository, **Show Toolchain** says what will be used.
- **Install Maven** downloads Maven for repositories without a wrapper; a repository's `mvnw` is used when it has one.
- Downloads honour `http.proxy`, `http.noProxy`, `HTTPS_PROXY` and `NO_PROXY`.

## Accounts

The **Accounts** view connects GitHub and Azure DevOps through VS Code's own sign-in, and any other HTTPS host with a user name and a token (kept in VS Code's secret storage).

- **Browse and Clone** lists an account's repositories with a filter; pick one, a folder and a group, and the clone is registered with the group's identity.
- **Clone from URL** works for every host.
- After that, fetch, pull and push on that host take their credentials from the account; no token is written to a clone's config or URL.
- A token close to expiry is marked from 14 days before, where the host tells (GitHub) or from the date entered with the token.

## Settings

| Setting | Meaning |
| --- | --- |
| `branchAndBrew.fetchIntervalMinutes` | Background fetch interval; `0` (default) turns it off. |
| `branchAndBrew.merge.applyNonConflictingChanges` | Open the merge with non-conflicting changes already applied (default on). |
| `branchAndBrew.java.jdkFeedUrl` | Where Install JDK reads its list; empty uses the feed IntelliJ IDEA reads, with Amazon Corretto and Eclipse Temurin as the fallback. |
