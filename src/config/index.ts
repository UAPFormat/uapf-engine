import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

type ModeSetting = "packages" | "workspace" | "auto";

export const PORT = Number(process.env.PORT || 4000);
export const UAPF_MODE: ModeSetting =
  (process.env.UAPF_MODE as ModeSetting) || "packages";

export const PACKAGES_DIR = process.env.PACKAGES_DIR
  ? path.resolve(process.env.PACKAGES_DIR)
  : path.resolve(process.cwd(), "packages");

export const WORKSPACE_DIR = process.env.WORKSPACE_DIR
  ? path.resolve(process.env.WORKSPACE_DIR)
  : "";

export const WORKSPACE_INDEX_FILENAMES = (process.env
  .WORKSPACE_INDEX_FILENAMES?.split(",")
  .map((entry) => entry.trim())
  .filter(Boolean) || [
  "workspace.json",
  "uapf.workspace.json",
  "uapf-workspace.json",
]).filter(Boolean);

export const UAPF_SCHEMAS_DIR = process.env.UAPF_SCHEMAS_DIR
  ? path.resolve(process.env.UAPF_SCHEMAS_DIR)
  : "";

export const ARTIFACT_CACHE_DIR = process.env.ARTIFACT_CACHE_DIR
  ? path.resolve(process.env.ARTIFACT_CACHE_DIR)
  : path.resolve(process.cwd(), ".cache", "uapf-artifacts");

export function resolveRegistryMode(): "packages" | "workspace" {
  if (UAPF_MODE === "workspace") {
    if (!WORKSPACE_DIR) {
      throw new Error("WORKSPACE_DIR must be set when UAPF_MODE=workspace");
    }
    if (!fs.existsSync(WORKSPACE_DIR)) {
      throw new Error(
        `WORKSPACE_DIR does not exist: ${WORKSPACE_DIR}. Create it or update the path.`
      );
    }
    return "workspace";
  }

  if (UAPF_MODE === "auto") {
    if (WORKSPACE_DIR && fs.existsSync(WORKSPACE_DIR)) {
      return "workspace";
    }
    return "packages";
  }

  return "packages";
}
