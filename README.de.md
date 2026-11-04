<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pochi-dark.svg">
    <img src="docs/pochi-light.svg" alt="Pochi" width="112">
  </picture>
</p>

<h1 align="center">Pochi</h1>

<p align="center">
  <strong>Ein tägliches Briefing darüber, was sich rund um dein Projekt getan hat:<br>nur was zählt, und was zu tun ist.</strong>
</p>

<p align="center">
  Pochi liest dein Repository, entscheidet, was es im Blick behält,<br>
  und schickt dir jeden Morgen ein kurzes Briefing in Slack oder als Markdown.
</p>

<p align="center">
  <a href="https://github.com/tanatyu12/pochi/actions/workflows/ci.yml"><img src="https://github.com/tanatyu12/pochi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-9a6fd8" alt="MIT-Lizenz"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-9a6fd8" alt="Node 22.18 oder neuer">
</p>

<p align="center">
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="#wie-es-funktioniert">Wie es funktioniert</a> ·
  <a href="#dokumentation-englisch">Doku</a>
</p>

<p align="center">
  <sub>
    <a href="README.md">English</a> ·
    <a href="README.ja.md">日本語</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.zh-TW.md">繁體中文</a> ·
    <a href="README.es.md">Español</a> ·
    <a href="README.fr.md">Français</a> ·
    <a href="README.de.md">Deutsch</a> ·
    <a href="README.pt-BR.md">Português</a> ·
    <a href="README.ko.md">한국어</a>
  </sub>
</p>

<p align="center"><sub>Dies ist eine Übersetzung. Bei Abweichungen gilt die englische <a href="README.md">README.md</a>.</sub></p>

<p align="center">
  <img src="docs/demo.gif" alt="pochi woof, pochi doctor und pochi run --dry-run in einem Terminal" width="800">
  <br>
  <sub>Erst wird das Setup geprüft, dann folgt ein Probelauf für ein Beispiel-Helpdesk-SaaS.</sub>
</p>

## So sieht ein Briefing aus

Drei der 11 Einträge, die Pochi an einem Tag für ein Beispiel-Helpdesk-SaaS auf Next.js gefunden hat ([seine Konfiguration](docs/demo/)):

> ### [High] [HTTP2Shell Brotli vulnerability reaches beyond Node.js](https://news.google.com/rss/articles/CBMiowFBVV95cUxNaktOLUVHRnNGOUVQSHZFU2R5SDNxTWJjYlBaLVZfQXpZMFN5Ukl1T2JzNGtCaWp6bS1VTXlfTzRmbHVxanJMRS1nMHRydjRmaUVyeHRNV1VIakhHdE9qZjJKa0xNeWdINWtvWkFzU1ZKYjM5aEo1dkczNFR2ak1kWElKR1pmdEI5M3dfSTdpR2RXaTJ4YlRVSHQ3MUJXeVpSRk44?oc=5)
>
> Check Point reports a Brotli-related flaw, nicknamed HTTP2Shell, that affects more than Node.js. Helpdesk serves Next.js over HTTP, so the flaw could reach it through the runtime, a proxy or a dependency.
>
> **Action:** Check whether Node, your reverse proxy/CDN and any Brotli dependencies are affected, and patch them or disable Brotli/HTTP2 where needed.
>
> ### [Medium] [AI is moving SaaS billing from seats to performance metrics](https://news.google.com/rss/articles/CBMiiAFBVV95cUxQVW1BWTVfNXFvcjhNUTZ3MElJMncybGxiTGdySmtPRHk0LTRBSng3TEhPNUFmbTdJYVE4anFfbXBSXzF0Q3pVQzNHQ3ZKZUR1RXNRMThWbzc2ZFJRTzdmNEREemdPTmhxc2Vid3VEYWRIdkozRmhnc0dneUxJUUFqV1FwSmkxWDVu?oc=5)
>
> SaaS vendors are moving from per-user pricing to outcome-based billing, which matches per-resolution AI pricing in help desks. Seat-based pricing for Helpdesk may come under pressure as AI reduces the number of agents customers need.
>
> **Action:** Model an outcome-based or hybrid pricing option for the AI assistant, and compare it with competitors' per-resolution prices.
>
> ### [Medium] [Zendesk launches employee service AI agents and advanced action flows](https://news.google.com/rss/articles/CBMixwFBVV95cUxQeC1ESnhiT0xmcmNjZGFmalk1dmVuWFNTQlZVX0dsT3ZqSFp3SzE3QWl1OEozVnJEemtkTk5QX25VbUxlZGU0RFpaWXlzbV80WUxuT21yRUx4Ymp2eGUyejE3ZUtWZFhnRVVvYmhySEJUaktCa040MnJJdkc0TldFRklBVWwzay10MFVoWkpHOXNDR3UzRE5Ha0pwMXZPbm5VZkhLSnBBR2pMWjRQYVFORlRmLXdjUW4walpac3pTNnZ2d0RfN1VZ?oc=5)
>
> Zendesk is extending its AI agents to internal employee service and adding action flows for multi-step automation: agents that take actions, not just draft replies.
>
> **Action:** Compare Zendesk's action flows with Helpdesk's roadmap and decide whether action-taking automation should be prioritized.

