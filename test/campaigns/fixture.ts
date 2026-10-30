// In-process production owners for the campaigns API and its template, list, subscriber,
// tracking and emailer seams, with a fake clock and a loopback SMTP sink, wired as
// src/main.ts does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { createCampaignStore } from "@/campaigns/store";
import { registerCampaignRoutes, type CampaignSettings } from "@/campaigns/routes";
import { registerCampaignPublicRoutes } from "@/campaigns/public";
import { createSubscriberStore } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { registerUserRoutes } from "@/users/routes";
import { createEmailer } from "@/messaging/email";
import { createTemplateStore } from "@/templates/store";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { createTracking } from "@/unsubscribe/tracking";
import { createAttachments } from "@/media/attachments";
import { createFilesystem } from "@/media/filesystem";
import { registerMediaRoutes } from "@/media/routes";
import { createMediaStore } from "@/media/store";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";

const admin = { user: "fixture-admin", password: "fixture-admin-password" };
const root = "http://fixture.test";

export async function campaignsFixture() {
  const sink = await startSink({});
  const directory = mkdtempSync(join(tmpdir(), "iglo-campaigns-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: unknown[] = [];
  const app = createApp({
    bootstrap: {
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      rootUrl: root,
      initialAdmin: admin,
    },
    db,
    clock,
    i18n: createTranslation(),
    logger: { error: (error) => errors.push(error) },
  });
  const lists = createListReferences(db),
    counts = createListCounts(db),
    listReferences = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, listReferences),
    subscribers = createSubscriberStore(db, clock, lists),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles);
  const auth = await createAuthentication(users, roles, clock, root, defaultAuthPolicy);
  await bootstrapAdmin(users, auth, admin);
  const session = await auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) throw new Error("fixture login failed");
  const renderer = createRenderer(clock, app.i18n);
  const templateReferences = createCampaignTemplateReferences(db);
  const templates = createTemplateStore(db, clock, renderer, templateReferences);
  templates.initialize();
  const emailer = createEmailer({
    clock,
    settings: () => ({
      rootUrl: root,
      smtp: [
        {
          name: "fixture",
          enabled: true,
          exclude_from_default: false,
          host: "127.0.0.1",
          port: sink.port,
          hello_hostname: "fixture.test",
          max_conns: 4,
          idle_timeout: "2s",
          wait_timeout: "2s",
          auth_protocol: "none",
          username: "",
          tls_type: "none",
          tls_skip_verify: false,
          email_headers: [{ Bcc: "copy@fixture.test" }],
          from_addresses: [],
        },
      ],
    }),
  });
  const tracking = createTracking(db, clock);
  const settings: CampaignSettings & { allowBlocklist: boolean } = {
    fromEmail: "Fixture <noreply@fixture.test>",
    rootUrl: root,
    siteName: "Fixture list",
    messengers: ["email", "fixture"],
    unsubscribeHeader: true,
    allowBlocklist: true,
    disableTracking: false,
    individualTracking: false,
  };
  const unsubscribed: unknown[] = [];
  const media = createMediaStore(db, clock);
  const mediaSettings = {
    provider: "filesystem",
    extensions: ["*"],
    rootUrl: root,
    uploadPath: "uploads",
    uploadUri: "/uploads",
  };
  const files = createFilesystem(directory, () => mediaSettings);
  const attachments = createAttachments(media, files);
  const store = createCampaignStore(db, clock, {
    templateExists: (id) => templates.get(id) !== null,
    defaultTemplate: () => templates.getDefault()?.id ?? null,
    listName: (id) => lists.name(id),
    mediaFilename: (id) => media.filename(id),
  });
  const router = createRouter();
  registerMediaRoutes(router, { store: media, files, auth, settings: () => mediaSettings });
  registerUserRoutes(router, users, roles, auth);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  registerTemplateRoutes(router, templates, renderer, auth);
  registerCampaignRoutes(router, {
    store,
    templates,
    renderer,
    roles,
    auth,
    lists,
    subscribers,
    tracking,
    emailer,
    settings: () => settings,
    attachments,
  });
  registerCampaignPublicRoutes(router, {
    db,
    store,
    subscribers,
    tracking,
    settings: () => settings,
    effects: { unsubscribed: (event) => unsubscribed.push(event) },
  });
  const sessionHeaders = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  const request = (path: string, init: RequestInit = {}) =>
    router.handle(app, new Request(`${root}${path}`, init));
  const json = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = sessionHeaders,
  ) => {
    const response = await request(path, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    const type = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      headers: response.headers,
      body: type.startsWith("application/json") ? JSON.parse(text) : text,
    };
  };
  const list = async (name: string, optin = "single") =>
    (await json("/api/lists", "POST", { name, type: "public", optin })).body.data.id as number;
  const subscriber = async (email: string, listIds: number[], extra: object = {}) => {
    const created = await json("/api/subscribers", "POST", {
      email,
      name: "Ada Lovelace",
      lists: listIds,
      ...extra,
    });
    if (created.status !== 200) throw new Error(`subscriber ${created.status}`);
    return created.body.data as { id: number; uuid: string; email: string };
  };
  const campaign = async (input: object) => {
    const created = await json("/api/campaigns", "POST", input);
    if (created.status !== 200)
      throw new Error(`campaign ${created.status} ${JSON.stringify(created.body)}`);
    return created.body.data as Record<string, any> & { id: number; uuid: string };
  };
  /** Wait for the sink: test sends are queued to the emailer, as in listmonk. */
  const mail = async (count: number) => {
    for (let i = 0; i < 400 && sink.messages.length < count; i++) await Bun.sleep(5);
    return sink.messages;
  };
  return {
    app,
    db,
    clock,
    sink,
    errors,
    settings,
    mediaSettings,
    directory,
    unsubscribed,
    sessionHeaders,
    request,
    json,
    list,
    subscriber,
    campaign,
    mail,
    /** Production owners, for wiring the campaign runner as src/main.ts does. */
    owners: {
      store,
      templates,
      renderer,
      tracking,
      lists,
      subscribers,
      emailer,
      roles,
      auth,
      attachments,
    },
    router,
    async close() {
      await emailer.close();
      store.close();
      media.close();
      tracking.close();
      templates.close();
      templateReferences.close();
      users.close();
      roles.close();
      subscribers.close();
      listStore.close();
      counts.close();
      listReferences.close();
      lists.close();
      db.close(true);
      await sink.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type CampaignsFixture = Awaited<ReturnType<typeof campaignsFixture>>;
