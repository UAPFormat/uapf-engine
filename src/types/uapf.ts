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

// UAPF v2.4.0 — Algorithm Card.
// A card is the governance wrapper for the algorithm a BPMN task invokes.
// Loaded from algorithms/*.card.yaml inside a package. Referenced from a
// BPMN task via the uapf:algorithmCardRef attribute (in namespace
// https://uapf.dev/bpmn/v2.4 — prefix arbitrary; XMLParser strips it).
export interface AlgorithmCardIO {
  inputs?: Array<{ id: string; type: string; description?: string; required?: boolean }>;
  outputs?: Array<{ id: string; type: string; description?: string }>;
}
export interface AlgorithmCardRisk {
  aiActRiskClass?: string;       // minimal | limited | high | unacceptable
  humanOversight?: string;       // none | advisory | mandatory
}
export interface AlgorithmCard {
  id: string;
  name?: string;
  version: string;
  description?: string;
  algorithm_kind?: string;       // free-form (redactor, extractor, classifier, ...)
  determinism?: "deterministic" | "stochastic" | "learned";
  io?: AlgorithmCardIO;
  risk?: AlgorithmCardRisk;
  implementation?: unknown;
  [key: string]: unknown;        // allow card extensions (ml, crypto, privacy, prompt, ...)
}
