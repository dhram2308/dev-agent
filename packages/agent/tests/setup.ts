// Register tsx's CommonJS hook so bare `require('./foo')` calls inside
// source files resolve `foo.ts` at runtime. Vitest transforms top-level
// imports via vite, but agents-team.ts and friends use CJS `require()`
// with extensionless specifiers that Node's built-in resolver cannot
// handle for .ts files.
require('tsx/cjs');
