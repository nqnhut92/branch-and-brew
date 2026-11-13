# Decisions

Choices that are not obvious from the code, with the reasoning. Grouped by area.

## Tooling and build

- `engines.vscode` is `^1.90.0` with `@types/vscode` pinned to 1.90.0: it leaves room for users on older VS Code, and CI runs the integration tests on 1.90.0 and on stable.
- Unit tests use vitest; integration tests use `@vscode/test-cli` with `@vscode/test-electron`, which the VS Code testing guide recommends over calling `runTests` directly.
- esbuild bundles (`cjs`, `platform: node`, `external: ['vscode']`), following its sample config. TypeScript resolves modules as the bundler does (`module: Preserve`, `moduleResolution: Bundler`) because `node-diff3` is ESM-only for types.
- Lint enforces the layer rule (`no-restricted-imports` of `vscode` under `src/core`) and bans `exec`, `execSync` and `shell: true` in `src`.
- Licence: MIT, the common choice for VS Code extensions, accepted by the Marketplace as is.
- Icon: `media/icon.png`, 128 px, rendered from `media/icon.svg` (a cup whose steam is a branch graph).
- React 19 is bundled per webview by esbuild (`jsx: automatic`).

## Git access

- The runner sets `LC_ALL=C` and `GIT_TERMINAL_PROMPT=0`, so messages are stable English for parsing; output that must be exact (paths) uses `-z` formats.
- A non-zero exit code is returned, not thrown. Only "could not start", timeout and cancellation reject, so callers can read stderr of normal git failures.
- Status is `git --no-optional-locks status --porcelain=v2 --branch -z`; rename entries consume one extra NUL field. Background status never takes the index lock, so it cannot clash with the user's own git.
- Pull is plain `git pull`, so the user's own config decides between merge and rebase. Push on a branch without an upstream runs `git push --set-upstream`, asking for the remote only when there is more than one.
- Extraction of downloaded archives uses the system `tar` (bsdtar), which on Windows 10+ also reads zip. On Windows `System32\tar.exe` is used explicitly, because Git's GNU tar on `PATH` reads `C:` as a remote host.

## Webviews

- The CSP is `default-src 'none'; script-src 'nonce-…' <cspSource>; style-src <cspSource> 'unsafe-inline'; font-src <cspSource>; img-src <cspSource> data:; connect-src <cspSource>; worker-src blob:`.
- `style-src 'unsafe-inline'` is needed because Monaco injects `<style>` elements and has no nonce support. Scripts stay nonce-only, which is what protects against commit text written by others.
- The Monaco editor worker is bundled to one file, fetched by the webview (`connect-src`) and started from a `blob:` URL, as the webview guide prescribes. Only the editor core is bundled, no language services (0.8 MB `.vsix`).
- The webview ignores the benign "ResizeObserver loop" notice that VS Code 1.90's Electron raises with `automaticLayout`.
- VS Code's `<body>` theme classes and `data-vscode-theme-id` update live on a theme switch (tested on 1.90.0 and current); Monaco re-applies its theme when they change. `vscode-high-contrast-light` is handled when present.
- Webviews use a timer, not `requestAnimationFrame`, to follow a theme switch or to report what they drew: frames stop while a panel or the whole window is not being drawn, which left Monaco on the old theme and made tests time out.
- `WebviewPanel.iconPath` accepts no `ThemeIcon` in the 1.90 API, so the log tab has no icon.
- The log, rebase and merge panels draw their own menus because the items depend on the row and the menu must open from the keyboard at the selected row.

## Rebase editor bridge

- `git rebase --edit-todo` opens the todo with `GIT_SEQUENCE_EDITOR`, so one sequence script serves both the start and mid-run edits; `GIT_EDITOR` only gets commit messages.
- Recent git writes todo lines as `pick <hash> # <subject>`; the parser accepts both forms.
- Editor scripts run with VS Code's own binary and `ELECTRON_RUN_AS_NODE=1`, so the user needs no Node install. Git runs editor commands through `sh` (Git for Windows ships one), so the command is single-quoted for `sh` and Windows paths use forward slashes.
- Transport: a Unix socket in a private `mkdtemp` folder on macOS and Linux, a named pipe `\\.\pipe\branch-and-brew-<random>` on Windows; every request carries a random token.
- Proxies that need NTLM or Kerberos are not supported by the downloader.

## Repositories

