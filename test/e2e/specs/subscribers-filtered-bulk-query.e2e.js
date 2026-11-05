// Filtered bulk actions of the subscribers screen, query/subscription/list query params scopes,
// from listmonk tests/specs/subscribers.spec.js at 6fcd95f. The cases are in
// subscribers-helpers.js; the other scopes are in subscribers-filtered-bulk.e2e.js.
import { test } from "../helpers.js";
import { filteredBulkActions } from "../subscribers-helpers.js";

test.describe.configure({ mode: "serial" });

filteredBulkActions(["query", "subscription", "list query params"]);
