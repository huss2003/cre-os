import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Every page is per-user and permission-filtered (RLS), so pages render dynamically; no Cache Components.
  serverExternalPackages: ["exceljs", "pptxgenjs", "docx"],
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
