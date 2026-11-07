import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnsFetch } from "@/bounces/ses";
import type { TxFixture } from "@/test/tx/fixture";

export const CERT = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem";
export const OTHER_CERT =
  "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-def456.pem";

function openssl(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["openssl", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

/** A leaf certificate issued by a fresh CA, and the key that signs for it. */
export function issue(notAfter = "21250101000000Z") {
  const dir = mkdtempSync(join(tmpdir(), "iglo-ses-"));
  try {
    openssl(
      dir,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-subj",
      "/CN=Test CA",
      "-days",
      "30",
    );
    openssl(
      dir,
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
      "-subj",
      "/CN=sns.amazonaws.com",
    );
    writeFileSync(
      join(dir, "ca.cnf"),
      `[ ca ]
default_ca = CA_default

[ CA_default ]
database = index.txt
new_certs_dir = .
certificate = ca.pem
serial = serial
private_key = ca.key
default_md = sha256
policy = policy_any

[ policy_any ]
commonName = supplied
`,
    );
    writeFileSync(join(dir, "index.txt"), "");
    writeFileSync(join(dir, "serial"), "01\n");
    openssl(
      dir,
      "ca",
      "-config",
      "ca.cnf",
      "-batch",
      "-in",
      "leaf.csr",
      "-out",
      "leaf.pem",
      "-startdate",
      "20250101000000Z",
      "-enddate",
      notAfter,
    );
    return {
      key: readFileSync(join(dir, "leaf.key"), "utf8"),
      pem: readFileSync(join(dir, "leaf.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const good = issue();

export interface Network {
  fetch: SnsFetch;
  requests: string[];
}

export function network(pems: Record<string, string> = { [CERT]: good.pem }): Network {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (url) => {
      requests.push(url);
      const pem = pems[url];
      if (pem) return new Response(pem);
      if (url.includes("?Action=ConfirmSubscription")) return new Response("<ok/>");
      return new Response("no", { status: 404 });
    },
  };
}

export function sign(n: Record<string, string>, key = good.key, version = "1") {
  const fields = [
    "Message",
    "MessageId",
    "Subject",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ];
  const text = fields
    .filter((k) => n[k])
    .map((k) => `${k}\n${n[k]}\n`)
    .join("");
  const signer = createSign(version === "2" ? "RSA-SHA256" : "RSA-SHA1");
  return signer.update(text).sign(key, "base64");
}

export function envelope(
  f: TxFixture,
  fields: Record<string, string>,
  options: { key?: string; version?: string; cert?: string } = {},
): Record<string, string> & {
  MessageId: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
} {
  const base: Record<string, string> = {
    MessageId: crypto.randomUUID(),
    TopicArn: "arn:aws:sns:eu-west-1:123456789012:bounces",
    Timestamp: f.clock.now().toISOString(),
    Type: "Notification",
    ...fields,
  };
  const version = options.version ?? "1";
  return {
    ...base,
    MessageId: base.MessageId!,
    SignatureVersion: version,
    Signature: sign(base, options.key, version),
    SigningCertURL: options.cert ?? CERT,
  };
}

export const post = (f: TxFixture, body: unknown, type = "Notification", raw?: string) =>
  f.json("/webhooks/service/ses", "POST", raw ?? JSON.stringify(body), {
    "x-amz-sns-message-type": type,
  });

export const bounceMessage = (
  f: TxFixture,
  recipients: string[],
  extra: object = {},
  headers: object[] = [],
) =>
  JSON.stringify({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: recipients.map((emailAddress) => ({
        emailAddress,
        status: "5.1.1",
        action: "failed",
        diagnosticCode: `smtp; 550 5.1.1 user unknown <${emailAddress}>`,
      })),
      ...extra,
    },
    mail: {
      timestamp: f.clock.now().toISOString(),
      destination: recipients,
      headersTruncated: false,
      headers,
    },
  });
