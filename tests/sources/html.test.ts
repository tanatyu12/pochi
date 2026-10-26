import { describe, expect, it } from "vitest";
import { htmlToLine, htmlToText, inlineHtmlToLine, plainTextToText } from "../../src/sources/html.js";
import { truncate } from "../../src/util/text.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function length(s: string): number {
  return Array.from(s).length;
}

describe("htmlToText", () => {
  it.each([
    ["<p>a</p><p>b</p>", "a\nb"],
    ["a<br>b<br/>c", "a\nb\nc"],
    ["<p>Hello <b>wo</b>rld and <a href='/x'>link</a></p>", "Hello world and link"],
    ["<ul><li>one</li><li>two</li></ul>", "one\ntwo"],
    ["<table><tr><td>a</td><td>b</td></tr></table>", "a b"],
    ["", ""],
    ["<div><span></span></div>", ""],
    ["  plain   text\t here  ", "plain text here"],
    ["<p>a</p>\n\n\n<p>  b  </p>", "a\nb"],
    ["<pre>a<br># b</pre>", "a\n# b"],
  ])("converts %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it.each([
    ["<script>alert(1)</script>keep", "keep"],
    ["<SCRIPT type='module'>x()</SCRIPT>keep", "keep"],
    ["<style>p{color:red}</style>keep", "keep"],
    ["<noscript>enable js</noscript><template><p>t</p></template>keep", "keep"],
    ["<svg viewBox='0 0 1 1'><text>icon</text></svg>keep", "keep"],
    ["<svg/>keep", "keep"],
    ["<iframe src='x'>fallback</iframe>keep", "keep"],
    ["<nav>Home | About</nav><aside>Popular posts</aside><p>keep</p><footer>(c) 2026</footer>", "keep"],
    ["<header><h1>Site</h1></header><form><input></form><p>keep</p>", "keep"],
    ["<!-- hidden -->keep<!-- also hidden -->", "keep"],
    ["keep<script>never closed", "keep"],
    ["keep<!-- never closed", "keep"],
    ["keep<nav", "keep"],
    ["a<!-- x -->b<nav>n</nav>c<!--y", "abc"],
  ])("drops %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it.each([
    ['<script>var s="<!--";</script><p>keep</p>', "keep"],
    ["<style>/* <!-- */</style>keep<!-- c -->", "keep"],
    ['<script>"<nav>"</script>keep', "keep"],
    ['<nav><script>"</nav>"</script>x</nav>keep', "keep"],
    ["<nav><!-- </nav> -->x</nav>keep", "keep"],
    ["<script><script>x</script>shown", "shown"],
  ])("reads comments and raw text in document order in %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it.each([
    ["<iframe src=https://x/>fallback</iframe>keep", "keep"],
    ["<form action=/submit/><input></form>keep", "keep"],
    ["<nav data-base=/>Home</nav>keep", "keep"],
    ["<svg a=b/>x</svg>keep", "keep"],
    ["<svg a = b/>x</svg>keep", "keep"],
    ["<svg />keep", "keep"],
    ['<svg a="b"/>keep', "keep"],
    ["<svg a/>keep", "keep"],
    ["<svg a=b />keep", "keep"],
    ['<svg a="p=q"/>keep', "keep"],
  ])("tells self-closing tags from unquoted values ending in a slash in %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it.each([
    ["<nav><nav>a</nav>leak</nav>keep", "keep"],
    ["<svg><svg><text>a</text></svg>leak</svg>keep", "keep"],
    ["<NAV><nav>a</NAV>leak</Nav>keep", "keep"],
    ["<nav><aside>x</nav>keep", "keep"],
    ["keep<nav><nav>a</nav>", "keep"],
    ["</nav>keep", "keep"],
    ["<nav></nav></nav>keep", "keep"],
    ["<navigation>keep</navigation>", "keep"],
    ["<header-x>keep</header-x>", "keep"],
  ])("counts nested dropped elements in %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it.each(["<svg ", "<nav>", "<nav></nav>"])("handles many %j tags in linear time", (tag) => {
    const start = performance.now();
    expect(htmlToText(`keep${tag.repeat(200_000)}`, 100)).toBe("keep");
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it.each([
    ["Tom &amp; Jerry &quot;quoted&quot; it&#39;s", `Tom & Jerry "quoted" it's`],
    ["smile &#x1F600;", "smile 😀"],
    ["a&nbsp;&nbsp;b", "a b"],
    ["&copy; 2026", "© 2026"],
    ["if a < b and c > d", "if a < b and c > d"],
    ["x &#1;y\u0002z", "x yz"],
    ["x &#2;w", "x w"],
  ])("decodes %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it("unwraps double-escaped HTML from GitHub Atom feeds", () => {
    const content = "&lt;h2&gt;Breaking&lt;/h2&gt;&lt;p&gt;Fix &amp;amp; bump&lt;/p&gt;&lt;script&gt;x&lt;/script&gt;";
    expect(htmlToText(content, 1000)).toBe("Breaking\nFix & bump");
  });

  it("unwraps only one extra level", () => {
    expect(htmlToText("&lt;p&gt;&amp;lt;b&amp;gt;x&lt;/p&gt;", 1000)).toBe("<b>x");
  });

  it.each([
    ["&lt;p&gt;Supports &amp;lt;form&amp;gt; actions&lt;/p&gt;&lt;p&gt;more&lt;/p&gt;", "Supports <form> actions\nmore"],
    ["&lt;!-- c --&gt;&lt;p&gt;x&lt;/p&gt;", "x"],
    ["  &lt;p&gt;lead ws&lt;/p&gt;", "lead ws"],
  ])("unwraps double-escaped %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it.each([
    ["<p>Supports &lt;form&gt; actions</p><p>more text</p>", "Supports <form> actions\nmore text"],
    ["<p>Avoid &lt;script&gt; in &lt;head&gt;</p><p>tail</p>", "Avoid <script> in <head>\ntail"],
    ["<p>Use <code>&lt;Image&gt;</code> and AT&amp;amp;T</p>", "Use <Image> and AT&amp;T"],
    ["Use &lt;form&gt; to submit, then more text", "Use <form> to submit, then more text"],
    ["Wrap it in &lt;b&gt;bold&lt;/b&gt; please", "Wrap it in <b>bold</b> please"],
  ])("keeps escaped tags as text in %j", (html, expected) => {
    expect(htmlToText(html, 1000)).toBe(expected);
  });

  it("does not let decoded entities forge heading markers", () => {
    const html = `<p>${"intro ".repeat(20)}</p><p>&#1;fake</p><h2>Real</h2><p>body</p>`;
    const text = htmlToText(html, 60);
    expect(text).toContain("Real");
    expect(text).not.toContain("\u0001");
  });

  it.each([
    "<p>Body</p><p>The post Hello appeared first on My Blog.</p>",
    "<p>Body</p><p>Continue reading →</p>",
    "<p>Body</p><p><a href='/x'>Read more…</a></p>",
  ])("drops feed boilerplate in %j", (html) => {
    expect(htmlToText(html, 1000)).toBe("Body");
  });

  it("keeps long sentences that start with read more", () => {
    const line = "Read more about the new caching model in the migration guide.";
    expect(htmlToText(`<p>${line}</p>`, 1000)).toBe(line);
  });

  describe("heading-aware truncation", () => {
    const release = [
      `<p>${"This release contains many changes from our contributors. ".repeat(10)}</p>`,
      "<h2>Core Changes</h2>",
      ...Array.from({ length: 30 }, (_, i) => `<li>Refactor module ${i} for clarity (#${1000 + i})</li>`),
      "<h2>Breaking Changes</h2>",
      "<p>Dropped support for Node 20.</p>",
      "<p>Renamed the cache option.</p>",
      "<h2>Security</h2>",
      "<p>Fixed CVE-2026-0001 in the image optimizer.</p>",
    ].join("");

    it("keeps every heading and the start of each section", () => {
      const text = htmlToText(release, 400);
      expect(length(text)).toBeLessThanOrEqual(400);
      for (const s of [
        "Core Changes",
        "Refactor module 0",
        "Breaking Changes",
        "Dropped support for Node 20.",
        "Security",
        "Fixed CVE-2026-0001",
      ]) {
        expect(text).toContain(s);
      }
      expect(text).not.toContain("Refactor module 29");
      expect(text.endsWith("…")).toBe(true);
    });

    it("keeps the original order", () => {
      const text = htmlToText(release, 400);
      const positions = ["This release", "Core Changes", "Breaking Changes", "Security"].map((s) => text.indexOf(s));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(positions[0]).toBe(0);
    });

    it("treats Markdown headings the same way", () => {
      const md = [
        "intro ".repeat(50),
        "## Fixes",
        ...Array.from({ length: 20 }, (_, i) => `- fix ${i}`),
        "## Breaking",
        "- removed the legacy API",
      ].join("<br>");
      const text = htmlToText(md, 200);
      expect(length(text)).toBeLessThanOrEqual(200);
      expect(text).toContain("## Breaking\n- removed the legacy API");
      expect(text).not.toContain("fix 19");
    });

    const intro = `<p>${"long intro text here. ".repeat(10)}</p>`;

    it.each([
      ["<h2>\n  Breaking\n</h2><p>y</p>", "\nBreaking\ny\n…"],
      ["<h2>Big<br>Change</h2><p>y</p>", "\nBig Change\ny\n…"],
      ["<h2>unclosed<p>y</p>", "\nunclosed\ny\n…"],
    ])("finds the heading in %j", (html, tail) => {
      const text = htmlToText(intro + html, 60);
      expect(length(text)).toBeLessThanOrEqual(60);
      expect(text.endsWith(tail)).toBe(true);
    });

    it.each([
      "<h2> </h2><p>body</p>",
      "<pre><code># install\nnpm i</code></pre><p>tail</p>",
    ])("finds no heading in %j", (html) => {
      expect(htmlToText(intro + html, 60)).toBe(truncate(htmlToText(intro + html, 10_000), 60));
    });

    it("still finds real headings after code", () => {
      const text = htmlToText(`${intro}<pre># a</pre><h2>Real</h2><p>z</p>`, 60);
      expect(text.endsWith("\nReal\nz\n…")).toBe(true);
      expect(text).not.toContain("# a");
    });

    it("marks truncation even when the last kept line ends with an ellipsis", () => {
      const html = [
        "<h2>Intro</h2><p>first line</p>",
        `<p>${"second line of intro. ".repeat(3)}</p>`,
        "<h2>Next</h2><p>Stay tuned…</p>",
        `<p>${"omitted tail paragraph. ".repeat(3)}</p>`,
      ].join("");
      expect(htmlToText(html, 50)).toBe("Intro\nfirst line\nNext\nStay tuned…\n…");
    });

    it("cuts from the start when there are no headings", () => {
      const html = Array.from({ length: 50 }, (_, i) => `<p>paragraph ${i}</p>`).join("");
      expect(htmlToText(html, 100)).toBe(truncate(htmlToText(html, 10_000), 100));
    });

    it("returns everything when it fits", () => {
      expect(htmlToText("<h2>A</h2><p>b</p>", 100)).toBe("A\nb");
    });

    it("stays within every limit and marks the cut", () => {
      for (let max = 40; max < 600; max++) {
        const text = htmlToText(release, max);
        expect(length(text)).toBeLessThanOrEqual(max);
        expect(text.endsWith("…")).toBe(true);
      }
    });
  });

  it.each([
    ["日本語の本文です。".repeat(30), 50],
    ["😀👍🎉".repeat(40), 31],
    ["mixed 日本 😀 text ".repeat(20), 77],
  ])("truncates %j by code point", (text, max) => {
    const out = htmlToText(`<p>${text}</p>`, max);
    expect(length(out)).toBe(max);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(LONE_SURROGATE);
  });
});

