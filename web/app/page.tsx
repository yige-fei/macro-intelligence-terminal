"use client";

// Adapted from OpenTerminal web/app/page.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root).
import dynamic from "next/dynamic";

// T2-G1: the page renders the application shell (Home by default); the Terminal is one of its workspaces.
const AppShell = dynamic(() => import("../components/AppShell"), { ssr: false });

export default function Home() {
  return <AppShell />;
}
