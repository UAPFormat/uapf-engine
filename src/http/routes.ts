import { Router } from "express";
import { PackageRegistry } from "../registry/packageRegistry";
import { IExecutionEngine } from "../engine/ExecutionEngine";

export function createRoutes(
  registry: PackageRegistry,
  engine: IExecutionEngine
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/uapf/packages", (_req, res) => {
    const pkgs = registry.getAll().map((p) => ({
      packageId: p.packageId,
      version: p.version,
      name: p.manifest.name,
      description: p.manifest.description,
      processes: p.manifest.processes || [],
      decisions: p.manifest.decisions || [],
    }));
    res.json(pkgs);
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

  return router;
}
