import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quillmate · AI 小说工作台",
  description: "本地全自动 AI 小说工作台：架构、角色、写作、审校与发布",
};

export const viewport = {
  colorScheme: "light dark" as const,
};

// 在首屏绘制前确定主题，避免深色用户看到一闪而过的白屏。
const themeScript = `(function(){try{var t=localStorage.getItem("quillmate-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute("content",t==="light"?"#f5f7fc":"#080a12");}}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#080a12" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
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
              <ThemeToggle />
              <Link href="/settings" className="topbar-link">
                模型设置
              </Link>
              <div className="topbar-meta">
                <span className="live-dot" />
                本地运行，数据不出本机
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