describe("htmlToLine", () => {
  it.each([
    ["<p>Line\none</p><p>two</p>", "Line one two"],
    ["<h2>Title</h2> <em>x</em>", "Title x"],
    // Escaped tags are text, with no second unwrap as in GitHub bodies.
    ["&lt;Link&gt; prefetch", "<Link> prefetch"],
    ["a\u0001b", "ab"],
  ])("converts %j", (html, expected) => {
    expect(htmlToLine(html)).toBe(expected);
  });
});

describe("inlineHtmlToLine", () => {
  it.each([
    ["Newest <em>post</em> &amp; more", "Newest post & more"],
    ["Why <canvas> matters", "Why <canvas> matters"],
    ['<a href="/x">The</a> <dialog> <Strong>element</Strong>', "The <dialog> element"],
    ["&lt;b&gt;literal&lt;/b&gt;", "<b>literal</b>"],
    ["one<br/>two", "one two"],
    ["<section>kept</section>", "<section>kept</section>"],
  ])("converts %j", (html, expected) => {
    expect(inlineHtmlToLine(html)).toBe(expected);
  });
});

describe("plainTextToText", () => {
  it("keeps markup literal and normalizes lines", () => {
    expect(plainTextToText(" a &amp; <b>  c \r\n\r\n d ", 100)).toBe("a &amp; <b> c\nd");
  });

  it("cuts like an HTML body, keeping headings", () => {
    const text = ["Intro", "x".repeat(100), "# Breaking Changes", "y".repeat(100)].join("\n");
    const out = plainTextToText(text, 120);
    // The preamble gives way to the heading and its section, as in htmlToText.
    expect(out).toMatch(/^Intro\n# Breaking Changes\ny+…$/);
    expect(Array.from(out).length).toBeLessThanOrEqual(120);
  });
});
