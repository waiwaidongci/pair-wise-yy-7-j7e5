// 判定层：转运开单、封帆/拆桅登记、复位校验、复校、改单与交付的全部业务规则。
// 只提供纯函数与 Reject 错误，不触碰落库与页面；判定不过即抛 Reject，调用方不得落库。

export const ORDER_STAGES = ["开放", "待复校", "已复位", "已交付"];
export const OPEN_STATUSES = ORDER_STAGES.filter((s) => s !== "已交付");
export const SUPPORTS_PER_MAST = 2; // 每桅至少 2 个支撑位
export const SPEC_FIELDS = [
  ["ropeDiameter", "索径"],
  ["winding", "绕向"],
  ["tension", "张力"],
];
export const OPERATION_TYPES = ["封帆", "拆桅"];

export class Reject extends Error {
  constructor(errors) {
    super(errors.join("；"));
    this.name = "Reject";
    this.status = 422;
    this.errors = errors;
  }
}

const norm = (v) => String(v ?? "").trim().toLowerCase();
const now = () => new Date().toISOString();

export function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v ?? "").split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

export const isOpen = (order) => OPEN_STATUSES.includes(order.status);
export const requiredSupports = (model) => Number(model?.mastCount || 0) * SUPPORTS_PER_MAST;
export const canDeliver = (order) => order.status === "已复位";

function pushLog(order, step, note) {
  order.logs ||= [];
  order.logs.push({ at: now(), step, note });
}

// 全部开放单占用的锁具：lock -> orderId
export function locksInUse(db, exceptOrderId = null) {
  const used = new Map();
  for (const order of db.orders) {
    if (order.id === exceptOrderId || !isOpen(order)) continue;
    for (const lock of order.registration.locks) if (!used.has(lock)) used.set(lock, order.id);
  }
  return used;
}

// 开单与改单共用同一套登记判定；不过则整单拒绝
export function validateRegistration(db, input, exceptOrderId = null) {
  const errors = [];
  const model = db.models.find((m) => m.id === input.modelId || m.code === input.modelId);
  const supports = toList(input.supports);
  const locks = toList(input.locks);
  const responsible = String(input.responsible ?? "").trim();
  if (!model) {
    errors.push("模型不存在");
  } else {
    const need = requiredSupports(model);
    if (supports.length < need) {
      errors.push(`支撑位不足：${model.code} 为 ${model.mastCount} 桅，至少需 ${need} 个支撑位，实登 ${supports.length} 个`);
    }
    const conflict = db.orders.find((o) => o.id !== exceptOrderId && o.modelId === model.id && isOpen(o));
    if (conflict) errors.push(`模型 ${model.code} 已有开放转运单 ${conflict.id}，一个模型只能有一张开放转运单`);
  }
  if (!responsible) errors.push("缺少责任人");
  if (!locks.length) errors.push("至少登记一把锁具");
  const dup = [...new Set(locks.filter((l, i) => locks.indexOf(l) !== i))];
  if (dup.length) errors.push("锁具号重复：" + dup.join("、"));
  const used = locksInUse(db, exceptOrderId);
  const busy = locks.filter((l) => used.has(l));
  if (busy.length) errors.push("锁具被他单占用：" + busy.map((l) => `${l}（${used.get(l)}）`).join("、"));
  if (errors.length) throw new Reject(errors);
  return { model, supports, locks, responsible };
}

export function validateModel(db, input) {
  const errors = [];
  const code = String(input.code ?? "").trim();
  if (!code) errors.push("缺少模型编号");
  else if (db.models.some((m) => m.code === code)) errors.push(`模型编号 ${code} 已存在`);
  const mastCount = Number(input.mastCount);
  if (!Number.isInteger(mastCount) || mastCount < 1) errors.push("桅杆数量须为正整数");
  const spec = {};
  for (const [key, label] of SPEC_FIELDS) {
    const v = String(input[key] ?? "").trim();
    if (!v) errors.push(`缺少原${label}`);
    spec[key] = v;
  }
  if (errors.length) throw new Reject(errors);
  return {
    code,
    shipType: String(input.shipType ?? "").trim(),
    scale: String(input.scale ?? "").trim(),
    mastCount,
    owner: String(input.owner ?? "").trim(),
    spec,
  };
}

// 复位/复校按原索径、绕向、张力逐项比对，返回不符项明细
export function compareSpec(original, values) {
  return SPEC_FIELDS.filter(([key]) => norm(original?.[key]) !== norm(values?.[key])).map(([key, label]) => ({
    key,
    label,
    expect: original?.[key] ?? "",
    actual: values?.[key] ?? "",
  }));
}

