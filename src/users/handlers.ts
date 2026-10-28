// Adapted from listmonk cmd/users.go, internal/core/users.go and queries/users.sql at 6fcd95f.
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Roles } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import { getID, strHasLen } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { readBody } from "@/users/input";
import { projectUser, type Identity } from "@/users/models";
import type { UserFields, UserStore } from "@/users/store";

interface Input {
  username: string;
  name: string;
  email: string;
  password: string;
  type: string;
  status: string;
  passwordLogin: boolean;
  userRoleId: bigint;
  listRoleId: bigint | null;
}

async function readJSON(request: Request): Promise<Input> {
  const body = await readBody(request);
  let data: unknown = {};
  if (body.length) {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      throw new HttpError(415);
    try {
      const parse = JSON.parse as (
        text: string,
        reviver: (key: string, value: unknown, context?: { source?: string }) => unknown,
      ) => unknown;
      data = parse(body, (key, value, context) => {
        if (
          (key === "user_role_id" || key === "list_role_id") &&
          typeof value === "number" &&
          context?.source
        ) {
          if (!/^-?(?:0|[1-9]\d*)$/.test(context.source)) throw new Error("Invalid identity");
          return BigInt(context.source);
        }
        return value;
      });
    } catch {
      throw new HttpError(400);
    }
  }
  if (data === null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) throw new HttpError(400);
  const value = data as Record<string, unknown>;
  function string(key: string): string {
    const field = value[key];
    if (field == null) return "";
    if (typeof field !== "string") throw new HttpError(400);
    return field;
  }
  function integer(key: string): bigint | null {
    const field = value[key];
    if (field == null) return null;
    const integer =
      typeof field === "bigint"
        ? field
        : typeof field === "number" && Number.isSafeInteger(field)
          ? BigInt(field)
          : null;
    if (integer === null || integer < -9223372036854775808n || integer > 9223372036854775807n)
      throw new HttpError(400);
    return integer;
  }
  if (value.password_login != null && typeof value.password_login !== "boolean")
    throw new HttpError(400);
  return {
    username: string("username").trim(),
    name: string("name").trim(),
    email: string("email").trim(),
    password: string("password"),
    type: string("type"),
    status: string("status"),
    passwordLogin: value.password_login === true,
    userRoleId: integer("user_role_id") ?? 0n,
    listRoleId: integer("list_role_id"),
  };
}

function invalid(context: RequestContext, name: string): never {
  throw new HttpError(400, context.app.i18n.Ts("globals.messages.invalidFields", "name", name));
}
function validEmail(value: string): boolean {
  const separator = value.indexOf("@");
  if (separator <= 0 || separator >= value.length - 1 || value.indexOf("@", separator + 1) !== -1)
    return false;
  const local = value.slice(0, separator),
    domain = value.slice(separator + 1);
  const atom = (part: string) =>
    !part.startsWith(".") &&
    !part.endsWith(".") &&
    !part.includes("..") &&
    ![...part].some((character) => {
      const code = character.codePointAt(0)!;
      return (
        code <= 32 || code === 127 || /\s/.test(character) || '<>(),:;[]\\"'.includes(character)
      );
    });
  if (!atom(local)) return false;
  if (domain.startsWith("[") && domain.endsWith("]")) {
    const literal = domain.slice(1, -1);
    return isIP(literal) === 4;
  }
  return atom(domain);
}
function validateCommon(context: RequestContext, input: Input, create: boolean): void {
  if ((create || input.type !== "") && input.type !== "user" && input.type !== "api")
    invalid(context, "type");
  if ((create || input.status !== "") && input.status !== "enabled" && input.status !== "disabled")
    invalid(context, "status");
  if (!strHasLen(input.username, 3, 2000) || !/^[a-zA-Z0-9_\-.@]+$/.test(input.username))
    invalid(context, "username");
  if (input.type !== "api" && !validEmail(input.email.toLowerCase())) invalid(context, "email");
}
function randomToken(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  while (out.length < 48)
    for (const byte of randomBytes(64)) {
      if (byte < 248) out += alphabet[byte % 62];
      if (out.length === 48) break;
    }
  return out;
}
function current(context: RequestContext): Identity {
  if (!context.identity) throw new Error("Authenticated identity is required");
  return context.identity;
}
function needSuper(context: RequestContext): never {
  throw new HttpError(400, context.app.i18n.T("users.needSuper"));
}
function storageFailure(
  error: unknown,
  action: "creating" | "updating",
  fields: UserFields,
): never {
  if (error instanceof Error) {
    for (const column of ["username", "email"] as const) {
      if (error.message.includes(`UNIQUE constraint failed: users.${column}`)) {
        throw new HttpError(
          500,
          `Error ${action} User: pq: duplicate key value violates unique constraint "users_${column}_key" (23505). Key (${column})=(${fields[column]}) already exists.`,
        );
      }
    }
  }
  throw new HttpError(500, `Error ${action} User`);
}

