// Language data comes from listmonk i18n/*.json at 6fcd95f32bb633d3a62a06c383c0b3322eecc898.
import lang0 from "@locale/ar.json";
import lang1 from "@locale/bg.json";
import lang2 from "@locale/ca.json";
import lang3 from "@locale/cs.json";
import lang4 from "@locale/cy.json";
import lang5 from "@locale/da.json";
import lang6 from "@locale/de.json";
import lang7 from "@locale/el.json";
import lang8 from "@locale/en.json";
import lang9 from "@locale/eo.json";
import lang10 from "@locale/es.json";
import lang11 from "@locale/fi.json";
import lang12 from "@locale/fr-CA.json";
import lang13 from "@locale/fr.json";
import lang14 from "@locale/he.json";
import lang15 from "@locale/hi.json";
import lang16 from "@locale/hr.json";
import lang17 from "@locale/hu.json";
import lang18 from "@locale/id.json";
import lang19 from "@locale/it.json";
import lang20 from "@locale/ja.json";
import lang21 from "@locale/ko.json";
import lang22 from "@locale/ml.json";
import lang23 from "@locale/nl.json";
import lang24 from "@locale/no.json";
import lang25 from "@locale/pl.json";
import lang26 from "@locale/pt-BR.json";
import lang27 from "@locale/pt.json";
import lang28 from "@locale/ro.json";
import lang29 from "@locale/ru.json";
import lang30 from "@locale/sk.json";
import lang31 from "@locale/sl.json";
import lang32 from "@locale/sv.json";
import lang33 from "@locale/tr.json";
import lang34 from "@locale/uk.json";
import lang35 from "@locale/vi.json";
import lang36 from "@locale/zh-CN.json";
import lang37 from "@locale/zh-TW.json";

// Static imports embed every pack in the standalone executable. They are private and immutable.
const packs: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  ar: Object.freeze(lang0),
  bg: Object.freeze(lang1),
  ca: Object.freeze(lang2),
  cs: Object.freeze(lang3),
  cy: Object.freeze(lang4),
  da: Object.freeze(lang5),
  de: Object.freeze(lang6),
  el: Object.freeze(lang7),
  en: Object.freeze(lang8),
  eo: Object.freeze(lang9),
  es: Object.freeze(lang10),
  fi: Object.freeze(lang11),
  "fr-CA": Object.freeze(lang12),
  fr: Object.freeze(lang13),
  he: Object.freeze(lang14),
  hi: Object.freeze(lang15),
  hr: Object.freeze(lang16),
  hu: Object.freeze(lang17),
  id: Object.freeze(lang18),
  it: Object.freeze(lang19),
  ja: Object.freeze(lang20),
  ko: Object.freeze(lang21),
  ml: Object.freeze(lang22),
  nl: Object.freeze(lang23),
  no: Object.freeze(lang24),
  pl: Object.freeze(lang25),
  "pt-BR": Object.freeze(lang26),
  pt: Object.freeze(lang27),
  ro: Object.freeze(lang28),
  ru: Object.freeze(lang29),
  sk: Object.freeze(lang30),
  sl: Object.freeze(lang31),
  sv: Object.freeze(lang32),
  tr: Object.freeze(lang33),
  uk: Object.freeze(lang34),
  vi: Object.freeze(lang35),
  "zh-CN": Object.freeze(lang36),
  "zh-TW": Object.freeze(lang37),
});

export function languagePack(code: string): Readonly<Record<string, string>> | undefined {
  return Object.hasOwn(packs, code) ? packs[code] : undefined;
}
