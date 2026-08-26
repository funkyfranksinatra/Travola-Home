"use client";

// components/FloorPlan.tsx — the restaurant's own room, drawn from its data.
//
// This is the Console's most important picture, and the reason is not
// decoration: an owner opening a management page recognises their own
// dining room instantly, and recognising it is what makes the numbers
// beside it feel like they are about *their* restaurant rather than about
// a spreadsheet.
//
// Geometry comes from the same helpers the POS uses (lib/floor-geometry),
// so a table drawn here is the same size and rotation it is on the floor
// app and the terminal. The room is scaled to fit its container from the
// bounding box of the tables themselves — there is no stored canvas size.
//
// A restaurant that has not built a floor plan yet gets a clearly-labelled
// TEMPLATE room instead of an empty box, so the page still shows what this
// panel is for.
import { rotatedSizePx, tileSizePx } from "@/lib/floor-geometry";

export type PlanTable = {
  id: string;
  name: string;
  capacity: number;
  shape: string;
  area: string;
  x: number;
  y: number;
  rotation: number;
};

/** A generic 14-table room, used only when the restaurant has none. */
const TEMPLATE: PlanTable[] = [
  { id: "t1", name: "1", capacity: 2, shape: "square", area: "dining", x: 40, y: 40, rotation: 0 },
  { id: "t2", name: "2", capacity: 2, shape: "square", area: "dining", x: 150, y: 40, rotation: 0 },
  { id: "t3", name: "3", capacity: 4, shape: "square", area: "dining", x: 260, y: 30, rotation: 0 },
  { id: "t4", name: "4", capacity: 4, shape: "square", area: "dining", x: 390, y: 30, rotation: 0 },
  { id: "t5", name: "5", capacity: 6, shape: "rectangle", area: "dining", x: 520, y: 34, rotation: 0 },
  { id: "t6", name: "6", capacity: 4, shape: "round", area: "dining", x: 40, y: 170 },
  { id: "t7", name: "7", capacity: 4, shape: "round", area: "dining", x: 170, y: 170, rotation: 0 },
  { id: "t8", name: "8", capacity: 6, shape: "round", area: "dining", x: 300, y: 165, rotation: 0 },
  { id: "t9", name: "9", capacity: 8, shape: "rectangle", area: "dining", x: 450, y: 170, rotation: 0 },
  { id: "t10", name: "10", capacity: 2, shape: "square", area: "bar", x: 40, y: 310, rotation: 0 },
  { id: "t11", name: "11", capacity: 2, shape: "square", area: "bar", x: 130, y: 310, rotation: 0 },
  { id: "t12", name: "12", capacity: 2, shape: "square", area: "bar", x: 220, y: 310, rotation: 0 },
  { id: "t13", name: "13", capacity: 4, shape: "square", area: "patio", x: 380, y: 310, rotation: 0 },
  { id: "t14", name: "14", capacity: 4, shape: "square", area: "patio", x: 500, y: 310, rotation: 0 },
].map((t) => ({ rotation: 0, ...t })) as PlanTable[];

const AREA_TONE: Record<string, { fill: string; stroke: string; text: string }> = {
  dining: { fill: "rgba(129,140,248,0.14)", stroke: "rgba(129,140,248,0.42)", text: "#c7cbfb" },
  bar:    { fill: "rgba(224,176,99,0.13)",  stroke: "rgba(224,176,99,0.40)",  text: "#eed3a5" },
  patio:  { fill: "rgba(82,199,148,0.13)",  stroke: "rgba(82,199,148,0.38)",  text: "#a9e3c7" },
  lounge: { fill: "rgba(168,150,224,0.13)", stroke: "rgba(168,150,224,0.38)", text: "#d3c9ef" },
};
const toneFor = (area: string) => AREA_TONE[area] ?? AREA_TONE.dining;

