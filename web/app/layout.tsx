import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

// Adapted from OpenTerminal web/app/layout.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root).
export const metadata: Metadata = {
  title: "Macro Intelligence Terminal",
  description: "Local portfolio demo: official release metadata, simulated market data; not live, no trading signals",
};

// T4-P1: load-failure notice. If an application script fails to load (T1 closure: a chunk request reset by the local
// static server left a black page with no message), the app never starts. This notice is plain HTML with inline CSS,
// so it needs no script or stylesheet: it becomes visible after 8 s unless AppShell has marked <html data-app-ready>.
const BOOT_CSS = `
#t4-boot-fallback{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:12px 16px;background:#1a1200;color:#f2f2f2;
border-top:1px solid #ff9f1a;font:13px/1.5 ui-monospace,Menlo,monospace;opacity:0;visibility:hidden;animation:t4-boot-show 0s linear 8s forwards}
#t4-boot-fallback a{color:#ff9f1a;display:inline-block;text-decoration:underline}
html[data-app-ready] #t4-boot-fallback{display:none}
@keyframes t4-boot-show{to{opacity:1;visibility:visible}}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style dangerouslySetInnerHTML={{ __html: BOOT_CSS }} />
        <div id="t4-boot-fallback" role="alert">
          <b>Macro Intelligence Terminal did not finish loading.</b> A script file may have failed to load from the local
          server. Check that the local server is still running, then <a href="">reload this page</a>.
        </div>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
