import os from "node:os";

const lanOrigins = Object.values(os.networkInterfaces())
  .flat()
  .filter((info) => info?.family === "IPv4" && !info.internal)
  .map((info) => info.address);

const extraOrigins = (process.env.QUILLMATE_DEV_ORIGINS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["playwright", "openai"],
  // Next 16 默认拦截非 localhost 来源的开发资源（含 HMR），
  // 用局域网 IP 打开时客户端无法接管，页签点击会失效。
  allowedDevOrigins: [...new Set(["127.0.0.1", ...lanOrigins, ...extraOrigins])],
  agentRules: false,
};

export default nextConfig;
