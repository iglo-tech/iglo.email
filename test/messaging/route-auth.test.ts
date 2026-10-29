// Real settings SMTP route with the user fixture's body-read barrier and loopback-only SMTP.
import { afterEach, expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { startUserFixture } from "@/test/users/fixture";
import { defaultAuthPolicy } from "@/users/auth";

type Fixture = Awaited<ReturnType<typeof startUserFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function login(f: Fixture, username: string, password: string) {
  const page = await fetch(`${f.origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1];
  const cookie = page.headers
    .getSetCookie()
    .find((c) => c.startsWith("nonce="))
    ?.split(";")[0];
  if (!nonce || !cookie) throw new Error("missing login nonce");
  const response = await fetch(`${f.origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password, nonce }),
  });
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith("session="))?.split(";")[0];
  const csrf = cookies.find((c) => c.startsWith("csrf="))?.split(";")[0];
  if (!session || !csrf) throw new Error("login failed");
  return { cookie: `${session}; ${csrf}`, csrf: csrf.slice(5) };
}
async function request(
  f: Fixture,
  session: { cookie: string; csrf: string },
  path: string,
  method: string,
  body?: unknown,
) {
  return fetch(`${f.origin}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function peer(hold = false) {
  let count = 0;
  let ready!: () => void;
  const four = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    count++;
    if (count === 4) ready();
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (hold) return;
    socket.write("220 fixture ESMTP\r\n");
    let pending = "",
      data = false;
    socket.on("data", (part) => {
      pending += part.toString();
      for (;;) {
        const end = pending.indexOf("\r\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          }
        } else if (/^EHLO/i.test(line)) socket.write("250 fixture\r\n");
        else if (/^DATA/i.test(line)) {
          data = true;
          socket.write("354 send\r\n");
        } else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("missing port");
  return {
    port: addr.port,
    four,
    count: () => count,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const smtpBody = (port: number) =>
  JSON.stringify({
    email: "recipient@example.test",
    host: "127.0.0.1",
    port,
    tls_type: "none",
    auth_protocol: "none",
  });

for (const change of ["disabled", "deleted", "grant", "explicit"] as const) {
  test(`held SMTP body denies ${change} before a connection`, async () => {
    const f = await startUserFixture(defaultAuthPolicy, true, true, undefined, true);
    fixtures.push(f);
    const smtp = await peer();
    try {
      const admin = await login(f, f.admin.user, f.admin.password);
      const name = `m21-${change}`;
      const roleRes = await request(f, admin, "/api/roles/users", "POST", {
        name,
        permissions: ["settings:manage"],
      });
      const role = ((await roleRes.json()) as { data: { id: number } }).data.id;
      const input = {
        username: name,
        email: `${name}@example.test`,
        type: "user",
        status: "enabled",
        password_login: true,
        password: "fixture-user-password",
        user_role_id: role,
      };
      const created = await request(f, admin, "/api/users", "POST", input);
      const user = ((await created.json()) as { data: { id: number } }).data;
      const human = await login(f, name, input.password);
      const payload = smtpBody(smtp.port),
        split = Math.floor(payload.length / 2),
        url = new URL(f.origin);
      const socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
      const response = new Promise<string>((resolve, reject) => {
        let result = "";
        socket.on("data", (part) => (result += part.toString()));
        socket.on("end", () => resolve(result));
        socket.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const explicit =
        change === "explicit" ? `Authorization: Basic ${btoa("wrong:wrong")}\r\n` : "";
      socket.write(
        `POST /api/settings/smtp/test HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${human.cookie}\r\nX-CSRF-Token: ${human.csrf}\r\n${explicit}X-M12-Gated-Body: yes\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, split)}`,
      );
      if (change === "explicit") {
        // Explicit bad credentials are rejected by middleware before body consumption.
        socket.end(payload.slice(split));
      } else {
        await f.bodyEntered;
        const action =
          change === "grant"
            ? await request(f, admin, `/api/roles/users/${role}`, "PUT", { name, permissions: [] })
            : change === "deleted"
              ? await request(f, admin, `/api/users/${user.id}`, "DELETE")
              : await request(f, admin, `/api/users/${user.id}`, "PUT", {
                  ...input,
                  password: "",
                  status: "disabled",
                });
        expect(action.status).toBe(200);
        socket.end(payload.slice(split));
      }
      expect(await response).toContain(" 403 ");
      expect(smtp.count()).toBe(0);
    } finally {
      await smtp.close();
    }
  });
}

test("SMTP route requires cookie CSRF and same origin; API credentials work without cookies", async () => {
  const f = await startUserFixture(defaultAuthPolicy, true, true, undefined, true);
  fixtures.push(f);
  const smtp = await peer();
  try {
    const admin = await login(f, f.admin.user, f.admin.password);
    const headers = { cookie: admin.cookie, "content-type": "application/json" };
    const send = (extra: Record<string, string>) =>
      fetch(`${f.origin}/api/settings/smtp/test`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: smtpBody(smtp.port),
      });
    expect((await send({})).status).toBe(403);
    expect((await send({ "x-csrf-token": "wrong" })).status).toBe(403);
    expect(
      (await send({ "x-csrf-token": admin.csrf, origin: "http://foreign.invalid" })).status,
    ).toBe(403);
    expect(smtp.count()).toBe(0);
    expect((await send({ "x-csrf-token": admin.csrf, origin: "http://fixture.test" })).status).toBe(
      200,
    );
    const created = await request(f, admin, "/api/users", "POST", {
      username: "m21-api",
      type: "api",
      status: "enabled",
      user_role_id: 1,
    });
    const api = ((await created.json()) as { data: { password: string } }).data;
    const response = await fetch(`${f.origin}/api/settings/smtp/test`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`m21-api:${api.password}`)}`,
        "content-type": "application/json",
      },
      body: smtpBody(smtp.port),
    });
    expect(response.status).toBe(200);
    expect(smtp.count()).toBe(2);
  } finally {
    await smtp.close();
  }
});

test("SMTP capacity releases after absolute timeout, malformed input and shutdown", async () => {
  const f = await startUserFixture(defaultAuthPolicy, true, true, undefined, true);
  fixtures.push(f);
  const held = await peer(true);
  const healthy = await peer();
  try {
    const admin = await login(f, f.admin.user, f.admin.password);
    const send = (port: number, csrf = admin.csrf) =>
      fetch(`${f.origin}/api/settings/smtp/test`, {
        method: "POST",
        headers: { cookie: admin.cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: smtpBody(port),
      });
    const pending = Array.from({ length: 4 }, () => send(held.port));
    await held.four;
    expect((await send(held.port)).status).toBe(429);
    expect(held.count()).toBe(4);
    f.persisted.clock.advance(10000);
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: "SMTP test outcome is unknown." });
    }
    expect((await send(healthy.port, "wrong")).status).toBe(403);
    const invalid = await fetch(`${f.origin}/api/settings/smtp/test`, {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "x-csrf-token": admin.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "recipient@example.test", host: "", port: 0 }),
    });
    expect(invalid.status).toBe(400);
    expect((await send(healthy.port)).status).toBe(200);
    await f.closeMessaging();
    const closed = await send(healthy.port);
    expect(closed.status).toBe(500);
    expect(await closed.json()).toEqual({ message: "SMTP test failed." });
    expect(healthy.count()).toBe(1);
  } finally {
    await held.close();
    await healthy.close();
  }
});
