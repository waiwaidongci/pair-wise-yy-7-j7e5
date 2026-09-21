// 归档层：负责 JSON 落库与转运单旧版本归档，不含任何业务判定。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "transfer-release.json");

const seed = {
  models: [
    {
      id: "MDL-001",
      code: "FC-048",
      shipType: "福船",
      scale: "1:48",
      mastCount: 3,
      owner: "周宁",
      spec: { ropeDiameter: "0.8mm", winding: "右旋", tension: "2.5N" },
      logs: [{ at: "2026-09-01T08:00:00.000Z", step: "建档", note: "模型入库登记" }],
    },
    {
      id: "MDL-002",
      code: "SC-036",
      shipType: "沙船",
      scale: "1:36",
      mastCount: 2,
      owner: "林澈",
      spec: { ropeDiameter: "0.6mm", winding: "左旋", tension: "1.8N" },
      logs: [{ at: "2026-09-02T08:00:00.000Z", step: "建档", note: "模型入库登记" }],
    },
  ],
  orders: [
    {
      id: "TO-20260910-001",
      modelId: "MDL-001",
      version: 1,
      status: "开放",
      createdAt: "2026-09-10T01:30:00.000Z",
      registration: {
        supports: ["前桅左A", "前桅右A", "主桅左A", "主桅右A", "后桅左A", "后桅右A"],
        locks: ["LK-01", "LK-02"],
        responsible: "周宁",
      },
      originalSpec: { ropeDiameter: "0.8mm", winding: "右旋", tension: "2.5N" },
      operations: [{ type: "封帆", by: "周宁", at: "2026-09-10T02:10:00.000Z" }],
      reset: null,
      rechecks: [],
      lastCompare: null,
      delivery: null,
      versions: [],
      logs: [{ at: "2026-09-10T01:30:00.000Z", step: "开单", note: "登记支撑位 6 个、锁具 2 把，责任人 周宁" }],
    },
  ],
};

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveDb(seed);
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 旧版归档：把当前版本整体快照（不含历史本身）压入 versions，供追溯
export function archiveVersion(order, reason, by) {
  const { versions = [], ...current } = order;
  order.versions = versions;
  order.versions.push({
    version: order.version,
    archivedAt: new Date().toISOString(),
    reason: String(reason || "修改转运单"),
    by: String(by || ""),
    snapshot: JSON.parse(JSON.stringify(current)),
  });
}
