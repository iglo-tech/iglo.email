// The instance pages on the instance host (14-projects sections 2, 5, 10 and 13; B140, D153,
// B143a, D157). Native:
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
import type { SesRateLine } from "@/admin/views/settings";
import type { Translation } from "@/i18n/i18n";
import { settingsHandlers } from "@/settings/routes";
import type { CustomCodeChange } from "@/settings/routes";
import type { InstanceSettingsStore } from "@/settings/instance";
import type { NavigationLink } from "@/admin/layout/shell";
import {
  LOGS_PATH,
  LogsBody,
  PROJECTS_PATH,
  ProjectsBody,
  projectJson,
  summaryJson,
} from "@/admin/instance/projects";
import type { InstanceProjects } from "@/admin/instance/projects";
import { RegistryError } from "@/projects/registry";
import type { SesAccount } from "@/messaging/ses-account";
import type { CapacityAnswer } from "@/messaging/capacity";
import { SENDING_PATH, SendingBody } from "@/admin/instance/sending";

export const ACCOUNT_PATH = "/admin/instance/account";
export const SETTINGS_PATH = "/admin/instance/settings";
const LOGIN_PATH = "/admin/instance/login";

export interface InstanceRouteDeps {
  readonly auth: InstanceAuth;
  readonly tokens: HandoffTokens;
  /** `--root-url`, without a trailing slash. */
  readonly rootUrl: string;
  /** `--root-url`'s host: the only hostname a primary project may have. */
  readonly instanceHost: string;
  /** A served project's root URL by slug, or undefined for a slug no project has. */
  readonly projectRootUrl: (slug: string) => string | undefined;
  /** The instance keys (B139, D154): `/api/instance/settings` and the instance Settings page. */
  readonly settings: InstanceSettingsStore;
  /** The projects: the Projects and Logs pages and `/api/instance/projects` (B143a, D157). */
  readonly projects: InstanceProjects;
  /** The login limit's client address, with security.trusted_proxies; the peer without it. */
  readonly clientAddress?: (context: RequestContext) => string;
  /**
   * The SES account (B145a): the instance Settings page's "Check SES account" button, and SES's
   * rate beside the send-rate setting (B145b).
   */
  readonly ses: Pick<SesAccount, "check" | "setting" | "current" | "held">;
  /**
   * The instance's forecast without a candidate, the function `GET /api/sending/capacity` uses
   * (B143b): the Sending page. It may read the account on demand, as that endpoint does.
   */
  readonly forecast: () => Promise<CapacityAnswer>;
  /** The primary project's SMTP test, or undefined without a primary project. */
  readonly smtpTest: () => ((body: unknown, revalidate: () => void) => Promise<void>) | undefined;
}

/** The SES rate line's inputs from the account as it is now (B145b). */
function sesRateLine(ses: Pick<SesAccount, "current" | "setting">): SesRateLine {
  const state = ses.current();
  return {
    configured: state.configured,
    maxSendRate: state.snapshot?.maxSendRate ?? null,
    setting: ses.setting(),
  };
}

/** The instance Settings page (B139, D154): the instance keys, in the instance layout. */
export function instanceSettingsPage(
  i18n: Translation,
  rootUrl: string,
  ses?: SesRateLine,
): string {
  const view = settingsPage(i18n, "instance", {
    canManage: true,
    canUpload: false,
    ses,
  });
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
    { label: "Projects", href: PROJECTS_PATH, current: current === PROJECTS_PATH, icon: "grid" },
    { label: "Sending", href: SENDING_PATH, current: current === SENDING_PATH, icon: "send" },
    { label: "Account", href: ACCOUNT_PATH, current: current === ACCOUNT_PATH, icon: "user" },
    {
      label: "Instance settings",
      href: SETTINGS_PATH,
      current: current === SETTINGS_PATH,
      icon: "settings",
    },
    { label: "Logs", href: LOGS_PATH, current: current === LOGS_PATH, icon: "terminal" },
  ];
}

