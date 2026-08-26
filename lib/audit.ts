// lib/audit.ts — the Console's record of who did what.
//
// Best-effort by design: an audit write must never fail the act it
// describes (an owner cancelling a subscription should not be blocked by
// a logging hiccup). But it is written on EVERY consequential act, and
// the failure is logged loudly enough to notice.
import { prisma } from "./prisma";
import { clientKey } from "./restaurant-auth";

export type AuditAction =
  | "auth.sign_in"
  | "auth.admin_verified"
  | "credentials.passcode_rotated"
  | "credentials.admin_passcode_set"
  | "staff.pin_reset"
  | "staff.deactivated"
  | "staff.reactivated"
  | "plan.change"
  | "plan.cancel"
  | "plan.resume"
  | "billing.contact_updated"
  | "data.export"
  | "data.delete";

export async function audit(opts: {
  restaurantId: string;
  action: AuditAction;
  summary: string;
  actor?: string;
  detail?: unknown;
  req?: Request;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        restaurantId: opts.restaurantId,
        action: opts.action,
        actor: opts.actor ?? "owner",
        summary: opts.summary,
        detail: (opts.detail ?? undefined) as never,
        ip: opts.req ? clientKey(opts.req) : "",
      },
    });
  } catch (error) {
    console.warn("[audit] write failed:", error);
  }
}
