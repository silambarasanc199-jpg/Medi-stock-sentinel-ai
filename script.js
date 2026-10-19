// MediStock Sentinel AI - Phase 1 (rule-based, runs fully in the browser)
const KEY = 'medistock_v1';
const NEAR = 60;        // days: near-expiry window (assumption)
const SAFETY_DAYS = 3;  // safety stock = daily usage x 3 days (assumption)
const COVER_DAYS = 30;  // order up to: lead time + 30 days of demand (assumption)
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const midnight = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
const plus = n => { const d = midnight(); d.setDate(d.getDate()+n); return fmt(d); };
const daysTo = e => Math.round((new Date(e + 'T00:00:00') - midnight()) / 864e5);
const money = n => n.toLocaleString(undefined, {style:'currency', currency:'USD'});

function seed() {
  const b = (name, sku, batch, d, qty, usage, reorder, lead, cost) =>
    ({name, sku, batch, expiry: plus(d), qty, usage, reorder, lead, cost, synthetic: true});
  return {
    batches: [
      b('Paracetamol 500mg (synthetic)', 'PARA500', 'P-101', 25, 400, 10, 150, 5, 0.4),
      b('Paracetamol 500mg (synthetic)', 'PARA500', 'P-102', 200, 600, 10, 150, 5, 0.4),
      b('Amoxicillin 250mg (synthetic)', 'AMOX250', 'A-77', 40, 120, 12, 100, 7, 1.2),
      b('Insulin R 10ml (synthetic)', 'INSR10', 'I-09', 150, 30, 6, 40, 10, 8.5),
      b('ORS Sachet (synthetic)', 'ORS01', 'O-5', -5, 80, 2, 20, 4, 0.3),
      b('Cetirizine 10mg (synthetic)', 'CET10', 'C-3', 300, 300, 8, 100, 6, 0.2)
    ], drafts: [], logs: [], reviewer: ''
  };
}
let S = JSON.parse(localStorage.getItem(KEY) || 'null') || seed();
const save = () => localStorage.setItem(KEY, JSON.stringify(S));
const log = m => { S.logs.unshift({t: new Date().toLocaleString(), m}); S.logs = S.logs.slice(0, 200); };

// ---- Risk engine: FEFO allocation so one unit of demand is never counted twice
function analyze() {
  const skus = {}, rows = [];
  S.batches.forEach(x => (skus[x.sku] = skus[x.sku] || []).push(x));
  const info = {};
  for (const sku in skus) {
    const list = skus[sku].slice().sort((a, b) => a.expiry.localeCompare(b.expiry));
    const usage = Math.max(...list.map(x => x.usage));        // SKU demand = highest entered usage
    const lead = Math.max(...list.map(x => x.lead));
    const reorder = Math.max(...list.map(x => x.reorder));
    let consumed = 0, usable = 0;
    list.forEach(x => {
      const d = daysTo(x.expiry);
      const sold = d <= 0 ? 0 : Math.min(x.qty, Math.max(0, usage * d - consumed));
      consumed += sold;
      if (d > 0) usable += x.qty;
      const surplus = Math.max(0, x.qty - sold);
      rows.push({...x, days: d, expired: d <= 0, near: d > 0 && d <= NEAR && surplus > 0,
        surplus: Math.ceil(surplus), exposure: Math.ceil(surplus) * x.cost});
    });
    const safety = usage * SAFETY_DAYS;
    const rop = usage * lead + safety;
    const cover = usage > 0 ? usable / usage : Infinity;
    const stockout = usable <= rop || usable <= reorder || cover < lead;
    const target = usage * (lead + COVER_DAYS) + safety;
    info[sku] = {usage, lead, usable, safety, rop, cover, stockout,
      order: stockout ? Math.max(0, Math.ceil(target - usable)) : 0, target};
  }
  rows.forEach(r => r.sku_info = info[r.sku]);
  return {rows, info};
}

