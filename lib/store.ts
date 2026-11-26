import { shouldUseSqlite } from "./storage-mode";
import * as fileStore from "./store-file";

type StoreModule = typeof import("./store-file");

// 文件后端保留为未迁移项目和回滚路径；数据库后端按需加载，文件模式下不会打开 SQLite。
async function backend(): Promise<StoreModule> {
  if (shouldUseSqlite()) {
    const sqlite = await import("./store-sqlite");
    return sqlite as unknown as StoreModule;
  }
  return fileStore;
}

export { DEFAULT_FANQIE, DEFAULT_PLAN, normalizeCharacter } from "./store-file";
export type {
  AuditReport,
  CommitArchitectureResult,
  CreateProjectInput,
  DeleteChapterResult,
  FixPlanConsistencyResult,
  IntegrityIssue,
  IntegrityReport,
  IntegritySeverity,
  RestoreChapterVersionResult,
  SaveCharactersOptions,
  UpdateProjectPatch,
  WriteChapterOptions,
} from "./store-file";

export async function saveCanon(
  ...args: Parameters<StoreModule["saveCanon"]>
): ReturnType<StoreModule["saveCanon"]> {
  return (await backend()).saveCanon(...args);
}

export async function getCanon(
  ...args: Parameters<StoreModule["getCanon"]>
): ReturnType<StoreModule["getCanon"]> {
  return (await backend()).getCanon(...args);
}

export async function getMemory(
  ...args: Parameters<StoreModule["getMemory"]>
): ReturnType<StoreModule["getMemory"]> {
  return (await backend()).getMemory(...args);
}

export async function saveMemory(
  ...args: Parameters<StoreModule["saveMemory"]>
): ReturnType<StoreModule["saveMemory"]> {
  return (await backend()).saveMemory(...args);
}

export async function getStory(
  ...args: Parameters<StoreModule["getStory"]>
): ReturnType<StoreModule["getStory"]> {
  return (await backend()).getStory(...args);
}

export async function saveStory(
  ...args: Parameters<StoreModule["saveStory"]>
): ReturnType<StoreModule["saveStory"]> {
  return (await backend()).saveStory(...args);
}

export async function getPlanLedger(
  ...args: Parameters<StoreModule["getPlanLedger"]>
): ReturnType<StoreModule["getPlanLedger"]> {
  return (await backend()).getPlanLedger(...args);
}

export async function savePlanLedger(
  ...args: Parameters<StoreModule["savePlanLedger"]>
): ReturnType<StoreModule["savePlanLedger"]> {
  return (await backend()).savePlanLedger(...args);
}

export async function commitCanonRebuild(
  ...args: Parameters<StoreModule["commitCanonRebuild"]>
): ReturnType<StoreModule["commitCanonRebuild"]> {
  return (await backend()).commitCanonRebuild(...args);
}

export async function createProject(
  ...args: Parameters<StoreModule["createProject"]>
): ReturnType<StoreModule["createProject"]> {
  return (await backend()).createProject(...args);
}

export async function deleteProject(
  ...args: Parameters<StoreModule["deleteProject"]>
): ReturnType<StoreModule["deleteProject"]> {
  return (await backend()).deleteProject(...args);
}

export async function getProjectFile(
  ...args: Parameters<StoreModule["getProjectFile"]>
): ReturnType<StoreModule["getProjectFile"]> {
  return (await backend()).getProjectFile(...args);
}

export async function listProjects(
  ...args: Parameters<StoreModule["listProjects"]>
): ReturnType<StoreModule["listProjects"]> {
  return (await backend()).listProjects(...args);
}

export async function getProjectDetail(
  ...args: Parameters<StoreModule["getProjectDetail"]>
): ReturnType<StoreModule["getProjectDetail"]> {
  return (await backend()).getProjectDetail(...args);
}

export async function savePlan(
  ...args: Parameters<StoreModule["savePlan"]>
): ReturnType<StoreModule["savePlan"]> {
  return (await backend()).savePlan(...args);
}

export async function appendChapters(
  ...args: Parameters<StoreModule["appendChapters"]>
): ReturnType<StoreModule["appendChapters"]> {
  return (await backend()).appendChapters(...args);
}

export async function appendOutlineSection(
  ...args: Parameters<StoreModule["appendOutlineSection"]>
): ReturnType<StoreModule["appendOutlineSection"]> {
  return (await backend()).appendOutlineSection(...args);
}

export async function commitArchitecture(
  ...args: Parameters<StoreModule["commitArchitecture"]>
): ReturnType<StoreModule["commitArchitecture"]> {
  return (await backend()).commitArchitecture(...args);
}

export async function saveCharacters(
  ...args: Parameters<StoreModule["saveCharacters"]>
): ReturnType<StoreModule["saveCharacters"]> {
  return (await backend()).saveCharacters(...args);
}

export async function updateProject(
  ...args: Parameters<StoreModule["updateProject"]>
): ReturnType<StoreModule["updateProject"]> {
  return (await backend()).updateProject(...args);
}

export async function writeChapterFile(
  ...args: Parameters<StoreModule["writeChapterFile"]>
): ReturnType<StoreModule["writeChapterFile"]> {
  return (await backend()).writeChapterFile(...args);
}

