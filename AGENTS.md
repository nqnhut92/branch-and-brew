# Agent rules

Branch and Brew is a VS Code extension written in TypeScript. This repository is worked on by AI agents only; these rules are what a human maintainer would otherwise tell you. Docs are in `docs/`: [architecture](docs/architecture.md), [development](docs/development.md), [decisions](docs/DECISIONS.md), [features](docs/features.md).

## Before every push

CI does not run macOS on each push (macOS minutes cost ten times a Linux minute on the Free plan), and the maintainer's machine is a Mac. So **you run the macOS checks yourself, locally, before pushing**:

```bash
npm run lint && npm run typecheck && npm test && npm run test:integration
```

Push only when all four pass. Say in your report what you ran and what you could not run. CI then covers Linux and Windows; macOS runs weekly and by hand ([docs/development.md](docs/development.md#ci)).

## Code rules

- `src/core` is pure TypeScript and never imports `vscode` (lint enforces it).
- Call git with `execFile` and an argument array. Never build a shell string; lint bans `exec`, `execSync` and `shell: true`.
- Webviews keep the strict CSP, use `--vscode-*` theme variables only, and load nothing remote.
- Before using an external API (VS Code, Adoptium, Maven archive, GitHub, Azure DevOps), read its current official documentation. Where it differs from the code or the docs, follow the documentation and record the change in `docs/DECISIONS.md`.
- Write unit tests for everything in `src/core`. Build fixture repositories by script in a temp folder; never commit a git repository into `test/`.
- Include a CRLF case and a path with spaces and non-ASCII characters where a feature reads files.

## Working style

- Work on `main` and push to `main`; no extra branches.
- Small commits, one concern each.
- Keep `README.md` short. Detail belongs in `docs/`.
- Record a choice that is not obvious from the code in `docs/DECISIONS.md`, with one line of reasoning.
- Report honestly: what was run, what passed, what could not be run or verified (real accounts, real hosts and a human looking at the UI are the usual gaps).
- CI minutes are limited. Do not add jobs, matrix entries or triggers without checking the cost notes in `docs/development.md`.
