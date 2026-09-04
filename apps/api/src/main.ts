import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { MemoryEventStore } from "./store/eventStore.js";

const config = loadConfig();
const app = buildServer({ config, store: new MemoryEventStore() });

app.listen({ port: config.PORT, host: "0.0.0.0" }).then((address) => {
  app.log.info({ address, origin: config.ORIGIN_ANSWER_URL, policy: config.POLICY_MODE }, "preflight api listening");
}).catch((err: unknown) => {
  app.log.fatal({ err }, "preflight api failed to start");
  process.exit(1);
});
