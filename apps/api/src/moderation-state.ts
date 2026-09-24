import type { PoolClient } from "pg";
import { conflict, notFound } from "./errors";
import { recordAudit } from "./audit";
import { notifyUser } from "./notifications";

/**
 * 举报阈值的唯一口径：同一目标下 status='open' 的不同举报人数。
 * 历史串行调用与多人并发调用必须得到同一个提交后计数，
 * 因此所有依赖该计数的流程都必须先持有目标行的行级锁（见 lockReportTarget）。
 */
export const REPORT_THRESHOLD = 3;

export type ReportTargetType = "feature" | "comment";

type TargetRow = {
  id: string;
  owner_id: string;
  status: string;
};

const TABLES: Record<ReportTargetType, { table: string; ownerColumn: string; link: string }> = {
  feature: { table: "map_features", ownerColumn: "owner_id", link: "/me/contributions" },
  comment: { table: "comments", ownerColumn: "author_id", link: "/me/comments" }
};

/**
 * 锁定举报目标并返回当前状态。
 * 针对同一目标的举报/审核操作在此串行化，保证阈值计数在并发下与历史口径一致。
 * 必须在插入举报、隐藏或恢复目标之前调用。
 */
export async function lockReportTarget(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string
): Promise<TargetRow | null> {
  const { table, ownerColumn } = TABLES[targetType];
  const result = await client.query<TargetRow>(
    `SELECT id, ${ownerColumn} AS owner_id, status
     FROM ${table} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [targetId]
  );
  return result.rows[0] ?? null;
}

/**
 * 统一的 open 举报计数。调用方必须已通过 lockReportTarget 持锁，
 * 否则并发事务无法看到彼此未提交的举报行，会退回到错误的快照口径。
 */
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
 * 隐藏目标。仅 published 内容可被隐藏：对已经隐藏的内容幂等返回 false，
 * 让调用方避免重复审计与重复通知；处于其它中间状态（pending/rejected/deleted）
 * 的内容本来就不公开，拒绝显式隐藏以免互相覆盖审核状态。
 */
export async function hideTarget(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string,
  context: { reasonCode: string; actorId: string | null; metadata?: Record<string, unknown> }
): Promise<{ changed: boolean; ownerId: string }> {
  const { table } = TABLES[targetType];
  const result = await client.query<{ owner_id: string; status: string }>(
    `UPDATE ${table} SET status = 'hidden', updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL AND status = 'published'
     RETURNING ${TABLES[targetType].ownerColumn} AS owner_id, status`,
    [targetId]
  );
  const row = result.rows[0];
  if (!row) {
    const current = await lockReportTarget(client, targetType, targetId);
    if (!current) throw notFound(`${targetType} not found`);
    if (current.status === "hidden") return { changed: false, ownerId: current.owner_id };
    throw conflict(`Cannot hide a ${targetType} in status '${current.status}'`);
  }
  await recordAudit(client, {
    actorId: context.actorId,
    action: `${targetType}.hidden`,
    resourceType: targetType,
    resourceId: targetId,
    metadata: { reasonCode: context.reasonCode, ...context.metadata }
  });
  return { changed: true, ownerId: row.owner_id };
}

/**
 * 恢复目标为公开。恢复的统一口径：仍有达到阈值的 open 举报时不得恢复，
 * 审核员必须先逐条处理（resolve/dismiss）举报，避免“处理完一条就公开、
 * 风险举报仍然成立”的状态倒挂。
 */
export async function restoreTarget(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string,
  context: { actorId: string; metadata?: Record<string, unknown> }
): Promise<{ ownerId: string }> {
  const target = await lockReportTarget(client, targetType, targetId);
  if (!target) throw notFound(`${targetType} not found`);
  if (target.status !== "hidden") {
    throw conflict("Only hidden content can be restored");
  }
  if (targetType === "feature") {
    const revision = await client.query<{ current_revision_id: string | null }>(
      "SELECT current_revision_id FROM map_features WHERE id = $1",
      [targetId]
    );
    if (!revision.rows[0]!.current_revision_id) throw conflict("Feature has no approved revision");
  }
  const openReports = await countOpenReports(client, targetType, targetId);
  if (openReports >= REPORT_THRESHOLD) {
    throw conflict(`Cannot restore while ${openReports} open reports remain above the threshold`);
  }
  await client.query(
    `UPDATE ${TABLES[targetType].table} SET status = 'published', updated_at = now() WHERE id = $1`,
    [targetId]
  );
  await recordAudit(client, {
    actorId: context.actorId,
    action: `${targetType}.restored`,
    resourceType: targetType,
    resourceId: targetId,
    metadata: { openReports, ...context.metadata }
  });
  return { ownerId: target.owner_id };
}

/** 内容被隐藏时通知所有者，阈值自动隐藏与人工隐藏走同一文案与留痕口径。 */
export async function notifyTargetHidden(
  client: PoolClient,
  targetType: ReportTargetType,
  ownerId: string,
  detail: string
): Promise<void> {
  await notifyUser(client, {
    userId: ownerId,
    type: `${targetType}_hidden`,
    title: targetType === "feature" ? "你的地点细节已被隐藏" : "你的评论已被隐藏",
    body: detail,
    link: TABLES[targetType].link
  });
}

/** 内容恢复公开时通知所有者。 */
export async function notifyTargetRestored(
  client: PoolClient,
  targetType: ReportTargetType,
  ownerId: string
): Promise<void> {
  await notifyUser(client, {
    userId: ownerId,
    type: `${targetType}_restored`,
    title: targetType === "feature" ? "你的地点细节已恢复公开" : "你的评论已恢复公开",
    body: "审核员复核后内容已重新公开。",
    link: TABLES[targetType].link
  });
}