export function createUserHandlers(store: UserStore, roles: Roles, auth: Authentication) {
  const getUser: Handler = (context) => {
    const user = store.byId(BigInt(getID(context)));
    if (!user)
      throw new HttpError(
        404,
        context.app.i18n.Ts("globals.messages.notFound", "name", "{globals.terms.user}"),
      );
    return ok(projectUser(user, roles));
  };
  const getUsers: Handler = (context) =>
    ok(
      store
        .list(
          context.url.searchParams.get("order_by") ?? "",
          context.url.searchParams.get("order") ?? "",
        )
        .map((user) => projectUser(user, roles, undefined, true)),
    );
  const getProfile: Handler = (context) => ok(projectUser(current(context).user, roles));
  const createUser: Handler = async (context) => {
    const input = await readJSON(context.request);
    validateCommon(context, input, true);
    if (input.type === "user" && input.passwordLogin && !strHasLen(input.password, 8, 2000))
      invalid(context, "password");
    if (
      !roles.hasRole(input.userRoleId, "user") ||
      (input.listRoleId !== null && !roles.hasRole(input.listRoleId, "list"))
    )
      throw new HttpError(400, "invalid role");
    const token = input.type === "api" ? randomToken() : undefined;
    const password = token
      ? createHash("sha256").update(token).digest("hex")
      : input.passwordLogin
        ? await auth.hash(input.password)
        : null;
    const fields: UserFields = {
      username: input.username,
      name: input.name || input.username,
      email: token ? `${input.username}@api` : input.email.toLowerCase(),
      type: input.type as "user" | "api",
      status: input.status as "enabled" | "disabled",
      passwordLogin: token ? false : input.passwordLogin,
      password,
      userRoleId: input.userRoleId,
      listRoleId: input.listRoleId,
    };
    auth.revalidate(context, "users:manage");
    let created;
    try {
      created = store.create(fields);
    } catch (error) {
      storageFailure(error, "creating", fields);
    }
    return ok(projectUser(created, roles, token));
  };
  const updateUser: Handler = async (context) => {
    const input = await readJSON(context.request);
    validateCommon(context, input, false);
    const id = BigInt(getID(context));
    if (
      input.type !== "api" &&
      input.passwordLogin &&
      input.password &&
      !strHasLen(input.password, 8, 2000)
    )
      invalid(context, "password");
    const previous = store.byId(id);
    if (!previous && input.type !== "api" && input.passwordLogin && !input.password)
      throw new HttpError(
        404,
        context.app.i18n.Ts("globals.messages.notFound", "name", "{globals.terms.user}"),
      );
    if (!previous) needSuper(context);
    const type = (input.type || previous.type) as "user" | "api";
    if (
      input.type !== "api" &&
      input.passwordLogin &&
      !input.password &&
      (!previous.password || (previous.type === "api" && type === "user"))
    )
      invalid(context, "password");
    const userRoleId = input.userRoleId === 0n ? previous.user_role_id : input.userRoleId;
    if (
      !roles.hasRole(userRoleId, "user") ||
      (input.listRoleId !== null &&
        input.listRoleId !== 0n &&
        !roles.hasRole(input.listRoleId, "list"))
    )
      throw new HttpError(400, "invalid role");
    const password =
      type === "api"
        ? previous.type === "api"
          ? previous.password
          : null
        : input.passwordLogin
          ? input.password
            ? await auth.hash(input.password)
            : previous.password
          : null;
    const fields: UserFields = {
      username: input.username,
      name: input.name || input.username,
      email: input.email.toLowerCase() || previous.email,
      type,
      status: (input.status || previous.status) as "enabled" | "disabled",
      passwordLogin: type === "api" ? false : input.passwordLogin,
      password,
      userRoleId,
      listRoleId: input.listRoleId === 0n ? previous.list_role_id : input.listRoleId,
    };
    auth.revalidate(context, "users:manage");
    let updated;
    try {
      updated = store.update(id, fields);
    } catch (error) {
      storageFailure(error, "updating", fields);
    }
    if (!updated) needSuper(context);
    return ok(projectUser(updated, roles));
  };
  const updateProfile: Handler = async (context) => {
    const input = await readJSON(context.request);
    const principal = current(context);
    const previous = principal.user;
    if (previous.type === "user" && previous.password_login !== 0n) {
      if (!validEmail(input.email)) invalid(context, "email");
      if (input.password && !strHasLen(input.password, 8, 2000)) invalid(context, "password");
    }
    const hash =
      previous.type === "user" && previous.password_login !== 0n && input.password
        ? await auth.hash(input.password)
        : null;
    auth.revalidate(context);
    const updated = store.updateProfile(
      previous.id,
      input.name,
      input.email,
      hash,
      principal.sessionId ?? "",
    );
    if (!updated)
      throw new HttpError(
        400,
        context.app.i18n.Ts("globals.messages.notFound", "name", "{globals.terms.user}"),
      );
    return ok(projectUser(updated, roles));
  };
  const deleteUser: Handler = (context) => {
    if (!store.delete([BigInt(getID(context))])) needSuper(context);
    return ok(true);
  };
  const deleteUsers: Handler = (context) => {
    const ids: bigint[] = [];
    for (const value of context.url.searchParams.getAll("id")) {
      if (!value) continue;
      if (!/^[+-]?\d+$/.test(value)) throw new HttpError(400, "invalid ID");
      const id = BigInt(value);
      if (id < -9223372036854775808n || id > 9223372036854775807n)
        throw new HttpError(400, "invalid ID");
      ids.push(id);
    }
    if (!store.delete(ids)) needSuper(context);
    return ok(true);
  };
  return {
    getUser,
    getUsers,
    getProfile,
    createUser,
    updateUser,
    updateProfile,
    deleteUser,
    deleteUsers,
  };
}
