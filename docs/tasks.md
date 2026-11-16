# From report to pull request: pochi-tasks

Pochi tells you what changed outside your project. `pochi-tasks`, a Claude Code plugin in this
repository, turns the items that matter into GitHub issues with a plan, and turns the issues you
approve into draft pull requests.

```
pochi run            → reports/<date>.md + reports/<date>.json  (impact and category on each item)
pochi-tasks issue    → filters by impact/category, checks the repository, opens issues    (scheduled)
you                  → add the label pochi:go to the issues worth doing
pochi-tasks implement→ plan → change → checks → independent review → draft PR             (scheduled)
you                  → review and merge
```

The model only reads and edits files. Creating issues, changing labels, pushing and opening pull
requests are done by the runner script, which also re-runs the checks before anything is pushed.

## Requirements

- A Pochi project (`pochi init` done) whose file channel writes JSON:

  ```yaml
  notify:
    channels:
      - type: file
        formats: [md, json]
  ```

- Node 22+, `git`, `gh` (logged in with access to the target repository), `claude` (logged in)
  - The scheduled jobs do not see variables from your shell profile, so `gh` must be logged in
    with `gh auth login` (keychain), not only through `GH_TOKEN` / `GITHUB_TOKEN`.
- A local clone of the target repository

## Install and enable

pochi-tasks is a Claude Code plugin in this repository's marketplace (`.claude-plugin/marketplace.json`,
marketplace name `pochi`). Install it once per machine, from the terminal:

```sh
claude plugin marketplace add tanatyu12/pochi      # or a local checkout: ~/workspace/pochi
claude plugin install pochi-tasks@pochi
```

or inside a Claude Code session: `/plugin marketplace add tanatyu12/pochi`, then
`/plugin install pochi-tasks@pochi`. Check it with `claude plugin list`; it is enabled on
install (`claude plugin disable pochi-tasks@pochi` / `enable` to toggle). Start a new session
afterwards so its skills are loaded.

What the plugin gives you, and where each piece runs:

| Piece | Used by | Needs the plugin enabled? |
|---|---|---|
| `/pochi-tasks:setup` | you, once, in an interactive session | yes |
| `/pochi-tasks:to-issue`, `/pochi-tasks:implement` | the scheduled jobs (also usable by hand) | no: the runner loads them with `--plugin-dir` |
| `scripts/pochi-tasks.mjs` (the runner) | the scheduled jobs | no: launchd runs it with `node` |

So the jobs keep working if you disable the plugin in your sessions, and they always use the
skills that sit next to the runner they run. Point the jobs at a runner path that stays put:

- the marketplace copy, `~/.claude/plugins/marketplaces/pochi/plugins/pochi-tasks/scripts/pochi-tasks.mjs`
  (the `installLocation` in `~/.claude/plugins/known_marketplaces.json`), updated by
  `claude plugin marketplace update pochi`; or
- a git checkout of this repository, `<checkout>/plugins/pochi-tasks/scripts/pochi-tasks.mjs`,
  updated by `git pull`.

Not the plugin cache: that path has the version in it and changes on every update.

## Set up the automation

In the Pochi project directory (the one with `config/context.yml`), start Claude Code and run:

```sh
/pochi-tasks:setup
```

It walks through, asking before anything leaves the machine:

1. turning on JSON reports (`formats: [md, json]` on the file channel);
2. writing `config/tasks.json` (which impact/category become issues, who may label, the checks);
3. checking logins the way launchd will run the jobs, without your shell profile: `gh` must be
   logged in to the keychain (`env -u GH_TOKEN -u GITHUB_TOKEN gh auth login`), not only through
   an exported token, and `claude` must be logged in;
4. creating the labels, and showing a dry run and optionally `--preview` drafts;
5. installing two launchd jobs, `sh.pochi-tasks.issue.<id>` (after each Pochi run) and
   `sh.pochi-tasks.implement.<id>` (every 30 minutes by default);
6. test-running the implement job under launchd and requiring `doctor` to pass.

From then on nothing needs starting by hand:

```
Pochi run (its own schedule)
  └─ ~30 min later: issue job → new issues labeled pochi, pochi:<impact>, pochi:<category>
you: read them, edit the approach if needed, add pochi:go to the ones worth doing
  └─ within one interval: implement job → pochi:working → draft PR, plan comment, pochi:pr-open
                                        or pochi:blocked with the reason (add pochi:go to retry)
you: review and merge the PR
```

