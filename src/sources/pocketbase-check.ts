// Native (15-external-sources section 2, D170, D188): the PocketBase connector's "Test connection".
// Signs in with the service account, reads one page of the recipients view and one of the events collection, and the users
// collection with the leaving filter when one is set, and reports each step and what is missing.
import type { Clock } from "@/clock";
import type { Guard, SourceTransport } from "@/sources/connect";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { PocketBaseConfig, PocketBaseSource } from "@/sources/pocketbase";
import { LEAVING_TOO_LONG, leavingTopic } from "@/sources/pocketbase-stream";
import { isSourceError } from "@/sources/source";
import type { CheckReport, CheckStep } from "@/sources/source";

const TIMEOUT_MS = 10_000;

const errorText = (error: unknown) =>
  isSourceError(error) ? error.message : "The check failed unexpectedly";

/**
 * Reads `collection` with a filter naming every field once; a 400 is narrowed to the fields the
 * collection lacks, one probe each.
 */
async function fields(
  source: PocketBaseSource,
  step: string,
  collection: string,
  names: Array<string>,
): Promise<CheckStep> {
  const probe = (list: Array<string>) =>
    source.probe(collection, list.map((name) => `${name} = ${name}`).join(" && "), {
      timeoutMs: TIMEOUT_MS,
    });
  const answer = await probe(names);
  if (answer.status === 404) {
    return { step, ok: false, message: `There is no collection ${collection}.`, missing: [] };
  }
  if (answer.status === 403) {
    return {
      step,
      ok: false,
      message: `The service account may not list ${collection}: set its list and view rules.`,
      missing: [],
    };
  }
  if (answer.status === 400) {
    const missing: Array<string> = [];
    for (const name of names) {
      if ((await probe([name])).status === 400) {
        missing.push(name);
      }
    }
    return {
      step,
      ok: false,
      message: missing.length
        ? `${collection} has no field ${missing.join(", ")}.`
        : `${collection} refused the read: ${answer.message}`,
      missing,
    };
  }
  if (answer.status !== 200) {
    return {
      step,
      ok: false,
      message: `${collection} answered ${answer.status} ${answer.message}`.trim(),
      missing: [],
    };
  }
  return {
    step,
    ok: true,
    message: answer.rows
      ? `${collection}: read.`
      : `${collection}: read, but there are no records yet, or the list rule hides them from the service account.`,
    missing: [],
  };
}

/**
 * D172: a collection a guest can read fails the check. PocketBase reads a revoked token as a guest,
 * and the adapter confirms its token only after a short or empty answer, so a guest-readable
 * collection could answer a revoked token with a full page of what guests see.
 */
async function guestCheck(
  source: PocketBaseSource,
  result: CheckStep,
  collection: string,
  authCollection: string,
): Promise<CheckStep> {
  if (!result.ok) {
    return result;
  }
  const guest = await source.guestProbe(collection, { timeoutMs: TIMEOUT_MS });
  if (guest.status === 200 && guest.rows > 0) {
    return {
      ...result,
      ok: false,
      message: `Guests can read ${collection}: set its list and view rules so that only the service account can read it (for example @request.auth.collectionName = "${authCollection}").`,
    };
  }
  // B171 (D199): only PocketBase's own refusals pass: an empty `200` (a rule that hides every
  // row), a `403` (no rule) or a `404`. Any other answer (a proxy's 401, 3xx, 429 or 5xx, a
  // broken rule's 400) shows nothing about the rule, so the step fails naming it. A `401` is not
  // PocketBase's answer to a guest's list: something in front asks for credentials, which a
  // revoked token carries past it.
  if (guest.status !== 200 && guest.status !== 403 && guest.status !== 404) {
    return {
      ...result,
      ok: false,
      message:
        `Could not check that guests cannot read ${collection}: a guest's read answered ${guest.status} ${guest.message}`.trim(),
    };
  }
  return result;
}

export async function checkSource(
  config: PocketBaseConfig,
  clock: Clock,
  guard: Guard,
  transport?: SourceTransport,
): Promise<CheckReport> {
  const steps: Array<CheckStep> = [];
  const done = () => ({ ok: steps.every((step) => step.ok), steps });
  let source: PocketBaseSource;
  try {
    const options: Parameters<typeof createPocketBaseSource>[0] = { config, clock, guard };
    if (transport) {
      options.transport = transport;
    }
    source = createPocketBaseSource(options);
    await source.authenticate({ timeoutMs: TIMEOUT_MS });
    steps.push({ step: "auth", ok: true, message: "Signed in.", missing: [] });
  } catch (error) {
    steps.push({ step: "auth", ok: false, message: errorText(error), missing: [] });
    return done();
  }
  const { events, recipients, users } = config;
  const run = async (step: string, work: () => Promise<CheckStep>) => {
    try {
      steps.push(await work());
    } catch (error) {
      steps.push({ step, ok: false, message: errorText(error), missing: [] });
    }
  };
  await run("recipients", async () =>
    guestCheck(
      source,
      await fields(
        source,
        "recipients",
        recipients.collection,
        [recipients.email, recipients.name, recipients.optOut].filter(Boolean),
      ),
      recipients.collection,
      config.authCollection,
    ),
  );
  await run("events", async () =>
    guestCheck(
      source,
      await fields(
        source,
        "events",
        events.collection,
        [events.user, events.name, events.data, events.occurredAt, events.key, "created"].filter(
          Boolean,
        ),
      ),
      events.collection,
      config.authCollection,
    ),
  );
  if (users.collection) {
    await run("users", async () => {
      // B169 (D197): the stream sorts and bounds the users it catches up by `updated`, as the
      // events step probes `created`.
      const named = await fields(source, "users", users.collection, ["updated"]);
      if (!named.ok) {
        return named;
      }
      // B171 (D199): the stream subscribes to the filter, which must fit PocketBase's topic limit.
      if (leavingTopic(users.collection, users.leavingFilter) === null) {
        return {
          step: "users",
          ok: false,
          message: `${users.collection}: ${LEAVING_TOO_LONG}.`,
          missing: [],
        };
      }
      const answer = await source.probe(users.collection, users.leavingFilter, {
        timeoutMs: TIMEOUT_MS,
      });
      return answer.status === 200
        ? {
            step: "users",
            ok: true,
            message: `${users.collection}: the leaving filter reads.`,
            missing: [],
          }
        : {
            step: "users",
            ok: false,
            message:
              answer.status === 400
                ? `${users.collection} refused the leaving filter: ${answer.message}`
                : `${users.collection} answered ${answer.status} ${answer.message}`.trim(),
            missing: [],
          };
    });
  }
  return done();
}
