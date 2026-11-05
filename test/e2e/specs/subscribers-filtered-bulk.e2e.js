// Filtered bulk actions of the subscribers screen, status/list/orphan/search scopes, from listmonk
// tests/specs/subscribers.spec.js at 6fcd95f. The cases are in subscribers-helpers.js; the other
// scopes are in subscribers-filtered-bulk-query.e2e.js, so two stacks can run them side by side.
import { test } from "../helpers.js";
import { filteredBulkActions } from "../subscribers-helpers.js";

test.describe.configure({ mode: "serial" });

filteredBulkActions(["status", "list", "orphan", "search"]);
