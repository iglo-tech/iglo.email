// Constrain every SMTP and Mailpit operation to the invocation-owned loopback reference.
export interface ReferenceMailpit {
  api: string;
  host: string;
  port: number;
  runId: string;
}
export function referenceMailpit(env: NodeJS.ProcessEnv): ReferenceMailpit {
  const host = env.MAILPIT_SMTP_HOST;
  const portText = env.MAILPIT_SMTP_PORT;
  const apiText = env.MAILPIT_URL;
  const runId = env.REFERENCE_RUN_ID;
  if (!host || !portText || !apiText || !runId)
    throw new Error("SMTP spike requires bun run reference:run and its owned Mailpit environment");
  if (
    host !== "127.0.0.1" ||
    !/^[0-9]{1,5}$/.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65535
  )
    throw new Error("SMTP destination must be numeric IPv4 loopback with an explicit port");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId))
    throw new Error("Invalid reference run ID");
  let api: URL;
  try {
    api = new URL(apiText);
  } catch {
    throw new Error("Invalid Mailpit API origin");
  }
  if (
    api.protocol !== "http:" ||
    api.hostname !== "127.0.0.1" ||
    !api.port ||
    Number(api.port) < 1 ||
    Number(api.port) > 65535 ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error("Mailpit API must be a numeric loopback HTTP origin with an explicit port");
  return { api: api.origin, host, port: Number(portText), runId };
}

// The runner labels its Mailpit and disables relay. Verify before sending any mail.
export async function assertOwnedMailpit(reference: ReferenceMailpit) {
  const response = await fetch(`${reference.api}/api/v1/webui`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Cannot verify reference Mailpit identity");
  const info = (await response.json()) as { Label?: string; MessageRelay?: { Enabled?: boolean } };
  if (info.Label !== reference.runId || info.MessageRelay?.Enabled !== false)
    throw new Error("Mailpit is not the labelled, relay-disabled reference for this run");
}
