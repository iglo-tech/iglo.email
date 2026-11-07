// MCP tools definitions and in-process execution handlers.
import type { App } from "@/app";
import type { Router } from "@/server/router";
import { TEMPLATE_REFERENCE } from "@/mcp/reference";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: string;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_templates",
    description: "List email templates with optional query search and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search term to filter templates by name." },
        no_body: { type: "boolean", description: "If true, omit the template body from results." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_template",
    description: "Get a single email template by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Template ID" },
        no_body: { type: "boolean", description: "If true, omit the template body." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_template",
    description:
      "Create a new email template (type 'campaign' for layouts with {{ content | raw }}, or 'tx' for complete messages).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Template name" },
        type: {
          type: "string",
          enum: ["campaign", "tx"],
          description: "Template type ('campaign' or 'tx')",
        },
        subject: { type: "string", description: "Template subject (required for tx templates)" },
        body: { type: "string", description: "Template HTML or plain-text body in Liquid format" },
        is_default: { type: "boolean", description: "Whether to make this the default template" },
      },
      required: ["name", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "update_template",
    description: "Update an existing email template.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Template ID to update" },
        name: { type: "string", description: "Template name" },
        type: {
          type: "string",
          enum: ["campaign", "tx"],
          description: "Template type ('campaign' or 'tx')",
        },
        subject: { type: "string", description: "Template subject" },
        body: { type: "string", description: "Template HTML or plain-text body in Liquid format" },
        is_default: { type: "boolean", description: "Whether to make this the default template" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_template",
    description: "Delete an email template by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Template ID to delete" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_template",
    description:
      "Render an HTML preview of a template (either an unsaved body or a stored template by ID).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Optional stored template ID to preview" },
        template_type: {
          type: "string",
          enum: ["campaign", "tx"],
          description: "Template type for unsaved body preview (default: 'campaign')",
        },
        body: { type: "string", description: "Template body to preview when id is not provided" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_default_template",
    description: "Set a template as the default template.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Template ID to set as default" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_campaigns",
    description: "List email campaigns with optional search, status filtering, and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query" },
        status: {
          type: "string",
          description:
            "Optional campaign status filter (draft, scheduled, running, paused, cancelled, finished)",
        },
        page: { type: "integer", description: "Page number (1-based)" },
        per_page: { type: "integer", description: "Results per page" },
        order_by: { type: "string", description: "Sort column" },
        dir: { type: "string", enum: ["ASC", "DESC"], description: "Sort direction" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_campaign",
    description: "Get a single campaign by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Campaign ID" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_campaign",
    description: "Update editable content and settings of a draft campaign.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Campaign ID" },
        name: { type: "string", description: "Campaign name" },
        subject: { type: "string", description: "Email subject line" },
        from_email: { type: "string", description: "Sender email address" },
        body: { type: "string", description: "Campaign body content in Liquid" },
        altbody: { type: "string", description: "Optional plain-text alternative body" },
        content_type: {
          type: "string",
          enum: ["richtext", "html", "markdown", "plain"],
          description: "Content type",
        },
        template_id: { type: "integer", description: "ID of template to use as layout" },
        lists: { type: "array", items: { type: "integer" }, description: "Target list IDs" },
        tags: { type: "array", items: { type: "string" }, description: "Campaign tags" },
        headers: {
          type: "array",
          items: { type: "object" },
          description: "Optional custom email headers",
        },
        attribs: { type: "object", description: "Custom subscriber/campaign attributes" },
        send_at: {
          type: "string",
          description: "Optional scheduled send timestamp (ISO 8601)",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_campaign",
    description: "Render an HTML preview of a campaign with sample subscriber data.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Campaign ID" },
        body: { type: "string", description: "Optional unsaved body to preview with the campaign" },
        content_type: {
          type: "string",
          enum: ["richtext", "html", "markdown", "plain"],
          description: "Optional content type",
        },
        template_id: { type: "integer", description: "Optional template ID override" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "campaign_text",
    description: "Render plain-text preview of a campaign.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Campaign ID" },
        body: { type: "string", description: "Optional unsaved body to preview" },
        content_type: { type: "string", description: "Optional content type" },
        template_id: { type: "integer", description: "Optional template ID override" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_campaign_test",
    description: "Send a test campaign email to specified subscriber email addresses.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Campaign ID" },
        subscribers: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses for the test send",
        },
        name: { type: "string", description: "Optional campaign name override" },
        subject: { type: "string", description: "Optional subject override" },
        from_email: { type: "string", description: "Optional sender email override" },
        body: { type: "string", description: "Optional body override in Liquid" },
        content_type: {
          type: "string",
          enum: ["richtext", "html", "markdown", "plain"],
          description: "Optional content type override",
        },
        template_id: { type: "integer", description: "Optional template ID override" },
      },
      required: ["id", "subscribers"],
      additionalProperties: false,
    },
  },
  {
    name: "template_reference",
    description:
      "Returns documentation of supported Liquid variables, tags, and filters for template and campaign editing, with examples.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
  },
];

