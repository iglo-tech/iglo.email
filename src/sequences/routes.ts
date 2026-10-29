// Native sequences and enrollments API (docs/design/05-sequences.md, 07-api-and-ui.md);
// no upstream endpoint. Reads need `sequences:get`; writes need `sequences:manage` and are
// revalidated and validated inside their write transaction, so a permission or definition
// change cannot interleave with them.
import { writeTransaction } from "@/db/transaction";
import { parseJson, readBounded } from "@/events/input";
import type { Roles } from "@/roles/roles";
import {
  idValue,
  DefinitionError,
  definitionInput,
  limits,
  sequenceStatuses,
} from "@/sequences/input";
import type { SequenceStatus } from "@/sequences/input";
import { project, type EnrollmentFilter, type Enrollments } from "@/sequences/enrollments";
import { SequenceConflict, type SequenceStore } from "@/sequences/store";
import type { RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import type { SubscriberStore } from "@/subscribers/store";
import type { Authentication } from "@/users/auth";

const GET = "sequences:get";
const MANAGE = "sequences:manage";
/** Small bodies: status changes and manual enrolls. */
const SMALL_BODY_BYTES = 4 * 1024;
const enrollmentStatuses = ["active", "completed", "exited", "canceled"];
const MAX_EXIT_REASON = 256;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function registerSequenceRoutes(
  router: Router,
  deps: {
    sequences: SequenceStore;
    enrollments: Enrollments;
    subscribers: Pick<SubscriberStore, "get">;
    roles: Roles;
    auth: Authentication;
  },
) {
  const { sequences, enrollments, subscribers, roles, auth } = deps;
  const invalid = (c: RequestContext, field: string, detail?: string) =>
    new HttpError(
      400,
      c.app.i18n.Ts(
        "globals.messages.invalidFields",
        "name",
        detail ? `${field} (${detail})` : field,
      ),
    );
  const body = async (c: RequestContext, limit: number) => {
    const value = parseJson(c.request, await readBounded(c.request, limit));
    if (!isObject(value)) throw invalid(c, "body");
    return value;
  };
  const identity = (c: RequestContext) => {
    if (!c.identity) throw new Error("Identity required");
    return c.identity;
  };
  /** Validate a definition and write it, both inside one write transaction. */
  const save = (
    c: RequestContext,
    value: unknown,
    write: (input: ReturnType<typeof definitionInput>) => unknown,
  ) =>
    writeTransaction(c.app.db, () => {
      auth.revalidate(c, MANAGE);
      const i = identity(c);
      try {
        const input = definitionInput(value, {
          canUseSql: roles.can(i.role, "subscribers:sql_query"),
          templateType: sequences.templateType,
          listUsable: (id) =>
            sequences.listExists(id) &&
            (roles.canList(i.role, i.user.list_role_id, "list:get", [id]) ||
              roles.canList(i.role, i.user.list_role_id, "list:manage", [id])),
        });
        return write(input);
      } catch (error) {
        if (error instanceof DefinitionError || error instanceof SequenceConflict)
          throw invalid(c, error.field, error.detail);
        throw error;
      }
    });
  const params = (c: RequestContext) => {
    const search = c.url.searchParams;
    const one = (key: string) => {
      const values = search.getAll(key);
      if (values.length > 1) throw invalid(c, key);
      return values[0];
    };
    const positive = (key: string, max: bigint) => {
      const raw = one(key);
      if (raw === undefined) return undefined;
      if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) > max) throw invalid(c, key);
      return BigInt(raw);
    };
    return { one, positive };
  };
  const paging = (c: RequestContext) => {
    const { positive } = params(c);
    return {
      page: Number(positive("page", 1_000_000n) ?? 1n),
      perPage: Number(positive("per_page", 100n) ?? 20n),
    };
  };
  const maxID = 9223372036854775807n;

  router.route(
    "GET",
    "/api/sequences",
    (c) => {
      const status = params(c).one("status");
      if (status !== undefined && !(sequenceStatuses as readonly string[]).includes(status))
        throw invalid(c, "status");
      return ok(
        sequences.list({
          ...paging(c),
          ...(status === undefined ? {} : { status }),
        }),
      );
    },
    auth.middleware(GET),
  );
  router.route(
    "GET",
    "/api/sequences/:id",
    (c) => {
      const found = sequences.get(BigInt(getID(c)));
      if (!found) throw new HttpError(404, "Sequence not found");
      return ok(found);
    },
    auth.middleware(GET),
    hasID,
  );
  router.route(
    "POST",
    "/api/sequences",
    async (c) => {
      const value = await body(c, limits.bodyBytes);
      return ok(save(c, value, (input) => sequences.create(input)));
    },
    auth.middleware(MANAGE),
  );
  router.route(
    "PUT",
    "/api/sequences/:id",
    async (c) => {
      const value = await body(c, limits.bodyBytes);
      const id = BigInt(getID(c));
      const saved = save(c, value, (input) => sequences.update(id, input));
      if (!saved) throw new HttpError(404, "Sequence not found");
      return ok(saved);
    },
    auth.middleware(MANAGE),
    hasID,
  );
  router.route(
    "PUT",
    "/api/sequences/:id/status",
    async (c) => {
      const value = await body(c, SMALL_BODY_BYTES);
      const status = value.status;
      if (typeof status !== "string" || !(sequenceStatuses as readonly string[]).includes(status))
        throw invalid(c, "status");
      const id = BigInt(getID(c));
      const saved = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        try {
          return sequences.setStatus(id, status as SequenceStatus);
        } catch (error) {
          if (error instanceof SequenceConflict) throw invalid(c, error.field, error.detail);
          throw error;
        }
      });
      if (!saved) throw new HttpError(404, "Sequence not found");
      return ok(saved);
    },
    auth.middleware(MANAGE),
    hasID,
  );
  router.route(
    "DELETE",
    "/api/sequences/:id",
    (c) => {
      const id = BigInt(getID(c));
      const result = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        return sequences.remove(id);
      });
      if (result === "missing") throw new HttpError(404, "Sequence not found");
      if (result === "enrolled")
        throw new HttpError(409, "The sequence has enrollments; archive it instead.");
      return ok(true);
    },
    auth.middleware(MANAGE),
    hasID,
  );

  router.route(
    "GET",
    "/api/enrollments",
    (c) => {
      const { one, positive } = params(c);
      const filter: EnrollmentFilter = paging(c);
      const sequenceId = positive("sequence_id", maxID),
        subscriberId = positive("subscriber_id", maxID),
        status = one("status"),
        exitReason = one("exit_reason");
      if (status !== undefined && !enrollmentStatuses.includes(status)) throw invalid(c, "status");
      if (exitReason !== undefined && (!exitReason || exitReason.length > MAX_EXIT_REASON))
        throw invalid(c, "exit_reason");
      if (sequenceId !== undefined) filter.sequenceId = sequenceId;
      if (subscriberId !== undefined) filter.subscriberId = subscriberId;
      if (status !== undefined) filter.status = status;
      if (exitReason !== undefined) filter.exitReason = exitReason;
      return ok(enrollments.list(filter));
    },
    auth.middleware(GET),
  );
  router.route(
    "GET",
    "/api/enrollments/:id",
    (c) => {
      const row = enrollments.get(BigInt(getID(c)));
      if (!row) throw new HttpError(404, "Enrollment not found");
      return ok(project(row));
    },
    auth.middleware(GET),
    hasID,
  );
  router.route(
    "POST",
    "/api/enrollments",
    async (c) => {
      const value = await body(c, SMALL_BODY_BYTES);
      let sequenceId: bigint | undefined, subscriberId: bigint | undefined;
      try {
        sequenceId = idValue(value.sequence_id, "sequence_id");
        subscriberId = idValue(value.subscriber_id, "subscriber_id");
      } catch (error) {
        if (error instanceof DefinitionError) throw invalid(c, error.field);
        throw error;
      }
      if (sequenceId === undefined) throw invalid(c, "sequence_id");
      if (subscriberId === undefined) throw invalid(c, "subscriber_id");
      if (value.force !== undefined && typeof value.force !== "boolean") throw invalid(c, "force");
      const force = value.force === true;
      const outcome = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        const subscriber = subscribers.get(subscriberId);
        if (!subscriber) throw new HttpError(404, "Subscriber not found");
        if (subscriber.status === "blocklisted")
          throw new HttpError(409, "The subscriber is blocklisted.");
        return enrollments.enroll(sequenceId, subscriberId, force);
      });
      if ("enrollment" in outcome) return ok(project(outcome.enrollment));
      if (outcome.error === "sequence_missing") throw new HttpError(404, "Sequence not found");
      if (outcome.error === "sequence_inactive")
        throw new HttpError(409, "The sequence is not active.");
      if (outcome.error === "no_steps") throw new HttpError(409, "The sequence has no steps.");
      throw new HttpError(409, "The sequence's reentry rule does not allow this enrollment.");
    },
    auth.middleware(MANAGE),
  );
  router.route(
    "DELETE",
    "/api/enrollments/:id",
    (c) => {
      const id = BigInt(getID(c));
      const result = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        return enrollments.cancel(id);
      });
      if (result === "missing") throw new HttpError(404, "Enrollment not found");
      if (result === "inactive") throw new HttpError(409, "The enrollment is not active.");
      return ok(project(result));
    },
    auth.middleware(MANAGE),
    hasID,
  );
}
