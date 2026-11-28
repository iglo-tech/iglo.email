// The PocketBase test binary (15-external-sources section 8, D169, D170): the official 0.40.5
// release for this machine's Linux architecture, checked against a pinned SHA-256 and cached in
// node_modules/.cache/ (test-excluded, so Bun's test discovery never walks it). A test tool only:
// the shipped executable gains no dependency. Run directly (`bun run pocketbase:download`) to fetch
// it ahead of the tests, as CI does. The download, check and extraction are harness.ts's.
import { releaseBinary } from "@/test/sources/harness";

export const POCKETBASE_VERSION = "0.40.5";

/** The cached binary's path, downloading and verifying it first when it is missing. */
export function pocketBaseBinary(): Promise<string> {
  return releaseBinary({
    label: "PocketBase",
    cache: `pocketbase-${POCKETBASE_VERSION}`,
    entry: "pocketbase",
    // The release archives' SHA-256, from the release's checksums.txt (2026-11-25).
    archives: {
      x64: {
        name: `pocketbase_${POCKETBASE_VERSION}_linux_amd64.zip`,
        sha256: "1dbea1b01eb3dfe64953513859d01e759c96650c4e3264fa4eecd54b769382e4",
      },
      arm64: {
        name: `pocketbase_${POCKETBASE_VERSION}_linux_arm64.zip`,
        sha256: "570baa1c45d2fb92fc0073582b945ca0ece03cbf9837ccabf49a222f99dd02e3",
      },
    },
    url: (archive) =>
      `https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/${archive}`,
    timeoutMs: 120_000,
  });
}

if (import.meta.main) {
  console.log(await pocketBaseBinary());
}
