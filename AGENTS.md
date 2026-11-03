# Pochi

A CLI that sends a daily, per-project briefing: it collects items from feeds, GitHub, Google News and Tavily, filters them with an LLM in two stages (cheap triage, then analysis of the relevant ones), and delivers to Slack or Markdown files. Distributed as a repo template, not on npm. User docs: `README.md`. How it behaves and why, module by module: `docs/SPEC.md`.

This file is the single source of instructions for coding agents. `CLAUDE.md` only imports it; put new guidance here, not there.

## Commands

- Install: `npm ci` (Node 24 per `.nvmrc`)
- Supported Node: 22.18 and later (`engines`), until Node 22 reaches end-of-life on 2027-04-30; it is then dropped in a minor release. Until then CI runs Node 22 and 24, and `@types/node` stays on 22 so typecheck rejects APIs Node 22 lacks (esbuild's `node22` target only rewrites syntax; it adds no missing APIs). Don't bump `@types/node` past the oldest supported major.
- Typecheck: `npm run typecheck`
- All tests: `npm test`
- One file / one test: `npx vitest run tests/sources/rss.test.ts -t "name"`
- Update snapshots after an intended output change: `npx vitest run -u`, then review the snapshot diff
- Run from source: `npm run dev -- run --dry-run` (prints the briefing to stdout, writes no state)
- Build: `npm run build` → `dist/pochi.mjs` (single esbuild bundle; `dist/` is generated and gitignored)
- Before pushing, run what CI runs: `npm run typecheck && npm test && npm run build && node dist/pochi.mjs --version`

There is no linter or formatter. Match the surrounding style (2-space indent, double quotes, semicolons).

Vitest's global setup (`tests/setup/build.ts`) builds the bundle before every run, including single-file runs, because `tests/bundle.test.ts` executes `dist/pochi.mjs`.

## Code conventions

- ESM. Relative imports carry a `.js` extension (`./commands/run.js`). Type-only imports must use `import type` (`verbatimModuleSyntax`).
- `strict` plus `noUncheckedIndexedAccess`: indexed access is `T | undefined`; handle it rather than asserting with `!`.
- Variants are discriminated unions on `kind` or `type`, handled by exhaustive `switch` with no `default`, so a new variant is a compile error at every place that must handle it.
- Side effects come in through option arguments (`env`, `spawn`, `exec`, `platform`, `home`, `signal`, `prompter`) so tests can inject fakes. Follow this instead of reaching for globals or module mocks.
- Factories are `createX` (`createNotifiers`, `createScheduler`); fetchers are `fetchXItems`; file names are camelCase.
- Code, comments, commit messages and user-facing CLI text are in English. Comments explain why, not what.

## Contracts that are easy to break

- stdout carries only a command's own output: the briefing of `run --dry-run`, the JSON of `run --json`, the report of `doctor`, what `schedule` prints, `woof`, and the prompt of `init --print-prompt` (so it can be piped). A plain `run` prints nothing there. All logging goes through `log` in `src/util/log.ts`, which writes to stderr and passes everything through `redact()`.
- When adding a secret env var, add it to `SECRET_ENV` (and a pattern to `PATTERNS` if its value has a recognizable prefix) in `src/util/log.ts`.
- Expected failures throw a `PochiError` subclass carrying an exit code from `src/errors.ts` (2 config, 3 LLM, 4 delivery, 5 sources, 130 interrupted). Anything else is reported as an internal error (exit 1). These codes are documented in `docs/troubleshooting.md`; keep them stable.
- Error messages never include config values or secrets.
- `Notifier.deliver` never throws; it returns a `Delivery` with failures, and `run` decides the exit code and which items to mark as notified.
- Interrupts: the first Ctrl-C aborts via `AbortSignal`, and work already delivered is still recorded in state. Pass `signal` down to anything that waits.
- An env var set to an empty string counts as unset (GitHub Actions expands missing secrets to `""`). Use `?.trim() || undefined` as the existing code does.
- Do not add a shebang to `src/cli.ts`; `scripts/build.mjs` adds it, and `tests/bundle.test.ts` checks there is exactly one.
- `VERSION` (`src/version.ts`) is injected at build time and is `0.0.0-dev` under tsx and vitest.
- API mode POSTs to `/v1/messages` with `fetch` (`src/llm/api.ts`, no SDK) and must not send `temperature` or `tool_choice` (current models reject them; `tests/llm/api.test.ts` asserts this). It takes credentials and `ANTHROPIC_BASE_URL` from the adapter rather than reading env itself.
- Fetched text reaches the LLM only HTML-escaped inside `<untrusted_items>` (see `src/llm/prompts.ts`). Keep that fencing for any new prompt input.
- Fail on a missing or unusable LLM before fetching anything or spending tokens. Items triaged as irrelevant are stored so they are never re-sent to the LLM.

## Extending

Each list is the minimum set of places to touch; the exhaustive switches will point out any you miss.

- Source type: `src/config/schema.ts` (feed union), `src/types.ts` (`SourceKind`), new `src/sources/<name>.ts`, the switches in `src/sources/index.ts`, and if relevant `src/commands/doctor.ts` and the modules in `src/commands/init/` (`feeds.ts`, `searches.ts`). Add `tests/sources/<name>.test.ts` with fixtures, and update `docs/configuration.md` and `config/sources.example.yml`.
- Notify channel: `src/config/schema.ts` (`notify.channels`), new `src/notifiers/<name>.ts` implementing `Notifier`, the switch in `src/notifiers/index.ts` (secrets come from env, missing secret → `ConfigError`), `SECRET_ENV` in `src/util/log.ts`, doctor, init and docs.
- LLM backend: `src/llm/schema.ts`, new `src/llm/<name>.ts` implementing `LlmClient`, `resolveLlm` in `src/llm/adapter.ts`, `llm.provider` in `src/config/schema.ts`.
- State backend (somewhere other than a local file): implement `StateStore` in `src/state/store.ts`, reusing `parseState`/`serializeState` so the document stays the same, and pass it to `runBriefing` (`src/pipeline/briefing.ts`). The pipeline itself reads no files, env or process state; keep it that way so it can run outside the CLI.
- Scheduler backend: `BackendName` in `src/schedule/types.ts`, new `src/schedule/<name>.ts`, `BACKENDS` and `createScheduler` in `src/schedule/index.ts`, and `docs/scheduling.md`.

## Testing

- Tests never touch the network or spawn real `claude`/`codex`. Use the helpers in `tests/helpers/`: `mockFetch` (route-based fetch stub; call `vi.unstubAllGlobals()` in `afterEach`), `fakeSpawn`, `fakeExec`, `scriptedPrompter`. Canned LLM and feed responses live in `tests/fixtures/`.
- `tests/` mirrors `src/` one file to one file. Name tests `it("does …")`.
- Output formats (Slack, Markdown, schedule files, LLM request shapes) are pinned by snapshots in `__snapshots__/`. A snapshot diff is a user-visible change; make sure it is intended.
- Add or update tests with every behavior change.

## Dependencies

- The runtime dependency list is deliberately small (six packages). Don't add one when Node built-ins or a few lines will do; heavier parsers such as cheerio or rss-parser were rejected on purpose. Discuss before adding any runtime dependency.
- Dependabot opens weekly update PRs; leave version bumps to it unless a change needs one.

## Security

- Never commit `.env`, `config/*.yml` (only `*.example.yml` are tracked), `state/*.json`, `reports/` or `logs/`. Secrets belong in env vars, never in YAML.
- `init` writes config files with mode `0o600` (`src/config/write.ts`); keep it for anything that may hold sensitive data.
- Reporting vulnerabilities: `SECURITY.md`.

## Git

- Branches: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`, off `main`. `main` is protected: every change lands through a pull request that passes CI, and PRs are squash merged.
- The squashed commit takes the PR's title, and release-please builds versions and the changelog from those commits, so the PR title must be a Conventional Commit (`.github/workflows/pr-title.yml` checks it): `type(scope): summary` with a lowercase, plain-English summary and no final period, and the reason in the PR body. Example: `fix(init): ask about a source only when its trial fetch fails or finds nothing`. Write commits inside a branch the same way.
- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `ci`, `chore`, `revert`. Common scopes: `sources`, `llm`, `pipeline`, `run`, `init`, `commands`, `schedule`, `notify`, `slack`, `config`, `state`, `cli`, `util`.
- Don't edit versions, `CHANGELOG.md` or `.release-please-manifest.json` by hand.
- Releases: release-please keeps a `chore(main): release X.Y.Z` PR open and up to date; merging it tags `vX.Y.Z` and publishes the GitHub Release. Before 1.0, `fix` bumps the patch, and `feat` or a breaking change (`!`) bumps the minor. There are no release branches; an urgent fix is a `fix` PR followed by merging the release PR.
- Workflows ship to every template copy, so a job that only makes sense in this repository (release-please, the PR title check) is guarded with `if: github.repository == 'tanatyu12/pochi'`.

## Docs

- `docs/configuration.md`: every `context.yml`/`sources.yml` field, env vars, state file
- `docs/scheduling.md`: `pochi schedule`, launchd, cron, GitHub Actions
- `docs/troubleshooting.md`: exit codes and common problems
- `docs/updating.md`: bringing a new release into a user's copy (clone or template)
- `docs/SPEC.md`: the specification: behavior, invariants and the reasons behind them, module by module. Update it in the same change when behavior changes

When a change is visible to users (commands, flags, config fields, output), update `README.md` and `README.ja.md` together, plus the matching page in `docs/` and the example YAML in `config/`.