// ---- Draft generation (never changes stock; humans decide)
function syncDrafts() {
  const {rows, info} = analyze();
  const add = (key, d) => { if (!S.drafts.some(x => x.key === key)) {
    S.drafts.unshift({id: 'D' + Date.now() + Math.random().toString(36).slice(2,5), key, status: 'pending', created: new Date().toLocaleString(), ...d});
    log('Draft created: ' + d.title); } };
  rows.forEach(r => {
    if (r.expired) add('exp|' + r.sku + r.batch + r.qty, {title: `Quarantine expired batch ${r.batch} (${r.sku})`,
      evidence: [`Expired ${-r.days} day(s) ago`, `${r.qty} units, ${money(r.qty * r.cost)} at cost`],
      assumptions: 'Expiry date entered is correct.', uncertainty: 'None on date; disposal rules vary by region.',
      next: 'Physically verify, quarantine and dispose per local policy.'});
    else if (r.near) add('near|' + r.sku + r.batch + r.surplus, {title: `Review near-expiry batch ${r.batch} (${r.sku})`,
      evidence: [`Expires in ${r.days} days`, `${r.qty} units, est. demand before expiry leaves ${r.surplus} surplus`, `Exposure ${money(r.exposure)}`,
        `Uses ${info[r.sku].usage}/day, earlier-expiring batches served first`],
      assumptions: 'Demand stays at entered daily usage.', uncertainty: 'Demand may vary; estimate, not measured.',
      next: 'Consider promotion, transfer or supplier return. No action is taken automatically.'});
  });
  for (const sku in info) { const i = info[sku];
    if (i.stockout && i.order > 0) add('re|' + sku + i.order, {title: `Reorder proposal for ${sku}: ${i.order} units`,
      evidence: [`Usable stock ${i.usable}, covers ${i.cover.toFixed(1)} days`, `Reorder point ${i.rop.toFixed(0)} = ${i.usage} x ${i.lead}d lead + ${i.safety.toFixed(0)} safety`,
        `Order up to ${i.target.toFixed(0)} units`],
      assumptions: `Safety = ${SAFETY_DAYS} days of usage; target = lead time + ${COVER_DAYS} days. No open orders or supplier minimum recorded.`,
      uncertainty: 'Supplier delays or demand spikes not modelled.', next: 'Pharmacist reviews and places the order manually.'}); }
  save();
}

function review(id, status) {
  const name = $('#reviewer').value.trim();
  if (!name) return alert('Enter the reviewer name first.');
  const d = S.drafts.find(x => x.id === id);
  if (!d || d.status !== 'pending') return;
  d.status = status; d.reviewedBy = name; d.reviewedAt = new Date().toLocaleString();
  S.reviewer = name; log(`${name} ${status} draft: ${d.title}`); save(); render();
}

