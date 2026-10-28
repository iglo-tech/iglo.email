// Reference: listmonk cmd/lists.go, internal/core/lists.go and queries/lists.sql at 6fcd95f.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runListsContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const owned: number[] = [];
  let cleanupFailed = false;
  const roles: number[] = [];
  const users: number[] = [];
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", body?: unknown, authorization = auth) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(`FAIL ${label}`);
  }
  async function create(name: string, fields: Record<string, unknown> = {}) {
    const response = await request("/api/lists", "POST", { name, ...fields });
    const data = (await response.json()) as { data?: Record<string, any> };
    if (response.status === 200 && typeof data.data?.id === "number") owned.push(data.data.id);
    check(response.status === 200 && data.data, "list-create");
    return data.data;
  }
  async function search(query: string) {
    const response = await request(
      `/api/lists?query=${encodeURIComponent(query)}&status=&per_page=all`,
    );
    check(response.status === 200, "list-search-status");
    return ((await response.json()) as { data: { results: Record<string, any>[] } }).data.results;
  }
  try {
    check(
      (await request("/api/lists", "GET", undefined, "")).status === 403,
      "list-unauthenticated",
    );
    const whitespaceName = `whitespace-${suffix}`;
    const queryWhitespaceTag = `whitespace-tag-${suffix}`;
    const whitespaceRow = await create(whitespaceName, {
      tags: [queryWhitespaceTag],
    });
    const bomQuery = new URLSearchParams({
      query: `\ufeff${whitespaceName}\ufeff`,
      tag: queryWhitespaceTag,
    });
    const bomResults = (await (await request(`/api/lists?${bomQuery}`)).json()).data.results;
    check(bomResults.length === 0, "query-BOM-is-not-Go-space");
    check(
      (await request(`/api/lists?${bomQuery}`, "DELETE")).status === 200 &&
        (await request(`/api/lists/${whitespaceRow.id}`)).status === 200,
      "delete-query-BOM-retains-row",
    );
    const bomTag = new URLSearchParams({
      query: whitespaceName,
      tag: `\ufeff${queryWhitespaceTag}\ufeff`,
    });
    check(
      (await (await request(`/api/lists?${bomTag}`)).json()).data.results.length === 0,
      "collection-tag-BOM-retained",
    );
    const nelQuery = new URLSearchParams({
      query: `\u0085${whitespaceName}\u0085`,
      tag: `\u0085${queryWhitespaceTag}\u0085`,
    });
    check(
      (await (await request(`/api/lists?${nelQuery}`)).json()).data.results.some(
        (row: any) => row.id === whitespaceRow.id,
      ),
      "collection-NEL-is-Go-space",
    );
    // Raw requests retain duplicate JSON keys and XML element order.
    async function raw(
      body: string | ArrayBuffer,
      contentType: string,
      method: "POST" | "PUT" = "POST",
      id?: number,
      authorization = auth,
    ) {
      const response = await fetch(
        `${target.baseUrl}/api/lists${id === undefined ? "" : `/${id}`}`,
        {
          method,
          headers: {
            Authorization: authorization,
            "Content-Type": contentType,
          },
          body,
        },
      );
      const value = (await response.json()) as {
        data?: Record<string, any>;
        message?: string;
      };
      if (method === "POST" && response.status === 200 && typeof value.data?.id === "number")
        owned.push(value.data.id);
      return { response, value };
    }
    const aliasName = `alias-${suffix}`;
    const alias = await raw(
      `{"name":"initial","Name":"middle","name":"${aliasName}","TAGS":[null," 002 ","x"],"ignored":{"x":1}}`,
      "application/json",
    );
    check(
      alias.response.status === 200 &&
        alias.value.data?.name === aliasName &&
        JSON.stringify(alias.value.data.tags) === JSON.stringify(["002", "x"]),
      "json-alias-order-null-tags",
    );
    const nullAlias = await raw(`{"NAME":"null-${suffix}","name":null}`, "application/json");
    check(
      nullAlias.response.status === 200 && nullAlias.value.data?.name === `null-${suffix}`,
      "json-null-string-noop",
    );
    for (const [label, body] of [
      ["type-before-alias", `{"name":123,"Name":"bad-${suffix}"}`],
      ["tag-type", `{"name":"bad-${suffix}","tags":[false]}`],
      ["top-array", "[]"],
      ["top-string", '"x"'],
    ] as const)
      check((await raw(body, "application/json")).response.status === 400, `json-${label}`);
    const repeatedTags = await raw(
      `{"name":"repeat-${suffix}","tags":["first","second"],"TAGS":[null,"other"]}`,
      "application/json",
    );
    check(
      repeatedTags.response.status === 200 &&
        JSON.stringify(repeatedTags.value.data?.tags) === JSON.stringify(["first", "other"]),
      "json-reused-slice-null",
    );
    const clearedTags = await raw(
      `{"name":"cleared-${suffix}","tags":["first"],"TAGS":null,"tags":[null]}`,
      "application/json",
    );
    check(
      clearedTags.response.status === 200 && JSON.stringify(clearedTags.value.data?.tags) === "[]",
      "json-null-slice-reset",
    );
    const reserved = await raw(
      `{"name":"reserved-${suffix}","constructor":{"x":1},"__proto__":true}`,
      "application/json",
    );
    check(
      reserved.response.status === 200 && reserved.value.data?.name === `reserved-${suffix}`,
      "json-unknown-prototype-names",
    );
    // D36 ignores read-only model metadata, even when upstream's discarded
    // read-model binding rejects it. Exercise create and update independently.
    const metadata = [
      [
        "map-type",
        '"subscriber_statuses":{"x":"bad"}',
        "<SubscriberCounts>bad</SubscriberCounts>",
        false,
      ],
      ["time-type", '"created_at":12', "<CreatedAt>bad-date</CreatedAt>", false],
      [
        "calendar",
        '"created_at":"2024-02-30T12:00:00Z"',
        "<CreatedAt>2024-02-30T12:00:00Z</CreatedAt>",
        false,
      ],
      [
        "duplicate-map",
        '"subscriber_statuses":{"x":"bad","x":1}',
        "<SubscriberCount>9223372036854775808</SubscriberCount>",
        false,
      ],
      ["id-overflow", '"id":9223372036854775808', "<ID>9223372036854775808</ID>", false],
      ["id-fraction", '"id":1.0', "<ID> </ID>", false],
      ["id-exponent", '"id":1e0', "<SubscriberID>bad</SubscriberID>", false],
      [
        "valid-int64",
        '"id":9223372036854775807,"subscriber_statuses":{"x":9223372036854775807}',
        "<ID>9223372036854775807</ID>",
        true,
      ],
      [
        "comma-time",
        '"created_at":"2024-02-29T12:00:00,123Z"',
        "<CreatedAt>2024-02-29T12:00:00,123Z</CreatedAt>",
        true,
      ],
    ] as const;
    for (const [label, jsonMetadata, xmlMetadata, compatible] of metadata) {
      for (const xmlBody of [false, true]) {
        for (const method of ["POST", "PUT"] as const) {
          const name = `metadata-${label}-${xmlBody}-${method}-${suffix}`;
          const seed =
            method === "PUT"
              ? await create(`seed-${name}`, {
                  tags: ["keep"],
                  description: "keep",
                })
              : undefined;
          const before = seed
            ? (await (await request(`/api/lists/${seed.id}`)).json()).data
            : undefined;
          const body = xmlBody
            ? `<List><Name>${name}</Name><Tags>writable</Tags><Description>writable</Description>${xmlMetadata}</List>`
            : `{"name":"${name}","tags":["writable"],"description":"writable",${jsonMetadata}}`;
          const result = await raw(
            body,
            xmlBody ? "application/xml" : "application/json",
            method,
            seed?.id,
          );
          const accepted = compatible || target.mode !== "reference";
          check(
            result.response.status === (accepted ? 200 : 400),
            `D36-${label}-${xmlBody}-${method}`,
          );
          if (accepted) {
            const actual = result.value.data!;
            check(
              actual.name === name &&
                actual.description === "writable" &&
                JSON.stringify(actual.tags) === '["writable"]',
              `D36-writable-${label}`,
            );
            check(
              typeof actual.id === "number" &&
                actual.id !== 9223372036854775808 &&
                actual.subscriber_count === 0 &&
                JSON.stringify(actual.subscriber_statuses) === "{}",
              `D36-generated-counts-${label}`,
            );
            check(
              actual.created_at !== "2024-02-29T12:00:00,123Z" &&
                actual.created_at !== "2024-02-30T12:00:00Z",
              `D36-generated-time-${label}`,
            );
            if (before)
              check(
                actual.id === before.id &&
                  actual.uuid === before.uuid &&
                  actual.created_at === before.created_at,
                `D36-identity-preserved-${label}`,
              );
          } else if (before) {
            const after = (await (await request(`/api/lists/${seed!.id}`)).json()).data;
            check(
              JSON.stringify(after) === JSON.stringify(before),
              `D36-reference-rejected-unchanged-${label}`,
            );
          }
        }
      }
    }
    const snapshotSeed = await create(`snapshot-${suffix}`, {
      tags: ["snapshot"],
    });
    const snapshot = (await (await request(`/api/lists/${snapshotSeed.id}`)).json()).data;
    const snapshotUpdate = await request(`/api/lists/${snapshotSeed.id}`, "PUT", {
      ...snapshot,
      name: `snapshot-update-${suffix}`,
    });
    const snapshotActual = (await snapshotUpdate.json()).data;
    check(
      snapshotUpdate.status === 200 &&
        snapshotActual.id === snapshot.id &&
        snapshotActual.uuid === snapshot.uuid &&
        snapshotActual.created_at === snapshot.created_at,
      "D36-get-snapshot-update",
    );
    const metadataOverride = await raw(
      `{"name":"override-${suffix}","id":-1,"uuid":"forged","created_at":"2000-01-01T00:00:00Z","updated_at":"2000-01-01T00:00:00Z","subscriber_count":99,"subscriber_statuses":{"subscribed":99}}`,
      "application/json",
    );
    check(
      metadataOverride.response.status === 200 &&
        metadataOverride.value.data!.id > 0 &&
        metadataOverride.value.data!.uuid !== "forged" &&
        metadataOverride.value.data!.subscriber_count === 0 &&
        metadataOverride.value.data!.created_at !== "2000-01-01T00:00:00Z",
      "D36-metadata-cannot-assign",
    );
    const folded = await raw(`{"name":"folded-${suffix}","tagſ":["accepted"]}`, "application/json");
    check(
      folded.response.status === 200 && folded.value.data?.tags[0] === "accepted",
      "json-unicode-simple-fold",
    );
    const namespaced = await raw(
      `<a:List xmlns:a="urn:test"><a:Name>ns-${suffix}</a:Name><a:Tags>007</a:Tags></a:List>`,
      "application/xml",
    );
    check(
      namespaced.response.status === 200 &&
        namespaced.value.data?.name === `ns-${suffix}` &&
        namespaced.value.data.tags[0] === "007",
      "xml-local-names",
    );
    const xmlFirst = await raw(
      `<List><Name>first-root-${suffix}</Name></List><List><Name>ignored-${suffix}</Name></List>`,
      "application/xml",
    );
    check(
      xmlFirst.response.status === 200 && xmlFirst.value.data?.name === `first-root-${suffix}`,
      "xml-first-root",
    );
    const xml = await raw(
      `<Anything><name>ignored</name><Name>xml-${suffix}</Name><Tags> One Two </Tags><Tags>002</Tags><Tags><Tag>ignored</Tag></Tags><Description> 02 &amp; &#x41; <![CDATA[x<y]]></Description></Anything>`,
      "application/xml",
    );
    check(
      xml.response.status === 200 &&
        xml.value.data?.name === `xml-${suffix}` &&
        JSON.stringify(xml.value.data.tags) === JSON.stringify(["One-Two", "002"]) &&
        xml.value.data.description === " 02 & A x<y",
      "xml-fields-container-text",
    );
    for (const digits of [30, 31, 32, 33, 64]) {
      for (const hex of [false, true]) {
        const entity = `&#${hex ? "x" : ""}${"0".repeat(digits)}${hex ? "41" : "65"};`;
        const result = await raw(
          `<List><Name>longref-${digits}-${hex}-${suffix}</Name><Tags>${entity}</Tags><Description>${entity}</Description></List>`,
          "application/xml",
        );
        check(
          result.response.status === 200 &&
            result.value.data?.description === "A" &&
            JSON.stringify(result.value.data.tags) === '["A"]',
          `xml-long-numeric-reference-${digits}-${hex}`,
        );
      }
    }
    const literalReference = "&#0000000000000000000000000000000000000000065;";
    const cdataReference = await raw(
      `<List><Name>cdata-reference-${suffix}</Name><Description><![CDATA[${literalReference}]]> &amp;#65; &#38;#65;</Description></List>`,
      "application/xml",
    );
    check(
      cdataReference.response.status === 200 &&
        cdataReference.value.data?.description === `${literalReference} &#65; &#65;`,
      "xml-numeric-reference-one-pass-cdata",
    );
    for (const content of [
      `<Description>a${String.fromCharCode(0)}b</Description>`,
      `<Description><![CDATA[a${String.fromCharCode(0)}b]]></Description>`,
      `<Ignored><Nested>${String.fromCharCode(0)}</Nested></Ignored>`,
      `<Ignored>${String.fromCharCode(1)}</Ignored>`,
      `<Ignored>${String.fromCharCode(0xfffe)}</Ignored>`,
    ]) {
      for (const method of ["POST", "PUT"] as const) {
        const seed =
          method === "PUT"
            ? await create(`xml-keep-${owned.length}-${suffix}`, {
                tags: ["keep"],
              })
            : undefined;
        const before = seed
          ? (await (await request(`/api/lists/${seed.id}`)).json()).data
          : undefined;
        const result = await raw(
          `<List><Name>forbidden-${suffix}</Name>${content}</List>`,
          "application/xml",
          method,
          seed?.id,
        );
        check(result.response.status === 400, `xml-forbidden-literal-${method}`);
        if (before)
          check(
            JSON.stringify((await (await request(`/api/lists/${seed!.id}`)).json()).data) ===
              JSON.stringify(before),
            "xml-forbidden-no-write",
          );
      }
    }
    const allowedCharacters = await raw(
      `<List><Name>allowed-xml-${suffix}</Name><Description>\t\n\r${String.fromCodePoint(0x10000, 0x10ffff)}</Description></List>`,
      "application/xml",
    );
    check(
      allowedCharacters.response.status === 200 &&
        allowedCharacters.value.data?.description ===
          `\t\n\n${String.fromCodePoint(0x10000, 0x10ffff)}`,
      "xml-allowed-character-boundaries",
    );
    const xmlUpdate = await raw(
      `<List><Name>first</Name><Name>updated-${suffix}</Name><Tags><![CDATA[a & b]]></Tags></List>`,
      "text/xml",
      "PUT",
      xml.value.data.id,
    );
    check(
      xmlUpdate.response.status === 200 &&
        xmlUpdate.value.data?.name === `updated-${suffix}` &&
        JSON.stringify(xmlUpdate.value.data.tags) === JSON.stringify(["a-&-b"]),
      "xml-update-duplicate",
    );
    check(
      (await raw(`<List><name>lower-${suffix}</name></List>`, "application/xml")).response
        .status === 400,
      "xml-case-sensitive",
    );
    check(
      (await raw("<List><Name>bad</List>", "application/xml")).response.status === 400,
      "xml-malformed",
    );
    const xmlSyntaxFailures = [
      '<List note="bare & broken"><Name>changed</Name></List>',
      '<List><Name>changed</Name><Ignored note="&broken"/></List>',
      '<List bad="<"><Name>changed</Name></List>',
      "<List><!-- bad -- comment --><Name>changed</Name></List>",
      "<List><Name>changed</Name><Description>bad ]]> text</Description></List>",
      "<List><Name>changed</Name><Ignored>abc]]>def</Ignored></List>",
      '<?xml version="1.1"?><List><Name>changed</Name></List>',
    ];
    const bytes = (prefix: string, middle: number[], suffix: string) =>
      new Uint8Array([
        ...new TextEncoder().encode(prefix),
        ...middle,
        ...new TextEncoder().encode(suffix),
      ]).buffer;
    const invalidXmlBytes = [
      bytes("<List><Name>changed</Name><Description>", [255], "</Description></List>"),
      bytes("<List><Name>changed</Name><Ignored>", [255], "</Ignored></List>"),
      bytes("<List><Name>changed</Name><Description>", [0xe2, 0x82], "</Description></List>"),
    ];
    for (const body of [...xmlSyntaxFailures, ...invalidXmlBytes]) {
      for (const method of ["POST", "PUT"] as const) {
        const seed =
          method === "PUT"
            ? await create(`syntax-keep-${owned.length}-${suffix}`, {
                tags: ["kept"],
                description: "before",
              })
            : undefined;
        const before = seed
          ? (await (await request(`/api/lists/${seed.id}`)).json()).data
          : undefined;
        const result = await raw(body, "application/xml", method, seed?.id);
        check(result.response.status === 400, `xml-syntax-and-byte-integrity-${method}`);
        if (before)
          check(
            JSON.stringify((await (await request(`/api/lists/${seed!.id}`)).json()).data) ===
              JSON.stringify(before),
            "xml-invalid-document-no-write",
          );
      }
    }
    for (const tail of [
      "<bad",
      "&broken",
      "<!DOCTYPE",
      String.fromCharCode(0),
      new Uint8Array([255]).buffer,
    ]) {
      for (const method of ["POST", "PUT"] as const) {
        const name = `first-document-${owned.length}-${method}-${suffix}`;
        const document = `<List><Name>${name}</Name><Tags>accepted</Tags></List>`;
        const body =
          typeof tail === "string"
            ? document + tail
            : bytes(document, [...new Uint8Array(tail)], "");
        const seed =
          method === "PUT" ? await create(`seed-${name}`, { tags: ["kept"] }) : undefined;
        const result = await raw(body, "application/xml", method, seed?.id);
        check(
          result.response.status === 200 &&
            result.value.data?.name === name &&
            JSON.stringify(result.value.data.tags) === '["accepted"]',
          `xml-ignore-unconsumed-suffix-${method}`,
        );
      }
    }
    const grammarControls = await raw(
      `\ufeff<List good="&amp; &lt; &quot; &#65;"><!-- ordinary comment --><Name>grammar-control-${suffix}</Name><Description>escaped ]]&gt; and <![CDATA[]]>ordinary</Description></List>`,
      "application/xml",
    );
    check(
      grammarControls.response.status === 200 &&
        grammarControls.value.data?.description === "escaped ]]> and ordinary",
      "xml-valid-attribute-comment-text-BOM",
    );
    for (const method of ["POST", "PUT"] as const) {
      const name = `json-replacement-${method}-${suffix}`;
      const seed = method === "PUT" ? await create(`seed-${name}`) : undefined;
      const result = await raw(
        bytes(`{"name":"${name}","description":"`, [255], '"}'),
        "application/json",
        method,
        seed?.id,
      );
      check(
        result.response.status === 200 && result.value.data?.description === "\ufffd",
        `json-compatible-invalid-UTF8-replacement-${method}`,
      );
    }
    const safeText = await raw(
      `<List><!-- <!DOCTYPE x> --><Name>safe-${suffix}</Name><Description><![CDATA[<!ENTITY x>]]></Description></List>`,
      "application/xml",
    );
    check(
      safeText.response.status === 200 && safeText.value.data?.description === "<!ENTITY x>",
      "xml-comment-cdata-not-declaration",
    );
    const depth = (n: number) =>
      `<List><Name>depth-${suffix}</Name>${"<x>".repeat(n)}${"</x>".repeat(n)}</List>`;
    check(
      (await raw(depth(63), "application/xml")).response.status === 200,
      "xml-depth-64-control",
    );
    const tooDeep = await raw(depth(64), "application/xml");
    check(
      tooDeep.response.status === (target.mode === "reference" ? 200 : 400),
      "D35-xml-depth-65",
    );
    const dtd = await raw(
      `<!DOCTYPE List><List><Name>dtd-${suffix}</Name></List>`,
      "application/xml",
    );
    check(dtd.response.status === (target.mode === "reference" ? 200 : 400), "D35-xml-dtd");
    const external = await raw(
      `<!DOCTYPE List [<!ENTITY x SYSTEM "file:///nonexistent">]><List><Name>&x;</Name></List>`,
      "application/xml",
    );
    check(external.response.status === 400, "D35-xml-external-entity");
    const oversized = await raw(
      `<List><Name>big-${suffix}</Name><Ignored>${"x".repeat(65536)}</Ignored></List>`,
      "application/xml",
    );
    check(
      oversized.response.status === (target.mode === "reference" ? 200 : 413),
      "D35-xml-body-limit",
    );
    check(
      (await raw(`<List><Name>bad &unknown;</Name></List>`, "application/xml")).response.status ===
        400,
      "xml-unknown-entity",
    );
    const deepestSelfClosing = `<List><Name>deep-self-${suffix}</Name>${"<x>".repeat(63)}<x/>${"</x>".repeat(63)}</List>`;
    const deepSelf = await raw(deepestSelfClosing, "application/xml");
    check(
      deepSelf.response.status === (target.mode === "reference" ? 200 : 400),
      "D35-xml-depth-self-closing",
    );
    const whitespaceTag = await create(`tag-spaces-${suffix}`, {
      tags: ["\u0085" + "a".repeat(100) + "\u0085", "\ufeffx\ufeff", "a\vb"],
    });
    check(
      JSON.stringify(whitespaceTag.tags) ===
        JSON.stringify(["a".repeat(100), "\ufeffx\ufeff", "a\vb"]),
      "tag-go-unicode-trim",
    );
    const longTag = "x".repeat(101),
      limitTag = "é".repeat(100);
    const longCreate = await raw(
      JSON.stringify({ name: `long-${suffix}`, tags: [longTag] }),
      "application/json",
    );
    check(
      longCreate.response.status === (target.mode === "reference" ? 500 : 400) &&
        (target.mode === "reference"
          ? longCreate.value.message?.includes("22001")
          : longCreate.value.message === "Invalid fields: tags"),
      "D35-tag-post",
    );
    const bounded = await create(`bounded-${suffix}`, {
      description: "retained",
      tags: [limitTag],
    });
    check(JSON.stringify(bounded.tags) === JSON.stringify([limitTag]), "tag-multibyte-100");
    const longUpdate = await raw(
      JSON.stringify({
        name: `renamed-${suffix}`,
        description: "changed",
        tags: [longTag],
      }),
      "application/json",
      "PUT",
      bounded.id,
    );
    check(longUpdate.response.status === (target.mode === "reference" ? 200 : 400), "D35-tag-put");
    const boundedRead = (
      (await (await request(`/api/lists/${bounded.id}`)).json()) as {
        data: Record<string, any>;
      }
    ).data;
    check(
      target.mode === "reference"
        ? boundedRead.name === `renamed-${suffix}` && boundedRead.tags[0] === "x".repeat(100)
        : boundedRead.name === bounded.name &&
            boundedRead.description === "retained" &&
            boundedRead.tags[0] === limitTag &&
            boundedRead.updated_at === bounded.updated_at,
      "D35-tag-put-persistence",
    );
    const exact = await request(
      `/api/lists?query=${encodeURIComponent(target.mode === "reference" ? `renamed-${suffix}` : bounded.name)}&tag=${encodeURIComponent(target.mode === "reference" ? "x".repeat(100) : limitTag)}`,
    );
    check(
      ((await exact.json()) as { data: { results: { id: number }[] } }).data.results.some(
        (x) => x.id === bounded.id,
      ),
      "D35-tag-exact-filter",
    );
    const xmlPostLong = await raw(
      `<List><Name>xml-long-${suffix}</Name><Tags>${longTag}</Tags></List>`,
      "application/xml",
    );
    check(
      xmlPostLong.response.status === (target.mode === "reference" ? 500 : 400),
      "D35-xml-tag-post",
    );
    const xmlLimit = await raw(
      `<List><Name>xml-limit-${suffix}</Name><Tags>${limitTag}</Tags></List>`,
      "application/xml",
    );
    check(
      xmlLimit.response.status === 200 && xmlLimit.value.data?.tags[0] === limitTag,
      "xml-multibyte-tag-100",
    );
    const xmlLong = await raw(
      `<List><Name>xml-rename-${suffix}</Name><Tags>${longTag}</Tags></List>`,
      "application/xml",
      "PUT",
      bounded.id,
    );
    check(xmlLong.response.status === (target.mode === "reference" ? 200 : 400), "D35-xml-tag-put");
    const list = await create(`m15 ${suffix} Ponies`, {
      description: "description",
      tags: [" One Two ", "other"],
    });
    check(
      JSON.stringify(Object.keys(list).sort()) ===
        JSON.stringify(
          [
            "created_at",
            "description",
            "id",
            "name",
            "optin",
            "status",
            "subscriber_count",
            "subscriber_statuses",
            "subscription_created_at",
            "subscription_updated_at",
            "tags",
            "type",
            "updated_at",
            "uuid",
          ].sort(),
        ),
      "list-full-projection-keys",
    );
    check(
      list.subscription_created_at === null && list.subscription_updated_at === null,
      "list-null-subscription-times",
    );
    check(
      list.type === "private" && list.optin === "single" && list.status === "active",
      "list-defaults",
    );
    check(
      JSON.stringify(list.tags) === JSON.stringify(["One-Two", "other"]),
      "list-tags-normalized",
    );
    check(
      list.subscriber_count === 0 && JSON.stringify(list.subscriber_statuses) === "{}",
      "list-empty-counts",
    );
    check(
      typeof list.uuid === "string" &&
        typeof list.created_at === "string" &&
        typeof list.updated_at === "string",
      "list-identity-timestamps",
    );
    const read = await request(`/api/lists/${list.id}`);
    check(
      read.status === 200 &&
        ((await read.json()) as { data: { uuid: string } }).data.uuid === list.uuid,
      "list-read",
    );
    for (const [query, expected, label] of [
      ["pony", target.mode === "reference", "stemming"],
      ["%", target.mode === "reference", "percent"],
      ["_", target.mode === "reference", "underscore"],
      [`  ${suffix}   PONIES  `, true, "whitespace"],
    ] as const) {
      check(
        (await search(query)).some((item) => item.id === list.id) === expected,
        `D33-search-${label}`,
      );
    }
    const update = await request(`/api/lists/${list.id}`, "PUT", {
      name: list.name,
      description: "",
    });
    check(update.status === 200, "list-update");
    const changed = ((await update.json()) as { data: Record<string, unknown> }).data;
    check(
      changed.description === (target.mode === "reference" ? "description" : ""),
      "D33-description-clear",
    );
    check(JSON.stringify(changed.tags) === "[]", "list-omitted-tags-clear");
    const missing = await request("/api/lists/2147483647");
    check(missing.status === 400, "list-missing-get");
    for (const [field, value] of [
      ["type", "wrong"],
      ["optin", "wrong"],
      ["status", "wrong"],
    ] as const) {
      check(
        (await request(`/api/lists?${field}=${value}`)).status === 400,
        `list-invalid-${field}`,
      );
    }
    const minimal = await request(`/api/lists?minimal=true&status=archived`);
    check(
      minimal.status === 200 &&
        JSON.stringify(((await minimal.json()) as { data: unknown }).data) === "[]",
      "list-minimal-empty",
    );
    const second = await create(`m15 ${suffix} other`, {
      type: "public",
      optin: "double",
      status: "archived",
      tags: ["one", "two"],
    });
    const repeatedMinimal = await request(
      `/api/lists?minimal=&minimal=true&status=&status=archived`,
    );
    const repeatedMinimalData = (
      (await repeatedMinimal.json()) as {
        data: { results: { id: number; subscriber_statuses: unknown }[] };
      }
    ).data;
    check(
      repeatedMinimalData.results.some(
        (entry) => entry.id === second.id && entry.subscriber_statuses === null,
      ),
      "list-repeated-minimal-status",
    );
    const filtered = await request(`/api/lists?query=${suffix}&status=archived&tag=one&tag=two`);
    const result = (
      (await filtered.json()) as {
        data: { results: { id: number }[]; total: number };
      }
    ).data;
    check(
      filtered.status === 200 && result.total === 1 && result.results[0]?.id === second.id,
      "list-filters",
    );
    const emptyMinimal = await request(`/api/lists?minimal=true&status=archived`, "GET");
    const minimalData = (
      (await emptyMinimal.json()) as {
        data: { results: Record<string, unknown>[]; total: number };
      }
    ).data;
    check(
      minimalData.results.some(
        (entry) =>
          entry.id === second.id &&
          entry.subscriber_statuses === null &&
          entry.subscriber_count === 0,
      ),
      "list-minimal-projection",
    );
    for (const [param, page, perPage] of [
      ["", 1, 20],
      ["page=0&per_page=invalid", 1, 20],
      ["per_page=100", 1, 100],
      ["per_page=all", 1, 0],
      ["page=999", 999, 20],
    ] as const) {
      const response = await request(`/api/lists?query=${suffix}&${param}`);
      const pageData = (
        (await response.json()) as {
          data: {
            page: number;
            per_page: number;
            total: number;
            results: unknown[];
          };
        }
      ).data;
      check(
        response.status === 200 &&
          pageData.page === page &&
          pageData.per_page === perPage &&
          (page !== 999 || (pageData.total === 0 && pageData.results.length === 0)),
        `list-page-${page}-${perPage}`,
      );
    }
    for (const tags of [null, [], undefined]) {
      const filled = await request(`/api/lists/${list.id}`, "PUT", {
        name: list.name,
        description: "kept",
        tags: ["retain"],
      });
      check(filled.status === 200, "list-tag-setup");
      const replacement = await request(`/api/lists/${list.id}`, "PUT", {
        name: list.name,
        ...(tags === undefined ? {} : { tags }),
        description: null,
      });
      const replacementData = (
        (await replacement.json()) as {
          data: { tags: string[]; description: string };
        }
      ).data;
      check(
        replacement.status === 200 &&
          JSON.stringify(replacementData.tags) === "[]" &&
          replacementData.description === "kept",
        `list-tag-replace-${tags === null ? "null" : tags === undefined ? "omitted" : "empty"}`,
      );
    }
    check(
      (await request("/api/lists", "POST", { name: "é".repeat(1001) })).status === 400,
      "list-utf8-length",
    );
    // D34 retains native int64 list identities versus pinned PostgreSQL int32.
    // D17 remains the separate signed-int64 overflow boundary.
    for (const [path, method, body, action] of [
      ["/api/lists/2147483648", "GET", undefined, "fetching"],
      ["/api/lists/2147483648", "PUT", { name: "out-of-range" }, "updating"],
      ["/api/lists/2147483648", "DELETE", undefined, "deleting"],
      ["/api/lists?id=2147483648", "DELETE", undefined, "deleting"],
    ] as const) {
      const response = await request(path, method, body);
      const expected =
        target.mode === "reference"
          ? {
              message: `Error ${action} ${action === "updating" ? "List" : "Lists"}: pq: value "2147483648" is out of range for type integer (22003)`,
            }
          : method === "DELETE"
            ? { data: true }
            : { message: "List not found" };
      check(
        response.status === (target.mode === "reference" ? 500 : method === "DELETE" ? 200 : 400) &&
          JSON.stringify(await response.json()) === JSON.stringify(expected),
        `D34-list-int32-limit-${action}-${path.includes("?") ? "query" : "path"}`,
      );
    }
    check(
      (await request("/api/lists/2147483647", "PUT", { name: "missing" })).status === 400,
      "list-missing-update",
    );
    check((await request("/api/lists/2147483647", "DELETE")).status === 200, "list-missing-delete");
    check((await request("/api/lists", "DELETE")).status === 400, "list-empty-delete");
    check((await request("/api/lists?id=bad", "DELETE")).status === 400, "list-invalid-delete-id");
    const overflowID = await request("/api/lists?id=-9223372036854775809", "DELETE");
    check(
      overflowID.status === 400 &&
        ((await overflowID.json()) as { message: string }).message ===
          'One or more IDs are invalid: strconv.Atoi: parsing "-9223372036854775809": value out of range',
      "list-negative-query-id-overflow",
    );

    // DELETE preserves raw query selectors; all probes use unique owned names.
    for (const [label, selector, expectedStatus] of [
      ["empty-tag", "&tag=", 200],
      ["padded-tag", "&tag=%20retained%20", 200],
      ["padded-type", "&type=%20private%20", 400],
      ["padded-optin", "&optin=%20single%20", 400],
      ["padded-status", "&status=%20active%20", 400],
    ] as const) {
      const preserved = await create(`selector-${label}-${suffix}`, {
        tags: ["retained"],
      });
      const response = await request(
        `/api/lists?query=${encodeURIComponent(preserved.name)}${selector}`,
        "DELETE",
      );
      check(response.status === expectedStatus, `delete-${label}-status`);
      check(
        (await request(`/api/lists/${preserved.id}`)).status === 200,
        `delete-${label}-retained`,
      );
    }
    const firstQuery = await create(`first-query-${suffix}`);
    const firstEmpty = await request(
      `/api/lists?query=&query=${encodeURIComponent(firstQuery.name)}`,
      "DELETE",
    );
    check(firstEmpty.status === 400, "delete-first-query-empty");
    check(
      (await request(`/api/lists/${firstQuery.id}`)).status === 200,
      "delete-first-query-retained",
    );
    const formPrefix = `form-delete-${suffix}`;
    const formA = await create(`${formPrefix}-a`, { tags: ["a"] });
    const formAB = await create(`${formPrefix}-ab`, { tags: ["a", "b"] });
    const formDelete = await fetch(`${target.baseUrl}/api/lists`, {
      method: "DELETE",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["query", formPrefix],
        ["all", "true"],
        ["tag", "a"],
        ["tag", "b"],
      ]),
    });
    check(
      formDelete.status === 400 &&
        ((await formDelete.json()) as { message: string }).message ===
          "One or more IDs are invalid: id or query required",
      "delete-body-selectors-ignored",
    );
    for (const row of [formA, formAB])
      check((await request(`/api/lists/${row.id}`)).status === 200, "delete-body-list-retained");
    const conjunction = await request(
      `/api/lists?query=${encodeURIComponent(formPrefix)}&tag=a&tag=b`,
      "DELETE",
    );
    check(conjunction.status === 200, "delete-url-tag-conjunction");
    check(
      (await request(`/api/lists/${formA.id}`)).status === 200,
      "delete-url-single-tag-retained",
    );
    check(
      (await request(`/api/lists/${formAB.id}`)).status === 400,
      "delete-url-both-tags-removed",
    );

    const userRoleResponse = await request("/api/roles/users", "POST", {
      name: `m15-user-${suffix}`,
      permissions: [],
    });
    check(userRoleResponse.status === 200, "list-create-user-role");
    const userRole = ((await userRoleResponse.json()) as { data: { id: number } }).data.id;
    roles.push(userRole);
    const listRoleResponse = await request("/api/roles/lists", "POST", {
      name: `m15-list-${suffix}`,
      lists: [{ id: list.id, permissions: ["list:get"] }],
    });
    check(listRoleResponse.status === 200, "list-create-list-role");
    const listRole = ((await listRoleResponse.json()) as { data: { id: number } }).data.id;
    roles.push(listRole);
    const limitedResponse = await request("/api/users", "POST", {
      username: `m15-${suffix}`,
      type: "api",
      status: "enabled",
      user_role_id: userRole,
      list_role_id: listRole,
    });
    check(limitedResponse.status === 200, "list-create-limited-user");
    const limited = (
      (await limitedResponse.json()) as {
        data: { id: number; username: string; password: string };
      }
    ).data;
    users.push(limited.id);
    const limitedAuth = `Basic ${btoa(`${limited.username}:${limited.password}`)}`;
    check(
      (await request(`/api/lists/${list.id}`, "GET", undefined, limitedAuth)).status === 200,
      "list-granted-read",
    );
    check(
      (await request(`/api/lists/${second.id}`, "GET", undefined, limitedAuth)).status === 403,
      "list-denied-read",
    );
    check(
      (await request(`/api/lists/${list.id}`, "PUT", { name: list.name }, limitedAuth)).status ===
        403,
      "list-denied-write",
    );
    check(
      (await request("/api/lists", "POST", { name: `m15-denied-${suffix}` }, limitedAuth))
        .status === 403,
      "list-denied-create",
    );
    check(
      (
        await raw(
          `<List><Name>denied-${suffix}</Name></List>`,
          "application/xml",
          "POST",
          undefined,
          limitedAuth,
        )
      ).response.status === 403,
      "xml-denied-create",
    );
    check(
      (
        await raw(
          `<List><Name>denied-${suffix}</Name></List>`,
          "application/xml",
          "PUT",
          list.id,
          limitedAuth,
        )
      ).response.status === 403,
      "xml-denied-update",
    );
    check(
      (await raw(`{"Name":"denied-${suffix}"}`, "application/json", "PUT", list.id, limitedAuth))
        .response.status === 403,
      "json-alias-denied-update",
    );
    const visible = await request(
      `/api/lists?query=${suffix}&per_page=all`,
      "GET",
      undefined,
      limitedAuth,
    );
    const visibleData = (
      (await visible.json()) as {
        data: { total: number; results: { id: number }[] };
      }
    ).data;
    check(
      visibleData.total === 1 &&
        visibleData.results.length === 1 &&
        visibleData.results[0]?.id === list.id,
      "list-scoped-collection",
    );
    const minimalVisible = await request("/api/lists?minimal=true", "GET", undefined, limitedAuth);
    const minimalVisibleData = (
      (await minimalVisible.json()) as {
        data: { total: number; results: { id: number }[] };
      }
    ).data;
    check(
      minimalVisibleData.total === 1 && minimalVisibleData.results[0]?.id === list.id,
      "list-scoped-minimal",
    );
    const grantManage = await request(`/api/roles/lists/${listRole}`, "PUT", {
      name: `m15-list-${suffix}`,
      lists: [{ id: list.id, permissions: ["list:manage"] }],
    });
    check(grantManage.status === 200, "list-change-grant");
    check(
      (await request(`/api/lists/${list.id}`, "GET", undefined, limitedAuth)).status === 403,
      "list-revoked-read",
    );
    check(
      (await request(`/api/lists/${list.id}`, "PUT", { name: list.name }, limitedAuth)).status ===
        200,
      "list-granted-write",
    );
    check(
      (
        await raw(
          `<List><Name>${list.name}</Name><Tags>allowed</Tags></List>`,
          "application/xml",
          "PUT",
          list.id,
          limitedAuth,
        )
      ).response.status === 200,
      "xml-granted-update",
    );
    check(
      (await request(`/api/lists?id=${list.id}&id=${second.id}`, "DELETE", undefined, limitedAuth))
        .status === 403,
      "list-bulk-all-or-nothing",
    );
    check(
      (await request(`/api/lists/${list.id}`)).status === 200 &&
        (await request(`/api/lists/${second.id}`)).status === 200,
      "list-bulk-denied-unchanged",
    );
    const managedTarget = await create(`m15 managed ${suffix}`, {
      tags: [`managed-${suffix}`],
    });
    const manageTwo = await request(`/api/roles/lists/${listRole}`, "PUT", {
      name: `m15-list-${suffix}`,
      lists: [
        { id: list.id, permissions: ["list:manage"] },
        { id: managedTarget.id, permissions: ["list:manage"] },
      ],
    });
    check(manageTwo.status === 200, "list-bulk-manage-grant");
    const bulk = await request(
      `/api/lists?all=true&tag=managed-${suffix}`,
      "DELETE",
      undefined,
      limitedAuth,
    );
    check(
      bulk.status === 200 &&
        (await request(`/api/lists/${managedTarget.id}`)).status === 400 &&
        (await request(`/api/lists/${list.id}`)).status === 200 &&
        (await request(`/api/lists/${second.id}`)).status === 200,
      "list-bulk-scoped-filter",
    );
    owned.splice(owned.indexOf(managedTarget.id), 1);
    const grantNothing = await request(`/api/roles/lists/${listRole}`, "PUT", {
      name: `m15-list-${suffix}`,
      lists: [],
    });
    check(
      grantNothing.status === 200 &&
        (await request(`/api/lists/${list.id}`, "DELETE", undefined, limitedAuth)).status === 403,
      "list-revoked-write",
    );
    const deletionTarget = await create(`m15 ${suffix} Ponies`, {
      tags: [`m15-${suffix}`],
    });
    const selection = await request(`/api/lists?query=pony&tag=m15-${suffix}`);
    const selected = (
      (await selection.json()) as { data: { results: { id: number }[] } }
    ).data.results.some((entry) => entry.id === deletionTarget.id);
    check(selected === (target.mode === "reference"), "D33-delete-preview-stemming");
    const deleteQuery = await request(`/api/lists?query=pony&tag=m15-${suffix}`, "DELETE");
    check(deleteQuery.status === 200, "D33-delete-query");
    const afterQuery = await request(`/api/lists/${deletionTarget.id}`);
    check(
      afterQuery.status === (target.mode === "reference" ? 400 : 200),
      "D33-delete-matches-preview",
    );
    if (target.mode === "reference") owned.splice(owned.indexOf(deletionTarget.id), 1);
    const sortedFirst = await create(`sort-${suffix}-a`);
    const sortedLast = await create(`sort-${suffix}-z`);
    for (const [order, expected] of [
      ["asc", [sortedFirst.id, sortedLast.id]],
      ["desc", [sortedLast.id, sortedFirst.id]],
      ["invalid", [sortedLast.id, sortedFirst.id]],
    ] as const) {
      const sorted = await request(`/api/lists?query=sort-${suffix}&order_by=name&order=${order}`);
      const ids = (
        (await sorted.json()) as { data: { results: { id: number }[] } }
      ).data.results.map((item) => item.id);
      check(JSON.stringify(ids) === JSON.stringify(expected), `list-sort-name-${order}`);
    }
    const repeatedSort = await request(
      `/api/lists?query=sort-${suffix}&order_by=&order_by=name&order=desc&per_page=&per_page=1&page=&page=2`,
    );
    const repeatedSortData = (
      (await repeatedSort.json()) as {
        data: { page: number; per_page: number; results: { id: number }[] };
      }
    ).data;
    check(
      repeatedSortData.page === 2 &&
        repeatedSortData.per_page === 1 &&
        repeatedSortData.results[0]?.id === sortedFirst.id,
      "list-repeated-pagination-sort",
    );
    const pageSorted = await request(
      `/api/lists?query=sort-${suffix}&order_by=name&per_page=1&page=2`,
    );
    const pageSortedData = (
      (await pageSorted.json()) as {
        data: { total: number; results: { id: number }[] };
      }
    ).data;
    check(
      pageSortedData.total === 2 && pageSortedData.results[0]?.id === sortedLast.id,
      "list-sort-before-pagination",
    );
    const deleted = await request(`/api/lists?id=${second.id}`, "DELETE");
    check(deleted.status === 200, "list-delete-ids");
    owned.splice(owned.indexOf(second.id), 1);
    check((await request(`/api/lists/${second.id}`)).status === 400, "list-deleted");
  } finally {
    for (const id of users.reverse())
      if ((await request(`/api/users/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of roles.reverse())
      if ((await request(`/api/roles/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.reverse())
      if ((await request(`/api/lists/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL list-cleanup");
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
    await runListsContract({
      mode: "reference",
      baseUrl,
      credentials: { user, token },
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Lists contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
