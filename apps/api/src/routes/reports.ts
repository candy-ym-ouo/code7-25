import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reportCreateSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { conflict, notFound } from "../errors";
import { requireAuth } from "../auth";
import { recordAudit } from "../audit";
import { notifyUser } from "../notifications";
import {
  REPORT_HIDE_THRESHOLD,
  countOpenReports,
  hideTarget,
  lockTarget,
  type ReportTargetType
} from "../moderation-state";

export async function reportRoutes(app: FastifyInstance) {
  app.post("/reports", { preHandler: requireAuth }, async (request, reply) => {
    const input = reportCreateSchema.parse(request.body);
    const targetType = input.targetType as ReportTargetType;
    const reportId = await transaction(async (client) => {
      // Lock the target first. The row lock serializes concurrent reports for
      // the same item, so every transaction counts the previous reports already
      // committed by the ones ahead of it in the queue.
      const target = await lockTarget(client, targetType, input.targetId);
      // Only currently public content is reportable; hidden or non-public
      // items are reported as 404 so the endpoint never leaks their existence.
      if (target.status !== "published") {
        throw notFound(targetType === "feature" ? "Feature not found" : "Comment not found");
      }

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
      if (openReports >= REPORT_HIDE_THRESHOLD) {
        const hide = await hideTarget(client, targetType, input.targetId);
        if (hide.changed) {
          await recordAudit(client, {
            actorId: null,
            action: "report.threshold_hidden",
            resourceType: targetType,
            resourceId: input.targetId,
            metadata: { openReports, threshold: REPORT_HIDE_THRESHOLD }
          });
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
