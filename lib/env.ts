// lib/env.ts — fail loudly, and in English, when configuration is missing.
//
// The failure this exists to prevent: with no DATABASE_URL, the Postgres
// driver quietly falls back to 127.0.0.1:5432, Prisma spends its timeout
// dialling a database that was never there, and the user sees a generic
// "that did not work" on the sign-in screen. The cause (an env var that
// was never set on the deployment) is nowhere in that message, so the
// natural conclusion is that the password is wrong.
//
// A configuration mistake should name itself.

export type ConfigProblem = { key: string; detail: string; fix: string };

/** Everything the app needs to serve a request, checked at call time. */
export function configProblems(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    problems.push({
      key: "DATABASE_URL",
      detail: "No database connection string is configured.",
      fix: "Set DATABASE_URL on this deployment to the same Neon connection string the floor manager and the POS use.",
    });
  } else if (/localhost|127\.0\.0\.1|placeholder/i.test(databaseUrl)) {
    // The build-time placeholder in prisma.config.ts exists so
    // `prisma generate` can run without a database. If it ever reaches
    // the runtime it means the real value is missing.
    problems.push({
      key: "DATABASE_URL",
      detail: "The database connection string is still the local build placeholder.",
      fix: "Set DATABASE_URL on this deployment to the same Neon connection string the floor manager and the POS use.",
    });
  }

  if (!process.env.SESSION_SECRET) {
    problems.push({
      key: "SESSION_SECRET",
      detail: "No session secret is configured, so nobody can be signed in.",
      fix: "Set SESSION_SECRET to the exact value used by the floor manager and the POS. It must match byte for byte.",
    });
  }

  return problems;
}

/**
 * A single sentence to show a signed-out user, or null when the app is
 * configured. Deliberately says what is wrong and where to fix it: the
 * person hitting this screen is the person who can fix it.
 */
export function configMessage(): string | null {
  const problems = configProblems();
  if (!problems.length) return null;
  const keys = problems.map((p) => p.key).join(" and ");
  return `This deployment is missing ${keys}. ${problems.map((p) => p.fix).join(" ")}`;
}

/**
 * Turn an infrastructure failure into a sentence the reader can act on.
 * A screen that answers "something went wrong" when the real problem is
 * an unset environment variable sends the user off to check a password
 * that was never wrong.
 */
export function operationalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  if (code === "P1001" || /reach database server|DatabaseNotReachable/i.test(message)) {
    return "The Console cannot reach the database. If this deployment is new, DATABASE_URL is probably not set on it yet — it needs the same Neon connection string as the floor manager and the POS.";
  }
  if (/SESSION_SECRET/i.test(message)) {
    return "The Console has no SESSION_SECRET configured, so it cannot sign anyone in. Set it to the same value the floor manager and the POS use.";
  }
  if (/DATABASE_URL/i.test(message)) return message;
  return "Something went wrong. The deployment logs will have the detail.";
}
