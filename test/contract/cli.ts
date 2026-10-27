import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startContractFixture } from "@/test/contract/fixture";
import { withProduction } from "@/test/contract/owned";
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
  if (operation === "owned" && args[1] === "production") {
    const values = argumentsForRun(args.slice(2));
    if (Object.keys(values).some((key) => key !== "--case"))
      throw new Error("Invalid owned production arguments");
    const passed = await withProduction(
      resolve(repository, "dist/iglo.email"),
      signal,
      (baseUrl, runSignal) =>
        report(
          {
            mode: "normal",
            target: "production",
            profile: "core",
            baseUrl,
            signal: runSignal,
          },
          values["--case"],
        ),
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
