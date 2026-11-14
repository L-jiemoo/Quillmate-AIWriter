import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quillmate · AI 小说工作台",
  description: "本地全自动 AI 小说工作台：架构、角色、写作、审校与发布",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="topbar">
          <div className="shell topbar-inner">
            <Link href="/" className="brand">
              <span className="brand-mark">Q</span>
              <span className="brand-text">
                Quillmate
                <small>AI 小说工作台</small>
              </span>
            </Link>
            <div className="topbar-right">
              <Link href="/settings" className="topbar-link">
                模型设置
              </Link>
              <div className="topbar-meta">
                <span className="live-dot" />
                本地运行 · 数据不出本机
              </div>
            </div>
          </div>
        </header>
        {children}
        <footer className="shell footer">Quillmate · 自动生成内容请在发布前人工复核</footer>
      </body>
    </html>
  );
}
