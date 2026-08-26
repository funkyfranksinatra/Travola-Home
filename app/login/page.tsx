"use client";

// app/login/page.tsx — one credential, three products.
//
// Intentionally the same two fields, in the same order, with the same
// wording as the floor app and the POS. A manager who has signed into one
// has signed into all three; making this screen look clever would only
// make them wonder whether it wants something different.
import { useEffect, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";

export default function LoginPage() {
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A configuration failure is not the user's fault and is not fixed by
  // retyping the code, so it is presented differently from a rejected
  // credential.
  const [isConfig, setIsConfig] = useState(false);
  const [busy, setBusy] = useState(false);

  // Ask up front whether this deployment is actually wired up, so a
  // misconfiguration is on screen before anyone types a code and starts
  // doubting a passcode that was never wrong. Also what a bounced page
  // request lands on: the layout sends unusable sessions here.
  useEffect(() => {
    fetch("/api/health")
      .then((response) => (response.ok ? null : response.json()))
      .then((data) => {
        const problems: Array<{ fix: string }> = data?.problems ?? [];
        if (problems.length) {
          setIsConfig(true);
          setError(`This deployment is not fully configured. ${problems.map((p) => p.fix).join(" ")}`);
        } else if (data && data.database && !data.database.ok) {
          setIsConfig(true);
          setError(`The Console cannot reach the database: ${data.database.detail}`);
        }
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setIsConfig(false);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, passcode }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setIsConfig(Boolean(data.configuration) || response.status >= 500);
        setError(
          data.error ??
            (response.status >= 500
              ? "The server hit an error signing in. Check this deployment's logs — the usual cause is a missing environment variable."
              : "That restaurant name and code do not match."),
        );
        return;
      }
      window.location.href = "/";
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={submit} className="tv-card w-full max-w-sm space-y-4">
        <div>
          <p className="tv-label">Travola</p>
          <h1 className="tv-heading text-ink-50 mt-0.5">Console</h1>
          <p className="text-sm text-ink-400 mt-2">
            Sign in with the same restaurant name and code you use for the floor manager and the POS.
          </p>
        </div>

        <Field label="Restaurant name">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="organization"
            autoFocus
            required
          />
        </Field>

        <Field label="Code">
          <input
            className={inputClass}
            value={passcode}
            onChange={(event) => setPasscode(event.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            autoComplete="current-password"
            placeholder="····"
            required
          />
        </Field>

        {error ? (
          <div className={isConfig ? "rounded-lg border border-state-dining/30 bg-state-diningBg p-3" : ""}>
            <p className={`text-sm ${isConfig ? "text-state-dining" : "text-state-seated"}`}>{error}</p>
            {isConfig ? (
              <p className="text-xs text-ink-400 mt-2">
                This is a setup problem, not a wrong code — retyping it will not help.{" "}
                <a href="/api/health" className="text-ai underline">Check what is missing</a>.
              </p>
            ) : null}
          </div>
        ) : null}

        <Button type="submit" tone="primary" disabled={busy || !name || passcode.length < 4} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
