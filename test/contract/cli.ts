import { runAnalyticsContract } from "@/test/contract/analytics";
import { runCampaignsContract } from "@/test/contract/campaigns";
import { runTemplatesContract } from "@/test/contract/templates";
import { runTxContract } from "@/test/contract/tx";
import { runUnsubscribeContract } from "@/test/contract/unsubscribe";
import { runPublicContract } from "@/test/contract/public";
import { runEventsContract } from "@/test/contract/events";
import { runSequencesContract } from "@/test/contract/sequences";
import { runBouncesContract } from "@/test/contract/bounces";
import { runWebhooksContract } from "@/test/contract/webhooks";
import { runTemplateAuthorization } from "@/test/templates/auth-contract";
import { runDKIMSettings } from "@/test/contract/messaging-dkim";
import { runMessagingContract } from "@/test/contract/messaging";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startContractFixture } from "@/test/contract/fixture";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { runSettingsLive } from "@/test/settings/live";
import { runSettingsContract } from "@/test/contract/settings";
import { runListsContract } from "@/test/contract/lists";
import { runSubscribersContract } from "@/test/contract/subscribers";
import { runSubscriberQuery } from "@/test/contract/subscriber-query";
import { runSubscriberScope } from "@/test/contract/subscriber-scope";
import { runExternalContract } from "@/test/subscribers/external";
import { runRolesContract } from "@/test/contract/roles";
import { runAuthContract } from "@/test/contract/auth";
import { runContract } from "@/test/contract/runner";
import type { ContractTarget, Credentials, Mode, Profile, TargetName } from "@/test/contract/types";

const repository = resolve(import.meta.dir, "../..");

function argumentsForRun(args: string[]): Record<string, string> {
  const accepted = new Set(["--mode", "--target", "--profile", "--base-url", "--case"]);
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      !name ||
      !accepted.has(name) ||
      !value ||
      value.startsWith("--") ||
      values[name] !== undefined
    )
      throw new Error("Invalid contract CLI arguments");
    values[name] = value;
  }
  return values;
}

function environmentCredentials(env: NodeJS.ProcessEnv): Credentials | undefined {
  const contractProvided =
    env.CONTRACT_API_USER !== undefined || env.CONTRACT_API_TOKEN !== undefined;
  const user = contractProvided ? env.CONTRACT_API_USER : env.REFERENCE_API_USER;
  const token = contractProvided ? env.CONTRACT_API_TOKEN : env.REFERENCE_API_TOKEN;
  if (user === undefined && token === undefined) return undefined;
  if (user === undefined || token === undefined)
    throw new Error("Both synthetic credential values are required");
  return { user, token };
}

async function fixtureCredentials(): Promise<Credentials> {
  const text = await readFile(resolve(repository, "test/contract/fixtures.md"), "utf8");
  const user = /^CONTRACT_API_USER=(.+)$/m.exec(text)?.[1];
  const token = /^CONTRACT_API_TOKEN=(.+)$/m.exec(text)?.[1];
  if (!user || !token) throw new Error("Synthetic fixture credentials are missing");
  return { user, token };
}

async function productionAdmin(): Promise<{ user: string; password: string }> {
  const text = await readFile(resolve(repository, "test/users/fixtures.md"), "utf8");
  const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(text)?.[1];
  const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(text)?.[1];
  if (!user || !password) throw new Error("Synthetic production bootstrap credentials are missing");
  return { user, password };
}

async function report(target: ContractTarget, caseId?: string): Promise<boolean> {
  const result = await runContract(target, caseId === undefined ? {} : { caseId });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  return result.passed;
}

