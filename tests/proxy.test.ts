// tests/proxy.test.ts — the redirect helper must never be why a page 500s.
//
// Regression cover for a deployment where sign-in worked and then every
// page returned Internal Server Error. `/login` and `/api/auth` sit
// outside the matcher, so the first request ever to reach the proxy was
// the redirect to `/` after a successful sign-in — and it threw
// "SESSION_SECRET is required", because middleware bundles bake
// environment values in at BUILD time while route handlers read them at
// request time. A secret added after the last build is visible to one
// and not the other.
//
// The fix is that the proxy no longer reads the secret at all. These
// tests hold that line.
import { strict as assert } from "node:assert";
import { test } from "node:test";

/** A NextRequest-shaped stand-in: only what the proxy actually touches. */
function fakeRequest(cookieValue?: string) {
  return {
    url: "https://console.travola.app/analysis",
    cookies: { get: (name: string) => (cookieValue && name === "travola_home_session" ? { value: cookieValue } : undefined) },
    nextUrl: new URL("https://console.travola.app/analysis"),
  } as never;
}

async function loadProxy(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // Cache-busted so module-scope evaluation is re-run under this env.
    const module = await import(`../proxy.ts?case=${Object.values(env).join("-")}-${Math.random()}`);
    return module.proxy as (request: never) => { status: number; headers: Headers };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("with no SESSION_SECRET the proxy still answers instead of throwing", async () => {
  const proxy = await loadProxy({ SESSION_SECRET: undefined });
  // This is the exact condition that produced Internal Server Error on
  // every page of a deployment that could sign people in perfectly well.
  assert.doesNotThrow(() => proxy(fakeRequest("anything.anything")));
  assert.doesNotThrow(() => proxy(fakeRequest(undefined)));
});

test("a request carrying a session cookie is let through", async () => {
  const proxy = await loadProxy({ SESSION_SECRET: "a-real-secret" });
  const response = proxy(fakeRequest("payload.signature"));
  assert.equal(response.status, 200, "let through, not redirected");
});

test("a request with no cookie is redirected to the sign-in screen", async () => {
  const proxy = await loadProxy({ SESSION_SECRET: "a-real-secret" });
  const response = proxy(fakeRequest(undefined));
  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /\/login$/);
});

test("a forged cookie gets past the redirect, which is fine and intended", async () => {
  // The proxy checks presence, not signature. The layout and every API
  // route verify properly, so a forged cookie reaches a page that
  // immediately bounces it — it never reads anything.
  const proxy = await loadProxy({ SESSION_SECRET: "a-real-secret" });
  assert.equal(proxy(fakeRequest("not.a.real.signature")).status, 200);
});

test("the matcher covers the signed-in pages and nothing that must stay reachable", async () => {
  const { config } = await import("../proxy.ts");
  const matcher: string[] = config.matcher;
  for (const page of ["/", "/analysis", "/predictions", "/staff", "/billing", "/data", "/settings"]) {
    assert.ok(matcher.includes(page), `${page} must require a session`);
  }
  // /login must stay reachable while signed out, and the API routes
  // answer 401 themselves rather than redirecting a fetch() to HTML.
  assert.ok(!matcher.some((m) => m.startsWith("/login")), "/login must not be gated");
  assert.ok(!matcher.some((m) => m.startsWith("/api")), "API routes must answer, not redirect");
});
