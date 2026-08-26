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
//
// There is deliberately no launcher menu up here. A button labelled "Open"
// beside a restaurant's name reads as a service-status control — as though
// pressing it marks the room open for business — and no amount of menu
// copy undoes that first impression. The links to the POS and the floor
// manager live in a labelled panel on the overview instead, where they can
// say what they are.
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
  restaurantName, children,
}: {
  restaurantName: string;
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

