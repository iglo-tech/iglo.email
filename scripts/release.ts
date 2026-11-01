// Release steps for .github/workflows/release.yml, run against a built executable.
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { version } from "@/../package.json";

const root = resolve(import.meta.dir, "..");
const executableName = "iglo.email-linux-x64";
const licenses = join(root, "dist/assets/admin/licenses");
const projectLicense = "listmonk-AGPL-3.0.txt";

// A tag decides the expected version. A dry run has no tag and uses package.json.
function expectedVersion(): string {
  if (process.env.GITHUB_REF_TYPE !== "tag") return version;
  return (process.env.GITHUB_REF_NAME ?? "").replace(/^v/, "");
}

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((done, fail) => {
    socket.once("error", fail);
    socket.listen(0, "127.0.0.1", done);
  });
  const address = socket.address();
  await new Promise<void>((done) => socket.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("No port was assigned");
  return address.port;
}

async function healthWhenReady(child: Bun.Subprocess, origin: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      return await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      // This delay is only for bounded process readiness.
      await Bun.sleep(25);
    }
  }
  throw new Error("Server did not answer /health within ten seconds");
}

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  if (actual !== expected)
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
}

async function login(origin: string, username: string, password: string): Promise<string> {
  const page = await fetch(`${origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1];
  const cookie = page.headers.getSetCookie().find((item) => item.startsWith("nonce="));
  if (!nonce || !cookie) throw new Error("Login form is missing its nonce");
  const response = await fetch(`${origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie.split(";", 1)[0]!,
    },
    body: new URLSearchParams({ username, password, nonce, next: "/admin" }),
  });
  expectEqual("Login status", response.status, 302);
  const session = response.headers.getSetCookie().find((item) => item.startsWith("session="));
  if (!session) throw new Error("Login did not set a session");
  return session.split(";", 1)[0]!;
}

// The server checks follow test/bootstrap/cli.test.ts, on a copy in an empty directory with no Bun
// on PATH, so nothing from the checkout can stand in for what the executable embeds.
async function verify(source: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "iglo-email-release-"));
  let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  try {
    const executable = join(directory, "iglo.email");
    await copyFile(source, executable);
    await chmod(executable, 0o755);

    const reported = Bun.spawn([executable, "--version"], {
      cwd: directory,
      env: { PATH: "" },
      stdout: "pipe",
      stderr: "inherit",
    });
    const [code, stdout] = await Promise.all([
      reported.exited,
      new Response(reported.stdout).text(),
    ]);
    expectEqual("--version exit code", code, 0);
    expectEqual("Reported version", stdout, `${expectedVersion()}\n`);

    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const username = "release-smoke-admin";
    const password = crypto.randomUUID();
    child = Bun.spawn([executable, "serve", "--port", String(port)], {
      cwd: directory,
      env: { PATH: "", IGLO_EMAIL_ADMIN_USER: username, IGLO_EMAIL_ADMIN_PASSWORD: password },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });

    const health = await healthWhenReady(child, origin);
    expectEqual("/health status", health.status, 200);
    expectEqual("/health body", await health.text(), '{"data":true}\n');
    expectEqual("Anonymous /api/health", (await fetch(`${origin}/api/health`)).status, 403);

    const cookie = await login(origin, username, password);
    const profile = await fetch(`${origin}/api/profile`, { headers: { cookie } });
    expectEqual("/api/profile status", profile.status, 200);
    const body = (await profile.json()) as { data: { username: string } };
    expectEqual("/api/profile username", body.data.username, username);
    const notices = await fetch(`${origin}/admin/static/licenses/${projectLicense}`);
    expectEqual("Embedded asset status", notices.status, 200);

    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 5_000);
    const exit = await child.exited;
    clearTimeout(timer);
    expectEqual("Exit code after SIGTERM", exit, 0);
    expectEqual("Server stderr", await new Response(child.stderr).text(), "");
    console.log(`Verified ${basename(source)} ${expectedVersion()}`);
  } catch (error) {
    if (child?.exitCode === null) child.kill("SIGKILL");
    throw error;
  } finally {
    await child?.exited;
    await rm(directory, { recursive: true, force: true });
  }
}

/** The WebKit revision Bun pins; a new Bun needs a new one, which packaging checks. */
const runtime = { bun: "1.4.4", webkit: "d6375c72affe0f70222cdcb45012b10f0bf3a9d5" };

async function notices(): Promise<string> {
  if (Bun.version !== runtime.bun)
    throw new Error(`Update the WebKit revision in notices() for Bun ${Bun.version}`);
  const license = (name: string) => Bun.file(join(root, "assets/licenses", name)).text();
  const sections = [
    `iglo.email ${version} third-party notices

iglo.email is licensed under the GNU Affero General Public License version 3; see LICENSE. It is
derived from listmonk. The corresponding source of this release is
https://github.com/iglo-tech/iglo.email/tree/v${version}, and \`bun run build\` rebuilds this
executable from it, also against a modified Bun.
`,
    `----- Bun ${Bun.version}, the runtime inside the executable -----

${await license("bun-LICENSE.txt")}`,
    `----- Bun and JavaScriptCore sources for this release -----

The executable contains Bun ${runtime.bun}, which statically links JavaScriptCore, WebCore and TinyCC,
under the LGPL. The exact sources are public, and they are the source route for this release. The
Bun tag pins the TinyCC revision in scripts/build/deps/tinycc.ts:

  Bun     https://github.com/oven-sh/bun/tree/bun-v${runtime.bun}
  WebKit  https://github.com/oven-sh/WebKit/tree/${runtime.webkit}

To use a modified JavaScriptCore, check out both, apply your change, and follow the relinking steps
above to build a native \`bun\`. Put that binary first on PATH under the name \`bun\`, because the
build script finds the compiler by that name, and calling the binary by its path would silently use
another \`bun\`. Check with \`command -v bun\`. Then run \`bun install --frozen-lockfile\` and
\`bun run build\` in a checkout of the iglo.email source named above, which gives you this executable
linked against your library.
`,
    `----- GNU Library General Public License, version 2 -----\n\n${await license("LGPL-2.0.txt")}`,
    `----- GNU Lesser General Public License, version 2.1 -----\n\n${await license("LGPL-2.1.txt")}`,
  ];
  for (const name of (await readdir(licenses)).sort()) {
    if (name === projectLicense) continue;
    const text = await Bun.file(join(licenses, name)).text();
    sections.push(`----- ${name.replace(/\.txt$/, "")} -----\n\n${text}`);
  }
  const fonts = await Bun.file(join(licenses, "../fonts/LICENSE.txt")).text();
  sections.push(`----- Geist fonts -----\n\n${fonts}`);
  return sections.join("\n");
}

async function packageRelease(source: string, output: string): Promise<void> {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await copyFile(source, join(output, executableName));
  await chmod(join(output, executableName), 0o755);
  await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
  await writeFile(join(output, "THIRD-PARTY-NOTICES.txt"), await notices());

  const lines: string[] = [];
  for (const name of [executableName, "LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
    const hash = createHash("sha256").update(await Bun.file(join(output, name)).bytes());
    lines.push(`${hash.digest("hex")}  ${name}\n`);
  }
  await writeFile(join(output, "SHA256SUMS"), lines.join(""));
  console.log(`Packaged ${output}`);
}

const [command, source, output, ...rest] = process.argv.slice(2);
if (command === "verify" && source && !output) await verify(source);
else if (command === "package" && source && output && rest.length === 0)
  await packageRelease(source, output);
else throw new Error("Usage: release.ts verify <executable> | package <executable> <output>");
