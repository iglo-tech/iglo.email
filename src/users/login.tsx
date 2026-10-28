// Adapted from listmonk cmd/auth.go, internal/utils/utils.go and static/public/templates/login.html at 6fcd95f.
import { posix } from "node:path";
import { render } from "@/jsx/render";
import { PublicShell } from "@/public/layout";
import { assetVersion } from "@/server/asset-manifest";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import { strHasLen } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { readBody } from "@/users/input";

function unsafeCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "\\";
  });
}

function sanitizeNext(value: string): string {
  const text = value.trim();
  if (!text || unsafeCharacters(text)) return "/";
  try {
    // Reject against the original decoded path: WHATWG URL parsing resolves
    // dot segments. Discard only scheme, authority, query and fragment here;
    // URL below still validates and selects the final local destination.
    const rawPath =
      text
        .replace(/^[a-z][a-z\d+.-]*:/i, "")
        .replace(/^\/\/[^/?#]*/, "")
        .split(/[?#]/, 1)[0] ?? "";
    const original = decodeURIComponent(rawPath);
    if (original.includes("..") || unsafeCharacters(original)) return "/";
    const url = new URL(text, "http://login.invalid/");
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("..") || unsafeCharacters(decoded)) return "/";
    const path = posix.normalize(decoded).replace(/\/+$/, "") || "/";
    // Clean the decoded path as upstream does, then preserve path delimiters
    // while escaping segment contents for a single, safe Location interpretation.
    return path.startsWith("/") && !path.startsWith("//")
      ? path.split("/").map(encodeURIComponent).join("/")
      : "/";
  } catch {
    return "/";
  }
}

function page(context: RequestContext, auth: Authentication, next: string, message = ""): Response {
  const nonce = auth.nonce();
  const i18n = context.app.i18n;
  const title = i18n.T("globals.buttons.login");
  const body = render(
    <PublicShell
      title={title}
      siteName="iglo.email"
      assetVersion={assetVersion}
      poweredBy={i18n.T("public.poweredBy")}
    >
      <section class="login">
        <h2>{title}</h2>
        <form method="post" action="/admin/login" class="form">
          <div>
            <input type="hidden" name="nonce" value={nonce} />
            <input type="hidden" name="next" value={next === "/" ? "/admin" : next} />
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
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Set-Cookie": auth.nonceCookie(nonce),
      "Cache-Control": "no-store",
    },
  });
}

export function createLoginHandlers(auth: Authentication) {
  const getLogin: Handler = (context) =>
    page(context, auth, sanitizeNext(context.url.searchParams.get("next") ?? ""));
  const postLogin: Handler = async (context) => {
    auth.limit(context.peerAddress);
    auth.checkOrigin(context.request);
    if (
      context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/x-www-form-urlencoded"
    )
      throw new HttpError(415);
    const fields = new URLSearchParams(await readBody(context.request));
    if (!auth.nonceValid(context.request, fields.get("nonce") ?? ""))
      throw new HttpError(403, "invalid nonce");
    const username = (fields.get("username") ?? "").trim();
    const password = fields.get("password") ?? "";
    const next = sanitizeNext(fields.get("next") ?? "");
    if (!strHasLen(username, 3, 2000))
      return page(
        context,
        auth,
        next,
        context.app.i18n.Ts("globals.messages.invalidFields", "name", "username"),
      );
    if (!strHasLen(password, 8, 2000))
      return page(
        context,
        auth,
        next,
        context.app.i18n.Ts("globals.messages.invalidFields", "name", "password"),
      );
    const session = await auth.login(username, password);
    if (!session) return page(context, auth, next, context.app.i18n.T("users.invalidLogin"));
    if ("token" in session) {
      const params = new URLSearchParams({ token: session.token, next });
      return new Response(null, {
        status: 302,
        headers: { Location: `/admin/login/twofa?${params}`, "Cache-Control": "no-store" },
      });
    }
    auth.replaceSession(context.request);
    const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
    for (const value of auth.sessionCookies(session.id, session.csrf))
      headers.append("Set-Cookie", value);
    return new Response(null, { status: 302, headers });
  };
  function twofaPage(context: RequestContext, token: string, next: string, message = ""): Response {
    const nonce = auth.nonce();
    const i18n = context.app.i18n;
    const title = i18n.T("users.twoFA");
    const body = render(
      <PublicShell
        title={title}
        siteName="iglo.email"
        assetVersion={assetVersion}
        poweredBy={i18n.T("public.poweredBy")}
      >
        <section class="login">
          <h2>{title}</h2>
          <p>{i18n.T("users.totpCodeHelp")}</p>
          <form method="post" action="/admin/login/twofa" class="form">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="next" value={next} />
            <input type="hidden" name="nonce" value={nonce} />
            <input
              id="totp_code"
              name="totp_code"
              type="text"
              autofocus
              required
              pattern="[0-9]{6}"
              maxlength="6"
              aria-label={i18n.T("users.totpCode")}
            />
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
          </form>
        </section>
      </PublicShell>,
    );
    return new Response(`<!DOCTYPE html>${body}`, {
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Set-Cookie": auth.nonceCookie(nonce),
        "Cache-Control": "no-store",
      },
    });
  }
  const getTwofa: Handler = (context) => {
    const token = context.url.searchParams.get("token") ?? "";
    if (!auth.challengeExists(token))
      return Response.redirect(new URL("/admin", context.request.url), 302);
    const next = sanitizeNext(context.url.searchParams.get("next") ?? "");
    return twofaPage(context, token, next === "/" ? "/admin" : next);
  };
  const postTwofa: Handler = async (context) => {
    auth.limit(context.peerAddress);
    auth.checkOrigin(context.request);
    if (
      context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/x-www-form-urlencoded"
    )
      throw new HttpError(415);
    const fields = new URLSearchParams(await readBody(context.request));
    if (!auth.nonceValid(context.request, fields.get("nonce") ?? ""))
      throw new HttpError(403, "invalid nonce");
    const token = fields.get("token") ?? "";
    if (!auth.challengeExists(token))
      return Response.redirect(new URL("/admin", context.request.url), 302);
    const nextValue = sanitizeNext(fields.get("next") ?? "");
    const next = nextValue === "/" ? "/admin" : nextValue;
    const session = auth.verifyChallenge(token, (fields.get("totp_code") ?? "").trim());
    if (!session)
      return twofaPage(context, token, next, context.app.i18n.T("globals.messages.invalidValue"));
    auth.replaceSession(context.request);
    const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
    for (const value of auth.sessionCookies(session.id, session.csrf))
      headers.append("Set-Cookie", value);
    return new Response(null, { status: 302, headers });
  };
  return { getLogin, postLogin, getTwofa, postTwofa };
}
