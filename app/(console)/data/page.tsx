"use client";

// app/(console)/data/page.tsx — export it, or destroy it.
//
// The two halves are on one page on purpose: an owner who is about to
// delete everything should be looking straight at the export button while
// they think about it. The delete side is guarded four ways (fresh owner
// code, the code again in the request, the restaurant name typed exactly,
// and an explicit scope) and none of them is a substitute for the others.
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Empty, Field, SectionHeading, inputClass } from "@/components/ui";
import { integer } from "@/lib/format";

type Manifest = { tables: Array<{ key: string; label: string; rows: number }>; generatedAt: string };

export default function DataPage() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/export")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not load.");
        return response.json();
      })
      .then(setManifest)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const populated = manifest?.tables.filter((table) => table.rows > 0) ?? [];
  const empty = manifest?.tables.filter((table) => table.rows === 0) ?? [];

  return (
    <div className="space-y-8">
      <header>
        <p className="tv-label">Data</p>
        <h1 className="tv-heading text-ink-50 mt-1" style={{ fontSize: "calc(var(--heading-size) * 1.3)" }}>
          Export & deletion
        </h1>
        <p className="text-sm text-ink-400 mt-1">
          Your records, as stored — not a summary. Every export is written to the audit log.
        </p>
      </header>

      {error ? <Empty>{error}</Empty> : null}

      <section>
        <SectionHeading
          title="Export"
          note="One CSV per table, streamed straight to your browser. Large tables take a moment to start."
        />
        {!manifest ? (
          <p className="text-sm text-ink-400">Counting rows…</p>
        ) : populated.length === 0 ? (
          <Empty>There is nothing to export yet.</Empty>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {populated.map((table) => (
              <a
                key={table.key}
                href={`/api/export?table=${table.key}`}
                className="tv-card flex items-center justify-between gap-3 hover:border-border-hi"
              >
                <span>
                  <span className="block text-sm text-ink-50">{table.label}</span>
                  <span className="block text-xs text-ink-400">{integer(table.rows)} {table.rows === 1 ? "row" : "rows"}</span>
                </span>
                <span className="text-ai text-sm shrink-0">CSV ↓</span>
              </a>
            ))}
          </div>
        )}
        {empty.length > 0 ? (
          <p className="text-xs text-ink-400 mt-3">
            Empty and not offered: {empty.map((table) => table.label).join(", ")}.
          </p>
        ) : null}
      </section>

      <DangerZone onDone={load} />
    </div>
  );
}

function DangerZone({ onDone }: { onDone: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [scope, setScope] = useState<"history" | "everything" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setError(null);
    const response = await fetch("/api/auth", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "That code is not right.");
      return;
    }
    setUnlocked(true);
    if (body.usedRestaurantPasscode) {
      setError(
        "That was the restaurant code, not a separate owner code. Set an owner code on the Logins page so the whole floor cannot reach this screen.",
      );
    }
  }

  async function destroy() {
    if (!scope) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/danger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, confirmName, passcode }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? "That did not work.");
      return;
    }
    setResult(
      `Deleted ${integer(body.removed?.reservations ?? 0)} reservations, ${integer(body.removed?.guests ?? 0)} guests and ${integer(body.removed?.checks ?? 0)} checks.` +
        (scope === "everything" ? " The floor plan, staff and menu are gone too, and the subscription is cancelled." : ""),
    );
    setScope(null);
    setConfirmName("");
    setPasscode("");
    setUnlocked(false);
    onDone();
  }

  return (
    <section>
      <SectionHeading
        title="Delete restaurant data"
        note="Irreversible. There is no undo and no backup on our side — export first."
      />

      {result ? (
        <Card className="border-l-2 border-l-state-avail">
          <p className="text-sm text-ink-50">{result}</p>
        </Card>
      ) : null}

      <Card className="border-l-2 border-l-state-seated space-y-4">
        {!unlocked ? (
          <>
            <p className="text-sm text-ink-200">
              Enter your owner code to unlock. The unlock lasts ten minutes.
            </p>
            <div className="flex gap-2 items-end flex-wrap">
              <Field label="Owner code">
                <input
                  className={`${inputClass} w-32`}
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                  inputMode="numeric"
                />
              </Field>
              <Button tone="danger" disabled={passcode.length !== 4} onClick={unlock}>Unlock</Button>
            </div>
            {error ? <p className="text-sm text-state-dining">{error}</p> : null}
          </>
        ) : (
          <>
            {error ? <p className="text-sm text-state-dining">{error}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <ScopeCard
                selected={scope === "history"}
                onSelect={() => setScope("history")}
                title="Clear service history"
                body="Reservations, guests, waitlist, shifts, checks, payments, forecasts and events. Keeps your floor plan, staff, menu and settings, so the restaurant keeps working from tonight."
              />
              <ScopeCard
                selected={scope === "everything"}
                onSelect={() => setScope("everything")}
                title="Clear everything"
                body="All of the above plus the floor plan, staff, menu and settings, and cancels the subscription. Your account and this audit log survive so you can still sign in and see what happened."
              />
            </div>

            {scope ? (
              <div className="space-y-3 pt-2 border-t border-border">
                <Field
                  label="Type the restaurant name exactly to confirm"
                  hint="Not a word like DELETE — the name, so this cannot happen to the wrong restaurant."
                >
                  <input className={inputClass} value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
                </Field>
                <div className="flex items-center gap-2 flex-wrap">
                  <Chip tone="bad">no undo</Chip>
                  <Button tone="danger" disabled={busy || !confirmName} onClick={destroy}>
                    {busy ? "Deleting…" : scope === "everything" ? "Delete everything" : "Delete service history"}
                  </Button>
                  <Button tone="ghost" onClick={() => { setScope(null); setConfirmName(""); }}>Cancel</Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </section>
  );
}

function ScopeCard({ selected, onSelect, title, body }: {
  selected: boolean; onSelect: () => void; title: string; body: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left rounded-lg p-3 border ${
        selected ? "border-state-seated bg-state-seatedBg/40" : "border-border hover:border-border-hi"
      }`}
    >
      <span className="block text-sm text-ink-50">{title}</span>
      <span className="block text-xs text-ink-400 mt-1 leading-relaxed">{body}</span>
    </button>
  );
}
