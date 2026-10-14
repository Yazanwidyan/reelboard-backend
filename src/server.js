import { createApp } from "./app.js";
import config from "./config.js";
import { closeDatabase, openDatabase } from "./db/index.js";

openDatabase();
const server = createApp().listen(config.port, () => {
  console.log(`ReelBoard API listening on http://localhost:${config.port}/api`);
});

const shutdown = () => {
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
