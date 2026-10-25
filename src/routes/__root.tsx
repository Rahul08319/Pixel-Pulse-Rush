import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import PixelPulseRush from "@/components/PixelPulseRush";

function NotFoundComponent() {
  // Pure arcade machine fallback: always render the arcade game regardless of subfolder or path
  return <PixelPulseRush />;
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center apple-glass-card p-8">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Game Runtime Interrupted
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A game engine error occurred. You can restart or return to the main arcade lobby.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="apple-interactive inline-flex items-center justify-center rounded-xl bg-[var(--color-apple-blue)] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20"
          >
            Restart Game
          </button>
          <a
            href="./"
            className="apple-interactive inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-medium text-foreground hover:bg-white/15"
          >
            Arcade Lobby
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" },
      { title: "Pixel Pulse Rush — Neon Arcade Rhythm Game" },
      {
        name: "description",
        content:
          "High-speed neon arcade rhythm game featuring procedural chiptune audio, Apple Liquid Glass aesthetic, and real-time TypeSafe AI System One routing.",
      },
      { property: "og:title", content: "Pixel Pulse Rush — Neon Arcade Rhythm Game" },
      {
        property: "og:description",
        content:
          "High-speed neon arcade rhythm game featuring procedural chiptune audio, Apple Liquid Glass aesthetic, and real-time TypeSafe AI System One routing.",
      },
      { property: "og:type", content: "game" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "theme-color", content: "#06040d" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script src="https://www.youtube.com/game_api/v1" async={false} />
        <HeadContent />
      </head>
      <body suppressHydrationWarning className="antialiased selection:bg-[var(--neon-pink)] selection:text-black overflow-hidden bg-[#06040d]">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}
