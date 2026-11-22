// Adapted from listmonk's internal/i18n/i18n.go and cmd/i18n.go.
import { must } from "@/invariant";
import { languagePack } from "@/i18n/packs";

export class Translation {
  private readonly values: Readonly<Record<string, string>>;

  constructor(base: Readonly<Record<string, string>>, overlay?: Readonly<Record<string, string>>) {
    if (!Object.hasOwn(base, "_.code") || !Object.hasOwn(base, "_.name")) {
      throw new Error("Language data requires _.code and _.name");
    }
    this.values = Object.freeze(Object.assign(Object.create(null), base, overlay));
  }

  // The constructor requires both keys, and an overlay only adds to them.
  get code(): string {
    return must(this.values["_.code"], "language code");
  }

  get name(): string {
    return must(this.values["_.name"], "language name");
  }

  // Loading an overlay produces an independent, immutable translation instance.
  Load(overlay: Readonly<Record<string, string>>): Translation {
    return new Translation(this.values, overlay);
  }

  T(key: string): string {
    if (!Object.hasOwn(this.values, key)) {
      return key;
    }
    return singular(must(this.values[key], "translation"));
  }

  Ts(key: string, ...params: Array<string>): string {
    if (params.length % 2 !== 0) {
      return `${key}: Invalid arguments`;
    }
    if (!Object.hasOwn(this.values, key)) {
      return key;
    }
    let value = this.T(key);
    const budget = { remaining: 256 };
    for (let index = 0; index < params.length; index += 2) {
      // The argument count is even, so each name has its value.
      const replacement = this.resolve(must(params[index + 1], "argument"), new Set(), budget);
      value = value.replaceAll(`{${must(params[index], "argument name")}}`, () => replacement);
    }
    return value;
  }

  Tc(key: string, count: number): string {
    if (!Object.hasOwn(this.values, key)) {
      return key;
    }
    const value = must(this.values[key], "translation");
    if (count <= 1 || !value.includes("|")) {
      return singular(value);
    }
    const parts = value.split("|");
    return must(parts.length === 2 ? parts[1] : parts[0], "translation part").trim();
  }

  private resolve(value: string, active: Set<string>, budget: { remaining: number }): string {
    return value.replaceAll(/\{([a-z0-9-.]+)\}/gi, (match, key: string) => {
      if (budget.remaining <= 0 || active.has(key)) {
        return match;
      }
      budget.remaining--;
      if (!Object.hasOwn(this.values, key)) {
        return key;
      }
      const next = new Set(active);
      next.add(key);
      return this.resolve(this.T(key), next, budget);
    });
  }
}

function singular(value: string): string {
  return value.includes("|") ? must(value.split("|")[0], "translation part").trim() : value;
}

export function createTranslation(code = "en"): Translation {
  const english = languagePack("en");
  if (!english) {
    throw new Error("English language data is missing");
  }
  return new Translation(english, languagePack(code));
}