// ---- Rendering
function render() {
  syncDrafts();
  const {rows, info} = analyze();
  const so = Object.values(info).filter(i => i.stockout).length;
  const m = [[rows.length, 'Batches'], [rows.reduce((a, r) => a + r.qty, 0), 'Units on hand'],
    [money(rows.reduce((a, r) => a + r.qty * r.cost, 0)), 'Inventory value'],
    [money(rows.reduce((a, r) => a + r.exposure, 0)), 'Est. expiry exposure'],
    [rows.filter(r => r.near || r.expired).length, 'Near/expired batches'], [so, 'Stockout-risk SKUs']];
  $('#metrics').innerHTML = m.map(([v, l]) => `<div class="m"><b>${esc(v)}</b><span>${l}</span></div>`).join('');
  $('#reviewer').value = $('#reviewer').value || S.reviewer || '';

  $('#drafts').innerHTML = S.drafts.length ? S.drafts.map(d => `<div class="card"><h3>${esc(d.title)}</h3>
    <span class="tag ${d.status === 'approved' ? 'green' : d.status === 'rejected' ? 'red' : 'amber'}">${d.status}</span>
    <ul>${d.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
    <p>Assumptions: ${esc(d.assumptions)}</p><p>Uncertainty: ${esc(d.uncertainty)}</p><p>Next step: ${esc(d.next)}</p>
    ${d.status === 'pending' ? `<div class="row"><button data-a="approved" data-id="${d.id}">Approve</button><button class="no" data-a="rejected" data-id="${d.id}">Reject</button></div>`
      : `<p>${esc(d.reviewedBy)}, ${esc(d.reviewedAt)}</p>`}</div>`).join('') : '<p class="hint">No drafts. Inventory looks fine.</p>';

  const q = $('#search').value.toLowerCase(), f = $('#filter').value;
  const shown = rows.filter(r => (!q || (r.name + r.sku + r.batch).toLowerCase().includes(q)) &&
    (f === 'all' || (f === 'expired' && r.expired) || (f === 'near' && r.near) ||
     (f === 'stockout' && r.sku_info.stockout) || (f === 'ok' && !r.expired && !r.near && !r.sku_info.stockout)));
  $('#list').innerHTML = shown.length ? shown.map(r => `<div class="card"><h3>${esc(r.name)}</h3>
    ${r.expired ? '<span class="tag red">Expired</span>' : r.near ? '<span class="tag amber">Near expiry</span>' : ''}
    ${r.sku_info.stockout ? '<span class="tag red">Stockout risk</span>' : ''}
    ${!r.expired && !r.near && !r.sku_info.stockout ? '<span class="tag green">OK</span>' : ''}
    <p>${esc(r.sku)} / batch ${esc(r.batch)} / expires ${esc(r.expiry)} (${r.days} days)</p>
    <p>Qty ${r.qty} / usage ${r.usage} per day / lead ${r.lead}d / cost ${money(r.cost)}</p>
    <p>Est. surplus: ${r.surplus} units (${money(r.exposure)}) / SKU cover: ${isFinite(r.sku_info.cover) ? r.sku_info.cover.toFixed(1) + ' days' : 'n/a'}</p></div>`).join('')
    : '<p class="hint">No batches match. Add one above or change the filter.</p>';
  $('#log').innerHTML = S.logs.map(l => `<li>${esc(l.t)}: ${esc(l.m)}</li>`).join('') || '<li>No activity yet.</li>';
}

// ---- Events
$('#form').addEventListener('submit', e => {
  e.preventDefault();
  const v = id => $('#' + id).value.trim();
  const x = {name: v('name'), sku: v('sku').toUpperCase(), batch: v('batch'), expiry: v('expiry'),
    qty: Number(v('qty')), usage: Number(v('usage')), reorder: Number(v('reorder')), lead: Number(v('lead')), cost: Number(v('cost'))};
  let err = '';
  if (!x.name || !x.sku || !x.batch) err = 'Name, SKU and batch number are required.';
  else if (!x.expiry) err = 'Choose an expiry date.';
  else if (['qty','usage','reorder','lead','cost'].some(k => v(k) === '' || !isFinite(x[k]) || x[k] < 0)) err = 'Quantity, usage, reorder level, lead time and cost must be numbers of 0 or more.';
  else if (!Number.isInteger(x.qty) || !Number.isInteger(x.lead)) err = 'Quantity and lead time must be whole numbers.';
  else if (S.batches.some(b => b.sku === x.sku && b.batch.toLowerCase() === x.batch.toLowerCase())) err = `Batch ${x.batch} already exists for SKU ${x.sku}.`;
  $('#error').textContent = err;
  if (err) return;
  S.batches.push(x); log(`Added batch ${x.batch} for ${x.sku}`); save(); e.target.reset(); render();
});
$('#drafts').addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) review(b.dataset.id, b.dataset.a); });
$('#search').addEventListener('input', render);
$('#filter').addEventListener('change', render);
$('#export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], {type: 'application/json'}));
  a.download = 'medistock-export.json'; a.click(); log('Exported data'); save(); render();
});
$('#reset').addEventListener('click', () => {
  if (confirm('Replace all data with the synthetic demo set?')) { S = seed(); log('Reset to synthetic demo data'); save(); render(); }
});
render();
