// Production scheduler, outbox and their owners wired as src/main.ts does, without HTTP, for the
// compiled crash fixture and the throughput measurement. Fixture data is generated and seeded
// through SQL arrangement plus the enrollments owner; mail goes to a loopback sink only.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createSubscriberStore } from "@/subscribers/store";
import { createQueryRunner, openReadOnly } from "@/subscribers/query-runner";
import { createEmailer } from "@/messaging/email";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { createTemplateStore } from "@/templates/store";
import { createRenderer } from "@/templates/renderer";
import { createEventStore } from "@/events/store";
import { createConditionEvaluator } from "@/conditions/evaluate";
import { createEnrollments } from "@/sequences/enrollments";
import { startScheduler, type Scheduler } from "@/scheduler/scheduler";
import { createMarketingPolicy, type MarketingSettings } from "@/unsubscribe/policy";
import { createTracking } from "@/unsubscribe/tracking";

export type Wrap = <T extends object>(name: string, owner: T) => T;

export function startRuntime(options: {
  dataDir: string;
  smtpPort: number;
  clock: Clock;
  /** Replace owner objects passed to the scheduler, e.g. to stop the process at a barrier. */
  wrap?: Wrap;
  /** Start the outbox (default true). */
  outbox?: boolean;
  /** Start the scheduler (default true). */
  scheduler?: boolean;
}) {
  const { clock } = options;
  const wrap: Wrap = options.wrap ?? ((_name, owner) => owner);
  const errors: unknown[] = [];
  const logger = {
    error(error: unknown) {
      errors.push(error);
      console.error(error instanceof Error ? error.message : String(error));
    },
  };
  const db = openDatabase(options.dataDir);
  runMigrations(db, options.dataDir, clock, productionMigrations);
  const lists = createListReferences(db);
  const enrollments = createEnrollments(db, clock);
  const subscribers = createSubscriberStore(db, clock, lists, enrollments.subscriberEffects);
  const readonly = openReadOnly(db.filename);
  const runner = createQueryRunner({ path: db.filename, timeoutMs: 10_000, concurrency: 2 });
  const renderer = createRenderer(clock, createTranslation());
  const templateReferences = createCampaignTemplateReferences(db);
  const templates = createTemplateStore(db, clock, renderer, templateReferences, logger);
  templates.initialize();
  const marketing: MarketingSettings = {
    rootUrl: "http://scheduler.test",
    siteName: "Scheduler fixture",
    minInterval: "",
    unsubscribeHeader: true,
    allowBlocklist: false,
    individualTracking: false,
    disableTracking: false,
  };
  const emailer = createEmailer({
    clock,
    settings: () => ({
      rootUrl: "http://scheduler.test",
      smtp: [
        {
          name: "sink",
          enabled: true,
          exclude_from_default: false,
          host: "127.0.0.1",
          port: options.smtpPort,
          hello_hostname: "scheduler.test",
          max_conns: 4,
          idle_timeout: "2s",
          wait_timeout: "2s",
          auth_protocol: "none",
          username: "",
          tls_type: "none",
          tls_skip_verify: false,
          email_headers: [],
          from_addresses: [],
        },
      ],
    }),
    copyAllowed: (address) => !addressBlocklisted(subscribers, address),
  });
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://scheduler.test",
    marketingPolicy: createMarketingPolicy({ subscribers, lists, settings: () => marketing }),
  });
  const tracking = createTracking(db, clock);
  const outbox =
    options.outbox === false ? undefined : startOutbox({ db, clock, logger, sends, emailer });
  const events = createEventStore(db, subscribers, {
    emailAllowed: () => true,
    exitThenTrigger: enrollments.exitThenTrigger,
  });
  const conditions = createConditionEvaluator({ readonly, runner });
  const scheduler: Scheduler | undefined =
    options.scheduler === false
      ? undefined
      : startScheduler({
          db,
          clock,
          logger,
          enrollments: wrap("enrollments", enrollments),
          sends: wrap("sends", sends),
          subscribers,
          templates,
          events,
          renderer,
          tracking,
          conditions,
          settings: () => ({ fromEmail: "Fixture <noreply@scheduler.test>", marketing }),
        });
  if (scheduler) enrollments.onDue(() => scheduler.wake());
  return {
    db,
    errors,
    enrollments,
    sends,
    scheduler,
    outbox,
    async close() {
      enrollments.onDue(() => {});
      await scheduler?.stop().catch(() => {});
      await outbox?.stop().catch(() => {});
      await emailer.close();
      await runner.close();
      conditions.close();
      events.close();
      tracking.close();
      sends.close();
      templates.close();
      templateReferences.close();
      readonly.close();
      subscribers.close();
      enrollments.close();
      lists.close();
      db.close(true);
    },
  };
}

/**
 * Generated data: one single opt-in list, `count` confirmed subscribers, a tx template and an
 * active sequence with the given steps, and one manual enrollment per subscriber.
 */
export function seed(
  db: Database,
  enrollments: ReturnType<typeof createEnrollments>,
  count: number,
  steps: { wait: string; kind: "transactional" | "marketing" }[],
) {
  return writeTransaction(db, () => {
    const list = db
      .query<{ id: bigint }, [string]>(
        "INSERT INTO lists(uuid, name, type, optin) VALUES (?, 'news', 'public', 'single') RETURNING id",
      )
      .get(crypto.randomUUID())!.id;
    const template = db
      .query<{ id: bigint }, []>(
        "INSERT INTO templates(name, type, subject, body) VALUES ('sequence', 'tx', 'Step {{ step.position }} for {{ subscriber.name }}', '<p>Hello {{ subscriber.name }} <a href=\"{{ unsubscribe_url }}\">unsubscribe</a></p>') RETURNING id",
      )
      .get()!.id;
    const sequence = db
      .query<{ id: bigint }, [string, bigint]>(
        `INSERT INTO sequences(uuid, name, status, trigger, exit_on, reentry, list_id)
         VALUES (?, 'Fixture', 'active', '{"event":"fixture"}', '[]', 'always', ?) RETURNING id`,
      )
      .get(crypto.randomUUID(), list)!.id;
    steps.forEach((step, position) =>
      db.run(
        "INSERT INTO sequence_steps(uuid, sequence_id, position, wait, kind, template_id) VALUES (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), sequence, position, step.wait, step.kind, template],
      ),
    );
    const subscriber = db.query<{ id: bigint }, [string, string, string]>(
      "INSERT INTO subscribers(uuid, email, name) VALUES (?, ?, ?) RETURNING id",
    );
    const member = db.query(
      "INSERT INTO subscriber_lists(subscriber_id, list_id, status) VALUES (?, ?, 'confirmed')",
    );
    for (let i = 0; i < count; i++) {
      const id = subscriber.get(crypto.randomUUID(), `s${i}@scheduler.test`, `Subscriber ${i}`)!.id;
      member.run(id, list);
      const outcome = enrollments.enroll(sequence, id, false);
      if (!("enrollment" in outcome)) throw new Error(outcome.error);
    }
    return { list, template, sequence };
  });
}

/** A real clock shifted by a fixed offset, so a restart can model time after lease expiry. */
export function offsetClock(base: Clock, offsetMs: number): Clock {
  return { now: () => new Date(base.now().getTime() + offsetMs), sleep: base.sleep };
}
