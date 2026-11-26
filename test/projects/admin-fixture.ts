// B140: the instance login and handoff as a browser makes them, over 127.0.0.1 with an explicit
// Host header (test/projects/fixture.ts `request`).
import { request } from "@/test/projects/fixture";
import type { Credentials, Session } from "@/test/projects/fixture";
import { totp } from "@/test/e2e/totp";

export interface InstanceSession {
  /** `instance_session=…; instance_csrf=…` */
  readonly cookie: string;
  readonly csrf: string;
}

/** The cookies a response set, as `name=value` pairs, cleared ones included. */
export function setCookies(response: Response): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    pairs.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return pairs;
}

/**
 * Posts the instance login form on `host`; with a TOTP secret, continues through the second step.
 * Returns the final response and the instance session it set, if any. `peer` is sent as
 * `X-Forwarded-For`: with loopback in `security.trusted_proxies` it is the login limit's client
 * address, so a file's tests need not share one address's 20 attempts a minute (B155a).
 */
export async function instanceLogin(
  port: number,
  host: string,
  credentials: Credentials,
  options: { next?: string; secret?: string; peer?: string } = {},
): Promise<{ response: Response; session?: InstanceSession; body: string }> {
  const forwarded: Record<string, string> = options.peer ? { "x-forwarded-for": options.peer } : {};
  const page = await request(port, host, "/admin/instance/login", { headers: forwarded });
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const nonceCookie = `instance_nonce=${setCookies(page).get("instance_nonce") ?? ""}`;
  let response = await request(port, host, "/admin/instance/login", {
    method: "POST",
    headers: {
      ...forwarded,
      cookie: nonceCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      nonce,
      username: credentials.user,
      password: credentials.password,
      next: options.next ?? "",
    }).toString(),
  });
  const location = response.headers.get("location") ?? "";
  if (response.status === 302 && location.startsWith("/admin/instance/login/twofa?")) {
    const step = await request(port, host, location, { headers: forwarded });
    const html = await step.text();
    const stepNonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const token = /name="token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const next = /name="next" value="([^"]+)"/.exec(html)?.[1] ?? "";
    if (!options.secret) {
      return { response, body: html };
    }
    response = await request(port, host, "/admin/instance/login/twofa", {
      method: "POST",
      headers: {
        ...forwarded,
        cookie: `instance_nonce=${setCookies(step).get("instance_nonce") ?? ""}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        nonce: stepNonce,
        token,
        next,
        totp_code: totp(options.secret),
      }).toString(),
    });
  }
  const cookies = setCookies(response);
  const id = cookies.get("instance_session");
  const csrf = cookies.get("instance_csrf");
  const body = response.status === 302 ? "" : await response.text();
  return id && csrf
    ? { response, body, session: { cookie: `instance_session=${id}; instance_csrf=${csrf}`, csrf } }
    : { response, body };
}

/** An instance JSON call with the session and its CSRF token. */
export function instanceCall(
  port: number,
  host: string,
  session: InstanceSession,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    cookie: session.cookie,
    "x-csrf-token": session.csrf,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return request(port, host, path, init);
}

/** Follows the handoff to project `slug`: the open on the instance host, then the redemption. */
export async function handoff(
  port: number,
  instanceHost: string,
  session: InstanceSession,
  slug: string,
  next = "/admin",
) {
  const open = await request(
    port,
    instanceHost,
    `/admin/instance/open/${slug}?${new URLSearchParams({ next })}`,
    { headers: { cookie: session.cookie } },
  );
  const target = new URL(open.headers.get("location") ?? "http://invalid/");
  const redeemed = await request(port, target.host, target.pathname + target.search);
  const cookies = setCookies(redeemed);
  const id = cookies.get("session");
  const csrf = cookies.get("csrf");
  const project: Session | undefined =
    id && csrf ? { cookie: `session=${id}; csrf=${csrf}`, csrf } : undefined;
  return { open, target, redeemed, project };
}
