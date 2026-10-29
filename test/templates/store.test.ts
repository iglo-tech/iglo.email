// Test-only campaign owner supplies references through HTTP; template operations use production routes.
import { expect, test } from "bun:test";
import { provisionApiUser } from "@/test/contract/owned";
import { startTemplateFixture } from "@/test/templates/fixture";

test("primary references move to default, nullable archive references clear", async () => {
  const f = await startTemplateFixture();
  try {
    const credential = await provisionApiUser(f.origin, f.admin),
      authorization = `Basic ${btoa(`${credential.user}:${credential.token}`)}`;
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${f.origin}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const created = await call("/api/templates", "POST", {
      name: "layout",
      type: "campaign",
      body: "<main>{{ content | raw }}</main>",
    });
    expect(created.status).toBe(200);
    const row = ((await created.json()) as { data: { id: number } }).data;
    expect((await call("/fixture/campaign", "POST", { template: String(row.id) })).status).toBe(
      200,
    );
    expect((await call("/fixture/history", "POST", { template: String(row.id) })).status).toBe(200);
    expect((await call(`/api/templates/${row.id}`, "DELETE")).status).toBe(200);
    expect((await (await call("/fixture/campaign")).json()).data).toEqual({
      primary: "1",
      archive: null,
    });
    expect((await (await call("/fixture/history")).json()).data).toEqual({
      sequence: null,
      send: null,
    });
  } finally {
    await f.close();
  }
}, 30000);

test("historical missing default is not reseeded, and high IDs retain exact wire values", async () => {
  const f = await startTemplateFixture();
  try {
    const credential = await provisionApiUser(f.origin, f.admin),
      authorization = `Basic ${btoa(`${credential.user}:${credential.token}`)}`;
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${f.origin}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await call("/fixture/clear-default", "POST");
    await call("/fixture/initialize", "POST");
    const before = (await (await call("/api/templates")).json()).data;
    expect(before.length).toBe(3);
    expect(before.some((x: { is_default: boolean }) => x.is_default)).toBe(false);
    expect((await call("/api/templates/2", "DELETE")).status).toBe(400);
    expect((await call("/api/templates/1/default", "PUT")).status).toBe(200);
    await call("/fixture/sequence", "POST");
    const response = await call("/api/templates", "POST", {
      name: "large ID",
      type: "tx",
      subject: "s",
      body: "b",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/"id":9007199254740993[,}]/);
    expect((await call("/api/templates/9007199254740993")).status).toBe(200);
    expect((await call("/api/templates/9007199254740993", "DELETE")).status).toBe(200);
  } finally {
    await f.close();
  }
}, 30000);

test("only real transactional unsubscribe references generate safe attention diagnostics", async () => {
  const f = await startTemplateFixture();
  try {
    const credential = await provisionApiUser(f.origin, f.admin),
      authorization = `Basic ${btoa(`${credential.user}:${credential.token}`)}`;
    const post = (body: string) =>
      fetch(`${f.origin}/api/templates`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "synthetic-canary", type: "tx", subject: "s", body }),
      });
    expect((await post("{% comment %}{{ unsubscribe_url }}{% endcomment %}")).status).toBe(200);
    expect((await (await fetch(`${f.origin}/fixture/diagnostics`)).json()).data).toEqual([]);
    expect((await post("{{ unsubscribe_url }}")).status).toBe(200);
    const diagnostics = (await (await fetch(`${f.origin}/fixture/diagnostics`)).json())
      .data as string[];
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]).not.toContain("synthetic-canary");
  } finally {
    await f.close();
  }
}, 30000);

