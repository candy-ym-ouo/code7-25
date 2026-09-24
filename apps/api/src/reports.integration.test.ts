/**
 * Integration tests for report-driven moderation against a real PostgreSQL.
 *
 * The concurrency guarantees here (row locks serializing threshold counting)
 * cannot be proven against a mock, so the suite spins up an embedded
 * PostgreSQL binary. When that binary package is not installed (e.g. a
 * minimal CI image without network access) the suite skips instead of
 * failing.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "test-secret-test-secret-test-secret";
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:55444/reporttest";
process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:9000";
process.env.S3_ACCESS_KEY = "test";
process.env.S3_SECRET_KEY = "test";
process.env.S3_QUARANTINE_BUCKET = "quarantine";
process.env.S3_PUBLIC_BUCKET = "public";
process.env.PUBLIC_MEDIA_BASE_URL = "http://media.local";

type EmbeddedPg = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPgClient(database?: string, host?: string): { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>; end(): Promise<void>; connect(): Promise<void> };
};

let EmbeddedConstructor: (new (options: Record<string, unknown>) => EmbeddedPg) | null = null;
try {
  const mod = (await import("embedded-postgres")) as {
    default: new (options: Record<string, unknown>) => EmbeddedPg;
  };
  EmbeddedConstructor = mod.default;
} catch {
  EmbeddedConstructor = null;
}

// The report flow only touches the tables below; PostGIS is irrelevant here,
// which keeps the embedded binary independent of distro PostGIS packaging.
const TEST_SCHEMA = `
CREATE TYPE user_role AS ENUM ('contributor', 'moderator', 'admin');
CREATE TYPE user_status AS ENUM ('pending_verification', 'active', 'suspended', 'deletion_pending', 'deleted');
CREATE TYPE content_status AS ENUM ('draft', 'pending', 'published', 'rejected', 'changes_requested', 'hidden', 'deleted');
CREATE TYPE comment_status AS ENUM ('pending', 'published', 'rejected', 'hidden', 'deleted');
CREATE TYPE report_target_type AS ENUM ('feature', 'comment');
CREATE TYPE report_status AS ENUM ('open', 'resolved', 'dismissed');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL DEFAULT 'x',
  display_name text NOT NULL,
  role user_role NOT NULL DEFAULT 'contributor',
  status user_status NOT NULL DEFAULT 'active',
  email_verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE map_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL DEFAULT 'bench',
  owner_id uuid NOT NULL REFERENCES users(id),
  location_accuracy_m integer NOT NULL DEFAULT 50,
  current_revision_id uuid,
  status content_status NOT NULL DEFAULT 'published',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid REFERENCES map_features(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  parent_id uuid,
  body text NOT NULL DEFAULT 'body',
  status comment_status NOT NULL DEFAULT 'published',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  target_type report_target_type NOT NULL,
  target_id uuid NOT NULL,
  reason_code text NOT NULL,
  notes text,
  status report_status NOT NULL DEFAULT 'open',
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reports_one_open_per_user_idx
  ON reports(reporter_id, target_type, target_id) WHERE status = 'open';
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

describe.skipIf(!EmbeddedConstructor)("report threshold moderation (real PostgreSQL)", () => {
  const port = 55444;
  const dbName = "reporttest";
  let server: EmbeddedPg;
  let pool: typeof import("./db").pool;
  let signAccessToken: typeof import("./auth").signAccessToken;

  async function buildTestApp() {
    const app = Fastify();
    await app.register(cookie);
    const [{ reportRoutes }, { moderationRoutes }] = await Promise.all([
      import("./routes/reports"),
      import("./routes/moderation")
    ]);
    await app.register(async (api) => {
      await api.register(reportRoutes);
      await api.register(moderationRoutes);
    }, { prefix: "/api/v1" });
    return app;
  }

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "embedded-pg-"));
    server = new EmbeddedConstructor!({
      databaseDir: dataDir,
      user: "test",
      password: "test",
      host: "127.0.0.1",
      port,
      persistent: false,
      initdbFlags: [],
      postgresFlags: [],
      // The postgres binary is chatty; piping its stdout through the test
      // runner's captured stream can stall the child on backpressure.
      onLog: () => undefined,
      onError: (error: unknown) => {
        console.error("embedded-postgres error", error);
      }
    });
    await server.initialise();
    await server.start();
    await server.createDatabase(dbName);
    const admin = server.getPgClient(dbName, "127.0.0.1");
    await admin.connect();
    await admin.query(TEST_SCHEMA);
    await admin.end();

    const db = await import("./db");
    pool = db.pool;
    const auth = await import("./auth");
    signAccessToken = auth.signAccessToken;
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await server.stop();
  }, 120_000);

  async function seedUsers(reporterCount: number) {
    const runId = crypto.randomUUID().slice(0, 8);
    const owner = await pool.query(`INSERT INTO users(email, email_normalized, display_name, role)
      VALUES ($1, $1, 'Owner', 'contributor') RETURNING id`, [`owner-${runId}@example.com`]);
    const reporters: string[] = [];
    for (let i = 0; i < reporterCount; i++) {
      const row = await pool.query(
        `INSERT INTO users(email, email_normalized, display_name, role)
         VALUES ($1, $1, 'Reporter', 'contributor') RETURNING id`,
        [`r-${runId}-${i}@example.com`]
      );
      reporters.push(row.rows[0]!.id);
    }
    const admin = await pool.query(`INSERT INTO users(email, email_normalized, display_name, role)
      VALUES ($1, $1, 'Admin', 'admin') RETURNING id`, [`admin-${runId}@example.com`]);
    return { ownerId: owner.rows[0]!.id, reporters, adminId: admin.rows[0]!.id };
  }

  const tokenFor = (id: string, role: "contributor" | "moderator" | "admin" = "contributor") =>
    signAccessToken({ id, email: "", displayName: "", role, status: "active", emailVerified: true });

  it("hides the target exactly once when threshold reports arrive concurrently", async () => {
    const users = await seedUsers(4);
    const feature = await pool.query(
      "INSERT INTO map_features(owner_id, status) VALUES ($1, 'published') RETURNING id",
      [users.ownerId]
    );
    const featureId = feature.rows[0]!.id;

    const app = await buildTestApp();
    await app.ready();

    // Fire the three threshold-crossing reports at the same time. Before the
    // fix all three transactions observed the same pre-threshold count and
    // none hid the content.
    const thresholdResponses = await Promise.all(
      users.reporters.slice(0, 3).map((reporterId) =>
        app.inject({
          method: "POST",
          url: "/api/v1/reports",
          headers: { authorization: `Bearer ${tokenFor(reporterId)}` },
          payload: { targetType: "feature", targetId: featureId, reasonCode: "SPAM" }
        })
      )
    );
    for (const response of thresholdResponses) {
      expect(response.statusCode, response.body).toBe(201);
    }

    // Any further report queued behind the threshold lock sees a hidden,
    // therefore non-reportable target and must be rejected as 404.
    const late = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: { authorization: `Bearer ${tokenFor(users.reporters[3]!)}` },
      payload: { targetType: "feature", targetId: featureId, reasonCode: "SPAM" }
    });
    expect(late.statusCode).toBe(404);

    const status = await pool.query("SELECT status FROM map_features WHERE id = $1", [featureId]);
    expect(status.rows[0]!.status).toBe("hidden");

    // The auto-hide must fire once, not once per threshold-crossing report.
    const audits = await pool.query(
      "SELECT count(*)::int AS c FROM audit_logs WHERE resource_id = $1 AND action = 'report.threshold_hidden'",
      [featureId]
    );
    expect(audits.rows[0]!.c).toBe(1);

    await app.close();
  }, 120_000);

  it("restored content needs a fresh full report round instead of counting stale open reports", async () => {
    const users = await seedUsers(6);
    const feature = await pool.query(
      "INSERT INTO map_features(owner_id, status, current_revision_id) VALUES ($1, 'published', gen_random_uuid()) RETURNING id",
      [users.ownerId]
    );
    const featureId = feature.rows[0]!.id;

    const app = await buildTestApp();
    await app.ready();
    const report = async (reporterId: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/reports",
        headers: { authorization: `Bearer ${tokenFor(reporterId)}` },
        payload: { targetType: "feature", targetId: featureId, reasonCode: "SPAM" }
      });

    for (const reporterId of users.reporters.slice(0, 3)) {
      const res = await report(reporterId);
      expect(res.statusCode, res.body).toBe(201);
    }
    expect((await pool.query("SELECT status FROM map_features WHERE id = $1", [featureId])).rows[0]!.status).toBe("hidden");

    const restore = await app.inject({
      method: "POST",
      url: `/api/v1/moderation/features/${featureId}/restore`,
      headers: { authorization: `Bearer ${tokenFor(users.adminId, "admin")}` }
    });
    expect(restore.statusCode, restore.body).toBe(200);
    expect((await pool.query("SELECT status FROM map_features WHERE id = $1", [featureId])).rows[0]!.status).toBe("published");
    const staleOpen = await pool.query(
      "SELECT count(*)::int AS c FROM reports WHERE target_id = $1 AND status = 'open'",
      [featureId]
    );
    expect(staleOpen.rows[0]!.c).toBe(0);

    // Two new reports are below threshold and must keep the content public.
    for (const reporterId of users.reporters.slice(3, 5)) {
      const res = await report(reporterId);
      expect(res.statusCode, res.body).toBe(201);
    }
    expect((await pool.query("SELECT status FROM map_features WHERE id = $1", [featureId])).rows[0]!.status).toBe("published");

    const crossing = await report(users.reporters[5]!);
    expect(crossing.statusCode, crossing.body).toBe(201);
    expect((await pool.query("SELECT status FROM map_features WHERE id = $1", [featureId])).rows[0]!.status).toBe("hidden");

    await app.close();
  }, 120_000);

  it("resolve with restore keeps the chosen report status and dismisses siblings", async () => {
    const users = await seedUsers(3);
    const moderatorId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users(id, email, email_normalized, display_name, role)
       VALUES ($1, $2, $2, 'Mod', 'moderator')`,
      [moderatorId, `mod-${crypto.randomUUID().slice(0, 8)}@example.com`]
    );
    const feature = await pool.query(
      "INSERT INTO map_features(owner_id, status, current_revision_id) VALUES ($1, 'published', gen_random_uuid()) RETURNING id",
      [users.ownerId]
    );
    const featureId = feature.rows[0]!.id;

    const app = await buildTestApp();
    await app.ready();

    const reportIds: string[] = [];
    for (const reporterId of users.reporters) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/reports",
        headers: { authorization: `Bearer ${tokenFor(reporterId)}` },
        payload: { targetType: "feature", targetId: featureId, reasonCode: "SPAM" }
      });
      reportIds.push((res.json() as { id: string }).id);
    }
    expect((await pool.query("SELECT status FROM map_features WHERE id=$1", [featureId])).rows[0]!.status).toBe("hidden");

    const resolve = await app.inject({
      method: "POST",
      url: `/api/v1/moderation/reports/${reportIds[0]}/resolve`,
      headers: { authorization: `Bearer ${tokenFor(moderatorId, "moderator")}` },
      payload: { status: "resolved", action: "restore", notes: "looks fine" }
    });
    expect(resolve.statusCode, resolve.body).toBe(200);
    expect((await pool.query("SELECT status FROM map_features WHERE id=$1", [featureId])).rows[0]!.status).toBe("published");

    const counts = await pool.query(
      `SELECT status, count(*)::int AS c FROM reports WHERE target_id = $1 GROUP BY status`,
      [featureId]
    );
    const tally = Object.fromEntries(counts.rows.map((r) => [r.status, r.c] as const)) as Record<string, number>;
    expect(tally.resolved).toBe(1);
    expect(tally.dismissed).toBe(2);
    expect(tally.open ?? 0).toBe(0);

    await app.close();
  }, 120_000);

  it("manual hide closes the open report round and hides from public reads", async () => {
    const users = await seedUsers(2);
    const moderatorId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users(id, email, email_normalized, display_name, role)
       VALUES ($1, $2, $2, 'Mod', 'moderator')`,
      [moderatorId, `mod2-${crypto.randomUUID().slice(0, 8)}@example.com`]
    );
    const feature = await pool.query(
      "INSERT INTO map_features(owner_id, status) VALUES ($1, 'published') RETURNING id",
      [users.ownerId]
    );
    const featureId = feature.rows[0]!.id;

    const app = await buildTestApp();
    await app.ready();
    for (const reporterId of users.reporters) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/reports",
        headers: { authorization: `Bearer ${tokenFor(reporterId)}` },
        payload: { targetType: "feature", targetId: featureId, reasonCode: "SPAM" }
      });
      expect(res.statusCode).toBe(201);
    }

    const hide = await app.inject({
      method: "POST",
      url: `/api/v1/moderation/features/${featureId}/hide`,
      headers: { authorization: `Bearer ${tokenFor(moderatorId, "moderator")}` },
      payload: { reasonCode: "PERSONAL_INFORMATION", notes: "manual" }
    });
    expect(hide.statusCode, hide.body).toBe(200);
    expect((await pool.query("SELECT status FROM map_features WHERE id=$1", [featureId])).rows[0]!.status).toBe("hidden");
    const open = await pool.query(
      "SELECT count(*)::int AS c FROM reports WHERE target_id=$1 AND status='open'",
      [featureId]
    );
    expect(open.rows[0]!.c).toBe(0);

    // New reports against the hidden item are rejected as 404, so the round
    // cannot silently grow while the item is out of public view.
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: { authorization: `Bearer ${tokenFor(users.reporters[0]!)}` },
      payload: { targetType: "feature", targetId: featureId, reasonCode: "SPAM" }
    });
    expect(after.statusCode).toBe(404);

    await app.close();
  }, 120_000);
});
