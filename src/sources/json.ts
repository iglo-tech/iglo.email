// Native (D170): the JSON a source answers with, typed at the boundary. A parsed body is walked once
// into these types; nothing reads it before. Object keys become own properties (`__proto__`
// included), and nesting deeper than `MAX_DEPTH` is refused rather than walked.

export type SourceJson =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<SourceJson>
  | SourceObject;
export interface SourceObject {
  readonly [name: string]: SourceJson;
}

const MAX_DEPTH = 64;

/** The parsed value as `SourceJson`, or `undefined` when it nests deeper than the limit. */
export function sourceJson(value: unknown): SourceJson | undefined {
  let deep = false;
  const walk = (item: unknown, depth: number): SourceJson => {
    if (depth > MAX_DEPTH) {
      deep = true;
      return null;
    }
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      typeof item === "number"
    ) {
      return item;
    }
    if (Array.isArray(item)) {
      return item.map((child) => walk(child, depth + 1));
    }
    if (typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([name, child]) => [name, walk(child, depth + 1)]),
      );
    }
    return null;
  };
  const result = walk(value, 0);
  return deep ? undefined : result;
}

export const isSourceList = (value: SourceJson | undefined): value is ReadonlyArray<SourceJson> =>
  Array.isArray(value);

export const isSourceObject = (value: SourceJson | undefined): value is SourceObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A member of an object answer, or `undefined`. */
export const member = (value: SourceJson | undefined, name: string): SourceJson | undefined =>
  isSourceObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;
