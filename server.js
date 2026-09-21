// 接入层：HTTP 路由，把请求分派给判定层（judgment.js）与归档层（store.js），页面由 page.js 承载。
// 判定层抛 Reject 时不写库，保证「整单拒绝且不落库」；所有变更先判定后落库，刷新后状态一致。
import http from "node:http";
import { loadDb, saveDb, archiveVersion } from "./store.js";
import {
  Reject,
  ORDER_STAGES,
  validateModel,
  validateRegistration,
  applyOperation,
  applyReset,
  applyRecheck,
  applyModification,
  applyDelivery,
  isOpen,
  canDeliver,
  dismantlerOf,
  requiredSupports,
} from "./judgment.js";
import { page } from "./page.js";

const port = Number(process.env.PORT || 3038);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
const findOrder = (db, id) => db.orders.find((o) => o.id === id);

// 页面所需的展示视图：在归档数据上附带判定结果（开放标记、交付资格、拆装人等）
function present(db) {
  return {
    stages: ORDER_STAGES,
    models: db.models.map((m) => ({
      ...m,
      requiredSupports: requiredSupports(m),
      openOrderId: (db.orders.find((o) => o.modelId === m.id && isOpen(o)) || {}).id || null,
    })),
    orders: db.orders.map((o) => ({
      ...o,
      model: db.models.find((m) => m.id === o.modelId) || null,
      open: isOpen(o),
      canDeliver: canDeliver(o),
      dismantler: dismantlerOf(o),
    })),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, present(await loadDb()));

    if (req.method === "POST" && url.pathname === "/api/models") {
      const db = await loadDb();
      const fields = validateModel(db, await body(req));
      const model = { id: "MDL-" + Date.now(), ...fields, logs: [{ at: new Date().toISOString(), step: "建档", note: "模型入库登记" }] };
      db.models.unshift(model);
      await saveDb(db);
      return send(res, 201, model);
    }

    if (req.method === "POST" && url.pathname === "/api/orders") {
      const db = await loadDb();
      // 判定不过会抛 Reject，此处直接返回，整单不落库
      const reg = validateRegistration(db, await body(req));
      const order = {
        id: "TO-" + Date.now(),
        modelId: reg.model.id,
        version: 1,
        status: "开放",
        createdAt: new Date().toISOString(),
        registration: { supports: reg.supports, locks: reg.locks, responsible: reg.responsible },
        originalSpec: { ...reg.model.spec },
        operations: [],
        reset: null,
        rechecks: [],
        lastCompare: null,
        delivery: null,
        versions: [],
        logs: [{ at: new Date().toISOString(), step: "开单", note: `登记支撑位 ${reg.supports.length} 个、锁具 ${reg.locks.length} 把，责任人 ${reg.responsible}` }],
      };
      db.orders.unshift(order);
      await saveDb(db);
      return send(res, 201, order);
    }

    const act = url.pathname.match(/^\/api\/orders\/([^/]+)\/(operations|reset|recheck|deliver)$/);
    if (act && req.method === "POST") {
      const db = await loadDb();
      const order = findOrder(db, act[1]);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const input = await body(req);
      if (act[2] === "operations") applyOperation(order, input);
      if (act[2] === "reset") applyReset(order, input);
      if (act[2] === "recheck") applyRecheck(order, input);
      if (act[2] === "deliver") applyDelivery(order, input);
      await saveDb(db);
      return send(res, 200, order);
    }

    const patch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const db = await loadDb();
      const order = findOrder(db, patch[1]);
      if (!order) return send(res, 404, { error: "order_not_found" });
      applyModification(db, order, await body(req), archiveVersion);
      await saveDb(db);
      return send(res, 200, order);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof Reject) return send(res, error.status, { error: "rejected", details: error.errors });
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型吊装转运与复位放行台 listening on http://localhost:" + port));
