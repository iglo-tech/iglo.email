// Loaded by bunfig.toml before every test file. Makes sure `dist/assets` and `dist/iglo.email` are
// built from the current sources before the file imports the generated asset manifest, so a single
// file, a directory and a bare `bun test --parallel=N` run all find complete assets. It builds only
// when the build is missing or out of date, and never under another run (test/production-build.ts).
// `bun run test` has already checked and sets IGLO_TEST_PREBUILT, which makes this a no-op.
import { ensureProductionBuild } from "@/test/production-build";

await ensureProductionBuild();
