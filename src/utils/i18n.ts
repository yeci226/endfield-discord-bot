import en from "../assets/languages/en";
import tw from "../assets/languages/tw";

const langs: Record<string, any> = { en, tw };

export function createTranslator(lang: string) {
  const selectedLang = langs[lang] ? lang : "en";
  const content = langs[selectedLang];

  const tr = function tr(key: string, options?: any, ...args: any[]) {
    let str = content[key] ?? langs["en"][key] ?? key;

    if (typeof str === "function") return str(options, ...args);
    if (typeof str !== "string") return str;

    if (options && typeof options === "object") {
      for (const [key, value] of Object.entries(options)) {
        str = str.replace(new RegExp(`<${key}>`, "g"), String(value));
      }
    }

    if (args.length > 0) {
      for (let i = 0; i < args.length; i++) {
        str = str.replace(new RegExp(`%${i}%`, "g"), String(args[i]));
        str = str.replace("%s", String(args[i]));
      }
    }

    return str;
  };

  (tr as any).lang = selectedLang;
  return tr;
}

/**
 * Converts Discord locale to i18n language code
 */
export function toI18nLang(locale: string): string {
  if (locale === "zh-TW" || locale === "zh-HK") return "tw";
  if (locale === "zh-CN") return "tw"; // Endfield uses Traditional Chinese for now or fallback to tw
  return "en";
}
