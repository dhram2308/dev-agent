"use strict";
/**
 * version.ts — Version info for MI Dev Agent
 *
 * Note: lib/version.js does not exist in the legacy codebase.
 * This is a placeholder for the unified-ts-migration task list.
 * The actual version info is typically read from package.json.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVersion = getVersion;
exports.getVersionInfo = getVersionInfo;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Read the agent version from the nearest package.json.
 */
function getVersion() {
    try {
        const pkgPath = path_1.default.join(__dirname, "..", "..", "package.json");
        const pkg = JSON.parse(fs_1.default.readFileSync(pkgPath, "utf8"));
        return pkg.version || "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
/**
 * Get full version info object.
 */
function getVersionInfo() {
    return {
        version: getVersion(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
    };
}
//# sourceMappingURL=version.js.map