Day to day:

| To | Do |
|---|---|
| See what is going on | `node <runner> status`, `tail -f logs/pochi-tasks.log` |
| Check the setup still works | `node <runner> doctor` |
| Run a job now instead of waiting | `launchctl kickstart gui/$(id -u)/sh.pochi-tasks.<issue\|implement>.<id>` |
| Change what becomes an issue | edit `select` in `config/tasks.json` (applies to new reports) |
| Change the timing | edit `schedule` in `config/tasks.json`, then `node <runner> schedule` (`doctor` says when the jobs and the config differ) |
| Change how many issues per run | edit `maxIssuesPerRun` in `config/tasks.json` (read on the next run) |
| Stop | `node <runner> schedule --remove` |
| Update | `claude plugin marketplace update pochi` (or `git pull` in your checkout); the jobs pick it up on their next run |

Everything `setup` does can also be done by hand from the sections below.

## config/tasks.json

| Key | Default | Meaning |
|---|---|---|
| `repo` | required | `owner/name` of the repository issues and PRs go to |
| `repoPath` | required | Local clone of it (`~` allowed) |
| `language` | Pochi's `language` | Language of issues and PR bodies; by default the `language` in `config/context.yml` (English if unset), the same as the reports |
| `select` | required | Rules, OR'ed: `{ "impact": [...], "category": [...] }`; a missing key matches anything |
| `maxIssuesPerRun` | `5` | Issues filed per `issue` run. Items the model skips (already covered, no impact) do not count; the rest wait for the next run |
| `maxConsideredPerRun` | `30` | Items one `issue` run may hand to the model while trying to reach `maxIssuesPerRun`, so a long run of skips stays within the plan's usage |
| `sinceDate` | – | Ignore reports before this date (`YYYY-MM-DD`) |
| `schedule.issueDelayMinutes` | `30` | The issue job runs this many minutes after each of Pochi's own runs |
| `schedule.implementEveryMinutes` | `30` | Minutes between the implement job's checks for `pochi:go` |
| `importMarkdown` | `true` | Import `reports/<date>.md` without a `.json` before each `issue` run |
| `labels` | `pochi`, `pochi:go`, … | Rename the workflow labels |
| `issue.timeoutMinutes`, `issue.maxBudgetUsd`, `issue.model` | `15`, –, – | Limits for each `to-issue` call |
| `implement.allowedLabelers` | required | Logins whose `pochi:go` counts |
| `implement.baseBranch` | origin's default | Branch PRs target |
| `implement.worktreeDir` | `<repoPath>/.claude/worktrees` | Where the worktrees go |
| `implement.setup` | `[]` | Commands run in a new worktree first (`npm ci`) |
| `implement.checks` | `[]` | Commands that must pass, run by claude and again by the runner |
| `implement.planSkill` | – | A planning skill of the target repository to follow |
| `implement.draft` | `true` | Open PRs as drafts |
| `implement.timeoutMinutes`, `implement.maxBudgetUsd`, `implement.model` | `90`, –, – | Limits for each implementation |

Examples for `select`:

```jsonc
[{ "impact": ["High", "Medium"] }]                                         // High and Medium
[{ "impact": ["High"] }, { "impact": ["Medium"], "category": ["tech"] }]   // High, and Medium tech
```

Categories: `tech`, `design`, `business`, `market`, `ops`.

## Commands

Run from the Pochi project directory.

```sh
node <pochi>/plugins/pochi-tasks/scripts/pochi-tasks.mjs issue [--dry-run | --preview]
node <pochi>/plugins/pochi-tasks/scripts/pochi-tasks.mjs implement [--dry-run]
node <pochi>/plugins/pochi-tasks/scripts/pochi-tasks.mjs import-md [--dry-run]
node <pochi>/plugins/pochi-tasks/scripts/pochi-tasks.mjs schedule [--dry-run | --remove]
node <pochi>/plugins/pochi-tasks/scripts/pochi-tasks.mjs doctor
node <pochi>/plugins/pochi-tasks/scripts/pochi-tasks.mjs labels
node <pochi>/plugins/pochi-tasks/scripts/pochi-tasks.mjs status
```

### issue

1. Imports Markdown reports that have no JSON (see import-md), then reads `reports/*.json` and
   the decisions in `state/tasks.json`.
2. Keeps the insights that match `select` and were not considered before. Those that do not match
   are recorded as `unselected`, so changing `select` later only affects new reports.
