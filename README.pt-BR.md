<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pochi-dark.svg">
    <img src="docs/pochi-light.svg" alt="Pochi" width="112">
  </picture>
</p>

<h1 align="center">Pochi</h1>

<p align="center">
  <strong>Não corra atrás da enxurrada.<br>Busque só o que o seu projeto precisa.</strong>
</p>

<p align="center">
  Uma CLI que lê o seu repositório para decidir o que acompanhar<br>
  e manda um resumo diário e curto para o Slack ou em Markdown.
</p>

<p align="center">
  <a href="https://github.com/tanatyu12/pochi/actions/workflows/ci.yml"><img src="https://github.com/tanatyu12/pochi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-9a6fd8" alt="Licença MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-9a6fd8" alt="Node 22.18 ou mais recente">
</p>

<p align="center">
  <a href="#início-rápido">Início rápido</a> ·
  <a href="#como-funciona">Como funciona</a> ·
  <a href="docs/configuration.md">Configuração</a> ·
  <a href="docs/scheduling.md">Agendamento</a>
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

<p align="center"><sub>Esta é uma tradução. Se houver divergência, vale o <a href="README.md">README.md</a> (em inglês).</sub></p>

<p align="center">
  <img src="docs/demo.gif" alt="pochi woof, pochi doctor e pochi run --dry-run em um terminal" width="800">
  <br>
  <sub>Verificando a configuração e depois um teste (dry run) para um SaaS de help desk de exemplo.</sub>
</p>

## Por que o Pochi

Sai mais notícia sobre a sua stack, o seu mercado e os seus concorrentes do que qualquer pessoa consegue acompanhar. O Pochi não é uma ferramenta que junta tudo e depois filtra. Ele parte do seu projeto e busca só o que tem a ver com ele.

**Ele acompanha só aquilo de que o seu projeto depende.** Um agente de código lê o seu repositório e propõe os problemas que merecem atenção e as fontes a acompanhar: as bibliotecas que você usa, os serviços que você chama, seus concorrentes, seu mercado. Cada sugestão cita os arquivos em que se baseia. O que não tem relação com o projeto nunca é buscado.

**Ele entrega só o que importa, e explica por quê.** O que chega ainda é conferido contra os seus problemas, item por item. O que passa vem com o motivo de importar, o tamanho do impacto (High, Medium, Low) e o que fazer. Nada que você já viu volta a aparecer, várias matérias sobre o mesmo assunto chegam como uma só, e em dia parado o Pochi fica quieto.

<sub>Fontes: releases do GitHub, feeds RSS e Atom, Google News (grátis), busca na web do Tavily · LLM: sua assinatura do Claude ou do Codex, ou uma chave de API da Anthropic · Roda em: launchd, cron ou GitHub Actions</sub>

## O que você recebe

Este é o resumo de um projeto de exemplo no dia em que este README foi escrito: um SaaS de help desk em Next.js que usa IA para rascunhar respostas ([a configuração dele](docs/demo/)). Naquele dia, as 12 fontes trouxeram 11 itens que valiam a leitura, sobre segurança, mercado, concorrentes e regulação. Abaixo, três deles, resumidos. O exemplo foi gerado com `language: English`. Com `language: Portuguese`, os resumos e as ações saem em português, enquanto rótulos como High e Action continuam em inglês.

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

O resumo chega como um arquivo Markdown em `reports/`, como uma mensagem no Slack, ou as duas coisas.

## Início rápido

