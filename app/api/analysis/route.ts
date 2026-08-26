// app/api/analysis/route.ts — the analysis tab's one data call.
//
// A single grouped-SQL pass, returned whole. It is deliberately not split
// per metric: an owner changing the date range should see the page change
// once, not watch twenty cards arrive in a random order.
import { buildAnalysis, type RangeKey } from "@/lib/analytics/analysis";
import { withTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RANGES: RangeKey[] = ["30d", "90d", "365d", "all", "custom"];

export async function GET(request: Request) {
  return withTenant(request, async (restaurantId) => {
    const url = new URL(request.url);
    const requested = url.searchParams.get("range") ?? "90d";
    const range = (RANGES as string[]).includes(requested) ? (requested as RangeKey) : "90d";
    const result = await buildAnalysis({
      restaurantId,
      range,
      custom: { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined },
    });
    return Response.json(result);
  });
}
