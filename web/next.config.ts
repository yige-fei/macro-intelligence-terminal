import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Adapted from OpenTerminal web/next.config.ts (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root): the upstream standalone server and
// /api proxy are not used. This build is a static export served from a loopback-only static server.

// Build identity: the source id is the SHA-256 of this folder's file hash list (lines `<sha256>  ./<path>`, build outputs
// and dependencies excluded), so identical sources give the same id in any clone. BUILD_TIME_UTC, when set, fixes the
// displayed build time.
const SKIP = new Set(["node_modules", ".next", "out", "tsconfig.tsbuildinfo", ".DS_Store"]);
function files(dir: string, rel = "."): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    SKIP.has(d.name) ? [] : d.isDirectory() ? files(join(dir, d.name), `${rel}/${d.name}`) : [`${rel}/${d.name}`]);
}
const root = process.cwd();
const list = files(root).sort().map((f) => `${createHash("sha256").update(readFileSync(join(root, f))).digest("hex")}  ${f}\n`).join("");
const SOURCE_SHA256 = createHash("sha256").update(list).digest("hex");
const BUILD_TIME_UTC = process.env.BUILD_TIME_UTC ?? new Date().toISOString().slice(0, 19) + "Z";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  generateBuildId: async () => SOURCE_SHA256.slice(0, 20),
  env: {
    NEXT_PUBLIC_BUILD_SOURCE_SHA256: SOURCE_SHA256,
    NEXT_PUBLIC_BUILD_TIME_UTC: BUILD_TIME_UTC,
    // Data mode (lib/api.ts). "demo" (default): the simulated market bars, illustrative research figures and their
    // manifest, served by `python3 -m terminal_demo.serve` from demo-data/. "excluded": release-desk metadata only.
    NEXT_PUBLIC_HISTORICAL_DATA: process.env.TERMINAL_DATA_MODE === "excluded" ? "excluded" : "demo",
  },
};

export default nextConfig;
