// Reference: listmonk cmd/subscribers.go and internal/auth/models.go at 6fcd95f.
import { createConnection } from "node:net";
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscriberScope(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const suffix = crypto.randomUUID();
  const basic = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const resources: { kind: string; id: number }[] = [];
  let cleanupFailed = false;
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL ${label}`);
  }
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = { Authorization: basic },
  ) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function create(path: string, kind: string, data: unknown) {
    const response = await request(path, "POST", data);
    const value = (await response.json()).data;
    if (response.status === 200 && typeof value?.id === "number")
      resources.push({ kind, id: value.id });
    check(response.status === 200 && value?.id, "subscriber-scope-setup");
    return value;
  }
  try {
    const accessible = await create("/api/lists", "lists", { name: `allowed-${suffix}` });
    const hidden = await create("/api/lists", "lists", {
      name: `hidden-${suffix}`,
      description: "private description",
    });
    const visible = await create("/api/subscribers", "subscribers", {
      email: `visible-${suffix}@example.test`,
      attribs: { persisted: { value: 1 } },
      lists: [accessible.id, hidden.id],
      preconfirm_subscriptions: true,
      ...(target.mode === "normal" ? { external_id: `visible-${suffix}` } : {}),
    });
    const invisible = await create("/api/subscribers", "subscribers", {
      email: `hidden-${suffix}@example.test`,
      lists: [hidden.id],
      preconfirm_subscriptions: true,
      ...(target.mode === "normal" ? { external_id: `hidden-${suffix}` } : {}),
    });
    const role = await create("/api/roles/users", "roles", {
      name: `subscriber-role-${suffix}`,
      permissions: ["subscribers:get", "subscribers:manage"],
    });
    const listRole = await create("/api/roles/lists", "roles", {
      name: `subscriber-list-role-${suffix}`,
      lists: [{ id: accessible.id, permissions: ["list:get", "list:manage"] }],
    });
    const token = await create("/api/users", "users", {
      username: `scope-${suffix}`,
      type: "api",
      status: "enabled",
      user_role_id: role.id,
      list_role_id: listRole.id,
    });
    const limited = { Authorization: `Basic ${btoa(`${token.username}:${token.password}`)}` };
    let response = await request(`/api/subscribers/${visible.id}`, "GET", undefined, limited);
    let row = (await response.json()).data;
    check(
      response.status === 200 &&
        row.lists.find((entry: any) => entry.id === hidden.id)?.name === "*Unknown" &&
        row.lists.find((entry: any) => entry.id === hidden.id)?.restricted === true &&
        !("description" in row.lists.find((entry: any) => entry.id === hidden.id)),
      "subscriber-scope-mask",
    );
    check(
      (await request(`/api/subscribers/${invisible.id}`, "GET", undefined, limited)).status === 403,
      "subscriber-scope-invisible-get",
    );
    check(
      (await request(`/api/subscribers/${invisible.id}`, "PATCH", {}, limited)).status === 403,
      "subscriber-scope-empty-patch",
    );
    if (target.mode === "normal") {
      for (const path of [
        `/api/subscribers/external?external_id=${encodeURIComponent(`visible-${suffix}`)}`,
        `/api/subscribers/external/${encodeURIComponent(`visible-${suffix}`)}`,
      ]) {
        check(
          (await request(path, "GET", undefined, limited)).status === 200,
          "D39-scope-external-visible",
        );
      }
      for (const path of [
        `/api/subscribers/external?external_id=${encodeURIComponent(`hidden-${suffix}`)}`,
        `/api/subscribers/external/${encodeURIComponent(`hidden-${suffix}`)}`,
      ]) {
        check(
          (await request(path, "GET", undefined, limited)).status === 403,
          "D39-scope-external-hidden",
        );
        check(
          (await request(path, "DELETE", undefined, limited)).status === 403,
          "D39-scope-external-delete-denied",
        );
      }
    }
    const deniedCreate = await request(
      "/api/subscribers",
      "POST",
      { email: `denied-${suffix}@example.test`, lists: [hidden.id] },
      limited,
    );
    if (deniedCreate.status === 200) {
      const unexpected = (await deniedCreate.json()).data;
      if (typeof unexpected?.id === "number")
        resources.push({ kind: "subscribers", id: unexpected.id });
    }
    check(deniedCreate.status === 403, "subscriber-scope-create-denied");
    check(
      (
        await request(
          "/api/subscribers/blocklist",
          "PUT",
          { ids: [visible.id, invisible.id] },
          limited,
        )
      ).status === 403,
      "subscriber-scope-mixed-bulk",
    );
    row = (await (await request(`/api/subscribers/${visible.id}`)).json()).data;
    check(
      row.status === "enabled" &&
        row.lists.every((entry: any) => entry.subscription_status === "confirmed"),
      "subscriber-scope-mixed-atomic",
    );
    response = await request(
      `/api/subscribers/${visible.id}`,
      "PATCH",
      { lists: [accessible.id], name: "scope update" },
      limited,
    );
    row = (await response.json()).data;
    check(
      response.status === 200 && row.lists.some((entry: any) => entry.id === hidden.id),
      "subscriber-scope-preserve-unmanaged",
    );
    const user = await create("/api/users", "users", {
      username: `human-${suffix}`,
      email: `human-${suffix}@example.test`,
      name: "Fixture",
      type: "user",
      status: "enabled",
      password_login: true,
      password: "fixture-password",
      user_role_id: role.id,
      list_role_id: listRole.id,
    });
    const page = await fetch(`${target.baseUrl}/admin/login`),
      html = await page.text();
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1];
    const nonceCookie = page.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))
      ?.split(";", 1)[0];
    check(nonce && nonceCookie, "subscriber-scope-login-form");
    const login = await fetch(`${target.baseUrl}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: nonceCookie },
      body: new URLSearchParams({ username: user.username, password: "fixture-password", nonce }),
    });
    const session = login.headers
      .getSetCookie()
      .find((v) => v.startsWith("session="))
      ?.split(";", 1)[0];
    const csrf = login.headers
      .getSetCookie()
      .find((v) => v.startsWith("csrf="))
      ?.split(";", 1)[0]
      ?.slice(5);
    check(
      login.status === 302 && session && (target.mode === "reference" || csrf),
      "subscriber-scope-login",
    );
    const sessionHeaders = { Cookie: session, ...(csrf ? { "X-CSRF-Token": csrf } : {}) };
    check(
      (await request(`/api/subscribers/${visible.id}`, "GET", undefined, sessionHeaders)).status ===
        200,
      "subscriber-scope-session-read",
    );
    if (target.mode === "normal") {
      const alias = `/api/subscribers/external?external_id=${encodeURIComponent(`visible-${suffix}`)}`;
      check(
        (await request(alias, "GET", undefined, sessionHeaders)).status === 200,
        "D39-session-external-read",
      );
      check(
        (await request(alias, "PUT", { email: visible.email }, { Cookie: session })).status === 403,
        "D39-session-external-csrf",
      );
      check(
        (
          await request(
            alias,
            "PUT",
            { email: visible.email },
            { ...sessionHeaders, Origin: "https://invalid.example.test" },
          )
        ).status === 403,
        "D39-session-external-origin",
      );
      if (target.restart) {
        await target.restart();
        const persisted = await request(alias, "GET", undefined, sessionHeaders);
        const afterRestart = (await persisted.json()).data;
        check(
          persisted.status === 200 &&
            afterRestart.id === visible.id &&
            afterRestart.uuid === visible.uuid &&
            afterRestart.email === visible.email &&
            afterRestart.external_id === `visible-${suffix}` &&
            afterRestart.status === "enabled" &&
            afterRestart.attribs.persisted.value === 1 &&
            afterRestart.lists.length === 2 &&
            afterRestart.lists.every((entry: any) => entry.subscription_status === "confirmed") &&
            afterRestart.lists.find((entry: any) => entry.id === hidden.id)?.restricted === true,
          "D39-session-external-restart",
        );
      }
    }
    if (target.mode === "normal") {
      const payload = JSON.stringify({ name: "late change" });
      const url = new URL(target.baseUrl),
        socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
      const result = new Promise<string>((resolve, reject) => {
        let output = "";
        socket.on("data", (part) => (output += part.toString()));
        socket.on("end", () => resolve(output));
        socket.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", resolve);
      });
      socket.write(
        `PATCH /api/subscribers/${visible.id} HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${session}\r\nX-CSRF-Token: ${csrf}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, 4)}`,
      );
      check(
        (
          await request(`/api/roles/lists/${listRole.id}`, "PUT", {
            name: `subscriber-list-role-${suffix}`,
            lists: [],
          })
        ).status === 200,
        "subscriber-scope-revoke",
      );
      socket.end(payload.slice(4));
      check((await result).includes(" 403 "), "subscriber-scope-inflight-revocation");
      check(
        (await request(`/api/subscribers/${visible.id}`, "GET", undefined, sessionHeaders))
          .status === 403,
        "subscriber-scope-retained-session-revoked",
      );
      check(
        (await request(`/api/subscribers/${visible.id}`, "GET", undefined, limited)).status === 403,
        "subscriber-scope-token-revoked",
      );
      row = (await (await request(`/api/subscribers/${visible.id}`)).json()).data;
      // Restore the live grant, begin a query-alias write, and revoke it while
      // the request body is incomplete.
      check(
        (
          await request(`/api/roles/lists/${listRole.id}`, "PUT", {
            name: `subscriber-list-role-${suffix}`,
            lists: [{ id: accessible.id, permissions: ["list:get", "list:manage"] }],
          })
        ).status === 200,
        "D39-query-grant-restore",
      );
      const aliasBody = JSON.stringify({ email: visible.email, name: "late alias" });
      const aliasSocket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
      const aliasResult = new Promise<string>((resolve, reject) => {
        let output = "";
        aliasSocket.on("data", (part) => (output += part.toString()));
        aliasSocket.on("end", () => resolve(output));
        aliasSocket.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        aliasSocket.once("error", reject);
        aliasSocket.once("connect", resolve);
      });
      aliasSocket.write(
        `PUT /api/subscribers/external?external_id=${encodeURIComponent(`visible-${suffix}`)} HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${session}\r\nX-CSRF-Token: ${csrf}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(aliasBody)}\r\nConnection: close\r\n\r\n${aliasBody.slice(0, 4)}`,
      );
      check(
        (
          await request(`/api/roles/lists/${listRole.id}`, "PUT", {
            name: `subscriber-list-role-${suffix}`,
            lists: [],
          })
        ).status === 200,
        "D39-query-revoke",
      );
      aliasSocket.end(aliasBody.slice(4));
      check((await aliasResult).includes(" 403 "), "D39-query-inflight-revoked");
      row = (await (await request(`/api/subscribers/${visible.id}`)).json()).data;
      check(row.name === "scope update", "subscriber-scope-revocation-no-write");
      check(
        (
          await request(
            `/api/subscribers/external?external_id=${encodeURIComponent(`visible-${suffix}`)}`,
            "GET",
            undefined,
            sessionHeaders,
          )
        ).status === 403,
        "D39-session-external-revoked",
      );
    }
  } finally {
    for (const { kind, id } of resources.reverse())
      if ((await request(`/api/${kind}/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL subscriber-scope-cleanup");
}
if (import.meta.main) {
  try {
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (process.argv[2] !== "reference" || !baseUrl || !user || !token)
      throw new Error("Reference required");
    await runSubscriberScope({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Subscriber scope contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
