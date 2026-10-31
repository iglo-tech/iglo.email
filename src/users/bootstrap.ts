// Bootstrap comparison: listmonk cmd/install.go and cmd/auth.go at 6fcd95f; D14/D26 own provisioning.
import type { BootstrapConfig } from "@/config/bootstrap";
import { strHasLen } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { validPassword } from "@/users/password";
import type { UserStore } from "@/users/store";

export async function bootstrapAdmin(
  store: UserStore,
  auth: Authentication,
  input: BootstrapConfig["initialAdmin"],
): Promise<void> {
  if (store.count() !== 0n) return;
  const username = input.user?.trim() ?? "";
  const password = input.password ?? "";
  if (input.user === undefined && input.password === undefined) return;
  if (!username || !password)
    throw new Error(
      "Initial administrator requires both IGLO_EMAIL_ADMIN_USER and IGLO_EMAIL_ADMIN_PASSWORD",
    );
  if (!strHasLen(username, 3, 2000) || !/^[a-zA-Z0-9_\-.@]+$/.test(username))
    throw new Error("Invalid initial administrator username");
  if (!validPassword(password)) throw new Error("Invalid initial administrator password");
  const hash = await auth.hash(password);
  store.bootstrap(username, hash);
}
