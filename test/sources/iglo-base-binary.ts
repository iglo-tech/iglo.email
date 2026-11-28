// The iglo.base test binary (15-external-sources section 8, D187, D189): the official 1.3.0 release
// of iglo-tech/iglo.base for this machine's Linux architecture, checked against a pinned SHA-256
// and cached in node_modules/.cache/ (test-excluded, so Bun's test discovery never walks it). A
// test tool only: the shipped executable gains no dependency. Run directly
// (`bun run iglo-base:download`) to fetch it ahead of the tests. The download, check and
// extraction are harness.ts's, shared with pocketbase-binary.ts.
import { releaseBinary } from "@/test/sources/harness";

export const IGLO_BASE_VERSION = "1.3.0";

/** The cached binary's path, downloading and verifying it first when it is missing. */
export function igloBaseBinary(): Promise<string> {
  return releaseBinary({
    label: "iglo.base",
    cache: `iglo-base-${IGLO_BASE_VERSION}`,
    entry: "iglo-base",
    // The release archives' SHA-256, from the release's SHA256SUMS (2026-11-27).
    archives: {
      x64: {
        name: `iglo-base_${IGLO_BASE_VERSION}_linux_amd64.zip`,
        sha256: "75c761840ca27f50afb6ec7badf210c31d7aaa2cca8793522b6be443e64c57ba",
      },
      arm64: {
        name: `iglo-base_${IGLO_BASE_VERSION}_linux_arm64.zip`,
        sha256: "8205147449f200ead69306b121213bfc0d4da8b9c4209e235db65d3839337e48",
      },
    },
    url: (archive) =>
      `https://github.com/iglo-tech/iglo.base/releases/download/v${IGLO_BASE_VERSION}/${archive}`,
    timeoutMs: 300_000,
  });
}

if (import.meta.main) {
  console.log(await igloBaseBinary());
}
