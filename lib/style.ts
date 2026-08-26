// lib/style.ts — which of the three visual treatments this browser gets.
//
// The Console ships all three (see app/globals.css) so the design can be
// chosen by looking at real data on a real screen rather than at a mockup.
// The choice is a cookie, so switching is instant and per-device; the
// default comes from an env var so a decision can be made permanent
// without a code change. Once the design is settled, deleting the two
// unused blocks in globals.css and this file is a five-minute cleanup.
export const STYLES = ["ledger", "brief", "console"] as const;
export type StyleKey = (typeof STYLES)[number];

export const STYLE_COOKIE = "travola_console_style";

export const STYLE_META: Record<StyleKey, { name: string; blurb: string }> = {
  ledger: {
    name: "Ledger",
    blurb: "Dense and hairline-ruled, monospaced figures, built for scanning long history. Closest to an OpenTable back-office.",
  },
  brief: {
    name: "Brief",
    blurb: "Editorial and airy. Large headline numbers, room around the charts. Reads like a weekly report you would forward to a partner.",
  },
  console: {
    name: "Console",
    blurb: "The operator's view. Raised panels and mono labels, matching the POS floor screen for a manager moving between the two.",
  },
};

export function resolveStyle(value?: string | null): StyleKey {
  const candidate = (value ?? process.env.NEXT_PUBLIC_CONSOLE_STYLE ?? "").trim();
  return (STYLES as readonly string[]).includes(candidate) ? (candidate as StyleKey) : "ledger";
}
