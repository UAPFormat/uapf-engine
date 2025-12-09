export interface LoadedUapfPackage {
  manifest: any;
  filePath: string;
}

export function loadUapfPackage(filePath: string): Promise<LoadedUapfPackage>;
export function validatePackage(pkg: LoadedUapfPackage): Promise<void>;
