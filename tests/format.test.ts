// tests/format.test.ts — the rule that a missing number never prints as zero.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DASH, dateLabel, decimal, delta, formatMetric, integer, minutes, money, percent, periodLabel, shortDate } from "../lib/format.ts";
import type { Metric } from "../lib/analytics/types.ts";

const metric = (over: Partial<Metric>): Metric => ({
  key: "k", label: "L", group: "volume", unit: "count", value: null, available: "ready", ...over,
});

test("null renders as a dash, never as zero", () => {
  assert.equal(money(null), DASH);
  assert.equal(integer(null), DASH);
  assert.equal(percent(null), DASH);
  assert.equal(minutes(null), DASH);
  assert.equal(decimal(null), DASH);
  assert.equal(delta(null), DASH);
  assert.equal(formatMetric(metric({ value: null, unit: "cents" })), DASH);
  // Zero is a real value and must still print as zero.
  assert.equal(money(0), "$0.00");
  assert.equal(integer(0), "0");
});

test("money switches off cents only for large figures", () => {
  assert.equal(money(1234), "$12.34");
  assert.equal(money(99999), "$999.99");
  assert.equal(money(100000), "$1,000");
  assert.equal(money(12345678), "$123,457");
  assert.equal(money(-1250), "-$12.50");
});

test("minutes become hours past the hour mark", () => {
  // The separator is a non-breaking space on purpose: "45" and "min"
  // must not be split across a line inside a narrow metric card.
  assert.equal(minutes(45), "45\u00A0min");
  assert.equal(minutes(59), "59\u00A0min");
  assert.equal(minutes(60), "1h");
  assert.equal(minutes(95), "1h\u00A035m");
  assert.equal(minutes(-20), "-20\u00A0min", "a negative pace figure stays readable");
});

test("delta carries an explicit sign and a real minus glyph", () => {
  assert.equal(delta(12.34), "+12.3%");
  assert.equal(delta(-3), "−3.0%");
  assert.equal(delta(0), "0.0%");
});

test("metric formatting follows the unit", () => {
  assert.equal(formatMetric(metric({ unit: "cents", value: 4599 })), "$45.99");
  assert.equal(formatMetric(metric({ unit: "percent", value: 12.345 })), "12.3%");
  assert.equal(formatMetric(metric({ unit: "minutes", value: 92 })), "1h\u00A032m");
  assert.equal(formatMetric(metric({ unit: "count", value: 16439 })), "16,439");
  assert.equal(formatMetric(metric({ unit: "text", value: "6 pm" })), "6 pm");
  // Average party size keeps a decimal; other people-counts do not.
  assert.equal(formatMetric(metric({ key: "avg_party", unit: "people", value: 3.87 })), "3.9");
  assert.equal(formatMetric(metric({ key: "covers", unit: "people", value: 6900 })), "6,900");
});

test("dates render in UTC so a service day never slips by one", () => {
  assert.equal(dateLabel("2026-08-03"), "Mon, Aug 3, 2026");
  assert.equal(shortDate("2026-01-01"), "Jan 1");
  assert.equal(dateLabel("nonsense"), "nonsense");
  assert.equal(periodLabel("DINNER"), "Dinner");
});

// ── Configuration diagnostics ─────────────────────────────────────────
// Regression cover for the deployment that answered "That did not work."
// on the sign-in screen when the real problem was an unset DATABASE_URL,
// sending the user to check a password that was never wrong.
import { configProblems, configMessage, operationalError } from "../lib/env.ts";

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a missing DATABASE_URL is reported as a missing DATABASE_URL", () => {
  withEnv({ DATABASE_URL: undefined, SESSION_SECRET: "x" }, () => {
    const problems = configProblems();
    assert.equal(problems.length, 1);
    assert.equal(problems[0].key, "DATABASE_URL");
    assert.match(configMessage() ?? "", /DATABASE_URL/);
  });
});

test("the build placeholder connection string counts as missing", () => {
  // prisma.config.ts supplies a localhost placeholder so `prisma
  // generate` can run without a database. If it survives to runtime the
  // real value was never set, and the driver would otherwise dial
  // 127.0.0.1 and blame the database.
  withEnv({ DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder", SESSION_SECRET: "x" }, () => {
    assert.equal(configProblems().length, 1);
    assert.match(configMessage() ?? "", /DATABASE_URL/);
  });
});

test("a real connection string with a session secret is clean", () => {
  withEnv({ DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=verify-full", SESSION_SECRET: "x" }, () => {
    assert.deepEqual(configProblems(), []);
    assert.equal(configMessage(), null);
  });
});

test("both missing variables are named, not just the first", () => {
  withEnv({ DATABASE_URL: undefined, SESSION_SECRET: undefined }, () => {
    const message = configMessage() ?? "";
    assert.match(message, /DATABASE_URL/);
    assert.match(message, /SESSION_SECRET/);
  });
});

test("Prisma's unreachable-database error points at the env var, not the database", () => {
  const error = Object.assign(new Error("Can't reach database server at 127.0.0.1:5432"), { code: "P1001" });
  assert.match(operationalError(error), /DATABASE_URL/);
  assert.match(operationalError(new Error("DriverAdapterError: DatabaseNotReachable")), /DATABASE_URL/);
  assert.match(
    operationalError(new Error("SESSION_SECRET is required to use restaurant sessions.")),
    /SESSION_SECRET/,
  );
});

test("an unrecognised failure does not pretend to diagnose itself", () => {
  const message = operationalError(new Error("something exploded"));
  assert.doesNotMatch(message, /DATABASE_URL|SESSION_SECRET/);
  assert.match(message, /logs/);
});

test("a local development database is not mistaken for the placeholder", () => {
  // An earlier version of this check rejected any localhost URL, which
  // called every developer's local Postgres a misconfiguration.
  withEnv({ DATABASE_URL: "postgresql://postgres@localhost:5432/travola_dev", SESSION_SECRET: "x" }, () => {
    assert.deepEqual(configProblems(), [], "a local dev database is a real database");
  });
  withEnv({ DATABASE_URL: "postgresql://postgres@localhost:5433/console_test?host=/tmp/pgsock", SESSION_SECRET: "x" }, () => {
    assert.deepEqual(configProblems(), []);
  });
  withEnv({ DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder", SESSION_SECRET: "x" }, () => {
    assert.equal(configProblems().length, 1, "but the build placeholder is still caught");
  });
});
