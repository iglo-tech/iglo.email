// Which API operations the MCP endpoint exposes as tools, and which it leaves out (D98).
// Every operation in src/openapi/operations.ts is one of: covered by a hand-written tool below,
// excluded below with its reason, or generated as a tool (src/mcp/generated.ts). The MCP test
// suite holds the document to exactly that split.

/**
 * Operations a hand-written tool fully covers. The tool keeps its own name and arguments, and no
 * generated tool repeats it. `update_sequence_step` changes one step, so it covers no operation
 * here: the whole `updateSequenceById` is generated.
 */
export const HANDWRITTEN_COVERAGE: Record<string, string> = {
  getTemplates: "list_templates",
  getTemplateById: "get_template",
  createTemplate: "create_template",
  updateTemplateById: "update_template",
  deleteTemplateById: "delete_template",
  previewTemplateById: "preview_template",
  previewTemplateBody: "preview_template",
  updateDefaultTemplateById: "set_default_template",
  getCampaigns: "list_campaigns",
  getCampaignById: "get_campaign",
  updateCampaignById: "update_campaign",
  previewCampaignById: "preview_campaign",
  previewCampaignBody: "preview_campaign",
  previewCampaignText: "campaign_text",
  testCampaignById: "send_campaign_test",
  createCampaign: "create_campaign",
  getLists: "list_lists",
  getMedia: "list_media",
  getSequences: "list_sequences",
  getSequenceById: "get_sequence",
};

/** Operations no tool exposes, each with its reason. Adding an endpoint means adding it here or leaving it generated. */
export const EXCLUDED_OPERATIONS: Record<string, string> = {
  // Not agent actions: anonymous, health and document endpoints, the MCP endpoint itself, provider webhooks.
  getHealthCheck: "Anonymous liveness probe for load balancers.",
  getAuthenticatedHealth: "Liveness probe, not an action.",
  getOpenApiDocument: "The API document itself.",
  mcpGet: "The MCP endpoint itself.",
  mcpEndpoint: "The MCP endpoint itself.",
  getPublicLists: "Anonymous public signup page data.",
  getPublicArchive: "Anonymous public archive page data.",
  createPublicSubscription: "Anonymous public signup form.",
  getAltchaChallenge: "Anonymous captcha challenge for the public signup form.",
  postBounce: "Bounce webhook from the mail provider, not an agent action.",
  postServiceBounce: "Anonymous bounce webhook from the mail provider.",

  // Privilege: an agent must not grant access to anyone, itself included, or change its own login.
  logout: "Ends a browser session.",
  updateProfile: "Changes the caller's own login and profile.",
  generateTotp: "Two-factor setup is for a person in a browser session.",
  enableTotp: "Two-factor setup is for a person in a browser session.",
  disableTotp: "Two-factor setup is for a person in a browser session.",
  createUser: "Creates an account with access.",
  deleteUsers: "Removes accounts in bulk.",
  updateUserById: "Changes an account's role, status or credentials.",
  deleteUserById: "Removes an account.",
  createUserRole: "Defines what a user role may do.",
  updateUserRole: "Changes what a user role may do.",
  createListRole: "Defines which lists a list role may read and manage.",
  updateListRole: "Changes which lists a list role may read and manage.",
  deleteRole: "Removes a role that accounts may depend on.",

  // Bulk or irreversible: the single-item forms of the same work stay exposed.
  deleteSubscribers: "Bulk delete of subscribers.",
  deleteSubscriberByExternalQuery:
    "Irreversible delete addressed by a query parameter; the path form deletes one subscriber.",
  deleteSubscribersByQuery: "Irreversible bulk delete of subscribers matched by a query.",
  blocklistSubscribersByQuery: "Bulk blocklist of subscribers matched by a query.",
  manageSubscriberListsByQuery: "Bulk list change for subscribers matched by a query.",
  deleteCampaigns: "Bulk delete of campaigns.",
  deleteLists: "Bulk delete of lists.",
  deleteBounces: "Bulk delete of bounce records.",
  deleteSubscribersByMaintenance: "Maintenance: irreversible bulk delete of subscribers.",
  deleteUnconfirmedSubscriptions:
    "Maintenance: irreversible bulk delete of unconfirmed subscriptions.",
  deleteAnalytics: "Maintenance: irreversible delete of analytics history.",

  // Whole-settings replace: each key changes through updateSettingByKey, one at a time.
  updateSettings: "Replaces every setting at once; settings change one key at a time.",
};
