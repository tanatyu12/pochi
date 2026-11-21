---
name: setup
description: Sets up pochi-tasks for a Pochi project interactively - asks multiple-choice questions to write config/tasks.json, turns on JSON reports, makes sure gh and claude work for unattended jobs, creates the GitHub labels, and installs the launchd jobs that file issues from each report and implement the issues labeled pochi:go. Ends with every check in `doctor` passing. Run it in the Pochi project directory (the one with config/context.yml).
disable-model-invocation: true
---

# setup

The goal is a flow that runs without anyone starting it:

```
pochi run (scheduled) → issue job (scheduled, after it) → issues
you add pochi:go      → implement job (every few minutes) → draft PR
```

## How to ask

Ask every choice with the **AskUserQuestion** tool, never as a question in plain text: up to four
questions per call, two to four options each (the tool adds "Other" for a typed answer). Build the
options from what you detected; put the one you recommend first with "(Recommended)" in its label,
and say in its description what it means in this project (paths, counts, commands). Do not ask
what you can detect for sure; state it instead.

Before each step that writes outside the current directory or reaches GitHub, show what you will
write or run and wait for a yes (an AskUserQuestion with "Go ahead" / "Skip this step" is fine).
Do not stop before step 8 passes unless the user says so: a setup that only works when run by
hand is not done.

Write down the answers as you go; step 4 turns them into `config/tasks.json`.

## 1. Detect

Without asking, collect and then show a short summary:

- The current directory has `config/context.yml` (a Pochi project). If not, stop: run `pochi init`
  first.
- From `context.yml`: the project name, `language` (English if unset), `schedule`, and the
  `notify.channels` file channel and its `formats`.
- `reports/`: how many `.md` and `.json`, the oldest and newest date.
- `node --version` (22 or later), and that `git`, `gh` and `claude` are on PATH.
- `gh api user --jq .login`.
- Candidate clones of the target repository: git repositories (depth 1) in the parent of the
  current directory, `~/workspace`, `~/src`, `~/code`, `~/projects` and `~/dev`, with their
  `origin` as owner/name. Rank by how well the directory or repo name matches the project name.
- Runner candidates, for the launchd jobs (they need a path that does not change; the plugin
  cache has the version in it):
  - a git checkout of the Pochi repository among the repositories above (has
    `plugins/pochi-tasks/scripts/pochi-tasks.mjs`);
  - the marketplace copy: `installLocation` of the `pochi` marketplace in
    `~/.claude/plugins/known_marketplaces.json` + `/plugins/pochi-tasks/scripts/pochi-tasks.mjs`.
  Keep only paths that exist. `${CLAUDE_PLUGIN_ROOT}/config/tasks.example.json` is the template.

## 2. Target and runner

One AskUserQuestion call:

1. **Target repository** (header "Repository"): the top three candidate clones, label
   `owner/name`, description the local path. "Other" takes a path.
2. **Runner** (header "Runner"): the candidates, a checkout first ("updated with git pull"), then
   the marketplace copy ("updated with claude plugin marketplace update pochi"). Skip the question
   if there is only one; say which it is. Below, `<runner>` is the chosen path.

Then, in the chosen clone, detect: the default branch (`origin/HEAD`), the package manager from the
lock file, the scripts in `package.json` (or Makefile targets), skills in `.claude/skills/`, and
CI's test command in `.github/workflows/*.yml` if any.

## 3. What becomes an issue

One AskUserQuestion call:

1. **Which items** (header "Select"), each rule OR'ed, with how many items of the existing reports
   each would select in its description (count them from the reports):
   - "High, plus Medium tech/ops" → `[{ "impact": ["High"] }, { "impact": ["Medium"], "category": ["tech", "ops"] }]`
   - "High only" → `[{ "impact": ["High"] }]`
   - "High and Medium" → `[{ "impact": ["High", "Medium"] }]`
   Recommend the first unless the reports have few items. For Markdown-only reports count by
   impact only and say categories are added when they are imported.
2. **Existing reports** (header "Old reports"):
   - "From today on" → `sinceDate` = today
   - "Last 30 days" → `sinceDate` = 30 days ago
   - "All N reports" → no `sinceDate`
   Mention that Markdown-only reports are imported automatically (one short claude call each).
3. **Issues per run** (header "Per run") → `maxIssuesPerRun`, any whole number. Say in the
   question that "Other" takes a number, and that it counts issues filed: items the model skips
   (already covered by an open issue, no impact on the code) do not count, up to
   `maxConsideredPerRun` (default 30) items looked at per run. Base the options on how often Pochi runs (step 1) and how
   many items the chosen rule selects: about a week's worth spread over the runs, e.g. for three
   runs a week "10 (Recommended)", "5", "3"; for a daily run "3 (Recommended)", "5", "10".
4. **Model for the investigation** (header "Model"). Find the default first: run
   `claude -p "reply ok" --output-format json --tools "" --no-session-persistence` and read the
   model id in `modelUsage`. Options: "Default: <model id> (Recommended)" (the model the user's
   Claude Code uses; most thorough) → leave `issue.model` out; "Sonnet" (enough for reading the
   code, about half the usage) → `"sonnet"`. Ask the same for `implement.model` in step 4 only if
   the user wants to; the default is fine for implementing.

`language` is not asked: issues and PRs use Pochi's `language` from step 1. Say which, and that
`language` in `tasks.json` overrides it.

