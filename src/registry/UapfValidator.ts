import fs from "fs";
import path from "path";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { LoadedPackage } from "./UapfLoader";

export interface ValidationIssue {
  level: "error" | "warn";
  message: string;
  path?: string;
}

export class UapfValidator {
  private ajv: Ajv;
  private manifestValidator?: ValidateFunction;
  private policiesValidator?: ValidateFunction;
  private resourceBindingValidator?: ValidateFunction;
  private startupWarnings: ValidationIssue[] = [];

  constructor(private schemasDir?: string) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
    });
    addFormats(this.ajv);
    this.loadValidators();
  }

  private loadValidators() {
    if (!this.schemasDir) {
      this.startupWarnings.push({
        level: "warn",
        message: "UAPF_SCHEMAS_DIR not set; validation will be best-effort",
      });
      return;
    }

    this.manifestValidator = this.loadSchema("manifest.schema.json");
    this.policiesValidator = this.loadSchema("policies.schema.json");
    this.resourceBindingValidator = this.loadSchema("resource-binding.schema.json");
  }

  private loadSchema(fileName: string): ValidateFunction | undefined {
    const schemaPath = path.join(this.schemasDir as string, fileName);
    if (!fs.existsSync(schemaPath)) {
      this.startupWarnings.push({
        level: "warn",
        message: `Schema not found: ${schemaPath}`,
        path: schemaPath,
      });
      return undefined;
    }

    try {
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
      return this.ajv.compile(schema);
    } catch (err) {
      const message = (err as Error).message;
      this.startupWarnings.push({
        level: "warn",
        message: `Failed to load schema ${fileName}: ${message}`,
        path: schemaPath,
      });
      return undefined;
    }
  }

  private static formatErrors(
    validator: ValidateFunction,
    basePath: string
  ): ValidationIssue[] {
    if (!validator.errors) return [];
    return validator.errors.map((err: ErrorObject | any) => {
      const path = (err as any).instancePath ?? (err as any).dataPath ?? basePath ?? "";

      return {
        level: "error" as const,
        message: `${path} ${err.message ?? "invalid"}`.trim(),
        path: basePath,
      };
    });
  }

  validateManifest(manifest: unknown): ValidationIssue[] {
    if (!this.manifestValidator) {
      return [...this.startupWarnings];
    }

    const valid = this.manifestValidator(manifest);
    return valid
      ? []
      : [
          ...this.startupWarnings,
          ...UapfValidator.formatErrors(this.manifestValidator, "manifest"),
        ];
  }

  validatePolicies(policies: unknown): ValidationIssue[] {
    if (!policies) return [];
    if (!this.policiesValidator) return [...this.startupWarnings];
    const valid = this.policiesValidator(policies);
    return valid
      ? []
      : [
          ...this.startupWarnings,
          ...UapfValidator.formatErrors(this.policiesValidator, "policies"),
        ];
  }

  validateResourceBindings(resourceConfig: unknown): ValidationIssue[] {
    if (!resourceConfig) return [];
    if (!this.resourceBindingValidator) return [...this.startupWarnings];
    const valid = this.resourceBindingValidator(resourceConfig);
    return valid
      ? []
      : [
          ...this.startupWarnings,
          ...UapfValidator.formatErrors(
            this.resourceBindingValidator,
            "resource-bindings"
          ),
        ];
  }

  validatePackage(pkg: LoadedPackage): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    issues.push(...this.validateManifest(pkg.manifest));
    issues.push(...this.validatePolicies(pkg.policies));
    issues.push(...this.validateResourceBindings(pkg.resources));
    return issues;
  }

  validateWorkspaceIndex(indexData: any, indexPath: string): ValidationIssue[] {
    if (!indexData) {
      return [
        ...this.startupWarnings,
        { level: "warn", message: "Workspace index missing or empty", path: indexPath },
      ];
    }

    if (typeof indexData !== "object") {
      return [
        ...this.startupWarnings,
        { level: "error", message: "Workspace index is not an object", path: indexPath },
      ];
    }

    const hasPackages = Array.isArray((indexData as any).packages);
    const hasEntries = Array.isArray((indexData as any).entries);
    if (!hasPackages && !hasEntries) {
      return [
        ...this.startupWarnings,
        {
          level: "warn",
          message: "Workspace index should include packages[] or entries[]",
          path: indexPath,
        },
      ];
    }
    return [...this.startupWarnings];
  }

  collectStartupWarnings(): ValidationIssue[] {
    return [...this.startupWarnings];
  }
}
