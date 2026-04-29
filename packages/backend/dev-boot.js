#!/usr/bin/env node
"use strict";

// Dev-only boot. Runs the backend TS-native via tsx — no compilation of
// shared/ or agent/ needed. Prod uses boot.js (unchanged) which loads
// compiled dist/.
//
// Strategy: install a Module._resolveFilename hook BEFORE requiring
// http-server. The hook rewrites every request that would hit a built
// artifact (agent/dist, shared/dist) to the corresponding TS source.
// tsx then transpiles those .ts files on the fly.
//
// Prod code path (boot.js + register-aliases.js) is untouched.

const path = require("path");
const Module = require("module");

const AGENT_SRC  = path.resolve(__dirname, "..", "agent",  "src");
const SHARED_SRC = path.resolve(__dirname, "..", "shared", "src");
const NATIVE_DIR = path.resolve(__dirname, "..", "native");

// Strip a trailing .js extension from a captured subpath so that
// `require('@mi/agent/dist/lib/foo.js')` still lands on `lib/foo.ts`.
const stripJs = (s) => s.replace(/\.js$/, "");

function rewrite(request) {
  // @mi/agent (workspace package) → agent/src
  if (request === "@mi/agent") return path.join(AGENT_SRC, "index");
  let m = request.match(/^@mi\/agent\/dist\/(.+)$/);
  if (m) return path.join(AGENT_SRC, stripJs(m[1]));
  m = request.match(/^@mi\/agent\/(.+)$/);
  if (m) return path.join(AGENT_SRC, stripJs(m[1]));

  // @mi/shared (workspace package) → shared/src
  if (request === "@mi/shared") return path.join(SHARED_SRC, "index");
  m = request.match(/^@mi\/shared\/(.+)$/);
  if (m) return path.join(SHARED_SRC, stripJs(m[1]));

  // Relative `.../agent/dist/...` requires from backend src → agent/src.
  // Must stay relative so Node resolves against the caller's directory.
  if (request.includes("/agent/dist/")) {
    return request.replace("/agent/dist/", "/agent/src/");
  }

  // @shared/* path alias (tsconfig paths) → shared/src. In dev we prefer
  // src so no shared build is needed; in prod this hook never runs.
  if (request === "@shared") return path.join(SHARED_SRC, "index");
  m = request.match(/^@shared\/(.+)$/);
  if (m) return path.join(SHARED_SRC, m[1]);

  // @native/* path alias → packages/native (no dist, pure JS).
  if (request === "@native") return path.join(NATIVE_DIR, "index");
  m = request.match(/^@native\/(.+)$/);
  if (m) return path.join(NATIVE_DIR, m[1]);

  return request;
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  const next = typeof request === "string" ? rewrite(request) : request;
  return originalResolve.call(this, next, parent, isMain, options);
};

require("./src/server/http-server").startServer();