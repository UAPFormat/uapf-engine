export interface UapfManifest {
  id: string;
  version: string;
  name?: string;
  description?: string;
  processes?: Array<{
    id: string;
    bpmnProcessId: string;
    label?: string;
  }>;
  decisions?: Array<{
    id: string;
    dmnDecisionId: string;
    label?: string;
  }>;
}

export interface UapfPackageInfo {
  packageId: string;
  version: string;
  filePath: string;
  manifest: UapfManifest;
}
