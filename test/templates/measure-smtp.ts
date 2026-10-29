// Compare the protected SMTP diagnostic through owned Mailpit for both compiled binaries.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const admin = { user: "m18-measure-admin", password: "m18-measure-password" };
const captures: { label: string; variant: string; html: string; id: string; subject: string }[] =
  [];
const ids: string[] = [];
try {
  for (const [label, executable] of [
    ["control", "node_modules/.cache/m18-baseline/dist/iglo.email"],
    ["candidate", "dist/iglo.email"],
  ] as const) {
    const address = `m18-${label}-${sink.runId}@example.test`;
    await withProduction(
      resolve(executable),
      AbortSignal.timeout(30000),
      async (origin) => {
        const credentials = await provisionApiUser(origin, admin);
        const headers = {
          authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`,
          "content-type": "application/json",
        };
        for (const [variant, logo] of [
          ["empty", ""],
          ["populated", "https://example.invalid/logo.png"],
          ["unsafe", "javascript:alert(1)"],
        ] as const) {
          const setting = await fetch(`${origin}/api/settings/app.logo_url`, {
            method: "PUT",
            headers,
            body: JSON.stringify(logo),
          });
          assert.equal(setting.status, 200);
          const variantAddress = `${variant}-${address}`;
          const response = await fetch(`${origin}/api/settings/smtp/test`, {
            method: "POST",
            headers: {
              authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              email: variantAddress,
              host: sink.host,
              port: sink.port,
              auth_protocol: "none",
              tls_type: "none",
            }),
          });
          assert.equal(response.status, 200);
          const query = new URLSearchParams({ query: `to:${variantAddress}`, limit: "100" });
          const found = (await (await fetch(`${sink.api}/api/v1/search?${query}`)).json()) as {
            messages: { ID: string; MessageID: string; Subject: string }[];
          };
          assert.equal(found.messages.length, 1);
          const item = found.messages[0]!;
          ids.push(item.ID);
          const message = (await (await fetch(`${sink.api}/api/v1/message/${item.ID}`)).json()) as {
            HTML: string;
            To: { Address: string }[];
          };
          assert.deepEqual(
            message.To.map((x) => x.Address),
            [variantAddress],
          );
          captures.push({
            label,
            variant,
            html: message.HTML,
            id: item.MessageID,
            subject: item.Subject,
          });
        }
      },
      admin,
    );
  }
  const normalize = (html: string) => html.replace(/\s+/g, " ").trim();
  for (const variant of ["empty", "populated", "unsafe"]) {
    const control = captures.find((item) => item.label === "control" && item.variant === variant)!;
    const candidate = captures.find(
      (item) => item.label === "candidate" && item.variant === variant,
    )!;
    assert.equal(control.subject, candidate.subject);
    assert.notEqual(control.id, candidate.id);
    if (variant !== "unsafe") assert.equal(normalize(control.html), normalize(candidate.html));
    if (variant === "populated")
      assert.ok(candidate.html.includes("https://example.invalid/logo.png"));
    if (variant === "unsafe") assert.ok(!candidate.html.includes("javascript:alert(1)"));
    console.log(
      JSON.stringify({
        variant,
        accepted: 2,
        distinctIds: true,
        normalizedBodiesEqual: normalize(control.html) === normalize(candidate.html),
        candidateContainsLogo: candidate.html.includes("https://example.invalid/logo.png"),
        candidateContainsUnsafe: candidate.html.includes("javascript:alert(1)"),
      }),
    );
  }
} finally {
  if (ids.length)
    await fetch(`${sink.api}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: ids }),
    });
}
