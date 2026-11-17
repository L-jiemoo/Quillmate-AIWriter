import { NextResponse } from "next/server";
import {
  apiError,
  assertSameOrigin,
  noStoreJson,
  readJsonBody,
} from "@/lib/api";
import {
  isPromptAgent,
  PROMPT_AGENTS,
  PROMPT_CATALOG,
} from "@/lib/prompt-registry";
import {
  createPromptVersion,
  readPromptStore,
  readPromptUsage,
  setActivePromptVersion,
} from "@/lib/prompt-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshot() {
  const [store, usage] = await Promise.all([
    readPromptStore(),
    readPromptUsage(50),
  ]);
  return {
    agents: PROMPT_AGENTS.map((agent) => ({
      agent,
      ...PROMPT_CATALOG[agent],
      activeId: store.active[agent] ?? null,
      versions: store.versions
        .filter((version) => version.agent === agent)
        .sort((a, b) => b.versionNumber - a.versionNumber),
    })),
    usage,
    updatedAt: store.updatedAt,
  };
}

export async function GET() {
  try {
    return noStoreJson(await snapshot());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody<{
      agent?: unknown;
      mode?: unknown;
      instructions?: unknown;
      label?: unknown;
      note?: unknown;
      activate?: unknown;
    }>(request);
    if (!isPromptAgent(body.agent)) {
      return NextResponse.json({ error: "未知的提示词 Agent" }, { status: 400 });
    }
    if (body.mode !== "system" && body.mode !== "user") {
      return NextResponse.json(
        { error: "附加规则只能追加到 system 或 user" },
        { status: 400 },
      );
    }
    if (typeof body.instructions !== "string") {
      return NextResponse.json({ error: "附加提示词不能为空" }, { status: 400 });
    }
    const version = await createPromptVersion({
      agent: body.agent,
      mode: body.mode,
      instructions: body.instructions,
      label: typeof body.label === "string" ? body.label : "",
      note: typeof body.note === "string" ? body.note : "",
      activate: body.activate !== false,
    });
    return noStoreJson({ version, ...(await snapshot()) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody<{
      agent?: unknown;
      activeId?: unknown;
    }>(request);
    if (!isPromptAgent(body.agent)) {
      return NextResponse.json({ error: "未知的提示词 Agent" }, { status: 400 });
    }
    if (body.activeId !== null && typeof body.activeId !== "string") {
      return NextResponse.json(
        { error: "activeId 必须是版本 ID，或 null 表示恢复内置" },
        { status: 400 },
      );
    }
    await setActivePromptVersion(body.agent, body.activeId);
    return noStoreJson(await snapshot());
  } catch (error) {
    return apiError(error);
  }
}
