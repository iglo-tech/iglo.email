// A settings snapshot made safe to write back: the secrets a read masks are blanked, which a
// write keeps (listmonk cmd/settings.go at 6fcd95f). Shared by the settings contract files.
export const SECRET_LISTS = ["smtp", "messengers", "bounce.mailboxes"] as const;

export function withBlankPasswords<T extends Record<string, any>>(snapshot: T): T {
  const out = structuredClone(snapshot);
  for (const key of SECRET_LISTS) for (const entry of out[key]) entry.password = "";
  return out;
}
