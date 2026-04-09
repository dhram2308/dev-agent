"use strict";

const { cfg, QA_HEALTH_TIMEOUT } = require("../../lib/config");
const { logInfo, logOk, logWarn, logErr } = require("../../lib/logging");

// ENV_DOWN error classification (pattern from test-qa.js)
const ENV_DOWN_ERRORS = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"];

/**
 * Check if the QA backend is reachable before attempting login.
 *
 * NOTE: Intentionally uses raw http/https instead of lib/http-client's req().
 * This is a quick, single-shot probe — we want an immediate answer on whether
 * QA is reachable. The http-client's retry loop, circuit breaker, and rate
 * limiter would add unnecessary delay when QA is truly down, which is exactly
 * the scenario this function is designed to detect quickly.
 *
 * @param {string} qaUrl - The QA base URL
 * @returns {Promise<{healthy: boolean, reason?: string}>}
 */
async function checkQAHealth(qaUrl) {
  const https = require("https");
  const http = require("http");
  const url = `${qaUrl}/api/v2.1/iv-generation/`;
  const mod = url.startsWith("https") ? https : http;

  return new Promise((resolve) => {
    const req = mod.get(url, { rejectUnauthorized: false, timeout: QA_HEALTH_TIMEOUT }, (res) => {
      res.resume();
      if (res.statusCode < 500) {
        resolve({ healthy: true });
      } else {
        resolve({ healthy: false, reason: `QA backend returning ${res.statusCode}` });
      }
    });
    req.on("error", (e) => {
      const isDown = ENV_DOWN_ERRORS.some((code) => e.message.includes(code));
      resolve({ healthy: false, reason: isDown ? `QA backend unreachable: ${e.code || e.message}` : e.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ healthy: false, reason: "QA health check timed out" });
    });
  });
}

/**
 * Login to the enterprise app via Playwright.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {number} port - Dev server port
 * @param {{email: string, pass: string}} credentials - Login credentials
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
async function loginToApp(page, port, credentials) {
  if (!credentials?.email || !credentials?.pass) {
    return { success: false, reason: "Missing login credentials (email or password not configured)" };
  }

  const loginUrl = `https://localhost:${port}/login?recaptcha_disabled=true`;
  logInfo(`Login: Navigating to ${loginUrl}`);

  try {
    await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30_000 });
  } catch (e) {
    return { success: false, reason: `Login page failed to load: ${e.message.substring(0, 200)}` };
  }

  try {
    // Step 1: Fill email/username
    const usernameInput = page.locator('input[name="username"]');
    await usernameInput.waitFor({ state: "visible", timeout: 10_000 });
    await usernameInput.fill(credentials.email);

    // Step 2: Click Continue
    await page.locator('button[type="submit"]').click();

    // Step 3: Wait for password field
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.waitFor({ state: "visible", timeout: 10_000 });
    await passwordInput.fill(credentials.pass);

    // Step 4: Click Sign In
    await page.locator('button[type="submit"]').click();

    // Step 5: Wait for navigation away from /login
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
  } catch (e) {
    // Check for error messages on the page
    try {
      const errorText = await page.textContent(".ant-form-item-explain-error", { timeout: 2000 });
      if (errorText) return { success: false, reason: `Login error: ${errorText}` };
    } catch { /* no error element */ }

    return { success: false, reason: `Login form interaction failed: ${e.message.substring(0, 200)}` };
  }

  // Handle post-login screens
  return await handlePostLoginScreens(page);
}

/**
 * Handle the 7 possible post-login screens.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
async function handlePostLoginScreens(page) {
  const maxScreens = 5; // Safety limit to prevent infinite loop

  for (let i = 0; i < maxScreens; i++) {
    const currentUrl = page.url();
    let pathname;
    try { pathname = new URL(currentUrl).pathname; } catch { pathname = currentUrl; }

    if (pathname === "/dashboard" || pathname.startsWith("/dashboard")) {
      logOk("Login: Reached dashboard");
      return { success: true };
    }

    if (pathname === "/reset-password") {
      return { success: false, reason: "Account requires password reset — cannot proceed" };
    }

    if (pathname === "/otp-verify") {
      return { success: false, reason: "Account requires OTP verification — cannot automate" };
    }

    if (pathname === "/business-info") {
      return { success: false, reason: "Account requires business info onboarding — cannot proceed" };
    }

    if (pathname === "/buyer-wizard") {
      return { success: false, reason: "Account in buyer wizard onboarding — cannot proceed" };
    }

    if (pathname === "/select-mode") {
      logInfo("Login: Select mode screen — clicking Enterprise");
      try {
        // Look for Enterprise mode option
        const enterpriseBtn = page.locator('text=Enterprise').first();
        await enterpriseBtn.click({ timeout: 10_000 });
        await page.waitForURL((url) => !url.pathname.includes("/select-mode"), { timeout: 15_000 });
        continue; // Re-check new URL
      } catch (e) {
        return { success: false, reason: `Failed to select Enterprise mode: ${e.message.substring(0, 200)}` };
      }
    }

    if (pathname === "/enable-2fa") {
      logInfo("Login: 2FA screen — clicking Skip for Now");
      try {
        // The "Skip for Now" button is a ghost-type button in TwoFactorConfirm component
        const skipBtn = page.locator('button:has-text("Skip")').first();
        await skipBtn.click({ timeout: 10_000 });
        await page.waitForURL((url) => !url.pathname.includes("/enable-2fa"), { timeout: 15_000 });
        continue; // Re-check new URL
      } catch (e) {
        return { success: false, reason: `Failed to skip 2FA: ${e.message.substring(0, 200)}` };
      }
    }

    // Unknown screen — wait a bit and check if it transitions
    logWarn(`Login: Unknown post-login screen: ${pathname} — waiting 5s`);
    await page.waitForTimeout(5000);
    let newPathname;
    try { newPathname = new URL(page.url()).pathname; } catch { newPathname = page.url(); }
    if (newPathname === pathname) {
      // Still stuck on same page — might be a valid destination
      if (pathname !== "/login") {
        logInfo(`Login: Settled on ${pathname} — treating as success`);
        return { success: true };
      }
      return { success: false, reason: `Stuck on ${pathname} after login` };
    }
  }

  // After max screens, check if we're somewhere useful
  let finalPath;
  try { finalPath = new URL(page.url()).pathname; } catch { finalPath = page.url(); }
  if (finalPath !== "/login") {
    logOk(`Login: Reached ${finalPath} after post-login screens`);
    return { success: true };
  }

  return { success: false, reason: "Login failed — too many post-login redirects" };
}

module.exports = { checkQAHealth, loginToApp, handlePostLoginScreens };
