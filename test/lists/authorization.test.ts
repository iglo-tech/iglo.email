import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { provisionApiUser } from "@/test/contract/owned";
import { startListFixture } from "@/test/lists/fixture";

test("live session grants, CSRF and in-flight body authorization", async () => {
  const f = await startListFixture();
  try {
    const credentials = await provisionApiUser(f.origin, f.admin);
    const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
    async function admin(path: string, method = "GET", body?: unknown) {
      const response = await fetch(`${f.origin}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: any }).data;
    }
    const list = await admin("/api/lists", "POST", { name: "session fixture" });
    const userRole = await admin("/api/roles/users", "POST", {
      name: "session role",
      permissions: [],
    });
    const listRole = await admin("/api/roles/lists", "POST", {
      name: "session list role",
      lists: [{ id: list.id, permissions: ["list:get", "list:manage"] }],
    });
    await admin("/api/users", "POST", {
      username: "session-fixture",
      name: "session fixture",
      email: "session@example.test",
      type: "user",
      status: "enabled",
      password_login: true,
      password: "fixture-password",
      user_role_id: userRole.id,
      list_role_id: listRole.id,
    });
    const page = await fetch(`${f.origin}/admin/login`),
      html = await page.text();
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)![1]!;
    const nonceCookie = page.headers
      .getSetCookie()
      .find((value) => value.startsWith("nonce="))!
      .split(";", 1)[0]!;
    const login = await fetch(`${f.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: nonceCookie },
      body: new URLSearchParams({
        username: "session-fixture",
        password: "fixture-password",
        nonce,
      }),
    });
    expect(login.status).toBe(302);
    const cookies = login.headers.getSetCookie();
    const session = cookies.find((value) => value.startsWith("session="))!.split(";", 1)[0]!;
    const csrf = cookies
      .find((value) => value.startsWith("csrf="))!
      .split(";", 1)[0]!
      .slice(5);
    const update = (extra: Record<string, string>) =>
      fetch(`${f.origin}/api/lists/${list.id}`, {
        method: "PUT",
        headers: { Cookie: session, "Content-Type": "application/json", ...extra },
        body: JSON.stringify({ name: "denied mutation" }),
      });
    const xmlUpdate = (extra: Record<string, string>) =>
      fetch(`${f.origin}/api/lists/${list.id}`, {
        method: "PUT",
        headers: { Cookie: session, "Content-Type": "application/xml", ...extra },
        body: `<List><Name>xml session update</Name><Tags>ok</Tags></List>`,
      });
    expect((await xmlUpdate({})).status).toBe(403);
    expect((await xmlUpdate({ "X-CSRF-Token": csrf, Origin: "http://foreign.test" })).status).toBe(
      403,
    );
    expect((await xmlUpdate({ "X-CSRF-Token": csrf, Origin: "http://fixture.test" })).status).toBe(
      200,
    );
    expect((await admin(`/api/lists/${list.id}`)).name).toBe("xml session update");
    expect((await update({})).status).toBe(403);
    expect((await update({ "X-CSRF-Token": csrf, Origin: "http://foreign.test" })).status).toBe(
      403,
    );
    expect(
      (await fetch(`${f.origin}/api/lists/${list.id}`, { headers: { Cookie: session } })).status,
    ).toBe(200);
    const payload = `<List><Name>late mutation</Name></List>`,
      cut = 8;
    const url = new URL(f.origin);
    const socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
    const result = new Promise<string>((resolve, reject) => {
      let output = "";
      socket.on("data", (chunk) => (output += chunk.toString()));
      socket.on("end", () => resolve(output));
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });
    socket.write(
      `PUT /api/lists/${list.id} HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${session}\r\nX-CSRF-Token: ${csrf}\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, cut)}`,
    );
    await admin(`/api/roles/lists/${listRole.id}`, "PUT", { name: "session list role", lists: [] });
    socket.end(payload.slice(cut));
    expect(await result).toContain(" 403 ");
    expect(
      (await fetch(`${f.origin}/api/lists/${list.id}`, { headers: { Cookie: session } })).status,
    ).toBe(403);
    expect((await admin(`/api/lists/${list.id}`)).name).toBe("xml session update");
  } finally {
    await f.close();
  }
}, 30_000);
