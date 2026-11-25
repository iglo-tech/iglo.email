// B139 (D154): a test's way to the instance keys of a running executable. The instance settings API
// takes only an instance session with its CSRF token (14-projects sections 4 and 5), so this logs in
// through the instance login form, as a browser does, and calls /api/instance/settings with the
// session. One install's instance host is `--root-url`'s, and an unclaimed host reaches the instance
// routes too, so `origin` may be either.

import { asBody, readJson } from "@/test/read-body";

export interface AdminCredentials {
  readonly user: string;
  readonly password: string;
}

function cookies(response: Response): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    pairs.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return pairs;
}

async function ensure(response: Response, what: string): Promise<void> {
  if (response.status !== 200) {
    throw new Error(`${what}: ${response.status} ${await response.text()}`);
  }
}

export interface InstanceClient {
  /** The session's cookie header and CSRF token, for a request a caller builds itself. */
  credentials(): { cookie: string; csrf: string };
  /** A JSON call under the instance session; a body is sent as JSON. */
  call(path: string, method?: string, body?: unknown): Promise<Response>;
  /** The masked instance keys. */
  read(): Promise<Record<string, any>>;
  /** `PUT /api/instance/settings/<key>`; throws unless it answers 200. */
  put(key: string, value: unknown): Promise<void>;
  /** The current keys with `change` applied, written as one full `PUT`; throws unless 200. */
  update(change: (current: Record<string, any>) => Record<string, any>): Promise<void>;
  /** `{ smtp }` pointed at a plain loopback sink, as the tests' SMTP fixtures expect. */
  useSink(port: number, extra?: Record<string, unknown>): Promise<void>;
}

/** Logs in to the instance at `origin` with the admin account and returns a client for it. */
export async function instanceClient(
  origin: string,
  admin: AdminCredentials,
  headers: Record<string, string> = {},
): Promise<InstanceClient> {
  const page = await fetch(`${origin}/admin/instance/login`, { headers });
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const login = await fetch(`${origin}/admin/instance/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...headers,
      cookie: `instance_nonce=${cookies(page).get("instance_nonce") ?? ""}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      nonce,
      username: admin.user,
      password: admin.password,
      next: "",
    }).toString(),
  });
  const set = cookies(login);
  const session = set.get("instance_session");
  const csrf = set.get("instance_csrf");
  if (!session || !csrf) {
    throw new Error(`instance login failed: ${login.status}`);
  }
  const cookie = `instance_session=${session}; instance_csrf=${csrf}`;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        ...headers,
        cookie,
        "x-csrf-token": csrf,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = async () =>
    (await readJson<{ data: Record<string, any> }>(await call("/api/instance/settings"))).data;
  const client: InstanceClient = {
    credentials: () => ({ cookie, csrf }),
    call,
    read,
    async put(key, value) {
      await ensure(await call(`/api/instance/settings/${key}`, "PUT", value), `PUT ${key}`);
    },
    async update(change) {
      await ensure(
        await call("/api/instance/settings", "PUT", change(await read())),
        "PUT /api/instance/settings",
      );
    },
    async useSink(port, extra = {}) {
      const current = await read();
      const smtp = asBody<Array<Record<string, unknown>>>(current.smtp).map((item, index) =>
        index === 0
          ? {
              ...item,
              enabled: true,
              host: "127.0.0.1",
              port,
              tls_type: "none",
              auth_protocol: "none",
              ...extra,
            }
          : item,
      );
      await client.put("smtp", smtp);
    },
  };
  return client;
}
