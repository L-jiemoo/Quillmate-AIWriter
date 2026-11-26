import type {
  ForeshadowRecord,
  PlanItem,
  PlanItemChange,
  PlanLedger,
  PlanRelation,
} from "./types";

// 纯只读切片：客户端 UI 和服务端都能用，不依赖 node:crypto 或存储层。

// 放在这里而不是 story.ts：story.ts 依赖 canon，会顺带把 node:crypto 拉进浏览器包。
export function isForeshadowOverdue(
  record: ForeshadowRecord,
  latestChapter: number,
): boolean {
  return (
    record.expectedEndChapter > 0 &&
    latestChapter > record.expectedEndChapter &&
    record.status !== "resolved" &&
    record.status !== "abandoned"
  );
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "");
}

function itemKeys(item: PlanItem): string[] {
  return [item.name, ...item.aliases].map(normalizeName).filter(Boolean);
}

function changeMatches(change: PlanItemChange, item: PlanItem): boolean {
  const key = normalizeName(change.item);
  return Boolean(key) && itemKeys(item).includes(key);
}

export function relationsAt(
  ledger: PlanLedger | undefined,
  chapter: number,
): PlanRelation[] {
  if (!ledger) return [];
  return ledger.relations.filter((relation) => {
    if (relation.status === "cancelled") return false;
    if (relation.startChapter <= 0 || relation.startChapter > chapter) return false;
    return relation.endChapter === 0 || chapter <= relation.endChapter;
  });
}

export interface ItemOwnershipSnapshot {
  item: string;
  holder: string;
  location: string;
  state: string;
  changedChapter: number;
  reason: string;
}

function snapshotOf(item: PlanItem): ItemOwnershipSnapshot {
  return {
    item: item.name,
    holder: item.holder,
    location: item.location,
    state: item.state,
    changedChapter: item.introducedChapter,
    reason: item.note || "架构初始状态",
  };
}

// 从架构基线出发，按章节顺序应用物品变化，得到第 N 章结束时的归属快照。
export function itemOwnershipAt(
  ledger: PlanLedger | undefined,
  chapter: number,
): ItemOwnershipSnapshot[] {
  if (!ledger) return [];
  const snapshots = new Map<string, ItemOwnershipSnapshot>();
  const registry = new Map<string, PlanItem>();
  for (const item of ledger.itemRegistry) {
    registry.set(item.name, item);
    if (item.introducedChapter === 0 || item.introducedChapter <= chapter) {
      snapshots.set(item.name, snapshotOf(item));
    }
  }

  const changes = ledger.items
    .filter(
      (change) =>
        change.chapter <= chapter &&
        change.status !== "cancelled" &&
        change.chapter > 0,
    )
    .slice()
    .sort((left, right) => left.chapter - right.chapter);

  for (const change of changes) {
    const item =
      [...registry.values()].find((entry) => changeMatches(change, entry)) ??
      null;
    const name = item?.name ?? change.item;
    if (!name) continue;
    const existing = snapshots.get(name);
    if (!existing) {
      if (change.changeType !== "introduce" && !item) continue;
      snapshots.set(name, {
        item: name,
        holder: change.holder,
        location: change.location,
        state: change.state || change.stateChange,
        changedChapter: change.chapter,
        reason: change.reason || change.stateChange,
      });
      continue;
    }
    snapshots.set(name, {
      item: name,
      holder: change.holder || existing.holder,
      location: change.location || existing.location,
      state: change.state || change.stateChange || existing.state,
      changedChapter: change.chapter,
      reason: change.reason || change.stateChange || existing.reason,
    });
  }

  return [...snapshots.values()].sort((left, right) =>
    left.item.localeCompare(right.item, "zh-CN"),
  );
}
