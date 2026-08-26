"use client";

// components/Deposits.tsx — where the restaurant's money goes.
//
// The most consequential settings panel in the product, and the copy is
// doing as much work as the controls. Three things it must never let an
// owner get wrong:
//
//   1. Whose account this is. Travola does not hold the money — the
//      restaurant's own Stripe account does, and the bank on the other
//      end is theirs. Said in the panel rather than buried in a doc.
//   2. Whether it is actually working. "Connected" is not the same as
//      "payouts enabled": Stripe can accept an account and still hold
//      deposits pending a document. The status line always reflects the
//      flag that decides whether money moves, not the one that is
//      easiest to make green.
//   3. Test mode. A sandbox connection that looks like a live one is how
//      a restaurant goes a fortnight believing they are being paid.
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Field, SectionHeading, inputClass } from "@/components/ui";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Prefs = {
  payoutInterval: "daily" | "weekly" | "monthly" | "manual";
  payoutWeeklyAnchor: number;
  payoutMonthlyAnchor: number;
  payoutDelayDays: number | null;
  statementDescriptor: string | null;
  payoutNotifyEmail: string | null;
  tipHandling: "with_payout" | "cash_nightly" | "payroll";
  tipNote: string | null;
};

type Payouts = {
  unlocked: boolean;
  unlockExpiresIn?: number;
  adminSet?: boolean;
  codeLabel?: string;
  restaurantName?: string;
  connected?: boolean;
  status?: string;
  statusLine?: string;
  payoutsEnabled?: boolean;
  chargesEnabled?: boolean;
  detailsSubmitted?: boolean;
  requirementsDue?: string[];
  requirementsDueAt?: string | null;
  disabledReason?: string | null;
  bank?: { name: string | null; last4: string; currency: string | null } | null;
  country?: string | null;
  prefs?: Prefs;
  scheduleLine?: string;
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
  fallbackEmail?: string | null;
  processor: { configured: boolean; testMode: boolean };
};

/** Stripe's requirement keys are machine names, and it emits one per
 *  FIELD — `company.address.city`, `company.address.line1`,
 *  `company.address.postal_code`, `company.address.state` are four
 *  entries for one thing an owner already knows. Rendering them raw
 *  produced a twenty-five item wall that reads as "this will never be
 *  finished". These rules collapse each family to the one sentence a
 *  person can act on, then the caller dedupes. */
const REQUIREMENT_RULES: Array<[RegExp, string]> = [
  [/^company\.address\./, "The business address"],
  [/^company\.(name|tax_id|phone|structure)/, "The registered business name and EIN"],
  [/^company\.verification/, "A photo of a business registration document"],
  [/^company\.owners_provided|^owners\./, "Name, email and date of birth for each owner"],
  [/^representative\.address\./, "A home address for the person responsible"],
  [/^representative\.dob\./, "Date of birth for the person responsible"],
  [/^representative\.(ssn_last_4|id_number)/, "The last four of that person's SSN"],
  [/^representative\.verification/, "A photo ID for the person responsible"],
  [/^representative\./, "Name, email and phone for the person responsible"],
  [/^individual\.address\./, "Your home address"],
  [/^individual\.dob\./, "Your date of birth"],
  [/^individual\.(ssn_last_4|id_number)/, "The last four of your SSN"],
  [/^individual\.verification/, "A photo ID"],
  [/^individual\./, "Your name, email and phone"],
  [/^external_account/, "A bank account to deposit into"],
  [/^business_profile\.url/, "A website or social page for the restaurant"],
  [/^business_profile\./, "A short description of the business"],
];

