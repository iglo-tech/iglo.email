// Bootstrap comparison: listmonk cmd/install.go and cmd/auth.go at 6fcd95f; D14/D26 own provisioning.
// The API user and its token follow D106: a token is stored as its SHA-256 digest, as handlers.ts does.
import { createHash } from "node:crypto";
import type { BootstrapConfig } from "@/config/bootstrap";
import { strHasLen } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { validPassword } from "@/users/password";
import type { BootstrapUser, UserStore } from "@/users/store";

/** The format handlers.ts gives generated API tokens (`randomToken`): 48 letters and digits. */
const apiTokenFormat = /^[0-9A-Za-z]{48}$/;
const usernameFormat = /^[a-zA-Z0-9_\-.@]+$/;

/**
 * Creates the first administrator and the first API user, when no users exist. Each pair is read
 * on its own: both or neither. Both rows are written in one transaction, so a start never leaves
 * one of them behind.
 */
export async function bootstrapAdmin(
  store: UserStore,
  auth: Authentication,
  input: BootstrapConfig["initialAdmin"],
  api: BootstrapConfig["initialApi"] = { user: undefined, token: undefined },
): Promise<void> {
  if (store.count() !== 0n) return;
  const adminSet = input.user !== undefined || input.password !== undefined;
  const apiSet = api.user !== undefined || api.token !== undefined;
  if (!adminSet && !apiSet) return;

  const username = input.user?.trim() ?? "";
  const password = input.password ?? "";
  const apiUsername = api.user?.trim() ?? "";
  const token = api.token ?? "";
  if (adminSet) {
    if (!username || !password)
      throw new Error(
        "Initial administrator requires both IGLO_EMAIL_ADMIN_USER and IGLO_EMAIL_ADMIN_PASSWORD",
      );
    if (!strHasLen(username, 3, 2000) || !usernameFormat.test(username))
      throw new Error("Invalid initial administrator username");
    if (!validPassword(password)) throw new Error("Invalid initial administrator password");
  }
  if (apiSet) {
    if (!apiUsername || !token)
      throw new Error("API user requires both IGLO_EMAIL_API_USER and IGLO_EMAIL_API_TOKEN");
    if (!strHasLen(apiUsername, 3, 2000) || !usernameFormat.test(apiUsername))
      throw new Error(
        "Invalid IGLO_EMAIL_API_USER: expected 3 to 2000 letters, digits, _ - . or @",
      );
    if (adminSet && apiUsername === username)
      throw new Error("IGLO_EMAIL_API_USER must differ from IGLO_EMAIL_ADMIN_USER");
    if (!apiTokenFormat.test(token))
      throw new Error(
        "Invalid IGLO_EMAIL_API_TOKEN: expected 48 letters and digits (A-Z, a-z, 0-9)",
      );
  }

  const users: BootstrapUser[] = [];
  if (adminSet) {
    users.push({
      username,
      passwordLogin: true,
      password: await auth.hash(password),
      email: "initial-admin@localhost.invalid",
      name: username,
      type: "user",
      status: "enabled",
    });
  }
  if (apiSet) {
    users.push({
      username: apiUsername,
      passwordLogin: false,
      password: createHash("sha256").update(token).digest("hex"),
      email: `${apiUsername}@api`,
      name: apiUsername,
      type: "api",
      status: "enabled",
    });
  }
  store.bootstrap(users);
}
