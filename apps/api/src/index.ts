import crypto from "node:crypto";
import os from "node:os";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import { compileProjectInNode } from "@aa-game/harness-core";
import { BUILTIN_TEMPLATES, getTemplateById } from "@aa-game/templates";
import {
  AuthCredentialsSchema,
  CreateProjectRequestSchema,
  GenerateAssetRequestSchema,
  PublishReleaseRequestSchema,
  SaveSnapshotRequestSchema,
  type AssetEntry,
  type ConfigParam,
  type GameConfigValues,
  type GameSpec,
  type ProjectDetail,
  type ProjectSummary,
  type ReleaseCard,
  type ReleasePlayPayload,
  type SnapshotSummary,
  type UploadAssetResponse,
  type UserProfile,
} from "@aa-game/protocol";
import {
  createDbPool,
  hashPassword,
  loadFilesFromManifest,
  runMigrations,
  storeFilesAsManifest,
  verifyPassword,
} from "./db.js";
import { buildStandaloneHtml, buildZipBuffer } from "./export.js";
import { generateSpriteAsset } from "./sprite-gen.js";
import { ObjectStorageService } from "./storage.js";

function detectLanIp(): string {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function makeSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base || "game"}-${suffix}`;
}

function safeJsonParse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const headerToken = req.headers["x-session-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }
  return null;
}

async function resolveSessionUser(pool: Pool, req: FastifyRequest): Promise<UserProfile | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  const res = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    created_at: Date;
  }>(
    `SELECT u.id, u.username, u.display_name, u.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

async function createSession(pool: Pool, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expiresAt],
  );
  return token;
}

