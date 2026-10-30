# Troubleshooting

Start with `pochi doctor`. It checks where the config comes from and whether it is valid, which LLM and models a run would use, which keys are set (never their values), the state file and the report directory. It calls no model and sends nothing, so it costs nothing. Add `--fetch` to fetch every source and show its latest title.

```sh
pochi doctor --fetch
```

Then try a run that posts nothing and leaves the state file as it is:

```sh
pochi run --dry-run --verbose
```

## Exit codes

`pochi run` and `pochi doctor` exit with one of these, so a scheduler or a script can tell what went wrong.

A check that doctor fails exits with the code a run would end with for the same problem. For example, a `slack` channel without `SLACK_WEBHOOK_URL` fails with 2, as `pochi run` would; only `pochi run --dry-run`, which delivers nothing, works without it.

| Code | Meaning |
| --- | --- |
| 0 | Success, including a quiet day and some sources or batches failing |
| 1 | An internal error, or the state file could not be saved after delivering |
| 2 | The config or the command line is wrong |
| 3 | No LLM is available, or every batch failed |
| 4 | The briefing was not (fully) delivered: Slack refused it, or the report could not be written |
| 5 | Every source failed |
| 130 | Interrupted |

An item is marked as notified only when every channel received it, so after a 4 the next run tries it again.

## Common problems

| Symptom | What to do |
| --- | --- |
| `no LLM available` | Log in to the `claude` or `codex` CLI, or set `ANTHROPIC_API_KEY` |
| A GitHub source times out | Repositories with huge release notes (such as `nodejs/node`) are better read from their feed: `https://github.com/<owner>/<repo>/releases.atom` as an `rss` source |
| GitHub rate limit | Set `GITHUB_TOKEN` |
| `queries` are skipped | Set `TAVILY_API_KEY` |
| The scheduled job does nothing | `pochi schedule status`, then read `logs/pochi.log` |
| Too much, or too little | Sharpen `problems` and `exclude`, or raise `notify.minImpact` |
