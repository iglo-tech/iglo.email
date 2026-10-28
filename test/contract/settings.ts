// Reference: listmonk cmd/settings.go, models/settings.go and queries/misc.sql at 6fcd95f.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSettingsContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", body?: string, auth = authorization) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(`FAIL settings-${label}`);
  }
  check((await request("/api/settings", "GET", undefined, "")).status === 403, "unauthenticated");
  const response = await request("/api/settings");
  check(response.status === 200, "get");
  const snapshot = ((await response.json()) as { data: Record<string, any> }).data;
  check(
    typeof snapshot["app.site_name"] === "string" && typeof snapshot["app.batch_size"] === "number",
    "scalar-types",
  );
  check(Array.isArray(snapshot.smtp) && Array.isArray(snapshot["app.from_email"]), "array-types");
  check(typeof snapshot["security.captcha"].hcaptcha.secret === "string", "nested-projection");
  check(
    snapshot.smtp.every(
      (item: { password?: string }) => !item.password || /^•+$/.test(item.password),
    ),
    "password-mask",
  );
  const bad = await request("/api/settings", "PUT", "{}");
  check(
    bad.status === 400 &&
      JSON.stringify(await bad.json()) ===
        JSON.stringify({ message: "at least one `from` address is required" }),
    "empty-full",
  );
  const malformed = await request("/api/settings", "PUT", "{");
  check(malformed.status === 400, "malformed");
  const after = ((await (await request("/api/settings")).json()) as { data: Record<string, any> })
    .data;
  check(JSON.stringify(after) === JSON.stringify(snapshot), "invalid-no-write");
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
    await runSettingsContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Settings contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
