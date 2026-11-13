// MCP tools definitions and in-process execution handlers.
import type { App } from "@/app";
import type { Router } from "@/server/router";
import { TEMPLATE_REFERENCE } from "@/mcp/reference";
import { DESTRUCTIVE, OPEN_WORLD, READ_ONLY, WRITE, type ToolAnnotations } from "@/mcp/annotations";
import { HANDWRITTEN_COVERAGE } from "@/mcp/coverage";
import { GENERATED, GENERATED_BY_NAME, operationRequest, toolFor } from "@/mcp/generated";
import { operations, type Operation } from "@/openapi/operations";

/** The largest non-JSON answer a tool returns (CSV, HTML); a larger one is refused with the REST endpoint to use (D98). */
const MCP_MAX_ANSWER_BYTES = 1024 * 1024;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: ToolAnnotations;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: string;
}

const OPERATION = new Map(operations.map((op) => [op.id, op]));
const operation = (id: string): Operation => {
  const op = OPERATION.get(id);
  if (!op) throw new Error(`no operation ${id} for a hand-written MCP tool`);
  return op;
};

/**
 * Where a hand-written tool takes an API field under its own argument name, the field is not added
 * again: `dir` is the `order` of getCampaigns (D98).
 */
const ARGUMENT_FOR_FIELD: Record<string, Record<string, string>> = {
  list_campaigns: { order: "dir" },
};
const argumentFor = (tool: string, field: string): string =>
  ARGUMENT_FOR_FIELD[tool]?.[field] ?? field;

/**
 * Each query parameter and body field of an operation, with the schema the generated tool builds for
 * it (generated.ts, D98). A path parameter is the tool's own `id`, so it is left out.
 */
function operationFields(op: Operation): Record<string, unknown> {
  const properties = (toolFor(op.id, op).inputSchema.properties ?? {}) as Record<string, unknown>;
  const query = new Set((op.query ?? []).map((param) => param.name));
  const fields: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(properties)) {
    if (op.route.includes(`{${name}}`)) continue;
    if (name === "body" && op.body && !query.has(name))
      Object.assign(fields, (schema as { properties?: Record<string, unknown> }).properties);
    else fields[name] = schema;
  }
  return fields;
}

/**
 * A hand-written tool takes every field of the operations it covers (coverage.ts, D98). Its own
 * arguments keep their names and schemas; a field no argument takes is added.
 */
