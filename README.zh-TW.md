<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pochi-dark.svg">
    <img src="docs/pochi-light.svg" alt="Pochi" width="112">
  </picture>
</p>

<h1 align="center">Pochi</h1>

<p align="center">
  <strong>不追資訊洪流，<br>只拿專案需要的。</strong>
</p>

<p align="center">
  讀取你的儲存庫、決定該關注哪些來源，<br>
  每天把精簡的重點摘要送到 Slack 或 Markdown 的 CLI。
</p>

<p align="center">
  <a href="https://github.com/OWNER/pochi/actions/workflows/ci.yml"><img src="https://github.com/OWNER/pochi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-9a6fd8" alt="MIT 授權"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-9a6fd8" alt="Node 22.18 以上">
</p>

<p align="center">
  <a href="#快速開始">快速開始</a> ·
  <a href="#運作方式">運作方式</a> ·
  <a href="docs/configuration.md">設定</a> ·
  <a href="docs/scheduling.md">排程執行</a>
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

<p align="center"><sub>本文件為翻譯版本，內容如有出入，以 README.md（英文）為準。</sub></p>

<p align="center">
  <img src="docs/demo.gif" alt="在終端機執行 pochi woof、pochi doctor 和 pochi run --dry-run 的畫面" width="800">
  <br>
  <sub>先檢查設定，再針對範例客服 SaaS 試跑一次。</sub>
</p>

## 為什麼選 Pochi

關於你的技術、市場和競爭對手的新聞，多到沒有人追得完。Pochi 不是先把所有資訊收進來再過濾的工具，而是從你的專案出發，只去抓跟它有關的資訊。

**只關注專案實際依賴的東西。** 由程式開發代理（coding agent）閱讀你的儲存庫，提出值得留意的課題和該追蹤的來源：你用的函式庫、呼叫的服務、競爭對手、所在的市場。每個建議都會附上依據的檔案。跟專案無關的資訊，從一開始就不會去抓。

**只送出重要的內容，並說明原因。** 抓回來的內容還會逐筆對照你的課題做確認。通過的項目會附上為什麼重要、影響程度（High、Medium、Low），以及該怎麼做。看過的不會再出現，同一件事的多篇報導會合併成一則，沒什麼事的日子，Pochi 就安安靜靜。

<sub>來源：GitHub releases、RSS 與 Atom 訂閱、Google 新聞（免費）、Tavily 網路搜尋 · LLM：你的 Claude 或 Codex 訂閱，或 Anthropic API 金鑰 · 執行環境：launchd、cron 或 GitHub Actions</sub>

## 你會收到什麼

以下是撰寫這份 README 當天，為一個範例專案產生的摘要：一個用 Next.js 打造、以 AI 草擬回覆的客服 SaaS（[它的設定](docs/demo/)）。當天 12 個來源帶來 11 則值得一讀的內容，涵蓋資安、市場、競爭對手和法規。以下節錄其中 3 則。這份範例是以 `language: English` 產生的；若設定 `language: Chinese (Traditional)`，摘要和建議行動會以中文輸出，High、Action 等標籤則維持英文。

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

摘要可以存成 `reports/` 裡的 Markdown 檔、發到 Slack，或兩者都要。

## 快速開始

