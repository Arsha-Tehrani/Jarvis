import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3: native addon, must not be bundled.
  // pdf-parse/pdfjs-dist: pdfjs resolves its worker (pdf.worker.mjs) relative
  // to its own file at runtime. Bundled into .next/chunks that sibling is
  // missing ("Setting up fake worker failed"), so PDF statement parsing dies.
  // Externalizing keeps it in node_modules where the worker lives.
  serverExternalPackages: ["better-sqlite3", "pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