function withOperationFields(tool: ToolDefinition): ToolDefinition {
  const properties: Record<string, unknown> = { ...tool.inputSchema.properties };
  for (const [id, covered] of Object.entries(HANDWRITTEN_COVERAGE)) {
    if (covered !== tool.name) continue;
    for (const [field, schema] of Object.entries(operationFields(operation(id)))) {
      if (argumentFor(tool.name, field) in properties) continue;
      properties[field] = schema;
    }
  }
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

/**
 * The query string the operation's query parameters take from a tool's arguments. An absent, null or
 * empty argument is left out; an array is sent as one parameter per item.
 */
function queryFor(tool: string, opId: string, args: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const { name } of operation(opId).query ?? []) {
    const value = args[argumentFor(tool, name)];
    if (value === undefined || value === null || value === "") continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(name, String(item));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

const HANDWRITTEN_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_templates",
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: WRITE,
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
    annotations: WRITE,
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
    annotations: DESTRUCTIVE,
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
    annotations: READ_ONLY,
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
    annotations: WRITE,
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
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: WRITE,
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
        media: {
          type: "array",
          items: { type: "integer" },
          description: "Attached media IDs (from list_media); omit to keep the stored media",
        },
        tags: { type: "array", items: { type: "string" }, description: "Campaign tags" },
        headers: {
          type: "array",
          items: { type: "object" },
          description: "Optional custom email headers",
        },
        attribs: { type: "object", description: "Custom subscriber/campaign attributes" },
        send_at: {
          type: ["string", "null"],
          description:
            "Scheduled send timestamp (ISO 8601). null clears the schedule; omit to keep the stored one.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_campaign",
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: OPEN_WORLD,
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
    name: "create_campaign",
    annotations: WRITE,
    description:
      "Create a draft email campaign. Get list IDs from list_lists and media IDs from list_media. Returns the created campaign.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Campaign name" },
        subject: { type: "string", description: "Email subject line" },
        from_email: {
          type: "string",
          description: "Sender email address (omit to use the default sender)",
        },
        lists: {
          type: "array",
          items: { type: "integer" },
          description: "Target list IDs (at least one)",
        },
        body: { type: "string", description: "Campaign body content in Liquid" },
        altbody: { type: "string", description: "Optional plain-text alternative body" },
        content_type: {
          type: "string",
          enum: ["richtext", "html", "markdown", "plain"],
          description: "Content type (default richtext)",
        },
        template_id: { type: "integer", description: "ID of template to use as layout" },
        media: {
          type: "array",
          items: { type: "integer" },
          description: "Media IDs to attach (from list_media)",
        },
        headers: {
          type: "array",
          items: { type: "object" },
          description: "Optional custom email headers",
        },
        attribs: { type: "object", description: "Custom subscriber/campaign attributes" },
        tags: { type: "array", items: { type: "string" }, description: "Campaign tags" },
        send_at: {
          type: "string",
          description: "Optional scheduled send timestamp (ISO 8601)",
        },
        messenger: {
          type: "string",
          enum: ["email"],
          description: "Sending channel (email)",
        },
      },
      required: ["name", "subject", "lists"],
      additionalProperties: false,
    },
  },
  {
    name: "list_lists",
    annotations: READ_ONLY,
    description:
      "List mailing lists with their ID, name, type, opt-in and subscriber counts. Use the IDs with create_campaign and update_campaign.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search term to filter lists by name" },
        page: { type: "integer", description: "Page number (1-based)" },
        per_page: { type: "integer", description: "Results per page" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_media",
    annotations: READ_ONLY,
    description:
      "List uploaded media files with their ID, filename and URL. Use the IDs to attach media to a campaign or reference the URL in a body.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search term to filter media by filename" },
        page: { type: "integer", description: "Page number (1-based)" },
        per_page: { type: "integer", description: "Results per page" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_sequences",
    annotations: READ_ONLY,
    description: "List sequences with optional status filtering and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["draft", "active", "paused", "archived"],
          description: "Optional sequence status filter",
        },
        page: { type: "integer", description: "Page number (1-based)" },
        per_page: { type: "integer", description: "Results per page" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_sequence",
    annotations: READ_ONLY,
    description: "Get a single sequence by its ID, with all of its steps.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Sequence ID" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_sequence_step",
    annotations: WRITE,
    description:
      "Change the subject or the transactional template of one step of a sequence. The sequence settings and every other step are kept as stored. Get step IDs from get_sequence. Saving rewrites every step, so the caller must be allowed to save all of them: if another step has a raw-SQL condition, the caller also needs subscribers:sql_query, or the save is refused.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Sequence ID" },
        step_id: { type: "integer", description: "Step ID to change (from get_sequence)" },
        subject: {
          type: ["string", "null"],
          description: "Subject for the step; null removes the subject override",
        },
        template_id: {
          type: "integer",
          description: "ID of the transactional template the step sends",
        },
      },
      required: ["id", "step_id"],
      additionalProperties: false,
    },
  },
  {
    name: "template_reference",
    annotations: READ_ONLY,
    description:
      "Returns documentation of supported Liquid variables, tags, and filters for template and campaign editing, with examples.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
  },
];

const HANDWRITTEN = HANDWRITTEN_DEFINITIONS.map(withOperationFields);

/** Every tool: the hand-written ones, then one per operation the document has and no hand-written tool covers (D98). */
export const TOOLS: ToolDefinition[] = [...HANDWRITTEN, ...GENERATED.map((entry) => entry.tool)];

function extractPositiveIds(items: unknown): number[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) =>
      typeof item === "object" && item !== null ? (item as { id?: unknown }).id : item,
    )
    .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true, resultType: "complete" };
}

