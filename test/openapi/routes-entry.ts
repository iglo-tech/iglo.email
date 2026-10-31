// Prints the production composition's router, then stops before anything listens.
import { main } from "@/main";

class Listed extends Error {}

await main((router) => {
  process.stdout.write(JSON.stringify(router.list()));
  throw new Listed();
}).catch((error: unknown) => {
  if (!(error instanceof Listed)) throw error;
});