- The repository list is one JSON value in `globalState` (`branchAndBrew.repoList`), not synced, because paths are per machine. The pure list model (`core/repos/model.ts`) is unit-tested; the host only stores it.
- Without groups, repositories are listed at the top level; with groups, repositories without one appear under "Ungrouped".
- The watcher is non-recursive on the git dir (`HEAD`, `index`, `MERGE_HEAD`, `rebase-merge`…) and recursive only on `refs/**` and `packed-refs` in the common dir (`rev-parse --path-format=absolute`, git 2.31+), because recursive watchers are expensive. A commit made outside VS Code shows in about 550 ms.
- Working-tree edits do not touch `.git`, so they are picked up when the window regains focus and on Refresh.
- Pull all tries every repository, dirty ones included, and reports git's refusal as a failure. It runs three at a time.
- Askpass: `GIT_ASKPASS` must be one executable path, not a command line, so a POSIX `sh` wrapper is written to `globalStorageUri` with mode 755 at activation (a `.vsix` does not keep file modes); Git for Windows runs it through its own `sh`, as VS Code's built-in Git extension does. `SSH_ASKPASS_REQUIRE=force` makes ssh use it without `DISPLAY`.
- Background fetch (`branchAndBrew.fetchIntervalMinutes`, default 0) never prompts: askpass is removed from its environment and `SSH_ASKPASS_REQUIRE=never`.
- Applying a group's identity profile writes `user.name` and `user.email` as local config to every repository in the group, again when repositories are added or moved into it, and again when the profile is edited. The identity warning also appears before a rebase and before cherry-pick or revert.
- The repository row menu groups Open in This Window, Open in New Window and Open Terminal Here in an **Open** submenu to keep the menu near 12 items, with Remove from List last and confirmed.
- `activate` returns internal handles (store, states, tree) for the integration tests; it is not a public API.

## Commit log

- Data: `git log -z --topo-order --decorate=short` with fields joined by `%x1f` (hash, parents, author name and email, author date, refs, subject). Topological order is what the lane layout needs: a commit always comes before its parents.
- Pages are `--max-count=500 --skip=N`. A page of a 50,000-commit repository takes about 120 ms, deep pages included, so no commit-graph file or cache is needed.
- Search (message, author, email or hash prefix) reads the whole history of the selected branches and filters in the extension: git cannot match "message or author or hash" in one pass (`--grep` and `--author` combine as AND).
- A filtered list (search, history of one file) has no graph, because its rows are not connected. TortoiseGit does the same.
- Commit files come from `git diff-tree --diff-merges=first-parent`, so a merge lists what it brought into the branch.
- Lanes never shift sideways. A commit takes the first lane waiting for it; its first parent continues in that lane, other parents take a waiting lane or the first free one; a freed lane is reused. `git log --graph` compacts columns, so on wide histories the two drawings can differ in column while showing the same connections; on the merge fixtures the columns are identical, which is what the tests check. Layout state is carried from page to page in the host, so a page requested out of order gets no graph, and the column is cut off after 12 lanes.
- One panel per repository; Show Log again reveals it. History of one file is its own panel.
- The branch list is also the branch filter (at most 6, at least 1). **Only current** resets to the current branch in one click, because at the limit the checkboxes are disabled. "Merged" means merged into `main`, `master` or `develop` (local before remote).
- The log reloads when the repository panel sees the repository change (HEAD, branch, ahead/behind, change counts, operation). Other changes (a new tag, a fetch of another branch) need Refresh.
- Hiding the log tab rebuilds the webview, so the scope, search and table scroll offset are written to the panel state and restored. The page that holds the offset is fetched by walking the pages in between.
- Working-tree rows show two letters, staged then unstaged. Show Diff there compares HEAD with the working file.
- Discard removes an untracked entry (`git clean -f -d`), removes a newly added file, and otherwise restores HEAD (`git restore --source=HEAD --staged --worktree`). It always asks.
- Create Branch Here does not switch (a dirty tree cannot block it) and offers "Switch to it" afterwards.
- Cherry-pick and revert of a merge use `-m 1`. Reset is one menu item that asks soft, mixed or hard, and hard asks again.
- Blame is the plain text of `git blame --date=short` in a read-only editor.
- Diffs use the `vscode.diff` command with URIs of the scheme `branch-and-brew`, served by a `TextDocumentContentProvider`; such documents are read-only. The URI path is the file path so VS Code picks the language, and repository and revision travel in the query.
- A commit with several files uses `vscode.changes` (the multi-file diff editor). Its resource list shape `[label, original, modified]` is not described in the commands reference; it comes from VS Code's source and works on 1.90.0 and current. If the call ever fails, the extension falls back to a pick list and `vscode.diff`.

