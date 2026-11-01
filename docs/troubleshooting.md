# Troubleshooting

Start with `pochi doctor`. It checks where the config comes from and whether it is valid, which LLM and models a run would use, which keys are set (never their values), the state file and the report directory. It also makes the check a run makes before fetching: in API mode it looks up both models with your key, which costs no tokens, and in CLI mode it asks `claude` or `codex` whether you are logged in. It sends no prompt and delivers nothing, so it costs nothing. Add `--fetch` to fetch every source and show its latest title.

```sh
pochi doctor --fetch
```

Then try a run that posts nothing and leaves the state file as it is:

```sh
pochi run --dry-run --verbose
```

## Exit codes

`pochi run` and `pochi doctor` exit with one of these, so a scheduler or a script can tell what went wrong.

A check that doctor fails exits with the code a run would end with for the same problem. For example, a `slack` channel without `SLACK_WEBHOOK_URL` fails with 2, as `pochi run` would; only `pochi run --dry-run`, which delivers nothing, works without it. A key the API turns down fails with 3. A state file that cannot be read or is not valid JSON fails with 1: a run would move it aside and start empty, notifying everything again.

| Code | Meaning |
| --- | --- |
| 0 | Success, including a quiet day and some sources or batches failing |
| 1 | An internal error, or the state file could not be saved after delivering |
| 2 | The config or the command line is wrong |
| 3 | No LLM is available, its key or login is rejected, a model is unknown, or every batch failed |
| 4 | The briefing was not (fully) delivered: Slack refused it, or the report could not be written |
| 5 | Every source failed |
| 130 | Interrupted |

An item is marked as notified only when every channel received it, so after a 4 the next run tries it again.

`pochi init` and `pochi schedule` use the same codes:

| Command | Code | When |
| --- | --- | --- |
| `pochi init` | 2 | Not run in an interactive terminal (stdin and stdout must both be one), a wrong flag (such as `--print-prompt` with `--from`, or a `--news-site` that is not a domain), or a config that cannot be written |
| `pochi init` | 130 | Cancelled (Ctrl-C or Esc), or you answered No to overwriting the existing config. Nothing is written |
| `pochi schedule` | 0 | Done. `status` also ends with 0 when nothing is installed or the job differs from `context.yml`; it warns instead |
| `pochi schedule` | 2 | An invalid config or schedule, an unknown `--backend`, no local scheduler on this platform, `install` run from source rather than `dist/pochi.mjs`, or `launchctl`, `crontab` or a file it needs failed |

## Common problems

| Symptom | What to do |
| --- | --- |
| `no LLM available` | Log in to the `claude` or `codex` CLI, or set `ANTHROPIC_API_KEY` |
| `Anthropic API rejected ANTHROPIC_API_KEY` before anything is fetched | The key was revoked or mistyped (or `ANTHROPIC_AUTH_TOKEN` was rejected by the gateway). Every run checks the key and both models with a lookup that costs no tokens before it fetches any source |
| `Anthropic API does not know the model; check llm.triageModel` | A model name in `context.yml` is mistyped or retired. Through a gateway (`ANTHROPIC_BASE_URL`) this check is skipped, since a gateway need not serve the models endpoint |
| `claude is not logged in` | Run `claude`, then `/login`. A run asks `claude auth status` first (claude 2.1.41 or later) |
| `codex is not logged in` | Run `codex login`. A run asks `codex login status` first, unless `CODEX_API_KEY` or `OPENAI_API_KEY` is set. In the CLI modes a mistyped model is only found by the first request |
| A GitHub source times out | Repositories with huge release notes (such as `nodejs/node`) are better read from their feed: `https://github.com/<owner>/<repo>/releases.atom` as an `rss` source |
| GitHub rate limit | Set `GITHUB_TOKEN` |
| `queries` are skipped | Set `TAVILY_API_KEY` |
| The scheduled job does nothing | `pochi schedule status`, then read `logs/pochi.log` |
| Too much, or too little | Sharpen `problems` and `exclude`, or raise `notify.minImpact` |
