import express from "express";
import bodyParser from "body-parser";
import {
  PORT,
  UAPF_SCHEMAS_DIR,
  WORKSPACE_DIR,
  resolveRegistryMode,
} from "../config";
import { SimpleExecutionEngine } from "../engine/SimpleExecutionEngine";
import { createRoutes } from "./routes";
import { logger } from "../utils/logger";
import { DirectoryRegistry } from "../registry/DirectoryRegistry";
import { WorkspaceRegistry } from "../registry/WorkspaceRegistry";
import { UapfValidator } from "../registry/UapfValidator";

async function main() {
  const app = express();
  app.use(bodyParser.json());

  const validator = new UapfValidator(UAPF_SCHEMAS_DIR || undefined);
  const registryMode = resolveRegistryMode();
  const registry =
    registryMode === "workspace"
      ? new WorkspaceRegistry(WORKSPACE_DIR, validator)
      : new DirectoryRegistry(validator);
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
