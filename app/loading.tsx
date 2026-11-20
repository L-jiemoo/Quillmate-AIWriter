import { SkeletonLines } from "@/components/ui/Loading";

export default function Loading() {
  return (
    <main className="shell loading-page" aria-busy="true">
      <section className="hero loading-hero">
        <div className="hero-copy">
          <span className="skeleton-line skeleton-w-xs" />
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-title skeleton-title-sm" />
          <SkeletonLines lines={2} />
        </div>
        <aside className="hero-aside skeleton-block" aria-hidden="true" />
      </section>
      <div className="dashboard-grid">
        <section>
          <div className="section-head">
            <span className="skeleton-line skeleton-w-sm" />
          </div>
          <div className="project-grid">
            {[0, 1, 2].map((item) => (
              <div key={item} className="project-card skeleton-card">
                <SkeletonLines lines={3} />
              </div>
            ))}
          </div>
        </section>
        <section className="panel create-panel">
          <div className="panel-head">
            <span className="skeleton-line skeleton-w-sm" />
          </div>
          <div className="panel-body">
            <SkeletonLines lines={7} />
          </div>
        </section>
      </div>
    </main>
  );
}
