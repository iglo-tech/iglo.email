// Notification rendering and SMTP testing adapted from listmonk cmd/settings.go, internal/notifs/notifs.go and static/email-templates at 6fcd95f.
import base from "@/messaging/smtp-base.txt" with { type: "text" };
import template from "@/messaging/smtp-test.txt" with { type: "text" };
import type { Translation } from "@/i18n/i18n";
import type { SettingsStore } from "@/settings/store";
import type { SMTPServer } from "@/messaging/email";
import { validServer, type createEmailer } from "@/messaging/email";
import { HttpError } from "@/server/response";
import { validateDKIM } from "@/settings/dkim";

const escape = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");
function render(logo: string, t: Translation): string {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(logo)?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "mailto"].includes(scheme)) logo = "#ZgotmplZ";
  const sections =
    /{{ define "header" }}([\s\S]*){{ end }}\s*{{ define "footer" }}([\s\S]*?){{ end }}/.exec(base);
  if (!sections) throw new Error("Missing notification template");
  const header = sections[1]!.replace(
    /{{ if ne LogoURL "" }}[\s\S]*?{{ end }}/,
    logo ? `<img src="${escape(logo)}" alt="listmonk" />` : "",
  );
  const footer = sections[2]!.replace(
    '{{ L.T "public.poweredBy" }}',
    escape(t.T("public.poweredBy")),
  );
  return template
    .replace('{{ define "smtp-test" }}', "")
    .replace('{{ template "header" . }}', header)
    .replace(
      '{{ L.Ts "globals.buttons.testConnection" }}',
      escape(t.T("globals.buttons.testConnection")),
    )
    .replace('{{ template "footer" }}', footer)
    .replace(/{{ end }}\s*$/, "");
}
function parse(value: unknown): { server: SMTPServer; email: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Invalid data.");
  const item = value as Record<string, unknown>;
  const strings = [
    "email",
    "host",
    "hello_hostname",
    "auth_protocol",
    "username",
    "password",
    "tls_type",
    "name",
    "uuid",
    "idle_timeout",
    "wait_timeout",
    "msg_retry_delay",
  ];
  for (const key of strings)
    if (item[key] !== undefined && item[key] !== null && typeof item[key] !== "string")
      throw new HttpError(400, "Invalid data.");
  for (const key of ["enabled", "exclude_from_default"]) {
    if (item[key] !== undefined && item[key] !== null && typeof item[key] !== "boolean")
      throw new HttpError(400, "Invalid data.");
  }
  for (const key of ["max_conns", "max_msg_retries"]) {
    if (
      item[key] !== undefined &&
      item[key] !== null &&
      (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]))
    )
      throw new HttpError(400, "Invalid data.");
  }
  if (
    item.from_addresses !== undefined &&
    item.from_addresses !== null &&
    (!Array.isArray(item.from_addresses) ||
      item.from_addresses.some((entry) => typeof entry !== "string"))
  )
    throw new HttpError(400, "Invalid data.");
  if (
    item.port !== undefined &&
    item.port !== null &&
    (!Number.isSafeInteger(item.port) || typeof item.port !== "number")
  )
    throw new HttpError(400, "Invalid data.");
  if (
    item.tls_skip_verify !== undefined &&
    item.tls_skip_verify !== null &&
    typeof item.tls_skip_verify !== "boolean"
  )
    throw new HttpError(400, "Invalid data.");
  if (
    item.email_headers !== undefined &&
    item.email_headers !== null &&
    (!Array.isArray(item.email_headers) ||
      item.email_headers.some(
        (h) =>
          h !== null &&
          (typeof h !== "object" ||
            Array.isArray(h) ||
            Object.values(h).some((v) => typeof v !== "string")),
      ))
  )
    throw new HttpError(400, "Invalid data.");
  const email = typeof item.email === "string" ? item.email : "";
  if (!email) throw new HttpError(400, "Missing field(s): email");
  const server: SMTPServer = {
    name: "",
    enabled: true,
    exclude_from_default: false,
    host: String(item.host ?? ""),
    port: Number(item.port ?? 0),
    hello_hostname: String(item.hello_hostname ?? ""),
    max_conns: 1,
    idle_timeout: "2s",
    wait_timeout: "2s",
    auth_protocol: String(item.auth_protocol ?? ""),
    username: String(item.username ?? ""),
    password: String(item.password ?? ""),
    tls_type: String(item.tls_type ?? ""),
    tls_skip_verify: item.tls_skip_verify === true,
    email_headers:
      (item.email_headers as Array<Record<string, string> | null> | null | undefined) ?? [],
    from_addresses: [],
  };
  if (item.dkim !== undefined && item.dkim !== null) {
    if (typeof item.dkim !== "object" || Array.isArray(item.dkim))
      throw new HttpError(400, "Invalid SMTP configuration.");
    try {
      server.dkim = validateDKIM(
        item.dkim as { domain_name: string; key_selector: string; private_key: string },
      );
    } catch {
      throw new HttpError(400, "Invalid SMTP configuration.");
    }
  }
  for (const header of server.email_headers ?? []) {
    for (const [name, value] of Object.entries(header ?? {})) {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n\0]/.test(value))
        throw new HttpError(400, "Invalid SMTP configuration.");
    }
  }
  if (!validServer(server)) throw new HttpError(400, "Invalid SMTP configuration.");
  return { server, email };
}
export function createSMTPTest(
  settings: SettingsStore,
  emailer: ReturnType<typeof createEmailer>,
  t: Translation,
) {
  let active = 0;
  return async (body: unknown, revalidate: () => void): Promise<void> => {
    const input = parse(body);
    if (active >= 4) throw new HttpError(429, "Too many SMTP tests in progress.");
    active++;
    try {
      revalidate();
      const current = settings.read();
      const send = emailer.test(
        input.server,
        {
          from: current["app.from_email"][0],
          to: [input.email],
          subject: t.T("globals.buttons.testConnection"),
          contentType: "html",
          body: Buffer.from(render(current["app.logo_url"], t)),
        },
        current["app.root_url"],
      );
      const outcome = await send.result;
      if (outcome.status === "ambiguous") throw new HttpError(500, "SMTP test outcome is unknown.");
      if (outcome.status !== "accepted") throw new HttpError(500, "SMTP test failed.");
      if (outcome.rejected.length)
        throw new HttpError(500, "SMTP test was accepted for some recipients only.");
    } finally {
      active--;
    }
  };
}
