// 页面层：单页界面，只负责展示与采集输入，全部判定走服务端接口。
import { ORDER_STAGES, SPEC_FIELDS, OPERATION_TYPES } from "./judgment.js";

export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型吊装转运与复位放行台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --info:#3f6a8a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; }
    main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:64px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:center; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .cardhead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; } .cardhead h3 { flex:1; }
    .meta { color:var(--muted); font-size:13px; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.st-开放 { background:#eef4e9; } .pill.st-待复校 { background:#f7ead9; border-color:#e0c9a6; }
    .pill.st-已复位 { background:#e4eef7; border-color:#b6cfe4; } .pill.st-已交付 { background:#e8e8e8; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; }
    .record { border-top:1px dashed var(--line); padding-top:6px; display:grid; gap:3px; }
    details.inline { border:1px dashed var(--line); border-radius:6px; padding:8px; }
    details.inline summary, details.versions summary { cursor:pointer; color:var(--accent); font-weight:700; font-size:13px; }
    details.versions { border-top:1px dashed var(--line); padding-top:6px; }
    .modelrow { border-top:1px dashed var(--line); padding:6px 0; }
    .hint { font-size:12px; color:var(--muted); margin-top:8px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型吊装转运与复位放行台</h1><div class="meta">转运开单 · 封帆/拆桅登记 · 复位校验 · 复校放行（归档 / 判定 / 页面分层承载）</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="modelForm"><h2>新增模型档案</h2><div id="modelFields"></div><button>保存模型</button></form>
      <form id="orderForm" style="margin-top:14px"><h2>开具转运单</h2>
        <label>模型</label><select name="modelId" id="modelSelect"></select>
        <div class="hint" id="modelHint"></div>
        <label>支撑位（逗号或换行分隔）</label><textarea name="supports" placeholder="前桅左A，前桅右A，…"></textarea>
        <label>锁具号（逗号分隔）</label><input name="locks" placeholder="LK-03，LK-04">
        <label>责任人</label><input name="responsible">
        <button>登记并开单</button>
        <div class="hint">封帆/拆桅前须完成登记；支撑不足或锁具被他单占用将整单拒绝，不落库。</div>
      </form>
      <div class="panel" style="margin-top:14px"><h2>模型档案</h2><div id="models"></div></div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option></select><input id="search" placeholder="搜索单号、锁具、责任人"></div>
      <div class="grid" id="cards"></div>
    </section>
  </main>
  <script>
    const STAGES = ${JSON.stringify(ORDER_STAGES)};
    const SPEC_FIELDS = ${JSON.stringify(SPEC_FIELDS)};
    const OP_TYPES = ${JSON.stringify(OPERATION_TYPES)};
    const MODEL_FIELDS = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["owner","负责人","text"],["ropeDiameter","原索径","text"],["tension","原张力","text"]];
    let state = { models: [], orders: [] };
    const $ = s => document.querySelector(s);
    function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }
    function fmtAt(s) { try { return new Date(s).toLocaleString('zh-CN', { hour12:false }); } catch { return s || ''; } }
    async function api(path, options) {
      const opts = options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options;
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error((data.details && data.details.join('\\n')) || data.error || '请求失败');
      return data;
    }
    async function run(fn) { try { await fn(); await load(); } catch (err) { alert(err.message); } }

    function renderModelForm() {
      $('#modelFields').innerHTML = MODEL_FIELDS.map(([k,l,t]) => '<label>'+l+'</label><input name="'+k+'" type="'+t+'">').join('') +
        '<label>原绕向</label><select name="winding"><option>右旋</option><option>左旋</option></select>';
      $('#statusFilter').innerHTML = '<option value="">全部状态</option>' + STAGES.map(s => '<option>'+s+'</option>').join('');
    }
    function renderStats() {
      $('#stats').innerHTML = STAGES.map(s => '<div class="stat"><span>'+s+'</span><strong>'+state.orders.filter(o => o.status === s).length+'</strong></div>').join('');
    }
    function renderModelOptions() {
      $('#modelSelect').innerHTML = state.models.map(m =>
        '<option value="'+esc(m.id)+'"'+(m.openOrderId ? ' disabled' : '')+'>'+esc(m.code)+' · '+esc(m.shipType)+'（需 '+m.requiredSupports+' 支撑位）'+(m.openOrderId ? ' · 已有开放单' : '')+'</option>').join('');
      renderModelHint();
    }
    function renderModelHint() {
      const m = state.models.find(x => x.id === $('#modelSelect').value);
      $('#modelHint').textContent = m ? '原索径 '+m.spec.ropeDiameter+' · 绕向 '+m.spec.winding+' · 张力 '+m.spec.tension+'；'+m.mastCount+' 桅至少 '+m.requiredSupports+' 个支撑位' : '';
    }
    function renderModels() {
      $('#models').innerHTML = state.models.map(m =>
        '<div class="modelrow"><b>'+esc(m.code)+'</b> '+esc(m.shipType)+' '+esc(m.scale)+' · '+m.mastCount+' 桅 · 负责人 '+esc(m.owner)+
        '<div class="meta">原索径 '+esc(m.spec.ropeDiameter)+' · 绕向 '+esc(m.spec.winding)+' · 张力 '+esc(m.spec.tension)+'</div>'+
        '<div class="meta">'+(m.openOrderId ? '开放单：'+esc(m.openOrderId) : '暂无开放转运单')+'</div></div>').join('') || '<div class="meta">暂无模型</div>';
    }
    function specText(v) { return '索径 '+esc(v.ropeDiameter)+' · 绕向 '+esc(v.winding)+' · 张力 '+esc(v.tension); }
    function recordHtml(tag, r) {
      let h = '<div class="record"><div><b>'+tag+'</b> <span class="'+(r.result === '通过' ? 'ok' : 'warn')+'">'+r.result+'</span> · '+esc(r.by)+' · '+fmtAt(r.at)+'</div>';
      h += '<div class="meta">'+specText(r.values)+'</div>';
      if (r.previous) h += '<div class="meta">比对前值：'+specText(r.previous)+'</div>';
      if (r.mismatches.length) h += '<div class="warn">不符项：'+r.mismatches.map(x => x.label+'（应 '+esc(x.expect)+'，实 '+esc(x.actual)+'）').join('；')+'</div>';
      return h + '</div>';
    }
    function specFormHtml(o, act, title, byLabel, prefill) {
      const p = prefill || {};
      return '<details class="inline"><summary>'+title+'</summary>' +
        '<label>索径</label><input data-f="ropeDiameter" value="'+esc(p.ropeDiameter || '')+'">' +
        '<label>绕向</label><select data-f="winding"><option'+(p.winding === '右旋' ? ' selected' : '')+'>右旋</option><option'+(p.winding === '左旋' ? ' selected' : '')+'>左旋</option></select>' +
        '<label>张力</label><input data-f="tension" value="'+esc(p.tension || '')+'">' +
        '<label>'+byLabel+'</label><input data-f="by">' +
        '<button data-act="'+act+'" data-id="'+esc(o.id)+'">'+title+'</button></details>';
    }
    function modifyFormHtml(o) {
      return '<details class="inline"><summary>修改转运单（作废复位与交付资格，旧版归档）</summary>' +
        '<label>支撑位</label><textarea data-f="supports">'+esc(o.registration.supports.join('\\n'))+'</textarea>' +
        '<label>锁具号</label><input data-f="locks" value="'+esc(o.registration.locks.join('，'))+'">' +
        '<label>责任人</label><input data-f="responsible" value="'+esc(o.registration.responsible)+'">' +
        '<label>修改说明</label><input data-f="note" placeholder="改单原因">' +
        '<button data-act="modify" data-id="'+esc(o.id)+'">提交改单</button></details>';
    }
    function versionsHtml(o) {
      if (!o.versions.length) return '';
      let h = '<details class="versions"><summary>历史版本（'+o.versions.length+'）</summary>';
      for (const v of [...o.versions].reverse()) {
        const s = v.snapshot;
        h += '<div class="record"><div><b>v'+v.version+'</b> · '+fmtAt(v.archivedAt)+' · '+esc(v.reason)+(v.by ? ' · '+esc(v.by) : '')+'</div>' +
          '<div class="meta">归档时状态 '+esc(s.status)+' · 锁具 '+s.registration.locks.map(esc).join('、')+' · 支撑位 '+s.registration.supports.length+' 个 · 责任人 '+esc(s.registration.responsible)+
          (s.reset ? ' · 复位'+s.reset.result+'（'+esc(s.reset.by)+'）' : '')+(s.rechecks && s.rechecks.length ? ' · 复校 '+s.rechecks.length+' 次' : '')+'</div></div>';
      }
      return h + '</details>';
    }
    function cardHtml(o) {
      const m = o.model || {};
      let h = '<article class="card"><div class="cardhead"><h3>'+esc(o.id)+'</h3><span class="pill st-'+o.status+'">'+o.status+'</span><span class="pill">v'+o.version+'</span></div>';
      h += '<div><b>'+esc(m.code || o.modelId)+'</b> '+esc(m.shipType || '')+' '+esc(m.scale || '')+'</div>';
      h += '<div class="meta">责任人 '+esc(o.registration.responsible)+' · 拆装人 '+esc(o.dismantler)+' · 开单 '+fmtAt(o.createdAt)+'</div>';
      h += '<div class="meta">锁具 '+o.registration.locks.map(esc).join('、')+'</div>';
      h += '<div class="meta">支撑位 '+o.registration.supports.length+' 个：'+o.registration.supports.map(esc).join('、')+'</div>';
      h += '<div class="meta">原值：'+specText(o.originalSpec)+'</div>';
      if ((o.operations || []).length) h += '<div class="meta">拆装：'+o.operations.map(op => esc(op.type)+'·'+esc(op.by)).join('，')+'</div>';
      if (o.reset) h += recordHtml('复位', o.reset);
      for (const r of (o.rechecks || [])) h += recordHtml('复校', r);
      if (o.open) {
        h += '<div class="toolbar">' +
          OP_TYPES.map(t => '<button class="secondary" data-act="op" data-type="'+t+'" data-by="'+esc(o.registration.responsible)+'" data-id="'+esc(o.id)+'">'+t+'</button>').join('') +
          (o.canDeliver ? '<button data-act="deliver" data-id="'+esc(o.id)+'">交付放行</button>' : '') + '</div>';
        if (o.status === '开放') h += specFormHtml(o, 'reset', '提交复位', '复位人');
        if (o.status === '待复校') h += specFormHtml(o, 'recheck', '提交复校（复校人须与拆装人不同）', '复校人', o.lastCompare ? o.lastCompare.values : null);
        h += modifyFormHtml(o);
      } else {
        h += '<div class="meta">已交付 · 交付人 '+esc(o.delivery && o.delivery.by)+' · '+fmtAt(o.delivery && o.delivery.at)+'</div>';
      }
      h += versionsHtml(o);
      h += '<div class="logs meta">'+(o.logs || []).slice(-5).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('')+'</div>';
      return h + '</article>';
    }
    function renderCards() {
      const status = $('#statusFilter').value;
      const q = $('#search').value.trim();
      const visible = state.orders.filter(o => (!status || o.status === status) && (!q || JSON.stringify(o).includes(q)));
      $('#cards').innerHTML = visible.map(cardHtml).join('') || '<div class="panel meta">暂无转运单</div>';
    }
    function render() { renderStats(); renderModelOptions(); renderModels(); renderCards(); }
    async function load() { state = await api('/api/state'); render(); }

    $('#modelForm').onsubmit = e => { e.preventDefault(); run(async () => {
      await api('/api/models', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
      e.target.reset();
    }); };
    $('#orderForm').onsubmit = e => { e.preventDefault(); run(async () => {
      const fd = new FormData(e.target);
      await api('/api/orders', { method:'POST', body: JSON.stringify({ modelId: fd.get('modelId'), supports: fd.get('supports'), locks: fd.get('locks'), responsible: fd.get('responsible') }) });
      e.target.reset();
    }); };
    $('#cards').onclick = e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.dataset.id, act = btn.dataset.act;
      run(async () => {
        if (act === 'op') {
          const by = prompt(btn.dataset.type + ' 操作人', btn.dataset.by);
          if (by === null) return;
          await api('/api/orders/'+id+'/operations', { method:'POST', body: JSON.stringify({ type: btn.dataset.type, by }) });
        } else if (act === 'deliver') {
          const by = prompt('交付人');
          if (!by) return;
          await api('/api/orders/'+id+'/deliver', { method:'POST', body: JSON.stringify({ by }) });
        } else if (act === 'reset' || act === 'recheck') {
          const box = btn.closest('details');
          const val = k => box.querySelector('[data-f="'+k+'"]').value;
          await api('/api/orders/'+id+'/'+act, { method:'POST', body: JSON.stringify({ ropeDiameter: val('ropeDiameter'), winding: val('winding'), tension: val('tension'), by: val('by') }) });
        } else if (act === 'modify') {
          const box = btn.closest('details');
          const val = k => box.querySelector('[data-f="'+k+'"]').value;
          await api('/api/orders/'+id, { method:'PATCH', body: JSON.stringify({ supports: val('supports'), locks: val('locks'), responsible: val('responsible'), note: val('note') }) });
        }
      });
    };
    $('#statusFilter').onchange = renderCards;
    $('#search').oninput = renderCards;
    $('#modelSelect').onchange = renderModelHint;
    $('#reload').onclick = load;
    renderModelForm(); load();
  </script>
</body>
</html>`;
}