/** A tool's answer and the HTTP status it came from, so a read-merge tool can tell a refused read apart. */
interface EndpointReply {
  status: number;
  result: ToolResult;
}

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
  csrfHeader?: string,
  originHeader?: string,
): Promise<EndpointReply> {
  const url = `http://127.0.0.1${path}`;
  const headers: Record<string, string> = {};
  if (authHeader) headers["authorization"] = authHeader;
  if (cookieHeader) headers["cookie"] = cookieHeader;
  if (csrfHeader) headers["x-csrf-token"] = csrfHeader;
  if (originHeader) headers["origin"] = originHeader;

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
    } else if (contentType === "multipart/form-data") {
      // The boundary belongs to the Request that builds the FormData, so no content-type is set here.
      requestBody = body as FormData;
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
  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;

  // Every answer, JSON or not, is read under the cap before it is parsed or returned, and the stream
  // is cancelled past it, so a large page or export is refused rather than held in memory (D98).
  const text = await readCapped(response, MCP_MAX_ANSWER_BYTES);
  if (text === undefined) {
    const route = path.split("?", 1)[0];
    const next = isJson
      ? "Narrow it with page and per_page, or fetch it from the REST API instead"
      : "Fetch it from the REST API instead";
    return {
      status: response.status,
      result: toolError(
        `The answer is larger than the ${MCP_MAX_ANSWER_BYTES}-byte MCP limit, so it was not returned. ${next}: ${method} ${route}`,
      ),
    };
  }

  if (!response.ok) {
    let errorMessage = text;
    if (isJson) {
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) errorMessage = parsed.message;
      } catch {}
    }
    return {
      status: response.status,
      result: {
        content: [{ type: "text", text: errorMessage || `HTTP ${response.status}` }],
        isError: true,
        resultType: "complete",
      },
    };
  }

  if (!isJson) {
    return {
      status: response.status,
      result: { content: [{ type: "text", text }], isError: false, resultType: "complete" },
    };
  }

  // A JSON answer under the cap is returned twice, as its parsed value (structuredContent, which the
  // hand-written tools read) and as compact text. Both copies are at most the cap; no pretty copy (D98).
  try {
    const parsed = JSON.parse(text) as unknown;
    return {
      status: response.status,
      result: {
        content: [{ type: "text", text: JSON.stringify(parsed) }],
        structuredContent: parsed,
        isError: false,
        resultType: "complete",
      },
    };
  } catch {
    return {
      status: response.status,
      result: { content: [{ type: "text", text }], isError: false, resultType: "complete" },
    };
  }
}

/** The body as text, or undefined once it is over `limit` bytes. Reading stops and the stream is cancelled at the cap. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * A read-merge tool reads the stored object before it writes or renders. When the caller may not read
 * it, the error names the tool and the read permission; the tool has not written anything at that point.
 */
function storedReadError(
  reply: EndpointReply,
  tool: string,
  readPermission: string,
): ToolResult | undefined {
  if (reply.status === 403) {
    const reason = reply.result.content[0]?.text ?? "permission denied";
    return toolError(
      `${tool} reads the stored object first, so the caller needs ${readPermission}. Nothing was changed. (${reason})`,
    );
  }
  return reply.result.isError ? reply.result : undefined;
}