const htmlHeaders = { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" };

/** After a login: a safe local `next`, else the Projects page. */
function loginNext(value: string | null): string {
  const next = safeNext(value);
  return next === "/admin" && value !== "/admin" ? PROJECTS_PATH : next;
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

/** A JSON object body's fields; an empty body has none. */
async function jsonObject(request: Request): Promise<Map<string, unknown>> {
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
  return new Map<string, unknown>(Object.entries(value));
}

/** A JSON object body's string fields; any other value of a field reads as empty. */
async function jsonFields(request: Request): Promise<Map<string, string>> {
  const value = await jsonObject(request);
  const fields = new Map<string, string>();
  for (const [key, field] of value) {
    if (typeof field === "string") {
      fields.set(key, field);
    }
  }
  return fields;
}

/** A string field of a JSON body; a missing field reads as empty, any other value is a 400. */
function text(body: Map<string, unknown>, name: string): string {
  const value = body.get(name) ?? "";
  if (typeof value !== "string") {
    throw new HttpError(400, `${name} must be a string`);
  }
  return value;
}

/** `extra`: an array of strings, missing as none. */
function hostnames(value: unknown): Array<string> {
  if (value === undefined || value === null) {
    return [];
  }
  const items: ReadonlyArray<unknown> = Array.isArray(value) ? value : [];
  const strings = items.filter((item): item is string => typeof item === "string");
  if (!Array.isArray(value) || strings.length !== items.length) {
    throw new HttpError(400, "extra must be an array of hostnames");
  }
  return strings;
}

/** `primary`: a boolean, missing as false. */
function flag(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "primary must be true or false");
  }
  return value;
}

