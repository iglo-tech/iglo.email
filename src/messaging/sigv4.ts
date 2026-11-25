// AWS Signature Version 4 on Web Crypto (14-projects section 7 and invariant 9, B145a). Native:
// listmonk has no AWS API client, and no AWS SDK is added. It signs with an `Authorization` header,
// as AWS's "Create a signed AWS API request" describes, and matches its published test suite
// (test/messaging/sigv4.test.ts).

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SignInput {
  readonly method: string;
  readonly url: string;
  /** Headers to send and sign. `host` is taken from the URL when it is not given. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly date: Date;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  text: string,
): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(text));
}

/** RFC 3986 encoding: every byte but the unreserved characters, as uppercase `%XX`. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Each path segment decoded once and encoded again, so a path signs as AWS normalizes it. */
function canonicalPath(pathname: string): string {
  const segments: Array<string> = [];
  for (const segment of pathname.split("/").slice(1)) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "." && segment !== "") {
      segments.push(uriEncode(decodeURIComponent(segment)));
    }
  }
  const trailing = pathname.length > 1 && pathname.endsWith("/") && segments.length ? "/" : "";
  return `/${segments.join("/")}${trailing}`;
}

function canonicalQuery(search: URLSearchParams): string {
  return [...search]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** `20150830T123600Z`: the signing time as SigV4 writes it. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** The intermediate texts and the result, so a test can compare each with AWS's suite. */
export async function signParts(input: SignInput) {
  const url = new URL(input.url);
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers.set(name.toLowerCase(), value.trim().replaceAll(/\s+/g, " "));
  }
  if (!headers.has("host")) {
    headers.set("host", url.host);
  }
  headers.set("x-amz-date", stamp);
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    ...names.map((name) => `${name}:${headers.get(name)}`),
    "",
    signedHeaders,
    await sha256(input.body ?? ""),
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256(canonicalRequest)].join(
    "\n",
  );
  let key = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), day);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));
  return {
    canonicalRequest,
    stringToSign,
    signature,
    headers: {
      "x-amz-date": stamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** The headers to add to the request: `x-amz-date` and `authorization`. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  return (await signParts(input)).headers;
}