async function getStoredCampaign(
  call: (method: string, path: string) => Promise<EndpointReply>,
  id: string | number,
  tool: string,
): Promise<{ data?: Record<string, unknown>; error?: ToolResult }> {
  const reply = await call("GET", `/api/campaigns/${encodeURIComponent(String(id))}`);
  const readError = storedReadError(
    reply,
    tool,
    "campaigns:get_all, or campaigns:get with a list role that includes one of the campaign's lists",
  );
  if (readError) {
    return { error: readError };
  }
  const structured = reply.result.structuredContent as
    | { data?: Record<string, unknown> }
    | undefined;
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
  csrfHeader?: string,
  originHeader?: string,
): Promise<ToolResult> {
  const call = (method: string, path: string, body?: unknown, contentType = "application/json") =>
    callEndpoint(
      app,
      router,
      authHeader,
      peerAddress,
      method,
      path,
      body,
      contentType,
      cookieHeader,
      csrfHeader,
      originHeader,
    );
  const invoke = async (
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<ToolResult> => (await call(method, path, body, contentType)).result;
  const storedCampaign = (id: string | number) => getStoredCampaign(call, id, name);

  switch (name) {
    case "list_templates":
      return invoke("GET", `/api/templates${queryFor(name, "getTemplates", args)}`);
    case "get_template": {
      const id = encodeURIComponent(String(args.id));
      return invoke("GET", `/api/templates/${id}${queryFor(name, "getTemplateById", args)}`);
    }
    case "create_template": {
      const body: Record<string, unknown> = {
        name: args.name,
        type: args.type,
      };
      if (args.subject !== undefined) body.subject = args.subject;
      if (args.body !== undefined) body.body = args.body;
      if (args.body_source !== undefined) body.body_source = args.body_source;
      if (args.is_default !== undefined) body.is_default = args.is_default;
      return invoke("POST", "/api/templates", body);
    }
    case "update_template": {
      const id = encodeURIComponent(String(args.id));
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.type !== undefined) body.type = args.type;
      if (args.subject !== undefined) body.subject = args.subject;
      if (args.body !== undefined) body.body = args.body;
      if (args.body_source !== undefined) body.body_source = args.body_source;
      if (args.is_default !== undefined) body.is_default = args.is_default;
      return invoke("PUT", `/api/templates/${id}`, body);
    }
    case "delete_template": {
      const id = encodeURIComponent(String(args.id));
      return invoke("DELETE", `/api/templates/${id}`);
    }
    case "preview_template": {
      if (args.id !== undefined && args.id !== null) {
        const id = encodeURIComponent(String(args.id));
        return invoke("GET", `/api/templates/${id}/preview`);
      }
      const form = new URLSearchParams();
      form.set(
        "template_type",
        typeof args.template_type === "string" ? args.template_type : "campaign",
      );
      form.set("body", typeof args.body === "string" ? args.body : "");
      return invoke(
        "POST",
        "/api/templates/preview",
        form.toString(),
        "application/x-www-form-urlencoded",
      );
    }
    case "set_default_template": {
      const id = encodeURIComponent(String(args.id));
      return invoke("PUT", `/api/templates/${id}/default`);
    }
    case "list_campaigns": {
      // The endpoint reads the direction as lower case only (asc or desc), so dir is sent that way.
      const dir = typeof args.dir === "string" ? args.dir.toLowerCase() : args.dir;
      return invoke("GET", `/api/campaigns${queryFor(name, "getCampaigns", { ...args, dir })}`);
    }
    case "get_campaign": {
      const id = encodeURIComponent(String(args.id));
      return invoke("GET", `/api/campaigns/${id}${queryFor(name, "getCampaignById", args)}`);
    }
    case "update_campaign": {
      const id = encodeURIComponent(String(args.id));
      const stored = await storedCampaign(args.id as string | number);
      if (stored.error) return stored.error;
      const data = stored.data ?? {};

      const storedLists = extractPositiveIds(data.lists);
      const storedMedia = extractPositiveIds(data.media);

      const body: Record<string, unknown> = {
        name: args.name !== undefined ? args.name : data.name,
        subject: args.subject !== undefined ? args.subject : data.subject,
        from_email: args.from_email !== undefined ? args.from_email : data.from_email,
        body: args.body !== undefined ? args.body : data.body,
        content_type: args.content_type !== undefined ? args.content_type : data.content_type,
        lists: args.lists !== undefined ? args.lists : storedLists,
        media: args.media !== undefined ? args.media : storedMedia,
        template_id: args.template_id !== undefined ? args.template_id : data.template_id,
        tags: args.tags !== undefined ? args.tags : data.tags,
        headers: args.headers !== undefined ? args.headers : data.headers,
        attribs: args.attribs !== undefined ? args.attribs : data.attribs,
        messenger: args.messenger !== undefined ? args.messenger : (data.messenger ?? "email"),
        // Passed through unchanged; the endpoint keeps the stored type of a campaign, so a change here is not applied.
        type: args.type !== undefined ? args.type : data.type,
        body_source: args.body_source !== undefined ? args.body_source : data.body_source,
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
      // Each archive field a caller gives wins; one left out keeps its stored value.
      for (const field of [
        "archive",
        "archive_slug",
        "archive_template_id",
        "archive_meta",
      ] as const) {
        const value = args[field] !== undefined ? args[field] : data[field];
        if (value !== undefined) body[field] = value;
      }

      return invoke("PUT", `/api/campaigns/${id}`, body);
    }
    case "preview_campaign": {
      const id = encodeURIComponent(String(args.id));
      const hasBody = typeof args.body === "string";
      const hasContentType = typeof args.content_type === "string";
      const hasTemplateId = typeof args.template_id === "number";

      if (!hasBody && !hasContentType && !hasTemplateId) {
        return invoke("GET", `/api/campaigns/${id}/preview`);
      }

      let body = hasBody ? (args.body as string) : undefined;
      let contentType = hasContentType ? (args.content_type as string) : undefined;
      let templateId = hasTemplateId ? (args.template_id as number) : undefined;

      if (body === undefined || contentType === undefined || templateId === undefined) {
        const stored = await storedCampaign(args.id as string | number);
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

      return invoke(
        "POST",
        `/api/campaigns/${id}/preview`,
        form.toString(),
        "application/x-www-form-urlencoded",
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
        const stored = await storedCampaign(args.id as string | number);
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

      return invoke(
        "POST",
        `/api/campaigns/${id}/text`,
        form.toString(),
        "application/x-www-form-urlencoded",
      );
    }
    case "send_campaign_test": {
      const id = encodeURIComponent(String(args.id));
      const stored = await storedCampaign(args.id as string | number);
      if (stored.error) return stored.error;
      const data = stored.data ?? {};

      const storedLists = extractPositiveIds(data.lists);
      const storedMedia = extractPositiveIds(data.media);

      const body: Record<string, unknown> = {
        name: args.name ?? data.name,
        subject: args.subject ?? data.subject,
        from_email: args.from_email ?? data.from_email,
        body: args.body ?? data.body,
        content_type: args.content_type ?? data.content_type,
        lists: args.lists ?? storedLists,
        media: args.media ?? storedMedia,
        subscribers: args.subscribers,
        messenger: args.messenger ?? data.messenger ?? "email",
        headers: args.headers ?? data.headers ?? [],
        attribs: data.attribs ?? {},
        tags: data.tags ?? [],
      };
      if (args.template_id !== undefined) {
        body.template_id = args.template_id;
      } else if (data.template_id !== undefined) {
        body.template_id = data.template_id;
      }
      if (args.altbody !== undefined) {
        body.altbody = args.altbody;
      } else if (data.altbody !== undefined && data.altbody !== null) {
        body.altbody = data.altbody;
      }

      // The test renders the template the query names (template_id), so an override goes there too.
      return invoke(
        "POST",
        `/api/campaigns/${id}/test${queryFor(name, "testCampaignById", args)}`,
        body,
      );
    }
    case "create_campaign": {
      const body: Record<string, unknown> = {};
      for (const field of Object.keys(operationFields(operation("createCampaign")))) {
        if (args[field] !== undefined) body[field] = args[field];
      }
      return invoke("POST", "/api/campaigns", body);
    }
    case "list_lists":
      return invoke("GET", `/api/lists${queryFor(name, "getLists", args)}`);
    case "list_media":
      return invoke("GET", `/api/media${queryFor(name, "getMedia", args)}`);
    case "list_sequences":
      return invoke("GET", `/api/sequences${queryFor(name, "getSequences", args)}`);
    case "get_sequence": {
      const id = encodeURIComponent(String(args.id));
      return invoke("GET", `/api/sequences/${id}`);
    }
    case "update_sequence_step": {
      // Nothing to change: refuse before any read or write, so the sequence is not saved or re-stamped.
      if (args.subject === undefined && args.template_id === undefined) {
        return toolError("Nothing to change: give subject or template_id.");
      }
      // PUT replaces the whole definition and omitted steps are deleted, so read every field first.
      const id = encodeURIComponent(String(args.id));
      const current = await call("GET", `/api/sequences/${id}`);
      const readError = storedReadError(current, name, "sequences:get");
      if (readError) return readError;
      const sequence = (
        current.result.structuredContent as { data?: Record<string, unknown> } | undefined
      )?.data;
      if (!sequence) return toolError("Sequence not found");
      const stored = Array.isArray(sequence.steps)
        ? (sequence.steps as Record<string, unknown>[])
        : [];
      const index = stored.findIndex((step) => step.id === args.step_id);
      if (index < 0) {
        return toolError(`Step ${String(args.step_id)} is not a step of sequence ${id}`);
      }
      const steps = stored.map((step) => ({
        id: step.id,
        wait: step.wait,
        kind: step.kind,
        template_id: step.template_id,
        subject: step.subject,
        condition: step.condition,
        on_false: step.on_false,
        cap_policy: step.cap_policy,
        max_late: step.max_late,
      }));
      if (args.subject !== undefined) steps[index]!.subject = args.subject;
      if (args.template_id !== undefined) steps[index]!.template_id = args.template_id;
      // status is left out: the endpoint keeps the stored status, so a status change made since the read is not reverted.
      return invoke("PUT", `/api/sequences/${id}`, {
        name: sequence.name,
        trigger: sequence.trigger,
        exit_on: sequence.exit_on,
        reentry: sequence.reentry,
        list_id: sequence.list_id,
        steps,
      });
    }
    case "template_reference": {
      return {
        content: [{ type: "text", text: TEMPLATE_REFERENCE }],
        structuredContent: { reference: TEMPLATE_REFERENCE },
        isError: false,
        resultType: "complete",
      };
    }
    default: {
      const generated = GENERATED_BY_NAME.get(name);
      if (generated) {
        const request = operationRequest(generated.operation, args);
        if ("error" in request) return toolError(request.error);
        return invoke(request.method, request.path, request.body, request.contentType);
      }
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
        resultType: "complete",
      };
    }
  }
}
