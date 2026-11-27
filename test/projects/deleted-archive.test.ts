// B165 (D193, 14-projects section 10): the deleted project's file archive is a tar the system `tar`
// lists and extracts, as the operations guide tells operators to, also for a file or a directory
// last changed before 1970 (a PAX `mtime` record, the ustar field holding 0). In process, through
// the instance's own API.
//
// Not tested here: a file of 8 GiB or more (a PAX `size` record). The archive copies every byte, so
// even a sparse upload of that size writes 8 GiB to the disk; the size takes the same path as the
// time, and the writer refuses any value its field cannot hold rather than spill it into the next.
import { expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { createProject, deleteProject, openLifecycle } from "@/test/projects/lifecycle-fixture";
import { asBody } from "@/test/read-body";

setDefaultTimeout(60_000);

// 1969-07-20T20:17:40Z, in seconds before the epoch.
const BEFORE_EPOCH = -14_182_940;

test("an archive with files and a directory from before 1970 lists and extracts with the system tar", async () => {
  const f = await openLifecycle(createRealClock());
  const out = mkdtempSync(join(tmpdir(), "b165-tar-"));
  try {
    await createProject(f, { slug: "old", name: "Old", hostname: "old.example.test" });
    const uploads = join(f.dataDir, "projects", "old", "uploads");
    const nested = join(uploads, "1969");
    const long = `${"l".repeat(120)}.txt`;
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "moon.txt"), "landing");
    writeFileSync(join(nested, long), "long name");
    for (const path of [join(nested, "moon.txt"), join(nested, long), nested]) {
      // A Date: Bun takes a negative number of seconds as now.
      const time = new Date(BEFORE_EPOCH * 1000);
      utimesSync(path, time, time);
      expect(Math.floor(statSync(path).mtimeMs / 1000)).toBe(BEFORE_EPOCH);
    }

    const deleted = await deleteProject(f, "old");
    expect(deleted.status, deleted.text).toBe(200);
    const archive = join(
      f.dataDir,
      asBody<{ data: { files: string } }>(JSON.parse(deleted.text)).data.files,
    );

    const listed = Bun.spawnSync(["tar", "-tvf", archive], { stderr: "pipe" });
    expect(listed.stderr.toString()).toBe("");
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString()).toContain("uploads/1969/moon.txt");
    expect(listed.stdout.toString()).toContain(`uploads/1969/${long}`);

    // GNU tar warns that a time before 1970 is "implausibly old" and restores it; that warning alone
    // is turned off, so any other complaint fails the test.
    const extracted = Bun.spawnSync(["tar", "--warning=no-timestamp", "-xf", archive, "-C", out], {
      stderr: "pipe",
    });
    expect(extracted.stderr.toString()).toBe("");
    expect(extracted.exitCode).toBe(0);
    expect(readFileSync(join(out, "uploads", "1969", "moon.txt"), "utf-8")).toBe("landing");
    expect(readFileSync(join(out, "uploads", "1969", long), "utf-8")).toBe("long name");
    // The PAX record carries the exact time, which the ustar field cannot.
    expect(Math.floor(statSync(join(out, "uploads", "1969", "moon.txt")).mtimeMs / 1000)).toBe(
      BEFORE_EPOCH,
    );
    expect(Math.floor(statSync(join(out, "uploads", "1969", long)).mtimeMs / 1000)).toBe(
      BEFORE_EPOCH,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
    await f.close();
  }
  expect(f.failures).toEqual([]);
});
