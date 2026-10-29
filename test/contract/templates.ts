// Reference: listmonk cmd/templates.go, internal/core/templates.go and queries/templates.sql at 6fcd95f.
import type { Credentials, Mode } from "@/test/contract/types";

type Row = {
  id: number;
  name: string;
  type: string;
  subject: string;
  body?: string;
  body_source: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export async function runTemplatesContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const reference = target.mode === "reference";
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const suffix = crypto.randomUUID();
  const owned: number[] = [];
  let originalDefault = 0;
  let cleanupFailed = false;
  const request = (path: string, method = "GET", body?: unknown, auth = authorization) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL templates-${label}`);
  };
  const campaignBody = reference
    ? '<div>{{ template "content" . }}</div>'
    : "<div>{{ content | raw }}</div>";
  const txBody = reference
    ? "<p>Hello {{ .Subscriber.Name }}</p>"
    : "<p>Hello {{ subscriber.name }}</p>";
  const list = async (query = "") =>
    ((await (await request(`/api/templates${query}`)).json()) as { data: Row[] }).data;
  const get = async (id: number) =>
    ((await (await request(`/api/templates/${id}`)).json()) as { data: Row }).data;
  const create = async (input: object) => {
    const response = await request("/api/templates", "POST", input);
    const item = ((await response.json()) as { data: Row }).data;
    if (response.status === 200 && item?.id) owned.push(item.id);
    check(response.status === 200 && item?.id > 0, "create");
    return item;
  };
  try {
    check((await request("/api/templates", "GET", undefined, "")).status === 403, "auth");
    check(
      (await request("/api/templates", "GET", undefined, "Basic invalid")).status === 403,
      "bad-auth",
    );
    const initial = await request("/api/templates");
    check(initial.status === 200, "list");
    const rows = ((await initial.json()) as { data: Row[] }).data;
    check(
      Array.isArray(rows) && rows.some((row) => row.type === "campaign" && row.is_default),
      "default",
    );
    originalDefault = rows.find((row) => row.is_default)!.id;
    check(rows.filter((row) => row.is_default).length === 1, "one-default");
    check(rows.some((row) => row.type === "campaign_visual") === reference, "D54-visual-omitted");
    const item = await create({
      name: `contract-${suffix}`,
      type: "campaign",
      body: campaignBody,
      subject: "ignored",
      body_source: "source",
    });
    check(
      item.type === "campaign" &&
        item.subject === "" &&
        item.body === campaignBody &&
        item.body_source === "source" &&
        !item.is_default,
      "create-projection",
    );
    check(typeof item.created_at === "string" && typeof item.updated_at === "string", "timestamps");
    if (!reference) {
      check(
        rows.length === 3 && rows.map((row) => row.id).join(",") === "1,2,3",
        "D54-bootstrap-ids",
      );
      if (target.restart) {
        await target.restart();
        const restarted = await list();
        check(
          restarted.length === rows.length + 1 &&
            restarted.some((row) => row.id === item.id && row.name === item.name),
          "D54-restart-preserves",
        );
      }
    }
    const fetched = await get(item.id);
    check(fetched.name === item.name && fetched.body === campaignBody, "get");
    const noBody = (
      (await (await request(`/api/templates/${item.id}?no_body=true`)).json()) as { data: Row }
    ).data;
    check(!("body" in noBody) && noBody.body_source === null, "no-body");
    check(
      (await list("?no_body=true")).every((row) => !("body" in row) && row.body_source === null),
      "collection-no-body",
    );
    check(
      (await list(`?query=${encodeURIComponent(suffix)}`)).some((row) => row.id === item.id),
      "search",
    );
    const ordered = await list("?order_by=name&order=asc");
    check(
      ordered.every((row, index) => index === 0 || ordered[index - 1]!.name <= row.name),
      "order",
    );
    const preview = await request(`/api/templates/${item.id}/preview`);
    check(
      preview.status === 200 &&
        (preview.headers.get("content-type") ?? "").startsWith("text/html") &&
        (await preview.text()).includes("Hi there"),
      "stored-preview",
    );
    const csp = preview.headers.get("content-security-policy") ?? "";
    check(
      reference
        ? csp.includes("allow-scripts")
        : csp.includes("sandbox") &&
            !csp.includes("allow-scripts") &&
            csp.includes("default-src 'none'") &&
            csp.includes("style-src 'unsafe-inline'") &&
            csp.includes("img-src data:") &&
            csp.includes("base-uri 'none'") &&
            csp.includes("form-action 'none'") &&
            preview.headers.get("x-content-type-options") === "nosniff",
      "D54-preview-csp",
    );
    const posted = await fetch(`${target.baseUrl}/api/templates/preview`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ template_type: "campaign", body: campaignBody }),
    });
    check(posted.status === 200 && (await posted.text()).includes("Hi there"), "posted-preview");
    const multipart = new FormData();
    multipart.set("template_type", "campaign");
    multipart.set("body", campaignBody);
    const multipartPreview = await fetch(`${target.baseUrl}/api/templates/preview`, {
      method: "POST",
      headers: { Authorization: authorization },
      body: multipart,
    });
    check(
      multipartPreview.status === 200 && (await multipartPreview.text()).includes("Hi there"),
      "posted-multipart-preview",
    );
    const emptyPreview = await fetch(`${target.baseUrl}/api/templates/preview`, {
      method: "POST",
      headers: { Authorization: authorization },
    });
    check(
      emptyPreview.status === 400 && (await emptyPreview.text()).includes("placeholder"),
      "posted-empty-preview",
    );
    const queryPreview = await fetch(
      `${target.baseUrl}/api/templates/preview?template_type=tx&body=query`,
      {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    check(
      queryPreview.status === 200 && (await queryPreview.text()) === "query",
      "posted-preview-query-fallback",
    );
    const precedencePreview = await fetch(
      `${target.baseUrl}/api/templates/preview?template_type=tx&body=query`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "body=posted",
      },
    );
    check(
      precedencePreview.status === 200 && (await precedencePreview.text()) === "posted",
      "posted-preview-body-precedence",
    );

    const wildcard = await create({
      name: `${suffix}-wild%_end`,
      type: "tx",
      subject: "s",
      body: "x",
    });
    const ordinary = await create({
      name: `${suffix}-wildOTHERend`,
      type: "tx",
      subject: "s",
      body: "x",
    });
    const literalMatches = await list(`?query=${encodeURIComponent(`${suffix}-wild%_`)}`);
    check(
      literalMatches.some((row) => row.id === wildcard.id),
      "D54-search-literal-target",
    );
    check(
      literalMatches.some((row) => row.id === ordinary.id) === reference,
      "D54-search-wildcards",
    );
    const tx = await create({ name: `tx-${suffix}`, type: "tx", subject: "Hello", body: txBody });
    check(tx.type === "tx" && tx.subject === "Hello" && !tx.is_default, "tx-projection");
    check((await request(`/api/templates/${tx.id}/preview`)).status === 200, "tx-preview");
    const update = await request(`/api/templates/${tx.id}`, "PUT", {
      name: `renamed-${suffix}`,
      type: "tx",
      subject: "Updated",
      body: txBody,
    });
    check(
      update.status === 200 && ((await update.json()) as { data: Row }).data.subject === "Updated",
      "update",
    );
    check((await get(tx.id)).name === `renamed-${suffix}`, "update-persisted");
    const omitted = await request(`/api/templates/${tx.id}`, "PUT", {
      name: `omitted-${suffix}`,
      body: txBody,
    });
    check(omitted.status === 200, "D54-omitted-update");
    check(
      (await get(tx.id)).subject === (reference ? `renamed-${suffix}` : "Updated"),
      "D54-omitted-subject",
    );
    const conflicting = await request(`/api/templates/${tx.id}`, "PUT", {
      name: `conflicting-${suffix}`,
      type: "campaign",
      body: campaignBody,
    });
    check(conflicting.status === (reference ? 200 : 400), "D54-immutable-type");
    const afterConflict = await get(tx.id);
    check(
      afterConflict.type === "tx" &&
        afterConflict.name === (reference ? `conflicting-${suffix}` : `omitted-${suffix}`),
      "D54-conflict-atomic",
    );
    const metadata = await request(`/api/templates/${tx.id}`, "PUT", {
      name: `metadata-${suffix}`,
      type: "tx",
      subject: "Subject",
      body: txBody,
      id: 1234,
      is_default: true,
      created_at: "fake",
      updated_at: "fake",
    });
    check(metadata.status === (reference ? 400 : 200), "D54-metadata-update");
    const metadataRow = await get(tx.id);
    check(
      metadataRow.id === tx.id &&
        !metadataRow.is_default &&
        metadataRow.created_at !== "fake" &&
        metadataRow.updated_at !== "fake",
      "D54-metadata-readonly",
    );

    check(
      (await request("/api/templates", "POST", { name: "", type: "tx", subject: "x", body: "x" }))
        .status === 400,
      "name-validation",
    );
    check(
      (await request("/api/templates", "POST", { name: "x", type: "tx", subject: "", body: "x" }))
        .status === 400,
      "subject-validation",
    );
    check(
      (await request("/api/templates", "POST", { name: "x", type: "campaign", body: "x" }))
        .status === 400,
      "slot-validation",
    );
    check(
      (await request("/api/templates", "POST", { name: "x", type: "unknown", body: "x" }))
        .status === 400,
      "type-validation",
    );
    check((await request("/api/templates/999999999")).status === 400, "missing");
    check((await request("/api/templates/0")).status === 400, "invalid-id");
    check((await request("/api/templates/999999999", "DELETE")).status === 400, "delete-missing");
    check((await request("/api/templates", "HEAD")).status === 404, "head-method");
    check((await request("/api/templates", "PATCH")).status === 404, "patch-method");
    check((await request("/api/templates/preview")).status === 400, "get-preview-invalid-id");
    const raw = (body: string, contentType: string) =>
      fetch(`${target.baseUrl}/api/templates`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": contentType },
        body,
      });
    check((await raw("{", "application/json")).status === 400, "malformed-json");
    check(
      (await raw("Name=Form&Type=tx&Subject=Hello&Body=test", "application/x-www-form-urlencoded"))
        .status === 400,
      "form-no-tags",
    );
    const duplicate = await raw(
      `{"name":"first","NAME":"paired-${suffix}-é","name":null,"type":"tx","subject":"Hello","body":"text"}`,
      "application/json",
    );
    const duplicateRow = ((await duplicate.json()) as { data?: Row }).data;
    if (duplicate.status === 200 && duplicateRow) owned.push(duplicateRow.id);
    check(
      duplicate.status === 200 && duplicateRow?.name === `paired-${suffix}-é`,
      "json-duplicate-case-null",
    );
    const xml = await raw(
      `<Template><Name>xml-${suffix}</Name><Type>tx</Type><Subject>Hello</Subject><Body>body</Body></Template>`,
      "application/xml",
    );
    const xmlRow = ((await xml.json()) as { data?: Row }).data;
    if (xml.status === 200 && xmlRow) owned.push(xmlRow.id);
    check(xml.status === 200 && xmlRow?.name === `xml-${suffix}`, "xml-create");

    if (!reference) {
      const tooLarge = await raw("x".repeat(512 * 1024 + 1), "application/json");
      check(tooLarge.status === 413, "D54-request-limit");
      for (const body of ["x".repeat(65537), "😀".repeat(16385)]) {
        check(
          (
            await request("/api/templates", "POST", {
              name: "limit",
              type: "tx",
              subject: "s",
              body,
            })
          ).status === 400,
          "D54-source-byte-limit",
        );
      }
      const subjectExact = await request("/api/templates", "POST", {
        name: "subject-bound",
        type: "tx",
        subject: "é".repeat(1024),
        body: "",
      });
      const subjectRow = ((await subjectExact.json()) as { data?: Row }).data;
      if (subjectExact.status === 200 && subjectRow) owned.push(subjectRow.id);
      check(subjectExact.status === 200 && subjectRow, "D54-subject-exact");
      check(
        (
          await request("/api/templates", "POST", {
            name: "subject-bound",
            type: "tx",
            subject: "é".repeat(1024) + "x",
            body: "",
          })
        ).status === 400,
        "D54-subject-one-past",
      );
      check(
        (await request(`/api/templates/${item.id}`, "PUT", { body_source: "é".repeat(32768) }))
          .status === 200,
        "D54-body-source-exact",
      );
      check(
        (
          await request(`/api/templates/${item.id}`, "PUT", {
            body_source: "é".repeat(32768) + "x",
          })
        ).status === 400,
        "D54-body-source-one-past",
      );
      const subjectSyntax = await request(`/api/templates/${tx.id}`, "PUT", {
        subject: "{% if secret-subject-canary %}",
      });
      const subjectError = await subjectSyntax.text();
      check(
        subjectSyntax.status === 400 &&
          subjectError.includes("subject") &&
          !subjectError.includes("secret-subject-canary"),
        "D54-subject-diagnostic",
      );
      const unchanged = await get(tx.id);
      for (const candidate of [
        { body: "{% if broken %}", name: "synthetic-source-canary" },
        { subject: "" },
        { type: "campaign", body: campaignBody },
        { body: "bad\u0000value" },
      ]) {
        const rejected = await request(`/api/templates/${tx.id}`, "PUT", candidate);
        check(
          rejected.status === 400 && !(await rejected.text()).includes("synthetic-source-canary"),
          "D54-invalid-candidate",
        );
        check(JSON.stringify(await get(tx.id)) === JSON.stringify(unchanged), "D54-invalid-atomic");
      }
      for (const body of [
        "{% comment %}{{ content | raw }}{% endcomment %}",
        "{% raw %}{{ content | raw }}{% endraw %}",
        "{% capture x %}{{ content | raw }}{% endcapture %}",
      ]) {
        check(
          (await request("/api/templates", "POST", { name: "invalid", type: "campaign", body }))
            .status === 400,
          "D54-real-slot",
        );
      }
      const clearSource = await request(`/api/templates/${item.id}`, "PUT", { body_source: null });
      check(
        clearSource.status === 200 && (await get(item.id)).body_source === null,
        "D54-clear-source",
      );
      check(
        (
          await request("/api/templates", "POST", {
            name: "x",
            type: "campaign_visual",
            body: campaignBody,
          })
        ).status === 400,
        "D54-no-visual-writes",
      );
      const invalidDefault = await request("/api/templates/999999999/default", "PUT");
      check(
        invalidDefault.status === 400 &&
          (await list()).find((row) => row.is_default)?.id === originalDefault,
        "D54-missing-default",
      );
    }

    check(
      (await request(`/api/templates/${originalDefault}`, "DELETE")).status === 400,
      "default-delete-guard",
    );
    const setDefault = await request(`/api/templates/${item.id}/default`, "PUT");
    check(
      setDefault.status === 200 &&
        ((await setDefault.json()) as { data: Row[] }).data.some(
          (row) => row.id === item.id && row.is_default,
        ),
      "set-default",
    );
    check(
      (await request(`/api/templates/${item.id}`, "DELETE")).status === 400,
      "new-default-delete-guard",
    );
    const invalidDefault = await request(`/api/templates/${tx.id}/default`, "PUT");
    check(invalidDefault.status === (reference ? 200 : 400), "D54-invalid-default-status");
    check(
      (await list()).some((row) => row.is_default) === !reference,
      "D54-invalid-default-preserves",
    );
    check(
      (await request(`/api/templates/${originalDefault}/default`, "PUT")).status === 200,
      "restore-default",
    );
    check((await request(`/api/templates/${item.id}`, "DELETE")).status === 200, "delete");
    owned.splice(owned.indexOf(item.id), 1);
    check((await request(`/api/templates/${item.id}`)).status === 400, "deleted");
  } finally {
    if (
      originalDefault &&
      (await request(`/api/templates/${originalDefault}/default`, "PUT")).status !== 200
    )
      cleanupFailed = true;
    for (const id of owned)
      if ((await request(`/api/templates/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL templates-cleanup");
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runTemplatesContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Templates contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
