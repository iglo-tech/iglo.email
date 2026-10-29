// marketing.min_interval: ISO 8601 durations subtracted on the UTC calendar.
import { expect, test } from "bun:test";
import { intervalStart } from "@/settings/duration";

test("min_interval parses ISO 8601 durations and rejects other syntax", () => {
  const now = new Date("2026-03-31T12:00:00.000Z");
  const at = (input: string) => intervalStart(input, now)?.toISOString();
  expect(intervalStart("", now)).toBeNull();
  expect(at("P7D")).toBe("2026-03-24T12:00:00.000Z");
  expect(at("P2W")).toBe("2026-03-17T12:00:00.000Z");
  expect(at("PT12H30M15S")).toBe("2026-03-30T23:29:45.000Z");
  expect(at("P1Y2M3DT4H")).toBe("2025-01-28T08:00:00.000Z");
  // Calendar months clamp to the end of a shorter month, including leap days.
  expect(at("P1M")).toBe("2026-02-28T12:00:00.000Z");
  expect(intervalStart("P1Y", new Date("2028-02-29T00:00:00Z"))?.toISOString()).toBe(
    "2027-02-28T00:00:00.000Z",
  );
  for (const bad of ["7d", "P", "PT", "P1.5D", "-P1D", "p7d", "P7DT", "P 7D", "P99999999D", "1h"])
    expect(intervalStart(bad, now)).toBeUndefined();
});
