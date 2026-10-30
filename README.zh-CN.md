<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pochi-dark.svg">
    <img src="docs/pochi-light.svg" alt="Pochi" width="112">
  </picture>
</p>

<h1 align="center">Pochi</h1>

<p align="center">
  <strong>不必追着信息洪流跑。<br>只取你的项目需要的。</strong>
</p>

<p align="center">
  一个 CLI：从你的仓库出发决定要关注什么，<br>
  每天把一份简短的简报发到 Slack 或写成 Markdown。
</p>

<p align="center">
  <a href="https://github.com/OWNER/pochi/actions/workflows/ci.yml"><img src="https://github.com/OWNER/pochi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-9a6fd8" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-9a6fd8" alt="Node 22.18 或更高版本">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="docs/configuration.md">配置</a> ·
  <a href="docs/scheduling.md">定时运行</a>
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

<p align="center"><sub>本文为译文，如与英文版 README.md 有出入，以英文版为准。</sub></p>

<p align="center">
  <img src="docs/demo.gif" alt="在终端中运行 pochi woof、pochi doctor 和 pochi run --dry-run" width="800">
  <br>
  <sub>先检查配置，再为一个示例客服 SaaS 试运行一次。</sub>
</p>

## 为什么选择 Pochi

关于你的技术栈、市场和竞争对手的新闻，多到没有人跟得上。Pochi 不是那种先把一切都收集起来再过滤的工具。它从你的项目出发，只去获取与项目相关的信息。

**只关注你的项目真正依赖的东西。** 编码智能体会阅读你的仓库，提出值得关心的问题和值得关注的信息源：你用的库、你调用的服务、你的竞争对手、你所在的市场。每条建议都会注明依据的文件。与项目无关的信息，从一开始就不会去获取。

**只推送重要的，并说明原因。** 获取到的内容仍会逐条对照你关心的问题进行检查。最终送达的每一条都会说明为什么重要、重要程度（High、Medium、Low）以及该怎么做。看过的内容不会再出现，同一件事的多篇报道会合并成一条，没什么新鲜事的日子，Pochi 就保持安静。

<sub>信息源：GitHub releases、RSS 和 Atom 订阅源、Google 新闻（免费）、Tavily 网页搜索 · LLM：你的 Claude 或 Codex 订阅，或 Anthropic API 密钥 · 运行方式：launchd、cron 或 GitHub Actions</sub>

## 你会收到什么

下面是编写本 README 当天，为一个示例项目生成的简报：一个基于 Next.js、用 AI 起草回复的客服 SaaS（[它的配置](docs/demo/)）。当天它的 12 个信息源带来了 11 条值得一读的内容，涉及安全、市场、竞争对手和监管。以下摘取其中三条，略有删节。这份示例是用 `language: English` 生成的；如果设为 `language: Chinese (Simplified)`，摘要和行动建议会以中文输出，而 High、Action 等标签仍保持英文。

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

简报可以保存为 `reports/` 下的 Markdown 文件，也可以发送为 Slack 消息，或者两者兼有。

## 快速开始

