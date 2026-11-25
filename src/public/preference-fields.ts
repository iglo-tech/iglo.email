// The preference center's profile fields (B147, D160): the subscriber attributes a manage view shows and
// lets subscribers edit, as the project setting `privacy.preference_fields` lists them. Native: listmonk's
// manage view (cmd/public.go SubscriptionPrefs at 6fcd95f) edits the name only.
import { trimSpace } from "@/lists/store";
import { parseBool } from "@/public/form";
import type { PreferenceForm } from "@/public/form";
import { HttpError } from "@/server/response";

export type PreferenceFieldType = "text" | "number" | "boolean" | "date" | "select";

export interface PreferenceField {
  /** The `attribs` key the field reads and writes. */
  key: string;
  label: string;
  type: PreferenceFieldType;
  /** Shown read-only when false; the save never writes it. */
  editable: boolean;
  required: boolean;
  /** Text: the length range in characters. Number: the value range. Null is unbounded (text: 1,000). */
  min: number | null;
  max: number | null;
  /** The allowed values of a `select` field; empty for every other type. */
  options: Array<string>;
}

/** The binding shape of one field, for the settings binder (null: a whole number or null). */
export const preferenceFieldShape = {
  key: "",
  label: "",
  type: "",
  editable: false,
  required: false,
  min: null,
  max: null,
  options: [""],
};

const types = new Set<string>(["text", "number", "boolean", "date", "select"]);
const isType = (value: string): value is PreferenceFieldType => types.has(value);
export const maxPreferenceFields = 20;
/** The longest text value a field takes, whatever its own maximum. */
export const textLimit = 1000;
const maxOptions = 50;
const labelLimit = 200;
const keyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const numberPattern = /^-?\d{1,15}(?:\.\d{1,15})?$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const chars = (value: string) => Array.from(value).length;

/** One field as the settings binder hands it over: the shape above, each member still unchecked. */
export interface BoundPreferenceField {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  editable?: unknown;
  required?: unknown;
  min?: unknown;
  max?: unknown;
  options?: unknown;
}

/** A stored or submitted profile value. */
export type ProfileValue = string | number | boolean;

const fail = (message: string): never => {
  throw new HttpError(400, `Invalid privacy.preference_fields: ${message}.`);
};
const trimmed = (value: unknown) => (typeof value === "string" ? trimSpace(value) : "");
/** A bound limit: a finite number, or null for none. */
const limit = (key: string, value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(`${key}: min and max are numbers`);
};
const optionList = (value: unknown): Array<string> =>
  (Array.isArray(value) ? value : []).map(trimmed);

/** Checks and normalizes a save of `privacy.preference_fields`; throws a 400 naming the problem. */
export function normalizePreferenceFields(
  raw: ReadonlyArray<BoundPreferenceField> | null,
): Array<PreferenceField> {
  const items = raw ?? [];
  if (items.length > maxPreferenceFields) {
    fail(`at most ${maxPreferenceFields} fields are allowed`);
  }
  const seen = new Set<string>();
  return items.map((item, index) => {
    const key = trimmed(item.key);
    if (!keyPattern.test(key)) {
      fail(
        `field ${index + 1}: a key is 1 to 64 letters, digits or underscores and does not start with a digit`,
      );
    }
    if (seen.has(key)) {
      fail(`the key ${key} is used twice`);
    }
    seen.add(key);
    const label = trimmed(item.label) || key;
    if (chars(label) > labelLimit || label.includes("\0")) {
      fail(`${key}: a label is at most ${labelLimit} characters`);
    }
    const type = trimmed(item.type);
    if (!isType(type)) {
      return fail(`${key}: the type must be text, number, boolean, date or select`);
    }
    const min = limit(key, item.min);
    const max = limit(key, item.max);
    if (min !== null && max !== null && min > max) {
      fail(`${key}: min is greater than max`);
    }
    if (type === "text" && [min, max].some((v) => v !== null && (v < 0 || v > textLimit))) {
      fail(`${key}: a text length is from 0 to ${textLimit}`);
    }
    if (type !== "text" && type !== "number" && (min !== null || max !== null)) {
      fail(`${key}: min and max apply to text and number fields only`);
    }
    const required = item.required === true;
    if (type === "boolean" && required) {
      fail(`${key}: a boolean field cannot be required`);
    }
    const options = optionList(item.options);
    if (type === "select") {
      if (!options.length || options.length > maxOptions) {
        fail(`${key}: a select field has 1 to ${maxOptions} options`);
      }
      if (options.some((option) => !option || chars(option) > labelLimit)) {
        fail(`${key}: an option is 1 to ${labelLimit} characters`);
      }
      if (new Set(options).size !== options.length) {
        fail(`${key}: an option is listed twice`);
      }
    } else if (options.length) {
      fail(`${key}: options apply to select fields only`);
    }
    return {
      key,
      label,
      type,
      editable: item.editable === true,
      required,
      min,
      max,
      options,
    };
  });
}

