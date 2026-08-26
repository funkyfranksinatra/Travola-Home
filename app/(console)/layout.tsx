// app/(console)/layout.tsx — the signed-in frame.
//
// Server component: it resolves the tenant and the chosen style once, on
// the server, so the nav renders with the restaurant's name in the first
// paint rather than flashing "Console" and then correcting itself.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/prisma";
import { CONSOLE_SESSION_COOKIE, restaurantIdFromCookieValue } from "@/lib/session";
import { resolveStyle, STYLE_COOKIE } from "@/lib/style";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const restaurantId = restaurantIdFromCookieValue(jar.get(CONSOLE_SESSION_COOKIE)?.value);
  if (!restaurantId) redirect("/login");

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  // A valid signature for a restaurant that no longer exists means the
  // account was deleted while this browser held a cookie. Send them back
  // to the login screen rather than rendering an empty shell.
  if (!restaurant) redirect("/login");

  return (
    <Shell
      restaurantName={restaurant.name}
      style={resolveStyle(jar.get(STYLE_COOKIE)?.value)}
      links={{
        floor: process.env.NEXT_PUBLIC_FLOOR_URL ?? "",
        pos: process.env.NEXT_PUBLIC_POS_URL ?? "",
      }}
    >
      {children}
    </Shell>
  );
}