for (const operation of ["save", "preview"] as const)
  for (const change of ["role", "disabled", "deleted"] as const)
    test(`held ${operation} input cannot outlive ${change} revocation`, async () => {
      const { createConnection } = await import("node:net");
      const f = await startTemplateFixture();
      try {
        const admin = await provisionApiUser(f.origin, f.admin),
          authorization = `Basic ${btoa(`${admin.user}:${admin.token}`)}`;
        const request = (path: string, method = "GET", body?: unknown) =>
          fetch(`${f.origin}${path}`, {
            method,
            headers: {
              authorization,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const name = `held-${crypto.randomUUID()}`,
          permission = operation === "save" ? "templates:manage" : "templates:get";
        const roleResponse = await request("/api/roles/users", "POST", {
          name,
          permissions: [permission],
        });
        expect(roleResponse.status).toBe(200);
        const role = (await roleResponse.json()).data;
        const userResponse = await request("/api/users", "POST", {
          username: name,
          type: "api",
          status: "enabled",
          user_role_id: role.id,
        });
        expect(userResponse.status).toBe(200);
        const user = (await userResponse.json()).data;
        const heldAuth = `Basic ${btoa(`${name}:${user.password}`)}`;
        const payload =
          operation === "save"
            ? JSON.stringify({ name: "held-write", type: "tx", subject: "subject", body: "body" })
            : "template_type=campaign&body=%7B%7B+content+%7C+raw+%7D%7D";
        const path = operation === "save" ? "/api/templates" : "/api/templates/preview";
        const contentType =
          operation === "save" ? "application/json" : "application/x-www-form-urlencoded";
        const address = new URL(f.origin);
        const socket = createConnection({ host: "127.0.0.1", port: Number(address.port) });
        const response = new Promise<string>((resolve, reject) => {
          let output = "";
          socket.on("data", (chunk) => (output += chunk.toString()));
          socket.on("end", () => resolve(output));
          socket.on("error", reject);
        });
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        socket.write(
          `POST ${path} HTTP/1.1\r\nHost: ${address.host}\r\nAuthorization: ${heldAuth}\r\nContent-Type: ${contentType}\r\nX-M18-Gated-Body: yes\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, 5)}`,
        );
        await f.bodyEntered;
        const revoked =
          change === "role"
            ? await request(`/api/roles/users/${role.id}`, "PUT", { name, permissions: [] })
            : change === "deleted"
              ? await request(`/api/users/${user.id}`, "DELETE")
              : await request(`/api/users/${user.id}`, "PUT", {
                  username: name,
                  type: "api",
                  status: "disabled",
                  user_role_id: role.id,
                });
        expect(revoked.status).toBe(200);
        socket.end(payload.slice(5));
        expect(await response).toContain(" 403 ");
        const rows = (await (await request("/api/templates?query=held-write")).json()).data;
        expect(rows).toEqual([]);
      } finally {
        await f.close();
      }
    }, 30000);

for (const operation of ["save", "preview"] as const)
  test(`held ${operation} input cannot outlive logout`, async () => {
    const { createConnection } = await import("node:net");
    const f = await startTemplateFixture();
    try {
      const admin = await provisionApiUser(f.origin, f.admin),
        authorization = `Basic ${btoa(`${admin.user}:${admin.token}`)}`;
      const request = (path: string, method = "GET", body?: unknown) =>
        fetch(`${f.origin}${path}`, {
          method,
          headers: {
            authorization,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const name = `held-human-${crypto.randomUUID()}`,
        permission = operation === "save" ? "templates:manage" : "templates:get";
      const roleResponse = await request("/api/roles/users", "POST", {
        name,
        permissions: [permission],
      });
      expect(roleResponse.status).toBe(200);
      const role = (await roleResponse.json()).data;
      const userResponse = await request("/api/users", "POST", {
        username: name,
        name,
        email: `${name}@example.test`,
        type: "user",
        status: "enabled",
        password_login: true,
        password: "m18-fixture-password",
        user_role_id: role.id,
      });
      expect(userResponse.status).toBe(200);
      const page = await fetch(`${f.origin}/admin/login`),
        html = await page.text(),
        nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)![1]!;
      const nonceCookie = page.headers
        .getSetCookie()
        .find((value) => value.startsWith("nonce="))!
        .split(";", 1)[0]!;
      const login = await fetch(`${f.origin}/admin/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
        body: new URLSearchParams({ username: name, password: "m18-fixture-password", nonce }),
      });
      expect(login.status).toBe(302);
      const cookies = login.headers.getSetCookie(),
        session = cookies.find((value) => value.startsWith("session="))!.split(";", 1)[0]!,
        csrf = cookies.find((value) => value.startsWith("csrf="))!.split(";", 1)[0]!;
      const payload =
        operation === "save"
          ? JSON.stringify({ name: "held-write", type: "tx", subject: "subject", body: "body" })
          : "template_type=campaign&body=%7B%7B+content+%7C+raw+%7D%7D";
      const path = operation === "save" ? "/api/templates" : "/api/templates/preview",
        contentType =
          operation === "save" ? "application/json" : "application/x-www-form-urlencoded";
      const address = new URL(f.origin),
        socket = createConnection({ host: "127.0.0.1", port: Number(address.port) });
      const response = new Promise<string>((resolve, reject) => {
        let output = "";
        socket.on("data", (chunk) => (output += chunk.toString()));
        socket.on("end", () => resolve(output));
        socket.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: ${address.host}\r\nCookie: ${session}; ${csrf}\r\nX-CSRF-Token: ${csrf.slice(5)}\r\nContent-Type: ${contentType}\r\nX-M18-Gated-Body: yes\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, 5)}`,
      );
      await f.bodyEntered;
      const logout = await fetch(`${f.origin}/api/logout`, {
        method: "POST",
        headers: { cookie: `${session}; ${csrf}`, "x-csrf-token": csrf.slice(5) },
      });
      expect(logout.status).toBe(200);
      socket.end(payload.slice(5));
      expect(await response).toContain(" 403 ");
      expect((await (await request("/api/templates?query=held-write")).json()).data).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);

test("concurrent omitted-field updates and default/delete retain valid state", async () => {
  const f = await startTemplateFixture();
  try {
    const credential = await provisionApiUser(f.origin, f.admin),
      authorization = `Basic ${btoa(`${credential.user}:${credential.token}`)}`;
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${f.origin}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const txResponse = await call("/api/templates", "POST", {
      name: "old",
      type: "tx",
      subject: "original",
      body: "old body",
    });
    expect(txResponse.status).toBe(200);
    const tx = (await txResponse.json()).data;
    const [one, two] = await Promise.all([
      call(`/api/templates/${tx.id}`, "PUT", { name: "new" }),
      call(`/api/templates/${tx.id}`, "PUT", { body: "new body" }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const row = (await (await call(`/api/templates/${tx.id}`)).json()).data;
    expect([row.name, row.body, row.subject]).toEqual(["new", "new body", "original"]);
    const preview = await call(`/api/templates/${tx.id}/preview`);
    expect(await preview.text()).toBe("new body");
    const campaignResponse = await call("/api/templates", "POST", {
      name: "racing layout",
      type: "campaign",
      body: "{{ content | raw }}",
    });
    const campaign = (await campaignResponse.json()).data;
    const [set, del] = await Promise.all([
      call(`/api/templates/${campaign.id}/default`, "PUT"),
      call(`/api/templates/${campaign.id}`, "DELETE"),
    ]);
    expect([set.status, del.status].sort()).toEqual([200, 400]);
    const rows = (await (await call("/api/templates")).json()).data as Array<{
      id: number;
      is_default: boolean;
    }>;
    expect(rows.filter((item) => item.is_default).length).toBe(1);
    expect(rows.some((item) => item.is_default && [1, campaign.id].includes(item.id))).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);

test("preview reports real renderer admission exhaustion and recovers after failures", async () => {
  const f = await startTemplateFixture({ saturateFirstPreview: true });
  try {
    const credential = await provisionApiUser(f.origin, f.admin);
    const authorization = `Basic ${btoa(`${credential.user}:${credential.token}`)}`;
    const preview = (body: string) =>
      fetch(`${f.origin}/api/templates/preview`, {
        method: "POST",
        headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ template_type: "tx", body }),
      });
    expect((await preview("held")).status).toBe(429);
    expect(await (await preview("available")).text()).toBe("available");
    expect((await preview('{% include "denied" %}')).status).toBe(400);
    expect(await (await preview("recovered")).text()).toBe("recovered");
  } finally {
    await f.close();
  }
}, 30000);

for (const change of ["role", "disabled", "deleted"] as const)
  test(`preview revalidates ${change} after a held real render`, async () => {
    const f = await startTemplateFixture({ holdPreview: true });
    try {
      const admin = await provisionApiUser(f.origin, f.admin);
      const authorization = `Basic ${btoa(`${admin.user}:${admin.token}`)}`;
      const request = (path: string, method = "GET", body?: unknown) =>
        fetch(`${f.origin}${path}`, {
          method,
          headers: {
            authorization,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const name = `render-held-${crypto.randomUUID()}`;
      const role = (
        await (
          await request("/api/roles/users", "POST", { name, permissions: ["templates:get"] })
        ).json()
      ).data;
      const user = (
        await (
          await request("/api/users", "POST", {
            username: name,
            type: "api",
            status: "enabled",
            user_role_id: role.id,
          })
        ).json()
      ).data;
      const heldAuth = `Basic ${btoa(`${name}:${user.password}`)}`;
      const pending = fetch(`${f.origin}/api/templates/1/preview`, {
        headers: { authorization: heldAuth },
      });
      await f.previewHeld;
      const revoked =
        change === "role"
          ? await request(`/api/roles/users/${role.id}`, "PUT", { name, permissions: [] })
          : change === "deleted"
            ? await request(`/api/users/${user.id}`, "DELETE")
            : await request(`/api/users/${user.id}`, "PUT", {
                username: name,
                type: "api",
                status: "disabled",
                user_role_id: role.id,
              });
      expect(revoked.status).toBe(200);
      f.releasePreview();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("<html");
    } finally {
      f.releasePreview();
      await f.close();
    }
  }, 30000);

test("preview revalidates a logged-out session after a held real render", async () => {
  const f = await startTemplateFixture({ holdPreview: true });
  try {
    const page = await fetch(`${f.origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())![1]!;
    const nonceCookie = page.headers
      .getSetCookie()
      .find((x) => x.startsWith("nonce="))!
      .split(";", 1)[0]!;
    const login = await fetch(`${f.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
      body: new URLSearchParams({ username: f.admin.user, password: f.admin.password, nonce }),
    });
    expect(login.status).toBe(302);
    const cookies = login.headers.getSetCookie();
    const session = cookies.find((x) => x.startsWith("session="))!.split(";", 1)[0]!;
    const csrf = cookies.find((x) => x.startsWith("csrf="))!.split(";", 1)[0]!;
    const cookie = `${session}; ${csrf}`;
    const pending = fetch(`${f.origin}/api/templates/1/preview`, { headers: { cookie } });
    await f.previewHeld;
    const logout = await fetch(`${f.origin}/api/logout`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf.slice(5) },
    });
    expect(logout.status).toBe(200);
    f.releasePreview();
    expect((await pending).status).toBe(403);
  } finally {
    f.releasePreview();
    await f.close();
  }
}, 30000);

test("omission preserves writable fields and explicit valid empty values clear them", async () => {
  const f = await startTemplateFixture();
  try {
    const credential = await provisionApiUser(f.origin, f.admin);
    const authorization = `Basic ${btoa(`${credential.user}:${credential.token}`)}`;
    const request = (path: string, method = "GET", body?: unknown) =>
      fetch(`${f.origin}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const created = (
      await (
        await request("/api/templates", "POST", {
          name: "clearable",
          type: "tx",
          subject: "s",
          body: "body",
          body_source: "source",
        })
      ).json()
    ).data;
    expect(
      (await request(`/api/templates/${created.id}`, "PUT", { name: "retained" })).status,
    ).toBe(200);
    let row = (await (await request(`/api/templates/${created.id}`)).json()).data;
    expect([row.name, row.subject, row.body, row.body_source]).toEqual([
      "retained",
      "s",
      "body",
      "source",
    ]);
    expect(
      (await request(`/api/templates/${created.id}`, "PUT", { body: "", body_source: "" })).status,
    ).toBe(200);
    row = (await (await request(`/api/templates/${created.id}`)).json()).data;
    expect([row.name, row.subject, row.body ?? "", row.body_source]).toEqual([
      "retained",
      "s",
      "",
      "",
    ]);
    expect((await request(`/api/templates/${created.id}`, "PUT", { subject: "" })).status).toBe(
      400,
    );
    expect((await (await request(`/api/templates/${created.id}`)).json()).data.subject).toBe("s");
  } finally {
    await f.close();
  }
}, 30000);