## Highlights

- **Beobachtet nur, wovon dein Projekt abhängt.** Ein Coding-Agent liest dein Repository und schlägt die Themen und Quellen vor, die es zu beobachten gilt, jeweils mit den Dateien, auf die er sich stützt. Was nichts damit zu tun hat, wird gar nicht erst abgerufen.
- **Sagt, warum es wichtig ist und was zu tun ist.** Jeder Eintrag bringt seine Relevanz mit, eine Einstufung als High, Medium oder Low und eine vorgeschlagene Handlung.
- **Wiederholt sich nie.** Was du schon gesehen hast, taucht nicht wieder auf, mehrere Berichte über dieselbe Geschichte kommen als einer an, und an ruhigen Tagen bleibt Pochi still.
- **Läuft mit dem Abo, das du schon hast.** Nutze deinen Login für das `claude`- oder `codex`-CLI oder einen Anthropic-API-Key.
- **Kostenlose Quellen.** GitHub-Releases, RSS- und Atom-Feeds und Google News kosten nichts; die Tavily-Websuche ist optional.
- **Läuft jeden Morgen von selbst.** `pochi schedule install` richtet launchd, cron oder GitHub Actions ein.

## Schnellstart

Du brauchst Node.js 22.18 oder neuer und eines von diesen: das [`claude`](https://docs.claude.com/en/docs/claude-code) CLI, das [`codex`](https://github.com/openai/codex) CLI oder einen `ANTHROPIC_API_KEY`. Pochi gibt es nicht auf npm: Klick auf **Use this template** (empfohlen, damit geplante Läufe funktionieren) oder klone dieses Repository.

```sh
git clone https://github.com/tanatyu12/pochi && cd pochi
npm ci && npm run build
alias pochi="node $PWD/dist/pochi.mjs"

pochi init              # answer a few questions to write config/
pochi doctor            # check the setup; sends no prompt, costs nothing
pochi run --dry-run     # print today's briefing without posting it
pochi schedule install  # run it every morning
```

### Lass einen Agenten dein Repository lesen (empfohlen)

Statt Fragen zu beantworten, lass einen Coding-Agent dein Projekt lesen, nur mit Lesezugriff, und vorschlagen, was beobachtet werden soll:

```sh
pochi init --print-prompt > /tmp/pochi-prompt.md
(cd ~/code/your-project && claude -p --allowedTools "Read,Glob,Grep" < /tmp/pochi-prompt.md > /tmp/proposal.md)
pochi init --from /tmp/proposal.md
```

Der Agent betrachtet deinen Tech-Stack, dein Design, dein Geschäft, deinen Markt und deinen Betrieb und nennt zu jedem Vorschlag seine Belege. Mit `pochi init --from` wählst du aus dem Vorschlag aus. Pochi prüft, ob jedes Repository existiert, ruft jede Quelle einmal ab, um zu zeigen, was sie liefert, und schreibt `config/context.yml` und `config/sources.yml`. Willst du bestimmte Akteure verfolgen, füge `--competitor`, `--adopter` oder `--news-site` hinzu (alle mehrfach verwendbar).

<details>
<summary>Ein Teil dessen, was er für Pochi selbst vorgeschlagen hat</summary>

```json
"problems": [
  { "text": "Changes to Claude Code and Codex CLI flags, JSON output, auth or safe mode that affect how Pochi spawns them",
    "axis": "tech", "evidence": "src/llm/cli.ts, src/llm/codex.ts, src/llm/adapter.ts" },
  { "text": "Launches and pricing of competing AI news digests, release-tracking and changelog-monitoring tools",
    "axis": "market", "evidence": "package.json description 'Daily briefing for your project'" }
],
"repos": [{ "repo": "colinhacks/zod", "evidence": "package.json zod ^4; src/config/schema.ts" }],
"queries": [{ "query": "AI changelog monitoring tool launch", "intent": "competitor", "topic": "news" }]
```

</details>

## Wie es funktioniert

```mermaid
flowchart LR
  collect["Sammeln<br/>Releases, Feeds, News"] --> dedupe["Bereits Gesehenes<br/>aussortieren"]
  dedupe --> triage["Vorsortieren<br/>ein kleines Modell prüft jeden Eintrag"]
  triage -- relevant --> analyze["Analysieren<br/>ein stärkeres Modell fasst zusammen"]
  analyze --> notify["Zustellen<br/>Slack, Markdown"]
  notify --> save["Merken<br/>was zugestellt wurde"]
```

Nur Einträge, die für dich neu sind, gehen ans LLM, und nur die relevanten erreichen das stärkere Modell. Fällt eine Quelle oder ein Batch aus, läuft der Rest trotzdem weiter.

## Mehr erfahren

| Befehl | |
| --- | --- |
| `pochi init` | Konfiguration interaktiv erstellen oder mit `--from` aus dem Vorschlag eines Agenten |
| `pochi doctor` | Konfiguration, Funktion von LLM-Key oder Login, Keys und State prüfen, ohne einen Prompt zu senden |
| `pochi run` | Das heutige Briefing sammeln, filtern und zustellen (`--dry-run`, um es nur auszugeben) |
| `pochi schedule install` | Nach dem Zeitplan in `context.yml` ausführen, mit launchd, cron oder GitHub Actions |

Jeder Befehl hat `--help`.

**Konfiguration.** `config/context.yml` beschreibt, worum es in deinem Projekt geht, welche Themen dich beschäftigen, was ausgeschlossen wird, die Sprache des Briefings und wohin es zugestellt wird; `config/sources.yml` listet die Repositorys, Feeds und Suchen, die beobachtet werden. Das Briefing kann in jeder Sprache geschrieben werden; `pochi init` bietet acht an.

<details>
<summary>Ein minimales Beispiel</summary>

```yaml
# config/context.yml
version: 1
project:
  name: my-app
  description: Eine Next.js-SaaS-App mit Postgres-Backend und LLM-gestütztem Support-Chat.
problems:
  - Breaking Changes und Sicherheitsfixes in Next.js und React
  - Günstigere oder schnellere LLMs für den Kundensupport-Chat
exclude:
  - Finanzierungsrunden und Firmenübernahmen
language: German
notify:
  channels:
    - type: file    # schreibt reports/<Datum>.md; oder type: slack mit SLACK_WEBHOOK_URL
```

```yaml
# config/sources.yml
version: 1
feeds:
  - { id: nextjs, type: github, name: Next.js releases, repo: vercel/next.js }
  - { id: llm-news, type: googlenews, query: Kundensupport LLM, locale: de-DE }
```

</details>

**Kosten.** Ein kleines Modell (Claude Haiku) sortiert jeden neuen Eintrag vor, und ein stärkeres (Claude Sonnet) schreibt nur die wenigen relevanten aus. Die `claude`- und `codex`-Abos sind für die persönliche Nutzung gedacht, nimm also für CI oder alles, was geteilt wird, einen API-Key. Das Gratiskontingent von Tavily umfasst 1.000 Credits pro Monat; jede Abfrage kostet einen Credit pro Lauf.

### Dokumentation (Englisch)

- [Konfiguration](docs/configuration.md): alle Schlüssel, Umgebungsvariablen, die State-Datei
- [Zeitplan](docs/scheduling.md): launchd, cron und GitHub Actions
- [Aktualisieren](docs/updating.md): eine neue Version in deine Kopie übernehmen
- [Fehlerbehebung](docs/troubleshooting.md): `pochi doctor` und Exit-Codes
- [Sicherheit](SECURITY.md): wie Keys und nicht vertrauenswürdiger Text behandelt werden und wie du eine Schwachstelle meldest

## Mitmachen

Issues und Pull Requests sind willkommen.

```sh
npm ci
npm run typecheck && npm test
npm run dev -- run --dry-run   # run from source
```

Commits folgen den [Conventional Commits](https://www.conventionalcommits.org/de/); Releases erstellt release-please.

## Lizenz

[MIT](LICENSE)

<p align="center"><sub>Pochi ist ein Shiba. Probier mal <code>pochi woof</code>.</sub></p>
