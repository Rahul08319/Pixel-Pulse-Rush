import { createFileRoute } from "@tanstack/react-router";
import PixelPulseRush from "@/components/PixelPulseRush";

export const Route = createFileRoute("/$")({
  head: () => ({
    meta: [
      { title: "Pixel Pulse Rush — Neon Arcade Rhythm Game" },
      {
        name: "description",
        content:
          "Tap to the beat as neon pixel blocks cascade in sync with a procedurally generated chiptune. Every run is unique.",
      },
      { property: "og:title", content: "Pixel Pulse Rush" },
      {
        property: "og:description",
        content:
          "High-speed 4-lane retro arcade rhythm game featuring procedural chiptune audio synthesis and pure tactile mechanics.",
      },
    ],
  }),
  component: PixelPulseRush,
});
