// Adapted from listmonk cmd/users.go and cmd/auth.go at 6fcd95f.
import QRCode from "qrcode";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import { getID } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { readBody } from "@/users/input";
import type { Identity } from "@/users/models";
import { validPassword } from "@/users/password";
import type { UserStore } from "@/users/store";
import { newSecret, verifyTOTP } from "@/users/totp";

function self(context: RequestContext): Identity {
  const identity = context.identity;
  if (
    !identity ||
    identity.user.id !== BigInt(getID(context)) ||
    identity.transport !== "session" ||
    identity.user.type !== "user" ||
    identity.user.password_login === 0n
  )
    throw new HttpError(403, "invalid session");
  return identity;
}
async function fields(request: Request): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (text && request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new HttpError(415);
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400);
  return value as Record<string, unknown>;
}
export function createFactorHandlers(store: UserStore, auth: Authentication) {
  const generate: Handler = async (context) => {
    const identity = self(context);
    return auth.withIdentityProof(identity.user.id, async (currentProof) => {
      if (identity.user.twofa_type === "totp")
        throw new HttpError(400, context.app.i18n.T("users.twoFAAlreadyEnabled"));
      const secret = newSecret();
      const uri = new URL(
        `otpauth://totp/${encodeURIComponent(`iglo.email:${identity.user.email}`)}`,
      );
      uri.search = new URLSearchParams({
        secret,
        issuer: "iglo.email",
        period: "30",
        digits: "6",
        algorithm: "SHA1",
      }).toString();
      const qr = (await QRCode.toBuffer(uri.toString(), { type: "png", width: 200 })).toString(
        "base64",
      );
      auth.revalidate(context);
      const current = self(context);
      if (
        !currentProof() ||
        current.user.twofa_type !== "none" ||
        current.user.password !== identity.user.password ||
        current.user.email !== identity.user.email
      )
        throw new HttpError(403, "invalid session");
      return ok({ secret, qr });
    });
  };
  const enable: Handler = async (context) => {
    const identity = self(context);
    return auth.withIdentityProof(identity.user.id, async (currentProof) => {
      const value = await fields(context.request);
      const secret = typeof value.secret === "string" ? value.secret.trim() : "";
      const code = typeof value.code === "string" ? value.code.trim() : "";
      const invalid = () =>
        new HttpError(
          400,
          context.app.i18n.Ts("globals.messages.invalidFields", "name", "{users.totpCode}"),
        );
      if (!secret || !code) throw invalid();
      auth.revalidate(context);
      self(context);
      if (!currentProof()) throw new HttpError(403, "invalid session");
      if (identity.user.twofa_type === "totp")
        throw new HttpError(400, context.app.i18n.T("users.twoFAAlreadyEnabled"));
      if (!verifyTOTP(secret, code, context.app.clock.now())) throw invalid();
      if (
        !store.setFactor(identity.user, "totp", secret, identity.sessionId!, () => {
          auth.revalidate(context);
          self(context);
        })
      )
        throw new HttpError(403, "invalid session");
      return ok(true);
    });
  };
  const disable: Handler = async (context) => {
    const identity = self(context);
    return auth.withIdentityProof(identity.user.id, async (currentProof) => {
      const value = await fields(context.request);
      const password = typeof value.password === "string" ? value.password : "";
      if (identity.user.twofa_type !== "totp")
        throw new HttpError(400, context.app.i18n.T("users.twoFANotEnabled"));
      if (!validPassword(password))
        throw new HttpError(
          400,
          context.app.i18n.Ts("globals.messages.invalidFields", "name", "password"),
        );
      if (!identity.user.password || !(await auth.verifyPassword(password, identity.user.password)))
        throw new HttpError(403, context.app.i18n.T("globals.messages.invalidPassword"));
      auth.revalidate(context);
      self(context);
      if (!currentProof()) throw new HttpError(403, "invalid session");
      if (
        !store.setFactor(identity.user, "none", null, identity.sessionId!, () => {
          auth.revalidate(context);
          self(context);
        })
      )
        throw new HttpError(403, "invalid session");
      return ok(true);
    });
  };
  return { generate, enable, disable };
}
