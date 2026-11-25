import { NextRequest } from "next/server";
import type { CloudAgentEvent, CloudAgentRequest } from "@aa-game/protocol";
import { runCloudAgentLoop } from "@aa-game/harness-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let payload: CloudAgentRequest;
  try {
    payload = (await req.json()) as CloudAgentRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!payload.modelConfig?.apiKey || !payload.modelConfig?.model) {
    return new Response(
      JSON.stringify({ error: "请先配置云端/BYOK 模型的 API Key 与模型名称，或切换到本地 ACP Agent 模式。" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: CloudAgentEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
      };
      try {
        await runCloudAgentLoop(
          {
            ...payload,
            roomServerUrl:
              payload.roomServerUrl ||
              process.env.NEXT_PUBLIC_ROOM_SERVER_URL ||
              "http://127.0.0.1:4000",
          },
          send,
        );
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
