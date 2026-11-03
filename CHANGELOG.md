# Changelog

## 0.1.0 (2026-11-03)

The first release.

Pochi sends one briefing per run with only the news that matters to your project: what changed, why it matters, and what to do. It reads releases, feeds, news and web searches, has an LLM judge each item against what you told it you care about, and delivers the result to Slack or Markdown files. It runs from your own copy of this repository, not from npm.

**Sources**
- GitHub releases or tags, with prereleases left out unless you ask for them
- RSS, Atom, RDF and JSON Feed, found from a blog's URL
- Google News searches (free, no key), limited to sites if you want
- Tavily web searches (optional, `TAVILY_API_KEY`)

**Filtering**
- Two stages: a cheap model triages every new item against your `problems` and `exclude`, and a stronger model writes up only the relevant ones, with impact (High/Medium/Low), a summary and an action
- Reports of the same story are grouped first, so each story is analyzed once and the other articles appear as related links
- Runs on the `claude` or `codex` CLI with your subscription, or on an Anthropic API key
- Fetched text is fenced off as untrusted data, so it cannot steer the model

**Delivery and state**
- Slack (incoming webhook) and Markdown files, in the order you list
- A state file makes sure nothing is delivered twice, and nothing the LLM judged irrelevant is sent to it again
- Summaries in the language you choose

**Commands**
- `pochi init`: an interactive setup that finds feeds, checks repositories, suggests searches and tries every source. It can also start from a proposal written by a coding agent that reads your repository (`--print-prompt`, `--from`)
- `pochi run`: with `--dry-run` to print the briefing, `--json` for scripts, and `--no-state`
- `pochi doctor`: checks the config, the LLM key or login, the keys and the state without spending tokens; `--fetch` also tries every source
- `pochi schedule install | status | uninstall`: runs Pochi every day, week or month, or on a cron expression, through launchd, cron or GitHub Actions. On Actions, the workflow commits the state back

**Requirements:** Node.js 22.18 or later, and the `claude` CLI, the `codex` CLI, or `ANTHROPIC_API_KEY`.

Get started with the [README](https://github.com/tanatyu12/pochi#quick-start). To update a copy later, see [docs/updating.md](https://github.com/tanatyu12/pochi/blob/main/docs/updating.md).
