import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPlatformApiApp } from "./index.js";

test("Milestone 3 Platform API E2E: Auth + Content-Addressed Snapshots + Rollback + RustFS S3 Upload/Publish + Gallery + Likes + Remix + Export HTML/Zip", async () => {
  const { app } = await createPlatformApiApp({ skipSeed: true });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const suffix = crypto.randomBytes(4).toString("hex");

  try {
    // 1. Health check proves Podman PostgreSQL & RustFS S3 connectivity
    const healthRes = await fetch(`${address}/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { ok: boolean; dbOk: boolean; s3Ok: boolean };
    assert.equal(health.ok, true);
    assert.equal(health.dbOk, true);
    assert.equal(health.s3Ok, true, "Podman RustFS S3 should be connected");

    // 2. Register Creator A & Creator B
    const regA = await fetch(`${address}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: `alice_${suffix}`,
        password: "password123",
        displayName: "Alice Dev",
      }),
    });
    assert.equal(regA.status, 200);
    const authA = (await regA.json()) as { token: string; user: { id: string; username: string } };
    assert.ok(authA.token);

    const regB = await fetch(`${address}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: `bob_${suffix}`,
        password: "password123",
        displayName: "Bob Remixer",
      }),
    });
    assert.equal(regB.status, 200);
    const authB = (await regB.json()) as { token: string; user: { id: string } };

    // 3. Create project from golden template -> creates initial snapshot
    const createProjRes = await fetch(`${address}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authA.token}`,
      },
      body: JSON.stringify({
        title: `Neon Space ${suffix}`,
        description: "Test neon game",
        templateId: "neon-dodger",
      }),
    });
    assert.equal(createProjRes.status, 200);
    const createdProj = (await createProjRes.json()) as {
      project: {
        id: string;
        currentSnapshotId: string;
        files: Record<string, string>;
        snapshots: Array<{ id: string }>;
      };
    };
    const projectId = createdProj.project.id;
    const snap1Id = createdProj.project.currentSnapshotId;
    assert.ok(createdProj.project.files["simulation.ts"]);

    // 4. Save Snapshot #2 with updated config.json, then Rollback to Snapshot #1
    const v2Files = {
      ...createdProj.project.files,
      "config.json": JSON.stringify({ playerSpeed: 499, lives: 5 }, null, 2),
    };
    const saveSnapRes = await fetch(`${address}/api/projects/${projectId}/snapshots`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authA.token}`,
      },
      body: JSON.stringify({
        files: v2Files,
        commitSummary: "调高移速到 499",
      }),
    });
    assert.equal(saveSnapRes.status, 200);
    const savedV2 = (await saveSnapRes.json()) as {
      project: { files: Record<string, string>; snapshots: Array<{ id: string }> };
    };
    assert.ok(savedV2.project.files["config.json"]!.includes("499"));
    assert.equal(savedV2.project.snapshots.length, 2);

    const rollbackRes = await fetch(`${address}/api/projects/${projectId}/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authA.token}`,
      },
      body: JSON.stringify({ snapshotId: snap1Id }),
    });
    assert.equal(rollbackRes.status, 200);
    const rolledBack = (await rollbackRes.json()) as {
      project: { currentSnapshotId: string; files: Record<string, string> };
    };
    assert.equal(rolledBack.project.currentSnapshotId, snap1Id);
    assert.ok(rolledBack.project.files["config.json"]!.includes("300"));

    // 5. Upload custom sprite to RustFS S3 & verify HTTP GET from S3 URL
    const tinySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#38bdf8"/></svg>`;
    const upRes = await fetch(`${address}/api/assets/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "orb.svg",
        mimeType: "image/svg+xml",
        dataBase64: Buffer.from(tinySvg).toString("base64"),
        assetId: `orb_${suffix}`,
      }),
    });
    assert.equal(upRes.status, 200);
    const uploaded = (await upRes.json()) as { storage: string; url: string; entry: { id: string } };
    assert.equal(uploaded.storage, "s3");
    const s3Fetch = await fetch(uploaded.url);
    assert.equal(s3Fetch.status, 200);
    assert.ok((await s3Fetch.text()).includes("<circle"));

    // 6. On-demand sprite generation + transparent background (stored in RustFS S3)
    const genRes = await fetch(`${address}/api/assets/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "cyber plasma drone",
        style: "pixel",
        removeBg: true,
      }),
    });
    assert.equal(genRes.status, 200);
    const generated = (await genRes.json()) as { storage: string; url: string; entry: { source: string } };
    assert.equal(generated.storage, "s3");
    assert.equal(generated.entry.source, "generated");

    // 7. Publish Release -> stored in Postgres + RustFS S3
    const pubRes = await fetch(`${address}/api/projects/${projectId}/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authA.token}`,
      },
      body: JSON.stringify({
        title: `Neon Star Release ${suffix}`,
        description: "Published E2E test release",
        isPublic: true,
        files: v2Files,
      }),
    });
    assert.equal(pubRes.status, 200);
    const published = (await pubRes.json()) as {
      release: { slug: string; title: string };
      clientBundleUrl: string | null;
      roomBundleUrl: string | null;
    };
    assert.ok(published.release.slug);
    assert.ok(published.clientBundleUrl);
    assert.ok(published.roomBundleUrl);

    // 8. Gallery listing, Direct Play fetch (increments play_count), Like toggle, and Fork/Remix by User B
    const galleryRes = await fetch(`${address}/api/releases?q=${encodeURIComponent(suffix)}`);
    assert.equal(galleryRes.status, 200);
    const gallery = (await galleryRes.json()) as { releases: Array<{ slug: string }> };
    assert.ok(gallery.releases.some((r) => r.slug === published.release.slug));

    const playRes = await fetch(`${address}/api/releases/${published.release.slug}`);
    assert.equal(playRes.status, 200);
    const playData = (await playRes.json()) as {
      release: { playCount: number };
      clientBundle: string;
      simBundle: string;
    };
    assert.equal(playData.release.playCount, 1);
    assert.ok(playData.clientBundle.length > 50);
    assert.ok(playData.simBundle.length > 50);

    const likeRes = await fetch(`${address}/api/releases/${published.release.slug}/like`, {
      method: "POST",
      headers: { authorization: `Bearer ${authB.token}` },
    });
    assert.equal(likeRes.status, 200);
    const liked = (await likeRes.json()) as { liked: boolean; release: { likeCount: number } };
    assert.equal(liked.liked, true);
    assert.equal(liked.release.likeCount, 1);

    const remixRes = await fetch(`${address}/api/releases/${published.release.slug}/remix`, {
      method: "POST",
      headers: { authorization: `Bearer ${authB.token}` },
    });
    assert.equal(remixRes.status, 200);
    const remixed = (await remixRes.json()) as {
      project: { id: string; ownerId: string; title: string; files: Record<string, string> };
    };
    assert.equal(remixed.project.ownerId, authB.user.id);
    assert.ok(remixed.project.title.includes("Remix"));
    assert.ok(remixed.project.files["config.json"]!.includes("499"));

    // 9. Standalone HTML & Standard Source ZIP Export
    const htmlRes = await fetch(`${address}/api/export/html`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Neon Export", files: v2Files }),
    });
    assert.equal(htmlRes.status, 200);
    const htmlBody = await htmlRes.text();
    assert.ok(htmlBody.includes("<!doctype html>") && htmlBody.includes("Neon Export"));

    const zipRes = await fetch(`${address}/api/export/zip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Neon Export", files: v2Files }),
    });
    assert.equal(zipRes.status, 200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    // PKZIP magic header: 0x50 0x4b 0x03 0x04
    assert.equal(zipBuf[0], 0x50);
    assert.equal(zipBuf[1], 0x4b);
  } finally {
    await app.close();
  }
});
