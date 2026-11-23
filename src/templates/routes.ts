// Template HTTP endpoints adapted from listmonk cmd/templates.go and cmd/handlers.go at 6fcd95f.
import { mailBrand } from "@/public/brand";
import type { BrandSite } from "@/public/brand";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { readTemplateBody, templateInput } from "@/templates/input";
import { TemplateError } from "@/templates/store";
import type { TemplateRow, TemplateStore, TemplateType } from "@/templates/store";
import { RenderCapacityError, RenderFaultError, TemplateSourceError } from "@/templates/renderer";
import type { TemplateRenderer } from "@/templates/renderer";
import {
  parseSample,
  previewBody,
  previewContext,
  previewDummy,
  SampleError,
} from "@/templates/sample";
import type { Sample } from "@/templates/sample";

const idValue = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(id)
    : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(id.toString());
function project(row: TemplateRow, noBody = false) {
  return {
    id: idValue(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    name: row.name,
    subject: row.subject,
    type: row.type,
    ...(!noBody && row.body ? { body: row.body } : {}),
    body_source: noBody ? null : row.body_source,
    is_default: row.is_default === 1n,
  };
}
function noBody(context: RequestContext) {
  return ["1", "t", "T", "TRUE", "true", "True"].includes(
    context.url.searchParams.get("no_body") ?? "",
  );
}
function translateError(context: RequestContext, error: unknown): never {
  if (error instanceof HttpError) {
    throw error;
  }
  if (error instanceof TemplateError) {
    const t = context.app.i18n;
    switch (error.reason) {
      case "name":
        throw new HttpError(400, t.T("campaigns.fieldInvalidName"));
      case "type":
        throw new HttpError(400, t.Ts("globals.messages.invalidFields", "name", "type"));
      case "subject":
        throw new HttpError(400, t.Ts("globals.messages.missingFields", "name", "subject"));
      case "subject-syntax":
        throw new HttpError(
          400,
          t.Ts(
            "templates.errorCompiling",
            "error",
            error.detail
              ? `unknown filter "${error.detail}" (see template_reference)`
              : "invalid subject",
          ),
        );
      case "slot":
        throw new HttpError(
          400,
          t.Ts("templates.placeholderHelp", "placeholder", "{{ content | raw }}"),
        );
      case "missing":
        throw new HttpError(
          400,
          t.Ts("globals.messages.notFound", "name", "{globals.terms.template}"),
          {},
          "not_found",
        );
      case "delete":
        throw new HttpError(400, t.T("templates.cantDeleteDefault"));
      case "default":
        throw new HttpError(400, t.Ts("globals.messages.invalidFields", "name", "template"));
      case "body":
        throw new HttpError(
          400,
          t.Ts(
            "templates.errorCompiling",
            "error",
            error.detail
              ? `unknown filter "${error.detail}" (see template_reference)`
              : "invalid body",
          ),
        );
      case "loop":
        throw new HttpError(
          400,
          t.Ts(
            "templates.errorCompiling",
            "error",
            "a for loop cannot take a filter; assign the filtered value first",
          ),
        );
      case "render":
        // The cause in words: the detail names the template's expression and the kind of value, never a data value (D134).
        throw new HttpError(
          400,
          t.Ts("templates.errorCompiling", "error", `it fails to render: ${error.detail}`),
        );
      case "capacity":
        throw new HttpError(429, "Too many template renders in progress.");
    }
  }
  throw new HttpError(500);
}
function guarded(handler: Handler): Handler {
  return async (context) => {
    try {
      return await handler(context);
    } catch (error) {
      return translateError(context, error);
    }
  };
}
function html(body: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Content-Security-Policy":
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * `brand` reads the operator's site settings for each request. A preview takes the brand as a send
 * does (B129 review, D127): without it the built-in layouts render with empty brand values.
 */
export function registerTemplateRoutes(
  router: Router,
  store: TemplateStore,
  renderer: TemplateRenderer,
  auth: Authentication,
  brand: () => BrandSite,
) {
  const collection = (context: RequestContext) =>
    ok(
      store
        .list(
          context.url.searchParams.get("query") ?? "",
          context.url.searchParams.get("order_by") ?? "",
          context.url.searchParams.get("order") ?? "",
        )
        .map((row) => project(row, noBody(context))),
    );
  const getRow = (context: RequestContext) => {
    const row = store.get(BigInt(getID(context)));
    if (!row) {
      throw new TemplateError("missing");
    }
    return row;
  };
  const preview = async (
    context: RequestContext,
    type: TemplateType,
    body: string,
    sample?: Sample,
  ) => {
    if (type === "campaign_visual") {
      throw new TemplateError("type");
    }
    // The dummy context with the brand read now, so a layout shows the accent, font and header it
    // would send with. A sample replaces only the parts it names (D105).
    const dummyData = { ...previewDummy, ...mailBrand(brand()) };
    const rendered = JSON.stringify(
      sample === undefined ? dummyData : previewContext(dummyData, sample),
    );
    try {
      if (type === "campaign") {
        renderer.validate(body, "", true);
      }
      const result = await renderer.render(
        type === "campaign"
          ? { body: previewBody, layout: body, mode: "html", data: rendered }
          : { body, mode: "html", data: rendered, transactional: true },
      );
      auth.revalidate(context, "templates:get");
      return html(result.body);
    } catch (error) {
      auth.revalidate(context, "templates:get");
      if (error instanceof HttpError) {
        throw error;
      }
      if (error instanceof TemplateSourceError && error.field === "slot") {
        throw new TemplateError("slot");
      }
      if (error instanceof TemplateSourceError) {
        throw new HttpError(
          400,
          context.app.i18n.Ts("templates.errorCompiling", "error", "invalid body"),
        );
      }
      if (error instanceof RenderCapacityError) {
        throw new HttpError(429, "Too many template renders in progress.");
      }
      // A failed render names its expression and what was wrong (D134).
      throw new HttpError(
        400,
        context.app.i18n.Ts(
          "templates.errorRendering",
          "error",
          error instanceof RenderFaultError ? error.detail : "invalid template",
        ),
      );
    }
  };
  router.route("GET", "/api/templates", guarded(collection), auth.middleware("templates:get"));
  router.route(
    "GET",
    "/api/templates/:id",
    guarded((context) => ok(project(getRow(context), noBody(context)))),
    auth.middleware("templates:get"),
    hasID,
  );
  router.route(
    "GET",
    "/api/templates/:id/preview",
    guarded((context) => {
      const row = getRow(context);
      return preview(context, row.type, row.body);
    }),
    auth.middleware("templates:get"),
    hasID,
  );
  router.route(
    "POST",
    "/api/templates/preview",
    guarded(async (context) => {
      const bytes = await readTemplateBody(context.request);
      const contentType = context.request.headers.get("content-type") ?? "";
      const media = contentType.split(";", 1)[0]?.trim();
      let form: URLSearchParams | FormData = new URLSearchParams();
      if (media === "application/x-www-form-urlencoded") {
        const parsed = new URLSearchParams();
        // Request.FormValue ignores ParseForm errors and keeps the valid pairs.
        for (const pair of bytes.toString("utf-8").split("&")) {
          if (/%(?![0-9a-fA-F]{2})/.test(pair) || pair.includes(";")) {
            continue;
          }
          for (const [key, value] of new URLSearchParams(pair)) {
            parsed.append(key, value);
          }
        }
        form = parsed;
      } else if (media === "multipart/form-data") {
        try {
          form = await new Request("http://fixture.invalid", {
            method: "POST",
            headers: { "content-type": contentType },
            body: Uint8Array.from(bytes),
          }).formData();
        } catch {
          throw new HttpError(400);
        }
      }
      const formValue = (key: string) => {
        const value = form.get(key);
        return typeof value === "string" ? value : context.url.searchParams.get(key);
      };
      const rawType = formValue("template_type");
      const rawBody = formValue("body");
      const type = typeof rawType === "string" && rawType ? rawType : "campaign";
      const body = typeof rawBody === "string" ? rawBody : "";
      const rawSample = formValue("sample");
      let sample: Sample | undefined;
      if (typeof rawSample === "string" && rawSample !== "") {
        try {
          sample = parseSample(rawSample, { data: true });
        } catch (error) {
          if (error instanceof SampleError) {
            throw new HttpError(
              400,
              context.app.i18n.Ts("globals.messages.invalidFields", "name", error.field),
            );
          }
          throw error;
        }
      }
      if (type !== "campaign" && type !== "tx") {
        throw new TemplateError("type");
      }
      auth.revalidate(context, "templates:get");
      return preview(context, type, body, sample);
    }),
    auth.middleware("templates:get"),
  );
  router.route(
    "POST",
    "/api/templates",
    guarded(async (context) => {
      const input = await templateInput(context);
      auth.revalidate(context, "templates:manage");
      return ok(
        project(
          store.create({
            name: input.name ?? "",
            type: input.type ?? ("" as TemplateType),
            subject: input.subject ?? "",
            body: input.body ?? "",
            body_source: input.body_source ?? null,
          }),
        ),
      );
    }),
    auth.middleware("templates:manage"),
  );
  router.route(
    "PUT",
    "/api/templates/:id",
    guarded(async (context) => {
      const input = await templateInput(context);
      auth.revalidate(context, "templates:manage");
      return ok(project(store.update(BigInt(getID(context)), input)));
    }),
    auth.middleware("templates:manage"),
    hasID,
  );
  router.route(
    "PUT",
    "/api/templates/:id/default",
    guarded((context) => {
      store.setDefault(BigInt(getID(context)));
      return collection(context);
    }),
    auth.middleware("templates:manage"),
    hasID,
  );
  router.route(
    "DELETE",
    "/api/templates/:id",
    guarded((context) => {
      store.remove(BigInt(getID(context)));
      return ok(true);
    }),
    auth.middleware("templates:manage"),
    hasID,
  );
}
