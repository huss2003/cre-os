// Preload for scripts/assistant-evals.ts: lets "server-only" modules load outside Next.js (same stub vitest uses).
const Module = require("node:module");
const path = require("node:path");
const stub = path.join(__dirname, "assistant-evals.server-only-stub.cjs");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  return orig.call(this, request, ...rest);
};
