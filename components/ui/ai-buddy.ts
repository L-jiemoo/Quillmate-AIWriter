import type { Job } from "@/lib/types";

export type BuddyMood = "idle" | Job["status"];

interface BuddyFace {
  emoji: string;
  label: string;
}

const STATUS_FACE: Record<BuddyMood, BuddyFace> = {
  idle: { emoji: "🖋️", label: "待命中" },
  queued: { emoji: "⏳", label: "排队中" },
  running: { emoji: "✍️", label: "正在工作" },
  paused: { emoji: "☕", label: "暂停中" },
  done: { emoji: "🎉", label: "任务完成" },
  error: { emoji: "😵", label: "遇到问题了" },
  cancelled: { emoji: "🫡", label: "任务已取消" },
  interrupted: { emoji: "💤", label: "任务被中断" },
};

const JOB_FACE: Record<Job["type"], BuddyFace> = {
  plan: { emoji: "📐", label: "正在搭故事框架" },
  extend: { emoji: "🧩", label: "正在补大纲" },
  write: { emoji: "✍️", label: "正在写章节" },
  rewrite: { emoji: "🪄", label: "正在重写" },
  repair: { emoji: "🛠️", label: "正在修复" },
  recanon: { emoji: "🧾", label: "正在整理事实台账" },
  memory: { emoji: "🧠", label: "正在整理记忆" },
  audit: { emoji: "🔍", label: "正在逐章审校" },
  export: { emoji: "📦", label: "正在导出全书" },
  "fanqie-login": { emoji: "🔐", label: "等待登录番茄" },
  "fanqie-publish": { emoji: "🚀", label: "正在发布番茄" },
};

export function buddyFor(job: Job | null): BuddyFace & { mood: BuddyMood } {
  if (!job) return { mood: "idle", ...STATUS_FACE.idle };
  if (job.status === "running") {
    return { mood: "running", ...JOB_FACE[job.type] };
  }
  return { mood: job.status, ...STATUS_FACE[job.status] };
}

export function logFace(message: string): string {
  const text = message.toLowerCase();
  if (/失败|错误|异常|超时|中断|取消|error|failed/.test(text)) return "😵";
  if (/警告|风险|注意|不足|缺少|warn/.test(text)) return "⚠️";
  if (/完成|成功|通过|已生成|已保存|已发布|done/.test(text)) return "🎉";
  if (/审校|检查|校验|连续性|一致性|audit/.test(text)) return "🔍";
  if (/大纲|架构|章节|草稿|写作|重写|生成|chapter/.test(text)) return "✍️";
  if (/记忆|台账|角色|人物|memory|canon/.test(text)) return "🧠";
  if (/发布|导出|番茄|publish|export/.test(text)) return "🚀";
  if (/登录|扫码|验证码|login/.test(text)) return "🔐";
  return "💬";
}

export function latestLogText(job: Job | null): string {
  if (!job || !job.logs.length) return "";
  return job.logs[job.logs.length - 1].message;
}
