// Focused reference cases for listmonk's cmd/handlers.go and cmd/lists.go.
// Run via reference:run; credentials and service origin are synthetic per run.
const origin = process.env.REFERENCE_URL;
const user = process.env.REFERENCE_API_USER;
const token = process.env.REFERENCE_API_TOKEN;
if (!origin || !user || !token) throw new Error("The reference runner environment is required");

interface ReferenceCase {
  label: string;
  path: string;
  method?: string;
  body?: string;
  authenticated?: boolean;
  status: number;
  contentType: string | null;
  response?: string;
}

const cases: ReferenceCase[] = [
  {
    label: "health",
    path: "/health",
    status: 200,
    contentType: "application/json",
    response: '{"data":true}\n',
  },
  {
    label: "unknown API",
    path: "/api/does-not-exist",
    status: 404,
    contentType: "application/json",
    response: '{"message":"404 unknown endpoint"}\n',
  },
  {
    label: "unknown API HEAD",
    path: "/api/does-not-exist",
    method: "HEAD",
    status: 404,
    contentType: null,
    response: "",
  },
  {
    label: "unknown API POST",
    path: "/api/does-not-exist",
    method: "POST",
    status: 404,
    contentType: "application/json",
    response: '{"message":"404 unknown endpoint"}\n',
  },
  {
    label: "health HEAD",
    path: "/health",
    method: "HEAD",
    status: 404,
    contentType: "text/html; charset=UTF-8",
    response: "",
  },
  {
    label: "health POST",
    path: "/health",
    method: "POST",
    status: 404,
    contentType: "text/html; charset=UTF-8",
  },
  {
    label: "invalid ID",
    path: "/api/lists/not-an-id",
    authenticated: true,
    status: 400,
    contentType: "application/json",
    response: '{"message":"invalid ID"}\n',
  },
  {
    label: "invalid field",
    path: "/api/lists",
    method: "POST",
    body: '{"name":""}',
    authenticated: true,
    status: 400,
    contentType: "application/json",
    response: '{"message":"Invalid name."}\n',
  },
  {
    label: "invalid enum field",
    path: "/api/lists",
    method: "POST",
    body: '{"name":"ok","type":"bad"}',
    authenticated: true,
    status: 400,
    contentType: "application/json",
    response: '{"message":"Invalid fields: type"}\n',
  },
  {
    label: "malformed JSON",
    path: "/api/lists",
    method: "POST",
    body: "{",
    authenticated: true,
    status: 400,
    contentType: "application/json",
    response: '{"message":"Bad Request"}\n',
  },
  {
    label: "API method mismatch",
    path: "/api/lists/not-an-id",
    method: "POST",
    authenticated: true,
    status: 404,
    contentType: "application/json",
    response: '{"message":"404 unknown endpoint"}\n',
  },
];

for (const item of cases) {
  const headers = new Headers();
  if (item.authenticated) headers.set("Authorization", `Basic ${btoa(`${user}:${token}`)}`);
  if (item.body !== undefined) headers.set("Content-Type", "application/json");
  const result = await fetch(new URL(item.path, origin), {
    method: item.method ?? "GET",
    headers,
    ...(item.body === undefined ? {} : { body: item.body }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await result.text();
  const contentType = result.headers.get("content-type");
  if (
    result.status !== item.status ||
    contentType !== item.contentType ||
    (item.response !== undefined && body !== item.response)
  ) {
    throw new Error(
      `${item.label}: got ${result.status}, ${contentType}, ${JSON.stringify(body)}; expected ${item.status}, ${item.contentType}, ${JSON.stringify(item.response)}`,
    );
  }
  console.log(
    `${item.label}: ${result.status} ${contentType}${item.response === undefined ? " (HTML body deferred)" : ` ${JSON.stringify(body)}`}`,
  );
}

export {};
