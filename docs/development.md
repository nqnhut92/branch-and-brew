# Development

## Commands

```bash
npm ci
npm run build            # bundle extension and webviews into dist/
npm run lint
npm run typecheck
npm test                 # unit tests (vitest)
npm run test:integration # downloads VS Code and runs the tests inside it
npm run vsix             # package branch-and-brew-<version>.vsix
```

- `VSCODE_TEST_VERSION=1.90.0` runs the integration tests on the oldest supported VS Code.
- `BAB_REAL_DOWNLOAD=1` adds the tests that download real JDKs and Maven (about 700 MB) and build a Java 8 and a Java 17 project with them (class file versions 52 and 61).

Install a build with **Extensions: Install from VSIX...**.

## Testing

- **Unit tests** cover everything in `src/core`: parsers against captured git output, lane layout, todo validation, diff3 chunking, pom version detection, checksum verification.
- **Fixtures** are repositories built by script in a temp folder for each run, never committed. At least one fixture per feature uses CRLF, and one has a path with spaces and non-ASCII characters.
- **Integration tests** run inside a real VS Code (`@vscode/test-cli`): the extension activates, a repository registers, the views show its status, each panel opens. The webviews report what they drew (commit count, DOM rows, lanes, errors) to the host, which is how tests see inside them.
- **Downloads** run against a local stub server, with stub JDKs and a stub Maven (scripts that record `JAVA_HOME` and their arguments). One opt-in test uses the real endpoints.
- **Hosting accounts** are played by `git http-backend` behind Basic authentication on 127.0.0.1 and a stub GitHub API, with a stand-in for VS Code's sign-in.
- Tests delete temp folders only through `test/fixtures/cleanup.ts`, which retries and gives up quietly: on Windows a fresh folder can stay locked after git exits, and cleanup must never fail a test.
- A globalState write is visible to a read only once VS Code has persisted it, so a test that reads right after a write waits for the value (`until` in `accounts.test.ts`) instead of reading once.
- Timing: the first page of a 50,000-commit history takes under one second in a unit test, and the integration test asserts one second locally and five on CI (`CI` set), where webviews start several times slower.

Not covered by tests, because they need a human, a browser or a real account: the modal questions (identity, stash, "already on a remote", Abort), dragging rows, the Add Account input boxes and folder dialog, the real GitHub and Microsoft sign-in, real REST endpoints and private clones on real hosts. Decisions behind the modals are unit-tested in core; the dialogs themselves are a manual check.

## CI

`.github/workflows/ci.yml`. The repository is public, so GitHub-hosted runners cost no minutes and every push runs the full suite on Linux, Windows and macOS. The jobs run in parallel (a run takes about as long as the slowest one, roughly four minutes) and there are few of them, because the account's concurrent-job limit (20 jobs, 5 macOS on the Free plan) is shared with its other repositories.

| Job | OS | Does |
| --- | --- | --- |
| `linux` | Ubuntu | lint, typecheck, unit tests, package, integration tests on VS Code stable, on 1.90.0 and on the packaged `.vsix`, under `xvfb-run` |
| `test` | Windows, macOS | unit tests and integration tests on VS Code stable |
| `minimum-vscode` | Windows, macOS | integration tests on VS Code 1.90.0 |
| `packaged` | Windows, macOS | integration tests on the packaged `.vsix` |

- Pushes that only touch `*.md` or `docs/` do not run CI.
- A newer push cancels the run in progress.
- Every job has a timeout, and the VS Code download is cached per OS and version.
- On Windows the workspace and temp folder are excluded from Defender, which speeds up `npm ci` and the tests.
- Run `npm run lint && npm run typecheck && npm test && npm run test:integration` locally before pushing for quick feedback; CI is the check on all three OSes.

If the repository ever goes private again, minutes count against the Free plan's 2,000 a month (a Windows minute counts double, a macOS minute ten times) and this layout would use them up quickly: run Linux and Windows per push, and macOS weekly or by hand.