async function callEndpoint(
  app: App,
  router: Router,
  authHeader: string,
  peerAddress: string,
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json",
  cookieHeader?: string,
): Promise<ToolResult> {
  const url = `http://127.0.0.1${path}`;
  const headers: Record<string, string> = {};
  if (authHeader) headers["authorization"] = authHeader;
  if (cookieHeader) headers["cookie"] = cookieHeader;

  let requestBody: BodyInit | undefined;
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    if (contentType === "application/json") {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(body);
    } else if (contentType === "application/x-www-form-urlencoded") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      requestBody =
        typeof body === "string"
          ? body
          : new URLSearchParams(body as Record<string, string>).toString();
    }
  }

  const init: RequestInit = {
    method,
    headers,
  };
  if (requestBody !== undefined) {
    init.body = requestBody;
  }
  const request = new Request(url, init);

  const response = await router.handle(app, request, peerAddress);
  const text = await response.text();
  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;

  if (!response.ok) {
    let errorMessage = text;
    if (isJson) {
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) errorMessage = parsed.message;
      } catch {}
    }
    return {
      content: [{ type: "text", text: errorMessage || `HTTP ${response.status}` }],
      isError: true,
      resultType: "complete",
    };
  }

  if (isJson) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        structuredContent: parsed,
        isError: false,
        resultType: "complete",
      };
    } catch {}
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: { text },
    isError: false,
    resultType: "complete",
  };
}

async function getStoredCampaign(
  app: App,
  router: Router,
  authHeader: string,
  peerAddress: string,
  cookieHeader: string | undefined,
  id: string | number,
): Promise<{ data?: Record<string, unknown>; error?: ToolResult }> {
  const res = await callEndpoint(
    app,
    router,
    authHeader,
    peerAddress,
    "GET",
    `/api/campaigns/${encodeURIComponent(String(id))}`,
    undefined,
    "application/json",
    cookieHeader,
  );
  if (res.isError) {
    return { error: res };
  }
  const structured = res.structuredContent as { data?: Record<string, unknown> } | undefined;
  if (!structured?.data) {
    return {
      error: {
        content: [{ type: "text", text: "Campaign not found" }],
        isError: true,
        resultType: "complete",
      },
    };
  }
  return { data: structured.data };
}

