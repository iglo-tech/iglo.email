// The stable machine-readable `code` of every API error (B131, D129). Each error JSON keeps
// listmonk's `message` and adds one of these, snake_case and fixed here, so a client can branch on
// it without parsing English. A route names a finer code on its HttpError; every other error takes
// the code of its status. docs/design/07-api-and-ui.md#error-codes lists them.
export const ERROR_CODES = [
  "invalid_fields",
  "unauthorized",
  "permission_denied",
  "not_found",
  "method_not_allowed",
  "invalid_credentials",
  "conflict",
  "email_conflict",
  "external_id_conflict",
  "subscriber_changed",
  "test_running",
  "upload_changed",
  "payload_too_large",
  "unsupported_media_type",
  "result_too_large",
  "rate_limited",
  "client_closed",
  "held",
  "unavailable",
  "internal_error",
  "not_implemented",
  "bad_gateway",
  "error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The code an error of each status takes when its route names none. */
const DEFAULT_CODES = new Map<number, ErrorCode>([
  [400, "invalid_fields"],
  [401, "unauthorized"],
  [403, "permission_denied"],
  [404, "not_found"],
  [405, "method_not_allowed"],
  [409, "conflict"],
  [413, "payload_too_large"],
  [415, "unsupported_media_type"],
  [422, "result_too_large"],
  [429, "rate_limited"],
  [499, "client_closed"],
  [500, "internal_error"],
  [501, "not_implemented"],
  [502, "bad_gateway"],
  [503, "unavailable"],
]);

/** Every code an answer of each status can carry, for the OpenAPI document. */
const CODES_BY_STATUS = new Map<number, ReadonlyArray<ErrorCode>>([
  // A missing numeric ID is a 400 in listmonk, so its `not_found` is a 400 code too.
  [400, ["invalid_fields", "not_found"]],
  [401, ["unauthorized"]],
  [403, ["permission_denied", "invalid_credentials"]],
  [404, ["not_found"]],
  [405, ["method_not_allowed"]],
  [
    409,
    [
      "conflict",
      "email_conflict",
      "external_id_conflict",
      "subscriber_changed",
      "test_running",
      "upload_changed",
    ],
  ],
  [413, ["payload_too_large"]],
  [415, ["unsupported_media_type"]],
  [422, ["result_too_large"]],
  [429, ["rate_limited"]],
  [499, ["client_closed"]],
  [500, ["internal_error"]],
  [501, ["not_implemented"]],
  [502, ["bad_gateway"]],
  [503, ["unavailable", "held"]],
]);

export function defaultErrorCode(status: number): ErrorCode {
  return DEFAULT_CODES.get(status) ?? "error";
}

export function errorCodesFor(status: number): ReadonlyArray<ErrorCode> {
  return CODES_BY_STATUS.get(status) ?? ["error"];
}
