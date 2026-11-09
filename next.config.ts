import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Every page is per-user and permission-filtered (RLS), so pages render dynamically; no Cache Components.
  // pptxgenjs is bundled, not external: its ESM build is a .js file without "type": "module", which the
  // Vercel Node runtime refuses to import ("Cannot use import statement outside a module").
  serverExternalPackages: ["exceljs", "docx"],
  // LinkedIn Connections.csv uploads go through a server action (up to 5 MB).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
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