Você precisa do Node.js 22.18 ou mais recente e de uma destas opções: a CLI [`claude`](https://docs.claude.com/en/docs/claude-code), a CLI [`codex`](https://github.com/openai/codex) ou uma `ANTHROPIC_API_KEY`. Slack e Tavily são opcionais.

O Pochi não está no npm: você o roda a partir da sua própria cópia deste repositório. Clique em **Use this template** (recomendado, para que as execuções agendadas funcionem) ou clone:

```sh
git clone https://github.com/tanatyu12/pochi && cd pochi
npm ci && npm run build
alias pochi="node $PWD/dist/pochi.mjs"
```

**1. Comece pelo seu repositório** (recomendado). Peça uma proposta a um agente de código, só com permissão de leitura, e monte a configuração a partir dela:

```sh
pochi init --print-prompt > /tmp/pochi-prompt.md
(cd ~/code/your-project && claude -p --allowedTools "Read,Glob,Grep" < /tmp/pochi-prompt.md > /tmp/proposal.md)
pochi init --from /tmp/proposal.md
```

Ou, se preferir, responda a algumas perguntas: `pochi init`.

**2. Verifique e faça um teste** que não envia nada:

```sh
pochi doctor          # configuração, LLM, chaves e estado; não chama nenhum modelo, não custa nada
pochi run --dry-run   # mostra o resumo de hoje
```

**3. Rode toda manhã:** `pochi schedule install`. Para GitHub Actions, veja [Agendamento](docs/scheduling.md).

## Do repositório à lista de acompanhamento

O prompt pede ao agente que leia o seu código, a documentação e a configuração, sem tocar em nada secreto, sob cinco ângulos: a stack técnica, o design, o negócio, o mercado e como alcançá-lo, e a operação. Cada sugestão cita a sua evidência. Este é um trecho do que ele propôs para o próprio Pochi (resumido):

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

Com `pochi init --from` você escolhe o que aproveitar da proposta. Ele confere se cada repositório existe, busca cada fonte uma vez para mostrar o que ela traz e grava `config/context.yml` e `config/sources.yml`. Para acompanhar empresas ou players específicos, cite-os pelo nome com `--competitor`, `--adopter` e `--news-site` (todos podem ser repetidos).

## Como funciona

```mermaid
flowchart LR
  collect["Coleta<br/>releases, feeds, notícias"] --> dedupe["Descarta o que<br/>você já viu"]
  dedupe --> triage["Triagem<br/>um modelo pequeno confere cada item"]
  triage -- relevante --> analyze["Análise<br/>um modelo mais forte escreve o resumo"]
  analyze --> notify["Entrega<br/>Slack, Markdown"]
  notify --> save["Registra<br/>o que foi entregue"]
```

Só os itens novos para você chegam ao LLM, e só os relevantes chegam ao modelo mais forte. Se uma fonte ou um lote falhar, o resto da execução continua.

## Comandos

| Comando | |
| --- | --- |
| `pochi init` | Cria a configuração de forma interativa, ou com `--from` a partir da proposta de um agente |
| `pochi doctor` | Verifica a configuração, o LLM, as chaves e o estado, sem chamar modelo nem enviar nada |
| `pochi run` | Coleta, filtra e entrega o resumo do dia (`--dry-run` só imprime) |
| `pochi schedule install` | Roda no horário definido em `context.yml`, com launchd, cron ou GitHub Actions |

Todo comando aceita `--help`.

## Configuração

São dois arquivos em `config/`, ambos gerados pelo `pochi init`:

- **`context.yml`**: o que é o seu projeto, os problemas que importam para você, o que excluir, o idioma do resumo e para onde enviá-lo.
- **`sources.yml`**: os repositórios do GitHub, feeds, buscas no Google News e consultas do Tavily a acompanhar.

O resumo pode ser escrito em qualquer idioma. O `pochi init` oferece inglês, japonês, chinês, espanhol, francês, alemão, português e coreano, e as buscas de notícias usam a edição do Google News desse idioma. Rótulos como High e Action continuam em inglês ([docs/configuration.md](docs/configuration.md)).

<details>
<summary>Um exemplo mínimo</summary>

```yaml
# config/context.yml
version: 1
project:
  name: my-app
  description: Um SaaS em Next.js com backend Postgres e um chat de suporte com LLM.
problems:
  - Mudanças incompatíveis e correções de segurança no Next.js e no React
  - LLMs mais baratos ou mais rápidos para chat de atendimento ao cliente
exclude:
  - Notícias sobre rodadas de investimento e aquisições de empresas
language: Portuguese
notify:
  channels:
    - type: file    # grava reports/<data>.md; ou type: slack com SLACK_WEBHOOK_URL
```

```yaml
# config/sources.yml
version: 1
feeds:
  - { id: nextjs, type: github, name: Next.js releases, repo: vercel/next.js }
  - { id: llm-news, type: googlenews, query: atendimento ao cliente LLM, locale: pt-BR }
```

</details>

Todas as chaves estão em [docs/configuration.md](docs/configuration.md) (em inglês) e nos arquivos comentados [`config/context.example.yml`](config/context.example.yml) e [`config/sources.example.yml`](config/sources.example.yml).

## Custo

- **LLM.** Um modelo pequeno (Claude Haiku) faz a triagem de cada item novo; um mais forte (Claude Sonnet) escreve só sobre os poucos relevantes. Com a CLI `claude` ou `codex`, as execuções usam a sua assinatura. Use uma chave de API em CI ou em qualquer ambiente compartilhado: as assinaturas são para uso pessoal.
- **Fontes.** GitHub, feeds e Google News são gratuitos. O Tavily tem um plano gratuito de 1.000 créditos por mês, e cada consulta gasta um crédito por execução.

## Documentação (em inglês)

- [Configuração](docs/configuration.md): todas as chaves, variáveis de ambiente e o arquivo de estado
- [Agendamento](docs/scheduling.md): launchd, cron e GitHub Actions
- [Solução de problemas](docs/troubleshooting.md): `pochi doctor` e códigos de saída
- [Segurança](SECURITY.md): como chaves e textos externos são tratados, e como relatar uma vulnerabilidade

## Como contribuir

Issues e pull requests são bem-vindos.

```sh
npm ci
npm run typecheck && npm test
npm run dev -- run --dry-run   # executar a partir do código-fonte
```

Os commits seguem o [Conventional Commits](https://www.conventionalcommits.org/); as releases são geradas pelo release-please.

## Licença

[MIT](LICENSE)

<p align="center"><sub>O Pochi é um Shiba. Experimente <code>pochi woof</code>.</sub></p>
