import { NextRequest, NextResponse } from "next/server";
import { searchAssetCatalog } from "@aa-game/harness-core";
import type { AssetEntry } from "@aa-game/protocol";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") || "";
  const kind = (searchParams.get("kind") || undefined) as AssetEntry["kind"] | undefined;
  const limit = Number(searchParams.get("limit") || 16);
  const items = searchAssetCatalog(q, { kind, limit });
  return NextResponse.json({ items });
}
