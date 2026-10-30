// Runs the adapted listmonk Playwright specs in test/e2e/specs, one at a time. `bun run e2e`
// builds first; arguments go to Playwright, as in `bun run e2e test/e2e/specs/login.e2e.js`.
import { resolve } from "node:path";
import { root, withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

process.exitCode = await withStack(async ({ origin, blankOrigin, mailbox }) => {
  // The specs run in their own process and read the sink over HTTP.
  const mail = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const to = new URL(request.url).searchParams.get("to");
      const found = mailbox.mails.filter((item) => item.to === to);
      return Response.json(found.map(({ subject, body }) => ({ subject, body })));
    },
  });
  try {
    const specs = Bun.spawn(
      [
        resolve(root, "node_modules/.bin/playwright"),
        "test",
        "--config",
        "test/e2e/playwright.config.js",
        ...process.argv.slice(2),
      ],
      {
        cwd: root,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          E2E_ORIGIN: origin,
          E2E_BLANK_ORIGIN: blankOrigin,
          E2E_MAIL: `http://127.0.0.1:${mail.port}`,
          E2E_ADMIN_USER: admin.user,
          E2E_ADMIN_PASSWORD: admin.password,
        },
      },
    );
    return await specs.exited;
  } finally {
    await mail.stop(true);
  }
});
