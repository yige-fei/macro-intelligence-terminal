// T4-P1: frontend build identity, set at build time by next.config.ts (never a dataset or retrieval time).
//   sourceSha256 — SHA-256 of this build's source hash list (re-derivable from the preserved source list)
//   builtUtc     — when this frontend was built

export const PRODUCT_NAME = "Macro Intelligence Terminal";

export const BUILD = {
  sourceSha256: process.env.NEXT_PUBLIC_BUILD_SOURCE_SHA256 ?? "",
  builtUtc: process.env.NEXT_PUBLIC_BUILD_TIME_UTC ?? "",
};

/** 'build 1a2b3c4d5e6f · 2026-10-18 09:12Z', or only what is known. */
export function buildLabel(): string {
  const id = BUILD.sourceSha256 ? `build ${BUILD.sourceSha256.slice(0, 12)}` : "build id unavailable";
  return BUILD.builtUtc ? `${id} · ${BUILD.builtUtc.slice(0, 10)} ${BUILD.builtUtc.slice(11, 16)}Z` : id;
}
