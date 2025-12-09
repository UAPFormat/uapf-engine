import fs from "fs";
import path from "path";
import { loadUapfPackage, validatePackage } from "@uapf/uapf-typescript";
import { PACKAGES_DIR } from "../config";
import { logger } from "../utils/logger";
import { UapfPackageInfo, UapfManifest } from "../types/uapf";

export class PackageRegistry {
  private packages: Map<string, UapfPackageInfo> = new Map();

  async loadAll(): Promise<void> {
    const files = await fs.promises.readdir(PACKAGES_DIR);
    const uapfFiles = files.filter((file) => file.toLowerCase().endsWith(".uapf"));

    for (const file of uapfFiles) {
      const filePath = path.join(PACKAGES_DIR, file);
      try {
        const loaded = await loadUapfPackage(filePath);
        await validatePackage(loaded);
        const manifest: UapfManifest = loaded.manifest;

        if (!manifest?.id || !manifest?.version) {
          throw new Error("Manifest missing required id or version");
        }

        const pkgInfo: UapfPackageInfo = {
          packageId: manifest.id,
          version: manifest.version,
          filePath,
          manifest,
        };

        this.packages.set(manifest.id, pkgInfo);
        logger.info(`Loaded UAPF package ${manifest.id}@${manifest.version} from ${filePath}`);
      } catch (err) {
        logger.error(`Failed to load package ${filePath}: ${(err as Error).message}`);
      }
    }
  }

  getAll(): UapfPackageInfo[] {
    return Array.from(this.packages.values());
  }

  getById(packageId: string): UapfPackageInfo | undefined {
    return this.packages.get(packageId);
  }
}
