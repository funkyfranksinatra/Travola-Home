// tests/settings-prefs.test.ts — the shared preferences blob.
//
// `RestaurantSettings.prefs` is ONE json column belonging to three apps.
// A whole-object write from Travola Home would silently reset the floor
// manager's tour state, auto-assign flag and alert settings — a bug
// nobody would connect to having changed the turn time on another screen.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergePrefs } from "../lib/settings-prefs.ts";

/** What production actually holds, abbreviated. */
const FLOOR_APP_PREFS = {
  tours: { host: { floor: true, service: true }, manager: { floor: true } },
  daysOpen: [true, false, true, true, true, true, true],
  location: { lat: "39.9197758", lon: "-105.7904009", name: "Volario's", address: "", timeZone: "America/Denver" },
  teamView: false,
  turnTime: "90",
  resBuffer: "0",
  autoAssign: true,
  holdWindow: "15",
  largeParty: "10",
  emailDigest: true,
  soundAlerts: false,
  confirmSeating: false,
};

test("editing one field leaves every key Travola Home does not own untouched", () => {
  const merged = mergePrefs(FLOOR_APP_PREFS, { turnMinutes: 105 });
  assert.equal(merged.turnTime, "105");
  assert.deepEqual(merged.tours, FLOOR_APP_PREFS.tours, "the floor app's tour state must survive");
  assert.equal(merged.autoAssign, true);
  assert.equal(merged.teamView, false);
  assert.equal(merged.emailDigest, true);
  assert.equal(merged.soundAlerts, false);
  assert.equal(merged.confirmSeating, false);
});

test("the location object is merged, not swapped", () => {
  const merged = mergePrefs(FLOOR_APP_PREFS, { timeZone: "America/Chicago" });
  const location = merged.location as Record<string, unknown>;
  assert.equal(location.timeZone, "America/Chicago");
  // Latitude and longitude are what the weekly forecast researches
  // weather against; losing them silently degrades the forecast.
  assert.equal(location.lat, "39.9197758");
  assert.equal(location.lon, "-105.7904009");
  assert.equal(location.name, "Volario's");
});

test("numbers are stored as the strings the floor app expects, and clamped", () => {
  assert.equal(mergePrefs({}, { turnMinutes: 105 }).turnTime, "105", "string, not number");
  assert.equal(mergePrefs({}, { turnMinutes: 5 }).turnTime, "15", "clamped up to the floor");
  assert.equal(mergePrefs({}, { turnMinutes: 9999 }).turnTime, "360", "clamped down to the ceiling");
  assert.equal(mergePrefs({}, { largePartySize: 2 }).largeParty, "4");
  assert.equal(mergePrefs({}, { holdWindowMinutes: 0 }).holdWindow, "0", "zero is a real value");
  assert.equal(mergePrefs({}, { reservationBufferMinutes: 0 }).resBuffer, "0");
});

test("junk is ignored rather than written", () => {
  const merged = mergePrefs(FLOOR_APP_PREFS, { turnMinutes: "not a number" });
  assert.equal(merged.turnTime, "90", "the existing value survives");
  // A short array is not a week and must not overwrite the real one.
  assert.deepEqual(
    mergePrefs(FLOOR_APP_PREFS, { daysOpen: [true, true] }).daysOpen,
    FLOOR_APP_PREFS.daysOpen,
  );
});

test("days open are coerced to real booleans", () => {
  const merged = mergePrefs({}, { daysOpen: [true, "yes", 1, null, false, true, true] as never });
  assert.deepEqual(merged.daysOpen, [true, false, false, false, false, true, true]);
});

test("an empty starting blob is fine", () => {
  const merged = mergePrefs(null, { timeZone: "UTC", turnMinutes: 90 });
  assert.equal((merged.location as Record<string, unknown>).timeZone, "UTC");
  assert.equal(merged.turnTime, "90");
});
