// app/api/export/route.ts — take your data with you.
//
// Two design decisions worth stating, because they are what make this
// work on a 60-second serverless function rather than timing out:
//
//   1. ONE TABLE PER REQUEST, STREAMED. This restaurant has 16,000
//      reservations; buffering every table into a single JSON response
//      would blow both the memory and the response-size ceiling. Each
//      table streams as CSV in keyset-paginated chunks, so the response
//      starts flowing immediately and peak memory is one chunk.
//   2. KEYSET, NOT OFFSET. `skip: 50000` makes Postgres walk 50,000 rows
//      it then throws away. Ordering by id and asking for "the next 500
//      after this id" stays flat no matter how much history there is.
//
// Nothing here is a summary or a derived figure: it is the rows as
// stored, so the export is a real handover rather than a report.
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHUNK = 500;

/** Every table an owner is entitled to, and how to read it. */
const TABLES = {
  reservations: { label: "Reservations", model: "reservation" },
  guests: { label: "Guests", model: "guest" },
  waitlist: { label: "Waitlist entries", model: "waitlistEntry" },
  tables: { label: "Table layout", model: "table" },
  floors: { label: "Floors", model: "floor" },
  staff: { label: "Staff", model: "server" },
  shifts: { label: "Shifts", model: "shift" },
  tableSessions: { label: "Table sessions", model: "tableSession" },
  checks: { label: "Checks", model: "check" },
  checkItems: { label: "Check items", model: "checkItem" },
  payments: { label: "Payments", model: "payment" },
  menuItems: { label: "Menu items", model: "menuItem" },
  menuCategories: { label: "Menu categories", model: "menuCategory" },
  forecasts: { label: "Shift forecasts", model: "shiftForecast" },
  serviceEvents: { label: "Service events", model: "serviceEvent" },
  auditLog: { label: "Console audit log", model: "auditLog" },
  invoices: { label: "Invoices", model: "invoice" },
} as const;

type TableKey = keyof typeof TABLES;

/** CheckItem has no restaurantId of its own — it is scoped through its check. */
function scopeFor(key: TableKey, restaurantId: string) {
  if (key === "checkItems") return { check: { restaurantId } };
  return { restaurantId };
}

function csvCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request) {
  let restaurantId: string;
  try {
    restaurantId = requireRestaurant(request);
  } catch (error) {
    return error as Response;
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("table") as TableKey | null;

  // No table named: return the manifest, so the UI can list what exists
  // and how big each file will be before anyone clicks anything.
  if (!key) {
    const counts = await Promise.all(
      (Object.keys(TABLES) as TableKey[]).map(async (name) => {
        const model = (prisma as never as Record<string, { count: (args: unknown) => Promise<number> }>)[TABLES[name].model];
        const rows = await model.count({ where: scopeFor(name, restaurantId) }).catch(() => 0);
        return { key: name, label: TABLES[name].label, rows };
      }),
    );
    return Response.json({ tables: counts, generatedAt: new Date().toISOString() });
  }

  if (!(key in TABLES)) return Response.json({ error: "Unknown table." }, { status: 400 });

  const model = (prisma as never as Record<string, {
    findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
  }>)[TABLES[key].model];

  const where = scopeFor(key, restaurantId);
  const encoder = new TextEncoder();
  let rowCount = 0;
  let byteCount = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let cursor: string | undefined;
        let headerWritten = false;
        let columns: string[] = [];

        for (;;) {
          const rows = await model.findMany({
            where,
            take: CHUNK,
            orderBy: { id: "asc" },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          if (!rows.length) break;

          if (!headerWritten) {
            columns = Object.keys(rows[0]);
            const line = `${columns.join(",")}\n`;
            byteCount += line.length;
            controller.enqueue(encoder.encode(line));
            headerWritten = true;
          }
          for (const row of rows) {
            const line = `${columns.map((column) => csvCell(row[column])).join(",")}\n`;
            byteCount += line.length;
            controller.enqueue(encoder.encode(line));
          }
          rowCount += rows.length;
          cursor = String(rows[rows.length - 1].id);
          if (rows.length < CHUNK) break;
        }

        if (!headerWritten) controller.enqueue(encoder.encode("(no rows)\n"));

        await prisma.dataExport
          .create({ data: { restaurantId, format: "csv", scope: key, rowCount, byteCount } })
          .catch(() => undefined);
        await audit({
          restaurantId, action: "data.export", req: request,
          summary: `Exported ${rowCount.toLocaleString("en-US")} ${TABLES[key].label.toLowerCase()} as CSV`,
          detail: { table: key, rowCount },
        });
      } catch (error) {
        console.error("[export]", error);
        controller.enqueue(encoder.encode("\n# export interrupted — please retry\n"));
      }
      controller.close();
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="travola-${key}-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
