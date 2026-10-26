import { describe, expect, it } from "vitest";
import { collapseWhitespace, truncate, truncateUnits } from "../../src/util/text.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("collapseWhitespace", () => {
  it.each([
    ["  a \n\t b  ", "a b"],
    ["a\r\nb", "a b"],
    ["\n", ""],
  ])("collapses %j", (text, expected) => {
    expect(collapseWhitespace(text)).toBe(expected);
  });
});

describe("truncate", () => {
  it.each([
    ["abcde", 5, "abcde"],
    ["abcdef", 5, "abcd…"],
    ["ab   cdef", 5, "ab…"],
    ["日本語テキスト", 4, "日本語…"],
    ["😀😀😀", 3, "😀😀😀"],
    ["😀😀😀😀", 3, "😀😀…"],
    ["abc", 1, "…"],
    ["abc", 0, ""],
    ["abc", -1, ""],
    ["", 3, ""],
  ])("truncates %j to %d", (text, max, expected) => {
    expect(truncate(text, max)).toBe(expected);
    expect(truncate(text, max)).not.toMatch(LONE_SURROGATE);
  });
});

describe("truncateUnits", () => {
  it.each([
    [["a", "b", "c"], 3, "abc"],
    [["&amp;", "&amp;", "&amp;"], 15, "&amp;&amp;&amp;"],
    [["&amp;", "&amp;", "&amp;"], 14, "&amp;&amp;…"],
    [["&amp;", "&amp;"], 5, "…"],
    [["😀", "😀", "😀"], 5, "😀😀…"],
    [["a", " ", "b", "c"], 3, "a…"],
    [["a"], 0, ""],
  ])("cuts %j to %d", (units, max, expected) => {
    expect(truncateUnits(units, max)).toBe(expected);
    expect(truncateUnits(units, max).length).toBeLessThanOrEqual(Math.max(max, 0));
  });
});
