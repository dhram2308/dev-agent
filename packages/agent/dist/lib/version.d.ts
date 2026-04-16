/**
 * version.ts — Version info for MI Dev Agent
 *
 * Note: lib/version.js does not exist in the legacy codebase.
 * This is a placeholder for the unified-ts-migration task list.
 * The actual version info is typically read from package.json.
 */
/**
 * Read the agent version from the nearest package.json.
 */
declare function getVersion(): string;
/**
 * Get full version info object.
 */
declare function getVersionInfo(): {
    version: string;
    node: string;
    platform: string;
    arch: string;
};
export { getVersion, getVersionInfo };
//# sourceMappingURL=version.d.ts.map