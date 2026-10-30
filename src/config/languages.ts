/**
 * The summary languages init offers, each with the Google News edition its searches use. The name
 * is what context.yml holds and the prompts read; any other language still works, typed as is.
 */
export const LANGUAGES = [
  { name: "English", native: "English", locale: "en-US", aliases: ["en"] },
  { name: "Japanese", native: "日本語", locale: "ja-JP", aliases: ["ja", "日本語"] },
  {
    name: "Chinese (Simplified)",
    native: "简体中文",
    locale: "zh-CN",
    aliases: ["chinese", "zh", "zh-cn", "zh-hans", "中文", "简体中文"],
  },
  { name: "Chinese (Traditional)", native: "繁體中文", locale: "zh-TW", aliases: ["zh-tw", "zh-hant", "繁體中文"] },
  { name: "Spanish", native: "Español", locale: "es-ES", aliases: ["es", "español"] },
  { name: "French", native: "Français", locale: "fr-FR", aliases: ["fr", "français"] },
  { name: "German", native: "Deutsch", locale: "de-DE", aliases: ["de", "deutsch"] },
  { name: "Portuguese", native: "Português", locale: "pt-BR", aliases: ["pt", "pt-br", "português", "portuguese (brazil)"] },
  { name: "Korean", native: "한국어", locale: "ko-KR", aliases: ["ko", "한국어"] },
] as const;

export type Language = (typeof LANGUAGES)[number];

/** The listed language a name or alias stands for, whatever its case. */
export function findLanguage(value: string | undefined): Language | undefined {
  const key = value?.trim().toLowerCase();
  if (!key) return undefined;
  return LANGUAGES.find((l) => l.name.toLowerCase() === key || (l.aliases as readonly string[]).includes(key));
}

// Google News editions by the summary language; the rest search the English one.
export function localeOf(language: string): string {
  return findLanguage(language)?.locale ?? "en-US";
}
