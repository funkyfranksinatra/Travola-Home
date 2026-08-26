"use client";

// app/(home)/staff/page.tsx — who can get in, and with what.
//
// This is the page an owner opens the morning after someone quits, so the
// revoke path is one click and takes effect at the next POS sign-in. Staff
// are deactivated rather than deleted: their name is on two years of
// checks and reservations, and removing the row would either fail on a
// foreign key or quietly change the numbers on the analysis tab. Revoking
// access is what "delete this ex-employee" actually means.
import { useCallback, useEffect, useState } from "react";
import { Avatar, Button, Card, Chip, Empty, Field, PageHeader, SectionHeading, inputClass } from "@/components/ui";
import { dateLabel } from "@/lib/format";

type Staff = {
  id: string; name: string; roles: string[]; active: boolean; hasPin: boolean;
  onShift: boolean; addedAt: string; lastServiceDate: string | null;
};

type Payload = {
  restaurant: { name: string; recoveryEmail: string | null };
  adminPasscodeSet: boolean;
  staff: Staff[];
};

export default function StaffPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(() => {
    fetch("/api/staff")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not load.");
        return response.json();
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  async function act(serverId: string, action: string, pin?: string) {
    setError(null);
    setNotice(null);
    const response = await fetch("/api/staff", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId, action, pin }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "That did not work.");
      return;
    }
    setNotice("Saved.");
    load();
  }

  if (error && !data) return <Empty>{error}</Empty>;
  if (!data) return <p className="text-sm text-ink-400">Loading…</p>;

  const active = data.staff.filter((row) => row.active);
  const inactive = data.staff.filter((row) => !row.active);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Logins"
        title="Access & credentials"
        note="Staff sign in to the POS with a four-digit PIN. The restaurant code opens all three apps."
        right={
          <div className="flex gap-2 flex-wrap">
            <Chip tone="good">{active.length} with access</Chip>
            {inactive.length ? <Chip>{inactive.length} revoked</Chip> : null}
          </div>
        }
      />

      {error ? <Card className="p-5 border-l-2 border-l-state-seated"><p className="text-sm text-state-seated">{error}</p></Card> : null}
      {notice ? <p className="text-sm text-state-avail">{notice}</p> : null}

      <Credentials adminSet={data.adminPasscodeSet} restaurantName={data.restaurant.name} onSaved={load} />

      <section>
        <SectionHeading
          title="Staff"
          note="A PIN is never shown back — reset it instead. Revoking access clears the PIN immediately."
        />
        {active.length === 0 ? (
          <Empty>No active staff. Add people in the floor manager; they appear here.</Empty>
        ) : (
          <div className="space-y-2">
            {active.map((person) => (
              <StaffRow key={person.id} person={person} onAct={act} />
            ))}
          </div>
        )}
      </section>

      {inactive.length > 0 ? (
        <section>
          <SectionHeading
            title={`Former staff (${inactive.length})`}
            action={
              <Button tone="ghost" onClick={() => setShowInactive((value) => !value)}>
                {showInactive ? "Hide" : "Show"}
              </Button>
            }
            note="Access revoked. Their history stays on the books, which is why the row is kept."
          />
          {showInactive ? (
            <div className="space-y-2">
              {inactive.map((person) => (
                <StaffRow key={person.id} person={person} onAct={act} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function StaffRow({ person, onAct }: { person: Staff; onAct: (id: string, action: string, pin?: string) => void }) {
  const [pin, setPin] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <Card className="p-5 flex items-center justify-between gap-4 flex-wrap">
      <div className="min-w-0 flex items-center gap-3">
        <Avatar name={person.name} dimmed={!person.active} />
        <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-ink-50">{person.name}</span>
          {person.roles.map((role) => <Chip key={role}>{role}</Chip>)}
          {person.hasPin ? <Chip tone="good">PIN set</Chip> : <Chip tone="warn">no PIN</Chip>}
          {person.onShift ? <Chip tone="accent">on shift</Chip> : null}
          {!person.active ? <Chip tone="neutral">access revoked</Chip> : null}
        </div>
        <p className="text-xs text-ink-400 mt-1">
          {person.lastServiceDate ? `Last worked ${dateLabel(person.lastServiceDate)}` : "No recorded shifts"}
        </p>
        </div>
      </div>

      <div className="no-print flex items-center gap-2 flex-wrap">
        {editing ? (
          <>
            <input
              className={`${inputClass} w-24`}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
              inputMode="numeric"
              placeholder="4 digits"
              autoFocus
            />
            <Button
              tone="primary"
              disabled={pin.length !== 4}
              onClick={() => { onAct(person.id, "set_pin", pin); setPin(""); setEditing(false); }}
            >
              Save PIN
            </Button>
            <Button tone="ghost" onClick={() => { setPin(""); setEditing(false); }}>Cancel</Button>
          </>
        ) : person.active ? (
          <>
            <Button onClick={() => setEditing(true)}>{person.hasPin ? "Reset PIN" : "Set PIN"}</Button>
            {person.hasPin ? <Button tone="ghost" onClick={() => onAct(person.id, "clear_pin")}>Clear PIN</Button> : null}
            {confirming ? (
              <>
                <span className="text-xs text-ink-400">Revoke {person.name}&rsquo;s access?</span>
                <Button tone="danger" onClick={() => { onAct(person.id, "deactivate"); setConfirming(false); }}>
                  Yes, revoke
                </Button>
                <Button tone="ghost" onClick={() => setConfirming(false)}>No</Button>
              </>
            ) : (
              <Button tone="danger" onClick={() => setConfirming(true)}>Revoke access</Button>
            )}
          </>
        ) : (
          <Button onClick={() => onAct(person.id, "reactivate")}>Restore access</Button>
        )}
      </div>
    </Card>
  );
}

function Credentials({ adminSet, restaurantName, onSaved }: {
  adminSet: boolean; restaurantName: string; onSaved: () => void;
}) {
  const [mode, setMode] = useState<"rotate_passcode" | "set_admin_passcode" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!mode) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/staff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: mode, currentPasscode: current, passcode: next }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? "That did not work.");
      return;
    }
    setDone(
      mode === "rotate_passcode"
        ? body.note ?? "Restaurant code changed."
        : "Owner code set. It is now required to delete data or change the restaurant code.",
    );
    setMode(null);
    setCurrent("");
    setNext("");
    onSaved();
  }

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card className="flex flex-col">
        <SectionHeading title="Restaurant code" note={`Opens the floor manager, the POS and Travola Home for ${restaurantName}.`} />
        <p className="text-sm text-ink-400">
          Change it and everyone will need the new four digits. Managers who have a device signed in stay signed in
          until they sign out.
        </p>
        <div className="mt-auto pt-4">
          <Button onClick={() => { setMode("rotate_passcode"); setDone(null); }}>Change restaurant code</Button>
        </div>
      </Card>

      <Card className={`flex flex-col ${adminSet ? "" : "border-l-2 border-l-state-dining"}`}>
        <SectionHeading
          title="Owner code"
          note="A second, private code that gates deleting data and changing the restaurant code."
        />
        {adminSet ? (
          <p className="text-sm text-ink-400">Set. Required for anything irreversible.</p>
        ) : (
          <p className="text-sm text-ink-200">
            Not set. Until you set one, deleting data falls back to the same four digits the whole floor
            already knows.
          </p>
        )}
        <div className="mt-auto pt-4">
          <Button tone={adminSet ? "default" : "primary"} onClick={() => { setMode("set_admin_passcode"); setDone(null); }}>
            {adminSet ? "Change owner code" : "Set an owner code"}
          </Button>
        </div>
      </Card>

      {done ? <p className="lg:col-span-2 text-sm text-state-avail">{done}</p> : null}

      {mode ? (
        <form onSubmit={submit} className="card p-5 lg:col-span-2 space-y-3">
          <SectionHeading
            title={mode === "rotate_passcode" ? "Change the restaurant code" : "Set the owner code"}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={adminSet ? "Current owner code" : "Current restaurant code"}
              hint={adminSet ? undefined : "You have not set an owner code yet, so the restaurant code is what proves it is you."}
            >
              <input
                className={inputClass}
                value={current}
                onChange={(event) => setCurrent(event.target.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
                autoFocus
              />
            </Field>
            <Field label="New four digits">
              <input
                className={inputClass}
                value={next}
                onChange={(event) => setNext(event.target.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
              />
            </Field>
          </div>
          {error ? <p className="text-sm text-state-seated">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" tone="primary" disabled={busy || current.length !== 4 || next.length !== 4}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button tone="ghost" onClick={() => { setMode(null); setError(null); }}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
