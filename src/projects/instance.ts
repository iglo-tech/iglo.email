// The instance (14-projects sections 1–3, 9 and 10, D142, D151, D157): instance.db with its
// registry, one wired project per registered project, the routing table that picks a project by
// `Host`, and the lifecycle that creates, edits and deletes projects while it runs. Native: listmonk
// serves one database per process. main() owns the lock, the bind and the signals.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Clock } from "@/clock";
import { must } from "@/invariant";
import { openDatabase } from "@/db/connection";
import { instanceMigrations, runMigrations } from "@/db/migrations";
import { createApp } from "@/app";
import { createInstanceRouter } from "@/admin/instance/routes";
import type { InstanceProjects, ProjectSummary } from "@/admin/instance/projects";
import { createTranslation } from "@/i18n/i18n";
import { createInstanceLogBuffer, mergeLogs } from "@/maintenance/log-buffer";
import { createAdminSync } from "@/projects/admin-sync";
import { createInstanceBudgets } from "@/projects/budgets";
import type { InstanceBudgets } from "@/projects/budgets";
import { createProject } from "@/projects/compose";
import { createDispatcher } from "@/messaging/dispatcher";
import type { Dispatcher } from "@/messaging/dispatcher";
import type { SMTPServer } from "@/messaging/email";
import type { Project, ProjectOptions, ProjectServer } from "@/projects/compose";
import { archiveDeleted } from "@/projects/deleted";
import type { DeletedProject } from "@/projects/deleted";
import {
  INSTANCE_DATABASE,
  PROJECTS,
  oldLayoutMessage,
  preMigrationDirectory,
  projectDirectory,
  usesOldLayout,
} from "@/projects/layout";
import { createInstanceLogger } from "@/projects/logger";
import {
  RegistryError,
  SLUG_PATTERN,
  createRegistry,
  normalizeHostname,
  projectName,
  requestHostname,
} from "@/projects/registry";
import type { NewProject, ProjectChange, ProjectRecord, Registry } from "@/projects/registry";
import { SES_PATH, registerSesRoute } from "@/bounces/ses-route";
import type { PageSite } from "@/public/layout";
import { Router } from "@/server/router";
import { ok } from "@/server/response";
import { defaults } from "@/settings/defaults";
import { holdForInstance } from "@/settings/hold";
import { sessionDuration } from "@/settings/duration";
import { createInstanceSettings, instanceLoginSettings } from "@/settings/instance";
import type { InstanceSettingsStore } from "@/settings/instance";
import { createClientAddress } from "@/server/client-address";
import { defaultAuthPolicy } from "@/users/auth";
import { createAdminAccountStore } from "@/users/account";
import type { AdminAccountStore } from "@/users/account";
import { initialAdmin } from "@/users/bootstrap";
import { createHandoffTokens } from "@/users/handoff";
import { createInstanceAuth } from "@/users/instance-auth";
import { hashPassword } from "@/users/password";
import { createCapacity } from "@/messaging/capacity";
import type { Capacity } from "@/messaging/capacity";
import { createSesAccount } from "@/messaging/ses-account";
import type { SesAccount } from "@/messaging/ses-account";

/** The paths the instance answers on the instance host and on an unclaimed one (section 2). */
function instancePath(pathname: string): boolean {
  return (
    pathname === "/admin/instance" ||
    pathname.startsWith("/admin/instance/") ||
    pathname === "/api/instance" ||
    pathname.startsWith("/api/instance/")
  );
}

/** The fresh install's one project (D151). Its name is the site name's default. */
export const PRIMARY_SLUG = "main";

/** The Projects page's "sent" window. */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InstanceConfig {
  readonly dataDir: string;
  /** `--root-url`: its host is the instance host, and the primary project's root URL is it. */
  readonly rootUrl: string;
  readonly listen: { readonly host: string; readonly port: number };
  /**
   * The environment's first users: the admin account on a first start with none (B140, D153), and
   * the API user, seeded as before into the primary project while it has no users (D151).
   */
  readonly seed: ProjectOptions["seed"];
  /** SES's API base URL for a region (B145a); AWS's own unless a test gives its stand-in. */
  readonly sesEndpoint?: (region: string) => string;
}

