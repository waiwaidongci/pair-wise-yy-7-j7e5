import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
const activePath = join(dataDir, "transfer-active.json");
const decisionsPath = join(dataDir, "transfer-decisions.json");
const archivePath = join(dataDir, "transfer-archive.json");
const port = Number(process.env.PORT || 3038);

const itemStages = ["待转运", "转运中", "待复校", "已复位", "已放行", "已交付"];
const closedStatuses = new Set(["已交付", "已作废"]);
const phases = ["封帆", "拆桅"];
const MIN_SUPPORTS = 2;
const baselineKeys = ["ropeDiameter", "windDirection", "tension"];
const baselineLabels = { ropeDiameter: "原索径", windDirection: "原绕向", tension: "原张力" };

const seedActive = {
  items: [
    {
      id: "MR-001", code: "MR-001", shipType: "福船", scale: "1:48", mastCount: 3,
      riggingMaterial: "蜡线", owner: "周宁", dueDate: "2026-06-28", status: "待转运",
      logs: [{ at: "2026-06-12T00:00:00.000Z", step: "建档", note: "创建模型" }]
    }
  ],
  orders: []
};

async function loadJson(path, seed) {
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(path, "utf8"));
}
const loadDb = () => loadJson(activePath, seedActive);
const saveDb = db => writeFile(activePath, JSON.stringify(db, null, 2));
async function recordDecision(entry) {
  const store = await loadJson(decisionsPath, { decisions: [] });
  store.decisions.unshift({ at: new Date().toISOString(), ...entry });
  await writeFile(decisionsPath, JSON.stringify(store, null, 2));
}
async function archiveOrder(order) {
  const store = await loadJson(archivePath, { orders: [] });
  store.orders.unshift({ ...order, archivedAt: new Date().toISOString() });
  await writeFile(archivePath, JSON.stringify(store, null, 2));
}

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

