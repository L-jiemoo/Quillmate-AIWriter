"use client";

type Theme = "light" | "dark";

export function ThemeToggle() {
  function toggle() {
    const next: Theme =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("quillmate-theme", next);
    } catch {
      // 无痕模式等场景下无法持久化，切换仍然生效。
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", next === "light" ? "#f5f7fc" : "#080a12");
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label="切换浅色或深色主题"
      title="切换浅色 / 深色主题"
    >
      <svg
        className="theme-icon theme-icon-sun"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
      </svg>
      <svg
        className="theme-icon theme-icon-moon"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.5 8.5 0 1 0 10.6 10.6Z" />
      </svg>
    </button>
  );
}
