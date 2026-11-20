import { SkeletonLines } from "@/components/ui/Loading";

export default function Loading() {
  return (
    <main className="shell workspace loading-page" aria-busy="true">
      <section className="workspace-head">
        <div className="workspace-title-row">
          <div>
            <span className="skeleton-line skeleton-title" />
            <SkeletonLines lines={1} className="skeleton-chips" />
          </div>
        </div>
      </section>
      <div className="workspace-layout">
        <aside className="workspace-nav skeleton-block" aria-hidden="true" />
        <section className="main-column">
          <div className="panel">
            <div className="panel-head">
              <span className="skeleton-line skeleton-w-sm" />
            </div>
            <div className="panel-body">
              <SkeletonLines lines={8} />
            </div>
          </div>
        </section>
        <aside className="side-column">
          <div className="panel">
            <div className="panel-head">
              <span className="skeleton-line skeleton-w-sm" />
            </div>
            <div className="panel-body">
              <SkeletonLines lines={6} />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
