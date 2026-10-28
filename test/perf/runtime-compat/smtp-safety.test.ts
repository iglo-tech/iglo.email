// No reference stack or network is needed for these destination checks.
import { expect, test } from "bun:test";
import { referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
const valid = {
  MAILPIT_URL: "http://127.0.0.1:8025",
  MAILPIT_SMTP_HOST: "127.0.0.1",
  MAILPIT_SMTP_PORT: "1025",
  REFERENCE_RUN_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};
test("requires a complete reference-run context with numeric loopback destinations", () => {
  expect(referenceMailpit(valid)).toEqual({
    api: valid.MAILPIT_URL,
    host: valid.MAILPIT_SMTP_HOST,
    port: 1025,
    runId: valid.REFERENCE_RUN_ID,
  });
  for (const invalid of [
    {},
    { ...valid, MAILPIT_SMTP_HOST: "localhost" },
    { ...valid, MAILPIT_SMTP_PORT: "65536" },
    { ...valid, MAILPIT_URL: "http://localhost:8025" },
    { ...valid, MAILPIT_URL: "http://127.0.0.1:8025/other" },
    { ...valid, MAILPIT_URL: "http://user:pass@127.0.0.1:8025" },
    { ...valid, REFERENCE_RUN_ID: "unowned" },
  ])
    expect(() => referenceMailpit(invalid)).toThrow();
});
