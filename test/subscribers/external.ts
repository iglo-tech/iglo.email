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
    // D39 preserves dot IDs through the canonical query selector. Bun normalizes
    // the raw path before routing; it must not accidentally modify either row.
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
      for (const method of ["PUT", "DELETE"]) {
        const raw = createConnection({ host: "127.0.0.1", port: Number(url.port) });
        const reply = new Promise<string>((resolve, reject) => {
          let wire = "";
          raw.on("data", (part) => (wire += part.toString()));
          raw.on("end", () => resolve(wire));
          raw.on("error", reject);
        });
        await new Promise<void>((resolve, reject) => {
          raw.once("error", reject);
          raw.once("connect", resolve);
        });
        const body =
          method === "PUT" ? JSON.stringify({ email: dotData.email, name: "wrong" }) : "";
        raw.end(
          `${method} /api/subscribers/external/${encoded} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        check((await reply).includes(" 404 "), "D39-dot-path-no-write");
      }
      const query = `/api/subscribers/external?external_id=${encodeURIComponent(dot)}`;
      const found = await request(query);
      check(found.status === 200 && (await found.json()).data.id === dotData.id, "D39-dot-query");
      const updated = await request(query, "PUT", { email: dotData.email, name: "dot" });
      check(updated.status === 200, "D39-dot-query-update");
      check((await request(query, "DELETE")).status === 200, "D39-dot-query-delete");
      owned.splice(owned.indexOf(dotData.id), 1);
    }
    check(
      dotStatuses.every((status) => status === 404),
      "D39-dot-path-normalized",
    );
    // D39: values that look like encodings are separate opaque identities.
    for (const [index, value] of [".", "%2E", "..", "%2E%2E", "%", "/", "\\", " + é"].entries()) {
      const created = await request("/api/subscribers", "POST", {
        email: `selector-${index}-${suffix}@example.test`,
        external_id: value,
      });
      const row = (await created.json()).data;
      if (created.status === 200 && typeof row?.id === "number") owned.push(row.id);
      check(created.status === 200, "D39-selector-create");
      const query = `/api/subscribers/external?external_id=${encodeURIComponent(value)}`;
      const response = await request(query);
      check(
        response.status === 200 && (await response.json()).data.id === row.id,
        "D39-selector-exact-query",
      );
      if (value !== "." && value !== "..") {
        const path = await request(`/api/subscribers/external/${encodeURIComponent(value)}`);
        check(
          path.status === 200 && (await path.json()).data.id === row.id,
          "D39-selector-exact-path",
        );
      }
    }
    for (const query of ["", "?external_id=", "?external_id=a&external_id=b"]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        check(
          (
            await request(
              `/api/subscribers/external${query}`,
              method,
              method === "PUT"
                ? { email: `missing-${suffix}@example.test`, external_id: "%" }
                : undefined,
            )
          ).status === 400,
          "D39-selector-invalid",
        );
      }
    }
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
    for (const [label, selector] of [
      ["path", `/api/subscribers/external/${encodeURIComponent(external)}`],
      ["query", `/api/subscribers/external?external_id=${encodeURIComponent(external)}`],
    ]) {
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
        `PUT ${selector} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, cut)}`,
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
      check((await result).includes(" 400 "), `D39-inflight-rebind-rejected-${label}`);
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
        (await request(`/api/subscribers/${id}`, "PATCH", { external_id: external })).status ===
          200,
        "D38-inflight-restore",
      );
    }
    await target.restart();
    response = await request(`/api/subscribers/external/${encodeURIComponent(external)}`);
    data = (await response.json()).data;
    check(
      response.status === 200 && data.id === id && data.uuid === uuid && data.attribs.persisted,
      "D38-external-restart",
    );
    response = await request(
      `/api/subscribers/external?external_id=${encodeURIComponent(external)}`,
    );
    check(
      response.status === 200 && (await response.json()).data.id === id,
      "D39-external-query-restart",
    );
    // Omitted PATCH fields are resolved from the current row after the body arrives.
    {
      const body = JSON.stringify({ attribs: { late: true } });
      const url = new URL(target.baseUrl);
      const socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
      const reply = new Promise<string>((resolve, reject) => {
        let wire = "";
        socket.on("data", (part) => (wire += part.toString()));
        socket.on("end", () => resolve(wire));
        socket.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", resolve);
      });
      socket.write(
        `PATCH /api/subscribers/${id} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, 4)}`,
      );
      check(
        (await request(`/api/subscribers/${id}`, "PATCH", { name: "Concurrent" })).status === 200,
        "subscriber-patch-concurrent-first",
      );
      socket.end(body.slice(4));
      check((await reply).includes(" 200 "), "subscriber-patch-concurrent-second");
      const current = (await (await request(`/api/subscribers/${id}`)).json()).data;
      check(
        current.name === "Concurrent" && current.attribs.persisted && current.attribs.late,
        "subscriber-patch-current-omissions",
      );
    }
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
