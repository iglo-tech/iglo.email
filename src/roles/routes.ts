// Adapted from listmonk cmd/roles.go and cmd/handlers.go at 6fcd95f.
import type { Roles } from "@/roles/roles";
import { permissions, RoleChildError } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID, strHasLen } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { readBody } from "@/users/input";
import type { UserStore } from "@/users/store";

const validPermissions = new Set<string>([
  ...permissions,
  "sequences:get",
  "sequences:manage",
  "subscriber_events:create",
  "subscriber_events:get",
  "sends:get",
  "sends:manage",
  "webhooks:manage",
]);

async function input(context: RequestContext, kind: "user" | "list") {
  const text = await readBody(context.request);
  if (
    text &&
    context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
  )
    throw new HttpError(415);
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400);
  }
  if (raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400);
  const data = raw as Record<string, unknown>;
  const invalid = (name: string): never => {
    throw new HttpError(400, context.app.i18n.Ts("globals.messages.invalidFields", "name", name));
  };
  if (data.name != null && typeof data.name !== "string") throw new HttpError(400);
  const name = typeof data.name === "string" ? data.name : "";
  if (!strHasLen(name, 1, 2000)) invalid("name");
  if (kind === "user" && data.permissions == null) invalid("permissions");
  const granted = data.permissions ?? [];
  if (!Array.isArray(granted) || granted.some((v) => typeof v !== "string"))
    throw new HttpError(400);
  if (kind === "user") for (const p of granted) if (!validPermissions.has(p)) invalid("permission");
  const items = data.lists ?? [];
  if (!Array.isArray(items)) throw new HttpError(400);
  const children: { id: bigint; permissions: string[] }[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpError(400);
    const value = item as Record<string, unknown>;
    const childPermissions = value.permissions ?? [];
    if (
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      !Array.isArray(childPermissions) ||
      childPermissions.some((p) => typeof p !== "string")
    )
      throw new HttpError(400);
    for (const p of childPermissions)
      if (p !== "list:get" && p !== "list:manage") invalid("list permission");
    children.push({ id: BigInt(value.id), permissions: childPermissions as string[] });
  }
  return { name, granted: granted as string[], children };
}

export function registerRoleRoutes(
  router: Router,
  roles: Roles,
  users: UserStore,
  auth: Authentication,
) {
  for (const [kind, path] of [
    ["user", "users"],
    ["list", "lists"],
  ] as const) {
    const get: Handler = (context) =>
      ok(
        roles.all(
          kind,
          context.url.searchParams.get("query") ?? "",
          context.url.searchParams.get("order_by") ?? "",
          context.url.searchParams.get("order") ?? "",
        ),
      );
    const save =
      (update: boolean): Handler =>
      async (context) => {
        const id = update ? BigInt(getID(context)) : null;
        if (id === 1n) throw new HttpError(400, "invalid ID");
        const data = await input(context, kind);
        auth.revalidate(context, "roles:manage");
        let result: bigint | null;
        try {
          result = roles.mutate(
            kind,
            id,
            update ? data.name.trim() : data.name,
            kind === "user" ? data.granted : [],
            data.children,
            context.app.clock.now().toISOString(),
          );
        } catch (error) {
          const message =
            error instanceof RoleChildError && update
              ? "Error creating List role"
              : update
                ? `Error updating ${kind === "user" ? "User" : "List"} role`
                : "Error creating Role";
          throw new HttpError(500, message);
        }
        if (result === null) {
          if (id !== null && !roles.exists(id))
            throw new HttpError(500, `Error updating ${kind === "user" ? "User" : "List"} role`);
          throw new HttpError(400, "invalid ID");
        }
        const entry = roles.all(kind, "", "", "").find((item) => item.id === Number(result));
        return ok(entry ? { ...entry, lists: null } : null);
      };
    router.route("GET", `/api/roles/${path}`, get, auth.middleware("roles:get"));
    router.route("POST", `/api/roles/${path}`, save(false), auth.middleware("roles:manage"));
    router.route(
      "PUT",
      `/api/roles/${path}/:id`,
      save(true),
      auth.middleware("roles:manage"),
      hasID,
    );
  }
  router.route(
    "DELETE",
    "/api/roles/:id",
    (context) => {
      const result = roles.remove(BigInt(getID(context)), users.roleAssigned);
      if (result === "invalid") throw new HttpError(400, "invalid ID");
      if (result === "assigned")
        throw new HttpError(400, context.app.i18n.T("users.cantDeleteRole"));
      return ok(true);
    },
    auth.middleware("roles:manage"),
    hasID,
  );
}
