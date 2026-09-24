import type { PoolClient } from "pg";
import { conflict, notFound } from "./errors";

export type ReportTargetType = "feature" | "comment";
export const REPORT_HIDE_THRESHOLD = 3;

type TargetRow = {
  id: string;
  status: string;
  owner_id: string;
  deleted_at: Date | null;
  current_revision_id?: string | null;
};

const tableName = (targetType: ReportTargetType): "map_features" | "comments" =>
  targetType === "feature" ? "map_features" : "comments";

/**
 * Lock the moderation target row for the duration of the transaction.
 *
 * Every report-driven read-modify-write must go through this lock so that
 * concurrent reports against the same target are serialized: without it two
 * backends can both count the same pre-threshold snapshot and both skip the
 * automatic hide, leaving reported content public past the threshold.
 */
export async function lockTarget(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string
): Promise<TargetRow> {
  const table = tableName(targetType);
  const result = await client.query<TargetRow>(
    `SELECT id, status, owner_id, deleted_at${targetType === "feature" ? ", current_revision_id" : ", NULL::uuid AS current_revision_id"}
     FROM ${table} WHERE id = $1 FOR UPDATE`,
    [targetId]
  );
  const target = result.rows[0];
  if (!target || target.deleted_at) throw notFound(targetType === "feature" ? "Feature not found" : "Comment not found");
  return target;
}

export async function countOpenReports(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM reports
     WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
    [targetType, targetId]
  );
  return result.rows[0]!.count;
}

/**
 * Hide a moderation target. Only published content can be hidden; an
 * already-hidden target is an idempotent no-op so repeated moderator actions
 * (or a threshold auto-hide racing a manual hide) do not create duplicate
 * audit rows or notifications. Deleted targets are never revived.
 * Returns whether the status actually transitioned in this call.
 */
export async function hideTarget(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string
): Promise<{ changed: boolean; previousStatus: string }> {
  const table = tableName(targetType);
  const current = await client.query<{ status: string; deleted_at: Date | null }>(
    `SELECT status, deleted_at FROM ${table} WHERE id = $1 FOR UPDATE`,
    [targetId]
  );
  const row = current.rows[0];
  if (!row || row.deleted_at) throw notFound(targetType === "feature" ? "Feature not found" : "Comment not found");
  if (row.status === "hidden") return { changed: false, previousStatus: "hidden" };
  if (row.status !== "published") throw conflict("Only published content can be hidden");

  await client.query(
    `UPDATE ${table} SET status = 'hidden', updated_at = now() WHERE id = $1`,
    [targetId]
  );
  return { changed: true, previousStatus: "published" };
}

/**
 * Restore a hidden target to public visibility. Used by admin restore and by
 * report resolution with an explicit restore decision.
 *
 * Every other open report belonging to the moderation round that justified
 * the hide is dismissed here. Otherwise those historical open reports stay
 * counted and the very first new report after restore immediately re-hides
 * the content, mixing already-adjudicated history with the fresh round.
 *
 * The report that triggered the resolution is skipped (its final status is
 * decided by the caller). Returns how many sibling reports were dismissed.
 */
export async function restoreTarget(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string,
  options: { reviewerId: string; keepReportId?: string }
): Promise<{ restored: boolean; previousStatus: string; siblingsDismissed: number }> {
  const table = tableName(targetType);
  const current = await client.query<{ status: string; deleted_at: Date | null; current_revision_id: string | null }>(
    `SELECT status, deleted_at${targetType === "feature" ? ", current_revision_id" : ", NULL::uuid AS current_revision_id"}
     FROM ${table} WHERE id = $1 FOR UPDATE`,
    [targetId]
  );
  const row = current.rows[0];
  if (!row || row.deleted_at) throw notFound(targetType === "feature" ? "Feature not found" : "Comment not found");
  if (targetType === "feature" && !row.current_revision_id) {
    throw conflict("Target has no approved revision");
  }
  if (!["hidden", "published"].includes(row.status)) {
    throw conflict("Only hidden content can be restored");
  }

  if (row.status === "hidden") {
    await client.query(
      `UPDATE ${table} SET status = 'published', updated_at = now() WHERE id = $1`,
      [targetId]
    );
  }

  const remaining = await client.query<{ id: string }>(
    `UPDATE reports
     SET status = 'dismissed', resolved_by = $2, resolved_at = now()
     WHERE target_type = $1 AND target_id = $3 AND status = 'open'
       AND ($4::uuid IS NULL OR id <> $4)
     RETURNING id`,
    [targetType, options.reviewerId, targetId, options.keepReportId ?? null]
  );

  return {
    restored: row.status === "hidden",
    previousStatus: row.status,
    siblingsDismissed: remaining.rowCount ?? 0
  };
}

/**
 * Close every open report for a target as part of an explicit moderator
 * decision (manual hide, or approval of a revision that brings a hidden
 * feature back to public). The current report is skipped when the caller is
 * already resolving it to a different status.
 */
export async function dismissOpenReports(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string,
  reviewerId: string,
  exceptReportId?: string
): Promise<number> {
  const result = await client.query(
    `UPDATE reports
     SET status = 'dismissed', resolved_by = $3, resolved_at = now()
     WHERE target_type = $1 AND target_id = $2 AND status = 'open'
       AND ($4::uuid IS NULL OR id <> $4)
     RETURNING id`,
    [targetType, targetId, reviewerId, exceptReportId ?? null]
  );
  return result.rowCount ?? 0;
}
