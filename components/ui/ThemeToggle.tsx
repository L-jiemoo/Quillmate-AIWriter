"use client";

import { useEffect, useRef, type ChangeEvent } from "react";

type Theme = "light" | "dark";

function applyTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("quillmate-theme", next);
  } catch {
    // 无痕模式等场景下无法持久化，切换仍然生效。
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", next === "light" ? "#f5f7fc" : "#080a12");
}

export function ThemeToggle() {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 首屏主题由 layout 内联脚本决定；挂载后把开关状态同步过去。
    if (inputRef.current) {
      inputRef.current.checked =
        document.documentElement.dataset.theme === "light";
    }
  }, []);

  function toggle(event: ChangeEvent<HTMLInputElement>) {
    applyTheme(event.target.checked ? "light" : "dark");
  }

  return (
    <label className="theme-toggle" title="切换浅色 / 深色主题">
      <span className="toggle">
        <input
          ref={inputRef}
          className="toggle-state"
          type="checkbox"
          name="theme"
          value="light"
          role="switch"
          aria-label="浅色主题"
          onChange={toggle}
        />
        <span className="indicator" aria-hidden="true" />
      </span>
    </label>
  );
}
