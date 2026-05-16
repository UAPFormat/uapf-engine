import { Router } from "express";
import { IExecutionEngine } from "../engine/ExecutionEngine";
import { RealExecutionEngine } from "../engine/RealExecutionEngine";
import { SessionManager } from "../engine/SessionManager";
import { IUapfRegistry } from "../registry/IUapfRegistry";
import packageJson from "../../package.json";

export function createRoutes(
  registry: IUapfRegistry,
  engine: IExecutionEngine,
  sessions?: SessionManager
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
      uapfIpSpec: "v0.1",
      sessionSurface: !!sessions,
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

  // Legacy stateless endpoints
  router.post("/uapf/execute-process", async (req, res) => {
    try {
      const { packageId, processId, input } = req.body || {};
      const result = await engine.executeProcessOnce({ packageId, processId, input });
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Execution failed";
      res.status(400).json({ error: message });
    }
  });

  router.post("/uapf/evaluate-decision", async (req, res) => {
    try {
      const { packageId, decisionId, input } = req.body || {};
      const result = await engine.evaluateDecision({ packageId, decisionId, input });
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Decision evaluation failed";
      res.status(400).json({ error: message });
    }
  });

  router.post("/uapf/resolve-resources", async (req, res) => {
    try {
      const { packageId, processId, taskId } = req.body || {};
      const result = await registry.resolveResources({ packageId, processId, taskId });
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

  // UAPF-IP v0.1 session surface
  router.post("/uapf/start-session", async (req, res) => {
    if (!(engine instanceof RealExecutionEngine) || !sessions) {
      res.status(501).json({ error: "session_surface_not_wired" });
      return;
    }
    try {
      const { packageId, packageVersion, processId, input, hostManifest, guardrailsRef } =
        req.body || {};
      if (!packageId || !processId || !hostManifest) {
        res.status(400).json({
          error: "missing_fields",
          required: ["packageId", "processId", "hostManifest"],
        });
        return;
      }
      const result = await engine.startSession({
        packageId,
        packageVersion,
        processId,
        input,
        hostManifest,
        guardrailsRef,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "start-session failed";
      res.status(400).json({ error: message });
    }
  });

  router.get("/uapf/sessions", (_req, res) => {
    if (!sessions) {
      res.status(501).json({ error: "session_surface_not_wired" });
      return;
    }
    res.json(
      sessions.list().map((s) => ({
        sessionId: s.sessionId,
        packageId: s.packageId,
        processId: s.processId,
        state: s.state,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      }))
    );
  });

  router.get("/uapf/sessions/:sessionId", (req, res) => {
    if (!sessions) {
      res.status(501).json({ error: "session_surface_not_wired" });
      return;
    }
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json(session);
  });

  router.get("/uapf/sessions/:sessionId/audit", (req, res) => {
    if (!sessions) {
      res.status(501).json({ error: "session_surface_not_wired" });
      return;
    }
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json(session.auditChain);
  });

  // UAPF-IP v0.1 — abort a running session (G2)
  router.post("/uapf/sessions/:sessionId/abort", (req, res) => {
    if (!sessions) {
      res.status(501).json({ error: "session_surface_not_wired" });
      return;
    }
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    const reason =
      req.body && typeof req.body.reason === "string" ? req.body.reason : undefined;
    const aborted = sessions.abort(req.params.sessionId, reason);
    if (!aborted) {
      res.status(409).json({
        error: "session_not_abortable",
        detail: `Session is in terminal state '${session.state}'.`,
      });
      return;
    }
    res.json({ sessionId: session.sessionId, state: "aborted" });
  });

  // ─── Admin: package management ────────────────────────────────────
  //
  // These endpoints let an external host (typically OpenDMS) sync packages
  // from a source-of-truth like ProcessGit at runtime, without redeploying
  // the engine. The host fetches the .uapf or repo archive via this engine,
  // then optionally triggers a reload.

  router.post("/uapf/admin/reload", async (_req, res) => {
    if (!registry.reloadAll) {
      res.status(501).json({ error: "reload_not_supported_in_this_registry_mode" });
      return;
    }
    try {
      const pkgs = await registry.reloadAll();
      res.json({
        reloaded: true,
        packageCount: pkgs.length,
        packages: pkgs.map((p) => ({
          packageId: p.packageId,
          version: p.version,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: "reload_failed", detail: (err as Error).message });
    }
  });

  router.post("/uapf/admin/install-from-url", async (req, res) => {
    if (!registry.installFromUrl) {
      res.status(501).json({ error: "install_not_supported_in_this_registry_mode" });
      return;
    }
    const { sourceUrl, packageId, filename } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== "string") {
      res.status(400).json({ error: "sourceUrl_required" });
      return;
    }
    try {
      const result = await registry.installFromUrl({ sourceUrl, packageId, filename });
      res.json({ installed: true, ...result });
    } catch (err) {
      res.status(500).json({ error: "install_failed", detail: (err as Error).message });
    }
  });

  return router;
}
