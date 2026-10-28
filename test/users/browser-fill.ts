// Fills only the synthetic credentials from fixtures.md without printing them.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const fixture = await readFile(resolve(import.meta.dir, "fixtures.md"), "utf8");
const lookup = (name: string) => new RegExp(`^${name}=(.+)$`, "m").exec(fixture)?.[1];
const username = lookup("IGLO_EMAIL_ADMIN_USER");
const password = lookup(
  process.argv[2] === "wrong" ? "M13_BROWSER_WRONG_PASSWORD" : "IGLO_EMAIL_ADMIN_PASSWORD",
);
if (!username || !password || !["wrong", "valid"].includes(process.argv[2] ?? ""))
  throw new Error("Invalid synthetic browser fixture");
for (const [selector, value] of [
  ["#username", username],
  ["#password", password],
]) {
  const child = Bun.spawn(
    ["agent-browser", "--session", "m13-browser", "fill", selector!, value!],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error("Browser fill failed");
}
