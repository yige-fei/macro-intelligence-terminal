"use client";

// Adapted from OpenTerminal web/app/providers.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { isNotIncluded } from "../lib/api";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: (count, error) => !isNotIncluded(error) && count < 1, // T4-P1: absent datasets are final, not retried
            staleTime: 10_000,
          },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
