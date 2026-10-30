// What the adapted specs and the agent-browser check run against: dist/iglo.email on a generated
// data directory, the loopback SMTP sink, and a second instance that never gets an administrator.
import { resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";
import {
  admin,
  apiClient,
  startMailbox,
  startProduction,
  type Mailbox,
} from "@/test/worked-example/harness";

export const root = resolve(import.meta.dir, "../..");

export interface Stack {
  origin: string;
  blankOrigin: string;
  mailbox: Mailbox;
}

export async function withStack(run: (stack: Stack) => Promise<number>): Promise<number> {
  const production = await startProduction();
  const mailbox = await startMailbox();
  try {
    const api = await apiClient(production.origin);
    const settings = await api.ok("/api/settings");
    await api.ok("/api/settings/smtp", "PUT", [
      {
        ...settings.smtp[0],
        enabled: true,
        host: "127.0.0.1",
        port: mailbox.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
      },
    ]);
    // Each test is its own client through this setting; see test/e2e/helpers.js.
    const current = await api.ok("/api/settings");
    await api.ok("/api/settings", "PUT", {
      ...current,
      "security.trusted_proxies": ["127.0.0.1"],
    });
    return await withProduction(
      resolve(root, "dist/iglo.email"),
      new AbortController().signal,
      (blankOrigin) => run({ origin: production.origin, blankOrigin, mailbox }),
      undefined,
      1_200_000,
    );
  } finally {
    await mailbox.close();
    await production.stop();
    await production.close();
  }
}
