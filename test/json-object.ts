// JSON values that test fixtures build, spread into request bodies and send. The types name what a test sends, so a
// fixture takes a concrete payload type instead of `object`. They are not a boundary for parsed input: responses
// and mail stay `unknown` until a test reads them.
export type JsonValue = string | number | boolean | null | Array<JsonValue> | JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };
