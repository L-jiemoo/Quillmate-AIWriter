import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { errorMessage } from "./utils";

export type StorageErrorCode = "not_found" | "corrupted" | "io_error";

// 读取时必须能区分“文件不存在”和“文件损坏”：
// 前者可以按缺失处理，后者绝不能当成空数据继续写回。
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly filePath: string;

  constructor(code: StorageErrorCode, filePath: string, message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.filePath = filePath;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function readTextStrict(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new StorageError("not_found", filePath, `文件不存在：${filePath}`, error);
    }
    throw new StorageError(
      "io_error",
      filePath,
      `读取文件失败：${filePath}（${errorMessage(error)}）`,
      error,
    );
  }
}

export async function readJsonStrict<T>(filePath: string): Promise<T> {
  const text = await readTextStrict(filePath);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new StorageError(
      "corrupted",
      filePath,
      `JSON 文件已损坏，已停止读取：${filePath}`,
      error,
    );
  }
}

export async function readTextOptional(filePath: string, fallback = ""): Promise<string> {
  try {
    return await readTextStrict(filePath);
  } catch (error) {
    if (error instanceof StorageError && error.code === "not_found") return fallback;
    throw error;
  }
}

export async function readJsonOptional<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJsonStrict<T>(filePath);
  } catch (error) {
    if (error instanceof StorageError && error.code === "not_found") return fallback;
    throw error;
  }
}

// 先写同目录临时文件并 fsync，再 rename 覆盖目标，避免进程中断留下半截 JSON/正文。
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tmp, "w", options.mode ?? 0o666);
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new StorageError(
      "io_error",
      filePath,
      `写入文件失败：${filePath}（${errorMessage(error)}）`,
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows 上目标文件被占用时 MoveFileEx 可能报 EEXIST/EPERM；
    // 退化为“先删旧文件再改名”，此时仍保留了已 fsync 的新内容。
    if (process.platform === "win32" && (code === "EEXIST" || code === "EPERM")) {
      try {
        await fs.rm(filePath, { force: true });
        await fs.rename(tmp, filePath);
        return;
      } catch (retryError) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw new StorageError(
          "io_error",
          filePath,
          `替换文件失败：${filePath}（${errorMessage(retryError)}）`,
          retryError,
        );
      }
    }
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new StorageError(
      "io_error",
      filePath,
      `替换文件失败：${filePath}（${errorMessage(error)}）`,
      error,
    );
  }
}

export interface BackupOptions {
  dir: string;
  name?: string;
  keep?: number;
}

function safeBackupName(name: string): string {
  return name.replace(/[\\/]+/g, "__").replace(/[<>:"|?*]/g, "_");
}

async function pruneBackups(dir: string, base: string, keep: number): Promise<void> {
  if (keep <= 0) return;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const prefix = `${base}.`;
  const stale = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".bak"))
    .sort();
  for (const entry of stale.slice(0, Math.max(0, stale.length - keep))) {
    await fs.rm(path.join(dir, entry), { force: true }).catch(() => undefined);
  }
}

export async function backupFile(
  filePath: string,
  options: BackupOptions,
): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new StorageError(
      "io_error",
      filePath,
      `检查文件失败：${filePath}（${errorMessage(error)}）`,
      error,
    );
  }

  const base = safeBackupName(options.name ?? path.basename(filePath));
  await fs.mkdir(options.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // 同一毫秒内多次写入时用随机后缀避免备份互相覆盖；时间戳前缀仍保证排序。
  const target = path.join(options.dir, `${base}.${stamp}-${randomUUID().slice(0, 8)}.bak`);

  try {
    await fs.copyFile(filePath, target);
  } catch (error) {
    throw new StorageError(
      "io_error",
      filePath,
      `备份文件失败：${filePath}（${errorMessage(error)}）`,
      error,
    );
  }

  await pruneBackups(options.dir, base, options.keep ?? 20);
  return target;
}

export async function writeFileSafe(
  filePath: string,
  data: string,
  options: { backup?: BackupOptions } = {},
): Promise<void> {
  if (options.backup) {
    await backupFile(filePath, options.backup);
  }
  await writeFileAtomic(filePath, data);
}

export async function writeTextSafe(
  filePath: string,
  data: string,
  options: { backup?: BackupOptions } = {},
): Promise<void> {
  await writeFileSafe(filePath, data, options);
}

export async function writeJsonSafe(
  filePath: string,
  value: unknown,
  options: { backup?: BackupOptions } = {},
): Promise<void> {
  await writeTextSafe(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
