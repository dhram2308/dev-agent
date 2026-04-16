/**
 * version.ts — Version info for MI Dev Agent
 *
 * Note: lib/version.js does not exist in the legacy codebase.
 * This is a placeholder for the unified-ts-migration task list.
 * The actual version info is typically read from package.json.
 */

import fs from "fs";
import path from "path";

/**
 * Read the agent version from the nearest package.json.
 */
function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Get full version info object.
 */
function getVersionInfo(): { version: string; node: string; platform: string; arch: string } {
  return {
    version: getVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

export { getVersion, getVersionInfo };
