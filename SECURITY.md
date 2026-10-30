# Security

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's security advisories](https://github.com/tanatyu12/pochi/security/advisories/new), not in a public issue. You will get a reply within a week.

## How Pochi handles secrets and untrusted text

- **Keys stay in the environment.** The Slack webhook, API keys and tokens are read only from environment variables, `.env` or repository secrets, never from the config files. Logs and errors redact them, and `pochi doctor` shows only whether each one is set.
- **The config stays private.** `pochi init` writes `config/*.yml` with mode 600 and checks that git ignores them. In Actions, the config comes from secrets and is never printed.
- **Fetched text is data, not instructions.** Articles reach the LLM wrapped and escaped, with an instruction to ignore anything inside them. The `claude` CLI runs with its tools disabled, in an empty temporary directory, with the prompt on stdin.
- **Output is escaped.** Titles and summaries are escaped before they go into Slack messages and Markdown reports, so a feed cannot inject links, mentions or headings.
- **Network access is bounded.** Only http(s) is fetched, with a timeout and a size limit on every response.

## Supported versions

Only the latest release receives fixes.