export function FloorPlan({ tables, showLegend = true }: {
  tables: PlanTable[];
  showLegend?: boolean;
}) {
  const isTemplate = tables.length === 0;
  const room = isTemplate ? TEMPLATE : tables;

  // Bounding box from the painted footprints, so a rotated communal table
  // cannot push the room off its own canvas.
  const boxes = room.map((table) => {
    const size = rotatedSizePx(table.shape, table.capacity, table.rotation ?? 0);
    return { table, size, left: table.x, top: table.y, right: table.x + size.w, bottom: table.y + size.h };
  });
  const PAD = 28;
  const minX = Math.min(...boxes.map((b) => b.left)) - PAD;
  const minY = Math.min(...boxes.map((b) => b.top)) - PAD;
  const width = Math.max(...boxes.map((b) => b.right)) + PAD - minX;
  const depth = Math.max(...boxes.map((b) => b.bottom)) + PAD - minY;

  const areas = [...new Set(room.map((t) => t.area))];
  const seats = room.reduce((sum, t) => sum + (t.capacity || 0), 0);

  // The panel takes the ROOM's proportions rather than a fixed height, so
  // the drawing fills the width instead of letterboxing with a band of
  // empty floor down each side — which reads as a rendering fault rather
  // than as a room. Capped so a very deep room cannot push the rest of the
  // page below the fold.
  // Clamped, not free: a `max-height` cap on an aspect-ratio box makes the
  // browser shrink the WIDTH to keep the ratio, which left the drawing in
  // the left half of its card. Clamping the ratio itself keeps the panel
  // full width and merely bounds how tall a very deep room can get.
  //
  // The bounds are the panel's, not the room's: a near-square dining room
  // given its own proportions inside a wide card became 800px tall and
  // pushed everything else below the fold, while letting the card's own
  // 3:1 shape win left the drawing marooned between two bands of empty
  // floor. Between 1.8 and 2.8 both failure modes stay off the page.
  const aspect = Math.min(2.8, Math.max(1.8, width / depth));

  return (
    <figure className="m-0">
      <div
        className="relative rounded-xl overflow-hidden bg-bg border border-border"
        style={{ aspectRatio: `${aspect}`, minHeight: 200 }}
      >
        {/* A faint floor grid. Purely orienting — it is what makes the room
            read as a room rather than as scattered rectangles. */}
        <svg
          viewBox={`${minX} ${minY} ${width} ${depth}`}
          preserveAspectRatio="xMidYMid meet"
          className="w-full h-full"
          role="img"
          aria-label={
            isTemplate
              ? "Example floor plan — this restaurant has not built one yet"
              : `Floor plan: ${room.length} tables, ${seats} seats`
          }
        >
          <defs>
            <pattern id="floor-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M40 0H0V40" fill="none" stroke="rgba(244,244,245,0.045)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect x={minX} y={minY} width={width} height={depth} fill="url(#floor-grid)" />

          {boxes.map(({ table }) => {
            const { w, h } = tileSizePx(table.shape, table.capacity);
            const tone = toneFor(table.area);
            const rotation = table.rotation ?? 0;
            const cx = table.x + w / 2;
            const cy = table.y + h / 2;
            const round = table.shape === "round";
            return (
              <g key={table.id} transform={`rotate(${rotation} ${cx} ${cy})`}>
                {round ? (
                  <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth="2" />
                ) : (
                  <rect x={table.x} y={table.y} width={w} height={h} rx="10" fill={tone.fill} stroke={tone.stroke} strokeWidth="2" />
                )}
                {/* Counter-rotated so a turned table's number still reads
                    the right way up. */}
                <g transform={`rotate(${-rotation} ${cx} ${cy})`}>
                  <text x={cx} y={cy - 3} textAnchor="middle" dominantBaseline="middle"
                    fill={tone.text} fontSize="19" fontWeight="650" letterSpacing="-0.5">
                    {table.name}
                  </text>
                  <text x={cx} y={cy + 16} textAnchor="middle" dominantBaseline="middle"
                    fill="rgba(161,161,170,0.85)" fontSize="12" fontWeight="500">
                    {table.capacity}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        {isTemplate ? (
          <div className="absolute inset-x-0 bottom-0 bg-panel/90 border-t border-border px-4 py-2.5 backdrop-blur">
            <p className="text-sm text-ink-50">This is an example room.</p>
            <p className="text-xs text-ink-400 mt-0.5">
              Build your floor plan in the floor manager and it appears here.
            </p>
          </div>
        ) : null}
      </div>

      {showLegend ? (
        <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-ink-400">
          {areas.map((area) => (
            <span key={area} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: toneFor(area).fill, border: `1px solid ${toneFor(area).stroke}` }} />
              <span className="capitalize">{area}</span>
            </span>
          ))}
          <span className="ml-auto tabular-nums">
            {room.length} tables · {seats} seats
            {isTemplate ? " (example)" : ""}
          </span>
        </figcaption>
      ) : null}
    </figure>
  );
}
