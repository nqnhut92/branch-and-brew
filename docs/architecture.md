# Architecture

The extension is TypeScript, calls the `git` command line for everything, and keeps all logic in a core layer that never imports `vscode`.

## Layout

```
src/core/      pure TypeScript, never imports vscode: git runner and operations, status, log and graph
               lanes, three-way merge, rebase todo and session, repository list model, accounts,
               JDK catalogue, pom reader, Maven, editor and askpass bridges, downloads
src/host/      extension host: commands, views, panels, tasks
src/shared/    message types shared by host and webviews
src/webviews/  browser code for the webview panels (React; VS Code theme variables only)
scripts/       git editor scripts that call back into the extension
test/          fixture repositories, unit and integration tests
docs/          documentation
```

## Technical choices

| Area | Choice | Reason |
| --- | --- | --- |
| Build | esbuild: one bundle for the extension host and one per webview | Fast builds, small `.vsix` |
| Git access | Spawn `git` with `execFile` and argument arrays, never a shell string; parse porcelain and NUL-separated output | Same behaviour as the user's git, works on repositories that are not open, no injection |
| Built-in Git extension | Not used | Its API only covers repositories open in the current window |
| Layers | `core` is unit-testable without VS Code; `host` and `webviews` are thin | The layer rule is enforced by lint |
| Repository view | Native `TreeView` | Light, native menus, keyboard support for free |
| Log, rebase, merge | Webview panels with React; Monaco bundled locally for the merge editors | Layouts the native API cannot draw |
| Messaging | One typed request/response protocol with ids in `shared/` | No stringly-typed messages |
| Theme | `--vscode-*` variables only | Follows the user's theme automatically, including live switches |
| Storage | Repository list and groups in `globalState`; downloads under `globalStorageUri`; settings under one prefix | Same list in every window; nothing needs admin rights |
| Webview security | Strict CSP, nonce on scripts, no remote scripts or fonts | Webviews render commit text written by other people |
| Downloads | HTTPS only, published checksum verified before extracting, proxy aware | Corporate networks |
| Distribution | `vsce package` to a `.vsix`, installed with Install from VSIX | Works without Marketplace access; metadata is ready to publish |

## Rebase editor bridge

`git rebase -i` is driven with `GIT_SEQUENCE_EDITOR` and `GIT_EDITOR` pointing at small scripts in `scripts/`. The scripts run with VS Code's own binary (`ELECTRON_RUN_AS_NODE=1`) and talk back to the extension over a Unix socket (macOS, Linux) or a named pipe (Windows); every request carries a random token. A `RebaseSession` in `core` drives one rebase through this bridge.

## Credentials bridge

`GIT_ASKPASS` points at a small shell wrapper in `globalStorage` that asks the extension. The extension answers from the account for that host, or shows an input box. Background fetch never prompts.

## Context menus

Three menus, one per thing the user right-clicks. Repository-row menus are native tree-view menus declared in `package.json`; log and file menus are drawn inside the webview and are reachable by keyboard. No menu is much longer than about 12 items, and destructive items sit last.

| Right-click on | Items |
| --- | --- |
| Repository row | Fetch, Pull, Push; Switch branch, New branch, Stash, Pop stash; Open (submenu); Git identity, Move to group, Remove from list; Show log; Interactive rebase; Maven (submenu, only with a `pom.xml`) |
| Commit in the log | Checkout, Create branch or tag; Cherry-pick, Revert; Compare, Copy hash or message; Reset (soft, mixed, hard); Rebase onto this, Interactive rebase from here |
| File in a file list | Show diff, Open file, Stage, Unstage, Discard; History, Blame; for a conflicted file also Resolve, Take mine, Take theirs |
