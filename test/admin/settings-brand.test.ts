// B129 (D127): the brand settings through the settings API. The accent is hex only, the font is a
// fixed system choice or a validated Google Fonts family name, and the header is one of four modes.
// A rejected value is a 400 that changes nothing. The admin page names the source of the software,
// and the sign-in page loads a Google font only when one is set. Public boundaries only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, api, get, login } from "@/test/admin/support";
import type { Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";

let f: Fixture;
let cookie = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterAll(() => f.close());

async function setting(key: string): Promise<unknown> {
  const res = await get(f, "/api/settings", cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data[key];
}

async function put(key: string, value: string) {
  return api(f, cookie, `/api/settings/${key}`, "PUT", value);
}

test("the brand is the built-in blue, the system sans font and the automatic header by default", async () => {
  expect(await setting("appearance.brand.accent")).toBe("");
  expect(await setting("appearance.brand.font")).toBe("system-sans");
  expect(await setting("appearance.brand.header")).toBe("auto");
});

test("a hex accent is saved in either length, in any case, and an empty one is the default", async () => {
  for (const value of ["#0AF", "#0055D4", "#abcdef"]) {
    expect((await put("appearance.brand.accent", value)).status).toBe(200);
    expect(await setting("appearance.brand.accent")).toBe(value);
  }
  expect((await put("appearance.brand.accent", "")).status).toBe(200);
  expect(await setting("appearance.brand.accent")).toBe("");
});

test("an accent that is not a hex colour is refused and nothing is saved", async () => {
  expect((await put("appearance.brand.accent", "#0055d4")).status).toBe(200);
  for (const value of [
    "red",
    "#12",
    "#12345",
    "#gggggg",
    "#0055d4;background:red",
    "url(https://evil.example.test/x.css)",
    "#0055d4}body{display:none",
    "expression(alert(1))",
  ]) {
    const refused = await put("appearance.brand.accent", value);
    expect(refused.status).toBe(400);
    expect(await setting("appearance.brand.accent")).toBe("#0055d4");
  }
  expect((await put("appearance.brand.accent", "")).status).toBe(200);
});

test("the font takes a fixed system choice or a Google Fonts family name, and nothing else", async () => {
  for (const value of ["system-serif", "system-mono", "system-sans", "Lora", "Noto Sans JP"]) {
    expect((await put("appearance.brand.font", value)).status).toBe(200);
    expect(await setting("appearance.brand.font")).toBe(value);
  }
  // A family name of 60 characters is the longest accepted.
  const longest = `A${"b".repeat(59)}`;
  expect((await put("appearance.brand.font", longest)).status).toBe(200);
  expect(await setting("appearance.brand.font")).toBe(longest);
  expect((await put("appearance.brand.font", "system-sans")).status).toBe(200);
});

test("a font that is not a fixed choice or a plain family name is refused and nothing is saved", async () => {
  expect((await put("appearance.brand.font", "Lora")).status).toBe(200);
  for (const value of [
    "system-cursive",
    "Lora;}body{display:none",
    "Lora-Bold",
    "Lora!",
    "Noto  Sans",
    "1Lora",
    "<script>x</script>",
    `A${"b".repeat(60)}`,
    "https://fonts.example.test/x",
  ]) {
    const refused = await put("appearance.brand.font", value);
    expect(refused.status).toBe(400);
    expect(await setting("appearance.brand.font")).toBe("Lora");
  }
  expect((await put("appearance.brand.font", "system-sans")).status).toBe(200);
});

test("each header mode is saved, and any other header is refused", async () => {
  for (const value of ["auto", "logo", "name", "logo_and_name"]) {
    expect((await put("appearance.brand.header", value)).status).toBe(200);
    expect(await setting("appearance.brand.header")).toBe(value);
  }
  expect((await put("appearance.brand.header", "middle")).status).toBe(400);
  expect((await put("appearance.brand.header", "logo,name")).status).toBe(400);
  expect(await setting("appearance.brand.header")).toBe("logo_and_name");
  expect((await put("appearance.brand.header", "auto")).status).toBe(200);
});

test("the admin sidebar links the source of the software", async () => {
  const res = await get(f, "/admin", cookie);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('href="https://github.com/iglo-tech/iglo.email"');
  expect(html).toContain("Source code");
});

test("the sign-in page loads a Google font's stylesheet only when the brand names one", async () => {
  const system = await fetch(`${f.origin}/admin/login`);
  expect(system.status).toBe(200);
  expect(system.headers.get("Content-Security-Policy")).not.toContain("fonts.googleapis.com");

  expect((await put("appearance.brand.font", "Lora")).status).toBe(200);
  const google = await fetch(`${f.origin}/admin/login`);
  expect(google.status).toBe(200);
  const policy = google.headers.get("Content-Security-Policy") ?? "";
  expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  expect(policy).toContain("font-src 'self' https://fonts.gstatic.com");
  expect(await (await fetch(`${f.origin}/admin/login`)).text()).toContain(
    "https://fonts.googleapis.com/css2?family=Lora",
  );
  expect((await put("appearance.brand.font", "system-sans")).status).toBe(200);
});
