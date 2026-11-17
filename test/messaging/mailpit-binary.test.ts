import { describe, expect, test } from "bun:test";
import { mailpitBinaryPath } from "@/test/reference/prepare";

describe("reference Mailpit binary per platform", () => {
  test("names the executable that reference:prepare caches for each supported host", () => {
    expect(mailpitBinaryPath("linux-x64")).toMatch(/mailpit-linux-amd64\.tar\.gz-mailpit$/);
    expect(mailpitBinaryPath("linux-arm64")).toMatch(/mailpit-linux-arm64\.tar\.gz-mailpit$/);
  });

  test("refuses hosts that have no reference Mailpit", () => {
    expect(() => mailpitBinaryPath("darwin-arm64")).toThrow("Unsupported platform darwin-arm64");
  });
});