/** A refused registry change as its HTTP status and message. */
async function refused<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RegistryError) {
      throw new HttpError(error.status, error.message);
    }
    throw error;
  }
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
  const policy: Middleware = async (context, next) => {
    const response = await next();
    if (
      response.headers.get("Content-Type")?.startsWith("text/html") &&
      !response.headers.has("Content-Security-Policy")
    ) {
      // The two login pages are authentication pages: no frame may hold them (D201).
      const { pathname } = context.url;
      const signIn = pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/twofa`;
      response.headers.set(
        "Content-Security-Policy",
        adminPolicy({ origins: [deps.rootUrl], signIn }),
      );
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
      <PublicShell title={title} site={site} assetVersion={assetVersion} customAssets={false}>
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
      <PublicShell title={title} site={site} assetVersion={assetVersion} customAssets={false}>
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
      new Response(instanceSettingsPage(context.app.i18n, deps.rootUrl, sesRateLine(deps.ses)), {
        headers: htmlHeaders,
      }),
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

  const projectsView = page((context) => {
    const projects = deps.projects.list();
    const html = renderAdminShell({
      title: "Projects",
      siteName: "iglo.email",
      assetVersion,
      i18n: context.app.i18n,
      script: "instance-projects",
      translationKeys: ["globals.messages.done"],
      config: {
        root_url: deps.rootUrl,
        instance_host: deps.instanceHost,
        projects: projects.map((project) => ({
          slug: project.slug,
          name: project.name,
          extra: [...project.extra],
        })),
      },
      navigation: instanceNavigation(PROJECTS_PATH),
      children: (
        <ProjectsBody
          projects={projects}
          leftovers={deps.projects.leftovers()}
          instanceHost={deps.instanceHost}
        />
      ),
    });
    return new Response(html, { headers: htmlHeaders });
  });
  const logsView = page((context) => {
    const html = renderAdminShell({
      title: "Logs",
      siteName: "iglo.email",
      assetVersion,
      i18n: context.app.i18n,
      config: { root_url: deps.rootUrl },
      navigation: instanceNavigation(LOGS_PATH),
      children: <LogsBody lines={deps.projects.logs()} />,
    });
    return new Response(html, { headers: htmlHeaders });
  });

  const sendingView = page(async (context) => {
    // The forecast first: it may read the account (older than a minute), and the page then shows
    // that read's snapshot, error and hold.
    const answer = await deps.forecast();
    const account = deps.ses.current();
    const html = renderAdminShell({
      title: "Sending",
      siteName: "iglo.email",
      assetVersion,
      i18n: context.app.i18n,
      config: { root_url: deps.rootUrl },
      navigation: instanceNavigation(SENDING_PATH),
      children: (
        <SendingBody
          settingsHref={SETTINGS_PATH}
          state={{
            now: context.app.clock.now(),
            configured: account.configured,
            snapshot: account.snapshot,
            error: account.error,
            rate: answer.rate,
            held: deps.ses.held(),
            forecast: answer.forecast,
          }}
        />
      ),
    });
    return new Response(html, { headers: htmlHeaders });
  });

  router.route(
    "GET",
    "/admin/instance",
    () => new Response(null, { status: 302, headers: { Location: PROJECTS_PATH } }),
  );
  router.route("GET", PROJECTS_PATH, projectsView);
  router.route("GET", SENDING_PATH, sendingView);
  router.route("GET", LOGS_PATH, logsView);
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
  // The projects (B143a, D157): the lifecycle, serialized by the instance, with no restart.
  router.route(
    "GET",
    "/api/instance/projects",
    api(() => ok(deps.projects.list().map(summaryJson))),
  );
  router.route(
    "POST",
    "/api/instance/projects",
    api(async (context) => {
      const body = await jsonObject(context.request);
      const record = await refused(() =>
        deps.projects.create({
          slug: text(body, "slug"),
          name: text(body, "name"),
          hostname: text(body, "hostname"),
          extra: hostnames(body.get("extra")),
          primary: flag(body.get("primary")),
        }),
      );
      return ok(projectJson(record));
    }),
  );
  router.route(
    "PUT",
    "/api/instance/projects/:slug",
    api(async (context) => {
      const body = await jsonObject(context.request);
      // B170 (D198): only `name` and `extra` can change; any other field (the slug, the main
      // hostname, the primary flag) is refused by name instead of ignored.
      for (const key of body.keys()) {
        if (key !== "name" && key !== "extra") {
          throw new HttpError(400, `${key} cannot be changed: send only name and extra`);
        }
      }
      // A field left out keeps its value.
      const change = {
        name: body.has("name") ? text(body, "name") : undefined,
        extra: body.has("extra") ? hostnames(body.get("extra")) : undefined,
      };
      const record = await refused(() => deps.projects.update(context.params.slug ?? "", change));
      return ok(projectJson(record));
    }),
  );
  // D201: a project's public custom CSS and JS are written only here, with the instance session.
  router.route(
    "GET",
    "/api/instance/projects/:slug/appearance",
    api((context) => {
      const code = deps.projects.customCode(context.params.slug ?? "");
      if (!code) {
        throw new HttpError(404, `No project ${context.params.slug ?? ""}`);
      }
      return ok({ custom_css: code.css, custom_js: code.js, custom_js_held: code.jsHeld });
    }),
  );
  router.route(
    "PUT",
    "/api/instance/projects/:slug/appearance",
    api(async (context) => {
      const body = await jsonObject(context.request);
      for (const key of body.keys()) {
        if (key !== "custom_css" && key !== "custom_js") {
          throw new HttpError(
            400,
            `${key} is not an appearance field: send custom_css or custom_js`,
          );
        }
      }
      // A field left out keeps its value (undefined).
      const field = (key: string): string | undefined => {
        const value = body.get(key);
        if (value !== undefined && typeof value !== "string") {
          throw new HttpError(400, `${key} must be a string`);
        }
        return value;
      };
      const change: CustomCodeChange = { css: field("custom_css"), js: field("custom_js") };
      const code = await refused(() =>
        deps.projects.setCustomCode(context.params.slug ?? "", change),
      );
      return ok({ custom_css: code.css, custom_js: code.js, custom_js_held: code.jsHeld });
    }),
  );
  router.route(
    "DELETE",
    "/api/instance/projects/:slug",
    api(async (context) => {
      const slug = context.params.slug ?? "";
      const body = await jsonObject(context.request);
      // The admin types the slug (14-projects section 10): a delete names it twice.
      if (body.get("confirm") !== slug) {
        throw new HttpError(400, "Type the project's slug in `confirm` to delete it");
      }
      const deleted = await refused(() => deps.projects.remove(slug));
      if (!deleted) {
        throw new HttpError(404, `No project ${slug}`);
      }
      return ok({ database: deleted.database, files: deleted.files });
    }),
  );
  // "Check SES account" (B145a): a GetAccount read now, with its values or the AWS error. The
  // secret never leaves the server; without the three API keys it answers `configured: false`.
  const { ses } = deps;
  router.route(
    "POST",
    "/api/instance/settings/ses/check",
    api(async () => {
      const state = await ses.check();
      return ok({
        configured: state.configured,
        error: state.error,
        setting: ses.setting(),
        account: state.snapshot && {
          max_send_rate: state.snapshot.maxSendRate,
          max_24_hour_send: state.snapshot.max24HourSend,
          sent_last_24_hours: state.snapshot.sentLast24Hours,
          production_access_enabled: state.snapshot.productionAccessEnabled,
          sending_enabled: state.snapshot.sendingEnabled,
          read_at: state.snapshot.readAt,
        },
      });
    }),
  );
  // Any other instance page is the plain 404 an unclaimed host answers.
  router.notFound("/admin/instance", plainNotFound);
  return router;
}
