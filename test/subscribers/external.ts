// D38 production-only contract: external IDs do not exist in the reference.
import { createConnection } from "node:net";
import type { Credentials } from "@/test/contract/types";

export async function runExternalContract(target: {
  baseUrl: string;
  credentials: Credentials;
  restart: () => Promise<void>;
}) {
  const suffix = crypto.randomUUID();
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const owned: number[] = [];
  let cleanupFailed = false;
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(`FAIL ${label}`);
  }
  try {
    // D38 requires opaque IDs including dot segments; send the original target
    // over a raw socket so the client does not normalize it before Bun sees it.
    const dotStatuses: number[] = [];
    for (const dot of [".", ".."]) {
      const created = await request("/api/subscribers", "POST", {
        email: `dot-${dot.length}-${suffix}@example.test`,
        external_id: dot,
      });
      const dotData = (await created.json()).data;
      if (created.status === 200 && typeof dotData?.id === "number") owned.push(dotData.id);
      check(created.status === 200, "D38-dot-create");
      const url = new URL(target.baseUrl);
      const socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
      const response = new Promise<string>((resolve, reject) => {
        let output = "";
        socket.on("data", (part) => (output += part.toString()));
        socket.on("end", () => resolve(output));
        socket.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", resolve);
      });
      const encoded = dot === "." ? "%2E" : "%2E%2E";
      socket.end(
        `GET /api/subscribers/external/${encoded} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${auth}\r\nConnection: close\r\n\r\n`,
      );
      const wire = await response;
      dotStatuses.push(Number(/^HTTP\/1\.1 (\d+)/.exec(wire)?.[1]));
    }
    check(
      dotStatuses.every((status) => status === 200),
      "D38-dot-opaque-lookup",
    );
    const external = ` /é/${suffix} `;
    let response = await request("/api/subscribers", "POST", {
      email: `external-${suffix}@example.test`,
      external_id: external,
      attribs: { persisted: true },
    });
    let data = (await response.json()).data;
    if (response.status === 200 && typeof data?.id === "number") owned.push(data.id);
    check(response.status === 200 && data.external_id === external, "D38-external-create");
    const id = data.id;
    const uuid = data.uuid;
    response = await request(`/api/subscribers/external/${encodeURIComponent(external)}`);
    data = (await response.json()).data;
    check(
      response.status === 200 && data.id === id && data.external_id === external,
      "D38-external-opaque-lookup",
    );
    response = await request(`/api/subscribers/${id}`, "PATCH", { name: "Retained" });
    data = (await response.json()).data;
    check(
      response.status === 200 && data.external_id === external,
      "D38-external-omission-preserves",
    );
    response = await request("/api/subscribers", "POST", {
      email: `collision-${suffix}@example.test`,
      external_id: external,
    });
    const collision = await response.json();
    if (response.status === 200 && typeof collision.data?.id === "number")
      owned.push(collision.data.id);
    check(
      response.status === 409 && collision.message === "External ID already exists",
      "D38-external-collision",
    );
    for (const invalid of ["", "\0", "\ud800", "é".repeat(1001), 1, [], {}]) {
      response = await request(`/api/subscribers/${id}`, "PATCH", {
        external_id: invalid,
        name: "Should not persist",
      });
      check(response.status === 400, "D38-external-invalid");
      data = (await (await request(`/api/subscribers/${id}`)).json()).data;
      check(
        data.name === "Retained" && data.external_id === external,
        "D38-external-invalid-atomic",
      );
    }
    const contender = await request("/api/subscribers", "POST", {
      email: `contender-${suffix}@example.test`,
    });
    const contenderData = (await contender.json()).data;
    if (contender.status === 200 && typeof contenderData?.id === "number")
      owned.push(contenderData.id);
    check(contender.status === 200, "D38-contender-create");
    response = await request(`/api/subscribers/${contenderData.id}`, "PATCH", {
      external_id: external,
      name: "collision changed",
    });
    check(response.status === 409, "D38-external-rekey-collision");
    const afterCollision = (await (await request(`/api/subscribers/${contenderData.id}`)).json())
      .data;
    check(
      afterCollision.name === contenderData.name && afterCollision.external_id === null,
      "D38-external-collision-atomic",
    );
    const claim = `race-${suffix}`;
    const claims = await Promise.all(
      ["a", "b"].map((n) =>
        request("/api/subscribers", "POST", {
          email: `${n}-${suffix}@example.test`,
          external_id: claim,
        }),
      ),
    );
    const outcomes = await Promise.all(
      claims.map(async (r) => ({ status: r.status, body: await r.json() })),
    );
    for (const outcome of outcomes)
      if (outcome.status === 200 && typeof outcome.body.data?.id === "number")
        owned.push(outcome.body.data.id);
    check(
      outcomes
        .map((o) => o.status)
        .sort()
        .join(",") === "200,409",
      "D38-external-concurrent-claim",
    );
    const payload = JSON.stringify({
      email: `retarget-${suffix}@example.test`,
      name: "wrong target",
    });
    const cut = 8,
      url = new URL(target.baseUrl);
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
      `PUT /api/subscribers/external/${encodeURIComponent(external)} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, cut)}`,
    );
    check(
      (await request(`/api/subscribers/${id}`, "PATCH", { external_id: null })).status === 200,
      "D38-inflight-clear",
    );
    check(
      (await request(`/api/subscribers/${contenderData.id}`, "PATCH", { external_id: external }))
        .status === 200,
      "D38-inflight-rebind",
    );
    socket.end(payload.slice(cut));
    check((await result).includes(" 400 "), "D38-inflight-rebind-rejected");
    const untouched = (await (await request(`/api/subscribers/${contenderData.id}`)).json()).data;
    check(
      untouched.name === contenderData.name && untouched.email === contenderData.email,
      "D38-inflight-rebind-no-write",
    );
    check(
      (await request(`/api/subscribers/${contenderData.id}`, "PATCH", { external_id: null }))
        .status === 200,
      "D38-inflight-contender-clear",
    );
    check(
      (await request(`/api/subscribers/${id}`, "PATCH", { external_id: external })).status === 200,
      "D38-inflight-restore",
    );
    await target.restart();
    response = await request(`/api/subscribers/external/${encodeURIComponent(external)}`);
    data = (await response.json()).data;
    check(
      response.status === 200 && data.id === id && data.uuid === uuid && data.attribs.persisted,
      "D38-external-restart",
    );
    const rekey = `new-${suffix}`;
    response = await request(`/api/subscribers/external/${encodeURIComponent(external)}`, "PUT", {
      email: data.email,
      name: data.name,
      external_id: rekey,
    });
    check(
      response.status === 200 && (await response.json()).data.external_id === rekey,
      "D38-external-rekey",
    );
    check(
      (await request(`/api/subscribers/external/${encodeURIComponent(external)}`)).status === 400,
      "D38-external-old-missing",
    );
    response = await request(`/api/subscribers/${id}`, "PATCH", { external_id: null });
    check(
      response.status === 200 && (await response.json()).data.external_id === null,
      "D38-external-clear",
    );
    check(
      (await request(`/api/subscribers/external/${encodeURIComponent(rekey)}`)).status === 400,
      "D38-external-cleared-missing",
    );
  } finally {
    for (const id of owned.reverse()) {
      if ((await request(`/api/subscribers/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw new Error("FAIL external-cleanup");
}
