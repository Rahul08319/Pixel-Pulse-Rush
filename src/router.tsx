import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  // Dynamically resolve basepath when served from GitHub Pages subfolder (e.g. /Pixel-Pulse-Rush/)
  let basepath: string | undefined = undefined;
  if (typeof window !== "undefined") {
    const match = window.location.pathname.match(/^(\/[^/]+)/);
    if (match && /pixel-pulse-rush/i.test(match[1])) {
      basepath = match[1];
    }
  }

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    basepath,
  });

  return router;
};
