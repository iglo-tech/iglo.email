// A missing numeric subscriber's data export answers listmonk's 400, as before D101; only an
// absent external ID is a 404 (D101). Through the HTTP API of the in-process production owners.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { queryFixture } from "@/test/subscribers/fixture";
import type { QueryFixture } from "@/test/subscribers/fixture";

describe("export of a missing subscriber", () => {
  let f: QueryFixture;
  beforeAll(async () => {
    f = await queryFixture();
    const created = await f.json("/api/subscribers", "POST", {
      email: "present@example.test",
      name: "Present",
    });
    expect(created.status).toBe(200);
  });
  afterAll(async () => {
    await f.close();
  });

  test("a missing numeric ID answers 400 with the message upstream gives for it", async () => {
    const response = await f.request("/api/subscribers/2000000000/export", {
      headers: f.sessionHeaders,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"message":"Subscriber not found"}\n');
  });

  test("a present numeric ID still exports", async () => {
    const response = await f.request("/api/subscribers/1/export", { headers: f.sessionHeaders });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profile: { email: "present@example.test" } });
  });

  test("an absent external ID answers 404 on GET", async () => {
    const response = await f.request("/api/subscribers/external/absent-1", {
      headers: f.sessionHeaders,
    });
    expect(response.status).toBe(404);
    expect(JSON.parse(await response.text())).toEqual({ message: "Subscriber not found." });
  });
});
