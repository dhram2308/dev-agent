declare const MODULE_ROUTE_MAP: Record<string, string>;
interface RouteResult {
    route: string;
    confidence: number;
    source: string;
    tier: number;
}
/**
 * Detect which routes to verify based on changed file paths.
 * Uses a 5-tier algorithm with decreasing confidence.
 */
declare function detectRoutes(changedFiles: Array<{
    file_path: string;
    action: string;
}>, clonePath: string, acceptanceCriteria?: string): RouteResult[];
/**
 * Tier 1: Map file path to route using known module-to-route table.
 */
declare function mapFilePathToRoute(filePath: string): string | null;
export { detectRoutes, mapFilePathToRoute, MODULE_ROUTE_MAP };
//# sourceMappingURL=route-detector.d.ts.map