// The text/plain alternative's named references and lists (B135 item 8, D118): read through POST
// /api/tx and the loopback SMTP sink, so the message is the one a reader receives.
import { afterEach, expect, test } from "bun:test";
import { textPart } from "@/test/messaging/mime";
import { txFixture } from "@/test/tx/fixture";
import type { TxFixture } from "@/test/tx/fixture";

const fixtures: Array<TxFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});

/** The text/plain part of a transactional message whose HTML body is `html`. */
async function plain(html: string) {
  const f = await txFixture();
  fixtures.push(f);
  const template = await f.template(html, "Subject");
  const email = `l-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template });
  expect(response.status).toBe(200);
  return textPart(f.mailTo(email)[0]?.data ?? "") ?? "";
}

test("named references the HTML spec lists decode, including the uppercase markup names", async () => {
  expect(await plain("<p>&notin; &AMP; &amp; &copy; &LT;b&GT; &QUOT;x&QUOT;</p>")).toBe(
    '∉ & & © <b> "x"',
  );
  expect(await plain("<p>&alpha;&Omega; &lang;x&rang; &hearts;</p>")).toBe("αΩ ⟨x⟩ ♥");
});

test("a name the spec does not list is left as written, and a legacy name needs no semicolon", async () => {
  expect(await plain("<p>&NotAnEntity; &AMPx &COPY 1</p>")).toBe("&NotAnEntity; &x © 1");
});

test("an ordered list is numbered from one, and a start attribute sets its first number", async () => {
  expect(await plain("<ol><li>one</li><li>two</li><li>three</li></ol>")).toBe(
    "1. one\n2. two\n3. three",
  );
  expect(await plain('<ol start="5"><li>a</li><li>b</li></ol>')).toBe("5. a\n6. b");
  expect(await plain('<ol start="-1"><li>a</li><li>b</li></ol>')).toBe("-1. a\n0. b");
  // An invalid start is the default, as a browser reads it.
  expect(await plain('<ol start="x"><li>a</li></ol>')).toBe("1. a");
});

test("a nested list is indented two spaces, numbered on its own, and the outer count goes on", async () => {
  expect(await plain("<ol><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ol>")).toBe(
    "1. a\n\n  1. x\n  2. y\n\n2. b",
  );
  expect(await plain("<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>")).toBe(
    "- a\n\n  - b\n  - c\n\n- d",
  );
});

test("a text paragraph that starts with a number is text, not a list item", async () => {
  expect(await plain("<ol><li>one</li></ol><p>1. literal</p>")).toBe("1. one\n\n1. literal");
});