/** Whether `value` is a calendar date written YYYY-MM-DD. */
export function calendarDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** What a save writes: the values to set and the keys to remove; or the first field it refuses. */
export type ProfileChange =
  | { ok: true; values: Map<string, ProfileValue>; removed: Array<string> }
  | { ok: false; field: PreferenceField };

/**
 * The stored values of `fields` in a subscriber's attributes JSON, for the manage view: a string, number
 * or boolean; any other stored value is left out, so its field shows empty.
 */
export function storedProfile(
  attribs: string,
  fields: ReadonlyArray<PreferenceField>,
): Map<string, ProfileValue> {
  const parsed: unknown = JSON.parse(attribs);
  const values = new Map<string, ProfileValue>();
  if (typeof parsed !== "object" || parsed === null) {
    return values;
  }
  const stored = new Map<string, unknown>(Object.entries(parsed));
  for (const field of fields) {
    const value = stored.get(field.key);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values.set(field.key, value);
    }
  }
  return values;
}

/**
 * Reads the editable fields of a submitted profile. Every editable field is read: an absent value is empty,
 * which removes an optional field, refuses a required one, and is false for a boolean. A key that is not an
 * editable field is never read, so it is never written.
 */
export function readProfile(
  fields: Array<PreferenceField>,
  form: Pick<PreferenceForm, "attrib">,
): ProfileChange {
  const values = new Map<string, ProfileValue>();
  const removed: Array<string> = [];
  for (const field of fields) {
    if (!field.editable) {
      continue;
    }
    const raw = form.attrib(field.key);
    const refused = { ok: false as const, field };
    if (field.type === "boolean") {
      const checked = typeof raw === "boolean" ? raw : parseBool(raw ?? "");
      if (checked === undefined) {
        return refused;
      }
      values.set(field.key, checked);
      continue;
    }
    if (field.type === "number" && typeof raw === "number") {
      if (
        !Number.isFinite(raw) ||
        (field.min !== null && raw < field.min) ||
        (field.max !== null && raw > field.max)
      ) {
        return refused;
      }
      values.set(field.key, raw);
      continue;
    }
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return refused;
    }
    const text = trimSpace(raw ?? "");
    if (!text) {
      if (field.required) {
        return refused;
      }
      removed.push(field.key);
      continue;
    }
    if (text.includes("\0")) {
      return refused;
    }
    if (field.type === "text") {
      const length = chars(text);
      if (
        length > Math.min(field.max ?? textLimit, textLimit) ||
        (field.min !== null && length < field.min)
      ) {
        return refused;
      }
      values.set(field.key, text);
    } else if (field.type === "number") {
      const number = Number(text);
      if (
        !numberPattern.test(text) ||
        !Number.isFinite(number) ||
        (field.min !== null && number < field.min) ||
        (field.max !== null && number > field.max)
      ) {
        return refused;
      }
      values.set(field.key, number);
    } else if (field.type === "date") {
      if (!calendarDate(text)) {
        return refused;
      }
      values.set(field.key, text);
    } else {
      if (!field.options.includes(text)) {
        return refused;
      }
      values.set(field.key, text);
    }
  }
  return { ok: true, values, removed };
}