interface Entry {
  /** Replaced by an edit (a rename or new extra hostnames). */
  record: ProjectRecord;
  readonly project: Project;
  /** Requests the project's router is answering now. */
  requests: number;
  /** Set by a delete waiting for `requests` to reach 0. */
  idle: (() => void) | undefined;
  /** Off the routing table, being deleted: a loop's failure no longer stops the process. */
  removed: boolean;
}

/**
 * `--root-url` with its host replaced by `hostname`: scheme, port and path are kept
 * (14-projects section 2).
 */
export function projectRootUrl(rootUrl: string, hostname: string): string {
  const url = new URL(rootUrl);
  const rest = url.href.slice(url.origin.length);
  const origin = `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;
  // A root URL without a trailing slash keeps none, as the bootstrap gave it.
  return origin + (rest === "/" && !rootUrl.endsWith("/") ? "" : rest);
}

/** The instance's own public page brand, for the SES route's 404 and 429 without a primary. */
const instancePageSite = (rootUrl: string): PageSite => ({
  rootUrl: rootUrl.replace(/\/+$/, ""),
  logoUrl: "",
  faviconUrl: "",
  subscriptionPage: false,
  archive: false,
  siteUrl: "",
  accent: "",
  font: "system-sans",
  header: "auto",
  siteName: "iglo.email",
});

const notFound = () =>
  new Response("404 page not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** The directories under `projects/`, by name. */
function projectDirectories(root: string): Array<string> {
  return existsSync(resolve(root, PROJECTS))
    ? readdirSync(resolve(root, PROJECTS), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted()
    : [];
}

function newEntry(record: ProjectRecord, project: Project): Entry {
  return { record, project, requests: 0, idle: undefined, removed: false };
}

export type Instance = Awaited<ReturnType<typeof openInstance>>;

/**
 * Opens and migrates `instance.db` in a data directory of today's layout; the caller closes it.
 * A test fixture registers projects through it (with createRegistry) before a start.
 */
export function openInstanceDatabase(dataDir: string, clock: Clock): Database {
  const root = resolve(dataDir);
  if (usesOldLayout(root)) {
    throw new Error(oldLayoutMessage(root));
  }
  const db = openDatabase(root, INSTANCE_DATABASE);
  try {
    runMigrations(db, root, clock, instanceMigrations, {
      directory: preMigrationDirectory(root),
      name: "instance",
    });
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

/**
 * Opens and migrates instance.db, registers the primary project on a fresh install, and wires every
 * registered project (none of their loops start yet: B52). The caller already holds the lock.
 */
export async function openInstance(config: InstanceConfig, clock: Clock) {
  const root = resolve(config.dataDir);
  const instanceHost = normalizeHostname(new URL(config.rootUrl).hostname);
  const db = openInstanceDatabase(root, clock);
  let registry: Registry | undefined;
  let budgets: InstanceBudgets | undefined;
  let account: AdminAccountStore | undefined;
  let settings: InstanceSettingsStore | undefined;
  /** The one dispatcher every project sends through (B141): its pools, rate and start schedule. */
  let dispatcher: Dispatcher | undefined;
  let unsubscribeRate: (() => void) | undefined;
  /** The SES account snapshot and the capacity forecast over every project (B145a). */
  let ses: SesAccount | undefined;
  let capacity: Capacity | undefined;
  /** Wired projects in registration order (slug order at start). */
  const entries: Array<Entry> = [];
  /** The routing table: hostname to project, and the primary for every other host. */
  let hosts = new Map<string, Entry>();
  let primary: Entry | undefined;
  let server: ProjectServer | undefined;
  let fail: ((failure?: unknown) => void) | undefined;
  /** Projects whose loops failed: the instance health route turns unhealthy. */
  const down = new Set<string>();
  /** Slugs whose directory a create or a delete is working on: not leftovers. */
  const busy = new Set<string>();
  // The instance's own lines: stderr and the buffer the instance Logs page shows (D157).
  const instanceLogs = createInstanceLogBuffer(clock);
  const { logger: instanceLogger, attention } = createInstanceLogger(instanceLogs);

  /**
   * Create, edit and delete run one at a time (D157): a create that loses a same-slug race sees the
   * winner's directory and removes nothing, and no edit sees a half-deleted project.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const rebuild = () => {
    const next = new Map<string, Entry>();
    for (const entry of entries) {
      for (const hostname of [entry.record.hostname, ...entry.record.extra]) {
        next.set(hostname, entry);
      }
    }
    hosts = next;
    primary = entries.find((entry) => entry.record.primary);
  };

  const options = (record: ProjectRecord): ProjectOptions => ({
    slug: record.slug,
    name: record.name,
    directory: projectDirectory(root, record.slug),
    // The primary project's root URL is `--root-url` itself, so one install's links are unchanged.
    rootUrl: record.primary ? config.rootUrl : projectRootUrl(config.rootUrl, record.hostname),
    snapshots: { directory: preMigrationDirectory(root), name: record.slug },
    // The environment's API user is the primary project's only: an API credential is one project's.
    seed: record.primary ? config.seed : { admin: config.seed.admin },
  });

  const tokens = createHandoffTokens(clock);
  const adminSync = () =>
    createAdminSync({
      account: must(account, "admin account"),
      projects: () =>
        entries.map((entry) => ({
          slug: entry.record.slug,
          syncAdmin: (current: Parameters<Project["syncAdmin"]>[0]) =>
            entry.project.syncAdmin(current),
        })),
      attention,
    });
  let sync: ReturnType<typeof adminSync> | undefined;

  const wire = async (record: ProjectRecord) => {
    const admin = must(sync, "admin sync");
    const project = await createProject(
      {
        clock,
        budgets: must(budgets, "budgets"),
        settings: must(settings, "instance settings").reader,
        dispatcher: must(dispatcher, "dispatcher"),
        instanceRootUrl: config.rootUrl,
        listen: config.listen,
        admin: {
          account: admin.account,
          changed: (slug, credentials) => admin.change(slug, credentials),
          redeem: (slug, token) => tokens.redeem(slug, token),
        },
        projects: () => entries.map(({ record: r }) => ({ slug: r.slug, name: r.name })),
        capacity: must(capacity, "capacity"),
      },
      options(record),
    );
    // A restored instance.db holds every project's sending until it is released (D158).
    holdForInstance(project.db, db);
    return project;
  };

  /** Only the primary project may hold the instance host (14-projects section 2). */
  const checkInstanceHost = (record: Pick<ProjectRecord, "primary" | "hostname" | "extra">) => {
    if (!record.primary && [record.hostname, ...record.extra].includes(instanceHost)) {
      throw new RegistryError(
        409,
        `The instance host ${instanceHost} can only be the primary project's`,
      );
    }
  };

  const closeAll = async () => {
    // A create or delete in progress finishes first: it may still write the registry.
    await queue;
    for (const entry of entries.toReversed()) {
      await entry.project.close();
    }
    entries.length = 0;
    // Last in the shutdown order (14-projects section 7): every project has stopped asking for
    // slots and drained; the pools close. After stop() this is the same, already settled close.
    unsubscribeRate?.();
    await dispatcher?.close();
    registry?.close();
    account?.close();
    settings?.close();
    db.close(true);
  };

  try {
    registry = createRegistry(db, clock);
    settings = createInstanceSettings(db, clock);
    account = createAdminAccountStore(db, clock);
    const instanceKeys = settings;
    // The effective rate is messaging.max_send_rate until B145 adds SES's MaxSendRate (D155).
    dispatcher = createDispatcher({
      clock,
      // Validated on save (src/settings/validate.ts): an array of servers and a whole number.
      smtp: () => {
        const servers: unknown = instanceKeys.read().smtp;
        return Array.isArray(servers) ? servers.filter((s): s is SMTPServer => !!s) : [];
      },
      rate: () => {
        const rate: unknown = instanceKeys.read()["messaging.max_send_rate"];
        return typeof rate === "number" ? rate : 0;
      },
    });
    const paced = dispatcher;
    unsubscribeRate = settings.reader.subscribe((next, current) => {
      if (next["messaging.max_send_rate"] !== current["messaging.max_send_rate"]) {
        paced.wake();
      }
    });
    ses = createSesAccount({
      clock,
      settings: settings.reader,
      attention,
      endpoint: config.sesEndpoint,
    });
    capacity = createCapacity({
      clock,
      account: ses,
      sources: () => entries.map((entry) => entry.project.capacity),
    });
    const directories = projectDirectories(root);
    // A fresh install, or one whose first start stopped before its registry row: register the
    // primary project. Its directory is created by its wiring, or used as it is (D151). An instance
    // with an admin account has started before, so an empty registry there means every project
    // was deleted, and nothing is registered again (D157).
    if (
      registry.list().length === 0 &&
      account.get() === null &&
      directories.every((name) => name === PRIMARY_SLUG)
    ) {
      registry.add({
        slug: PRIMARY_SLUG,
        name: defaults["app.site_name"],
        hostname: instanceHost,
        primary: true,
      });
    }
    registry.followInstanceHost(instanceHost);
    const records = registry.list();
    for (const name of directories) {
      if (!records.some((record) => record.slug === name)) {
        attention(`${PROJECTS}/${name} has no registry row: it is not served`);
      }
    }
    budgets = await createInstanceBudgets(clock);
    // The admin account (B140): created from the environment on a start with none. Once it exists
    // the variables are not read, as a project with users never read them (D153).
    const first = account.get() ? null : initialAdmin(config.seed.admin, config.seed.api);
    if (first) {
      account.create(first.username, await hashPassword(first.password));
    }
    sync = adminSync();
    for (const record of records) {
      checkInstanceHost(record);
      entries.push(newEntry(record, await wire(record)));
    }
    rebuild();
  } catch (error) {
    await closeAll();
    throw error;
  }
  const registered = must(registry, "registry");
  const changes = must(sync, "admin sync");
  const rootUrlOf = (slug: string) => {
    const entry = entries.find((item) => item.record.slug === slug);
    return entry ? options(entry.record).rootUrl : undefined;
  };

  /**
   * Wires a project, registers it and serves it, without a restart (14-projects section 10).
   * Everything is checked before the directory is made. The registry row is written last: a
   * failure before it removes the new directory, and a crash before it leaves a directory with no
   * row, which a start reports and never serves.
   */
  const add = (input: NewProject): Promise<ProjectRecord> =>
    serial(async () => {
      if (!SLUG_PATTERN.test(input.slug)) {
        throw new RegistryError(400, `Invalid project slug: ${input.slug}`);
      }
      const name = projectName(input.name);
      const hostname = normalizeHostname(input.hostname);
      const extra = (input.extra ?? []).map(normalizeHostname);
      if (new Set([hostname, ...extra]).size !== extra.length + 1) {
        throw new RegistryError(400, "A hostname is listed twice");
      }
      if (input.primary && primary) {
        throw new RegistryError(409, "There is a primary project already");
      }
      if (input.primary && hostname !== instanceHost) {
        throw new RegistryError(400, "The primary project's hostname is the instance host");
      }
      checkInstanceHost({ primary: input.primary ?? false, hostname, extra });
      if (entries.some((entry) => entry.record.slug === input.slug)) {
        throw new RegistryError(409, `A project named ${input.slug} exists`);
      }
      const directory = projectDirectory(root, input.slug);
      if (existsSync(directory)) {
        throw new RegistryError(409, `${PROJECTS}/${input.slug} exists already`);
      }
      // Checked again, with the registry's own rules, when the row is written below.
      const taken = new Set(entries.flatMap((e) => [e.record.hostname, ...e.record.extra]));
      if ([hostname, ...extra].some((h) => taken.has(h))) {
        throw new RegistryError(409, "A hostname belongs to another project");
      }
      const pending: ProjectRecord = {
        slug: input.slug,
        name,
        createdAt: clock.now().toISOString(),
        primary: input.primary ?? false,
        hostname,
        extra,
      };
      busy.add(input.slug);
      try {
        let project: Project;
        try {
          project = await wire(pending);
        } catch (error) {
          rmSync(directory, { recursive: true, force: true });
          throw error;
        }
        let record: ProjectRecord;
        try {
          record = registered.add({ ...input, name, hostname, extra });
        } catch (error) {
          await project.close();
          rmSync(directory, { recursive: true, force: true });
          throw error;
        }
        const entry = newEntry(record, project);
        if (server) {
          project.attach(server);
        }
        entries.push(entry);
        rebuild();
        if (fail) {
          startProject(entry);
        }
        return record;
      } finally {
        busy.delete(input.slug);
      }
    });

  /** Renames a project or replaces its extra hostnames; the routing table follows at once. */
  const update = (slug: string, change: ProjectChange): Promise<ProjectRecord> =>
    serial(async () => {
      const entry = entries.find((item) => item.record.slug === slug);
      if (!entry) {
        throw new RegistryError(404, `No project ${slug}`);
      }
      if (change.extra !== undefined) {
        checkInstanceHost({
          primary: entry.record.primary,
          hostname: entry.record.hostname,
          extra: change.extra.map(normalizeHostname),
        });
      }
      entry.record = registered.update(slug, change);
      rebuild();
      return entry.record;
    });

  /**
   * Deletes a project (14-projects section 10): it leaves the routing table, its sending stops,
   * its in-flight requests finish against its open database, its loops stop under today's deadlines
   * (its sends in SMTP flight under the sender's 5 s close deadline), it closes, its
   * registry rows go, then its database moves to `backups/deleted/` with a tarball of its other
   * files, and its directory is removed. A crash before the rows go serves it again at the next
   * start; a crash after leaves a directory with no row, reported and never served, with nothing
   * lost. Returns null for a slug no project has.
   */
  const remove = (slug: string): Promise<DeletedProject | null> =>
    serial(async () => {
      const index = entries.findIndex((entry) => entry.record.slug === slug);
      if (index === -1) {
        return null;
      }
      const entry = must(entries.splice(index, 1)[0], "project entry");
      entry.removed = true;
      busy.add(slug);
      try {
        rebuild();
        // Its sending stops first (D157): grants go back, waiting pushes end not-started with their
        // claims handed back, and no slot request is answered while its HTTP requests drain. Pushes
        // in SMTP flight get the sender's 5 s close deadline; the shared pools are never cut.
        const sending = entry.project.stopSending();
        await drain(entry);
        await Promise.allSettled([sending, ...entry.project.stop()]);
        await entry.project.close();
        down.delete(slug);
        registered.remove(slug);
        return await archiveDeleted(root, slug, clock);
      } finally {
        busy.delete(slug);
      }
    });

  const projects: InstanceProjects = {
    list: (): Array<ProjectSummary> => {
      const since = new Date(clock.now().getTime() - DAY_MS);
      return entries.map((entry) => ({
        ...entry.record,
        rootUrl: options(entry.record).rootUrl,
        activity: entry.project.activity(since),
      }));
    },
    leftovers: () =>
      projectDirectories(root).filter(
        (name) => !busy.has(name) && !entries.some((entry) => entry.record.slug === name),
      ),
    create: add,
    update,
    remove,
    logs: () =>
      mergeLogs([
        { source: "instance", lines: instanceLogs.lines() },
        ...entries.map((entry) => ({ source: entry.record.slug, lines: entry.project.logs() })),
      ]),
  };

  const instanceSettings = must(settings, "instance settings");
  const sesAccount = must(ses, "SES account");
  const instanceClientAddress = createClientAddress(
    () => instanceLoginSettings(instanceSettings.read()).trustedProxies,
    instanceLogger,
  );
  const instanceAuth = await createInstanceAuth({
    account: must(account, "admin account"),
    clock,
    rootUrl: config.rootUrl,
    change: (credentials, keepSession) => changes.change(null, credentials, keepSession),
    // The instance session lasts security.session_duration, an instance key (B139, D154).
    policy: {
      ...defaultAuthPolicy,
      get sessionDurationMs() {
        return sessionDuration(
          instanceLoginSettings(instanceSettings.read()).sessionDuration,
          clock.now().getTime(),
        );
      },
    },
  });
  const instanceRouter = createInstanceRouter({
    auth: instanceAuth,
    tokens,
    rootUrl: config.rootUrl.replace(/\/+$/, ""),
    instanceHost,
    projectRootUrl: rootUrlOf,
    settings: instanceSettings,
    projects,
    // The login limit's address honours security.trusted_proxies, as a project's login does.
    clientAddress: instanceClientAddress,
    ses: sesAccount,
    smtpTest: () => {
      const project = primary?.project;
      return project && ((body, revalidate) => project.smtpTest(body, revalidate));
    },
  });
  const instanceApp = createApp({
    bootstrap: {
      host: config.listen.host,
      port: config.listen.port,
      dataDir: root,
      rootUrl: config.rootUrl,
      initialAdmin: config.seed.admin,
    },
    clock,
    db,
    logger: instanceLogger,
    i18n: createTranslation(),
  });
  // SES notices (B142, D156): the instance's route, with the instance's bounce keys; each notice
  // goes to the one project it names (14-projects section 8).
  const sesRouter = new Router();
  const sesProjects = () =>
    entries
      .toSorted((a, b) => (a.record.slug < b.record.slug ? -1 : 1))
      .map((entry) => entry.project.ses);
  const sesPage = () => primary?.project.ses.page() ?? instancePageSite(config.rootUrl);
  registerSesRoute(sesRouter, {
    clock,
    settings: () => {
      const current = instanceSettings.read();
      const topics: unknown = current["bounce.ses_topic_arns"];
      return {
        enabled: current["bounce.enabled"] === true,
        webhooksEnabled: current["bounce.webhooks_enabled"] === true,
        ses: current["bounce.ses_enabled"] === true,
        sesTopics: Array.isArray(topics)
          ? topics.filter((topic): topic is string => typeof topic === "string")
          : [],
      };
    },
    page: sesPage,
    // The bounce table's own peers: no project's slug is empty. The floor, or the largest
    // project's setting, so one install's budget is unchanged.
    limit: must(budgets, "budgets").limit("bounce", {
      slug: "",
      limit: () =>
        Math.max(
          must(budgets, "budgets").bounceWebhookPerMinute,
          ...entries.map((entry) => entry.project.ses.bounceLimit()),
        ),
      page: sesPage,
      clientAddress: instanceClientAddress,
    }),
    projects: sesProjects,
    byHost: (hostname) => hosts.get(hostname)?.project.ses,
    logger: instanceLogger,
  });

  return {
    /** The instance host: `--root-url`'s host. */
    host: instanceHost,
    /** The projects being served, in registration order. */
    projects: (): ReadonlyArray<ProjectRecord> => entries.map((entry) => entry.record),
    /** The primary project's router, for main()'s `inspect` (the OpenAPI coverage test). */
    primaryRouter: (): Router | undefined => primary?.project.router,
    /** False once any project's loops have failed (14-projects section 9). */
    healthy: (): boolean => down.size === 0,
    /**
     * Picks the project by `Host` (lowercase, no port; `X-Forwarded-Host` is ignored). A host no
     * project claims, the instance host included, goes to the primary project if there is one.
     */
    dispatch(request: Request, peerAddress: string): Promise<Response> {
      const hostname = requestHostname(request.headers.get("host"));
      const claimed = hosts.get(hostname);
      const { pathname } = new URL(request.url);
      // The instance routes come first on the instance host and on a host no project claims
      // (section 2); on a project's own host these paths are that project's.
      if ((!claimed || hostname === instanceHost) && instancePath(pathname)) {
        return instanceRouter.handle(instanceApp, request, peerAddress);
      }
      // SES notices are the instance's on those hosts, with or without a primary (B142).
      if (
        (!claimed || hostname === instanceHost) &&
        pathname === SES_PATH &&
        request.method === "POST"
      ) {
        return sesRouter.handle(instanceApp, request, peerAddress);
      }
      const entry = claimed ?? primary;
      if (entry) {
        return serve(entry, request, peerAddress);
      }
      // Without a primary, the instance pages still need the admin's stylesheet and scripts.
      if (pathname.startsWith("/admin/static/")) {
        return instanceRouter.handle(instanceApp, request, peerAddress);
      }
      return Promise.resolve(answerWithoutPrimary(request));
    },
    attach(bound: ProjectServer): void {
      server = bound;
      for (const entry of entries) {
        entry.project.attach(bound);
      }
    },
    /** Starts every project's loops, in registration order. A loop's failure calls `onFail`. */
    start(onFail: (failure?: unknown) => void): void {
      fail = onFail;
      sesAccount.start();
      for (const entry of entries) {
        startProject(entry);
      }
    },
    /**
     * Every project's orderly stops, the last registered first, then the dispatcher's. main() appends
     * the HTTP stop. The dispatcher stops in the same turn as the projects, not after they settle: a
     * project's sender waits for its pushes in SMTP flight, and only the dispatcher's emailer bounds
     * that drain (5 s, then it cancels the sockets), as each project's own emailer did before B141.
     */
    stop(): Array<unknown> {
      const stops = [
        ...entries.toReversed().flatMap((entry) => entry.project.stop()),
        sesAccount.stop(),
      ];
      return dispatcher ? [...stops, dispatcher.close()] : stops;
    },
    close: closeAll,
    add,
    update,
    remove,
  };

  /** One request to a project's router, counted until its handler answers (a delete's drain). */
  async function serve(entry: Entry, request: Request, peerAddress: string): Promise<Response> {
    entry.requests++;
    try {
      return await entry.project.router.handle(entry.project.app, request, peerAddress);
    } finally {
      entry.requests--;
      if (entry.requests === 0) {
        entry.idle?.();
      }
    }
  }

  /** Resolves once the project's counted requests have all answered. */
  function drain(entry: Entry): Promise<void> {
    return entry.requests === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          entry.idle = resolve;
        });
  }

  function startProject(entry: Entry): void {
    entry.project.start((failure) => {
      if (entry.removed) {
        return;
      }
      down.add(entry.record.slug);
      must(fail, "instance failure handler")(failure);
    });
  }

  /** Without a primary project: health, a way to the instance pages, and a 404 that names nothing. */
  function answerWithoutPrimary(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return down.size === 0
        ? ok(true)
        : Response.json({ message: "Background work has stopped" }, { status: 503 });
    }
    if (
      (pathname === "/admin" || pathname.startsWith("/admin/")) &&
      !pathname.startsWith("/admin/instance/")
    ) {
      const target = new URL(config.rootUrl);
      target.pathname = `${target.pathname.replace(/\/$/, "")}/admin/instance/projects`;
      return new Response(null, {
        status: 302,
        headers: { Location: target.href },
      });
    }
    return notFound();
  }
}
