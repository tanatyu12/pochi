import { describe, expect, it } from "vitest";
import { LANGUAGES, findLanguage, localeOf } from "../../src/config/languages.js";
import { SourcesSchema } from "../../src/config/schema.js";

describe("findLanguage", () => {
  it("matches a name or an alias whatever its case", () => {
    expect(findLanguage("spanish")?.name).toBe("Spanish");
    expect(findLanguage(" Chinese (Simplified) ")?.name).toBe("Chinese (Simplified)");
    expect(findLanguage("中文")?.name).toBe("Chinese (Simplified)");
    expect(findLanguage("zh-TW")?.name).toBe("Chinese (Traditional)");
    expect(findLanguage("Français")?.name).toBe("French");
    expect(findLanguage("es")?.name).toBe("Spanish");
  });

  it("leaves other languages unlisted", () => {
    expect(findLanguage("Swahili")).toBeUndefined();
    expect(findLanguage("")).toBeUndefined();
    expect(findLanguage(undefined)).toBeUndefined();
  });

  it("gives every alias to one language only", () => {
    const keys = LANGUAGES.flatMap((l) => [l.name.toLowerCase(), ...l.aliases]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("localeOf", () => {
  it("is the language's Google News edition, or the English one", () => {
    expect(localeOf("Japanese")).toBe("ja-JP");
    expect(localeOf("korean")).toBe("ko-KR");
    expect(localeOf("Portuguese")).toBe("pt-BR");
    expect(localeOf("Swahili")).toBe("en-US");
  });

  it("is a locale sources.yml accepts", () => {
    const feeds = LANGUAGES.map((l) => ({ id: l.locale.toLowerCase(), type: "googlenews", query: "AI", locale: l.locale }));
    expect(SourcesSchema.safeParse({ version: 1, feeds }).success).toBe(true);
  });
});
