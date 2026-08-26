"use client";

// app/login/page.tsx — one credential, three products.
//
// Intentionally the same two fields, in the same order, with the same
// wording as the floor app and the POS. A manager who has signed into one
// has signed into all three; making this screen look clever would only
// make them wonder whether it wants something different.
import { useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";

export default function LoginPage() {
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, passcode }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "That did not work.");
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

        {error ? <p className="text-sm text-state-seated">{error}</p> : null}

        <Button type="submit" tone="primary" disabled={busy || !name || passcode.length < 4} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
