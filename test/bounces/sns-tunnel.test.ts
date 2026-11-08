// The compiled executable fetches an SNS signing certificate through the tunnel with Bun's default
// fetch (src/bounces/ses.ts). That fetch must verify the host as well as the chain: a certificate
// issued for another name is refused. The positive case shows that the same tunnel serves the right
// certificate to the same client, so the refusal is not a broken tunnel.
import { expect, test } from "bun:test";
import { CERT } from "@/test/bounces/ses-fixture";
import { startSnsTunnel, type SnsTunnel } from "@/test/bounces/sns-tunnel";

/** Fetches the certificate in a child process, with the tunnel's environment as the executable has. */
async function fetchThroughTunnel(tunnel: SnsTunnel) {
  const script =
    `fetch(${JSON.stringify(CERT)}).then(` +
    `async (response) => { console.log("status " + response.status); ` +
    `console.log("bytes " + (await response.text()).length); }, ` +
    `(error) => { console.log("refused " + (error.code ?? error.message)); });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: "", ...tunnel.environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("the tunnel serves the signing certificate to a client that verifies the SNS host", async () => {
  const tunnel = await startSnsTunnel();
  try {
    const { stdout, stderr, code } = await fetchThroughTunnel(tunnel);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("status 200");
    expect(stdout).toMatch(/^bytes [1-9]/m);
  } finally {
    await tunnel.close();
  }
});

test("a certificate issued for another host is refused through the tunnel", async () => {
  const tunnel = await startSnsTunnel({ certificateHost: "sns.example.test" });
  try {
    const { stdout, code } = await fetchThroughTunnel(tunnel);
    expect(code).toBe(0);
    // The hostname check refuses it, not the chain or the proxy: the certificate names another host.
    expect(stdout).toMatch(/^refused ERR_TLS_CERT_ALTNAME_INVALID/m);
    expect(stdout).not.toContain("status 200");
  } finally {
    await tunnel.close();
  }
});