export async function executeTool(
  name: string,
  app: App,
  router: Router,
  authHeader: string,
  peerAddress: string,
  args: Record<string, unknown>,
  cookieHeader?: string,
): Promise<ToolResult> {
  switch (name) {
    case "list_templates": {
      const params = new URLSearchParams();
      if (typeof args.query === "string" && args.query) params.set("query", args.query);
      if (args.no_body === true) params.set("no_body", "true");
      const qs = params.toString() ? `?${params.toString()}` : "";
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "GET",
        `/api/templates${qs}`,
        undefined,
        "application/json",
        cookieHeader,
      );
    }
    case "get_template": {
      const id = encodeURIComponent(String(args.id));
      const qs = args.no_body === true ? "?no_body=true" : "";
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "GET",
        `/api/templates/${id}${qs}`,
        undefined,
        "application/json",
        cookieHeader,
      );
    }
    case "create_template": {
      const body: Record<string, unknown> = {
        name: args.name,
        type: args.type,
      };
      if (args.subject !== undefined) body.subject = args.subject;
      if (args.body !== undefined) body.body = args.body;
      if (args.is_default !== undefined) body.is_default = args.is_default;
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "POST",
        "/api/templates",
        body,
        "application/json",
        cookieHeader,
      );
    }
    case "update_template": {
      const id = encodeURIComponent(String(args.id));
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.type !== undefined) body.type = args.type;
      if (args.subject !== undefined) body.subject = args.subject;
      if (args.body !== undefined) body.body = args.body;
      if (args.is_default !== undefined) body.is_default = args.is_default;
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "PUT",
        `/api/templates/${id}`,
        body,
        "application/json",
        cookieHeader,
      );
    }
    case "delete_template": {
      const id = encodeURIComponent(String(args.id));
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "DELETE",
        `/api/templates/${id}`,
        undefined,
        "application/json",
        cookieHeader,
      );
    }
    case "preview_template": {
      if (args.id !== undefined && args.id !== null) {
        const id = encodeURIComponent(String(args.id));
        return callEndpoint(
          app,
          router,
          authHeader,
          peerAddress,
          "GET",
          `/api/templates/${id}/preview`,
          undefined,
          "application/json",
          cookieHeader,
        );
      }
      const form = new URLSearchParams();
      form.set(
        "template_type",
        typeof args.template_type === "string" ? args.template_type : "campaign",
      );
      form.set("body", typeof args.body === "string" ? args.body : "");
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "POST",
        "/api/templates/preview",
        form.toString(),
        "application/x-www-form-urlencoded",
        cookieHeader,
      );
    }
    case "set_default_template": {
      const id = encodeURIComponent(String(args.id));
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "PUT",
        `/api/templates/${id}/default`,
        undefined,
        "application/json",
        cookieHeader,
      );
    }
    case "list_campaigns": {
      const params = new URLSearchParams();
      if (typeof args.query === "string" && args.query) params.set("query", args.query);
      if (typeof args.status === "string" && args.status) params.set("status", args.status);
      if (typeof args.page === "number") params.set("page", String(args.page));
      if (typeof args.per_page === "number") params.set("per_page", String(args.per_page));
      if (typeof args.order_by === "string") params.set("order_by", args.order_by);
      if (typeof args.dir === "string") params.set("dir", args.dir);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "GET",
        `/api/campaigns${qs}`,
        undefined,
        "application/json",
        cookieHeader,
      );
    }
    case "get_campaign": {
      const id = encodeURIComponent(String(args.id));
      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "GET",
        `/api/campaigns/${id}`,
        undefined,
        "application/json",
        cookieHeader,
      );
    }
    case "update_campaign": {
      const id = encodeURIComponent(String(args.id));
      const stored = await getStoredCampaign(
        app,
        router,
        authHeader,
        peerAddress,
        cookieHeader,
        args.id as string | number,
      );
      if (stored.error) return stored.error;
      const data = stored.data ?? {};

      const storedLists = Array.isArray(data.lists)
        ? data.lists.map((l: any) => (typeof l === "object" && l !== null ? l.id : l))
        : [];
      const storedMedia = Array.isArray(data.media)
        ? data.media.map((m: any) => (typeof m === "object" && m !== null ? m.id : m))
        : [];

      const body: Record<string, unknown> = {
        name: args.name !== undefined ? args.name : data.name,
        subject: args.subject !== undefined ? args.subject : data.subject,
        from_email: args.from_email !== undefined ? args.from_email : data.from_email,
        body: args.body !== undefined ? args.body : data.body,
        content_type: args.content_type !== undefined ? args.content_type : data.content_type,
        lists: args.lists !== undefined ? args.lists : storedLists,
        media: storedMedia,
        template_id: args.template_id !== undefined ? args.template_id : data.template_id,
        tags: args.tags !== undefined ? args.tags : data.tags,
        headers: args.headers !== undefined ? args.headers : data.headers,
        attribs: args.attribs !== undefined ? args.attribs : data.attribs,
        messenger: data.messenger ?? "email",
      };
      if (args.altbody !== undefined) {
        body.altbody = args.altbody;
      } else if (data.altbody !== undefined && data.altbody !== null) {
        body.altbody = data.altbody;
      }
      if (args.send_at !== undefined) {
        body.send_at = args.send_at;
      } else if (data.send_at !== undefined && data.send_at !== null) {
        body.send_at = data.send_at;
      }
      if (data.archive !== undefined) {
        body.archive = data.archive;
      }
      if (data.archive_slug !== undefined) {
        body.archive_slug = data.archive_slug;
      }
      if (data.archive_template_id !== undefined) {
        body.archive_template_id = data.archive_template_id;
      }
      if (data.archive_meta !== undefined) {
        body.archive_meta = data.archive_meta;
      }

      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "PUT",
        `/api/campaigns/${id}`,
        body,
        "application/json",
        cookieHeader,
      );
    }
    case "preview_campaign": {
      const id = encodeURIComponent(String(args.id));
      const hasBody = typeof args.body === "string";
      const hasContentType = typeof args.content_type === "string";
      const hasTemplateId = typeof args.template_id === "number";

      if (!hasBody && !hasContentType && !hasTemplateId) {
        return callEndpoint(
          app,
          router,
          authHeader,
          peerAddress,
          "GET",
          `/api/campaigns/${id}/preview`,
          undefined,
          "application/json",
          cookieHeader,
        );
      }

      let body = hasBody ? (args.body as string) : undefined;
      let contentType = hasContentType ? (args.content_type as string) : undefined;
      let templateId = hasTemplateId ? (args.template_id as number) : undefined;

      if (body === undefined || contentType === undefined || templateId === undefined) {
        const stored = await getStoredCampaign(
          app,
          router,
          authHeader,
          peerAddress,
          cookieHeader,
          args.id as string | number,
        );
        if (stored.error) return stored.error;
        if (body === undefined) body = String(stored.data?.body ?? "");
        if (contentType === undefined)
          contentType = String(stored.data?.content_type ?? "richtext");
        if (templateId === undefined && typeof stored.data?.template_id === "number") {
          templateId = stored.data.template_id;
        }
      }

      const form = new URLSearchParams();
      form.set("body", body ?? "");
      if (contentType) form.set("content_type", contentType);
      if (templateId !== undefined) form.set("template_id", String(templateId));

      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "POST",
        `/api/campaigns/${id}/preview`,
        form.toString(),
        "application/x-www-form-urlencoded",
        cookieHeader,
      );
    }
    case "campaign_text": {
      const id = encodeURIComponent(String(args.id));
      let body = typeof args.body === "string" ? (args.body as string) : undefined;
      let contentType =
        typeof args.content_type === "string" ? (args.content_type as string) : undefined;
      let templateId =
        typeof args.template_id === "number" ? (args.template_id as number) : undefined;

      if (body === undefined || contentType === undefined || templateId === undefined) {
        const stored = await getStoredCampaign(
          app,
          router,
          authHeader,
          peerAddress,
          cookieHeader,
          args.id as string | number,
        );
        if (stored.error) return stored.error;
        if (body === undefined) body = String(stored.data?.body ?? "");
        if (contentType === undefined)
          contentType = String(stored.data?.content_type ?? "richtext");
        if (templateId === undefined && typeof stored.data?.template_id === "number") {
          templateId = stored.data.template_id;
        }
      }

      const form = new URLSearchParams();
      form.set("body", body ?? "");
      if (contentType) form.set("content_type", contentType);
      if (templateId !== undefined) form.set("template_id", String(templateId));

      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "POST",
        `/api/campaigns/${id}/text`,
        form.toString(),
        "application/x-www-form-urlencoded",
        cookieHeader,
      );
    }
    case "send_campaign_test": {
      const id = encodeURIComponent(String(args.id));
      const stored = await getStoredCampaign(
        app,
        router,
        authHeader,
        peerAddress,
        cookieHeader,
        args.id as string | number,
      );
      if (stored.error) return stored.error;
      const data = stored.data ?? {};

      const storedLists = Array.isArray(data.lists)
        ? data.lists.map((l: any) => (typeof l === "object" && l !== null ? l.id : l))
        : [];
      const storedMedia = Array.isArray(data.media)
        ? data.media.map((m: any) => (typeof m === "object" && m !== null ? m.id : m))
        : [];

      const body: Record<string, unknown> = {
        name: args.name ?? data.name,
        subject: args.subject ?? data.subject,
        from_email: args.from_email ?? data.from_email,
        body: args.body ?? data.body,
        content_type: args.content_type ?? data.content_type,
        lists: storedLists,
        media: storedMedia,
        subscribers: args.subscribers,
        messenger: data.messenger ?? "email",
        headers: data.headers ?? [],
        attribs: data.attribs ?? {},
        tags: data.tags ?? [],
      };
      if (args.template_id !== undefined) {
        body.template_id = args.template_id;
      } else if (data.template_id !== undefined) {
        body.template_id = data.template_id;
      }
      if (data.altbody !== undefined && data.altbody !== null) {
        body.altbody = data.altbody;
      }

      return callEndpoint(
        app,
        router,
        authHeader,
        peerAddress,
        "POST",
        `/api/campaigns/${id}/test`,
        body,
        "application/json",
        cookieHeader,
      );
    }
    case "template_reference": {
      return {
        content: [{ type: "text", text: TEMPLATE_REFERENCE }],
        structuredContent: { reference: TEMPLATE_REFERENCE },
        isError: false,
        resultType: "complete",
      };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
        resultType: "complete",
      };
  }
}
