# Scheduling

`pochi schedule install` runs `pochi run` on the `schedule` in `context.yml`, on this machine or on GitHub Actions.

```yaml
schedule:
  interval: daily            # daily | weekly | monthly (the 1st) | cron
  day: [monday, thursday]    # weekly only (default monday)
  time: "06:17"              # HH:MM, 24-hour (default 06:17)
  timezone: Asia/Tokyo       # IANA name (default: this machine's zone)
  cronjob: "17 6 * * 1-5"    # interval: cron only
```

| Backend | Runs on | Keys come from | State file |
| --- | --- | --- | --- |
| `launchd` (default on macOS) | this Mac; a run missed while asleep runs on wake | `.env` in the repository | stays on this machine |
| `cron` (default on Linux) | this machine | `.env` in the repository | stays on this machine |
| `github` | GitHub Actions | repository secrets | committed back by the workflow |

## Commands

```sh
pochi schedule install [--backend launchd|cron|github]
pochi schedule status                 # installed?, the next three runs, the log
pochi schedule uninstall
```

| Option | |
| --- | --- |
| `--print` | Show what would be installed, and change nothing |
| `--at HH:MM` | Run at this time instead of `schedule.time` |
| `--dry-run` | The scheduled runs print the briefing instead of posting it, to try the job |
| `--config-dir <dir>` | Another config directory |

Run `npm run build` first: the job calls `dist/pochi.mjs`.

## On this machine (launchd, cron)

launchd and cron do not see your shell's environment, so put the keys in a `.env` at the repository root and keep it private:

```sh
cat > .env <<'EOF'
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TAVILY_API_KEY=tvly-...
EOF
chmod 600 .env
```

The job runs `pochi run` in this checkout with the `PATH` you had at install time, so it finds the `claude` or `codex` CLI. Its output is appended to `logs/pochi.log`. Install warns if `.env` is missing, readable by others, or lacks a key your config needs. With `cron`, only the line Pochi added is ever touched.

## On GitHub Actions

```sh
pochi schedule install --backend github   # writes .github/workflows/daily_briefing.yml
gh secret set POCHI_CONTEXT_YAML < config/context.yml
gh secret set POCHI_SOURCES_YAML < config/sources.yml
gh secret set ANTHROPIC_API_KEY
gh secret set SLACK_WEBHOOK_URL           # if you use Slack
gh secret set TAVILY_API_KEY              # if you use queries
git add .github/workflows/daily_briefing.yml && git commit -m "ci: daily briefing" && git push
```

The workflow can also be started by hand (Actions → Daily briefing → Run workflow), with a `dry_run` input. After each run it commits `state/notified.json`, so the next run knows what you have seen.

Things to know:

- **Use the template or a clone, not a fork.** Scheduled workflows are disabled in forks. A private repository works too.
- **Use an API key.** The runner has no `claude` or `codex` CLI. Their subscriptions are for your own use, not for CI.
- Scheduled workflows run only on the default branch, and in UTC. Install converts your `time` and `timezone` to UTC; a monthly schedule that would cross midnight cannot be converted, so set `timezone` to UTC instead.
- GitHub pauses scheduled workflows in a public repository after 60 days without activity. The daily state commit counts as activity.
- The workflow can push (`contents: write`), but only its last step gets the token to do so. Checkout runs with `persist-credentials: false` and dependencies are installed with `npm ci --ignore-scripts`, so no package install script or build step can find a token in `.git/config`. The `pochi run` step still receives `GITHUB_TOKEN`, for the GitHub API's rate limit.
