// Adapted from listmonk static/admin/build.mjs at 6fcd95f; only v1 assets are built.
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const destination = join(root, "dist/assets");
const admin = join(destination, "admin");
const pub = join(destination, "public");
await rm(destination, { recursive: true, force: true });
await mkdir(admin, { recursive: true });
await mkdir(pub, { recursive: true });
await cp(join(root, "assets/admin/static"), admin, { recursive: true });
await cp(join(root, "assets/public/static"), pub, { recursive: true });
for (const name of ["style.css", "richtext.css"])
  await cp(join(root, "assets/admin/css", name), join(admin, name));
await cp(join(root, "node_modules/@knadh/oat/oat.min.css"), join(admin, "oat.min.css"));

const jsRoot = join(root, "assets/admin/js");
const built = await Bun.build({
  entrypoints: ["main.js", "code-editor.js", "richtext-editor.js", "charts.js"].map((name) =>
    join(jsRoot, name),
  ),
  outdir: join(admin, "js"),
  root: jsRoot,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
});
if (!built.success) throw new AggregateError(built.logs, "Browser asset build failed");

// Bundle project, vendored-source and npm licenses alongside executable assets.
const packages = [
  "saxes",
  "liquidjs",
  "nodemailer",
  "qrcode",
  "alpinejs",
  "@knadh/oat",
  "@codemirror/commands",
  "@codemirror/lang-css",
  "@codemirror/lang-html",
  "@codemirror/lang-javascript",
  "@codemirror/lang-markdown",
  "@codemirror/language",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/highlight",
  "chart.js",
  "squire-rte",
];
const seen = new Set<string>();
const licenseDir = join(admin, "licenses");
await mkdir(licenseDir, { recursive: true });
await cp(join(root, "LICENSE"), join(licenseDir, "listmonk-AGPL-3.0.txt"));
await cp(
  join(root, "assets/licenses/fsegurai-codemirror-themes-MIT.txt"),
  join(licenseDir, "fsegurai-codemirror-themes-MIT.txt"),
);
await cp(join(root, "assets/licenses/go-1.27.2-BSD.txt"), join(licenseDir, "go-1.27.2-BSD.txt"));
await cp(
  join(root, "assets/licenses/gdgvda-cron-0.7.0-MIT.txt"),
  join(licenseDir, "gdgvda-cron-0.7.0-MIT.txt"),
);
await cp(
  join(root, "assets/licenses/unicode-17.0.0-3.0.txt"),
  join(licenseDir, "unicode-17.0.0-3.0.txt"),
);
for (let index = 0; index < packages.length; index++) {
  const name = packages[index]!;
  if (seen.has(name)) continue;
  seen.add(name);
  const directory = join(root, "node_modules", name);
  const info = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };
  packages.push(...Object.keys(info.dependencies ?? {}));
  const files = (await readdir(directory))
    .filter((file) => /^(licen[sc]e|copying)([.-].*)?$/i.test(file))
    .sort();
  const license =
    name === "saxes" && info.version === "6.0.0"
      ? join(root, "assets/licenses/saxes-6.0.0-ISC.txt")
      : name === "alpinejs"
        ? join(root, "assets/licenses/alpinejs-LICENSE.txt")
        : files[0]
          ? join(directory, files[0])
          : undefined;
  if (!license) throw new Error(`Missing license file for ${name}@${info.version}`);
  await cp(license, join(licenseDir, `${name.replaceAll("/", "_")}@${info.version}.txt`));
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unexpected asset entry: ${path}`);
  }
  return result.sort();
}
const mime: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const paths = await files(destination);
const version = createHash("sha256");
const imports: string[] = [];
const entries: string[] = [];
for (let index = 0; index < paths.length; index++) {
  const path = paths[index]!;
  const name = relative(destination, path).replaceAll("\\", "/");
  const type = mime[extname(name)];
  if (!type) throw new Error(`Unsupported asset type: ${name}`);
  version
    .update(name)
    .update("\0")
    .update(await readFile(path))
    .update("\0");
  imports.push(
    `// @ts-ignore Generated Bun file import.\nimport a${index} from ${JSON.stringify(`@/../dist/assets/${name}`)} with { type: "file" };`,
  );
  const slash = name.indexOf("/");
  const url = `/${name.slice(0, slash)}/static/${name.slice(slash + 1)}`;
  entries.push(
    `  ${JSON.stringify(url)}: Object.freeze({ path: a${index}, type: ${JSON.stringify(type)} }),`,
  );
}
const manifest = `// Generated by scripts/assets-build.ts. Do not edit.\n${imports.join("\n")}\nexport const assetVersion = ${JSON.stringify(version.digest("hex").slice(0, 10))};\nexport const assets: Readonly<Record<string, { readonly path: string; readonly type: string }>> = Object.freeze({\n${entries.join("\n")}\n});\n`;
await writeFile(join(root, "src/server/asset-manifest.ts"), manifest);
console.log(`Built ${paths.length} embedded browser assets`);
