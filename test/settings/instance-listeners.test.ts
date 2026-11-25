// B139 (D154): an instance save notifies every project that subscribed, even when one notification
// throws; the failure is logged as an error and the save still answers its own result.
import { afterEach, expect, spyOn, test } from "bun:test";
import { createTestInstanceSettings } from "@/test/settings/instance-fixture";
import { TestClock } from "@/test/server/fixture";

const opened: Array<{ close(): void }> = [];
afterEach(() => {
  while (opened.length) {
    opened.pop()!.close();
  }
});

test("a throwing notification does not stop the others or the save, and is logged", () => {
  const instance = createTestInstanceSettings(new TestClock());
  opened.push(instance);
  const seen: Array<string> = [];
  instance.reader.subscribe(() => {
    seen.push("first");
  });
  instance.reader.subscribe(() => {
    throw new Error("listener broke");
  });
  instance.reader.subscribe((next) => {
    seen.push(`third:${String(next["messaging.max_send_rate"])}`);
  });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() =>
      instance.update((current) => ({ ...current, "messaging.max_send_rate": 7 })),
    ).not.toThrow();
    expect(seen).toEqual(["first", "third:7"]);
    expect(instance.read()["messaging.max_send_rate"]).toBe(7);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("[instance] ");
    expect(String(errors.mock.calls[0]?.[0])).toContain("listener broke");
  } finally {
    errors.mockRestore();
  }
});

test("a refused save still answers its refusal and notifies no one", () => {
  const instance = createTestInstanceSettings(new TestClock());
  opened.push(instance);
  let calls = 0;
  instance.reader.subscribe(() => {
    calls += 1;
  });
  expect(() =>
    instance.update((current) => ({ ...current, "messaging.max_send_rate": -1 })),
  ).toThrow("messaging.max_send_rate");
  expect(calls).toBe(0);
});
