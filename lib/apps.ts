// lib/apps.ts — where the other two fragments of Travola live.
//
// These are PLATFORM facts, not per-restaurant configuration. Every
// restaurant's floor manager and POS are the same two deployments; what
// separates one restaurant from another is the signed-in tenant, not the
// URL. Asking an owner to paste a URL would be asking them to configure
// something that is identical for every customer and that they have no
// way of knowing.
//
// So the addresses are built in, and the env vars exist only as an
// override — for a preview deployment, a self-hosted install, or the day
// a custom domain lands. Nothing has to be set for the launcher to work.
//
// When onboarding is wired up end to end, this is the file that hands a
// new restaurant its two links after it is created.

export type TravolaApp = {
  key: "floor" | "pos";
  name: string;
  hint: string;
  url: string;
  /** True when an env var overrode the built-in address. */
  overridden: boolean;
};

const DEFAULTS = {
  floor: "https://travola-os-tablai.vercel.app",
  pos: "https://pos.travola.app",
} as const;

function resolve(key: keyof typeof DEFAULTS, override: string | undefined) {
  const trimmed = (override ?? "").trim();
  // A malformed override must not silently produce a dead link; fall back
  // to the address that is known to work.
  if (trimmed) {
    try {
      return { url: new URL(trimmed).origin + new URL(trimmed).pathname.replace(/\/$/, ""), overridden: true };
    } catch {
      console.warn(`[apps] ignoring malformed ${key} URL override: ${trimmed}`);
    }
  }
  return { url: DEFAULTS[key], overridden: false };
}

export function travolaApps(): TravolaApp[] {
  const floor = resolve("floor", process.env.NEXT_PUBLIC_FLOOR_URL);
  const pos = resolve("pos", process.env.NEXT_PUBLIC_POS_URL);
  return [
    { key: "floor", name: "Floor manager", hint: "Reservations, waitlist, sections", ...floor },
    { key: "pos", name: "POS", hint: "Orders, kitchen, checks", ...pos },
  ];
}

/** `{ floor, pos }`, the shape the client components take. */
export function appLinks() {
  const apps = travolaApps();
  return {
    floor: apps.find((app) => app.key === "floor")!.url,
    pos: apps.find((app) => app.key === "pos")!.url,
  };
}
