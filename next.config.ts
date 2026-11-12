import type { NextConfig } from "next";

// OCR language data (~12 MB) only for routes that can read images (captures, imports, the job runner, the assistant).
const OCR_DATA = ["./node_modules/@tesseract.js-data/eng/4.0.0/**", "./node_modules/@tesseract.js-data/hin/4.0.0/**"];
const nextConfig: NextConfig = {
  /* config options here */
  // Every page is per-user and permission-filtered (RLS), so pages render dynamically; no Cache Components.
  // pptxgenjs is bundled, not external: its ESM build is a .js file without "type": "module", which the
  // Vercel Node runtime refuses to import ("Cannot use import statement outside a module").
  // tesseract.js (local OCR) spawns a worker_threads script from its own folder, so it must stay a real node_modules package.
  serverExternalPackages: ["exceljs", "docx", "tesseract.js", "tesseract.js-core", "@tesseract.js-data/eng", "@tesseract.js-data/hin"],
  // Local OCR language data is read from disk (no CDN): trace the gzipped eng/hin models into the serverless functions.
  outputFileTracingIncludes: {
    "/capture/**": OCR_DATA,
    "/api/v1/captures/**": OCR_DATA,
    "/imports/**": OCR_DATA,
    "/api/v1/imports/**": OCR_DATA,
    "/api/cron/tick": OCR_DATA,
    "/api/v1/assistant/**": OCR_DATA,
    "/assistant/**": OCR_DATA,
    "/toolkit/**": OCR_DATA,
  },
  // `npm run fast` on low-memory PCs skips the build-time type check (run `npx tsc --noEmit` separately). Vercel still checks.
  typescript: { ignoreBuildErrors: process.env.SKIP_TYPECHECK === "1" },
  // LinkedIn Connections.csv uploads go through a server action (up to 5 MB).
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
    // Small build hosts (Render free) get OOM-killed with one worker per CPU.
    ...(process.env.RENDER ? { cpus: 2, workerThreads: false } : {}),
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
