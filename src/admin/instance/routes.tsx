// The instance pages on the instance host (14-projects sections 2, 5 and 13; B140, D153). Native:
// listmonk has no instance. `/admin/instance/**` and `/api/instance/**` are answered here, before the
// primary project's router; they never accept API credentials and are not in OpenAPI or MCP.
import { renderAdminShell } from "@/admin/layout/shell";
import { adminPolicy } from "@/admin/policy";
import { render } from "@/jsx/render";
import { PublicShell } from "@/public/layout";
import type { PageSite } from "@/public/layout";
import { assetVersion } from "@/server/asset-manifest";
import type { Handler, Middleware, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import { Router } from "@/server/router";
import { strHasLen } from "@/server/validation";
import { safeNext } from "@/users/handoff";
import type { HandoffTokens } from "@/users/handoff";
import { readBody } from "@/users/input";
import type { InstanceAuth, InstanceSession } from "@/users/instance-auth";
import { validPassword } from "@/users/password";
import { settingsPage } from "@/admin/views/settings";
import type { Translation } from "@/i18n/i18n";
import { settingsHandlers } from "@/settings/routes";
import type { InstanceSettingsStore } from "@/settings/instance";
import type { NavigationLink } from "@/admin/layout/shell";

export const ACCOUNT_PATH = "/admin/instance/account";
export const SETTINGS_PATH = "/admin/instance/settings";
const LOGIN_PATH = "/admin/instance/login";

export interface InstanceRouteDeps {
  readonly auth: InstanceAuth;
  readonly tokens: HandoffTokens;
  /** `--root-url`, without a trailing slash. */
  readonly rootUrl: string;
  /** A served project's root URL by slug, or undefined for a slug no project has. */
  readonly projectRootUrl: (slug: string) => string | undefined;
  /** The instance keys (B139, D154): `/api/instance/settings` and the instance Settings page. */
  readonly settings: InstanceSettingsStore;
  /** The login limit's client address, with security.trusted_proxies; the peer without it. */
  readonly clientAddress?: (context: RequestContext) => string;
  /** The primary project's SMTP test, or undefined without a primary project. */
  readonly smtpTest: () => ((body: unknown, revalidate: () => void) => Promise<void>) | undefined;
}

/** The instance Settings page (B139, D154): the instance keys, in the instance layout. */
export function instanceSettingsPage(i18n: Translation, rootUrl: string): string {
  const view = settingsPage(i18n, "instance", { canManage: true, canUpload: false });
  return renderAdminShell({
    title: view.title,
    siteName: "iglo.email",
    assetVersion,
    i18n,
    script: view.script,
    translationKeys: view.translationKeys,
    config: { ...view.config, root_url: rootUrl, csrf_cookie: "instance_csrf" },
    navigation: instanceNavigation(SETTINGS_PATH),
    children: view.body,
  });
}

/** The instance pages' sidebar, with `current` marked. */
function instanceNavigation(current: string): ReadonlyArray<NavigationLink> {
  return [
    { label: "Account", href: ACCOUNT_PATH, current: current === ACCOUNT_PATH, icon: "user" },
    {
      label: "Instance settings",
      href: SETTINGS_PATH,
      current: current === SETTINGS_PATH,
      icon: "settings",
    },
  ];
}

const htmlHeaders = { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" };

/** After a login: a safe local `next`, else the Account page (the Projects page is B143's). */
function loginNext(value: string | null): string {
  const next = safeNext(value);
  return next === "/admin" && value !== "/admin" ? ACCOUNT_PATH : next;
}

function plainNotFound(): Response {
  return new Response("404 page not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function formFields(context: RequestContext): Promise<URLSearchParams> {
  if (
    context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/x-www-form-urlencoded"
  ) {
    throw new HttpError(415);
  }
  return new URLSearchParams(await readBody(context.request));
}

/** A JSON object body's string fields; any other value of a field reads as empty. */
async function jsonFields(request: Request): Promise<Map<string, string>> {
  const body = await readBody(request);
  if (
    body &&
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
  ) {
    throw new HttpError(415);
  }
  let value: unknown;
  try {
    value = body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400);
  }
  const fields = new Map<string, string>();
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string") {
      fields.set(key, field);
    }
  }
  return fields;
}

