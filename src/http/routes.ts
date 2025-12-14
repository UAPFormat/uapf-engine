import { Router } from "express";
import { IExecutionEngine } from "../engine/ExecutionEngine";
import { IUapfRegistry } from "../registry/IUapfRegistry";
import packageJson from "../../package.json";

export function createRoutes(
  registry: IUapfRegistry,
  engine: IExecutionEngine
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/_/meta", (_req, res) => {
    res.json({
      service: "uapf-engine",
      mode: registry.mode(),
      version: packageJson.version,
    });
  });

  router.get("/uapf/packages", async (_req, res) => {
    const pkgs = await registry.listPackages();
    res.json(pkgs);
  });

  router.get("/uapf/packages/:packageId", async (req, res) => {
    const pkg = await registry.getPackage(req.params.packageId);
    if (!pkg) {
      res.status(404).json({ error: "package_not_found" });
      return;
    }
    res.json(pkg);
  });

  router.get("/uapf/packages/:packageId/artifacts/:kind", async (req, res) => {
    const { packageId, kind } = req.params;
    const { id } = req.query;
    const allowedKinds = ["manifest", "bpmn", "dmn", "cmmn", "docs", "tests"];
    if (!allowedKinds.includes(kind)) {
      res.status(400).json({ error: "invalid_artifact_kind" });
      return;
    }
    const artifact = await registry.getArtifact(
      packageId,
      kind as any,
      id as string | undefined
    );
    if (!artifact) {
      res.status(404).json({ error: "artifact_not_found" });
      return;
    }
    res.contentType(artifact.mediaType);
    res.send(artifact.content);
  });

  router.post("/uapf/execute-process", async (req, res) => {
    try {
      const { packageId, processId, input } = req.body || {};
      const result = await engine.executeProcessOnce({
        packageId,
        processId,
        input,
      });
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Execution failed";
      res.status(400).json({ error: message });
    }
  });

  router.post("/uapf/evaluate-decision", async (req, res) => {
    try {
      const { packageId, decisionId, input } = req.body || {};
      const result = await engine.evaluateDecision({
        packageId,
        decisionId,
        input,
      });
      res.json(result);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Decision evaluation failed";
      res.status(400).json({ error: message });
    }
  });

  router.post("/uapf/resolve-resources", async (req, res) => {
    try {
      const { packageId, processId, taskId } = req.body || {};
      const result = await registry.resolveResources({
        packageId,
        processId,
        taskId,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Resolve failed";
      res.status(400).json({ error: message });
    }
  });

  router.post("/uapf/validate", async (req, res) => {
    try {
      const { packageId } = req.body || {};
      const result = await registry.validateWorkspaceOrPackage({ packageId });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Validation failed";
      res.status(400).json({ error: message });
    }
  });

  return router;
}
