import fs from "fs";
import path from "path";

export interface LoadedUapfPackage {
  manifest: any;
  filePath: string;
}

export async function loadUapfPackage(filePath: string): Promise<LoadedUapfPackage> {
  const absolutePath = path.resolve(filePath);
  const raw = await fs.promises.readFile(absolutePath, "utf8");
  let manifest: any;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse UAPF package ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { manifest, filePath: absolutePath };
}

export async function validatePackage(_pkg: LoadedUapfPackage): Promise<void> {
  // Stub validation placeholder
  return;
}