3. Updates a detached worktree of the base branch (`pochi-snapshot`) so the model reads merged
   code, not a branch in progress.
4. For each insight, runs `claude -p "/pochi-tasks:to-issue <file>"` there with only Read, Grep,
   Glob and Skill, and passes it the repository's open issues (plus the ones filed earlier in the
   run). The skill checks what the item affects and answers `create`, or `skip` when nothing
   needs doing or an open issue already covers the change.
5. Creates the issue with labels `pochi`, `pochi:<impact>`, `pochi:<category>` (and
   `pochi:chore` for work outside the code). The body ends with a hidden
   `<!-- pochi:item=<id> -->`, so an item is never filed twice even if the state file is lost.

`--dry-run` only lists the insights that would be considered. `--preview` also runs the
investigation, but writes each draft (or the reason for skipping) to `previews/<date>-<id>.md`
instead of creating issues; it does not touch `state/tasks.json` or GitHub, so a later real run
considers the same insights again. Use it to tune `select` and check the issue text first.

### import-md

Reports written before `formats: [md, json]` exist only as Markdown. `import-md` parses each
`reports/<date>.md` without a `.json`, has claude assign the categories with Pochi's own
definitions (one short call per report, no tools), and writes `reports/<date>.json` with
`importedFrom`. The `issue` job does this first on every run, so old reports are picked up without
a manual step; set `importMarkdown: false` to turn that off.

### schedule

Writes and (re)loads the two launchd jobs, `sh.pochi-tasks.issue.<id>` and
`sh.pochi-tasks.implement.<id>` (`<id>` is the same hash of the project directory as Pochi's own
`sh.pochi.<id>`). The issue job's times are Pochi's own job's times plus `issueDelayMinutes`, so it
follows Pochi's `schedule` (days, time, timezone); Pochi's job must be installed first
(`pochi schedule`). The implement job runs every `implementEveryMinutes`. Run it again after
changing `schedule`; `--dry-run` prints the plists, `--remove` uninstalls them. On Linux it prints
crontab lines instead.

### doctor

Checks what the scheduled jobs need, under the conditions launchd runs them in: no shell profile,
so `GH_TOKEN` / `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` are left out. It checks the config, that
`gh` can read the repository, the `claude` login (and whether it is a subscription or billed), that
git reaches `origin` without a prompt, the reports, and on macOS that both launchd jobs are loaded
and did not last exit with an error. Exits 1 if anything fails, with the fix for each.

### implement

1. Takes the oldest open issue labeled `pochi:go`, if the label was added by someone in
   `allowedLabelers` (checked in the issue's events). One issue per run; a lock file prevents
   overlapping runs.
2. Relabels it `pochi:working`, creates the worktree `pochi-issue-<n>` on branch
   `pochi/issue-<n>` from the base branch, and runs `setup`.
3. Runs `claude -p "/pochi-tasks:implement .pochi/task.json"` in the worktree. Tools: read and
   edit files, subagents, skills, `git status/diff/log/show/add/commit/restore` and the `checks`
   commands. No push, no `gh`, no network tools.
4. The skill plans (with `planSkill` if set), implements, runs the checks, has a subagent review
   the diff without the issue or plan, fixes what it agrees with, and commits.
5. The runner verifies there are commits, the tree is clean and the checks pass, then pushes,
   opens a draft PR with `Closes #<n>`, posts the plan on the issue and relabels it
   `pochi:pr-open`.
6. If anything stops it, the issue gets a comment with the reason and the label `pochi:blocked`.
   The worktree is kept. Add `pochi:go` again to continue on the same branch.

## Safety

- Item text comes from the web. The skills treat it as data, the issue run has no tools that
  change anything, and the implement run has no network or push access.
- Only labels added by `allowedLabelers` start an implementation.
- PRs are drafts by default and target the base branch; nothing is pushed to it.
- Each claude call has a timeout, and optionally a budget (`maxBudgetUsd`).
  With a Claude subscription login, calls count against the plan's usage limits and are not
  billed; the dollar figures in the log and `maxBudgetUsd` are API-rate estimates. With
  `claude` logged in to an API key (Console), they are what you pay.
- Read-deny rules in the target repository's `.claude/settings.json` (such as `.env`) still apply.

## Logs and state

- `logs/pochi-tasks.log`: each decision, created issue, claude's turns and cost, PR URL
- `state/tasks.json`: `items` (decision per insight id) and `pulls` (result per issue)
