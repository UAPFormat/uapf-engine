import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import os from "os";
import path from "path";
import multer from "multer";
import packageJson from "../../package.json";
import {
  ARTIFACT_CACHE_DIR,
  PACKAGES_DIR,
  PORT,
  UAPF_MODE,
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

function getEngineConfig(effectiveMode?: string) {
  return {
    service: "uapf-engine",
    version: packageJson.version,
    mode: effectiveMode || UAPF_MODE,
    packagesDir: PACKAGES_DIR,
    workspaceDir: WORKSPACE_DIR || null,
    schemasDir: UAPF_SCHEMAS_DIR || null,
    artifactCacheDir: ARTIFACT_CACHE_DIR,
    mcp: {
      websocketUrl: process.env.MCP_WS_URL || "ws://localhost:7900",
    },
  };
}

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

  const uploadTmpDir =
    process.env.UPLOAD_TMP_DIR || path.join(os.tmpdir(), "uapf-upload");

  if (!fs.existsSync(uploadTmpDir)) {
    fs.mkdirSync(uploadTmpDir, { recursive: true });
  }

  const upload = multer({ dest: uploadTmpDir });

  app.get("/_/config", (_req, res) => {
    res.json(getEngineConfig(registry.mode()));
  });

  app.post("/uapf/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const originalName = req.file.originalname;
      if (!originalName.endsWith(".uapf")) {
        await fs.promises.unlink(req.file.path);
        res
          .status(400)
          .json({ error: "Uploaded file must have .uapf extension" });
        return;
      }

      if (!fs.existsSync(PACKAGES_DIR)) {
        fs.mkdirSync(PACKAGES_DIR, { recursive: true });
      }

      const targetPath = path.join(PACKAGES_DIR, originalName);
      await fs.promises.rename(req.file.path, targetPath);

      res.json({
        status: "ok",
        message:
          "Package uploaded. If the engine does not auto-rescan, restart it.",
        file: {
          originalName,
          path: targetPath,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(500).json({ error: message });
    }
  });

  const staticDir = path.join(__dirname, "../../public");
  if (fs.existsSync(staticDir)) {
    app.use("/ui", express.static(staticDir));
  }

  app.get("/", (_req, res) => {
    res.redirect("/ui/uapf-dashboard.html");
  });

  app.use("/", createRoutes(registry, engine));

  app.listen(PORT, "0.0.0.0", () => {
    logger.info(`uapf-engine listening on port ${PORT}`);
  });
}

main().catch((err) => {
  logger.error(`Failed to start uapf-engine: ${(err as Error).message}`);
  process.exit(1);
});
