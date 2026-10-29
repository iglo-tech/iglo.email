// Manual, loopback-only authenticated browser check. No credentials are printed.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";
import { command } from "@/test/reference/command";

const fixture = await readFile(resolve("test/users/fixtures.md"), "utf8");
const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1];
const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1];
if (!user || !password) throw new Error("Missing synthetic browser fixture");
const sessionResult = await command(
  ["agent-browser", "session", "id", "--scope", "worktree", "--prefix", "m18"],
  { cwd: process.cwd(), env: process.env, timeout: 10000 },
);
if (sessionResult.code !== 0) throw new Error("Unable to allocate browser session");
const session = sessionResult.stdout.trim();
const env = { ...process.env, AGENT_BROWSER_SESSION: session };
const browser = async (...args: string[]) => {
  const result = await command(["agent-browser", ...args], {
    cwd: process.cwd(),
    env,
    timeout: 20000,
  });
  if (result.code !== 0)
    throw new Error(
      `Browser operation failed: ${args[0]}: ${result.stderr.replace(/https?:\/\/\S+/g, "[local URL]").slice(0, 400)}`,
    );
  return result.stdout;
};
try {
  await withProduction(
    resolve("dist/iglo.email"),
    AbortSignal.timeout(120000),
    async (origin) => {
      await browser("open", `${origin}/admin/login`);
      const snapshot = await browser("snapshot", "-i");
      if (!snapshot.includes("Username") || !snapshot.includes("Password"))
        throw new Error("Missing login fields");
      await browser("fill", "#username", user);
      await browser("fill", "#password", password);
      await browser("click", "button[type=submit]");
      await browser("wait", "--url", "**/admin");
      await browser("open", `${origin}/api/templates/1/preview`);
      const stored = await browser("snapshot");
      if (!stored.includes("Hi there"))
        throw new Error(`Stored preview was not rendered: ${stored.slice(0, 300)}`);
      await browser("open", `${origin}/api/templates`);
      const expression = `(async()=>{const csrf=document.cookie.split('; ').find(x=>x.startsWith('csrf='))?.slice(5); const r=await fetch('/api/templates/preview',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-Token':decodeURIComponent(csrf||'')},body:new URLSearchParams({template_type:'campaign',body:'<main>{{ content | raw }}</main>'})}); const html=await r.text(); return r.status===200 && html.includes('Hi there') && r.headers.get('content-security-policy').includes('sandbox');})()`;
      const posted = await browser("eval", expression);
      if (!posted.includes("true")) throw new Error("Posted preview was not rendered");
      process.stdout.write("Authenticated stored and posted preview browser check passed\n");
    },
    { user, password },
    120000,
  );
} finally {
  await browser("close").catch(() => {});
}
