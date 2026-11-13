// MCP tool annotations (D98). Clients use them to decide when to ask a person before a call.

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

/** Reads and previews: change nothing and send nothing. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** Creates or changes data; nothing is deleted and no mail or outside call is made. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** Deletes, blocks, or changes what is live: may not be undone. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

/** Sends email or calls an outside URL, so the effect leaves this system. */
export const OPEN_WORLD: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
