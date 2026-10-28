// D38 production-only contract: external IDs do not exist in the reference.
import type { Credentials } from "@/test/contract/types";

export async function runExternalContract(target: {
  baseUrl: string;
  credentials: Credentials;
  restart: () => Promise<void>;
}) {
  const suffix = crypto.randomUUID();
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const owned: number[] = [];
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
    check(
      response.status === 409 && (await response.json()).message === "External ID already exists",
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
      if ((await request(`/api/subscribers/${id}`, "DELETE")).status !== 200)
        throw new Error("FAIL external-cleanup");
    }
  }
}
