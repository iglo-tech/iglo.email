// Adapted from listmonk cmd/auth.go and static/public/templates/login.html at 6fcd95f.
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
    const url = new URL(text, "http://login.invalid/");
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("..") || unsafeCharacters(decoded)) return "/";
    const path = posix.normalize(url.pathname);
    return path.startsWith("/") && !path.startsWith("//") ? path : "/";
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
    auth.replaceSession(context.request);
    const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
    for (const value of auth.sessionCookies(session.id, session.csrf))
      headers.append("Set-Cookie", value);
    return new Response(null, { status: 302, headers });
  };
  return { getLogin, postLogin };
}
