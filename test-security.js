#!/usr/bin/env node
"use strict";

/**
 * test-security.js — Comprehensive tests for lib/security.js
 * Run: node test-security.js
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const {
  // Session & Auth
  SessionStore,
  sessionStore,
  parseCookies,
  buildSetCookie,
  authenticate,
  SESSION_COOKIE_NAME,

  // Input Sanitization
  validateTicket,
  validateGate,
  validateStage,
  safeJsonParse,
  sanitize,
  safePath,
  VALID_GATES,

  // Security Headers
  generateNonce,
  buildCSP,
  getSecurityHeaders,

  // CORS
  checkCORS,

  // Token Management
  loadOrCreateToken,
  safeTokenInjection,

  // Redaction
  redactSecrets,
  redactObject,

  // File Security
  atomicWriteFile,
  safeUnlink,

  // Rate Limiting
  RateLimiter,

  // Error Handling
  SecurityError,
  sendError,
  sanitizeErrorMessage,

  // Integrated Middleware
  securityMiddleware,

  // HTML
  escapeHtml,
} = require("./lib/security");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, description) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(description);
    console.error(`  FAIL: ${description}`);
  }
}

function assertEq(actual, expected, description) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`${description} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.error(`  FAIL: ${description} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function section(name) {
  console.log(`\n  --- ${name} ---`);
}

// ═══════════════════════════════════════════════════════════════════
// 1. SESSION STORE TESTS
// ═══════════════════════════════════════════════════════════════════

section("SessionStore");

{
  const store = new SessionStore({ ttlMs: 1000, maxSessions: 5 });

  // Create and retrieve session
  const sid = store.create({ authenticated: true, ip: "127.0.0.1" });
  assert(typeof sid === "string" && sid.length === 64, "Session ID is 64-char hex");
  assert(/^[0-9a-f]{64}$/.test(sid), "Session ID is valid hex");

  const session = store.get(sid);
  assert(session !== null, "Can retrieve created session");
  assertEq(session.authenticated, true, "Session data preserved");
  assertEq(session.ip, "127.0.0.1", "Session IP preserved");

  // Invalid session IDs
  assert(store.get("") === null, "Empty session ID returns null");
  assert(store.get(null) === null, "Null session ID returns null");
  assert(store.get("short") === null, "Short session ID returns null");
  assert(store.get("x".repeat(64)) === null, "Non-hex session ID returns null");
  assert(store.get("a".repeat(63)) === null, "63-char session ID returns null");

  // Destroy session
  store.destroy(sid);
  assert(store.get(sid) === null, "Destroyed session returns null");

  // Max sessions eviction
  const sids = [];
  for (let i = 0; i < 6; i++) {
    sids.push(store.create({ num: i }));
  }
  assert(store.size <= 5, "Max sessions enforced");

  // Destroy all
  store.destroyAll();
  assertEq(store.size, 0, "destroyAll clears all sessions");

  store.dispose();
}

// ═══════════════════════════════════════════════════════════════════
// 2. COOKIE PARSING
// ═══════════════════════════════════════════════════════════════════

section("Cookie Parsing");

{
  const req1 = { headers: { cookie: "__mi_agent_sid=abc123; other=val" } };
  const cookies = parseCookies(req1);
  assertEq(cookies["__mi_agent_sid"], "abc123", "Parse session cookie");
  assertEq(cookies["other"], "val", "Parse other cookie");

  const req2 = { headers: {} };
  const cookies2 = parseCookies(req2);
  assertEq(Object.keys(cookies2).length, 0, "No cookie header returns empty");
}

{
  const cookie = buildSetCookie("test", "value", { maxAge: 3600, httpOnly: true, sameSite: "Strict" });
  assert(cookie.includes("test=value"), "Set-Cookie includes name=value");
  assert(cookie.includes("Max-Age=3600"), "Set-Cookie includes Max-Age");
  assert(cookie.includes("HttpOnly"), "Set-Cookie includes HttpOnly");
  assert(cookie.includes("SameSite=Strict"), "Set-Cookie includes SameSite");
}

// ═══════════════════════════════════════════════════════════════════
// 3. INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════════

section("Ticket Validation");

{
  assertEq(validateTicket("AUT-8031"), "AUT-8031", "Valid ticket: AUT-8031");
  assertEq(validateTicket("proj-123"), "PROJ-123", "Lowercase ticket uppercased");
  assertEq(validateTicket("A-1"), "A-1", "Minimal ticket");
  assertEq(validateTicket("ABCDEFGHIJ-999999"), "ABCDEFGHIJ-999999", "Max-length ticket");

  assertEq(validateTicket(null), null, "Null ticket");
  assertEq(validateTicket(""), null, "Empty ticket");
  assertEq(validateTicket("INVALID"), null, "No dash");
  assertEq(validateTicket("123-ABC"), null, "Numbers first");
  assertEq(validateTicket("A-"), null, "No digits");
  assertEq(validateTicket("-1"), null, "No letters");
  assertEq(validateTicket("A-1; rm -rf /"), null, "Injection attempt");
  assertEq(validateTicket("../../../etc/passwd"), null, "Path traversal");
  assertEq(validateTicket("__proto__"), null, "Prototype pollution key");
}

section("Gate Validation");

{
  assertEq(validateGate("explore_plan"), "explore_plan", "Valid gate: explore_plan");
  assertEq(validateGate("gate_code_review"), "gate_code_review", "Valid gate: gate_code_review");
  assertEq(validateGate("GATE_CODE_REVIEW"), "gate_code_review", "Uppercase gate lowercased");

  assertEq(validateGate("__proto__"), null, "Prototype pollution blocked");
  assertEq(validateGate("constructor"), null, "Constructor blocked");
  assertEq(validateGate("prototype"), null, "Prototype blocked");
  assertEq(validateGate("invalid_gate"), null, "Unknown gate blocked");
  assertEq(validateGate(""), null, "Empty gate");
  assertEq(validateGate(null), null, "Null gate");
}

section("Stage Validation");

{
  assertEq(validateStage("fetch_ticket"), "fetch_ticket", "Valid stage");
  assertEq(validateStage("DONE"), "done", "Uppercase stage lowercased");
  assertEq(validateStage("invalid"), null, "Unknown stage blocked");
  assertEq(validateStage("__proto__"), null, "Proto pollution in stage");
}

section("Safe JSON Parse");

{
  const normal = safeJsonParse('{"name": "test", "value": 42}');
  assertEq(normal.name, "test", "Normal JSON parse works");
  assertEq(normal.value, 42, "Normal JSON values preserved");

  // Prototype pollution attacks
  const polluted = safeJsonParse('{"__proto__": {"isAdmin": true}, "name": "test"}');
  assert(!Object.prototype.hasOwnProperty.call(polluted, "__proto__"), "__proto__ own property stripped");
  assertEq(({}).isAdmin, undefined, "__proto__ pollution did NOT inject isAdmin onto Object.prototype");
  assertEq(polluted.name, "test", "Normal keys preserved after strip");

  const nested = safeJsonParse('{"data": {"__proto__": {"evil": true}}}');
  assert(!Object.prototype.hasOwnProperty.call(nested.data || {}, "__proto__"), "Nested __proto__ stripped");

  const constructor_attack = safeJsonParse('{"constructor": {"prototype": {"x": 1}}}');
  assert(!Object.prototype.hasOwnProperty.call(constructor_attack, "constructor"), "constructor own property stripped");
}

section("Sanitize Function");

{
  const result = sanitize(
    { ticket: "aut-8031", gate: "EXPLORE_PLAN", feedback: "Looks good" },
    {
      ticket: { type: "ticket", required: true },
      gate: { type: "gate", required: true },
      feedback: { type: "string", maxLength: 10000 },
    }
  );
  assertEq(result.ticket, "AUT-8031", "Sanitize normalizes ticket");
  assertEq(result.gate, "explore_plan", "Sanitize normalizes gate");
  assertEq(result.feedback, "Looks good", "Sanitize preserves valid string");

  // Missing required field
  let threw = false;
  try {
    sanitize({}, { ticket: { type: "ticket", required: true } });
  } catch (e) {
    threw = true;
    assert(e instanceof SecurityError, "Throws SecurityError for missing field");
    assertEq(e.code, "MISSING_FIELD", "Error code is MISSING_FIELD");
  }
  assert(threw, "Missing required field throws");

  // String length limits
  threw = false;
  try {
    sanitize(
      { text: "x".repeat(101) },
      { text: { type: "string", maxLength: 100 } }
    );
  } catch (e) {
    threw = true;
    assertEq(e.code, "TOO_LONG", "TOO_LONG for oversized string");
  }
  assert(threw, "Oversized string throws");

  // Null bytes stripped
  const withNull = sanitize(
    { text: "hello\0world" },
    { text: { type: "string" } }
  );
  assertEq(withNull.text, "helloworld", "Null bytes stripped from strings");
}

section("Safe Path");

{
  const base = "/home/user/project";
  const safe = safePath(base, "state-AUT-8031.json");
  assert(safe.startsWith(base), "Safe path stays within base");

  let threw = false;
  try {
    safePath(base, "../../etc/passwd");
  } catch (e) {
    threw = true;
    assertEq(e.code, "PATH_TRAVERSAL", "Path traversal detected");
  }
  assert(threw, "Path traversal throws");

  threw = false;
  try {
    safePath(base, "/etc/passwd");
  } catch (e) {
    threw = true;
    assertEq(e.code, "PATH_TRAVERSAL", "Absolute path traversal detected");
  }
  assert(threw, "Absolute path traversal throws");
}

// ═══════════════════════════════════════════════════════════════════
// 4. SECURITY HEADERS
// ═══════════════════════════════════════════════════════════════════

section("Security Headers");

{
  const nonce = generateNonce();
  assert(typeof nonce === "string" && nonce.length > 0, "Nonce generated");

  const headers = getSecurityHeaders({ nonce });
  assert(headers["Content-Security-Policy"].includes(`nonce-${nonce}`), "CSP includes nonce");
  assert(headers["Content-Security-Policy"].includes("'unsafe-inline'"), "CSP allows inline styles");
  assert(!headers["Content-Security-Policy"].includes("'unsafe-eval'"), "CSP blocks eval");
  assertEq(headers["X-Content-Type-Options"], "nosniff", "nosniff header set");
  assertEq(headers["X-Frame-Options"], "DENY", "X-Frame-Options is DENY");
  assertEq(headers["Cache-Control"], "no-store, no-cache, must-revalidate, private", "Cache-Control prevents caching");
  assert(headers["Content-Security-Policy"].includes("frame-ancestors 'none'"), "CSP prevents framing");
  assert(headers["Content-Security-Policy"].includes("object-src 'none'"), "CSP blocks objects");
}

// ═══════════════════════════════════════════════════════════════════
// 5. CORS
// ═══════════════════════════════════════════════════════════════════

section("CORS Policy");

{
  // Same-origin with Sec-Fetch-Site
  const req1 = { method: "GET", headers: { "sec-fetch-site": "same-origin", host: "localhost:3000" } };
  const url1 = new URL("http://localhost:3000/api/state");
  assertEq(checkCORS(req1, url1).allowed, true, "Same-origin allowed");

  // Cross-origin with Sec-Fetch-Site
  const req2 = { method: "GET", headers: { "sec-fetch-site": "cross-site", host: "localhost:3000" } };
  assertEq(checkCORS(req2, url1).allowed, false, "Cross-site blocked");

  // Same-site blocked
  const req3 = { method: "GET", headers: { "sec-fetch-site": "same-site", host: "localhost:3000" } };
  assertEq(checkCORS(req3, url1).allowed, false, "Same-site blocked");

  // Direct navigation allowed
  const req4 = { method: "GET", headers: { "sec-fetch-site": "none", host: "localhost:3000" } };
  assertEq(checkCORS(req4, url1).allowed, true, "Direct navigation allowed");

  // OPTIONS preflight denied
  const req5 = { method: "OPTIONS", headers: { host: "localhost:3000" } };
  assertEq(checkCORS(req5, url1).allowed, false, "OPTIONS preflight denied");

  // Cross-origin via Origin header (fallback)
  const req6 = { method: "POST", headers: { origin: "http://evil.com", host: "localhost:3000" } };
  assertEq(checkCORS(req6, url1).allowed, false, "Cross-origin Origin header blocked");
}

// ═══════════════════════════════════════════════════════════════════
// 6. TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

section("Token Management");

{
  const result = loadOrCreateToken();
  assert(result.token.length >= 48, "Token has sufficient length");
  assert(typeof result.created === "boolean", "created flag returned");

  // Safe injection
  const nonce = generateNonce();
  const injection = safeTokenInjection("test-token-123<script>alert(1)</script>", nonce);
  assert(injection.includes(`nonce="${nonce}"`), "Injection includes nonce");
  assert(!injection.includes("<script>alert(1)"), "XSS payload escaped");
  assert(injection.includes("\\u003c"), "< escaped to \\u003c");
  assert(injection.includes("window.__MI_TOKEN="), "Uses safe variable name");
}

// ═══════════════════════════════════════════════════════════════════
// 7. REDACTION ENGINE
// ═══════════════════════════════════════════════════════════════════

section("Redaction Engine");

{
  // Jira token
  assert(
    redactSecrets("ATATT3xAbcDefGhiJklMno12345==").includes("[JIRA_TOKEN_REDACTED]"),
    "Jira ATATT token redacted"
  );

  // GitLab token
  assert(
    redactSecrets("glpat-abcdefghijklmnopqrstuvwxyz").includes("[GITLAB_TOKEN_REDACTED]"),
    "GitLab glpat token redacted"
  );

  // GitHub tokens
  assert(
    redactSecrets("ghp_1234567890abcdefghijklmnopqrstuvwxyz").includes("[GITHUB_PAT_REDACTED]"),
    "GitHub ghp_ token redacted"
  );
  assert(
    redactSecrets("gho_1234567890abcdefghijklmnopqrstuvwxyz").includes("[GITHUB_OAUTH_REDACTED]"),
    "GitHub gho_ token redacted"
  );
  assert(
    redactSecrets("ghs_1234567890abcdefghijklmnopqrstuvwxyz").includes("[GITHUB_SERVER_REDACTED]"),
    "GitHub ghs_ token redacted"
  );

  // Slack tokens
  assert(
    redactSecrets("xoxb-12345-67890-abcdefghijklmnop").includes("[SLACK_BOT_REDACTED]"),
    "Slack xoxb token redacted"
  );
  assert(
    redactSecrets("xoxp-12345-67890-abcdefghijklmnop").includes("[SLACK_USER_REDACTED]"),
    "Slack xoxp token redacted"
  );

  // Anthropic key
  assert(
    redactSecrets("sk-ant-api03-" + "a".repeat(80)).includes("[ANTHROPIC_KEY_REDACTED]"),
    "Anthropic sk-ant-api03 key redacted"
  );
  assert(
    redactSecrets("sk-ant-abcdefghijklmnopqrstuvwxyz").includes("[ANTHROPIC_KEY_REDACTED]"),
    "Anthropic sk-ant key redacted"
  );

  // AWS credentials
  assert(
    redactSecrets("AKIAIOSFODNN7EXAMPLE").includes("[AWS_ACCESS_KEY_REDACTED]"),
    "AWS AKIA access key redacted"
  );
  assert(
    redactSecrets("ASIAIOSFODNN7EXAMPLE").includes("[AWS_TEMP_KEY_REDACTED]"),
    "AWS ASIA temp key redacted"
  );

  // SSH private key
  const sshKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----";
  assert(
    redactSecrets(sshKey).includes("[SSH_PRIVATE_KEY_REDACTED]"),
    "SSH private key redacted"
  );

  // Bearer token
  assert(
    redactSecrets("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.some.thing").includes("Bearer [REDACTED]"),
    "Bearer token redacted"
  );

  // Basic auth
  assert(
    redactSecrets("Basic dXNlcjpwYXNzd29yZA==").includes("Basic [REDACTED]"),
    "Basic auth redacted"
  );

  // JWT tokens
  assert(
    redactSecrets("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")
      .includes("[JWT_REDACTED]"),
    "JWT token redacted"
  );

  // Connection strings
  assert(
    redactSecrets("mongodb://admin:password123@db.example.com:27017")
      .includes("[CREDENTIALS_REDACTED]"),
    "Connection string credentials redacted"
  );

  // Stripe keys
  assert(
    redactSecrets("sk_live_abcdefghijklmnopqrstuvwxyz1234567890")
      .includes("[STRIPE_SECRET_REDACTED]"),
    "Stripe secret key redacted"
  );

  // Non-secret text preserved
  assertEq(redactSecrets("Hello World"), "Hello World", "Normal text unchanged");
  assertEq(redactSecrets(""), "", "Empty string unchanged");
  assertEq(redactSecrets(42), 42, "Non-string returned as-is");
}

section("Object Redaction");

{
  const obj = {
    name: "test",
    apiToken: "sk-ant-secret-key-here-1234567890",
    nested: {
      password: "hunter2",
      data: "safe-value",
    },
  };
  const redacted = redactObject(obj);
  assertEq(redacted.name, "test", "Non-secret field preserved");
  assertEq(redacted.apiToken, "[REDACTED]", "Token field redacted by key name");
  assertEq(redacted.nested.password, "[REDACTED]", "Password field redacted by key name");
  assertEq(redacted.nested.data, "safe-value", "Non-secret nested field preserved");
}

// ═══════════════════════════════════════════════════════════════════
// 8. FILE SECURITY
// ═══════════════════════════════════════════════════════════════════

section("File Security");

{
  const testDir = path.join(__dirname, ".test-security");
  const testFile = path.join(testDir, "test.txt");
  try { fs.mkdirSync(testDir, { recursive: true }); } catch {}

  // Atomic write
  atomicWriteFile(testFile, "test-content", { mode: 0o600 });
  assert(fs.existsSync(testFile), "Atomic write creates file");
  assertEq(fs.readFileSync(testFile, "utf8"), "test-content", "Atomic write content correct");

  // Check permissions
  const stat = fs.statSync(testFile);
  assert((stat.mode & 0o777) === 0o600, "File permissions are 0o600");

  // Safe unlink
  assert(safeUnlink(testFile) === true, "Safe unlink returns true for existing file");
  assert(!fs.existsSync(testFile), "File deleted after safe unlink");
  assert(safeUnlink(testFile) === false, "Safe unlink returns false for non-existent file");

  // Cleanup
  try { fs.rmdirSync(testDir); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// 9. RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

section("Rate Limiter");

{
  const rl = new RateLimiter({
    readLimit: 5,
    writeLimit: 3,
    authFailLimit: 3,
    authBackoffBase: 1000,
    globalLimit: 100,
  });

  // Read rate limit
  for (let i = 0; i < 5; i++) {
    assert(rl.check("test-ip", "read").allowed, `Read ${i + 1}/5 allowed`);
  }
  assert(!rl.check("test-ip", "read").allowed, "Read 6/5 blocked");
  assert(rl.check("other-ip", "read").allowed, "Different IP not affected");

  // Write rate limit
  for (let i = 0; i < 3; i++) {
    assert(rl.check("test-ip2", "write").allowed, `Write ${i + 1}/3 allowed`);
  }
  assert(!rl.check("test-ip2", "write").allowed, "Write 4/3 blocked");

  // Auth failure tracking
  rl.recordAuthFailure("bad-ip");
  rl.recordAuthFailure("bad-ip");
  const result3 = rl.recordAuthFailure("bad-ip"); // 3rd failure
  assert(result3.blocked, "Blocked after 3 failures");
  assert(result3.retryAfter > 0, "retryAfter is positive");

  // Blocked check
  const blocked = rl.isAuthBlocked("bad-ip");
  assert(blocked.blocked, "isAuthBlocked returns blocked");

  // Clear auth failures
  rl.clearAuthFailures("bad-ip");
  assert(!rl.isAuthBlocked("bad-ip").blocked, "Auth failures cleared");

  // SSE limits
  assert(rl.checkSSE("session-1").allowed, "First SSE allowed");
  rl.trackSSE("session-1", +1);
  rl.trackSSE("session-1", +1);
  rl.trackSSE("session-1", +1);
  assert(!rl.checkSSE("session-1").allowed, "SSE 4/3 blocked per session");

  rl.trackSSE("session-1", -1);
  assert(rl.checkSSE("session-1").allowed, "SSE allowed after disconnect");

  rl.dispose();
}

// ═══════════════════════════════════════════════════════════════════
// 10. SECURE ERROR RESPONSES
// ═══════════════════════════════════════════════════════════════════

section("Secure Error Responses");

{
  // SecurityError
  const err = new SecurityError("INVALID_TICKET", "Bad ticket format", 400);
  assertEq(err.code, "INVALID_TICKET", "SecurityError code set");
  assertEq(err.statusCode, 400, "SecurityError status set");
  assertEq(err.message, "Bad ticket format", "SecurityError message set");
  assert(err instanceof Error, "SecurityError extends Error");

  // Error message sanitization
  assertEq(
    sanitizeErrorMessage("Error at /home/user/project/server/routes.js:42:15"),
    "Error at [path]",
    "File paths stripped from error messages"
  );
  assert(
    sanitizeErrorMessage("Failed with token ATATT3xAbcDefGhiJklMno12345==")
      .includes("[JIRA_TOKEN_REDACTED]"),
    "Credentials redacted from error messages"
  );
}

// ═══════════════════════════════════════════════════════════════════
// 11. HTML ESCAPING
// ═══════════════════════════════════════════════════════════════════

section("HTML Escaping");

{
  assertEq(escapeHtml('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    "XSS payload escaped");
  assertEq(escapeHtml("normal text"), "normal text", "Normal text unchanged");
  assertEq(escapeHtml("a'b"), "a&#x27;b", "Single quotes escaped");
  assertEq(escapeHtml("a&b"), "a&amp;b", "Ampersand escaped");
}

// ═══════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════

console.log(`\n  ═══════════════════════════════════════`);
console.log(`    Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log(`  ═══════════════════════════════════════`);

if (failed > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) {
    console.log(`    - ${f}`);
  }
  process.exit(1);
} else {
  console.log(`\n  All tests passed.\n`);
}

// Clean up token file created by tests
try {
  const tokenFile = path.join(__dirname, ".api-token");
  if (fs.existsSync(tokenFile)) {
    // Don't delete if it existed before — but in tests this is fine
  }
} catch {}