function toList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，、\n]+/).map(v => v.trim()).filter(Boolean);
  return [];
}
function activeOrders(db, exceptId) {
  return db.orders.filter(o => !closedStatuses.has(o.status) && o.id !== exceptId);
}
function parseRegistration(input) {
  return {
    phase: String(input.phase || "").trim(),
    supports: toList(input.supports),
    locks: toList(input.locks),
    responsible: String(input.responsible || "").trim(),
    baseline: {
      ropeDiameter: String(input.ropeDiameter || "").trim(),
      windDirection: String(input.windDirection || "").trim(),
      tension: String(input.tension || "").trim()
    }
  };
}
function lockConflicts(db, order, locks) {
  const busy = new Map();
  for (const other of activeOrders(db, order.id)) {
    for (const lock of other.locks || []) busy.set(lock, other.id);
  }
  return locks.filter(l => busy.has(l)).map(l => l + "（被单 " + busy.get(l) + " 占用）");
}
function validateRegistration(db, order, reg) {
  const errors = [];
  if (!phases.includes(reg.phase)) errors.push("阶段须为封帆或拆桅");
  if (reg.supports.length < MIN_SUPPORTS) errors.push("支撑不足：至少登记 " + MIN_SUPPORTS + " 个支撑位");
  if (!reg.locks.length) errors.push("至少登记 1 把锁具");
  if (!reg.responsible) errors.push("缺少责任人");
  for (const key of baselineKeys) if (!reg.baseline[key]) errors.push("缺少" + baselineLabels[key]);
  const conflicts = lockConflicts(db, order, reg.locks);
  if (conflicts.length) errors.push("锁具被他单占用：" + conflicts.join("、"));
  return errors;
}
function compareBaseline(baseline, values) {
  return baselineKeys.map(key => ({
    key,
    label: baselineLabels[key],
    expect: baseline?.[key] ?? "",
    actual: values?.[key] ?? "",
    match: String(baseline?.[key] ?? "").trim() === String(values?.[key] ?? "").trim()
  }));
}
function syncItemStatus(item, order) {
  if (!item || !order) return;
  const map = { "开放": "转运中", "已登记": "转运中", "待复校": "待复校", "已复位": "已复位", "已放行": "已放行" };
  if (map[order.status]) item.status = map[order.status];
}
function findOrder(db, id) {
  return db.orders.find(o => o.id === id);
}
function computeStats(items) {
  const stats = Object.fromEntries(itemStages.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}

const css = `
  :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
  header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h4 { margin:10px 0 4px; }
  main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
  form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
  label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:8px; }
  button.secondary { background:#69736a; }
  nav a { color:var(--accent); font-weight:700; text-decoration:none; margin-right:14px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
  .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
  .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
  .warn { color:var(--warn); font-weight:700; }
  .order { border-top:1px dashed var(--line); padding-top:8px; display:grid; gap:6px; }
  .inline { border:1px dashed var(--line); border-radius:6px; padding:10px; background:#fafbf9; }
  details { border-top:1px solid var(--line); padding-top:6px; } summary { cursor:pointer; color:var(--muted); font-size:13px; }
  table { width:100%; border-collapse:collapse; background:#fff; } th,td { border:1px solid var(--line); padding:8px; text-align:left; font-size:14px; vertical-align:top; }
  th { background:#eef2ea; }
  .ver { border-top:1px dotted var(--line); padding:6px 0; }
  @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
`;
function layout(title, subtitle, bodyHtml, script) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <div><h1>${title}</h1><div class="meta">${subtitle}</div></div>
    <nav><a href="/">转运台</a><a href="/decisions">判定记录</a><a href="/archive">归档</a></nav>
  </header>
  ${bodyHtml}
  <script>${script}<\/script>
</body>
</html>`;
}

const clientCommon = `
  async function api(path, options) {
    const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
    const data = await res.json();
    if (!res.ok) throw new Error((data.error || '请求失败') + (data.details ? '：' + data.details.join('；') : ''));
    return data;
  }
  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
  function fmt(iso) { return iso ? new Date(iso).toLocaleString() : '-'; }
`;

function mainPage() {
  const bodyHtml = `
  <main>
    <section>
      <form id="createForm" data-act="create-item"><h2>新增模型</h2><div id="fields"></div><button>保存模型</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option></select><input id="search" placeholder="搜索编号或关键词"><button class="secondary" id="reload" type="button">刷新</button></div>
      <div class="panel"><h2>转运台</h2><div class="meta" style="margin-bottom:10px">一个模型仅允许一张开放转运单；封帆/拆桅前须登记支撑位、锁具号与责任人；复位按原索径、绕向、张力校验。</div><div class="grid" id="cards"></div></div>
    </section>
  </main>`;
  const script = `
    const itemFields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const itemStages = ${JSON.stringify(itemStages)};
    let items = [], orders = [];
    ${clientCommon}
    document.querySelector('#fields').innerHTML = itemFields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
    document.querySelector('#statusFilter').innerHTML = '<option value="">全部状态</option>' + itemStages.map(s => '<option>'+s+'</option>').join('');
    function baselineText(b) { return b ? '索径 '+b.ropeDiameter+' · 绕向 '+b.windDirection+' · 张力 '+b.tension : '-'; }
    function registerForm(o) {
      return '<form data-act="register" data-order="'+o.id+'" class="inline"><h4>封帆/拆桅前登记</h4>'
        + '<label>阶段</label><select name="phase"><option>封帆</option><option>拆桅</option></select>'
        + '<label>支撑位（逗号分隔，至少2个）</label><input name="supports" required>'
        + '<label>锁具号（逗号分隔）</label><input name="locks" required>'
        + '<label>责任人（拆装人）</label><input name="responsible" required>'
        + '<label>原索径</label><input name="ropeDiameter" required>'
        + '<label>原绕向</label><input name="windDirection" required>'
        + '<label>原张力</label><input name="tension" required>'
        + '<button>登记</button></form>';
    }
    function resetForm(o) {
      return '<form data-act="reset" data-order="'+o.id+'" class="inline"><h4>复位校验（对照原索径/绕向/张力）</h4>'
        + '<label>索径</label><input name="ropeDiameter" required>'
        + '<label>绕向</label><input name="windDirection" required>'
        + '<label>张力</label><input name="tension" required>'
        + '<label>复位人</label><input name="by" required>'
        + '<button>提交复位校验</button></form>';
    }
    function recheckForm(o) {
      return '<form data-act="recheck" data-order="'+o.id+'" class="inline"><h4>复校（复校人须与拆装人不同，自动留存比对前值）</h4>'
        + '<label>索径</label><input name="ropeDiameter" required>'
        + '<label>绕向</label><input name="windDirection" required>'
        + '<label>张力</label><input name="tension" required>'
        + '<label>复校人</label><input name="by" required>'
        + '<button>提交复校</button></form>';
    }
    function editDetails(o) {
      const b = o.baseline || {};
      return '<details><summary>改转运单（提交即作废复位与交付资格，旧版留档）</summary>'
        + '<form data-act="edit" data-order="'+o.id+'" class="inline">'
        + '<label>阶段</label><select name="phase"><option'+(o.phase==='封帆'?' selected':'')+'>封帆</option><option'+(o.phase==='拆桅'?' selected':'')+'>拆桅</option></select>'
        + '<label>支撑位</label><input name="supports" value="'+esc((o.supports||[]).join(','))+'">'
        + '<label>锁具号</label><input name="locks" value="'+esc((o.locks||[]).join(','))+'">'
        + '<label>责任人</label><input name="responsible" value="'+esc(o.responsible||'')+'">'
        + '<label>原索径</label><input name="ropeDiameter" value="'+esc(b.ropeDiameter||'')+'">'
        + '<label>原绕向</label><input name="windDirection" value="'+esc(b.windDirection||'')+'">'
        + '<label>原张力</label><input name="tension" value="'+esc(b.tension||'')+'">'
        + '<label>改单人</label><input name="by" required>'
        + '<label>改动原因</label><input name="reason" required>'
        + '<button>提交改动</button></form></details>';
    }
    function historyHtml(o) {
      const hist = o.history || [];
      const rows = hist.slice().reverse().map(v =>
        '<div class="ver"><b>v'+v.version+'</b> <span class="meta">'+fmt(v.at)+' · 改单人 '+(v.by||'-')+' · '+(v.reason||'')+'</span>'
        + '<div class="meta">状态 '+v.snapshot.status+' · 支撑 '+(v.snapshot.supports||[]).join('、')+' · 锁具 '+(v.snapshot.locks||[]).join('、')+' · 责任人 '+(v.snapshot.responsible||'-')+'</div>'
        + '<div class="meta">基准：'+baselineText(v.snapshot.baseline)+'</div></div>').join('');
      return '<details><summary>历史版本（'+hist.length+'）</summary>'+(rows || '<div class="meta">无旧版本</div>')+'</details>';
    }
    function orderHtml(o) {
      let h = '<div class="order"><div><b>转运单 '+o.id+'</b> <span class="pill">'+o.status+'</span> <span class="meta">v'+o.version+(o.phase ? ' · '+o.phase : '')+'</span></div>';
      if (o.registeredAt) {
        h += '<div class="meta">支撑位：'+o.supports.join('、')+'</div>';
        h += '<div class="meta">锁具：'+o.locks.join('、')+' · 责任人：'+esc(o.responsible)+'</div>';
        h += '<div class="meta">基准：'+baselineText(o.baseline)+'</div>';
      }
      if (o.reset) {
        h += '<div class="meta">复位记录（'+esc(o.reset.by)+'）：'+o.reset.checks.map(c => c.label+(c.match?' ✓':' ✗')).join('，')+'</div>';
      }
      if (o.rechecks && o.rechecks.length) {
        const last = o.rechecks[o.rechecks.length-1];
        h += '<div class="meta">复校 '+o.rechecks.length+' 次，最近由 '+esc(last.by)+' 比对前值（'+baselineText(last.prevValues)+'）</div>';
      }
      if (o.status === '待复校') h += '<div class="warn">复位不符，仅可复校，不得放行</div>';
      if (o.status === '开放') h += registerForm(o);
      if (o.status === '已登记') h += resetForm(o);
      if (o.status === '待复校') h += recheckForm(o);
      if (o.status === '已复位') h += '<button data-act="release" data-order="'+o.id+'">放行</button>';
      if (o.status === '已放行') h += '<button data-act="deliver" data-order="'+o.id+'">交付并归档</button>';
      h += editDetails(o);
      h += '<button class="secondary" data-act="void" data-order="'+o.id+'">作废转运单</button>';
      h += historyHtml(o);
      return h + '</div>';
    }
    function cardHtml(item) {
      const order = orders.find(o => o.itemId === item.id);
      const main = itemFields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      let h = '<article class="card"><h3>'+esc(item.code)+' · '+esc(item.shipType)+'</h3><span class="pill">'+item.status+'</span>'+main;
      h += '<div class="meta">帆索 '+esc(item.riggingMaterial)+' · 负责人 '+esc(item.owner)+' · 交付 '+esc(item.dueDate)+'</div>';
      h += order ? orderHtml(order) : '<button data-act="create-order" data-item="'+item.id+'">开转运单</button>';
      return h + '</article>';
    }
    function render() {
      const stats = Object.fromEntries(itemStages.map(s => [s, items.filter(i => i.status === s).length]));
      document.querySelector('#stats').innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      document.querySelector('#cards').innerHTML = visible.map(cardHtml).join('') || '<div class="meta">暂无模型</div>';
    }
    async function load() {
      [items, orders] = await Promise.all([api('/api/items'), api('/api/orders')]);
      render();
    }
    document.addEventListener('submit', async event => {
      const form = event.target;
      if (!form.dataset.act) return;
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        if (form.dataset.act === 'create-item') { await api('/api/items', { method:'POST', body: JSON.stringify(data) }); form.reset(); }
        if (form.dataset.act === 'register') await api('/api/orders/'+form.dataset.order+'/register', { method:'POST', body: JSON.stringify(data) });
        if (form.dataset.act === 'reset') await api('/api/orders/'+form.dataset.order+'/reset', { method:'POST', body: JSON.stringify(data) });
        if (form.dataset.act === 'recheck') await api('/api/orders/'+form.dataset.order+'/recheck', { method:'POST', body: JSON.stringify(data) });
        if (form.dataset.act === 'edit') await api('/api/orders/'+form.dataset.order, { method:'PATCH', body: JSON.stringify(data) });
        await load();
      } catch (error) { alert(error.message); }
    });
    document.addEventListener('click', async event => {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      try {
        if (btn.dataset.act === 'create-order') await api('/api/items/'+btn.dataset.item+'/orders', { method:'POST' });
        if (btn.dataset.act === 'release') { const by = prompt('放行操作人'); if (!by) return; await api('/api/orders/'+btn.dataset.order+'/release', { method:'POST', body: JSON.stringify({ by }) }); }
        if (btn.dataset.act === 'deliver') { const by = prompt('交付操作人'); if (!by) return; await api('/api/orders/'+btn.dataset.order+'/deliver', { method:'POST', body: JSON.stringify({ by }) }); }
        if (btn.dataset.act === 'void') { const reason = prompt('作废原因'); if (reason === null) return; const by = prompt('操作人') || ''; await api('/api/orders/'+btn.dataset.order+'/void', { method:'POST', body: JSON.stringify({ by, reason }) }); }
        await load();
      } catch (error) { alert(error.message); }
    });
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    load();
  `;
  return layout("古船模型吊装转运与复位放行台", "开单、登记、复位、放行、交付一单一档", bodyHtml, script);
}

function decisionsPage() {
  const bodyHtml = `
  <main style="grid-template-columns:1fr">
    <section class="panel"><h2>判定记录</h2><div class="meta" style="margin-bottom:10px">登记、复位、复校、改单、放行、交付、作废的判定留痕，与在途单、归档分开保存。</div>
      <table><thead><tr><th>时间</th><th>转运单</th><th>模型</th><th>判定</th><th>结果</th><th>操作人</th><th>详情</th></tr></thead><tbody id="rows"></tbody></table>
    </section>
  </main>`;
  const script = `
    ${clientCommon}
    async function load() {
      const decisions = await api('/api/decisions');
      document.querySelector('#rows').innerHTML = decisions.map(d =>
        '<tr><td>'+fmt(d.at)+'</td><td>'+esc(d.orderId||'')+'</td><td>'+esc(d.itemCode||'')+'</td><td>'+esc(d.kind)+'</td><td>'+esc(d.result)+'</td><td>'+esc(d.by||'')+'</td><td>'+esc(d.detail||'')+'</td></tr>'
      ).join('') || '<tr><td colspan="7" class="meta">暂无判定</td></tr>';
    }
    load();
  `;
  return layout("判定记录", "复位与放行的判定留痕", bodyHtml, script);
}

function archivePage() {
  const bodyHtml = `
  <main style="grid-template-columns:1fr">
    <section class="panel"><h2>归档转运单</h2><div class="meta" style="margin-bottom:10px">已交付或已作废的转运单连同历史版本一并归档，只读可查。</div>
      <div class="grid" id="cards"></div>
    </section>
  </main>`;
  const script = `
    ${clientCommon}
    function baselineText(b) { return b ? '索径 '+b.ropeDiameter+' · 绕向 '+b.windDirection+' · 张力 '+b.tension : '-'; }
    async function load() {
      const orders = await api('/api/archive');
      document.querySelector('#cards').innerHTML = orders.map(o =>
        '<article class="card"><h3>'+esc(o.id)+' · '+esc(o.itemCode)+'</h3><span class="pill">'+o.status+'</span>'
        + '<div class="meta">归档时间 '+fmt(o.archivedAt)+' · 版本 v'+o.version+'（历史 '+(o.history||[]).length+' 版）</div>'
        + '<div class="meta">支撑位：'+(o.supports||[]).join('、')+' · 锁具：'+(o.locks||[]).join('、')+' · 责任人：'+esc(o.responsible||'-')+'</div>'
        + '<div class="meta">基准：'+baselineText(o.baseline)+'</div>'
        + '<details><summary>完整档案</summary><pre class="meta" style="white-space:pre-wrap">'+esc(JSON.stringify(o, null, 2))+'</pre></details>'
        + '</article>'
      ).join('') || '<div class="meta">暂无归档</div>';
    }
    load();
  `;
  return layout("归档转运单", "已交付与已作废转运单的只读档案", bodyHtml, script);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, mainPage());
    if (req.method === "GET" && url.pathname === "/decisions") return html(res, decisionsPage());
    if (req.method === "GET" && url.pathname === "/archive") return html(res, archivePage());

    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items);
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: "MR-" + Date.now(), ...input, status: "待转运", logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }

    if (req.method === "GET" && url.pathname === "/api/orders") return send(res, 200, db.orders);
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    if (req.method === "GET" && url.pathname === "/api/decisions") {
      const store = await loadJson(decisionsPath, { decisions: [] });
      return send(res, 200, store.decisions);
    }
    if (req.method === "GET" && url.pathname === "/api/archive") {
      const store = await loadJson(archivePath, { orders: [] });
      return send(res, 200, store.orders);
    }

    const createOrder = url.pathname.match(/^\/api\/items\/([^/]+)\/orders$/);
    if (createOrder && req.method === "POST") {
      const item = db.items.find(x => x.id === createOrder[1] || x.code === createOrder[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const existing = db.orders.find(o => o.itemId === item.id && !closedStatuses.has(o.status));
      if (existing) return send(res, 409, { error: "一个模型只能有一张开放转运单", details: ["现有转运单 " + existing.id + "（" + existing.status + "）"] });
      const order = {
        id: "TO-" + Date.now(), itemId: item.id, itemCode: item.code, version: 1, status: "开放",
        phase: null, supports: [], locks: [], responsible: null, baseline: null,
        registeredAt: null, reset: null, rechecks: [], resetValid: false, deliveryQualified: false,
        history: [], createdAt: new Date().toISOString()
      };
      db.orders.unshift(order);
      syncItemStatus(item, order);
      await saveDb(db);
      await recordDecision({ kind: "开单", result: "通过", orderId: order.id, itemCode: item.code, detail: "开立转运单" });
      return send(res, 201, order);
    }

    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)(?:\/(register|reset|recheck|release|deliver|void))?$/);
    if (orderMatch) {
      const order = findOrder(db, orderMatch[1]);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const item = db.items.find(x => x.id === order.itemId);
      const action = orderMatch[2];

      if (req.method === "GET" && !action) return send(res, 200, order);

      if (req.method === "PATCH" && !action) {
        const input = await body(req);
        const merged = parseRegistration({
          phase: input.phase ?? order.phase,
          supports: input.supports ?? order.supports,
          locks: input.locks ?? order.locks,
          responsible: input.responsible ?? order.responsible,
          ropeDiameter: input.ropeDiameter ?? order.baseline?.ropeDiameter,
          windDirection: input.windDirection ?? order.baseline?.windDirection,
          tension: input.tension ?? order.baseline?.tension
        });
        const errors = order.registeredAt
          ? validateRegistration(db, order, merged)
          : lockConflicts(db, order, merged.locks).map(c => "锁具被他单占用：" + c);
        if (errors.length) {
          await recordDecision({ kind: "改单", result: "拒绝", orderId: order.id, itemCode: order.itemCode, by: input.by || "", detail: errors.join("；") });
          return send(res, 422, { error: "整单拒绝，未落库", details: errors });
        }
        const snapshot = JSON.parse(JSON.stringify({ ...order, history: undefined }));
        order.history.push({ version: order.version, at: new Date().toISOString(), by: input.by || "", reason: input.reason || "", snapshot });
        order.version += 1;
        order.phase = merged.phase;
        order.supports = merged.supports;
        order.locks = merged.locks;
        order.responsible = merged.responsible;
        order.baseline = merged.baseline;
        order.reset = null;
        order.rechecks = [];
        order.resetValid = false;
        order.deliveryQualified = false;
        order.status = order.registeredAt ? "已登记" : "开放";
        syncItemStatus(item, order);
        await saveDb(db);
        await recordDecision({ kind: "改单", result: "通过", orderId: order.id, itemCode: order.itemCode, by: input.by || "", detail: "改为 v" + order.version + "，复位与交付资格作废：" + (input.reason || "未填原因") });
        return send(res, 200, order);
      }

      if (req.method !== "POST" || !action) return send(res, 405, { error: "method_not_allowed" });
      const input = await body(req);

      if (action === "register") {
        if (order.status !== "开放") return send(res, 409, { error: "仅开放中的转运单可登记，当前状态：" + order.status });
        const reg = parseRegistration(input);
        const errors = validateRegistration(db, order, reg);
        if (errors.length) {
          await recordDecision({ kind: "登记", result: "拒绝", orderId: order.id, itemCode: order.itemCode, by: reg.responsible || "", detail: errors.join("；") });
          return send(res, 422, { error: "整单拒绝，未落库", details: errors });
        }
        Object.assign(order, { phase: reg.phase, supports: reg.supports, locks: reg.locks, responsible: reg.responsible, baseline: reg.baseline, registeredAt: new Date().toISOString(), status: "已登记" });
        syncItemStatus(item, order);
        await saveDb(db);
        await recordDecision({ kind: "登记", result: "通过", orderId: order.id, itemCode: order.itemCode, by: reg.responsible, detail: reg.phase + " · 支撑 " + reg.supports.length + " 处 · 锁具 " + reg.locks.join("、") });
        return send(res, 200, order);
      }

      if (action === "reset") {
        if (order.status !== "已登记") return send(res, 409, { error: "仅已登记的转运单可复位校验，当前状态：" + order.status });
        const values = { ropeDiameter: String(input.ropeDiameter || "").trim(), windDirection: String(input.windDirection || "").trim(), tension: String(input.tension || "").trim() };
        const checks = compareBaseline(order.baseline, values);
        const match = checks.every(c => c.match);
        order.reset = { by: String(input.by || "").trim(), values, checks, match, at: new Date().toISOString() };
        if (match) {
          order.status = "已复位";
          order.resetValid = true;
          order.deliveryQualified = true;
        } else {
          order.status = "待复校";
        }
        syncItemStatus(item, order);
        await saveDb(db);
        const detail = checks.map(c => c.label + (c.match ? "✓" : "✗（基准 " + c.expect + " ≠ 实测 " + c.actual + "）")).join("，");
        await recordDecision({ kind: "复位", result: match ? "通过" : "不符，转待复校", orderId: order.id, itemCode: order.itemCode, by: order.reset.by, detail });
        return send(res, 200, order);
      }

      if (action === "recheck") {
        if (order.status !== "待复校") return send(res, 409, { error: "仅待复校的转运单可复校，当前状态：" + order.status });
        const by = String(input.by || "").trim();
        if (!by) return send(res, 422, { error: "缺少复校人" });
        if (by === order.responsible) {
          await recordDecision({ kind: "复校", result: "拒绝", orderId: order.id, itemCode: order.itemCode, by, detail: "复校人须与拆装人（" + order.responsible + "）不同" });
          return send(res, 422, { error: "复校人须与拆装人不同", details: ["拆装人为 " + order.responsible] });
        }
        const values = { ropeDiameter: String(input.ropeDiameter || "").trim(), windDirection: String(input.windDirection || "").trim(), tension: String(input.tension || "").trim() };
        const prevValues = order.rechecks.length ? order.rechecks[order.rechecks.length - 1].values : order.reset.values;
        const checks = compareBaseline(order.baseline, values);
        const match = checks.every(c => c.match);
        order.rechecks.push({ by, prevValues, values, checks, match, at: new Date().toISOString() });
        if (match) {
          order.status = "已复位";
          order.resetValid = true;
          order.deliveryQualified = true;
        }
        syncItemStatus(item, order);
        await saveDb(db);
        const detail = "比对前值（索径 " + prevValues.ropeDiameter + " · 绕向 " + prevValues.windDirection + " · 张力 " + prevValues.tension + "），本次" + (match ? "全部相符" : "仍不符");
        await recordDecision({ kind: "复校", result: match ? "通过" : "不符，仍待复校", orderId: order.id, itemCode: order.itemCode, by, detail });
        return send(res, 200, order);
      }

      if (action === "release") {
        if (!(order.status === "已复位" && order.resetValid && order.deliveryQualified)) {
          return send(res, 409, { error: "复位或交付资格不足，禁止放行", details: ["当前状态 " + order.status + "，复位有效 " + order.resetValid + "，交付资格 " + order.deliveryQualified] });
        }
        order.status = "已放行";
        order.releasedBy = String(input.by || "").trim();
        order.releasedAt = new Date().toISOString();
        syncItemStatus(item, order);
        await saveDb(db);
        await recordDecision({ kind: "放行", result: "通过", orderId: order.id, itemCode: order.itemCode, by: order.releasedBy, detail: "复位有效，准予放行" });
        return send(res, 200, order);
      }

      if (action === "deliver") {
        if (order.status !== "已放行") return send(res, 409, { error: "仅已放行的转运单可交付，当前状态：" + order.status });
        order.status = "已交付";
        order.deliveredBy = String(input.by || "").trim();
        order.deliveredAt = new Date().toISOString();
        item.status = "已交付";
        db.orders = db.orders.filter(o => o.id !== order.id);
        await saveDb(db);
        await archiveOrder(order);
        await recordDecision({ kind: "交付", result: "通过", orderId: order.id, itemCode: order.itemCode, by: order.deliveredBy, detail: "交付完成，转运单归档" });
        return send(res, 200, order);
      }

      if (action === "void") {
        order.status = "已作废";
        order.voidedBy = String(input.by || "").trim();
        order.voidReason = String(input.reason || "").trim();
        order.voidedAt = new Date().toISOString();
        item.status = "待转运";
        db.orders = db.orders.filter(o => o.id !== order.id);
        await saveDb(db);
        await archiveOrder(order);
        await recordDecision({ kind: "作废", result: "通过", orderId: order.id, itemCode: order.itemCode, by: order.voidedBy, detail: order.voidReason || "未填原因" });
        return send(res, 200, order);
      }
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型吊装转运与复位放行台 listening on http://localhost:" + port));
