# Configuration

Pochi reads two files from `config/` (change it with `--config-dir`):

| File | What it says |
| --- | --- |
| `context.yml` | What your project is and what you care about. The LLM judges every item against it. |
| `sources.yml` | Where to look: GitHub repositories, feeds, Google News and web searches. |

`pochi init` writes both. To write them by hand, start from [`config/context.example.yml`](../config/context.example.yml) and [`config/sources.example.yml`](../config/sources.example.yml), which list every key with comments. Unknown keys are an error, so a typo never goes unnoticed.

Both files are gitignored. Keep them out of a public repository: they describe your project.

## context.yml

```yaml
version: 1
project:
  name: my-app
  description: A Next.js SaaS app with a Postgres backend and an LLM-powered support chat.
problems:            # what you want to hear about (1-50)
  - Breaking changes and security fixes in Next.js and React
exclude:             # what to drop even if it looks related (0-30)
  - Funding news and company acquisitions
language: English    # the language of the summaries
```

`problems` is the heart of Pochi. An item reaches you only when it bears on one of them, so write them as concerns ("Cheaper LLMs for support chat"), not as topics ("LLMs").

| Key | Default | Notes |
| --- | --- | --- |
| `llm.provider` | `auto` | `api`, `claude`, `codex`, or `auto`: an API key if `ANTHROPIC_API_KEY` is set, else the `claude` CLI, else `codex` |
| `llm.triageModel` | `claude-haiku-5-5` (api), `haiku` (claude) | The model that reads every new item. Codex uses its own default |
| `llm.analyzeModel` | `claude-sonnet-5-5` (api), `sonnet` (claude) | The model that writes up the relevant ones |
| `llm.maxItemsPerCall` | `40` | Items per LLM request |
| `llm.maxItemsPerRun` | `150` | Items per run; the rest wait for the next run |
| `notify.minImpact` | `Low` | `High`, `Medium` or `Low`: drop anything below |
| `notify.postWhenEmpty` | `false` | Deliver a "No relevant updates" note on quiet days |
| `notify.personality` | `true` | Pochi's voice in the report's footer and quiet-day note |
| `notify.channels` | `[{ type: slack }]` | `slack` (webhook from `SLACK_WEBHOOK_URL`) and/or `file` (`dir`, default `reports`), in delivery order |
| `state.ttlDays` | `45` | Forget items not seen in a feed for this long |
| `state.maxItemAgeDays` | from the schedule | How far back a run looks: daily 2, weekly 8, monthly 32 days, or back to the last run if one was missed |
| `schedule` | daily at 06:17 | See [Scheduling](scheduling.md) |

## sources.yml

```yaml
version: 1
feeds:
  - { id: nextjs, type: github, name: Next.js releases, repo: vercel/next.js }
  - { id: simonw, type: rss, name: Simon Willison, url: "https://simonwillison.net/atom/everything/" }
  - { id: qwen-press, type: googlenews, query: Qwen model release, locale: en-US }
queries:
  - { id: qwen-news, query: Qwen model release, topic: news }
```

Ids must be unique across feeds and queries, and at least one of either is required.

| Type | Needs | Options |
| --- | --- | --- |
| `github` | nothing (`GITHUB_TOKEN` raises the rate limit) | `repo`, `feed: releases \| tags`, `includePrereleases` |
| `rss` | nothing | `url` (RSS, Atom, RDF or JSON Feed) |
| `googlenews` | nothing, free | `query`, `sites` (domains), `locale` (default `en-US`) |
| `queries` (Tavily) | `TAVILY_API_KEY`; skipped without it | `query`, `topic: news \| general`, `maxResults` (1-20), `requireDate`, `includeDomains`, `excludeDomains` |

`defaults` sets how much each feed contributes: `itemsPerFeed` (3, the newest every run), `maxItemsPerFeed` (20, everything since the last run up to this many) and `maxContentChars` (2000).

## Environment variables

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | The LLM in `api` mode |
| `ANTHROPIC_BASE_URL` | A gateway or proxy for the Anthropic API, in `api` mode and for `claude` (default `https://api.anthropic.com`) |
| `ANTHROPIC_AUTH_TOKEN` | Sent as a bearer token to the gateway in `ANTHROPIC_BASE_URL` |
| `SLACK_WEBHOOK_URL` | The `slack` channel. Never put it in a yml file |
| `TAVILY_API_KEY` | `queries` |
| `GITHUB_TOKEN` | GitHub's API rate limit (optional locally; set for you in Actions) |
| `POCHI_CONTEXT_YAML`, `POCHI_SOURCES_YAML` | The config files' contents, for CI. They take precedence over the files |
| `POCHI_STATE_PATH` | The state file (default `state/notified.json`; `--state` wins) |

Values are never printed: `pochi doctor` shows only whether each one is set.

## The state file

`state/notified.json` remembers every item Pochi has seen and what it decided: notified, irrelevant, or relevant but not yet written up. That is why the same story never reaches you twice, and why an item judged irrelevant is not paid for again. `run --dry-run` reads it but never writes it; `--no-state` ignores it altogether.
