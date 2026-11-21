# Issue template

Use these six sections, in this order, and no others at the top level. Write the headings in the
issue's `language` (translate the English names below; for Japanese use the names in brackets).
Leave out a section only when it would be empty; Background, Approach and Acceptance criteria are
never empty.

```markdown
## Background                      (背景)
What happened outside the project, in two or three sentences, and why it matters here.

## Affected code                   (影響箇所)
- `path/to/file.ts:42` — what this line does with the thing that changed
- `cloudbuild.yaml:120` — …

## Approach                        (対応方針)
1. The change, step by step, concrete enough to start (which file, which setting, which version).
2. …
Alternatives considered and why this one, if there was a real choice.

## Acceptance criteria             (受け入れ条件)
- [ ] Observable result 1 (a command passes, a value is pinned, a page shows X)
- [ ] Existing checks pass (name them: `npm run typecheck`, `npm test`, …)

## Out of scope                    (やらないこと)
What is deliberately left out, so the change stays small.

## Risks and open questions        (リスク・確認事項)
What could break, what a reviewer should look at, what is still unverified.
```

Rules:

- Every claim about the code cites `path:line` you actually read.
- One issue, one change. If the Action needs several independent changes, describe the first one
  and list the others under Out of scope as follow-ups.
- No secrets, tokens, internal hostnames or personal data, even if you see them in files.
