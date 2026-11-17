import { apiError, assertSafeSlugParam } from "@/lib/api";
import { buildBookText } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const slug = assertSafeSlugParam(params.slug);
    const book = await buildBookText(slug);
    const filename = `${book.title}-全书.md`;
    return new Response(book.text, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error, 404);
  }
}
