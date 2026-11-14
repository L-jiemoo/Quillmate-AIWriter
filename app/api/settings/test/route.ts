import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getRuntimeConfig } from "@/lib/config";
import { readSettings } from "@/lib/settings";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      provider?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    };

    const base = getRuntimeConfig();

    if (body.provider === "mock") {
      return NextResponse.json({
        ok: true,
        mock: true,
        message: "当前选择的是 mock 模式，不会调用外部模型。",
      });
    }

    const saved = await readSettings();
    const baseUrl =
      typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : base.baseUrl;
    const model =
      typeof body.model === "string" && body.model.trim() ? body.model.trim() : base.model;
    // 测试连接允许“还没保存就先测”：优先用表单里临时填的 Key，
    // 没有则依次回落到已保存设置、环境变量和运行时配置。
    const apiKey =
      (typeof body.apiKey === "string" && body.apiKey.trim()
        ? body.apiKey.trim()
        : saved?.apiKey) ||
      process.env.LLM_API_KEY?.trim() ||
      base.apiKey;

    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "没有可用的 API Key，请先填写后再测试。" },
        { status: 400 },
      );
    }

    try {
      new URL(baseUrl);
    } catch {
      return NextResponse.json({ ok: false, error: "接口地址格式不正确。" }, { status: 400 });
    }

    const client = new OpenAI({ apiKey, baseURL: baseUrl, timeout: 20000, maxRetries: 0 });
    const started = Date.now();
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "只回复四个字：连接成功" }],
      temperature: 0,
      max_tokens: 16,
    });

    return NextResponse.json({
      ok: true,
      model,
      latencyMs: Date.now() - started,
      reply: response.choices[0]?.message?.content?.trim() ?? "",
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 502 });
  }
}
