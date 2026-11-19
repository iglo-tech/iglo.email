// B104: ordinary Markdown renders byte-identically before and after the link-scan fix. Each pinned
// line is a corpus document's SHA-256 of its HTML and byte length, recorded on origin/main.
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";
import { markdownCorpus } from "@/test/templates/markdown-corpus";
import { newsletter } from "@/test/templates/markdown-newsletter";

const pinned: string[] = [
  "1931c578fa1ff4dccd293ebfc73727ae126bd5a9b0f0ffbca01525aeb1d3d0fb 171",
  "8c359ce7cf2b68621838b8fc786b86df5c243103d1d13f9391db5c3f9ce60525 117",
  "750d320b806874e446a09a77b72161888011d5d89603ef4f62d887bfbe92ba23 113",
  "3f4c48254dbf0a0c8da7d431a4cf5beff39555dff82cf34849729eb09e689289 101",
  "3d69001687bc77f2150aa4c01d1c6731ca1ed7cb00e13e7b9ebffb2c68621f9f 48",
  "a6474f6fccf2ea6d3e09e5128f490626ad0a582065ce646afbf0576b61ecf248 176",
  "c88641d4acc67423373ccd623563609963b9843f9858265a2a327ee73ff34415 167",
  "0e5585081f90fd9bce074e6d80498844cb289aaf34e4aaa90b38d1dc228605a7 93",
  "d96da6617ce13ccb7e310ef73b323a1fbc1268f2d6814c260fd75acb7fb6cfe6 208",
  "3675fa450a0b8f459b32f486222937aec1e584bbaf3a42b91ddaf69899302c80 59",
  "bee426256a118925d91d499ad682a8a7a33b3b127192c081dedd4b458d0d7909 119",
  "faf1caa8fe75d4244b24c9dfa37739ddce8b4fb51b1eb183952d24367a4dfc33 61",
  "e692d15b82e47dfef5251f6652c5ddebea794fb850d39f616037452aa587200d 169",
  "fc36f0576d3bd2a1e0cf206af22d1b899468f7ce2bd49ea8fd692afd0d06162d 85",
  "94e9ee04a4a225ace7010cea7a881d554edfc3c2b9a3528af61fbf166ff917bc 139",
  "df2325724aaf7578387496209640185db59e728f5aac9d12e3e3af78b0e04081 44",
  "200f6e2db0b646bec47228a1303e03f4a0a7386df3742af37270c33284fa2cc6 142",
  "3b085deae12de30028f46f4cee995e9dfa95c9e7c3dcd5e88ca6327175d36564 61",
  "c4440d8d0d2dfafe60c2b37e8672060eb733119952a8f2c21b390f9b6135b21a 127",
  "9e800395748776e213c511c0c6b8d35fd957348227ec3b9dd2d563f9a0e6d910 51",
  "27390fd0e03e265deb51409b797e76a281397b438e9c261c65553bcf3e30b2a2 112",
  "ab880af9e78fa593ca07b03e415252d26406f3d4a259d6b56fba1b369416cfaa 100",
  "1334bc70ff9c7bec3977045cea8c19f4ecb2203e423af19235561bc0a8c470f8 83",
  "528160e8d923db796d9c4b759c875c5ff361a44c0e7d18af7149d75c4eb6b012 1555",
  "cc8380b32ba07a2a9a23d473170028224ec03a5aa06804b2d2a1fd8fa963e3b5 2458",
  "b810e8b8870c26ed260a11fdcc5547c9a52bad3d48b427fce762f5aea6908e70 42",
  "542b93924673e4c00dfa08dbd37174508010f865890f6dd6eec41c4d3114a242 144",
  "1a055cd96ec9e843d0d3f831c118d607b753119a0875eb270efd1c6f9d842389 51",
  "7f01e2e20749c5b1a2910ae582cd66b6c3d20432d56088504bf808bfd4e70280 67",
  "98f33411107342f5e6a38201536cef9041927a93c8e119d4ce809e351a609f10 72",
  "08b827f41ece82870357971ca6b0a1c148d2e8c63ce74526b2ed9c27dd328861 105",
  "dfa6aa92fee3f9ed7c4e8eceed7fd4418085f44acd41fa621ece00b8bdda1ae3 115",
  "e00e9eeaca494d0d671faf5578d278445379ae91ed1c787cd6538cbb9149e782 158",
];

test("ordinary Markdown renders exactly as it did before the link-scan fix", async () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  expect(markdownCorpus.length).toBe(pinned.length);
  const actual: string[] = [];
  for (const body of markdownCorpus) {
    try {
      const { body: html } = await renderer.render({ body, data: "{}", mode: "markdown" });
      actual.push(`${createHash("sha256").update(html).digest("hex")} ${Buffer.byteLength(html)}`);
    } catch (error) {
      actual.push(`refused: ${(error as Error).message}`);
    }
  }
  expect(actual).toEqual(pinned);
});

// B105 (D112): realistic newsletters of 4, 16, 64 and 256 KiB (the campaign path, which is where the
// 256 KiB limit applies). Each line is the SHA-256 and byte length of the HTML this renderer produces;
// the constructs and their differences from goldmark are listed in docs/perf/B105-markdown-cost.md.
const newsletterPinned = [
  ["4", "179337a65308a865dac3b0fe5e60cd1c5f1448ea174aac068d3f258846909b99", 5182],
  ["16", "6082356751e98104d324c3c0bccc224039dbd7c95a870340cf70ce608dcfd3cc", 22282],
  ["64", "26f2052d0dcdd88e235edeb62bb6c6f711ee1d540129cc4a8f9563793bb6a19e", 92759],
  ["256", "71ada8efd3be1362a261a922a21a5b5558af82f109f679d00d090cc790c61da0", 374608],
] as const;

test("realistic newsletters render exactly as pinned, up to 256 KiB", () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  for (const [kib, sha, length] of newsletterPinned) {
    const { source } = newsletter(Number(kib));
    const { body } = renderer
      .compile({ body: source, mode: "markdown", campaign: true })
      .renderSync("{}");
    expect([kib, createHash("sha256").update(body).digest("hex"), Buffer.byteLength(body)]).toEqual(
      [kib, sha, length],
    );
  }
});