## Three-pane merge

- Stages are found with `git ls-files -u -z` and read by blob id with `git cat-file blob`, as bytes: one call lists every conflicted file with its stages, and bytes are needed to detect and keep the encoding.
- Encoding comes from the BOM (UTF-8 with BOM, UTF-16 LE/BE), else UTF-8; bytes that are not valid UTF-8 are read as Latin-1, which round-trips every byte. The result is written in the encoding, line ending style and final-newline state of "mine" (stage 2).
- Accepted consequences, not bugs to chase: a file with mixed line endings is written with its dominant style, so the minority lines change ending; and Latin-1 maps 0x80–0x9F to control characters instead of the Windows-1252 punctuation a file from another code page meant, so such a pane can look odd. Saving still writes the same bytes back, and no reproduction changes a merge result. They stay until one is reported.
- Binary means a NUL byte in the first 8000 bytes (git's own test), except UTF-16 with a BOM.
- A missing stage (added by both, deleted by one side), a binary file or a stage over 2 MB gets no editor: a pick list offers Keep Mine, Keep Theirs and, when both sides have the file, Delete the File.
- In a rebase git's stage 2 is the branch being rebased onto and stage 3 the commit being applied. The panes keep their places and their titles say so ("rebased so far", "commit being applied").
- Library: `node-diff3` (MIT). Its `diff3MergeRegions` does not report where a one-sided deletion sits in each file, which the panes need for alignment, so the two line diffs come from its `diffIndices` (base against mine, base against theirs) and are combined by diff3's own rule: changes whose base ranges overlap or touch form one chunk; a chunk with changes from both sides is a conflict unless both ended with the same lines.
- Accepting one side resolves the conflict; the other side's arrow stays and adds its lines below (that is "accept both", in either order). `✕` leaves a side out; a conflict with both sides left out is resolved with the base lines.
- Each chunk's place in the result is a tracked range in the result editor, so typing anywhere keeps later chunks in place. Undoing an accept restores the text but not the chunk's buttons.
- The panes scroll together by mapping the middle of the viewport through the chunk it is in. Wrapping and folding are off in all three editors so lines have equal height.
- The merge and rebase panels keep their webview while hidden (`retainContextWhenHidden`), unlike the log: a half-merged result or an edited rebase table cannot be reloaded. The memory cost is paid only while one is open.
- A webview panel cannot stop itself from being closed, so closing the tab drops an unsaved result. The panel says so afterwards with a warning notification, not a modal: nobody can answer a question about work that is already gone, and a modal would hold the window. Saving, which also closes the panel, is not treated as a lost close.
- The conflict list is a native quick pick, back after each file until none is left.
- The host can press the view's buttons (`perform` messages); the integration tests use this.

## Interactive rebase

- One `RebaseSession` (core) drives a rebase through the editor bridge. The sequence editor writes the prepared list; before it does, it checks that git's own list holds the same commits and aborts the start otherwise (the history moved since the table was drawn).
- The table's commits come from `git log --reverse --topo-order --no-merges --right-only --cherry-pick <onto>...HEAD`, which is how git builds its own list.
- A reword uses the message typed in the table; a squash uses the message typed on a squash row of its chain. When nothing was typed, git's editor call is held open, the panel shows git's proposal and Continue answers it. For any other command, git's message is kept.
- While git waits for a message it is still running, so rows cannot be edited and Skip is off; Abort first makes git stop, then aborts.
- Mid-run edits are written with `git rebase --edit-todo` right before Continue or Skip, only when the rows differ from git's list.
- A paused rebase shows Continue in the banner that explains the pause as well as in the toolbar: after resolving conflicts, the next click is Continue and must not need a scroll.
- Git refuses to rebase over uncommitted changes; the offer to stash uses `git rebase --autostash`, so git puts them back when the rebase ends, also after Abort.
- "Already on a remote" means a remote-tracking branch contains the oldest commit in the table (`git branch -r --contains`).
- Todo lines the model does not edit (`exec`, `break`, `label`, `merge`, `update-ref`, `fixup -C`) are kept and shown as "(kept)" rows. A list prepared in the table replaces git's whole list, so `update-ref` lines from `rebase.updateRefs` are not carried over: stacked branches are not moved.
- Dropped commits are written as `drop` lines, so `rebase.missingCommitsCheck` has nothing to complain about. Dropping every commit is refused before the start; while a rebase runs the remaining rows may all be dropped.
- Setup picks the current branch and a pick list for what it goes onto (upstream first). Rebasing a branch that is not checked out would switch branches as a side effect, so switch first.
- "Interactive Rebase from Here" rebases onto the commit's first parent so the commit is the first row; on the first commit it uses `git rebase --root`. "Rebase Current Branch onto This" is a plain `git rebase <commit>` through the same session, and the panel opens only when it stops.
- A rebase started outside the extension (a terminal, `git pull --rebase`) shows in the same panel.

## Java and Maven

- JDK catalogue: the JetBrains feed (`download.jetbrains.com/jdk/feed/v1/jdks.json`, setting `branchAndBrew.java.jdkFeedUrl`), read as `{ jdks: [{ vendor, product, jdk_version_major, jdk_version, packages: [{ os, arch, url, package_type, sha256, install_folder_name }] }] }`. It is not a documented API: entries without that shape are skipped, and a feed that fails or holds nothing usable falls back to the latest Corretto builds plus Temurin from the Adoptium API for Java 25, 21, 17, 11 and 8.
- From the feed, preview builds and special flavours (Liberica "Full") are left out, only `https` URLs with a SHA-256 are accepted, and Windows prefers the zip package. Amazon Corretto is listed first and is the default vendor: it has Java 8 and 17 for Windows x64 and macOS aarch64 (Temurin has no Java 8 for macOS aarch64) and is free to use at work.
- Corretto URLs: `https://corretto.aws/downloads/latest/amazon-corretto-{feature}-{x64|aarch64}-{windows|macos|linux}-jdk.{zip|tar.gz}`, SHA-256 under `latest_sha256/` (`latest_checksum/` is MD5 and unused). Adoptium: `/v3/assets/latest/{feature}/hotspot?architecture=&image_type=jdk&os=&vendor=eclipse`, whose response has the link, SHA-256 and size.
- Maven versions come from Maven Central's `maven-metadata.xml` for `org.apache.maven:apache-maven`, stable 3.x only (its `<latest>` is a Maven 4 preview). Archives and `.sha512` files come from `archive.apache.org/dist/maven/maven-3/<v>/binaries/`, so the downloader supports SHA-512 too.
- A JDK goes into `globalStorage/jdk/<install folder name>` (for example `corretto-17.0.21`), not by feature version: two vendors or two builds of the same version must not overwrite each other. The folder name comes from the feed and is reduced to one plain path segment.
- Download is two pick lists (version, then vendor with size and install folder) and a progress notification with Cancel. Nothing downloads without the user picking it.
- Installed JDKs are found in the extension's storage, IntelliJ's `~/.jdks`, `JAVA_HOME` and the usual install folders (macOS `JavaVirtualMachines`, Windows `Program Files\{Java, Eclipse Adoptium, Amazon Corretto, Zulu, Microsoft, BellSoft}`, Linux `/usr/lib/jvm`). The version comes from the JDK's `release` file; Corretto 8 ships none, so `version.txt` is read next, and `jre/lib/rt.jar` counts as Java 8.
- For a repository the JDK is: one fixed by hand, else the newest installed build of the pom's version, the extension's own downloads before IntelliJ's before the system's.
- Only local parent poms are followed. A project whose version comes from a remote parent (`spring-boot-starter-parent` without its own `java.version`) is asked once and the answer is remembered. Pointing at a local archive instead of downloading is not built; Java Version… can select any JDK on the machine.
- Proxy: the `http.proxy` setting first, then `HTTPS_PROXY` and `HTTP_PROXY`; `http.noProxy` and `NO_PROXY` are honoured. HTTPS goes through a CONNECT tunnel with optional Basic credentials.
- A repository with `mvnw` uses it. On macOS and Linux the wrapper is started through `sh`, so it works without its executable bit (a checkout made on Windows has none). On Windows `mvn.cmd` and `mvnw.cmd` are batch files started through `cmd.exe /d /c`.
- Maven runs as a `vscode.Task` with a `ProcessExecution` (arguments as an array, never a shell string) through `tasks.executeTask`; no task provider is needed. The scope is `TaskScope.Workspace`, because global tasks are not supported and Workspace works with no folder open.
- All Maven runs share one task terminal, cleared for each run: on VS Code 1.146 a task that has to create its own terminal can end without ever starting a process, so the runner starts such a task once more.
- **Build Module…** lists the root pom's `<modules>` and runs `clean install -pl <module> -am`, because the repository panel has no module rows to right-click.
- The mark on the repository row is text after the status ("Maven running", "Maven passed", "Maven failed"); a failed run also shows a notification with Show Output.
- The Maven submenu appears only when the repository has a `pom.xml`. Install JDK and Install Maven are in the view's `…` menu.
- Project kinds are detected in `core/project/detect.ts` from a table of marker files; Gradle or npm would be one more row and their own menu.

## Accounts and credentials

- GitHub and Azure DevOps sign in with `vscode.authentication.getSession` and the built-in `github` and `microsoft` providers. VS Code keeps those tokens; the extension stores only who the account is (kind, host, login) in `globalState`. Another HTTPS host is a host name, a user name and a token in `ExtensionContext.secrets`. No token is written to the account list, a clone's config or a URL.
- Scopes: GitHub `repo` and `read:user`; Microsoft `499b84ac-1321-427f-aa17-267ca6975798/.default` (the Azure DevOps resource id).
- One account per kind and host: `getSession` in the 1.90 API cannot pick between two accounts of one provider. A personal access token added as "Other HTTPS host" for `github.com` works beside it and wins for git.
- Removing a GitHub or Azure DevOps account forgets it here; the sign-in stays in VS Code's Accounts menu.
- REST: GitHub `GET /user` and `GET /user/repos?per_page=100&page=N&sort=pushed` with `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`, paged until one comes back short (at most 2,000). Azure DevOps `GET app.vssps.visualstudio.com/_apis/profile/profiles/me`, then `…/_apis/accounts?memberId=`, then `GET dev.azure.com/{organization}/_apis/git/repositories`, all `api-version=7.1` with `Authorization: Bearer`. The `Authorization` header is dropped when a redirect leaves the host it was meant for.
- Browsing is a pick list with its own filter box; Azure DevOps asks for the organization first. A generic host has no API this extension knows, so it offers Clone from URL only (also for GitHub Enterprise Server and Azure DevOps Server).
- The askpass bridge asks the accounts first: for "Username for 'https://host'" and "Password for 'https://user@host'" the account for that host answers silently. With no account, or for another prompt (an ssh passphrase), the input box appears. Git's own credential helpers still come before askpass.
- For a GitHub or Microsoft account the token is read with `getSession(..., { silent: true })` at that moment; if VS Code would need the user to sign in again, the prompt goes to the input box.
- Azure DevOps: Microsoft documents an Entra token for git as `git -c http.extraheader="AUTHORIZATION: bearer …"`. Here it is given as the password, the way Git Credential Manager's OAuth mode does.
- Token expiry: GitHub reports it in the `github-authentication-token-expiration` header for tokens that expire; it is read when an account is added, and the parser accepts only the `YYYY-MM-DD HH:MM:SS UTC` form. A generic host cannot tell, so the date can be typed when adding the token. Azure DevOps exposes expiry only for personal access tokens through an organization-level API, which is not used. The Accounts view warns from 14 days before.

## Testing and CI

- Integration tests that need a webview to draw wait on what it reports, never on frames (see Webviews).
- The repository is public, so runners are free: every push runs Linux, Windows and macOS. The jobs are split (unit and stable, minimum VS Code, packaged) so the run takes about as long as its slowest job, and kept few because the account's concurrent-job limit (20, 5 macOS) is shared with other repositories. The layout and the fallback for a private repository are in [development.md](development.md#ci).
- There is no scheduled run: with full CI on every push it adds nothing, and GitHub disables scheduled workflows after 60 days without repository activity.
- Docs-only pushes skip CI, and a newer push cancels the run in progress.

## Known limitations

- Not verified against real services: the GitHub and Microsoft sign-in flows, the real REST endpoints, a private clone on each host, Azure DevOps accepting the Entra token as a password, and whether GitHub's `repo` scope is the one needed to list private repositories.
- The real JDK and Maven download test has been run on macOS arm64 only.
- The Windows named-pipe transport of the rebase bridge is covered by CI only.
- `rebase.updateRefs` lines are not carried over, so stacked branches are not moved by an interactive rebase.
- A second GitHub or Microsoft account is not supported.
- Dialogs and drag-and-drop are checked by hand, not by tests.
