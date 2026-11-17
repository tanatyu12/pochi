import { describe, expect, it } from "vitest";
import {
  type Insight,
  issueParts,
  mdLink,
  mdText,
  pendingInsights,
} from "../../../plugins/pochi-tasks/scripts/pochi-tasks.mjs";

const insight = (over: Partial<Insight>): Insight => ({
  id: "a1",
  report: "2026-11-17.json",
  impact: "High",
  category: "tech",
  title: "t",
  source: "Example",
  url: "https://example.com/post",
  ...over,
});

describe("pendingInsights", () => {
  it("does keep one copy of an id that appears in several reports", () => {
    const all = [
      insight({ id: "a1", report: "2026-11-16.json", impact: "Low" }),
      insight({ id: "b2", report: "2026-11-16.json" }),
      insight({ id: "a1", report: "2026-11-17.json", impact: "Low" }),
    ];
    const { fresh, picked } = pendingInsights(all, { items: {} }, [{}]);
    expect(fresh.map((f) => f.id).sort()).toEqual(["a1", "b2"]);
    expect(picked.map((f) => `${f.id}@${f.report}`)).toEqual(["b2@2026-11-16.json", "a1@2026-11-17.json"]);
  });

  it("does leave out ids already in state", () => {
    const { fresh } = pendingInsights([insight({ id: "a1" }), insight({ id: "b2" })], { items: { a1: {} } }, [{}]);
    expect(fresh.map((f) => f.id)).toEqual(["b2"]);
  });

  it("does return unselected items in fresh but not in picked", () => {
    const { fresh, picked } = pendingInsights([insight({ impact: "Low" })], { items: {} }, [{ impact: ["High"] }]);
    expect(fresh).toHaveLength(1);
    expect(picked).toHaveLength(0);
  });
});

describe("mdText", () => {
  it("does escape Markdown and HTML so text stays literal", () => {
    expect(mdText("a]b(c)*_`<img src=x>&@me\\")).toBe("a\\]b\\(c\\)\\*\\_\\`&lt;img src=x&gt;&amp;\\@me\\\\");
  });

  it("does fold line breaks into spaces", () => {
    expect(mdText("one\n\n# two")).toBe("one # two");
  });
});

describe("mdLink", () => {
  it("does wrap an http(s) URL in angle brackets", () => {
    expect(mdLink("Example", "https://example.com/a")).toBe("[Example](<https://example.com/a>)");
  });

  it("does keep a ) or space in the URL from ending the link", () => {
    const link = mdLink("x", "https://example.com/a) [evil](https://evil.example/");
    // Inside <...> only <, > and line breaks end the destination, so ( ) [ ] stay literal.
    expect(link).toBe("[x](<https://example.com/a)%20[evil](https://evil.example/>)");
  });

  it("does percent-encode angle brackets in the URL", () => {
    expect(mdLink("x", "https://example.com/?q=<script>")).toBe("[x](<https://example.com/?q=%3Cscript%3E>)");
  });

  it("does escape a ] in the link text", () => {
    expect(mdLink("a](javascript:alert(1))", "https://example.com/")).toBe(
      "[a\\]\\(javascript:alert\\(1\\)\\)](<https://example.com/>)",
    );
  });

  it("does show a non-http URL as text, not a link", () => {
    expect(mdLink("Example", "javascript:alert(1)")).toBe("Example (javascript:alert\\(1\\))");
    expect(mdLink("Example", "not a url")).toBe("Example (not a url)");
    expect(mdLink("Example", undefined)).toBe("Example");
  });
});

describe("issueParts", () => {
  const cfg = { labels: { base: "pochi" } };

  it("does write an escaped footer and the item marker", () => {
    const { labels, body } = issueParts(cfg, insight({ source: "Blog [x]", url: "https://e.com/a)b" }), { body: "Body\n" });
    expect(labels).toEqual(["pochi", "pochi:high", "pochi:tech"]);
    expect(body).toBe(
      "Body\n\n---\n_Pochi 2026-11-17 · \\[High\\] \\[tech\\] · [Blog \\[x\\]](<https://e.com/a)b>)_\n\n<!-- pochi:item=a1 -->\n",
    );
  });

  it("does make labels only from known impacts and categories", () => {
    const { labels } = issueParts(cfg, insight({ impact: "toString", category: "evil" }), { body: "B" });
    expect(labels).toEqual(["pochi"]);
  });

  it("does leave out a marker whose id could end the comment", () => {
    const { body } = issueParts(cfg, insight({ id: "x --> <b>hi</b>" }), { body: "B" });
    expect(body).not.toContain("<!--");
    expect(body).not.toContain("<b>");
  });
});