async function seedCommunityShowcase(pool: Pool, storage: ObjectStorageService): Promise<void> {
  const existing = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM releases`);
  if (Number(existing.rows[0]?.count ?? 0) > 0) return;

  const userId = "usr_official_studio";
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [userId, "aastudio", "AA Studio 官方精选", hashPassword("demo1234")],
  );

  for (const tpl of BUILTIN_TEMPLATES) {
    const compiled = await compileProjectInNode(tpl.files);
    if (!compiled.ok) continue;

    const projectId = `prj_seed_${tpl.id}`;
    const snapshotId = `snp_seed_${tpl.id}`;
    const releaseId = `rel_seed_${tpl.id}`;
    const manifest = await storeFilesAsManifest(pool, tpl.files);

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, description, mode, orientation, config_schema, current_snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        projectId,
        userId,
        tpl.spec.title,
        tpl.spec.description,
        tpl.spec.mode,
        tpl.spec.orientation,
        JSON.stringify(tpl.configSchema),
        snapshotId,
      ],
    );

    await pool.query(
      `INSERT INTO snapshots (id, project_id, parent_snapshot_id, file_manifest, spec_json, assets_json, commit_summary)
       VALUES ($1, $2, NULL, $3::jsonb, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        snapshotId,
        projectId,
        JSON.stringify(manifest),
        JSON.stringify(tpl.spec),
        JSON.stringify(tpl.assets),
        "官方黄金模板首发版本",
      ],
    );

    const clientUpload = await storage.putObject({
      bucket: "releases",
      key: `${tpl.id}/client.bundle.js`,
      body: compiled.clientBundle,
      contentType: "application/javascript; charset=utf-8",
    });
    const roomUpload = await storage.putObject({
      bucket: "releases",
      key: `${tpl.id}/room.bundle.js`,
      body: compiled.simBundle,
      contentType: "application/javascript; charset=utf-8",
    });

    await pool.query(
      `INSERT INTO releases (
         id, slug, project_id, snapshot_id, author_id, title, description, mode, orientation,
         client_bundle, sim_bundle, client_bundle_url, room_bundle_url,
         spec_json, config_schema, config_values, assets_json, is_public
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [
        releaseId,
        tpl.id,
        projectId,
        snapshotId,
        userId,
        tpl.spec.title,
        tpl.spec.description,
        tpl.spec.mode,
        tpl.spec.orientation,
        compiled.clientBundle,
        compiled.simBundle,
        clientUpload?.url ?? null,
        roomUpload?.url ?? null,
        JSON.stringify(tpl.spec),
        JSON.stringify(tpl.configSchema),
        JSON.stringify(tpl.defaultConfig),
        JSON.stringify(tpl.assets),
      ],
    );
  }
}

export async function createPlatformApiApp(options?: {
  databaseUrl?: string;
  s3Endpoint?: string;
  skipSeed?: boolean;
}) {
  const pool = createDbPool(options?.databaseUrl);
  await runMigrations(pool);

  const storage = new ObjectStorageService(
    options?.s3Endpoint ? { endpoint: options.s3Endpoint } : undefined,
  );
  await storage.ensureBuckets();

  if (!options?.skipSeed) {
    await seedCommunityShowcase(pool, storage);
  }

  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  await app.register(cors, { origin: true, credentials: true });

  app.get("/health", async () => {
    let dbOk = false;
    try {
      await pool.query("SELECT 1");
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      dbOk,
      s3Ok: storage.isAvailable(),
      lanIp: detectLanIp(),
    };
  });

  // =========================================================================
  // Auth Routes
  // =========================================================================
  app.post("/api/auth/register", async (request, reply) => {
    const parsed = AuthCredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "参数无效" });
    }
    const { username, password, displayName } = parsed.data;
    const exists = await pool.query(`SELECT id FROM users WHERE username = $1`, [username.toLowerCase()]);
    if (exists.rowCount && exists.rowCount > 0) {
      return reply.status(409).send({ error: "该用户名已被注册" });
    }
    const id = `usr_${crypto.randomUUID().slice(0, 12)}`;
    const res = await pool.query<{ id: string; username: string; display_name: string; created_at: Date }>(
      `INSERT INTO users (id, username, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, created_at`,
      [id, username.toLowerCase(), displayName?.trim() || username, hashPassword(password)],
    );
    const row = res.rows[0]!;
    const token = await createSession(pool, row.id);
    const user: UserProfile = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at.toISOString(),
    };
    return { user, token };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = AuthCredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "请输入正确的用户名与密码" });
    }
    const { username, password } = parsed.data;
    const res = await pool.query<{
      id: string;
      username: string;
      display_name: string;
      password_hash: string;
      created_at: Date;
    }>(`SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = $1`, [
      username.toLowerCase(),
    ]);
    const row = res.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      return reply.status(401).send({ error: "用户名或密码错误" });
    }
    const token = await createSession(pool, row.id);
    return {
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        createdAt: row.created_at.toISOString(),
      } satisfies UserProfile,
      token,
    };
  });

  app.post("/api/auth/demo", async () => {
    const username = "creator";
    let res = await pool.query<{ id: string; username: string; display_name: string; created_at: Date }>(
      `SELECT id, username, display_name, created_at FROM users WHERE username = $1`,
      [username],
    );
    if (!res.rows[0]) {
      const id = `usr_${crypto.randomUUID().slice(0, 12)}`;
      res = await pool.query(
        `INSERT INTO users (id, username, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, display_name, created_at`,
        [id, username, "演示创作者", hashPassword("demo1234")],
      );
    }
    const row = res.rows[0]!;
    const token = await createSession(pool, row.id);
    return {
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        createdAt: row.created_at.toISOString(),
      } satisfies UserProfile,
      token,
    };
  });

  app.post("/api/auth/logout", async (request) => {
    const token = extractBearerToken(request);
    if (token) {
      await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
    }
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    const user = await resolveSessionUser(pool, request);
    return { user };
  });

  // =========================================================================
  // Projects & Content-Addressed Snapshots / Rollback
  // =========================================================================
  app.get("/api/projects", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    if (!user) return reply.status(401).send({ error: "请先登录" });

    const res = await pool.query<{
      id: string;
      owner_id: string;
      forked_from_release_id: string | null;
      title: string;
      description: string;
      mode: "singleplayer" | "multiplayer";
      orientation: "portrait" | "landscape" | "responsive";
      current_snapshot_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, owner_id, forked_from_release_id, title, description, mode, orientation, current_snapshot_id, created_at, updated_at
       FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC`,
      [user.id],
    );

    const projects: ProjectSummary[] = res.rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      forkedFromReleaseId: r.forked_from_release_id,
      title: r.title,
      description: r.description,
      mode: r.mode,
      orientation: r.orientation,
      currentSnapshotId: r.current_snapshot_id,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
    return { projects };
  });

  app.post("/api/projects", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    if (!user) return reply.status(401).send({ error: "请先登录" });

    const parsed = CreateProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const { title, description, templateId, files: inputFiles, configSchema: inputSchema } = parsed.data;
    const tpl = templateId ? getTemplateById(templateId) : BUILTIN_TEMPLATES[0]!;
    const files = inputFiles && Object.keys(inputFiles).length > 0 ? inputFiles : { ...(tpl?.files ?? {}) };
    const configSchema = (inputSchema ?? tpl?.configSchema ?? []) as ConfigParam[];
    const spec = safeJsonParse<Partial<GameSpec>>(files["spec.json"], tpl?.spec ?? {});
    const assets = safeJsonParse(files["assets.json"], tpl?.assets ?? { version: 1, assets: [] });

    const projectId = `prj_${crypto.randomUUID().slice(0, 12)}`;
    const snapshotId = `snp_${crypto.randomUUID().slice(0, 12)}`;
    const manifest = await storeFilesAsManifest(pool, files);

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, description, mode, orientation, config_schema, current_snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        projectId,
        user.id,
        title,
        description || spec.description || "",
        spec.mode ?? "singleplayer",
        spec.orientation ?? "responsive",
        JSON.stringify(configSchema),
        snapshotId,
      ],
    );

    await pool.query(
      `INSERT INTO snapshots (id, project_id, parent_snapshot_id, file_manifest, spec_json, assets_json, commit_summary)
       VALUES ($1, $2, NULL, $3::jsonb, $4::jsonb, $5::jsonb, $6)`,
      [
        snapshotId,
        projectId,
        JSON.stringify(manifest),
        JSON.stringify(spec),
        JSON.stringify(assets),
        "初始创建项目快照",
      ],
    );

    const detail = await loadProjectDetail(pool, projectId);
    return { project: detail };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    if (!user) return reply.status(401).send({ error: "请先登录" });
    const detail = await loadProjectDetail(pool, request.params.id);
    if (!detail) return reply.status(404).send({ error: "项目不存在" });
    if (detail.ownerId !== user.id) return reply.status(403).send({ error: "无权访问此项目" });
    return { project: detail };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/snapshots", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    if (!user) return reply.status(401).send({ error: "请先登录" });

    const existing = await pool.query<{
      id: string;
      owner_id: string;
      current_snapshot_id: string | null;
      title: string;
      description: string;
    }>(`SELECT id, owner_id, current_snapshot_id, title, description FROM projects WHERE id = $1`, [
      request.params.id,
    ]);
    const proj = existing.rows[0];
    if (!proj) return reply.status(404).send({ error: "项目不存在" });
    if (proj.owner_id !== user.id) return reply.status(403).send({ error: "无权修改此项目" });

    const parsed = SaveSnapshotRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { files, commitSummary, title, description, configSchema } = parsed.data;
    const spec = safeJsonParse<Partial<GameSpec>>(files["spec.json"], {});
    const assets = safeJsonParse(files["assets.json"], { version: 1, assets: [] });

    const snapshotId = `snp_${crypto.randomUUID().slice(0, 12)}`;
    const manifest = await storeFilesAsManifest(pool, files);

    await pool.query(
      `INSERT INTO snapshots (id, project_id, parent_snapshot_id, file_manifest, spec_json, assets_json, commit_summary)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
      [
        snapshotId,
        proj.id,
        proj.current_snapshot_id,
        JSON.stringify(manifest),
        JSON.stringify(spec),
        JSON.stringify(assets),
        commitSummary,
      ],
    );

    await pool.query(
      `UPDATE projects
       SET current_snapshot_id = $1,
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           mode = COALESCE($4, mode),
           orientation = COALESCE($5, orientation),
           config_schema = COALESCE($6::jsonb, config_schema),
           updated_at = NOW()
       WHERE id = $7`,
      [
        snapshotId,
        title ?? spec.title ?? null,
        description ?? spec.description ?? null,
        spec.mode ?? null,
        spec.orientation ?? null,
        configSchema ? JSON.stringify(configSchema) : null,
        proj.id,
      ],
    );

    const detail = await loadProjectDetail(pool, proj.id);
    return { snapshotId, project: detail };
  });

  app.post<{ Params: { id: string }; Body: { snapshotId?: string } }>(
    "/api/projects/:id/rollback",
    async (request, reply) => {
      const user = await resolveSessionUser(pool, request);
      if (!user) return reply.status(401).send({ error: "请先登录" });

      const targetSnapshotId = request.body?.snapshotId;
      if (!targetSnapshotId) return reply.status(400).send({ error: "snapshotId is required" });

      const projRes = await pool.query<{ id: string; owner_id: string }>(
        `SELECT id, owner_id FROM projects WHERE id = $1`,
        [request.params.id],
      );
      const proj = projRes.rows[0];
      if (!proj) return reply.status(404).send({ error: "项目不存在" });
      if (proj.owner_id !== user.id) return reply.status(403).send({ error: "无权回滚此项目" });

      const snpRes = await pool.query<{
        id: string;
        file_manifest: Record<string, string>;
        spec_json: Partial<GameSpec> | null;
      }>(`SELECT id, file_manifest, spec_json FROM snapshots WHERE id = $1 AND project_id = $2`, [
        targetSnapshotId,
        proj.id,
      ]);
      const snp = snpRes.rows[0];
      if (!snp) return reply.status(404).send({ error: "目标快照不存在" });

      await pool.query(
        `UPDATE projects
         SET current_snapshot_id = $1,
             mode = COALESCE($2, mode),
             orientation = COALESCE($3, orientation),
             updated_at = NOW()
         WHERE id = $4`,
        [snp.id, snp.spec_json?.mode ?? null, snp.spec_json?.orientation ?? null, proj.id],
      );

      const detail = await loadProjectDetail(pool, proj.id);
      return { project: detail };
    },
  );

  // =========================================================================
  // One-Click Publish, Community Gallery, Likes & Fork / Remix
  // =========================================================================
  app.post<{ Params: { id: string } }>("/api/projects/:id/publish", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    if (!user) return reply.status(401).send({ error: "发布前请先登录" });

    const detail = await loadProjectDetail(pool, request.params.id);
    if (!detail) return reply.status(404).send({ error: "项目不存在" });
    if (detail.ownerId !== user.id) return reply.status(403).send({ error: "无权发布此项目" });

    const parsed = PublishReleaseRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const body = parsed.data;
    const files = body.files && Object.keys(body.files).length > 0 ? body.files : detail.files;
    const configSchema = (body.configSchema ?? detail.configSchema) as ConfigParam[];

    // Freeze a dedicated release snapshot so subsequent edits never break published games!
    const snapshotId = `snp_${crypto.randomUUID().slice(0, 12)}`;
    const manifest = await storeFilesAsManifest(pool, files);
    const spec = safeJsonParse<GameSpec>(files["spec.json"], BUILTIN_TEMPLATES[0]!.spec);
    const configValues = safeJsonParse<GameConfigValues>(files["config.json"], {});
    const assets = safeJsonParse(files["assets.json"], { version: 1, assets: [] });

    await pool.query(
      `INSERT INTO snapshots (id, project_id, parent_snapshot_id, file_manifest, spec_json, assets_json, commit_summary)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
      [
        snapshotId,
        detail.id,
        detail.currentSnapshotId,
        JSON.stringify(manifest),
        JSON.stringify(spec),
        JSON.stringify(assets),
        `发布版本: ${body.title || spec.title}`,
      ],
    );
    await pool.query(
      `UPDATE projects SET current_snapshot_id = $1, updated_at = NOW() WHERE id = $2`,
      [snapshotId, detail.id],
    );

    // Compile bundles server-side if not pre-supplied
    let clientBundle = body.clientBundle ?? "";
    let simBundle = body.simBundle ?? "";
    if (!clientBundle || !simBundle) {
      const compiled = await compileProjectInNode(files);
      if (!compiled.ok) {
        return reply.status(400).send({
          error: `发布前编译失败: ${compiled.diagnostics.map((d) => d.message).join("; ")}`,
        });
      }
      clientBundle = compiled.clientBundle;
      simBundle = compiled.simBundle;
    }

    const title = body.title?.trim() || spec.title || detail.title;
    const description = body.description?.trim() ?? spec.description ?? detail.description;
    const slug = makeSlug(title);
    const releaseId = `rel_${crypto.randomUUID().slice(0, 12)}`;

    const clientUpload = await storage.putObject({
      bucket: "releases",
      key: `${slug}/client.bundle.js`,
      body: clientBundle,
      contentType: "application/javascript; charset=utf-8",
    });
    const roomUpload = await storage.putObject({
      bucket: "releases",
      key: `${slug}/room.bundle.js`,
      body: simBundle,
      contentType: "application/javascript; charset=utf-8",
    });

    let coverUrl: string | null = null;
    if (body.coverDataUrl && body.coverDataUrl.startsWith("data:image/")) {
      const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(body.coverDataUrl);
      if (match) {
        const mime = match[1]!;
        const ext = mime.includes("png") ? "png" : mime.includes("svg") ? "svg" : "jpg";
        const up = await storage.putObject({
          bucket: "releases",
          key: `${slug}/cover.${ext}`,
          body: Buffer.from(match[2]!, "base64"),
          contentType: mime,
        });
        coverUrl = up?.url ?? body.coverDataUrl;
      }
    }

    await pool.query(
      `INSERT INTO releases (
         id, slug, project_id, snapshot_id, author_id, title, description, mode, orientation,
         client_bundle, sim_bundle, client_bundle_url, room_bundle_url, cover_url,
         spec_json, config_schema, config_values, assets_json, is_public
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19)`,
      [
        releaseId,
        slug,
        detail.id,
        snapshotId,
        user.id,
        title,
        description,
        spec.mode ?? detail.mode,
        spec.orientation ?? detail.orientation,
        clientBundle,
        simBundle,
        clientUpload?.url ?? null,
        roomUpload?.url ?? null,
        coverUrl,
        JSON.stringify(spec),
        JSON.stringify(configSchema),
        JSON.stringify(configValues),
        JSON.stringify(assets),
        body.isPublic,
      ],
    );

    const card = await loadReleaseCardBySlug(pool, slug, user.id);
    return {
      release: card,
      clientBundleUrl: clientUpload?.url ?? null,
      roomBundleUrl: roomUpload?.url ?? null,
      lanIp: detectLanIp(),
    };
  });

  app.get<{
    Querystring: { mode?: string; q?: string; sort?: string; limit?: string };
  }>("/api/releases", async (request) => {
    const user = await resolveSessionUser(pool, request);
    const { mode, q, sort, limit } = request.query;
    const params: unknown[] = [user?.id ?? ""];
    const where: string[] = ["r.is_public = TRUE"];

    if (mode === "singleplayer" || mode === "multiplayer") {
      params.push(mode);
      where.push(`r.mode = $${params.length}`);
    }
    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      where.push(`(LOWER(r.title) LIKE $${params.length} OR LOWER(r.description) LIKE $${params.length})`);
    }

    const orderBy =
      sort === "popular"
        ? "r.play_count DESC, r.created_at DESC"
        : sort === "likes"
          ? "r.like_count DESC, r.created_at DESC"
          : "r.created_at DESC";

    const maxRows = Math.min(60, Math.max(1, Number(limit || 30)));
    params.push(maxRows);

    const res = await pool.query<{
      id: string;
      slug: string;
      project_id: string;
      snapshot_id: string;
      title: string;
      description: string;
      mode: "singleplayer" | "multiplayer";
      orientation: "portrait" | "landscape" | "responsive";
      author_id: string;
      author_name: string;
      cover_url: string | null;
      play_count: number;
      like_count: number;
      remix_count: number;
      is_public: boolean;
      liked_by_me: boolean;
      created_at: Date;
    }>(
      `SELECT r.id, r.slug, r.project_id, r.snapshot_id, r.title, r.description, r.mode, r.orientation,
              r.author_id, u.display_name AS author_name, r.cover_url,
              r.play_count, r.like_count, r.remix_count, r.is_public, r.created_at,
              EXISTS(SELECT 1 FROM release_likes rl WHERE rl.release_id = r.id AND rl.user_id = $1) AS liked_by_me
       FROM releases r
       JOIN users u ON u.id = r.author_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params,
    );

    const releases: ReleaseCard[] = res.rows.map(mapReleaseRow);
    return { releases };
  });

  app.get<{ Params: { slug: string } }>("/api/releases/:slug", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    const res = await pool.query<{
      id: string;
      slug: string;
      project_id: string;
      snapshot_id: string;
      title: string;
      description: string;
      mode: "singleplayer" | "multiplayer";
      orientation: "portrait" | "landscape" | "responsive";
      author_id: string;
      author_name: string;
      cover_url: string | null;
      play_count: number;
      like_count: number;
      remix_count: number;
      is_public: boolean;
      liked_by_me: boolean;
      created_at: Date;
      client_bundle: string;
      sim_bundle: string;
      client_bundle_url: string | null;
      room_bundle_url: string | null;
      spec_json: GameSpec;
      config_schema: ConfigParam[];
      config_values: GameConfigValues;
      assets_json: { version: 1; assets: AssetEntry[] };
    }>(
      `UPDATE releases
       SET play_count = play_count + 1
       WHERE slug = $1
       RETURNING id, slug, project_id, snapshot_id, title, description, mode, orientation,
                 author_id,
                 (SELECT display_name FROM users WHERE id = releases.author_id) AS author_name,
                 cover_url, play_count, like_count, remix_count, is_public, created_at,
                 EXISTS(SELECT 1 FROM release_likes rl WHERE rl.release_id = releases.id AND rl.user_id = $2) AS liked_by_me,
                 client_bundle, sim_bundle, client_bundle_url, room_bundle_url,
                 spec_json, config_schema, config_values, assets_json`,
      [request.params.slug, user?.id ?? ""],
    );

    const row = res.rows[0];
    if (!row) return reply.status(404).send({ error: "游戏作品不存在" });

    const payload: ReleasePlayPayload = {
      release: mapReleaseRow(row),
      spec: row.spec_json,
      configSchema: row.config_schema,
      configValues: row.config_values,
      assets: row.assets_json,
      clientBundle: row.client_bundle,
      simBundle: row.sim_bundle,
      clientBundleUrl: row.client_bundle_url,
      roomBundleUrl: row.room_bundle_url,
    };
    return payload;
  });

  app.post<{ Params: { slug: string } }>("/api/releases/:slug/like", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    if (!user) return reply.status(401).send({ error: "点赞前请先登录" });

    const relRes = await pool.query<{ id: string }>(`SELECT id FROM releases WHERE slug = $1`, [
      request.params.slug,
    ]);
    const rel = relRes.rows[0];
    if (!rel) return reply.status(404).send({ error: "作品不存在" });

    const existing = await pool.query(
      `SELECT 1 FROM release_likes WHERE user_id = $1 AND release_id = $2`,
      [user.id, rel.id],
    );

    let liked: boolean;
    if (existing.rowCount && existing.rowCount > 0) {
      await pool.query(`DELETE FROM release_likes WHERE user_id = $1 AND release_id = $2`, [
        user.id,
        rel.id,
      ]);
      await pool.query(`UPDATE releases SET like_count = GREATEST(0, like_count - 1) WHERE id = $1`, [
        rel.id,
      ]);
      liked = false;
    } else {
      await pool.query(
        `INSERT INTO release_likes (user_id, release_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [user.id, rel.id],
      );
      await pool.query(`UPDATE releases SET like_count = like_count + 1 WHERE id = $1`, [rel.id]);
      liked = true;
    }

    const updated = await loadReleaseCardBySlug(pool, request.params.slug, user.id);
    return { liked, release: updated };
  });

  app.post<{ Params: { slug: string } }>("/api/releases/:slug/remix", async (request, reply) => {
    const user = await resolveSessionUser(pool, request);
    if (!user) return reply.status(401).send({ error: "Fork / Remix 前请先登录" });

    const relRes = await pool.query<{
      id: string;
      snapshot_id: string;
      title: string;
      description: string;
      mode: "singleplayer" | "multiplayer";
      orientation: "portrait" | "landscape" | "responsive";
      config_schema: ConfigParam[];
      file_manifest: Record<string, string>;
      spec_json: unknown;
      assets_json: unknown;
    }>(
      `SELECT r.id, r.snapshot_id, r.title, r.description, r.mode, r.orientation, r.config_schema,
              s.file_manifest, s.spec_json, s.assets_json
       FROM releases r
       JOIN snapshots s ON s.id = r.snapshot_id
       WHERE r.slug = $1`,
      [request.params.slug],
    );
    const rel = relRes.rows[0];
    if (!rel) return reply.status(404).send({ error: "源作品不存在" });

    const newProjectId = `prj_${crypto.randomUUID().slice(0, 12)}`;
    const newSnapshotId = `snp_${crypto.randomUUID().slice(0, 12)}`;

    // Content-addressed Fork: reuses exact SHA-256 blobs with zero duplication!
    await pool.query(
      `INSERT INTO projects (id, owner_id, forked_from_release_id, title, description, mode, orientation, config_schema, current_snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        newProjectId,
        user.id,
        rel.id,
        `${rel.title} (Remix)`,
        rel.description,
        rel.mode,
        rel.orientation,
        JSON.stringify(rel.config_schema ?? []),
        newSnapshotId,
      ],
    );

    await pool.query(
      `INSERT INTO snapshots (id, project_id, parent_snapshot_id, file_manifest, spec_json, assets_json, commit_summary)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
      [
        newSnapshotId,
        newProjectId,
        rel.snapshot_id,
        JSON.stringify(rel.file_manifest),
        JSON.stringify(rel.spec_json),
        JSON.stringify(rel.assets_json),
        `Remix 自「${rel.title}」`,
      ],
    );

    await pool.query(`UPDATE releases SET remix_count = remix_count + 1 WHERE id = $1`, [rel.id]);
    const project = await loadProjectDetail(pool, newProjectId);
    return { project };
  });

  // =========================================================================
  // Standalone HTML & Standard Vite+TS Source ZIP Export
  // =========================================================================
  app.post<{
    Body: { title?: string; files: Record<string, string> };
  }>("/api/export/html", async (request, reply) => {
    const files = request.body?.files;
    if (!files || !files["simulation.ts"] || !files["renderer.ts"]) {
      return reply.status(400).send({ error: "files must include simulation.ts and renderer.ts" });
    }
    const compiled = await compileProjectInNode(files);
    if (!compiled.ok) {
      return reply.status(400).send({
        error: `导出失败，编译报错: ${compiled.diagnostics.map((d) => d.message).join("; ")}`,
      });
    }
    const spec = safeJsonParse<GameSpec>(files["spec.json"], BUILTIN_TEMPLATES[0]!.spec);
    const configValues = safeJsonParse<GameConfigValues>(files["config.json"], {});
    const assets = safeJsonParse(files["assets.json"], { version: 1, assets: [] });
    const title = request.body.title || spec.title || "AA Game";

    const html = buildStandaloneHtml({
      title,
      spec,
      configValues,
      assets,
      simBundle: compiled.simBundle,
      clientBundle: compiled.clientBundle,
    });
    const safeName = title.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32) || "aa-game";
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-disposition", `attachment; filename="${safeName}.html"`)
      .send(html);
  });

  app.post<{
    Body: { title?: string; files: Record<string, string> };
  }>("/api/export/zip", async (request, reply) => {
    const files = request.body?.files;
    if (!files || Object.keys(files).length === 0) {
      return reply.status(400).send({ error: "files is required" });
    }
    const spec = safeJsonParse<Partial<GameSpec>>(files["spec.json"], {});
    const title = request.body.title || spec.title || "aa-game-project";
    const safeName = title.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase().slice(0, 32) || "aa-game";

    const entries = [
      {
        name: "package.json",
        content: JSON.stringify(
          {
            name: safeName,
            version: "0.1.0",
            private: true,
            type: "module",
            scripts: { dev: "vite", build: "vite build" },
            dependencies: { "pixi.js": "^8.9.2" },
            devDependencies: { typescript: "^5.8.3", vite: "^6.3.5" },
          },
          null,
          2,
        ),
      },
      {
        name: "README.md",
        content: `# ${title}\n\n由 AA Game Maker 导出的标准 2D 游戏源码工程。\n\n- \`src/simulation.ts\`: 无头核心逻辑（适配单机与 workerd 权威联机房间）\n- \`src/renderer.ts\`: PixiJS v8 + 双端 HUD 渲染层\n- \`spec.json\` / \`config.json\` / \`assets.json\`: 策划卡、数值表与资产清单\n`,
      },
      ...Object.entries(files).map(([filePath, content]) => ({
        name: filePath.endsWith(".ts") ? `src/${filePath}` : filePath,
        content,
      })),
    ];

    const zipBuf = buildZipBuffer(entries);
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${safeName}.zip"`)
      .send(zipBuf);
  });

  // =========================================================================
  // Custom Asset Upload (RustFS S3) & On-Demand AI Sprite Gen + Remove BG
  // =========================================================================
  app.post<{
    Body: {
      filename: string;
      mimeType: string;
      dataBase64: string;
      assetId?: string;
      kind?: AssetEntry["kind"];
    };
  }>("/api/assets/upload", async (request, reply) => {
    const body = request.body;
    if (!body?.dataBase64 || !body?.mimeType) {
      return reply.status(400).send({ error: "mimeType and dataBase64 are required" });
    }

    const rawBase64 = body.dataBase64.includes(",")
      ? body.dataBase64.split(",")[1]!
      : body.dataBase64;
    const buffer = Buffer.from(rawBase64, "base64");
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.status(400).send({ error: "单个素材文件大小不能超过 5MB" });
    }

    const ext =
      body.filename?.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ||
      (body.mimeType.includes("png")
        ? "png"
        : body.mimeType.includes("svg")
          ? "svg"
          : body.mimeType.includes("audio")
            ? "mp3"
            : "bin");
    const assetId =
      body.assetId?.trim().replace(/[^a-zA-Z0-9_-]/g, "_") ||
      `usr_asset_${crypto.randomBytes(4).toString("hex")}`;
    const key = `uploads/${Date.now()}-${assetId}.${ext}`;
    const kind: AssetEntry["kind"] =
      body.kind || (body.mimeType.startsWith("audio/") ? "audio_sfx" : "sprite");

    const uploaded = await storage.putObject({
      bucket: "assets",
      key,
      body: buffer,
      contentType: body.mimeType,
    });

    const url = uploaded?.url ?? `data:${body.mimeType};base64,${rawBase64}`;
    const entry: AssetEntry = {
      id: assetId,
      kind,
      source: "uploaded",
      url,
    };

    const response: UploadAssetResponse = {
      entry,
      url,
      storage: uploaded ? "s3" : "inline",
    };
    return response;
  });

  app.post("/api/assets/generate", async (request, reply) => {
    const parsed = GenerateAssetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const { prompt, assetId: rawId, style, removeBg, apiKey, baseUrl, model } = parsed.data;
    try {
      const generated = await generateSpriteAsset({
        prompt,
        style,
        removeBg,
        apiKey,
        baseUrl,
        model,
      });
      const assetId =
        rawId?.trim().replace(/[^a-zA-Z0-9_-]/g, "_") ||
        `ai_sprite_${crypto.randomBytes(4).toString("hex")}`;
      const key = `generated/${Date.now()}-${assetId}.${generated.ext}`;

      const uploaded = await storage.putObject({
        bucket: "assets",
        key,
        body: generated.buffer,
        contentType: generated.mimeType,
      });

      const url =
        uploaded?.url ??
        `data:${generated.mimeType};base64,${generated.buffer.toString("base64")}`;
      const entry: AssetEntry = {
        id: assetId,
        kind: "sprite",
        source: "generated",
        url,
        width: 128,
        height: 128,
      };
      return {
        entry,
        url,
        storage: uploaded ? "s3" : "inline",
        usedExternalApi: Boolean(apiKey?.trim()),
      };
    } catch (err) {
      return reply.status(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  return { app, pool, storage };
}

function mapReleaseRow(r: {
  id: string;
  slug: string;
  project_id: string;
  snapshot_id: string;
  title: string;
  description: string;
  mode: "singleplayer" | "multiplayer";
  orientation: "portrait" | "landscape" | "responsive";
  author_id: string;
  author_name: string;
  cover_url: string | null;
  play_count: number;
  like_count: number;
  remix_count: number;
  is_public: boolean;
  liked_by_me: boolean;
  created_at: Date;
}): ReleaseCard {
  return {
    id: r.id,
    slug: r.slug,
    projectId: r.project_id,
    snapshotId: r.snapshot_id,
    title: r.title,
    description: r.description,
    mode: r.mode,
    orientation: r.orientation,
    authorId: r.author_id,
    authorName: r.author_name,
    coverUrl: r.cover_url,
    playCount: r.play_count,
    likeCount: r.like_count,
    remixCount: r.remix_count,
    likedByMe: Boolean(r.liked_by_me),
    isPublic: r.is_public,
    createdAt: r.created_at.toISOString(),
  };
}

async function loadReleaseCardBySlug(
  pool: Pool,
  slug: string,
  viewerUserId: string,
): Promise<ReleaseCard | null> {
  const res = await pool.query<{
    id: string;
    slug: string;
    project_id: string;
    snapshot_id: string;
    title: string;
    description: string;
    mode: "singleplayer" | "multiplayer";
    orientation: "portrait" | "landscape" | "responsive";
    author_id: string;
    author_name: string;
    cover_url: string | null;
    play_count: number;
    like_count: number;
    remix_count: number;
    is_public: boolean;
    liked_by_me: boolean;
    created_at: Date;
  }>(
    `SELECT r.id, r.slug, r.project_id, r.snapshot_id, r.title, r.description, r.mode, r.orientation,
            r.author_id, u.display_name AS author_name, r.cover_url,
            r.play_count, r.like_count, r.remix_count, r.is_public, r.created_at,
            EXISTS(SELECT 1 FROM release_likes rl WHERE rl.release_id = r.id AND rl.user_id = $2) AS liked_by_me
     FROM releases r
     JOIN users u ON u.id = r.author_id
     WHERE r.slug = $1`,
    [slug, viewerUserId],
  );
  const row = res.rows[0];
  return row ? mapReleaseRow(row) : null;
}

async function loadProjectDetail(pool: Pool, projectId: string): Promise<ProjectDetail | null> {
  const projRes = await pool.query<{
    id: string;
    owner_id: string;
    forked_from_release_id: string | null;
    title: string;
    description: string;
    mode: "singleplayer" | "multiplayer";
    orientation: "portrait" | "landscape" | "responsive";
    config_schema: ConfigParam[];
    current_snapshot_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, owner_id, forked_from_release_id, title, description, mode, orientation, config_schema, current_snapshot_id, created_at, updated_at
     FROM projects WHERE id = $1`,
    [projectId],
  );
  const proj = projRes.rows[0];
  if (!proj) return null;

  const snapRes = await pool.query<{
    id: string;
    project_id: string;
    parent_snapshot_id: string | null;
    file_manifest: Record<string, string>;
    commit_summary: string;
    created_at: Date;
  }>(
    `SELECT id, project_id, parent_snapshot_id, file_manifest, commit_summary, created_at
     FROM snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [projectId],
  );

  const currentSnap =
    snapRes.rows.find((s) => s.id === proj.current_snapshot_id) ?? snapRes.rows[0];
  const files = currentSnap ? await loadFilesFromManifest(pool, currentSnap.file_manifest) : {};

  const snapshots: SnapshotSummary[] = snapRes.rows.map((s) => ({
    id: s.id,
    projectId: s.project_id,
    parentSnapshotId: s.parent_snapshot_id,
    commitSummary: s.commit_summary,
    fileCount: Object.keys(s.file_manifest || {}).length,
    createdAt: s.created_at.toISOString(),
  }));

  return {
    id: proj.id,
    ownerId: proj.owner_id,
    forkedFromReleaseId: proj.forked_from_release_id,
    title: proj.title,
    description: proj.description,
    mode: proj.mode,
    orientation: proj.orientation,
    currentSnapshotId: proj.current_snapshot_id,
    configSchema: proj.config_schema ?? [],
    files,
    snapshots,
    createdAt: proj.created_at.toISOString(),
    updatedAt: proj.updated_at.toISOString(),
  };
}

const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  const port = Number(process.env.API_PORT || 4002);
  const { app, storage } = await createPlatformApiApp();
  await app.listen({ port, host: "0.0.0.0" });
  console.log(
    `[api] Listening on http://0.0.0.0:${port} (PostgreSQL ready, RustFS S3: ${storage.isAvailable() ? "connected" : "fallback"})`,
  );
}
