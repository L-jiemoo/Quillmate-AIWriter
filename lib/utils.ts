export function nowIso(): string {
  return new Date().toISOString();
}

export function countWords(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function isSafeSlug(slug: string): boolean {
  // slug 会直接拼进 data/projects/<slug> 路径，必须限制为安全字符，
  // 防止 ../ 之类的输入越过项目目录。
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

export function assertSafeSlug(slug: string): void {
  if (!isSafeSlug(slug)) throw new Error("slug 不合法");
}

export function isSafeJobId(id: string): boolean {
  // 任务 ID 由 randomUUID 生成，会直接拼进 jobs/<id>.json；只接受 UUID。
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

export function slugify(input: string): string {
  // 中文书名过滤掉非 ASCII 字符后可能为空，这时用时间戳兜底，
  // 保证每个项目都有可用的目录名，而不是退化成空 slug。
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || `book-${Date.now().toString(36)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
