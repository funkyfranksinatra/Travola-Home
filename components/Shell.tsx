"use client";

// components/Shell.tsx — the frame every screen sits in.
//
// The Console's job is to be the SIMPLE page in front of two complicated
// ones, so the frame does three things and no more: say where you are,
// get you into the floor manager or the POS in one click, and get out of
// the way. The launcher is given real prominence rather than being buried
// in a menu, because "open the POS" is the single most common reason a
// manager lands here at all.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { STYLE_META, STYLES, type StyleKey } from "@/lib/style";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/analysis", label: "Analysis" },
  { href: "/predictions", label: "Predictions" },
  { href: "/staff", label: "Logins" },
  { href: "/billing", label: "Plan & billing" },
  { href: "/data", label: "Data" },
];

export function Shell({
  restaurantName, style, links, children,
}: {
  restaurantName: string;
  style: StyleKey;
  links: { floor: string; pos: string };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  async function chooseStyle(next: StyleKey) {
    setBusy(true);
    await fetch("/api/style", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style: next }),
    });
    window.location.reload();
  }

  async function signOut() {
    await fetch("/api/auth", { method: "DELETE" });
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-screen" style={{ gap: "var(--shell-gap)" }}>
      <nav
        className="tv-no-print shrink-0 bg-panel border-r border-border flex flex-col"
        style={{ width: "var(--nav-width)" }}
      >
        <div className="px-4 py-5 border-b border-border">
          <p className="tv-label">Travola</p>
          <p className="tv-heading text-ink-50 mt-0.5 truncate" title={restaurantName}>
            {restaurantName || "Console"}
          </p>
        </div>

        <ul className="flex-1 py-3">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block px-4 py-2 text-sm border-l-2 ${
                    active
                      ? "border-ai text-ink-50 bg-ai-muted"
                      : "border-transparent text-ink-400 hover:text-ink-50 hover:bg-panel-up/40"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="px-3 py-3 border-t border-border space-y-2">
          <p className="tv-label px-1">Open</p>
          <LaunchLink href={links.floor} label="Floor manager" hint="Reservations, waitlist, sections" />
          <LaunchLink href={links.pos} label="POS" hint="Orders, kitchen, checks" />
        </div>

        <details className="px-3 py-3 border-t border-border">
          <summary className="tv-label cursor-pointer select-none px-1">Appearance</summary>
          <div className="mt-2 space-y-1">
            {STYLES.map((key) => (
              <button
                key={key}
                type="button"
                disabled={busy}
                onClick={() => chooseStyle(key)}
                className={`w-full text-left rounded-md px-2 py-1.5 text-xs ${
                  style === key ? "bg-ai-bg text-ai" : "text-ink-400 hover:text-ink-50 hover:bg-panel-up/40"
                }`}
                title={STYLE_META[key].blurb}
              >
                {STYLE_META[key].name}
                {style === key ? " ·" : ""}
              </button>
            ))}
            <p className="text-[11px] text-ink-400/70 px-2 pt-1 leading-relaxed">
              Three designs, one palette. Pick one and the others can be removed.
            </p>
          </div>
        </details>

        <div className="px-3 pb-4">
          <button
            type="button"
            onClick={signOut}
            className="w-full text-left px-2 py-1.5 text-xs text-ink-400 hover:text-ink-50"
          >
            Sign out
          </button>
        </div>
      </nav>

      <main className="flex-1 min-w-0 px-6 py-6 max-w-[1500px]">{children}</main>
    </div>
  );
}

function LaunchLink({ href, label, hint }: { href: string; label: string; hint: string }) {
  if (!href) {
    return (
      <span className="block rounded-lg px-2 py-1.5 text-xs text-ink-400/60" title="Set the URL in this app's environment variables">
        {label} — not linked yet
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block rounded-lg px-2 py-1.5 hover:bg-panel-up/50"
    >
      <span className="block text-sm text-ink-50">{label} ↗</span>
      <span className="block text-[11px] text-ink-400">{hint}</span>
    </a>
  );
}
