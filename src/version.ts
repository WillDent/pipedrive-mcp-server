import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultPackageJsonPath = resolve(moduleDirectory, "../package.json");

export function getPackageVersion(packageJsonPath = defaultPackageJsonPath): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.trim()) return version.trim();
    }
  } catch {
    // A stable fallback keeps the server diagnosable when a package is assembled incorrectly.
  }
  return "unknown";
}
