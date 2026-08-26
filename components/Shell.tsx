"use client";

// components/Shell.tsx — the frame, matching the floor manager exactly.
//
// Top tabs rather than a side rail, with the same 56px bar, the same brand
// lockup and the same uppercase tab treatment Travola-OS uses. A manager
// moving between the two products should not have to relearn where
// anything is; the muscle memory is the point.
//
// The right-hand cluster mirrors the floor app's live strip: it answers
// "what is the room doing right now" without leaving the page you are on.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS = [
  { href: "/", label: "Overview" },
  { href: "/analysis", label: "Analysis" },
  { href: "/predictions", label: "Predictions" },
  { href: "/staff", label: "Logins" },
  { href: "/billing", label: "Plan & billing" },
  { href: "/data", label: "Data" },
  { href: "/settings", label: "Settings" },
];

export function Shell({
  restaurantName, links, children,
}: {
  restaurantName: string;
  links: { floor: string; pos: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [clock, setClock] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);

  // Rendered only after mount: a server-rendered clock is wrong by the
  // time it reaches the browser and trips a hydration mismatch.
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }));
      setToday(now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }));
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  async function signOut() {
    await fetch("/api/auth", { method: "DELETE" });
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 flex items-center px-4 sm:px-6 h-14 bg-panel border-b border-border shrink-0">
        <Link href="/" className="flex items-center gap-2.5 mr-4 sm:mr-8 shrink-0">
          <img src="/brand/travola-icon.svg" alt="" aria-hidden="true" className="w-6 h-6 rounded-[6px]" />
          <span className="hidden sm:flex items-baseline gap-2.5">
            <span className="font-display text-base font-bold tracking-wide text-ai">Travola</span>
            <span className="font-mono text-[9px] text-ink-400 tracking-[0.2em] uppercase">Home</span>
          </span>
        </Link>

        <nav className="flex h-full items-stretch overflow-x-auto" aria-label="Sections">
          {TABS.map((tab) => {
            const active = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center px-3 sm:px-4 whitespace-nowrap text-[10.5px] font-bold tracking-[0.12em] uppercase border-b-2 ${
                  active ? "border-ai text-ai" : "border-transparent text-ink-400 hover:text-ink-50"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3 sm:gap-4 shrink-0">
          <div className="hidden lg:block font-mono text-xs text-ink-400">
            <span className="text-ink-50 font-semibold tabular-nums">{clock ?? "—:—"}</span>
            <span className="mx-2 text-border-hi">·</span>
            {today ?? ""}
          </div>
          <span className="hidden md:inline text-sm text-ink-200 truncate max-w-[16ch]" title={restaurantName}>
            {restaurantName}
          </span>
          <Launcher links={links} />
          <button
            type="button"
            onClick={signOut}
            className="font-mono text-[9px] uppercase tracking-[.1em] text-ink-400 hover:text-ink-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-6 mx-auto w-full max-w-[1560px]">{children}</main>
    </div>
  );
}

/** One control that opens the other two products. Given real prominence
 *  because "open the POS" is the commonest reason a manager lands here. */
function Launcher({ links }: { links: { floor: string; pos: string } }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg bg-ai-bg border border-ai/30 px-2.5 py-1.5 text-[11px] font-semibold text-ai hover:bg-ai-muted"
        aria-expanded={open}
      >
        Open
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-border-hi bg-panel shadow-2xl overflow-hidden">
          <LaunchItem href={links.floor} title="Floor manager" hint="Reservations, waitlist, sections" />
          <LaunchItem href={links.pos} title="POS" hint="Orders, kitchen, checks" />
        </div>
      ) : null}
    </div>
  );
}

function LaunchItem({ href, title, hint }: { href: string; title: string; hint: string }) {
  if (!href) {
    return (
      <span className="block px-3 py-2.5 text-xs text-ink-400/70 border-b border-border last:border-0">
        {title} — no URL configured
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block px-3 py-2.5 hover:bg-panel-up border-b border-border last:border-0"
    >
      <span className="block text-sm text-ink-50">{title} ↗</span>
      <span className="block text-[11px] text-ink-400 mt-0.5">{hint}</span>
    </a>
  );
}
