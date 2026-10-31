// A JSON Schema subset for checking responses against the served document. It stays in tests, and
// a keyword it does not know fails, so a schema can never pass by being misread.
type Schema = Record<string, unknown> | boolean;
export interface Document {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, any> };
  [key: string]: any;
}

const annotations = new Set([
  "description",
  "title",
  "example",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const keywords = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "contentMediaType",
]);
const formats: Record<string, (value: string) => boolean> = {
  "date-time": (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  uuid: (value) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value),
  uri: (value) => URL.canParse(value),
  email: (value) => /^[^@\s]+@[^@\s]+$/.test(value),
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return Number.isInteger(value);
  return typeOf(value) === type;
}

/**
 * Returns the problems of `value`, an empty list when it fits. Responses are read strictly: an
 * object property the schema does not name is a problem, unless the schema opts in with
 * `additionalProperties`, so a response cannot grow a field the document leaves out.
 */
export function validate(
  document: Document,
  root: object | boolean,
  value: unknown,
  path = "$",
  depth = 0,
  visited?: Set<string>,
): string[] {
  if (depth > 64) throw new Error(`Schema nests too deeply at ${path}`);
  if (root === true) return [];
  if (root === false) return [`${path}: not allowed`];
  const schema = root as Record<string, unknown>;
  for (const key of Object.keys(schema))
    if (!keywords.has(key) && !annotations.has(key))
      throw new Error(`Unknown schema keyword ${key} at ${path}`);
  const problems: string[] = [];
  const next = (inner: Schema, item: unknown, at: string) =>
    validate(document, inner, item, at, depth + 1, visited);

  if (typeof schema.$ref === "string") {
    const name = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)?.[1];
    const target = name === undefined ? undefined : document.components.schemas[name];
    if (target === undefined) throw new Error(`Unresolved ${schema.$ref} at ${path}`);
    visited?.add(name!);
    problems.push(...next(target, value, path));
  }
  const types = schema.type === undefined ? undefined : [schema.type as string | string[]].flat();
  if (types && !types.some((type) => matchesType(value, type)))
    return [`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value))
    problems.push(`${path}: ${JSON.stringify(value)} is not in the enum`);
  if ("const" in schema && !Bun.deepEquals(schema.const, value))
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.oneOf !== undefined) {
    const fits = (schema.oneOf as Schema[]).map((inner) => next(inner, value, path));
    if (fits.filter((items) => items.length === 0).length !== 1)
      problems.push(
        `${path}: expected exactly one branch of oneOf: ${fits.map((items) => items[0] ?? "ok").join(" | ")}`,
      );
  }
  if (schema.anyOf !== undefined) {
    const fits = (schema.anyOf as Schema[]).map((inner) => next(inner, value, path));
    if (!fits.some((items) => items.length === 0))
      problems.push(`${path}: no branch of anyOf: ${fits.map((items) => items[0]).join(" | ")}`);
  }
  if (typeof value === "string") {
    const check = schema.format === undefined ? undefined : formats[schema.format as string];
    if (schema.format !== undefined && !check)
      throw new Error(`Unknown format ${String(schema.format)} at ${path}`);
    if (check && !check(value)) problems.push(`${path}: ${value} is not ${schema.format}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string).test(value))
      problems.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < (schema.minLength as number))
      problems.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number))
      problems.push(`${path}: too long`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < (schema.minimum as number))
      problems.push(`${path}: below the minimum`);
    if (schema.maximum !== undefined && value > (schema.maximum as number))
      problems.push(`${path}: above the maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number))
      problems.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number))
      problems.push(`${path}: too many items`);
    if (schema.items !== undefined)
      value.forEach((item, index) =>
        problems.push(...next(schema.items as Schema, item, `${path}[${index}]`)),
      );
  }
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of (schema.required ?? []) as string[])
      if (!Object.hasOwn(object, name)) problems.push(`${path}.${name}: required`);
    for (const [name, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, name))
        problems.push(...next(properties[name]!, item, `${path}.${name}`));
      else if (schema.additionalProperties !== undefined)
        problems.push(...next(schema.additionalProperties as Schema, item, `${path}.${name}`));
      else if (schema.$ref === undefined && !schema.oneOf && !schema.anyOf)
        problems.push(`${path}.${name}: not in the document`);
    }
  }
  return problems;
}
