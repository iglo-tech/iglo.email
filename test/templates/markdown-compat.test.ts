// B104/B105/B106: ordinary Markdown renders as pinned. Each pinned line is a corpus document's SHA-256 of its
// HTML and byte length. B106 (D113) moved the pins from marked to Bun's Markdown API. Each pin that changed
// is equal to listmonk's goldmark output after the canonical comparison in test/templates/measure-markdown.ts
// (`compare`: no pin differs), and each output difference is listed in docs/design/07-api-and-ui.md.
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";
import { markdownCorpus } from "@/test/templates/markdown-corpus";
import { newsletter } from "@/test/templates/markdown-newsletter";

const pinned: string[] = [
  "fd6c83adc06e4baecc889e105f2b9f8d1a477c41ce71ac814a7f73f434cfe6d8 175",
  "3df31e0027c42e4339285098c4060924398959a798366a678e13d103e21586ef 118",
  "169d83a14c556f57cc937252b176c68843a30fe4e7fc085521a112f7ec6fafe9 115",
  "3f4c48254dbf0a0c8da7d431a4cf5beff39555dff82cf34849729eb09e689289 101",
  "3d69001687bc77f2150aa4c01d1c6731ca1ed7cb00e13e7b9ebffb2c68621f9f 48",
  "d62b85aa08f51bf9319637ee6159764622b2eba4c9ad728d7a9d62a94ef4a924 172",
  "c88641d4acc67423373ccd623563609963b9843f9858265a2a327ee73ff34415 167",
  "0e5585081f90fd9bce074e6d80498844cb289aaf34e4aaa90b38d1dc228605a7 93",
  "5455ac4c1906cd631c67a1a8419e8b43fb5a67243cf42cbf5f425648643a30bb 169",
  "27c89f517484d5954571f182646e31315c510e55b00620c5293384788c20171b 65",
  "bee426256a118925d91d499ad682a8a7a33b3b127192c081dedd4b458d0d7909 119",
  "faf1caa8fe75d4244b24c9dfa37739ddce8b4fb51b1eb183952d24367a4dfc33 61",
  "42b5a93d9e2d6141cd41d4eaa4cef9b23b75a3dea9acfab69036c0ef87ceb23e 175",
  "fc36f0576d3bd2a1e0cf206af22d1b899468f7ce2bd49ea8fd692afd0d06162d 85",
  "46c3ba662932b51beaf3201254c1031de278a067399702e68145c5051cdbbcf5 238",
  "59b43fc180620b3ae64bb024ee9bb5d7d8d40934ccdbcb196755a1c94d5f8620 48",
  "b32a28af433132332489cf639278969c22b2697ffe484629be6e62558399a2b5 106",
  "3b085deae12de30028f46f4cee995e9dfa95c9e7c3dcd5e88ca6327175d36564 61",
  "b5bf3ce2868319a448b08c83dd1f1b98ff87ba570b9446c21ba899b4ff339761 129",
  "9e800395748776e213c511c0c6b8d35fd957348227ec3b9dd2d563f9a0e6d910 51",
  "27390fd0e03e265deb51409b797e76a281397b438e9c261c65553bcf3e30b2a2 112",
  "ab880af9e78fa593ca07b03e415252d26406f3d4a259d6b56fba1b369416cfaa 100",
  "1334bc70ff9c7bec3977045cea8c19f4ecb2203e423af19235561bc0a8c470f8 83",
  "528160e8d923db796d9c4b759c875c5ff361a44c0e7d18af7149d75c4eb6b012 1555",
  "cc8380b32ba07a2a9a23d473170028224ec03a5aa06804b2d2a1fd8fa963e3b5 2458",
  "0af3c8fc946f06ec625b17ccf6720c2e3354816cfaa94aba59168dd3e8410516 34",
  "b84128335c9a1351c968fd46377591cea92495402916cd6b420e1d3b45474890 140",
  "1a055cd96ec9e843d0d3f831c118d607b753119a0875eb270efd1c6f9d842389 51",
  "7f01e2e20749c5b1a2910ae582cd66b6c3d20432d56088504bf808bfd4e70280 67",
  "cafb8cf43b0cb903940822e8d30116db181b6c8d61bbd64cbc9796404257d0df 75",
  "08b827f41ece82870357971ca6b0a1c148d2e8c63ce74526b2ed9c27dd328861 105",
  "dfa6aa92fee3f9ed7c4e8eceed7fd4418085f44acd41fa621ece00b8bdda1ae3 115",
  "ed556d7298d593ca3943557a8a4babd04515a955179b4e4ce6c4b68880141e62 150",
];

test("ordinary Markdown renders as pinned", async () => {
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

// B105 (D112), pinned again by B106: realistic newsletters of 4, 16 and 64 KiB, the largest body the source
// limit admits. Each line is the SHA-256 and byte length of the HTML this renderer produces.
const newsletterPinned = [
  ["4", "b6751f21c9726be5138c9677c38f186a26f5ca43891231c278af85f7944bea70", 4975],
  ["16", "7f231e39ed737d047baeb2da6c887f02631d35ebe0e8ea3243c0dbfb5ae1258f", 21395],
  ["64", "dd34f01cea6c48937cdc6360997062bb518929c56efd6792e0985b48bd8a08d4", 89054],
] as const;

test("realistic newsletters render exactly as pinned, up to 64 KiB", async () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  for (const [kib, sha, length] of newsletterPinned) {
    const { source } = newsletter(Number(kib));
    const { body } = await renderer.render({ body: source, data: "{}", mode: "markdown" });
    expect([kib, createHash("sha256").update(body).digest("hex"), Buffer.byteLength(body)]).toEqual(
      [kib, sha, length],
    );
  }
});
