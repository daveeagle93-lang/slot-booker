import { toCsv } from "../../../../../core/csv";
import { utcToLondon } from "../../../../../core/london";
import { editFailed, eventNotFound } from "../../../../../server/admin-event-edit";
import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import type { RouteHandler } from "../../../../../server/env";
import { loadEventBySlug } from "../../../../../server/events";
import { apiHeaders } from "../../../../../server/http";

interface Row { slot_start_utc: string; dog_name: string; handler_name: string; created_at: string }

const london = (iso: string): string => {
  const { date, time } = utcToLondon(iso);
  return `${date} ${time}`;
};

/**
 * The event's bookings as a CSV download (Time, Dog, Handler, Booked at; London time; by slot start). One query.
 * Names are user input, so toCsv guards every cell against spreadsheet formulas. The file name is the slug,
 * which loadEventBySlug has already limited to letters, digits, hyphens and underscores, so it can't break the header.
 */
export const onRequestGet: RouteHandler<"slug"> = async ({ env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const { results } = await env.DB
      .prepare("SELECT slot_start_utc, value_1 AS dog_name, value_2 AS handler_name, created_at FROM bookings WHERE event_id = ? ORDER BY slot_start_utc, lane_id, place")
      .bind(event.id)
      .all<Row>();
    const csv = toCsv([
      ["Time", "Dog", "Handler", "Booked at"],
      ...results.map((r) => [london(r.slot_start_utc), r.dog_name, r.handler_name, london(r.created_at)]),
    ]);
    return new Response(csv, {
      headers: {
        ...apiHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${event.slug}-bookings.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return editFailed("exportBookings", e);
  }
};
