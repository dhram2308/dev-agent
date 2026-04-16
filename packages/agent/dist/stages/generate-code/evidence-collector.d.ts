/**
 * Collect all evidence from a Playwright page after navigating to a route.
 */
declare function collectEvidence(page: any, route: string, acceptanceCriteria: string): Promise<any>;
/**
 * Capture structured accessibility tree from the page.
 */
declare function captureAccessibilityTree(page: any): Promise<any>;
/**
 * Capture visible text content from the page.
 */
declare function captureVisibleText(page: any): Promise<string>;
/**
 * Run targeted DOM checks based on acceptance criteria keywords.
 */
declare function runDOMChecks(page: any, acceptanceCriteria: string): Promise<any[]>;
/**
 * Set up network activity capture on a page.
 * Call BEFORE navigation. Returns a collector object.
 */
declare function setupNetworkCapture(page: any): {
    summary: () => any;
    reset: () => void;
};
/**
 * Set up console error capture on a page.
 * Call BEFORE navigation. Returns a collector object.
 */
declare function setupConsoleCapture(page: any): {
    errors: () => any[];
    reset: () => void;
};
/**
 * Capture navigation timeline.
 */
declare function captureNavigationTimeline(page: any, expectedRoute: string): Promise<any>;
/**
 * Capture a full-page screenshot to disk.
 */
declare function captureScreenshot(page: any, route: string, ticket: string): Promise<string | null>;
/**
 * Aggregate evidence from multiple route results into a single object for the Gap Analysis Agent.
 */
declare function aggregateEvidence(routeResults: any[]): any;
export { collectEvidence, captureAccessibilityTree, captureVisibleText, runDOMChecks, setupNetworkCapture, setupConsoleCapture, captureNavigationTimeline, captureScreenshot, aggregateEvidence, };
//# sourceMappingURL=evidence-collector.d.ts.map