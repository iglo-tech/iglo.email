// Loaded by bunfig.toml before every test file. Builds `dist/assets` and `dist/iglo.email` once
// per `bun test` run, before any test file imports the generated asset manifest, so a single
// file, a directory and a bare `bun test --parallel=N` run all find complete assets. `bun run test`
// has already built and sets IGLO_TEST_PREBUILT, which makes this a no-op.
import { ensureProductionBuild } from "@/test/production-build";

await ensureProductionBuild();