function groupRequirements(keys: string[]) {
  const out: string[] = [];
  for (const key of keys) {
    const rule = REQUIREMENT_RULES.find(([pattern]) => pattern.test(key));
    const label = rule ? rule[1] : key.replace(/_/g, " ").replace(/\./g, " → ");
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** Stripe's `currently_due` includes plumbing the hosted flow fills in
 *  by itself — the IP address that accepted the terms, the descriptor we
 *  already set. Listing those tells an owner to go and find something
 *  that is not theirs to find, and pads a list that is already
 *  intimidating. */
const SELF_SERVING = /^(tos_acceptance\.|settings\.|business_profile\.mcc$)/;

/** Long enough to be useful, short enough to look finishable. Stripe's
 *  own flow walks through the rest. */
const REQUIREMENTS_SHOWN = 6;

const STATUS_TONE: Record<string, "good" | "accent" | "warn" | "bad"> = {
  active: "good",
  onboarding: "accent",
  restricted: "warn",
  disabled: "bad",
  not_started: "warn",
};

export function Deposits() {
  const [data, setData] = useState<Payouts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<Prefs | null>(null);

  // Unlock form
  const [unlockName, setUnlockName] = useState("");
  const [unlockCode, setUnlockCode] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/payouts");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load deposit settings.");
      setData(body);
      if (body.prefs) setPrefs(body.prefs);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Stripe sends the owner back here after onboarding. Pick that up and
  // re-read rather than leaving them on a stale "not connected" panel.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("deposits");
    if (!flag) return;
    if (flag === "return") setNote("Back from Stripe. Checking what it says…");
    if (flag === "refresh") setNote("That Stripe link had expired. Start the connection again.");
    window.history.replaceState({}, "", window.location.pathname);
    load();
  }, [load]);

  async function post(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/payouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.locked) await load();
        throw new Error(body.error ?? "That did not work.");
      }
      return body;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    const body = await post({ action: "unlock", name: unlockName, code: unlockCode });
    if (!body) return;
    setUnlockCode("");
    setUnlockName("");
    if (body.usedRestaurantCode) {
      setNote("Unlocked with the restaurant code. Set an owner code in Logins — the restaurant code is the one your whole floor knows.");
    }
    await load();
  }

  async function connect() {
    const body = await post({ action: "connect" });
    if (body?.url) window.location.href = body.url;
  }

  async function openDashboard() {
    const body = await post({ action: "dashboard" });
    if (body?.url) window.open(body.url, "_blank", "noreferrer");
  }

  async function save() {
    if (!prefs) return;
    const body = await post({ action: "save", prefs });
    if (!body) return;
    setNote("Deposit settings saved.");
    setData((current) => (current ? { ...current, ...body } : current));
    if (body.prefs) setPrefs(body.prefs);
  }

  async function disconnect() {
    const body = await post({ action: "disconnect" });
    if (!body) return;
    setNote(body.note ?? "Disconnected.");
    await load();
  }

  if (!data) {
    return (
      <Card className="p-5">
        <SectionHeading title="Deposits" note="Where card payments on closed checks are paid out." />
        <p className="text-sm text-ink-400">{error ?? "Loading…"}</p>
      </Card>
    );
  }

  // ── Locked ──────────────────────────────────────────────────────
  if (!data.unlocked) {
    return (
      <Card className="p-5 border-l-2 border-l-ai">
        <SectionHeading
          title="Deposits"
          note="Where card payments on closed checks are paid out. Locked, because changing it changes where your money goes."
        />

        <form onSubmit={unlock} className="grid gap-3 sm:grid-cols-2 max-w-2xl">
          <Field label="Restaurant name" hint="Typed out, the same as at sign-in.">
            <input
              className={inputClass}
              value={unlockName}
              onChange={(event) => setUnlockName(event.target.value)}
              autoComplete="off"
              placeholder={data.restaurantName ? undefined : "Your restaurant"}
            />
          </Field>
          <Field
            label={data.codeLabel ?? "Restaurant code"}
            hint={
              data.adminSet
                ? "The private code, not the four digits your floor uses."
                : "You have not set an owner code yet, so the restaurant code is what proves it is you."
            }
          >
            <input
              className={inputClass}
              type="password"
              inputMode="numeric"
              value={unlockCode}
              onChange={(event) => setUnlockCode(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <div className="sm:col-span-2 flex items-center gap-3">
            {/* type="submit" is load-bearing: Button defaults to
                type="button", so without this the click does nothing and
                only pressing Enter in a field submits the form. */}
            <Button type="submit" tone="primary" disabled={busy || !unlockName || !unlockCode}>
              {busy ? "Checking…" : "Unlock deposit settings"}
            </Button>
            {data.connected ? (
              <span className="text-xs text-ink-400">An account is already connected.</span>
            ) : null}
          </div>
        </form>

        {error ? <p className="text-sm text-state-seated mt-3">{error}</p> : null}

        <p className="text-xs text-ink-400 mt-4 leading-relaxed max-w-2xl">
          This will become an email and password with a confirmation code. Until then it is the restaurant
          name and code, and the unlock lasts ten minutes.
        </p>
      </Card>
    );
  }

  // ── Unlocked ────────────────────────────────────────────────────
  const status = data.status ?? "not_started";
  const tone = STATUS_TONE[status] ?? "warn";
  const due = groupRequirements((data.requirementsDue ?? []).filter((key) => !SELF_SERVING.test(key)));
  const shown = due.slice(0, REQUIREMENTS_SHOWN);
  const moreCount = due.length - shown.length;

  return (
    <div className="flex flex-col gap-4">
      {data.processor.testMode ? (
        <Card className="p-4 border-l-2 border-l-state-dining">
          <p className="text-sm text-ink-50">Stripe is in test mode on this deployment.</p>
          <p className="text-xs text-ink-400 mt-1">
            Everything here works, but no real money moves and any bank account connected is a test one.
          </p>
        </Card>
      ) : null}

      {!data.processor.configured ? (
        <Card className="p-4 border-l-2 border-l-state-dining">
          <p className="text-sm text-ink-50">No payment processor is connected to Travola yet.</p>
          <p className="text-xs text-ink-400 mt-1">
            You can set your preferences below and they will be saved. Connecting a bank account needs
            Stripe switched on for this deployment.
          </p>
        </Card>
      ) : null}

      {/* ── The account itself ── */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <SectionHeading
              title="Deposit account"
              note="Card payments on closed checks land in your own Stripe account and are paid out to your own bank. Travola never holds your money."
            />
          </div>
          <Chip tone={tone}>{status === "not_started" ? "not connected" : status}</Chip>
        </div>

        <p className="text-sm text-ink-200">{data.statusLine}</p>

        {data.bank ? (
          <div className="mt-4 rounded-xl border border-border bg-panel-up/40 px-4 py-3">
            <p className="label">Depositing to</p>
            <p className="text-base font-semibold text-ink-50 mt-1">
              {data.bank.name ?? "Bank account"} ····{data.bank.last4}
            </p>
            <p className="text-xs text-ink-400 mt-0.5 uppercase">
              {data.bank.currency ?? ""} {data.country ? `· ${data.country}` : ""}
            </p>
          </div>
        ) : null}

        {due.length ? (
          <div className="mt-4 rounded-xl border border-border bg-panel-up/40 px-4 py-3">
            <p className="label">Have this to hand</p>
            <ul className="mt-2 space-y-1.5">
              {shown.map((label) => (
                <li key={label} className="flex gap-2 text-sm text-ink-200">
                  <span className="text-state-dining shrink-0">·</span>
                  <span>{label}</span>
                </li>
              ))}
            </ul>
            {moreCount > 0 ? (
              <p className="text-xs text-ink-400 mt-2">
                And {moreCount} more — Stripe asks for each one in turn.
              </p>
            ) : null}
            {data.requirementsDueAt ? (
              <p className="text-xs text-ink-400 mt-2.5">
                Due by {new Date(data.requirementsDueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!data.connected ? (
            <Button tone="primary" disabled={busy || !data.processor.configured} onClick={connect}>
              {busy ? "Opening Stripe…" : "Connect a bank account"}
            </Button>
          ) : (
            <>
              {status !== "active" ? (
                <Button tone="primary" disabled={busy} onClick={connect}>
                  {busy ? "Opening Stripe…" : "Finish verification"}
                </Button>
              ) : null}
              {/* Stripe refuses a login link until onboarding is submitted,
                  so offering the button before then is offering an error. */}
              {data.detailsSubmitted ? (
                <Button disabled={busy} onClick={openDashboard}>Manage in Stripe ↗</Button>
              ) : null}
              <Button disabled={busy} onClick={() => post({ action: "refresh" }).then(load)}>Refresh</Button>
              <button
                type="button"
                disabled={busy}
                onClick={disconnect}
                className="text-sm text-state-seated hover:underline disabled:opacity-50"
              >
                Disconnect
              </button>
            </>
          )}
        </div>

        <p className="text-xs text-ink-400 mt-4 leading-relaxed max-w-3xl">
          Stripe collects the bank details and the identity documents on its own pages — Travola never sees
          them, and never sees more of your account number than the last four digits.
          {data.lastSyncedAt ? ` Last checked with Stripe ${new Date(data.lastSyncedAt).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}.` : ""}
        </p>
      </Card>

      {prefs ? (
        <>
          {/* ── Schedule ── */}
          <Card className="p-5">
            <SectionHeading title="Deposit schedule" note="How often Stripe sends what it has collected." />

            <div className="flex flex-wrap gap-2">
              {(["daily", "weekly", "monthly", "manual"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setPrefs({ ...prefs, payoutInterval: option })}
                  aria-pressed={prefs.payoutInterval === option}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold border capitalize ${
                    prefs.payoutInterval === option
                      ? "bg-ai-bg border-ai/40 text-ai"
                      : "bg-panel border-border text-ink-400 hover:text-ink-50"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2 max-w-3xl">
              {prefs.payoutInterval === "weekly" ? (
                <Field label="Day of the week" hint="Deposits land on this day.">
                  <select
                    className={inputClass}
                    value={prefs.payoutWeeklyAnchor}
                    onChange={(event) => setPrefs({ ...prefs, payoutWeeklyAnchor: Number(event.target.value) })}
                  >
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index}>{day}</option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {prefs.payoutInterval === "monthly" ? (
                <Field label="Day of the month" hint="29, 30 and 31 fall back to the last day in a shorter month.">
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className={inputClass}
                    value={prefs.payoutMonthlyAnchor}
                    onChange={(event) => setPrefs({ ...prefs, payoutMonthlyAnchor: Number(event.target.value) })}
                  />
                </Field>
              ) : null}

              {prefs.payoutInterval !== "manual" ? (
                <Field
                  label="Hold funds for"
                  hint="Leave empty for Stripe's minimum, which is the fastest it will go for your account."
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={30}
                      placeholder="Stripe's minimum"
                      className={inputClass}
                      value={prefs.payoutDelayDays ?? ""}
                      onChange={(event) =>
                        setPrefs({
                          ...prefs,
                          payoutDelayDays: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                    />
                    <span className="text-sm text-ink-400 shrink-0">days</span>
                  </div>
                </Field>
              ) : null}
            </div>

            <p className="mt-4 rounded-lg bg-panel-up/50 border border-border px-3.5 py-2.5 text-sm text-ink-200">
              {data.scheduleLine}
            </p>
          </Card>

          {/* ── On the guest's statement ── */}
          <Card className="p-5">
            <SectionHeading
              title="On the guest's statement"
              note="What a guest sees on their card statement beside the charge. A name they recognise is the cheapest chargeback prevention there is."
            />
            <div className="grid gap-4 sm:grid-cols-2 max-w-3xl">
              <Field label="Statement descriptor" hint="5 to 22 characters. No quotes, angle brackets or asterisks.">
                <input
                  className={inputClass}
                  maxLength={22}
                  placeholder={data.restaurantName ?? ""}
                  value={prefs.statementDescriptor ?? ""}
                  onChange={(event) => setPrefs({ ...prefs, statementDescriptor: event.target.value })}
                />
              </Field>
              <Field
                label="Who Travola tells about deposits"
                hint={
                  data.fallbackEmail
                    ? `Left empty, Travola uses ${data.fallbackEmail}. Stripe's own emails go to the address on your Stripe account — change that one in Stripe.`
                    : "Stripe's own emails go to the address on your Stripe account; change that one in Stripe."
                }
              >
                <input
                  className={inputClass}
                  type="email"
                  placeholder={data.fallbackEmail ?? "owner@restaurant.com"}
                  value={prefs.payoutNotifyEmail ?? ""}
                  onChange={(event) => setPrefs({ ...prefs, payoutNotifyEmail: event.target.value })}
                />
              </Field>
            </div>
          </Card>

          {/* ── Tips ── */}
          <Card className="p-5">
            <SectionHeading
              title="Tips"
              note="Card tips are deposited with the rest of the card revenue. Travola cannot send a tip to a server's own account — this records how you distribute them, so the POS and the reports say the same thing you do."
            />
            <div className="flex flex-wrap gap-2">
              {([
                ["with_payout", "Paid out with card revenue"],
                ["cash_nightly", "Paid in cash at the end of the night"],
                ["payroll", "Distributed through payroll"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPrefs({ ...prefs, tipHandling: value })}
                  aria-pressed={prefs.tipHandling === value}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold border ${
                    prefs.tipHandling === value
                      ? "bg-ai-bg border-ai/40 text-ai"
                      : "bg-panel border-border text-ink-400 hover:text-ink-50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-4 max-w-3xl">
              <Field label="Note for your team" hint="Optional. Shown wherever tip handling is explained.">
                <input
                  className={inputClass}
                  maxLength={280}
                  placeholder="e.g. Pooled and split by hours worked"
                  value={prefs.tipNote ?? ""}
                  onChange={(event) => setPrefs({ ...prefs, tipNote: event.target.value })}
                />
              </Field>
            </div>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {error ? <p className="text-sm text-state-seated">{error}</p> : null}
              {note && !error ? <p className="text-sm text-state-avail">{note}</p> : null}
            </div>
            <Button tone="primary" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save deposit settings"}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
