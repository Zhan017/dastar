import { parseWorkerConfig, startWorker } from "./worker.js";

let config;
try {
  config = parseWorkerConfig(process.env);
} catch (e) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "bad configuration", error: (e as Error).message }));
  process.exit(2);
}
const running = startWorker(config);
console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "sweeping", everyMs: config.sweep.everyMs, limit: config.sweep.limit }));
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void running.stop().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