// Instance routes never accept API credentials (14-projects section 6): 401, whatever the path.
const noCredentials: Middleware = (context, next) => {
  if (context.request.headers.has("authorization")) {
    throw new HttpError(401, "API credentials are not accepted here", {}, "invalid_credentials");
  }
  return next();
};

export function createInstanceRouter(deps: InstanceRouteDeps): Router {
  const { auth, tokens } = deps;
  const router = new Router();
  const site: PageSite = {
    rootUrl: deps.rootUrl,
    logoUrl: "",
    faviconUrl: "",
    subscriptionPage: false,
    archive: false,
    siteUrl: "",
    accent: "",
    font: "system-sans",
    header: "auto",
    siteName: "iglo.email",
  };

  // Every HTML answer carries the admin pages' policy (D71).
  const policy: Middleware = async (_context, next) => {
    const response = await next();
    if (
      response.headers.get("Content-Type")?.startsWith("text/html") &&
      !response.headers.has("Content-Security-Policy")
    ) {
      response.headers.set("Content-Security-Policy", adminPolicy({ origins: [deps.rootUrl] }));
    }
    return response;
  };
  router.use(noCredentials, policy);

  /** The page's instance session, or a redirect to the login that comes back here. */
  const page =
    (view: (context: RequestContext, session: InstanceSession) => Response | Promise<Response>) =>
    (context: RequestContext) => {
      const session = auth.session(context.request);
      if (!session) {
        const next = new URLSearchParams({ next: context.url.pathname + context.url.search });
        return new Response(null, {
          status: 307,
          headers: { Location: `${LOGIN_PATH}?${next}`, "Cache-Control": "no-store" },
        });
      }
      return view(context, session);
    };
  /** A JSON route: the session, and for a change its Origin and CSRF token. */
  const api =
    (
      handler: (context: RequestContext, session: InstanceSession) => Promise<Response> | Response,
    ) =>
    (context: RequestContext) =>
      handler(context, auth.authorize(context.request));

  function loginPage(context: RequestContext, next: string, message = ""): Response {
    const nonce = auth.nonce();
    const i18n = context.app.i18n;
    const title = i18n.T("globals.buttons.login");
    const body = render(
      <PublicShell title={title} site={site} assetVersion={assetVersion}>
        <section class="login" data-testid="instance-login">
          <h2>{title}</h2>
          {auth.username() === null ? (
            <p>
              The instance has no admin account: start it once with IGLO_EMAIL_ADMIN_USER and
              IGLO_EMAIL_ADMIN_PASSWORD.
            </p>
          ) : null}
          <form method="post" action={LOGIN_PATH} class="form">
            <div>
              <input type="hidden" name="nonce" value={nonce} />
              <input type="hidden" name="next" value={next} />
              <p>
                <label for="username">{i18n.T("globals.fields.username")}</label>
                <input id="username" type="text" name="username" autofocus required minlength="3" />
              </p>
              <p>
                <label for="password">{i18n.T("globals.fields.password")}</label>
                <input id="password" type="password" name="password" required minlength="8" />
              </p>
              {message ? (
                <p>
                  <span class="error">{message}</span>
                </p>
              ) : null}
              <p class="submit">
                <button class="button" type="submit">
                  {title}
                </button>
              </p>
            </div>
          </form>
        </section>
      </PublicShell>,
    );
    return new Response(`<!DOCTYPE html>${body}`, {
      headers: { ...htmlHeaders, "Set-Cookie": auth.nonceCookie(nonce) },
    });
  }

  function twofaPage(context: RequestContext, token: string, next: string, message = "") {
    const nonce = auth.nonce();
    const i18n = context.app.i18n;
    const title = i18n.T("users.twoFA");
    const body = render(
      <PublicShell title={title} site={site} assetVersion={assetVersion}>
        <section class="login">
          <h2>{title}</h2>
          <p>{i18n.T("users.totpCodeHelp")}</p>
          <form method="post" action={`${LOGIN_PATH}/twofa`} class="form">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="next" value={next} />
            <input type="hidden" name="nonce" value={nonce} />
            <div>
              <p>
                <input
                  id="totp_code"
                  name="totp_code"
                  type="text"
                  autofocus
                  required
                  pattern="[0-9]{6}"
                  maxlength="6"
                  placeholder="• • • • • •"
                  aria-label={i18n.T("users.totpCode")}
                />
              </p>
              {message ? (
                <p>
                  <span class="error">{message}</span>
                </p>
              ) : null}
              <p class="submit">
                <button class="button" type="submit">
                  {i18n.T("globals.buttons.continue")}
                </button>
              </p>
            </div>
          </form>
        </section>
      </PublicShell>,
    );
    return new Response(`<!DOCTYPE html>${body}`, {
      headers: { ...htmlHeaders, "Set-Cookie": auth.nonceCookie(nonce) },
    });
  }

  const signedIn = (session: Parameters<InstanceAuth["sessionCookies"]>[0], next: string) => {
    const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
    for (const value of auth.sessionCookies(session)) {
      headers.append("Set-Cookie", value);
    }
    return new Response(null, { status: 302, headers });
  };

  const getLogin: Handler = (context) =>
    loginPage(context, loginNext(context.url.searchParams.get("next")));
  const peer = (context: RequestContext) => deps.clientAddress?.(context) ?? context.peerAddress;
  const postLogin: Handler = async (context) => {
    auth.limit(peer(context));
    auth.checkOrigin(context.request);
    const fields = await formFields(context);
    if (!auth.nonceValid(context.request, fields.get("nonce") ?? "")) {
      throw new HttpError(403, "invalid nonce");
    }
    const i18n = context.app.i18n;
    const username = (fields.get("username") ?? "").trim();
    const password = fields.get("password") ?? "";
    const next = loginNext(fields.get("next"));
    if (!strHasLen(username, 3, 2000)) {
      return loginPage(
        context,
        next,
        i18n.Ts("globals.messages.invalidFields", "name", "username"),
      );
    }
    if (!validPassword(password)) {
      return loginPage(
        context,
        next,
        i18n.Ts("globals.messages.invalidFields", "name", "password"),
      );
    }
    const result = await auth.login(username, password);
    if (!result) {
      return loginPage(context, next, i18n.T("users.invalidLogin"));
    }
    if ("token" in result) {
      const params = new URLSearchParams({ token: result.token, next });
      return new Response(null, {
        status: 302,
        headers: { Location: `${LOGIN_PATH}/twofa?${params}`, "Cache-Control": "no-store" },
      });
    }
    return signedIn(result, next);
  };
  const getTwofa: Handler = (context) => {
    const token = context.url.searchParams.get("token") ?? "";
    if (!auth.challengeExists(token)) {
      return new Response(null, { status: 302, headers: { Location: LOGIN_PATH } });
    }
    return twofaPage(context, token, loginNext(context.url.searchParams.get("next")));
  };
  const postTwofa: Handler = async (context) => {
    auth.limit(peer(context));
    auth.checkOrigin(context.request);
    const fields = await formFields(context);
    if (!auth.nonceValid(context.request, fields.get("nonce") ?? "")) {
      throw new HttpError(403, "invalid nonce");
    }
    const token = fields.get("token") ?? "";
    if (!auth.challengeExists(token)) {
      return new Response(null, { status: 302, headers: { Location: LOGIN_PATH } });
    }
    const next = loginNext(fields.get("next"));
    const session = auth.verifyChallenge(token, (fields.get("totp_code") ?? "").trim());
    if (!session) {
      return twofaPage(context, token, next, context.app.i18n.T("globals.messages.invalidValue"));
    }
    return signedIn(session, next);
  };

  const account = page((context) => {
    const i18n = context.app.i18n;
    const username = auth.username() ?? "";
    const totp = auth.twofa() === "totp";
    const html = renderAdminShell({
      title: "Account",
      siteName: "iglo.email",
      assetVersion,
      i18n,
      script: "instance-account",
      translationKeys: [
        "users.passwordMismatch",
        "users.twoFAEnabled",
        "globals.messages.done",
        "globals.messages.invalidValue",
        "globals.messages.invalidFields",
        "globals.fields.password",
      ],
      config: { root_url: deps.rootUrl },
      navigation: instanceNavigation(ACCOUNT_PATH),
      children: (
        <section class="user-profile" x-data="instanceAccount">
          <header class="page-header">
            <div class="hstack gap-1">
              <h1 class="page-title">Account</h1>
              <span class="badge">Instance admin</span>
            </div>
            <button
              type="button"
              class="outline small"
              data-testid="instance-logout"
              x-on:click="logout"
            >
              {i18n.T("globals.buttons.logout")}
            </button>
          </header>
          <div class="card page-content content">
            <form method="post" {...{ "x-on:submit.prevent": "changePassword" }}>
              <section class="dialog-body">
                <h4 class="mb-6" data-testid="instance-username">
                  @{username}
                </h4>
                <label data-field="">
                  Current password
                  <input
                    type="password"
                    name="current"
                    minlength="8"
                    maxlength="2000"
                    autocomplete="current-password"
                    required
                    x-model="form.current"
                  />
                </label>
                <div class="row">
                  <label data-field="" class="col-6">
                    {i18n.T("globals.fields.newPassword")}
                    <input
                      type="password"
                      name="password"
                      minlength="8"
                      maxlength="2000"
                      autocomplete="new-password"
                      required
                      x-model="form.password"
                    />
                  </label>
                  <label data-field="" class="col-6">
                    {i18n.T("globals.fields.passwordRepeat")}
                    <input
                      type="password"
                      name="password2"
                      minlength="8"
                      maxlength="2000"
                      autocomplete="new-password"
                      required
                      x-model="form.password2"
                    />
                  </label>
                </div>
                <small data-hint="">
                  Changes the password in every project. Every other session ends.
                </small>
              </section>
              <footer class="dialog-foot hstack justify-end mt-6">
                <button type="submit" data-variant="primary" data-testid="instance-password-save">
                  {i18n.T("globals.buttons.save")}
                </button>
              </footer>
            </form>
          </div>
          <section class="twofa-app-section mt-6">
            {totp ? (
              <div class="card content" data-testid="twofa-enabled">
                <h3>{i18n.T("users.twoFAEnabled")}</h3>
                <p>{i18n.Ts("users.twoFAEnabledDesc", "type", "TOTP")}</p>
                <form class="disable-totp mt-5" {...{ "x-on:submit.prevent": "disableTotp" }}>
                  <label data-field="">
                    {i18n.T("globals.fields.password")}
                    <input type="password" x-model="disablePassword" minlength="8" required />
                  </label>
                  <button type="submit" data-variant="danger">
                    {i18n.T("globals.buttons.disable")}
                  </button>
                </form>
              </div>
            ) : (
              <div class="card content" data-testid="twofa-disabled">
                <h3>{i18n.T("users.twoFA")}</h3>
                <p>{i18n.T("users.twoFANotEnabled")}</p>
                <button
                  type="button"
                  data-variant="primary"
                  data-testid="totp-start"
                  x-show="!totpQR"
                  x-on:click="startTotp"
                >
                  {i18n.T("globals.buttons.enable")}
                </button>
                <template x-if="totpQR">
                  <div class="qr-app-section totp-setup mt-5">
                    <figure class="mb-6">
                      <img
                        class="card"
                        x-bind:src="'data:image/png;base64,' + totpQR"
                        alt="QR Code"
                      />
                      <figcaption class="text-light text-8">
                        {i18n.T("users.totpScanQR")}
                      </figcaption>
                    </figure>
                    <p>
                      {i18n.T("globals.fields.secretKey")}:{" "}
                      <code data-testid="totp-secret" x-text="totpSecret"></code>
                    </p>
                    <form class="mt-5" {...{ "x-on:submit.prevent": "confirmTotp" }}>
                      <div data-field="">
                        <input
                          x-model="totpCode"
                          aria-label={i18n.T("users.totpCode")}
                          maxlength="6"
                          pattern="[0-9]{6}"
                          placeholder="000000"
                          required
                        />
                      </div>
                      <button type="submit" data-variant="primary">
                        {i18n.T("globals.buttons.enable")}
                      </button>
                    </form>
                  </div>
                </template>
              </div>
            )}
          </section>
        </section>
      ),
    });
    return new Response(html, { headers: htmlHeaders });
  });

  const settingsView = page(
    (context) =>
      new Response(instanceSettingsPage(context.app.i18n, deps.rootUrl), { headers: htmlHeaders }),
  );
  const settings = settingsHandlers({
    side: "instance",
    read: () => deps.settings.read(),
    update: (build) => deps.settings.update(build),
    rootUrl: () => deps.rootUrl,
  });

  const open = page((context) => {
    const slug = context.params.slug ?? "";
    const base = deps.projectRootUrl(slug);
    if (base === undefined) {
      return plainNotFound();
    }
    const token = tokens.mint(slug);
    if (!token) {
      throw new HttpError(429, "Too many requests");
    }
    const params = new URLSearchParams({
      token,
      next: safeNext(context.url.searchParams.get("next")),
    });
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${base.replace(/\/+$/, "")}/admin/handoff?${params}`,
        "Cache-Control": "no-store",
      },
    });
  });

  router.route(
    "GET",
    "/admin/instance",
    () => new Response(null, { status: 302, headers: { Location: ACCOUNT_PATH } }),
  );
  router.route("GET", LOGIN_PATH, getLogin);
  router.route("POST", LOGIN_PATH, postLogin);
  router.route("GET", `${LOGIN_PATH}/twofa`, getTwofa);
  router.route("POST", `${LOGIN_PATH}/twofa`, postTwofa);
  router.route("GET", ACCOUNT_PATH, account);
  router.route("GET", SETTINGS_PATH, settingsView);
  router.route("GET", "/admin/instance/open/:slug", open);

  router.route(
    "POST",
    "/api/instance/logout",
    api((_context, session) => {
      auth.endSession(session.id);
      const response = ok(true);
      for (const value of auth.clearCookies()) {
        response.headers.append("Set-Cookie", value);
      }
      return response;
    }),
  );
  router.route(
    "GET",
    "/api/instance/account",
    api(() => ok({ username: auth.username(), twofa_type: auth.twofa() })),
  );
  router.route(
    "PUT",
    "/api/instance/account/password",
    api(async (context, session) => {
      const value = await jsonFields(context.request);
      const current = value.get("current") ?? "";
      const password = value.get("password") ?? "";
      if (!validPassword(password)) {
        throw new HttpError(
          400,
          context.app.i18n.Ts("globals.messages.invalidFields", "name", "password"),
        );
      }
      if (!(await auth.changePassword(session, current, password))) {
        throw new HttpError(
          403,
          context.app.i18n.T("globals.messages.invalidPassword"),
          {},
          "invalid_credentials",
        );
      }
      return ok(true);
    }),
  );
  router.route(
    "GET",
    "/api/instance/account/totp",
    api(async () => ok(await auth.totpSecret())),
  );
  router.route(
    "PUT",
    "/api/instance/account/twofa",
    api(async (context, session) => {
      const value = await jsonFields(context.request);
      auth.enableTotp(
        session,
        (value.get("secret") ?? "").trim(),
        (value.get("code") ?? "").trim(),
      );
      return ok(true);
    }),
  );
  router.route(
    "DELETE",
    "/api/instance/account/twofa",
    api(async (context, session) => {
      const value = await jsonFields(context.request);
      await auth.disableTotp(session, value.get("password") ?? "");
      return ok(true);
    }),
  );
  // The instance keys (B139, D154): the same bodies and rules as a project's /api/settings.
  router.route(
    "GET",
    "/api/instance/settings",
    api(() => settings.get()),
  );
  router.route(
    "PUT",
    "/api/instance/settings",
    api((context) => settings.putAll(context.request, () => auth.authorize(context.request))),
  );
  router.route(
    "PUT",
    "/api/instance/settings/:key",
    api((context) =>
      settings.putKey(context.request, context.params.key ?? "", () =>
        auth.authorize(context.request),
      ),
    ),
  );
  // The instance Settings page's test: the primary project's sender, from address and brand.
  router.route(
    "POST",
    "/api/instance/settings/smtp/test",
    api(async (context) => {
      const body = await readBody(context.request);
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        throw new HttpError(400, "Invalid data.");
      }
      const test = deps.smtpTest();
      if (!test) {
        throw new HttpError(
          409,
          "The SMTP test sends through the primary project, and there is none.",
        );
      }
      await test(value, () => auth.authorize(context.request));
      return ok([]);
    }),
  );
  // Any other instance page is the plain 404 an unclaimed host answers.
  router.notFound("/admin/instance", plainNotFound);
  return router;
}