async function main(args: string[], signal: AbortSignal): Promise<void> {
  const operation = args[0];
  if (operation === "run") {
    const values = argumentsForRun(args.slice(1));
    const credentials = environmentCredentials(process.env);
    const target: ContractTarget = {
      mode: values["--mode"] as Mode,
      target: values["--target"] as TargetName,
      profile: values["--profile"] as Profile,
      baseUrl:
        values["--base-url"] ??
        (values["--mode"] === "reference" ? process.env.REFERENCE_URL : undefined) ??
        "",
      ...(credentials ? { credentials } : {}),
      signal,
    };
    if (!(await report(target, values["--case"]))) process.exitCode = 1;
    return;
  }
  if (
    operation === "owned" &&
    (args[1] === "production" ||
      args[1] === "auth" ||
      args[1] === "roles" ||
      args[1] === "lists" ||
      args[1] === "subscribers" ||
      args[1] === "settings" ||
      args[1] === "messaging" ||
      args[1] === "templates" ||
      args[1] === "tx" ||
      args[1] === "unsubscribe" ||
      args[1] === "public" ||
      args[1] === "events" ||
      args[1] === "sequences" ||
      args[1] === "webhooks" ||
      args[1] === "bounces" ||
      args[1] === "analytics" ||
      args[1] === "campaigns")
  ) {
    const values = argumentsForRun(args.slice(2));
    if (Object.keys(values).some((key) => key !== "--case"))
      throw new Error("Invalid owned production arguments");
    if (
      (args[1] === "auth" ||
        args[1] === "roles" ||
        args[1] === "lists" ||
        args[1] === "subscribers" ||
        args[1] === "settings" ||
        args[1] === "messaging" ||
        args[1] === "templates" ||
        args[1] === "tx" ||
        args[1] === "unsubscribe" ||
        args[1] === "public" ||
        args[1] === "events" ||
        args[1] === "sequences" ||
        args[1] === "webhooks" ||
        args[1] === "bounces" ||
        args[1] === "analytics" ||
        args[1] === "campaigns") &&
      Object.keys(values).length
    )
      throw new Error("Invalid owned auth arguments");
    const admin = await productionAdmin();
    const passed = await withProduction(
      resolve(repository, "dist/iglo.email"),
      signal,
      async (baseUrl, runSignal, restart, dataDir) => {
        const credentials = await provisionApiUser(baseUrl, admin);
        if (args[1] === "analytics") {
          await runAnalyticsContract({ mode: "normal", baseUrl, credentials, restart, dataDir });
          process.stdout.write("PASS analytics production contract\n");
          return true;
        }
        if (args[1] === "campaigns") {
          await runCampaignsContract({ mode: "normal", baseUrl, credentials, restart });
          process.stdout.write("PASS campaigns production contract\n");
          return true;
        }
        if (args[1] === "sequences") {
          await runSequencesContract({ baseUrl, credentials, restart });
          process.stdout.write("PASS sequences production contract\n");
          return true;
        }
        if (args[1] === "bounces") {
          await runBouncesContract({ mode: "normal", baseUrl, credentials, restart, dataDir });
          process.stdout.write("PASS bounces production contract\n");
          return true;
        }
        if (args[1] === "webhooks") {
          await runWebhooksContract({ baseUrl, credentials, restart, dataDir });
          process.stdout.write("PASS webhooks production contract\n");
          return true;
        }
        if (args[1] === "events") {
          await runEventsContract({ baseUrl, credentials, restart, dataDir });
          process.stdout.write("PASS events production contract\n");
          return true;
        }
        if (args[1] === "unsubscribe") {
          await runUnsubscribeContract({ baseUrl, credentials, restart });
          process.stdout.write("PASS unsubscribe production contract\n");
          return true;
        }
        if (args[1] === "public") {
          await runPublicContract({ mode: "normal", baseUrl, credentials, restart });
          process.stdout.write("PASS public production contract\n");
          return true;
        }
        if (args[1] === "tx") {
          await runTxContract({ mode: "normal", baseUrl, credentials, restart });
          process.stdout.write("PASS tx production contract\n");
          return true;
        }
        if (args[1] === "templates") {
          await runTemplatesContract({ mode: "normal", baseUrl, credentials, restart });
          await runTemplateAuthorization(baseUrl, credentials, admin);
          return true;
        }
        if (args[1] === "messaging") {
          await runMessagingContract({ mode: "normal", baseUrl, credentials, restart });
          await runDKIMSettings({ baseUrl, credentials, restart, dataDir });
          return true;
        }
        if (args[1] === "settings") {
          await runSettingsContract({ mode: "normal", baseUrl, credentials, restart });
          await runSettingsLive({ baseUrl, credentials, admin, restart });
          return true;
        }
        if (args[1] === "subscribers") {
          await runSubscribersContract({ mode: "normal", baseUrl, credentials });
          await runExternalContract({ baseUrl, credentials, restart });
          await runSubscriberScope({ mode: "normal", baseUrl, credentials, restart });
          await runSubscriberQuery({ mode: "normal", baseUrl, credentials });
          return true;
        }
        if (args[1] === "lists") {
          await runListsContract({ mode: "normal", baseUrl, credentials });
          return true;
        }
        if (args[1] === "roles") {
          await runRolesContract({ mode: "normal", baseUrl, credentials, admin });
          return true;
        }
        if (args[1] === "auth") {
          try {
            await runAuthContract({ mode: "normal", baseUrl, credentials, admin });
          } catch (error) {
            throw new Error(
              error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message)
                ? error.message
                : "Auth contract failed",
            );
          }
          return true;
        }
        return report(
          {
            mode: "normal",
            target: "production",
            profile: "core",
            baseUrl,
            credentials,
            signal: runSignal,
          },
          values["--case"],
        );
      },
      admin,
    );
    if (!passed) process.exitCode = 1;
    return;
  }
  if (operation === "owned" && args[1] === "fixture" && args.length === 2) {
    const credentials = await fixtureCredentials();
    const fixture = startContractFixture(credentials);
    try {
      const base = {
        mode: "normal",
        target: "fixture",
        baseUrl: fixture.origin,
        credentials,
        signal,
      } as const;
      const staged = await report({ ...base, profile: "staged" });
      const probe = await report({ ...base, profile: "probe" });
      if (!staged || !probe) process.exitCode = 1;
    } finally {
      await fixture.close();
    }
    return;
  }
  throw new Error("Use run with explicit mode/target/profile or owned production/fixture");
}

async function execute(): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;
  const abort = () => {
    interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await main(
      process.argv.slice(2),
      AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    );
  } catch (error: unknown) {
    // Validation errors never echo arguments, URLs, environment, or credentials.
    process.stderr.write(
      `${interrupted ? "Contract run interrupted" : error instanceof Error ? error.message : "Contract run failed"}\n`,
    );
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

await execute();