export async function listChapterVersions(
  ...args: Parameters<StoreModule["listChapterVersions"]>
): ReturnType<StoreModule["listChapterVersions"]> {
  return (await backend()).listChapterVersions(...args);
}

export async function getChapterVersion(
  ...args: Parameters<StoreModule["getChapterVersion"]>
): ReturnType<StoreModule["getChapterVersion"]> {
  return (await backend()).getChapterVersion(...args);
}

export async function restoreChapterVersion(
  ...args: Parameters<StoreModule["restoreChapterVersion"]>
): ReturnType<StoreModule["restoreChapterVersion"]> {
  return (await backend()).restoreChapterVersion(...args);
}

export async function saveRejectedDraft(
  ...args: Parameters<StoreModule["saveRejectedDraft"]>
): ReturnType<StoreModule["saveRejectedDraft"]> {
  return (await backend()).saveRejectedDraft(...args);
}

export async function getRejectedDraftContent(
  ...args: Parameters<StoreModule["getRejectedDraftContent"]>
): ReturnType<StoreModule["getRejectedDraftContent"]> {
  return (await backend()).getRejectedDraftContent(...args);
}

export async function saveRepairBackup(
  ...args: Parameters<StoreModule["saveRepairBackup"]>
): ReturnType<StoreModule["saveRepairBackup"]> {
  return (await backend()).saveRepairBackup(...args);
}

export async function markChapterRepaired(
  ...args: Parameters<StoreModule["markChapterRepaired"]>
): ReturnType<StoreModule["markChapterRepaired"]> {
  return (await backend()).markChapterRepaired(...args);
}

export async function markChapterWritten(
  ...args: Parameters<StoreModule["markChapterWritten"]>
): ReturnType<StoreModule["markChapterWritten"]> {
  return (await backend()).markChapterWritten(...args);
}

export async function updateChapterSummary(
  ...args: Parameters<StoreModule["updateChapterSummary"]>
): ReturnType<StoreModule["updateChapterSummary"]> {
  return (await backend()).updateChapterSummary(...args);
}

export async function saveChapter(
  ...args: Parameters<StoreModule["saveChapter"]>
): ReturnType<StoreModule["saveChapter"]> {
  return (await backend()).saveChapter(...args);
}

export async function deleteChapter(
  ...args: Parameters<StoreModule["deleteChapter"]>
): ReturnType<StoreModule["deleteChapter"]> {
  return (await backend()).deleteChapter(...args);
}

export async function buildBookText(
  ...args: Parameters<StoreModule["buildBookText"]>
): ReturnType<StoreModule["buildBookText"]> {
  return (await backend()).buildBookText(...args);
}

export async function exportBookFile(
  ...args: Parameters<StoreModule["exportBookFile"]>
): ReturnType<StoreModule["exportBookFile"]> {
  return (await backend()).exportBookFile(...args);
}

export async function writeAuditReport(
  ...args: Parameters<StoreModule["writeAuditReport"]>
): ReturnType<StoreModule["writeAuditReport"]> {
  return (await backend()).writeAuditReport(...args);
}

export async function getAuditReport(
  ...args: Parameters<StoreModule["getAuditReport"]>
): ReturnType<StoreModule["getAuditReport"]> {
  return (await backend()).getAuditReport(...args);
}

export async function getWrittenChapters(
  ...args: Parameters<StoreModule["getWrittenChapters"]>
): ReturnType<StoreModule["getWrittenChapters"]> {
  return (await backend()).getWrittenChapters(...args);
}

export async function appendPublishRecord(
  ...args: Parameters<StoreModule["appendPublishRecord"]>
): ReturnType<StoreModule["appendPublishRecord"]> {
  return (await backend()).appendPublishRecord(...args);
}

export async function clearPublishHistory(
  ...args: Parameters<StoreModule["clearPublishHistory"]>
): ReturnType<StoreModule["clearPublishHistory"]> {
  return (await backend()).clearPublishHistory(...args);
}

export async function getPublishLedger(
  ...args: Parameters<StoreModule["getPublishLedger"]>
): ReturnType<StoreModule["getPublishLedger"]> {
  return (await backend()).getPublishLedger(...args);
}

export async function recordPublishOutcome(
  ...args: Parameters<StoreModule["recordPublishOutcome"]>
): ReturnType<StoreModule["recordPublishOutcome"]> {
  return (await backend()).recordPublishOutcome(...args);
}

export async function resolvePublishOutcome(
  ...args: Parameters<StoreModule["resolvePublishOutcome"]>
): ReturnType<StoreModule["resolvePublishOutcome"]> {
  return (await backend()).resolvePublishOutcome(...args);
}

export async function resolvePublishOutcomes(
  ...args: Parameters<StoreModule["resolvePublishOutcomes"]>
): ReturnType<StoreModule["resolvePublishOutcomes"]> {
  return (await backend()).resolvePublishOutcomes(...args);
}

export async function checkProjectIntegrity(
  ...args: Parameters<StoreModule["checkProjectIntegrity"]>
): ReturnType<StoreModule["checkProjectIntegrity"]> {
  return (await backend()).checkProjectIntegrity(...args);
}

export async function fixPlanOutlineConsistency(
  ...args: Parameters<StoreModule["fixPlanOutlineConsistency"]>
): ReturnType<StoreModule["fixPlanOutlineConsistency"]> {
  return (await backend()).fixPlanOutlineConsistency(...args);
}
