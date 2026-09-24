import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), relativePath), "utf8");

describe("report threshold concurrency regression", () => {
  const reports = read("routes/reports.ts");
  const moderation = read("routes/moderation.ts");
  const state = read("moderation-state.ts");
  const features = read("routes/features.ts");

  it("locks the target row before inserting reports so concurrent counts share one committed view", () => {
    // 历史与并发口径差异的根因：计数依赖事务快照。
    // 必须先对目标行 FOR UPDATE，让并发举报串行化，再插入、再计数。
    const lockIndex = state.indexOf("FOR UPDATE");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(state.indexOf("lockReportTarget")).toBeGreaterThan(-1);

    const callLock = reports.indexOf("await lockReportTarget");
    const callInsert = reports.indexOf("INSERT INTO reports");
    const callCount = reports.indexOf("await countOpenReports");
    expect(callLock).toBeGreaterThan(-1);
    expect(callInsert).toBeGreaterThan(callLock);
    expect(callCount).toBeGreaterThan(callInsert);
    // 旧实现内联 count(*) 的写法不得回流
    expect(reports).not.toContain("SELECT count(*)");
  });

  it("uses a single REPORT_THRESHOLD constant for hiding and restore guards", () => {
    expect(state).toContain("export const REPORT_THRESHOLD = 3");
    expect(reports).toContain(">= REPORT_THRESHOLD");
    // 恢复口径：剩余 open 举报仍达到阈值时禁止恢复，避免“处理一条就公开”。
    expect(state).toMatch(/openReports >= REPORT_THRESHOLD/);
  });

  it("only hides published rows and records both hide and threshold audits", () => {
    // 幂等/状态守卫：已隐藏不重复隐藏与重复通知，非公开状态不覆盖审核状态。
    expect(state).toContain("status = 'published'");
    expect(reports).toContain("report.threshold_hidden");
    expect(reports).toContain("notifyTargetHidden");
  });

  it("routes manual hide/restore for features and comments through the same guarded helpers", () => {
    expect(moderation).toContain('"/moderation/comments/:id/restore"');
    // resolve 端点的 hide/restore 不得再用绕过守卫的裸 UPDATE 切换状态
    const resolveBlock = moderation.slice(moderation.indexOf("/moderation/reports/:id/resolve"));
    expect(resolveBlock).not.toMatch(/SET status = 'hidden'/);
    expect(resolveBlock).not.toMatch(/SET status = 'published'/);
    expect(moderation).toContain("restoreTarget(");
    expect(moderation).toContain("hideTarget(");
  });

  it("locks report rows only after locking the target to keep a consistent lock order", () => {
    const targetLock = moderation.indexOf("lockReportTarget");
    const reportForUpdate = moderation.indexOf("FROM reports WHERE id = $1 AND status = 'open' FOR UPDATE");
    expect(targetLock).toBeGreaterThan(-1);
    expect(reportForUpdate).toBeGreaterThan(targetLock);
  });

  it("applies the same lock-before-count rule to the freshness confirmation threshold", () => {
    const confirmBlock = features.slice(features.indexOf("/confirmations\""));
    expect(confirmBlock).toContain("FOR UPDATE");
    expect(confirmBlock).toContain("feature.freshness_threshold_flagged");
  });
});