## 4. How it implements

One AskUserQuestion call:

1. **Checks** (header "Checks", `multiSelect: true`): up to four commands from the scripts that
   check without side effects (typecheck, lint, test, check). Leave out watch, coverage, e2e,
   deploy, and anything loading `.env*` or needing secrets. Use the package manager's form
   (`npm run typecheck`, `npm test`).
2. **Setup in a new worktree** (header "Setup"): the install command for the lock file
   ("`npm ci` (Recommended)", `pnpm install --frozen-lockfile`, …) or "Nothing".
3. **Planning** (header "Plan"): each skill in the target's `.claude/skills/` whose name or
   description is about planning (up to three), and "Generic plan" (no `planSkill`).
4. **Who may start an implementation** (header "Labelers"): "<login> only (Recommended)" →
   `allowedLabelers: [login]`; "Other" for several logins, comma-separated.

Then one more call:

1. **Pull requests** (header "PRs"): "Draft (Recommended)" → `draft: true`; "Ready for review".
2. **Run the checks once now?** (header "Try checks"): "Yes (Recommended)" with how long the test
   script usually takes if you can tell; "No".

If yes: create a detached worktree of the default branch under
`<clone>/.claude/worktrees/pochi-setup-check`, run the setup command and then each check there,
as the job would, and remove the worktree afterwards. If a test command fails only with timeouts,
the machine is too busy for the suite's default parallelism: offer (AskUserQuestion) to append
flags that lower it, for vitest and jest `-- --maxWorkers=4 --testTimeout=30000`, and run it
again. If a check fails for another reason, show the key lines and ask whether to keep it; a
check that fails on the base branch blocks every implementation.

Write `config/tasks.json` (mode 600) with `version: 1` and the answers. Show it.

## 5. JSON reports

If the file channel has no `json` in `formats`, show the `notify.channels` block and ask (Go ahead
/ Skip) to add `formats: [md, json]` (add a file channel if there is none).

## 6. Logins the jobs can use

Run `node <runner> doctor`. It checks as launchd runs the jobs: without the shell profile, so
without `GH_TOKEN` / `GITHUB_TOKEN`. Fix each `fail` with its hint and run it again until all
checks before the launchd ones pass:

- gh: if it works only through an exported token, ask the user to run
  `! env -u GH_TOKEN -u GITHUB_TOKEN gh auth login` (stores the token in the keychain). Never
  write tokens into the plist or config.
- claude: `claude auth login`. Say which it is: a subscription uses the plan's usage limits and is
  not billed; an API key is billed per call.
- repository: git must fetch without a prompt; pushes use the same credentials.

## 7. Labels, a first look, and the schedule

1. Ask (Go ahead / Skip), then run `node <runner> labels`.
2. Run `node <runner> issue --dry-run` and show what would be considered. Ask (header "Preview"):
   "Preview the drafts first" → `node <runner> issue --preview` and show the files in `previews/`;
   "No".
3. One AskUserQuestion call; both answers go into `config/tasks.json` under `schedule`, and say in
   each question that "Other" takes any number of minutes and that they can be changed later:
   1. **Implement check interval** (header "Interval") → `implementEveryMinutes`: "Every 30 minutes
      (Recommended)", "Every 5 minutes (while trying it out)", "Every hour". Each check that finds
      nothing is one GitHub API call.
   2. **Issue job timing** (header "Issue job") → `issueDelayMinutes`: "30 minutes after Pochi's
      run (Recommended)", "60 minutes after", with the resulting days and times.
4. Pochi's own job must be installed (`~/Library/LaunchAgents/sh.pochi.<ID>.plist`, from
   `pochi schedule`): the issue job takes its times and adds `issueDelayMinutes`, so it follows
   Pochi's `schedule` (days, time, timezone) without reading it a second time. If it is missing,
   offer to run `pochi schedule` first.
5. Run `node <runner> schedule --dry-run` and show both plists, ask (Go ahead / Skip), then
   `node <runner> schedule`: it writes `~/Library/LaunchAgents/sh.pochi-tasks.{issue,implement}.<ID>.plist`,
   checks them with `plutil` and (re)loads them. Running it again after editing `schedule` in
   `tasks.json` applies the change; `schedule --remove` uninstalls both.

On Linux, `schedule` prints equivalent crontab lines instead; run the step 8 test with `env -i`
and the same PATH.

## 8. Prove it runs unattended

1. `launchctl kickstart gui/$(id -u)/sh.pochi-tasks.implement.<ID>` and, after a few seconds,
   read the end of `logs/pochi-tasks.log`. Expect `no open issue is labeled pochi:go` (or an issue
   being started). Any `error:` line means the job environment lacks something: fix it and
   kickstart again.
2. `node <runner> doctor` must now show `ok` for every line, including both launchd jobs.

Do not kickstart the issue job unless the user wants issues filed now; it files real issues.

## 9. Done

Summarize: where the config is, when each job runs, the log file (`logs/pochi-tasks.log`), and the
flow for the user: read new issues labeled `pochi`, edit them if the approach needs changing (later
comments override the body), add `pochi:go` to the ones worth doing, review the draft PR. To change
the timing: edit `schedule` in `config/tasks.json` and run `node <runner> schedule`. To stop:
`node <runner> schedule --remove`.
