// Adapted from listmonk cmd/auth.go (ForgotPage, ResetPage, doForgotPassword, doResetPassword)
// and static/public/templates/{forgot,reset}-password.html at 6fcd95f.
import type { ErrorLogger } from "@/app";
import { render, type Child } from "@/jsx/render";
import type { Dispatch, Message } from "@/messaging/email";
import { safeLogo } from "@/messaging/test";
import { PublicShell } from "@/public/layout";
import { publicMessage } from "@/public/message";
import { assetVersion } from "@/server/asset-manifest";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import { strHasLen } from "@/server/validation";
import { systemTemplates } from "@/templates/builtins";
import type { TemplateRenderer } from "@/templates/renderer";
import type { Authentication } from "@/users/auth";
import { readBody } from "@/users/input";

export interface ResetSettings {
  siteName: string;
  rootUrl: string;
  fromEmail: string;
  logoUrl: string;
}
export interface ResetDeps {
  auth: Authentication;
  renderer: TemplateRenderer;
  send: (message: Message) => Dispatch;
  settings: () => ResetSettings;
  logger: ErrorLogger;
}

// The link in the query must not outlive the page in a cache or a cross-site Referer. Not
// `no-referrer`: that makes the browser send `Origin: null`, which the form's own POST fails.
const pageHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "same-origin" };

export function createPasswordReset(deps: ResetDeps) {
  const { auth, renderer, send, settings, logger } = deps;
  const form = (context: RequestContext, title: string, children: Child): Response => {
    const body = render(
      <PublicShell
        title={title}
        siteName={settings().siteName}
        assetVersion={assetVersion}
        poweredBy={context.app.i18n.T("public.poweredBy")}
      >
        <section class="login">
          <h2>{title}</h2>
          {children}
        </section>
      </PublicShell>,
    );
    return new Response(`<!DOCTYPE html>${body}`, {
      headers: { "Content-Type": "text/html; charset=UTF-8", ...pageHeaders },
    });
  };
  const message = (context: RequestContext, status: number, text: string) =>
    publicMessage(
      context.app.i18n,
      {
        status,
        title: context.app.i18n.T("users.resetPassword"),
        message: text,
        siteName: settings().siteName,
      },
      pageHeaders,
    );
  const invalidLink = (context: RequestContext) =>
    message(context, 400, context.app.i18n.T("users.invalidResetLink"));
  const formFields = async (context: RequestContext) => {
    auth.limit(auth.clientAddress(context));
    auth.checkOrigin(context.request);
    if (
      context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/x-www-form-urlencoded"
    )
      throw new HttpError(415);
    return new URLSearchParams(await readBody(context.request));
  };
  const mail = (context: RequestContext, email: string) => {
    const reset = auth.issueReset(email);
    if (!reset) return;
    const t = context.app.i18n;
    const current = settings();
    const query = new URLSearchParams({ token: reset.token, email });
    const html = renderer.renderSync({
      body: systemTemplates.forgotPassword,
      mode: "html",
      data: JSON.stringify({
        reset_url: `${current.rootUrl}/admin/reset?${query}`,
        logo_url: safeLogo(current.logoUrl),
      }),
    }).body;
    void send({
      from: current.fromEmail,
      to: [reset.user.email],
      subject: t.T("email.forgotPassword.subject"),
      contentType: "html",
      body: Buffer.from(html),
    }).result.then((outcome) => {
      if (outcome.status !== "accepted") logger.error(new Error("Password reset mail not sent"));
    });
  };
  const getForgot: Handler = (context) => {
    const t = context.app.i18n;
    return form(
      context,
      t.T("users.forgotPassword"),
      <form method="post" action="/admin/forgot" class="form">
        <div>
          <p>
            <label for="email">{t.T("globals.fields.email")}</label>
            <input id="email" type="email" name="email" autofocus required />
          </p>
          <p>
            <button class="button" type="submit">
              {t.T("globals.buttons.continue")}
            </button>
          </p>
          <p class="small">
            <a href="/admin/login">← {t.T("globals.buttons.login")}</a>
          </p>
        </div>
      </form>,
    );
  };
  const postForgot: Handler = async (context) => {
    const fields = await formFields(context);
    const email = (fields.get("email") ?? "").trim().toLowerCase();
    // The answer leaves first, so neither it nor its timing depends on the address.
    setTimeout(() => {
      try {
        mail(context, email);
      } catch (error) {
        logger.error(error);
      }
    }, 0);
    return message(context, 200, context.app.i18n.T("users.resetLinkSent"));
  };
  const link = (context: RequestContext) => ({
    token: (context.url.searchParams.get("token") ?? "").trim(),
    email: (context.url.searchParams.get("email") ?? "").trim().toLowerCase(),
  });
  const resetForm = (context: RequestContext, token: string, email: string, error = "") => {
    const t = context.app.i18n;
    const query = new URLSearchParams({ token, email });
    return form(
      context,
      t.T("users.resetPassword"),
      <form method="post" action={`/admin/reset?${query}`} class="form">
        <div>
          <p>
            <label for="password">{t.T("globals.fields.newPassword")}</label>
            <input id="password" type="password" name="password" autofocus required minlength="8" />
          </p>
          <p>
            <label for="password2">{t.T("globals.fields.passwordRepeat")}</label>
            <input id="password2" type="password" name="password2" required minlength="8" />
          </p>
          {error ? (
            <p>
              <span class="error">{error}</span>
            </p>
          ) : null}
          <p class="submit">
            <button class="button" type="submit">
              {t.T("users.resetPassword")}
            </button>
          </p>
        </div>
      </form>,
    );
  };
  const getReset: Handler = (context) => {
    const { token, email } = link(context);
    if (!auth.resetValid(email, token)) return invalidLink(context);
    return resetForm(context, token, email);
  };
  const postReset: Handler = async (context) => {
    const fields = await formFields(context);
    const { token, email } = link(context);
    if (!auth.resetValid(email, token)) return invalidLink(context);
    const t = context.app.i18n;
    const password = fields.get("password") ?? "";
    if (!strHasLen(password, 8, 2000))
      return resetForm(
        context,
        token,
        email,
        t.Ts("globals.messages.invalidFields", "name", "password"),
      );
    if (password !== (fields.get("password2") ?? ""))
      return resetForm(context, token, email, t.T("users.passwordMismatch"));
    const session = await auth.resetPassword(email, token, password);
    if (!session) return invalidLink(context);
    if ("token" in session) {
      const params = new URLSearchParams({ token: session.token, next: "/admin" });
      return new Response(null, {
        status: 302,
        headers: { Location: `/admin/login/twofa?${params}`, ...pageHeaders },
      });
    }
    auth.replaceSession(context.request);
    const headers = new Headers({ Location: "/admin", ...pageHeaders });
    for (const value of auth.sessionCookies(session.id, session.csrf, session.duration))
      headers.append("Set-Cookie", value);
    return new Response(null, { status: 302, headers });
  };
  return { getForgot, postForgot, getReset, postReset };
}