// 拆装人：最近一次封帆/拆桅的操作人，未操作过则为登记责任人
export function dismantlerOf(order) {
  const ops = (order.operations || []).filter((op) => OPERATION_TYPES.includes(op.type));
  return ops.length ? ops[ops.length - 1].by : order.registration.responsible;
}

function specValues(input) {
  return Object.fromEntries(SPEC_FIELDS.map(([key]) => [key, String(input?.[key] ?? "").trim()]));
}

export function applyOperation(order, input) {
  if (!isOpen(order)) throw new Reject(["转运单已交付，不能再登记拆装操作"]);
  const type = String(input.type ?? "");
  if (!OPERATION_TYPES.includes(type)) throw new Reject(["操作类型须为封帆或拆桅"]);
  const by = String(input.by ?? "").trim() || order.registration.responsible;
  const op = { type, by, at: now() };
  order.operations ||= [];
  order.operations.push(op);
  pushLog(order, type, `操作人 ${by}，支撑位 ${order.registration.supports.length} 个、锁具 ${order.registration.locks.join("、")} 已登记`);
  return op;
}

// 复位：不符不报错，只转待复校
export function applyReset(order, input) {
  if (order.status !== "开放") throw new Reject([`当前状态「${order.status}」不能提交复位，仅开放中的转运单可复位`]);
  const by = String(input.by ?? "").trim();
  if (!by) throw new Reject(["缺少复位人"]);
  const values = specValues(input);
  const mismatches = compareSpec(order.originalSpec, values);
  const record = { at: now(), by, values, previous: null, mismatches, result: mismatches.length ? "不符" : "通过" };
  order.reset = record;
  order.lastCompare = record;
  order.status = mismatches.length ? "待复校" : "已复位";
  pushLog(order, "复位", mismatches.length ? `复位不符（${mismatches.map((m) => m.label).join("、")}），转入待复校` : `复位校验通过，复位人 ${by}`);
  return record;
}

// 复校：复校人须与拆装人不同，并留存比对前值
export function applyRecheck(order, input) {
  if (order.status !== "待复校") throw new Reject([`当前状态「${order.status}」不能复校，仅待复校的转运单可提交`]);
  const by = String(input.by ?? "").trim();
  if (!by) throw new Reject(["缺少复校人"]);
  const dismantler = dismantlerOf(order);
  if (norm(by) === norm(dismantler)) throw new Reject([`复校人须与拆装人不同（拆装人：${dismantler}）`]);
  const values = specValues(input);
  const previous = order.lastCompare ? order.lastCompare.values : null;
  const mismatches = compareSpec(order.originalSpec, values);
  const record = { at: now(), by, values, previous, mismatches, result: mismatches.length ? "不符" : "通过" };
  order.rechecks ||= [];
  order.rechecks.push(record);
  order.lastCompare = record;
  order.status = mismatches.length ? "待复校" : "已复位";
  pushLog(order, "复校", mismatches.length ? `复校仍不符（${mismatches.map((m) => m.label).join("、")}），继续待复校` : `复校通过，复校人 ${by}，具备交付资格`);
  return record;
}

// 改单：先按开单同套规则判定，再归档旧版，最后作废复位与交付资格
export function applyModification(db, order, input, archive) {
  if (!isOpen(order)) throw new Reject(["转运单已交付，不能修改"]);
  const before = order.registration;
  const next = {
    supports: input.supports !== undefined ? toList(input.supports) : [...before.supports],
    locks: input.locks !== undefined ? toList(input.locks) : [...before.locks],
    responsible: input.responsible !== undefined ? String(input.responsible).trim() : before.responsible,
  };
  const changed =
    next.supports.join("|") !== before.supports.join("|") ||
    next.locks.join("|") !== before.locks.join("|") ||
    next.responsible !== before.responsible;
  if (!changed) throw new Reject(["登记内容未变化，无需改单"]);
  validateRegistration(db, { modelId: order.modelId, ...next }, order.id);
  archive(order, input.note || "修改转运单", input.by); // 旧版整体归档，可追溯
  order.registration = next;
  order.version += 1;
  order.status = "开放";
  order.reset = null;
  order.rechecks = [];
  order.lastCompare = null;
  order.delivery = null;
  pushLog(order, "改单", `升级为 v${order.version}，复位与交付资格已作废，旧版已归档`);
}

export function applyDelivery(order, input) {
  if (!canDeliver(order)) throw new Reject([`当前状态「${order.status}」不具备交付资格，须复位校验通过`]);
  const by = String(input.by ?? "").trim();
  if (!by) throw new Reject(["缺少交付人"]);
  order.status = "已交付";
  order.delivery = { at: now(), by };
  pushLog(order, "交付", `交付放行，交付人 ${by}，锁具 ${order.registration.locks.join("、")} 释放`);
}
