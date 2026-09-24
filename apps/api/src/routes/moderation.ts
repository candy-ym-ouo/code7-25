import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { moderationDecisionSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { conflict, notFound } from "../errors";
import { requireAdmin, requireModerator } from "../auth";
import { recordAudit } from "../audit";
import { notifyUser } from "../notifications";
import {
  dismissOpenReports,
  hideTarget,
  lockTarget,
  restoreTarget,
  type ReportTargetType
} from "../moderation-state";

export async function moderationRoutes(app: FastifyInstance) {
  app.get("/moderation/queue", { preHandler: requireModerator }, async () => {
    const [features, comments, media, reports] = await Promise.all([
      query(
        `SELECT fr.id AS revision_id, fr.feature_id, fr.revision_no, fr.payload, fr.submitted_at,
                mf.category_key, mf.status AS feature_status, u.display_name AS author_name
         FROM feature_revisions fr
         JOIN map_features mf ON mf.id = fr.feature_id
         JOIN users u ON u.id = fr.author_id
         WHERE fr.status = 'pending' AND mf.deleted_at IS NULL
         ORDER BY fr.submitted_at ASC
         LIMIT 100`
      ),
      query(
        `SELECT c.id, c.feature_id, c.body, c.status, c.created_at, u.display_name AS author_name
         FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.status = 'pending' AND c.deleted_at IS NULL
         ORDER BY c.created_at ASC LIMIT 100`
      ),
      query(
        `SELECT ma.id, ma.original_filename, ma.privacy_status, ma.privacy_report,
                ma.processed_object_key, ma.created_at, u.display_name AS owner_name
         FROM media_assets ma JOIN users u ON u.id = ma.owner_id
         WHERE ma.privacy_status = 'manual_review' AND ma.deleted_at IS NULL
         ORDER BY ma.created_at ASC LIMIT 100`
      ),
      query(
        `SELECT r.id, r.target_type, r.target_id, r.reason_code, r.notes, r.created_at,
                u.display_name AS reporter_name,
                CASE r.target_type
                  WHEN 'feature' THEN f.status
                  ELSE c.status
                END AS target_status,
                CASE
                  WHEN r.target_type = 'feature' THEN f.deleted_at IS NOT NULL
                  ELSE c.deleted_at IS NOT NULL
                END AS target_deleted
         FROM reports r
         JOIN users u ON u.id = r.reporter_id
         LEFT JOIN map_features f ON r.target_type = 'feature' AND f.id = r.target_id
         LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
         WHERE r.status = 'open'
         ORDER BY r.created_at ASC LIMIT 100`
      )
    ]);

    return {
      counts: {
        features: features.rowCount,
        comments: comments.rowCount,
        media: media.rowCount,
        reports: reports.rowCount
      },
      features: features.rows,
      comments: comments.rows,
      media: media.rows,
      reports: reports.rows
    };
  });

  app.post("/moderation/features/:id/approve", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const revisionResult = await client.query<{
        id: string;
        payload: { categoryKey: string; longitude: number; latitude: number; locationAccuracyM: number; mediaIds?: string[] };
        author_id: string;
      }>(
        `SELECT fr.id, fr.payload, fr.author_id
         FROM feature_revisions fr
         JOIN map_features mf ON mf.id = fr.feature_id
         WHERE fr.feature_id = $1 AND fr.status = 'pending' AND mf.deleted_at IS NULL
         ORDER BY fr.revision_no DESC LIMIT 1 FOR UPDATE`,
        [params.id]
      );
      const revision = revisionResult.rows[0];
      if (!revision) throw notFound("Pending revision not found");

      const mediaIds = revision.payload.mediaIds ?? [];
      if (mediaIds.length) {
        const media = await client.query<{ id: string; privacy_status: string }>(
          "SELECT id, privacy_status FROM media_assets WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
          [mediaIds]
        );
        if (media.rowCount !== mediaIds.length || media.rows.some((row) => row.privacy_status !== "ready")) {
          throw conflict("All attached media must pass privacy review before content approval");
        }
      }

      const featureBefore = await client.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 FOR UPDATE",
        [params.id]
      );
      const previousStatus = featureBefore.rows[0]?.status;

      await client.query(
        `UPDATE feature_revisions
         SET status = 'published', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = NULL, updated_at = now()
         WHERE id = $1`,
        [revision.id, request.user!.id]
      );
      await client.query(
        `UPDATE map_features
         SET current_revision_id = $2,
             status = 'published',
             category_key = $3,
             geom = ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
             location_accuracy_m = $6,
             first_published_at = COALESCE(first_published_at, now()),
             freshness_expires_at = now() + interval '180 days',
             needs_review_at = NULL,
             updated_at = now()
         WHERE id = $1`,
        [
          params.id,
          revision.id,
          revision.payload.categoryKey,
          revision.payload.longitude,
          revision.payload.latitude,
          revision.payload.locationAccuracyM
        ]
      );
      // A hidden feature only becomes public again through a moderator
      // decision; approving a revision is that decision, so the open reports
      // that justified the hide belong to the previous round and must not be
      // counted against the newly published version.
      const dismissedReports = previousStatus === "hidden"
        ? await dismissOpenReports(client, "feature", params.id, request.user!.id)
        : 0;
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.approved",
        resourceType: "feature",
        resourceId: params.id,
        metadata: {
          revisionId: revision.id,
          previousStatus,
          nextStatus: "published",
          dismissedOpenReports: dismissedReports
        }
      });
      await notifyUser(client, {
        userId: revision.author_id,
        type: "feature_approved",
        title: "你的地点细节已通过审核",
        body: "内容已发布到公共地图。",
        link: `/features/${params.id}`
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/features/:id/reject", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const revision = await activePendingRevision(client, params.id);
      await client.query(
        `UPDATE feature_revisions
         SET status = 'rejected', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = $3, moderation_notes = $4, updated_at = now()
         WHERE id = $1`,
        [revision.id, request.user!.id, input.reasonCode, input.notes ?? null]
      );
      await client.query(
        `UPDATE map_features
         SET status = CASE WHEN current_revision_id IS NULL THEN 'rejected'::content_status ELSE status END,
             updated_at = now()
         WHERE id = $1`,
        [params.id]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.rejected",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { revisionId: revision.id, reasonCode: input.reasonCode, notes: input.notes }
      });
      await notifyUser(client, {
        userId: revision.author_id,
        type: "feature_rejected",
        title: "你的地点细节未通过审核",
        body: `拒绝原因：${input.reasonCode}${input.notes ? `。${input.notes}` : ""}`,
        link: "/me/contributions"
      });
    });
    return { status: "rejected" };
  });

  app.post("/moderation/features/:id/request-changes", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const revision = await activePendingRevision(client, params.id);
      await client.query(
        `UPDATE feature_revisions
         SET status = 'changes_requested', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = $3, moderation_notes = $4, updated_at = now()
         WHERE id = $1`,
        [revision.id, request.user!.id, input.reasonCode, input.notes ?? null]
      );
      await client.query(
        `UPDATE map_features
         SET status = CASE WHEN current_revision_id IS NULL THEN 'changes_requested'::content_status ELSE status END,
             updated_at = now()
         WHERE id = $1`,
        [params.id]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.changes_requested",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { revisionId: revision.id, reasonCode: input.reasonCode }
      });
      await notifyUser(client, {
        userId: revision.author_id,
        type: "feature_changes_requested",
        title: "你的地点细节需要修改",
        body: `${input.reasonCode}${input.notes ? `：${input.notes}` : ""}`,
        link: "/me/contributions"
      });
    });
    return { status: "changes_requested" };
  });

  app.post("/moderation/features/:id/hide", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const before = await client.query<{ status: string; owner_id: string }>(
        "SELECT status, owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const current = before.rows[0];
      if (!current) throw notFound("Feature not found");
      if (current.status === "hidden") {
        return { alreadyHidden: true };
      }
      if (current.status !== "published") throw conflict("Only published content can be hidden");
      await hideTarget(client, "feature", params.id);
      const dismissedReports = await dismissOpenReports(client, "feature", params.id, request.user!.id);
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.hidden",
        resourceType: "feature",
        resourceId: params.id,
        metadata: {
          reasonCode: input.reasonCode,
          notes: input.notes,
          previousStatus: current.status,
          nextStatus: "hidden",
          dismissedOpenReports: dismissedReports
        }
      });
      await notifyUser(client, {
        userId: current.owner_id,
        type: "feature_hidden",
        title: "你的地点细节已被隐藏",
        body: `${input.reasonCode}${input.notes ? `：${input.notes}` : ""}`,
        link: "/me/contributions"
      });
    });
    return { status: "hidden" };
  });

  app.post("/moderation/features/:id/restore", { preHandler: requireAdmin }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await restoreTarget(client, "feature", params.id, { reviewerId: request.user!.id });
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.restored",
        resourceType: "feature",
        resourceId: params.id,
        metadata: {
          previousStatus: result.previousStatus,
          nextStatus: "published",
          dismissedOpenReports: result.siblingsDismissed
        }
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/comments/:id/approve", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await client.query<{ author_id: string }>(
        `UPDATE comments SET status = 'published', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = NULL, updated_at = now()
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL RETURNING author_id`,
        [params.id, request.user!.id]
      );
      const comment = result.rows[0];
      if (!comment) throw notFound("Pending comment not found");
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.approved",
        resourceType: "comment",
        resourceId: params.id
      });
      await notifyUser(client, {
        userId: comment.author_id,
        type: "comment_approved",
        title: "你的评论已通过审核",
        body: "评论已公开显示。",
        link: "/me/comments"
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/comments/:id/reject", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const result = await client.query<{ author_id: string }>(
        `UPDATE comments SET status = 'rejected', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = $3, updated_at = now()
         WHERE id = $1 AND status IN ('pending', 'published') AND deleted_at IS NULL RETURNING author_id`,
        [params.id, request.user!.id, input.reasonCode]
      );
      const comment = result.rows[0];
      if (!comment) throw notFound("Comment not found");
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.rejected",
        resourceType: "comment",
        resourceId: params.id,
        metadata: { reasonCode: input.reasonCode, notes: input.notes }
      });
      await notifyUser(client, {
        userId: comment.author_id,
        type: "comment_rejected",
        title: "你的评论未通过审核",
        body: `${input.reasonCode}${input.notes ? `：${input.notes}` : ""}`,
        link: "/me/comments"
      });
    });
    return { status: "rejected" };
  });

  app.post("/moderation/comments/:id/hide", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const before = await client.query<{ status: string; author_id: string }>(
        "SELECT status, author_id FROM comments WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const current = before.rows[0];
      if (!current) throw notFound("Comment not found");
      if (current.status === "hidden") return;
      if (current.status !== "published") throw conflict("Only published content can be hidden");
      await hideTarget(client, "comment", params.id);
      const dismissedReports = await dismissOpenReports(client, "comment", params.id, request.user!.id);
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.hidden",
        resourceType: "comment",
        resourceId: params.id,
        metadata: {
          reasonCode: input.reasonCode,
          notes: input.notes,
          previousStatus: current.status,
          nextStatus: "hidden",
          dismissedOpenReports: dismissedReports
        }
      });
      await notifyUser(client, {
        userId: current.author_id,
        type: "comment_hidden",
        title: "你的评论已被隐藏",
        body: `${input.reasonCode}${input.notes ? `：${input.notes}` : ""}`,
        link: "/me/comments"
      });
    });
    return { status: "hidden" };
  });

  app.post("/moderation/comments/:id/restore", { preHandler: requireAdmin }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await restoreTarget(client, "comment", params.id, { reviewerId: request.user!.id });
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.restored",
        resourceType: "comment",
        resourceId: params.id,
        metadata: {
          previousStatus: result.previousStatus,
          nextStatus: "published",
          dismissedOpenReports: result.siblingsDismissed
        }
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/reports/:id/resolve", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      status: z.enum(["resolved", "dismissed"]),
      action: z.enum(["none", "hide", "restore"]).default("none"),
      notes: z.string().trim().max(1000).optional()
    }).parse(request.body);

    await transaction(async (client) => {
      const reportResult = await client.query<{ target_type: ReportTargetType; target_id: string; reporter_id: string }>(
        "SELECT target_type, target_id, reporter_id FROM reports WHERE id = $1 AND status = 'open' FOR UPDATE",
        [params.id]
      );
      const report = reportResult.rows[0];
      if (!report) throw notFound("Open report not found");

      let previousTargetStatus: string | undefined;
      let nextTargetStatus: string | undefined;
      let siblingsDismissed = 0;

      if (input.action === "hide") {
        // Locking the target here prevents racing a concurrent report that is
        // itself holding the target lock for its threshold evaluation.
        const target = await lockTarget(client, report.target_type, report.target_id);
        previousTargetStatus = target.status;
        const hide = await hideTarget(client, report.target_type, report.target_id);
        nextTargetStatus = "hidden";
        if (hide.changed) {
          // The other open reports belong to the same moderation round and are
          // covered by this explicit decision; close them with a single audit.
          siblingsDismissed = await dismissOpenReports(
            client,
            report.target_type,
            report.target_id,
            request.user!.id,
            params.id
          );
        }
      }

      if (input.action === "restore") {
        const restore = await restoreTarget(client, report.target_type, report.target_id, {
          reviewerId: request.user!.id,
          keepReportId: params.id
        });
        previousTargetStatus = restore.previousStatus;
        nextTargetStatus = "published";
        siblingsDismissed = restore.siblingsDismissed;
      }

      await client.query(
        `UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
        [params.id, input.status, request.user!.id]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "report.resolved",
        resourceType: "report",
        resourceId: params.id,
        metadata: {
          status: input.status,
          action: input.action,
          notes: input.notes,
          targetType: report.target_type,
          targetId: report.target_id,
          previousTargetStatus,
          nextTargetStatus,
          siblingsDismissed
        }
      });
      await notifyUser(client, {
        userId: report.reporter_id,
        type: "report_resolved",
        title: "你的举报已处理",
        body: input.status === "resolved" ? "审核员已完成处理。" : "审核员已完成核查，本次举报被驳回。",
        link: "/me/notifications"
      });
    });
    return { status: input.status };
  });

  app.get("/moderation/audit", { preHandler: requireAdmin }, async (request) => {
    const input = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(100),
      resourceType: z.string().optional()
    }).parse(request.query);
    const values: unknown[] = [input.limit];
    const where = input.resourceType ? "WHERE resource_type = $2" : "";
    if (input.resourceType) values.push(input.resourceType);
    const result = await query(
      `SELECT al.id, al.actor_id, u.display_name AS actor_name, al.action,
              al.resource_type, al.resource_id, al.metadata, al.created_at
       FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_id
       ${where}
       ORDER BY al.created_at DESC LIMIT $1`,
      values
    );
    return result.rows;
  });
}

async function activePendingRevision(client: Parameters<Parameters<typeof transaction>[0]>[0], featureId: string) {
  const result = await client.query<{ id: string; author_id: string }>(
    `SELECT id, author_id FROM feature_revisions
     WHERE feature_id = $1 AND status = 'pending'
     ORDER BY revision_no DESC LIMIT 1 FOR UPDATE`,
    [featureId]
  );
  const revision = result.rows[0];
  if (!revision) throw notFound("Pending revision not found");
  return revision;
}
