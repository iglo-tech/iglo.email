// Typed reads of what a test receives from outside: a parsed JSON body (an HTTP response or request), an MCP tool result,
// a mail or a webhook body. Once parsed each is `any` or `unknown`, and the test names the shape it expects with a type
// argument; the assertions that then read its fields check the values. These are the only casts for those reads, so a
// wrong shape fails the assertion that reads it, the same as before.

// Anything with a JSON body reader: a Response, a Request, or a fixture's stand-in for either.
export interface JsonSource {
  json(): Promise<unknown>;
}

// Parses the JSON body of a response (or request) as T.
export async function readJson<T>(source: JsonSource): Promise<T> {
  return asBody<T>(await source.json());
}

// Types a value the test has already received or parsed (an MCP structured result, a stored row, a mail body) as T, or
// a value it builds outside T on purpose to check that the code under test refuses it.
export function asBody<T>(value: unknown): T {
  return value as T;
}
