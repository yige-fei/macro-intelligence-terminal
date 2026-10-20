// T2-G1: workspace navigation held in the URL (?ws=…) of the single static page, so refresh, deep links and
// browser back/forward work on any static server. Navigation never touches browser storage.

// T3-I v1: "macro" added (Release Schedule); the other ids and their behaviour are unchanged.
// T4-P1: "settings" added (read-only Settings & About page).
export type WorkspaceId = "home" | "macro" | "market" | "research" | "settings";
const IDS: readonly WorkspaceId[] = ["home", "macro", "market", "research", "settings"];

/** Fired after navigate() changes the URL (popstate covers back/forward). */
export const WORKSPACE_EVENT = "workspace-change";

export function readWorkspace(): WorkspaceId {
  const v = new URLSearchParams(window.location.search).get("ws");
  return (IDS as readonly string[]).includes(v ?? "") ? (v as WorkspaceId) : "home";
}

export function hrefFor(ws: WorkspaceId): string {
  return ws === "home" ? window.location.pathname : `${window.location.pathname}?ws=${ws}`;
}

/** One-shot request carried with a navigation, not stored in the URL (a refresh does not repeat it). */
export type NavIntent = "focus-macro";
let pendingIntent: NavIntent | null = null;

export function navigate(ws: WorkspaceId, intent?: NavIntent) {
  pendingIntent = intent ?? null;
  if (readWorkspace() !== ws) window.history.pushState(null, "", hrefFor(ws));
  window.dispatchEvent(new Event(WORKSPACE_EVENT));
}

export function takeIntent(): NavIntent | null {
  const i = pendingIntent;
  pendingIntent = null;
  return i;
}
