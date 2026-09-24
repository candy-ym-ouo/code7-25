import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reportCreateSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { conflict, notFound } from "../errors";
import { requireAuth } from "../auth";
import { recordAudit } from "../audit";
import { notifyUser } from "../notifications";
import {
  REPORT_THRESHOLD,
  type ReportTargetType,
  countOpenReports,
  hideTarget,
  lockReportTarget,
  notifyTargetHidden
} from "../moderation-state";

export async function reportRoutes(app: FastifyInstance) {
  app.post("/reports", { preHandler: requireAuth }, async (request, reply) => {
    const input = reportCreateSchema.parse(request.body);
    const targetType: ReportTargetType = input.targetType;
    const reportId = await transaction(async (client) => {
      // 先锁定目标行再插入举报：并发举报在此排队，后续事务能看到前面已提交的
      // 举报行，open 计数与历史串行口径完全一致，达阈值必隐藏。
      const target = await lockReportTarget(client, targetType, input.targetId);
      if (!target || target.status !== "published") throw notFound(`${targetType} not found`);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reports(reporter_id, target_type, target_id, reason_code, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [request.user!.id, targetType, input.targetId, input.reasonCode, input.notes ?? null]
      ).catch((error: unknown) => {
        if (typeof error === "object" && error && "code" in error && error.code === "23505") {
          throw conflict("You already have an open report for this item");
        }
        throw error;
      });

      const openReports = await countOpenReports(client, targetType, input.targetId);
      if (openReports >= REPORT_THRESHOLD) {
        const hidden = await hideTarget(client, targetType, input.targetId, {
          actorId: null,
          reasonCode: "report_threshold",
          metadata: { openReports, threshold: REPORT_THRESHOLD, triggerReportId: inserted.rows[0]!.id }
        });
        if (hidden.changed) {
          await recordAudit(client, {
            actorId: null,
            action: "report.threshold_hidden",
            resourceType: targetType,
            resourceId: input.targetId,
            metadata: { openReports, threshold: REPORT_THRESHOLD, triggerReportId: inserted.rows[0]!.id }
          });
          await notifyTargetHidden(
            client,
            targetType,
            hidden.ownerId,
            `内容因收到 ${openReports} 个有效举报已被临时隐藏，审核员会结合举报理由进行判断。`
          );
        }
      }
      if (target.owner_id !== request.user!.id) {
        await notifyUser(client, {
          userId: target.owner_id,
          type: "content_reported",
          title: "你的内容收到举报",
          body: "内容已进入审核流程，审核员会结合举报理由进行判断。",
          link: targetType === "feature" ? `/features/${input.targetId}` : "/me/comments"
        });
      }
      return inserted.rows[0]!.id;
    });
    return reply.code(201).send({ id: reportId, status: "open" });
  });

  app.get("/me/notifications", { preHandler: requireAuth }, async (request) => {
    const result = await query(
      `SELECT id, type, title, body, link, read_at, created_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [request.user!.id]
    );
    return result.rows;
  });

  app.post("/me/notifications/:id/read", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id",
      [params.id, request.user!.id]
    );
    if (!result.rowCount) throw notFound("Notification not found");
    return { status: "read" };
  });
}
