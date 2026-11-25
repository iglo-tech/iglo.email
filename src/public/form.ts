// Public form binding, adapted from Echo's DefaultBinder as listmonk's public handlers use it
// (cmd/public.go) at 6fcd95f: url-encoded, multipart or JSON bodies within the shared limit.
import { must } from "@/invariant";
import { readBodyBytes } from "@/users/input";

export interface Fields {
  get(name: string): unknown;
  /** Repeated form values, or the JSON array under its different JSON name. */
  list(form: string, json: string): Array<string>;
}

/** Go strconv.ParseBool, with Echo's empty-value-is-false form binding. */
export function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "" || value === false) {
    return false;
  }
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) {
    return true;
  }
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) {
    return false;
  }
  return undefined;
}

const strings = (values: Array<unknown>) => {
  if (values.some((value) => typeof value !== "string")) {
    throw new Error("list");
  }
  return values as Array<string>;
};

/** Throws HttpError for an oversized body and a plain Error for an unusable one. */
export async function readFields(request: Request): Promise<Fields> {
  const bytes = await readBodyBytes(request);
  const media = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!bytes.length) {
    return { get: () => undefined, list: () => [] };
  }
  if (media === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(bytes.toString("utf-8"));
    return { get: (name) => form.get(name) ?? undefined, list: (name) => form.getAll(name) };
  }
  if (media === "multipart/form-data") {
    const form = await new Request("http://form.invalid", {
      method: "POST",
      headers: { "content-type": must(request.headers.get("content-type"), "content type") },
      body: Uint8Array.from(bytes),
    }).formData();
    return {
      get(name) {
        const value = form.get(name);
        return value === null ? undefined : typeof value === "string" ? value : 0;
      },
      list: (name) => strings(form.getAll(name)),
    };
  }
  if (media === "application/json") {
    const value = JSON.parse(bytes.toString("utf-8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body");
    }
    const record = value as Record<string, unknown>;
    return {
      get: (name) => record[name],
      list(_, json) {
        const items = record[json];
        if (items === undefined || items === null) {
          return [];
        }
        if (!Array.isArray(items)) {
          throw new Error("list");
        }
        return strings(items);
      },
    };
  }
  throw new Error("media");
}

export interface PreferenceForm {
  blocklist: boolean;
  manage: boolean;
  name: string;
  lists: Array<string>;
  /**
   * B147 (D160): whether the save carries the profile fields: a form's `profile=true` (the manage view's
   * hidden field), or a JSON body's `attribs` object. Without it the stored attributes are not read.
   */
  profile: boolean;
  /** A submitted profile value: a form's `attribs.<key>`, or a JSON body's `attribs.<key>`. */
  attrib(key: string): unknown;
}

/** The body of SubscriptionPrefs, with the preference center's profile (B147, D160). */
export async function readPreferences(request: Request): Promise<PreferenceForm> {
  const fields = await readFields(request);
  const blocklist = parseBool(fields.get("blocklist"));
  const manage = parseBool(fields.get("manage"));
  const name = fields.get("name") ?? "";
  if (blocklist === undefined || manage === undefined || typeof name !== "string") {
    throw new Error("field");
  }
  // A JSON body's attributes are an object; in a form, a field named `attribs` is not one and is ignored.
  const attribs = fields.get("attribs");
  const json = attribs !== null && typeof attribs === "object";
  if (json && Array.isArray(attribs)) {
    throw new Error("field");
  }
  const profile = json || parseBool(fields.get("profile")) === true;
  const record = (json ? attribs : {}) as Record<string, unknown>;
  return {
    blocklist,
    manage,
    name,
    lists: fields.list("l", "list_uuids"),
    profile,
    attrib: (key) =>
      json ? (Object.hasOwn(record, key) ? record[key] : undefined) : fields.get(`attribs.${key}`),
  };
}