你需要 Node.js 22.18 或更高版本，以及以下任意一项：[`claude`](https://docs.claude.com/en/docs/claude-code) CLI、[`codex`](https://github.com/openai/codex) CLI 或 `ANTHROPIC_API_KEY`。Slack 和 Tavily 是可选的。

Pochi 没有发布到 npm，你需要在自己的仓库副本中运行它。点击 GitHub 上的 **Use this template**（推荐，这样定时运行才能生效），或者直接 clone：

```sh
git clone https://github.com/OWNER/pochi && cd pochi
npm ci && npm run build
alias pochi="node $PWD/dist/pochi.mjs"
```

**1. 从你的仓库开始**（推荐）。先让编码智能体以只读方式写一份提案，再据此生成配置：

```sh
pochi init --print-prompt > /tmp/pochi-prompt.md
(cd ~/code/your-project && claude -p --allowedTools "Read,Glob,Grep" < /tmp/pochi-prompt.md > /tmp/proposal.md)
pochi init --from /tmp/proposal.md
```

也可以回答几个问题来生成配置：`pochi init`。

**2. 先检查，再试运行一次**，不会发送任何内容：

```sh
pochi doctor          # 检查配置、LLM、密钥和状态文件；不调用模型，不产生费用
pochi run --dry-run   # 打印今天的简报
```

**3. 让它每天早上自动运行：** `pochi schedule install`。如需使用 GitHub Actions，请参阅[定时运行](docs/scheduling.md)。

## 从仓库到关注清单

这段提示词会让智能体阅读你的代码、文档和配置（不碰任何机密文件），并从五个维度展开：技术栈、设计、业务、市场与营销、运营方式。每条建议都附有依据。下面是它为 Pochi 自身给出的部分提案（有删节）：

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

`pochi init --from` 让你从中挑选要用的条目，确认每个仓库确实存在，把每个信息源抓取一次让你看看它的内容，然后写出 `config/context.yml` 和 `config/sources.yml`。如果想追踪特定对象，可以用 `--competitor`、`--adopter` 和 `--news-site` 指名（都可以重复指定）。

## 工作原理

```mermaid
flowchart LR
  collect["收集<br/>releases、订阅源、新闻"] --> dedupe["去掉<br/>已经看过的"]
  dedupe --> triage["初筛<br/>小模型逐条检查"]
  triage -- 相关 --> analyze["分析<br/>更强的模型撰写摘要"]
  analyze --> notify["送达<br/>Slack、Markdown"]
  notify --> save["记录<br/>已送达的内容"]
```

只有你没见过的内容才会交给 LLM，也只有相关的内容才会交给更强的模型。某个信息源或某一批处理失败，不会中断整次运行。

## 命令

| 命令 | 说明 |
| --- | --- |
| `pochi init` | 以交互方式创建配置，或用 `--from` 基于智能体的提案创建 |
| `pochi doctor` | 检查配置、LLM、密钥和状态，不调用模型，也不发送任何内容 |
| `pochi run` | 收集、过滤并送达今天的简报（`--dry-run` 只打印不发送） |
| `pochi schedule install` | 按 `context.yml` 中的时间表，通过 launchd、cron 或 GitHub Actions 定时运行 |

每个命令都支持 `--help`。

## 配置

配置由 `config/` 下的两个文件组成，都由 `pochi init` 生成：

- **`context.yml`**：项目是做什么的、你关心的问题、要排除的话题、简报的语言，以及送达到哪里。
- **`sources.yml`**：要关注的 GitHub 仓库、订阅源、Google 新闻搜索和 Tavily 查询。

简报可以用任何语言撰写。`pochi init` 提供英语、日语、中文、西班牙语、法语、德语、葡萄牙语和韩语可选，新闻搜索也会使用该语言的 Google 新闻版本。High、Action 等标签保持英文（[docs/configuration.md](docs/configuration.md)）。

<details>
<summary>最小示例</summary>

```yaml
# config/context.yml
version: 1
project:
  name: my-app
  description: 基于 Next.js 和 Postgres 的 SaaS 应用，客服聊天使用 LLM。
problems:
  - Next.js 和 React 的破坏性变更与安全修复
  - 更便宜或更快、适合客服聊天的 LLM
exclude:
  - 融资和企业并购新闻
language: Chinese (Simplified)
notify:
  channels:
    - type: file    # 写入 reports/<日期>.md；或使用 type: slack 并设置 SLACK_WEBHOOK_URL
```

```yaml
# config/sources.yml
version: 1
feeds:
  - { id: nextjs, type: github, name: Next.js releases, repo: vercel/next.js }
  - { id: llm-news, type: googlenews, query: 客服 LLM, locale: zh-CN }
```

</details>

所有配置项见 [docs/configuration.md](docs/configuration.md)（英文），以及带注释的 [`config/context.example.yml`](config/context.example.yml) 和 [`config/sources.example.yml`](config/sources.example.yml)。

## 费用

- **LLM。** 每条新内容由小模型（Claude Haiku）初筛，只有少数相关内容才交给更强的模型（Claude Sonnet）撰写。使用 `claude` 或 `codex` CLI 时，运行消耗的是你的订阅额度。在 CI 或任何共享环境中请使用 API 密钥：订阅仅限个人使用。
- **信息源。** GitHub、订阅源和 Google 新闻都是免费的。Tavily 每月有 1,000 积分的免费额度，每次运行每个查询消耗 1 积分。

## 文档（英文）

- [配置](docs/configuration.md)：所有配置项、环境变量、状态文件
- [定时运行](docs/scheduling.md)：launchd、cron 和 GitHub Actions
- [故障排查](docs/troubleshooting.md)：`pochi doctor` 与退出码
- [安全](SECURITY.md)：密钥和不可信文本的处理方式，以及如何报告漏洞

## 参与贡献

欢迎提交 Issue 和 Pull Request。

```sh
npm ci
npm run typecheck && npm test
npm run dev -- run --dry-run   # 直接从源码运行
```

提交信息请遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范；版本由 release-please 发布。

## 许可证

[MIT](LICENSE)

<p align="center"><sub>Pochi 是一只柴犬。试试 <code>pochi woof</code>。</sub></p>
