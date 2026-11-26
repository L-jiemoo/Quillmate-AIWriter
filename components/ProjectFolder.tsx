"use client";

// 作品卡片上的“档案夹”装饰：悬停微微打开，点击后三张卡片完全抽出，抽出结束再进入工作台。
// SVG 里用到的 filter id 必须全局唯一，所以用 uid 拼进 id。
import { useEffect, useRef, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

// 与 .pf-card / .pf-flap 的 transition（0.45s + 错峰延迟）对齐，动画播完再跳转。
const OPEN_DELAY = 450;

export function ProjectFolder({
  uid,
  label,
  href,
}: {
  uid: string;
  label: string;
  href: string;
}) {
  const router = useRouter();
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    // 取消勾选（连点两次）时只收起卡片，不跳转。
    if (!event.target.checked) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      router.push(href);
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      router.push(href);
    }, OPEN_DELAY);
  }

  return (
    <label className="pf" onPointerEnter={() => router.prefetch(href)}>
      <input
        type="checkbox"
        className="pf-toggle"
        aria-label={label}
        onChange={handleChange}
      />
      <div className="pf-stage">
        <div className="pf-back" />
        <div className="pf-cards">
          {[1, 2, 3].map((index) => (
            <div className={`pf-card pf-card-${index}`} key={index}>
              <svg
                width="164"
                height="214"
                viewBox="0 0 164 214"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <g filter={`url(#pf-shadow-${uid}-${index})`}>
                  <rect width="163.078" height="213.262" rx="20" fill="var(--pf-card-fill)" />
                </g>
                <rect
                  x="0.5"
                  y="0.5"
                  width="162.078"
                  height="212.262"
                  rx="19.5"
                  stroke="var(--pf-card-stroke)"
                />
                <rect
                  x="14.1193"
                  y="31.2091"
                  width="134.84"
                  height="11.8892"
                  rx="5.94459"
                  fill="var(--pf-card-line)"
                />
                {[61, 75.1, 89.2, 103.3, 117.4, 131.6].map((y) => (
                  <g key={y}>
                    <rect
                      width="64.5183"
                      height="5.88276"
                      rx="2.94138"
                      x="14.8253"
                      y={y}
                      fill="var(--pf-card-line)"
                    />
                    <rect
                      width="64.5183"
                      height="5.88276"
                      rx="2.94138"
                      x="84.4303"
                      y={y - 0.03}
                      fill="var(--pf-card-line)"
                    />
                  </g>
                ))}
                <defs>
                  <filter
                    id={`pf-shadow-${uid}-${index}`}
                    x="0"
                    y="0"
                    width="166.078"
                    height="218.262"
                    filterUnits="userSpaceOnUse"
                    colorInterpolationFilters="sRGB"
                  >
                    <feFlood floodOpacity="0" result="BackgroundImageFix" />
                    <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feMorphology
                      radius="2"
                      operator="erode"
                      in="SourceAlpha"
                      result="innerShadow"
                    />
                    <feOffset dx="3" dy="5" />
                    <feGaussianBlur stdDeviation="3.05" />
                    <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"
                    />
                    <feBlend mode="normal" in2="shape" />
                  </filter>
                </defs>
              </svg>
            </div>
          ))}
        </div>

        <div className="pf-flap">
          <div className="pf-flap-blur" />
          <svg
            width="321"
            height="241"
            viewBox="0 0 321 241"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <g filter={`url(#pf-flap-shadow-${uid})`}>
              <path
                d="M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z"
                fill="var(--pf-flap-fill)"
                fillOpacity="var(--pf-flap-fill-opacity)"
              />
              <path
                d="M25 0.5H136.084C142.905 0.5 149.417 3.3431 154.054 8.3457L177.713 33.874C182.539 39.0808 189.317 42.04 196.416 42.04H296C309.531 42.04 320.5 53.0092 320.5 66.54V216C320.5 229.531 309.531 240.5 296 240.5H25C11.469 240.5 0.5 229.531 0.5 216V25C0.5 11.469 11.469 0.5 25 0.5Z"
                stroke="var(--pf-flap-stroke)"
              />
            </g>
            <defs>
              <filter
                id={`pf-flap-shadow-${uid}`}
                x="-25.4"
                y="-25.4"
                width="371.8"
                height="291.8"
                filterUnits="userSpaceOnUse"
                colorInterpolationFilters="sRGB"
              >
                <feFlood floodOpacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feColorMatrix
                  in="SourceAlpha"
                  type="matrix"
                  values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                  result="hardAlpha"
                />
                <feOffset />
                <feGaussianBlur stdDeviation="2.65" />
                <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
                <feColorMatrix
                  type="matrix"
                  values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.37 0"
                />
                <feBlend mode="normal" in2="shape" />
              </filter>
            </defs>
          </svg>
        </div>
      </div>
    </label>
  );
}
