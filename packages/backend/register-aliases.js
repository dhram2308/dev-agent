/**
 * Register @shared and @native path aliases for runtime resolution.
 * TypeScript `paths` only work at compile/check time; Node.js needs this hook.
 *
 * Usage: require('./register-aliases') before any other imports.
 */
"use strict";

const path = require("path");
const Module = require("module");

const aliases = {
  "@shared": path.resolve(__dirname, "..", "shared", "dist"),
  "@native": path.resolve(__dirname, "..", "native"),
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  for (const [alias, target] of Object.entries(aliases)) {
    if (request === alias || request.startsWith(alias + "/")) {
      const resolved = request.replace(alias, target);
      return originalResolve.call(this, resolved, parent, isMain, options);
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
