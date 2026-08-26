// lib/settings-prefs.ts — merging the shared preferences blob.
//
// `RestaurantSettings.prefs` is one JSON column shared by three apps. It
// carries the floor app's tour state, auto-assign flag, sound alerts and
// more alongside the handful of fields Travola Home edits. Writing it as a
// whole object would silently reset every setting a manager had chosen in
// the floor manager — a bug nobody would connect to having changed the
// turn time on a different screen.
//
// Extracted from the route so the guarantee is testable rather than
// asserted in a comment.

export type Prefs = Record<string, unknown>;

export type PrefEdits = {
  daysOpen?: unknown;
  timeZone?: string;
  address?: string;
  locationName?: string;
  turnMinutes?: unknown;
  largePartySize?: unknown;
  holdWindowMinutes?: unknown;
  reservationBufferMinutes?: unknown;
};

/** The floor app stores these as strings; keep the shape it expects. */
function bounded(value: unknown, low: number, high: number): string | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return String(Math.round(Math.max(low, Math.min(high, parsed))));
}

/**
 * Apply Travola Home's edits on top of the existing blob, leaving every
 * key it does not own exactly as it found it.
 */
export function mergePrefs(existing: Prefs | null | undefined, edits: PrefEdits): Prefs {
  const prefs: Prefs = { ...(existing ?? {}) };
  const location: Prefs = { ...((prefs.location as Prefs) ?? {}) };

  if (Array.isArray(edits.daysOpen) && edits.daysOpen.length === 7) {
    prefs.daysOpen = edits.daysOpen.map((value) => value === true);
  }
  if (edits.timeZone !== undefined) location.timeZone = edits.timeZone;
  if (typeof edits.address === "string") location.address = edits.address.trim().slice(0, 300);
  if (typeof edits.locationName === "string") location.name = edits.locationName.trim().slice(0, 160);
  prefs.location = location;

  const set = (key: string, value: unknown, low: number, high: number) => {
    if (value === undefined) return;
    const next = bounded(value, low, high);
    if (next !== undefined) prefs[key] = next;
  };
  set("turnTime", edits.turnMinutes, 15, 360);
  set("largeParty", edits.largePartySize, 4, 40);
  set("holdWindow", edits.holdWindowMinutes, 0, 120);
  set("resBuffer", edits.reservationBufferMinutes, 0, 120);

  return prefs;
}
