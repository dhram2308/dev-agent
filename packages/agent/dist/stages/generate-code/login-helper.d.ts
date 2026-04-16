/**
 * Check if the QA backend is reachable before attempting login.
 *
 * NOTE: Intentionally uses raw http/https instead of lib/http-client's req().
 * This is a quick, single-shot probe -- we want an immediate answer on whether
 * QA is reachable. The http-client's retry loop, circuit breaker, and rate
 * limiter would add unnecessary delay when QA is truly down, which is exactly
 * the scenario this function is designed to detect quickly.
 */
declare function checkQAHealth(qaUrl: string): Promise<{
    healthy: boolean;
    reason?: string;
}>;
/**
 * Login to the enterprise app via Playwright.
 */
declare function loginToApp(page: any, port: number, credentials: {
    email: string;
    pass: string;
}): Promise<{
    success: boolean;
    reason?: string;
}>;
/**
 * Handle the 7 possible post-login screens.
 */
declare function handlePostLoginScreens(page: any): Promise<{
    success: boolean;
    reason?: string;
}>;
export { checkQAHealth, loginToApp, handlePostLoginScreens };
//# sourceMappingURL=login-helper.d.ts.map