// Test-only executable entry; never imported by the production executable.
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { existsSync } from "node:fs";
import { probeLiquid } from "@/test/perf/runtime-compat/liquid-probes";
import { control } from "@/test/perf/runtime-compat/smtp-control";
import { referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

assert.equal(process.cwd(), "/work");
assert.ok(!existsSync("/node_modules") && !existsSync("/work/node_modules"));
const mode = process.argv[2];
if (mode === "liquid") console.log(JSON.stringify(await probeLiquid()));
else if (mode === "smtp") {
  const reference = referenceMailpit(process.env);
  const result = await control(reference, true);
  const transport = nodemailer.createTransport({
    pool: true,
    host: reference.host,
    port: reference.port,
    ignoreTLS: true,
    maxConnections: 2,
    maxMessages: 5,
    maxRequeues: 0,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await assert.rejects(
      transport.sendMail({
        from: "sender@example.test",
        to: [],
        subject: "synthetic failure",
        text: "no recipients",
      }),
    );
  } finally {
    transport.close();
  }
  console.log(JSON.stringify({ ...result, expectedFailure: "closed after rejection" }));
} else throw new Error("Unknown compiled fixture mode");
