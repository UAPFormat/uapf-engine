import express from "express";
import bodyParser from "body-parser";
import { PORT } from "../config";
import { PackageRegistry } from "../registry/packageRegistry";
import { SimpleExecutionEngine } from "../engine/SimpleExecutionEngine";
import { createRoutes } from "./routes";
import { logger } from "../utils/logger";

async function main() {
  const app = express();
  app.use(bodyParser.json());

  const registry = new PackageRegistry();
  await registry.loadAll();

  const engine = new SimpleExecutionEngine(registry);
  app.use("/", createRoutes(registry, engine));

  app.listen(PORT, () => {
    logger.info(`uapf-engine listening on port ${PORT}`);
  });
}

main().catch((err) => {
  logger.error(`Failed to start uapf-engine: ${(err as Error).message}`);
  process.exit(1);
});