你需要 Node.js 22.18 以上，以及 [`claude`](https://docs.claude.com/en/docs/claude-code) CLI、[`codex`](https://github.com/openai/codex) CLI 或 `ANTHROPIC_API_KEY` 三者之一。Slack 和 Tavily 可有可無。

Pochi 沒有發布到 npm，而是從你自己複製的這個儲存庫執行。建議按 **Use this template** 建立（這樣排程執行才能正常運作），或直接 clone：

```sh
git clone https://github.com/OWNER/pochi && cd pochi
npm ci && npm run build
alias pochi="node $PWD/dist/pochi.mjs"
```

**1. 從你的儲存庫開始**（建議）。請程式開發代理以唯讀方式提出建議，再據此建立設定：

```sh
pochi init --print-prompt > /tmp/pochi-prompt.md
(cd ~/code/your-project && claude -p --allowedTools "Read,Glob,Grep" < /tmp/pochi-prompt.md > /tmp/proposal.md)
pochi init --from /tmp/proposal.md
```

也可以改成回答幾個問題來建立：`pochi init`。

**2. 先檢查，再試跑一次**（不會送出任何東西）：

```sh
pochi doctor          # 檢查設定、LLM、金鑰和狀態檔；不呼叫模型，不花錢
pochi run --dry-run   # 印出今天的摘要
```

**3. 設定每天早上自動執行：** `pochi schedule install`。要用 GitHub Actions 執行，請參閱[排程執行](docs/scheduling.md)。

## 從儲存庫到追蹤清單

這段提示詞會請代理閱讀你的程式碼、文件和設定（但不碰任何機密），並從四個面向著手：技術堆疊、商業模式、市場與競爭對手、營運方式。每個建議都附上依據。以下是它為 Pochi 本身提出的部分建議（節錄）：

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

`pochi init --from` 讓你從中挑選要用的項目，確認每個儲存庫確實存在，並把每個來源各抓一次讓你看看內容，最後寫出 `config/context.yml` 和 `config/sources.yml`。想追蹤特定對象時，可以用 `--competitor`、`--adopter` 和 `--news-site` 指名（皆可重複指定）。

## 運作方式

```mermaid
flowchart LR
  collect["收集<br/>releases、訂閱、新聞"] --> dedupe["排除<br/>已看過的內容"]
  dedupe --> triage["初篩<br/>小模型逐筆確認"]
  triage -- 相關 --> analyze["分析<br/>較強的模型撰寫摘要"]
  analyze --> notify["送出<br/>Slack、Markdown"]
  notify --> save["記錄<br/>已送出的內容"]
```

只有你沒看過的項目會交給 LLM，也只有相關的項目會交給較強的模型。某個來源或某批處理失敗，也不會中斷整次執行。

## 指令

| 指令 | 說明 |
| --- | --- |
| `pochi init` | 以互動方式建立設定，或用 `--from` 從代理的建議建立 |
| `pochi doctor` | 檢查設定、LLM、金鑰和狀態檔，不呼叫模型也不送出任何東西 |
| `pochi run` | 收集、篩選並送出今天的摘要（加上 `--dry-run` 則只印出來） |
| `pochi schedule install` | 依 `context.yml` 裡的排程，透過 launchd、cron 或 GitHub Actions 定期執行 |

每個指令都有 `--help`。

## 設定

設定是 `config/` 裡的兩個檔案，都由 `pochi init` 產生：

- **`context.yml`**：專案的說明、你在意的課題、要排除的內容、摘要的語言，以及送達的地方。
- **`sources.yml`**：要追蹤的 GitHub 儲存庫、訂閱來源、Google 新聞搜尋和 Tavily 查詢。

<details>
<summary>最精簡的設定範例</summary>

```yaml
# config/context.yml
version: 1
project:
  name: my-app
  description: 以 Next.js 和 Postgres 打造的 SaaS 應用程式，客服聊天使用 LLM。
problems:
  - Next.js 和 React 的破壞性變更與安全性修正
  - 更便宜或更快、適合客服聊天的 LLM
exclude:
  - 募資與企業併購新聞
language: Chinese (Traditional)
notify:
  channels:
    - type: file    # 寫入 reports/<日期>.md；若用 Slack，改成 type: slack 並設定 SLACK_WEBHOOK_URL
```

```yaml
# config/sources.yml
version: 1
feeds:
  - { id: nextjs, type: github, name: Next.js releases, repo: vercel/next.js }
  - { id: llm-news, type: googlenews, query: 客服 LLM, locale: zh-TW }
```

</details>

所有設定項目都寫在 [docs/configuration.md](docs/configuration.md)（英文），以及附有註解的 [`config/context.example.yml`](config/context.example.yml) 和 [`config/sources.example.yml`](config/sources.example.yml) 裡。

## 費用

- **LLM。** 每個新項目由小模型（Claude Haiku）初篩，只有少數相關的項目才交給較強的模型（Claude Sonnet）撰寫摘要。使用 `claude` 或 `codex` CLI 時，會在你的訂閱額度內執行。訂閱方案僅限個人使用，CI 或任何共用環境請改用 API 金鑰。
- **來源。** GitHub、訂閱來源和 Google 新聞都是免費的。Tavily 每月有 1,000 點的免費額度，每次執行每個查詢用掉 1 點。

## 文件（英文）

- [設定](docs/configuration.md)：所有設定項目、環境變數、狀態檔
- [排程執行](docs/scheduling.md)：launchd、cron 和 GitHub Actions
- [疑難排解](docs/troubleshooting.md)：`pochi doctor` 與結束代碼
- [安全性](SECURITY.md)：金鑰與不可信文字的處理方式，以及如何回報漏洞

## 參與貢獻

歡迎提出 Issue 和 Pull Request。

```sh
npm ci
npm run typecheck && npm test
npm run dev -- run --dry-run   # 直接從原始碼執行
```

Commit 訊息請遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hant/) 格式；版本由 release-please 發布。

## 授權

[MIT](LICENSE)

<p align="center"><sub>Pochi 是一隻柴犬。試試看 <code>pochi woof</code>。</sub></p>
