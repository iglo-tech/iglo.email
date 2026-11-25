// B150a (15-external-sources section 7, D170): the `first_name` Liquid filter, observed through
// POST /api/tx into the loopback SMTP sink. The first word when it starts with a letter, holds no
// `@` and is at most 24 characters; otherwise empty, so `default` supplies the greeting.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { txFixture } from "@/test/tx/fixture";
import type { TxFixture } from "@/test/tx/fixture";

let f: TxFixture;
beforeAll(async () => {
  f = await txFixture();
});
afterAll(async () => {
  await f?.close();
});

async function greet(name: unknown): Promise<string> {
  const template = await f.template(`<p>[{{ data.name | first_name | default: "there" }}]</p>`);
  const email = `n-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({
    subscriber_emails: [email],
    template_id: template,
    data: { name },
  });
  expect(response.status).toBe(200);
  const raw = f.mailTo(email)[0]?.data ?? "";
  const bytes = raw
    .slice(raw.indexOf("\r\n\r\n") + 4)
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  const text = Buffer.from(bytes, "latin1").toString("utf-8");
  return /\[([^\]]*)\]/.exec(text)?.[1] ?? "<no greeting>";
}

test("first_name: the first word of a name", async () => {
  expect(await greet("Ada Lovelace")).toBe("Ada");
  expect(await greet("  Grace\tBrewster Hopper ")).toBe("Grace");
  expect(await greet("Zoë")).toBe("Zoë");
  expect(await greet("Łukasz Nowak")).toBe("Łukasz");
  expect(await greet("Ólafur Arnalds")).toBe("Ólafur");
  // Exactly 24 characters (code points) passes.
  expect(await greet(`A${"b".repeat(23)} Smith`)).toBe(`A${"b".repeat(23)}`);
});

test("first_name: empty, so the default greets, for anything that is not a first name", async () => {
  for (const name of [
    "",
    "   ",
    null,
    "ada@example.com",
    "ada@example.com Lovelace",
    "a@b",
    "123 Main",
    "_user",
    "(Ada)",
    "😀 Ada",
    `A${"b".repeat(24)}`,
    42,
    true,
    ["Ada"],
    { first: "Ada" },
  ]) {
    expect(await greet(name)).toBe("there");
  }
});

test("first_name takes no argument: a template that passes one is refused at save", async () => {
  const response = await f.json("/api/templates", "POST", {
    name: "first-name-arg",
    type: "tx",
    subject: "s",
    body: "{{ data.name | first_name: 2 }}",
  });
  expect(response.status).toBe(400);
});
