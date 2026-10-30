/* Premier Pools Cash Book - phone app
   Data lives in Google Firebase (Firestore). The database rules (firestore.rules)
   decide who may do what; this file only shows and sends. */
(function () {
const CFG = window.CB_CONFIG || {};
const ENTRY = 'Javed', APPROVERS = ['Bhavesh', 'Jatin'], PEOPLE = [ENTRY, ...APPROVERS];
const ACCOUNTS = ['Javed', 'Bhavesh', 'Jatin'];
const TYPES = {
  cash_in:  {label:'Cash received',  sub:'Jama · cash',                 cash:1,  bank:0,  kind:'in',   tag:'C+'},
  cash_out: {label:'Cash paid',      sub:'Udhar · cash',                cash:-1, bank:0,  kind:'out',  tag:'C−'},
  bank_in:  {label:'Online received',sub:'Jama · in account',           cash:0,  bank:1,  kind:'in',   tag:'B+'},
  bank_out: {label:'Online paid',    sub:'Udhar · from account',        cash:0,  bank:-1, kind:'out',  tag:'B−'},
  withdraw: {label:'Bank → Cash',    sub:'Cash withdrawn from account', cash:1,  bank:-1, kind:'xfer', tag:'⇄'}
};
const FIELDS = ['date','type','amount','party','category','note','challan','account','mode','ref'];
const CATS = ['Client payment','Material','Labour','Fuel / Travel','Salary','Office','Rent','Electricity','Repairs','Other'];
const accOf = e => ACCOUNTS.includes(e.account) ? e.account : ACCOUNTS[0];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => iso(new Date());
const fmt = n => { const v = Math.round((n || 0) * 100) / 100; const s = Math.abs(v).toLocaleString('en-IN', {minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2}); return (v < 0 ? '−' : '') + '₹' + s; };
const dmy = d => d ? d.split('-').reverse().join('-') : '';
const ms = t => t && t.toMillis ? t.toMillis() : (+t || 0);
const when = t => { const m = ms(t); return m ? new Date(m).toLocaleString('en-IN', {day:'numeric', month:'short', hour:'numeric', minute:'2-digit'}) : 'just now'; };
const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const dayLabel = d => { const t = today(); const y = new Date(); y.setDate(y.getDate() - 1);
  const base = new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {weekday:'short', day:'numeric', month:'short', year:'numeric'});
  return d === t ? 'Today · ' + base : d === iso(y) ? 'Yesterday · ' + base : base; };
const listNames = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const only = (o, keys) => { const r = {}; keys.forEach(k => { if (o[k] !== undefined && o[k] !== '') r[k] = o[k]; }); return r; };

const S = {raw: [], reqRaw: [], base: null, baseExists: false, entries: [], reqs: [], settings: {openingCash: 0, opening: {}},
  period: 'month', from: '', to: '', acct: 'all', cat: '', q: '', me: null, mode: 'new', editing: null, viewing: null, type: 'cash_out',
  loaded: {}, authReady: false};

/* ---------- connection ---------- */
const filled = v => v && !String(v).includes('PASTE');
const configured = CFG.firebase && Object.values(CFG.firebase).every(filled) && CFG.people && PEOPLE.every(p => filled(CFG.people[p]));
if (!configured) {
  $('loadMsg').innerHTML = '<b>The app is not connected to its online database yet.</b><br>Fill in config.js with your Firebase settings and the three partners\' emails, then upload it again.';
  return;
}
if (!window.firebase) { $('loadMsg').textContent = 'Could not load. Connect to the internet and open the app again.'; return; }
firebase.initializeApp(CFG.firebase);
const auth = firebase.auth(), db = firebase.firestore();
db.enablePersistence({synchronizeTabs: true}).catch(() => {});
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
// config.js holds a SHA-256 fingerprint of each partner's email, not the address itself.
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s || '').trim().toLowerCase()));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function nameOfEmail(e) { const h = await sha(e); return PEOPLE.find(p => String(CFG.people[p]).toLowerCase() === h) || null; }
const savedEmail = n => { try { return localStorage.getItem('cb-email-' + n) || ''; } catch (e) { return ''; } };
const saveEmail = (n, e) => { try { localStorage.setItem('cb-email-' + n, e); } catch (x) {} };

/* ---------- derive the book from entries + approved requests ---------- */
function derive() {
  const reqs = S.reqRaw.map(r => {
    const full = APPROVERS.every(a => r.approvals && r.approvals[a]);
    const state = r.status === 'rejected' ? 'rejected' : r.status === 'cancelled' ? 'cancelled' : full ? 'approved' : 'pending';
    return {...r, full, state, atMs: ms(r.at)};
  }).sort((a, b) => a.atMs - b.atMs);
  S.reqs = reqs;
  const byEntry = {};
  reqs.filter(r => r.state === 'approved' && r.entryId).forEach(r => (byEntry[r.entryId] = byEntry[r.entryId] || []).push(r));
  S.entries = S.raw.filter(e => TYPES[e.type]).map(e => {
    let cur = {...e}; const history = [];
    for (const r of byEntry[e.id] || []) {
      history.push({at: r.at, action: r.action, before: r.before, reason: r.reason, by: r.by, approvedAt: maxApproval(r)});
      if (r.action === 'edit') cur = {id: e.id, by: e.by, createdAt: e.createdAt, ...only(r.data || {}, FIELDS)};
      if (r.action === 'delete') cur.deleted = true;
    }
    cur.history = history; return cur;
  });
  let st = Object.assign({openingCash: 0, opening: {}}, S.base || {});
  reqs.filter(r => r.state === 'approved' && r.action === 'opening').forEach(r => { st = Object.assign({openingCash: 0, opening: {}}, r.data || {}); });
  S.settings = st;
}
const maxApproval = r => Math.max(...APPROVERS.map(a => ms(r.approvals && r.approvals[a])));
const live = () => S.entries.filter(e => !e.deleted);
const pendingFor = id => S.reqs.find(r => r.state === 'pending' && r.entryId === id);

/* ---------- compute balances ---------- */
function range() {
  const t = new Date();
  if (S.period === 'today') return [today(), today()];
  if (S.period === 'yesterday') { const y = new Date(); y.setDate(y.getDate() - 1); return [iso(y), iso(y)]; }
  if (S.period === 'month') return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(new Date(t.getFullYear(), t.getMonth() + 1, 0))];
  if (S.period === 'lastmonth') return [iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))];
  if (S.period === 'custom') return [S.from || '0000-01-01', S.to || '9999-12-31'];
  return ['0000-01-01', '9999-12-31'];
}
const acctDelta = (e, acct) => { const t = TYPES[e.type], a = +e.amount || 0;
  if (acct === 'cash') return t.cash * a; if (acct === 'all') return (t.cash + t.bank) * a; return accOf(e) === acct ? t.bank * a : 0; };
const touches = (e, acct) => { const t = TYPES[e.type]; return acct === 'all' || (acct === 'cash' ? !!t.cash : (!!t.bank && accOf(e) === acct)); };
function openBal() { const b = {cash: +S.settings.openingCash || 0}; for (const n of ACCOUNTS) b[n] = +(S.settings.opening || {})[n] || 0; return b; }
function applyE(b, e) { const t = TYPES[e.type], a = +e.amount || 0; b.cash += t.cash * a; if (t.bank) b[accOf(e)] += t.bank * a; }
const pick = (b, acct) => acct === 'all' ? ACCOUNTS.reduce((s, n) => s + b[n], b.cash) : b[acct];
function compute() {
  const sorted = live().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : ms(a.createdAt) - ms(b.createdAt));
  const bal = openBal(); const [from, to] = range(); let opening = null, closing = null; const rows = [];
  const q = S.q.trim().toLowerCase();
  for (const e of sorted) {
    if (e.date >= from && opening === null) opening = pick(bal, S.acct);
    if (e.date > to && closing === null) closing = pick(bal, S.acct);
    const t = TYPES[e.type]; applyE(bal, e);
    if (e.date < from || e.date > to || !touches(e, S.acct)) continue;
    if (S.cat && e.category !== S.cat) continue;
    if (q && ![e.party, e.challan, e.note, e.ref, e.category, e.mode, t.bank ? accOf(e) : '', t.label].join(' ').toLowerCase().includes(q)) continue;
    rows.push({e, t, delta: acctDelta(e, S.acct), bal: pick(bal, S.acct)});
  }
  if (opening === null) opening = pick(bal, S.acct); if (closing === null) closing = pick(bal, S.acct);
  return {rows, bal, opening, closing, from, to};
}

/* ---------- describe ---------- */
function fieldList(o) { const t = TYPES[o.type] || {}; return [
  ['Date', dmy(o.date)], ['Type', t.label], ['Amount', o.amount != null ? fmt(o.amount) : ''], ['Challan no.', o.challan], ['Name', o.party],
  ['Category', o.category], ['A/c name', t.bank ? accOf(o) + ' A/c' : (o.type ? 'Cash' : '')], ['Paid via', o.mode], ['Ref no.', o.ref], ['Note', o.note]]; }
function diffHTML(before, after) {
  const a = fieldList(before), b = fieldList(after); let h = '';
  a.forEach(([k, v], i) => { const n = b[i][1]; if ((v || '') !== (n || '')) h += `<dt>${k}</dt><dd><s>${esc(v || '—')}</s> → <b>${esc(n || '—')}</b></dd>`; });
  return h || '<dt>—</dt><dd>No fields changed</dd>';
}
const short = o => { const t = TYPES[o.type] || {}; return `${dmy(o.date)} · ${t.label || ''} ${fmt(o.amount)} · ${o.party || ''}`; };

/* ---------- render ---------- */
const PERIODS = [['today','Today'],['yesterday','Yesterday'],['month','This month'],['lastmonth','Last month'],['all','All'],['custom','Custom']];
let pickedPerson = null;
function renderStatic() {
  $('acct').innerHTML = [['all','All'],['cash','Cash'],...ACCOUNTS.map(n => [n, n])].map(([k, l]) => `<button data-a="${k}" aria-pressed="${S.acct === k}">${l}</button>`).join('');
  $('eAcc').innerHTML = '<option value="">Choose account…</option>' + ACCOUNTS.map(n => `<option value="${n}">${n} A/c</option>`).join('');
  $('setGrid').innerHTML = `<label class="f full">Cash in hand (₹)<input class="num" id="sCash" type="number" step="0.01" inputmode="decimal"></label>` +
    ACCOUNTS.map((n, i) => `<label class="f">${n} A/c (₹)<input class="num" id="sAcc${i}" type="number" step="0.01" inputmode="decimal"></label>`).join('');
  $('quick').innerHTML = Object.entries(TYPES).map(([k, t]) => `<button class="qbtn ${t.kind}${t.kind === 'xfer' ? ' wide' : ''}" data-type="${k}"><i>${t.kind === 'in' ? '+' : t.kind === 'out' ? '−' : '⇄'}</i><span>${t.label}<small>${t.sub}</small></span></button>`).join('');
  $('periods').innerHTML = PERIODS.map(([k, l]) => `<button class="chip" data-p="${k}" aria-pressed="${S.period === k}">${l}</button>`).join('');
  $('typePick').innerHTML = Object.entries(TYPES).map(([k, t]) => `<button type="button" class="${t.kind}" data-t="${k}" aria-pressed="false">${t.label}</button>`).join('');
  $('people').innerHTML = PEOPLE.map(p => `<button type="button" data-p="${p}" aria-pressed="false">${p}<small>${p === ENTRY ? 'Adds entries' : 'Approves'}</small></button>`).join('');
}
function renderLock() {
  $('lock').hidden = !!S.me; $('app').hidden = !S.me;
  $('lockLoading').hidden = S.authReady; $('lockLogin').hidden = !S.authReady || !!S.me;
  document.querySelectorAll('#people button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === pickedPerson));
}
function render() {
  renderLock(); if (!S.me) return;
  derive();
  const isEntry = S.me === ENTRY;
  $('meChip').innerHTML = `${esc(S.me)} <i>${isEntry ? 'adds entries' : 'approver'}</i>`;
  const C = compute(), B = C.bal;
  $('balances').innerHTML = [['Cash in hand', B.cash], ...ACCOUNTS.map(n => [n + ' A/c', B[n]])].map(([l, v]) => `<div class="bal"><span>${l}</span><strong class="${v < 0 ? 'neg' : ''}">${fmt(v)}</strong></div>`).join('') +
    `<div class="bal total"><span>Total</span><strong>${fmt(pick(B, 'all'))}</strong></div>`;
  $('quick').hidden = !isEntry; $('viewOnly').hidden = isEntry;
  document.querySelectorAll('#periods .chip').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === S.period));
  document.querySelectorAll('#acct button').forEach(b => b.setAttribute('aria-pressed', b.dataset.a === S.acct));
  $('custom').hidden = S.period !== 'custom';

  const cats = [...new Set([...CATS, ...S.entries.map(e => e.category).filter(Boolean)])];
  $('catList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  $('fCat').innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option ${c === S.cat ? 'selected' : ''} value="${esc(c)}">${esc(c)}</option>`).join('');
  $('partyList').innerHTML = [...new Set(S.entries.map(e => e.party).filter(Boolean))].slice(0, 300).map(p => `<option value="${esc(p)}">`).join('');

  let inn = 0, out = 0, xf = 0; for (const r of C.rows) { if (r.delta > 0) inn += r.delta; else if (r.delta < 0) out -= r.delta; else xf += +r.e.amount || 0; }
  $('totals').innerHTML = `<span class="in">Received <b>${fmt(inn)}</b></span><span class="out">Paid <b>${fmt(out)}</b></span><span>Net <b>${fmt(inn - out)}</b></span>${xf ? `<span>Bank → cash <b>${fmt(xf)}</b></span>` : ''}<span>${C.rows.length} ${C.rows.length === 1 ? 'entry' : 'entries'}</span>`;

  const st = $('status');
  if (S.errMsg) { st.hidden = false; st.className = 'status'; st.textContent = S.errMsg; }
  else if (!navigator.onLine) { st.hidden = false; st.className = 'status offline'; st.textContent = 'No internet. You can keep working; new entries upload by themselves when the internet is back.'; }
  else st.hidden = true;

  renderApprovals();

  const L = $('ledger');
  if (!S.loaded.e) { L.innerHTML = '<div class="empty"><strong>Opening your cash book…</strong></div>'; return; }
  const acctName = S.acct === 'cash' ? 'cash' : S.acct === 'all' ? 'balance (all)' : S.acct + ' A/c';
  let html = `<div class="edge num"><span>Opening ${acctName}</span><b>${fmt(C.opening)}</b></div>`;
  if (!C.rows.length) {
    html += `<div class="empty"><strong>No entries ${S.q || S.cat ? 'match these filters' : 'in this period'}</strong>${isEntry ? 'Use the buttons above to add cash or online payments.' : 'Entries Javed adds will show here.'}</div>`;
  } else {
    const groups = []; for (const r of C.rows) { const g = groups[groups.length - 1]; if (g && g.date === r.e.date) g.rows.push(r); else groups.push({date: r.e.date, rows: [r]}); }
    for (const g of groups) {
      let di = 0, dout = 0; g.rows.forEach(r => { if (r.delta > 0) di += r.delta; else if (r.delta < 0) dout -= r.delta; });
      html += `<div class="day"><div class="dayhead"><h3>${esc(dayLabel(g.date))}</h3><span class="dt num">${di ? `<span class="i">+${fmt(di)}</span>` : ''}${di && dout ? ' · ' : ''}${dout ? `<span class="o">−${fmt(dout)}</span>` : ''}</span></div>`;
      for (const r of g.rows) { const e = r.e, t = r.t;
        const kind = r.delta > 0 ? 'in' : r.delta < 0 ? 'out' : 'xfer';
        const how = t.bank ? (accOf(e) + ' A/c' + (t.kind === 'xfer' ? ' → Cash' : (e.mode ? ' · ' + e.mode : ''))) : 'Cash';
        const meta = [e.challan ? 'Challan ' + e.challan : '', e.category, how, e.ref, e.note].filter(Boolean).map(esc).join(' · ');
        const badge = pendingFor(e.id) ? '<span class="mini wait">Awaiting approval</span>' : (e.history.length ? '<span class="mini">Edited</span>' : '');
        html += `<button class="entry" data-id="${esc(e.id)}"><span class="tag ${t.kind}">${t.tag}</span>
          <span class="who"><div class="p">${esc(e.party || t.label)}${badge}</div><div class="m">${meta}</div></span>
          <span class="amt num"><div class="a ${kind}">${kind === 'in' ? '+' : kind === 'out' ? '−' : ''}${fmt(Math.abs(r.delta) || e.amount)}</div><div class="b">Bal ${fmt(r.bal)}</div></span></button>`;
      }
      html += '</div>';
    }
  }
  html += `<div class="edge num" style="border-top:1px solid var(--line)"><span>Closing ${acctName}</span><b>${fmt(C.closing)}</b></div>`;
  L.innerHTML = html;
}
function renderApprovals() {
  const box = $('approvals');
  const list = S.reqs.filter(r => r.state === 'pending' || (r.state === 'rejected' && !r.closed));
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const pend = list.filter(r => r.state === 'pending').length;
  let h = `<h2>${pend ? `Waiting for approval (${pend})` : 'Change requests'}</h2>`;
  for (const r of list) {
    const ap = r.approvals || {};
    const cur = r.entryId ? S.entries.find(e => e.id === r.entryId) : null;
    let title, body = '';
    if (r.action === 'edit') { title = 'Change entry'; body = `<dl class="diff num">${diffHTML(cur || r.before || {}, r.data || {})}</dl>`; }
    else if (r.action === 'delete') { title = 'Delete entry'; body = `<div class="why">${esc(short(cur || r.before || {}))}</div>`; }
    else { title = 'Change opening balance'; const b = S.settings, a = r.data || {};
      const rows = [['Cash', b.openingCash, a.openingCash], ...ACCOUNTS.map(n => [n + ' A/c', (b.opening || {})[n], (a.opening || {})[n]])].filter(x => (+x[1] || 0) !== (+x[2] || 0));
      body = `<dl class="diff num">${rows.map(([k, x, y]) => `<dt>${k}</dt><dd><s>${fmt(+x || 0)}</s> → <b>${fmt(+y || 0)}</b></dd>`).join('') || '<dt>—</dt><dd>No change</dd>'}</dl>`; }
    const pills = APPROVERS.map(a => r.state === 'rejected' && r.rejectedBy === a ? `<span class="pill no">${a}: rejected</span>` : ap[a] ? `<span class="pill ok">${a}: approved</span>` : `<span class="pill">${a}: waiting</span>`).join('');
    let btns = '';
    if (r.state === 'pending') {
      if (APPROVERS.includes(S.me) && !ap[S.me]) btns = `<button class="okbtn" data-ap="${r.id}">Approve</button><button class="danger" data-rj="${r.id}">Reject</button>`;
      if (S.me === ENTRY) btns += `<button class="secondary" data-cn="${r.id}">Cancel request</button>`;
    } else if (S.me === ENTRY) btns = `<button class="secondary" data-ok="${r.id}">Dismiss</button>`;
    h += `<div class="req"><div class="t">${title}${r.state === 'rejected' ? ' · rejected' : ''}</div>
      <div class="why">Requested by ${esc(r.by)} · ${when(r.at)}${r.reason ? ' · Reason: ' + esc(r.reason) : ''}</div>${body}
      <div class="who-ok">${pills}</div>${btns ? `<div class="btns">${btns}</div>` : ''}</div>`;
  }
  box.innerHTML = h;
}
let toastT; function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }
function writeErr(e) {
  const c = e && e.code;
  if (c === 'permission-denied') return 'The database refused this. Only allowed actions can be saved.';
  return 'Could not save. Check your internet and try again.';
}
// Writes queue offline; show the result when the server answers.
function send(p, okMsg) {
  const off = !navigator.onLine;
  toast(off ? 'Saved on this phone. It will upload when the internet is back.' : okMsg);
  p.catch(e => { S.errMsg = writeErr(e); render(); setTimeout(() => { S.errMsg = null; render(); }, 6000); });
}

/* ---------- sign in ---------- */
auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(() => {});
let unsubs = [];
function stopData() { unsubs.forEach(u => u()); unsubs = []; S.raw = []; S.reqRaw = []; S.base = null; S.loaded = {}; }
function startData() {
  stopData();
  const err = e => { S.errMsg = e && e.code === 'permission-denied' ? 'This login has no access. Check that the emails in firestore.rules match the logins.' : 'Could not load the cash book. Check your internet.'; render(); };
  const opt = {serverTimestamps: 'estimate'};
  unsubs.push(db.collection('entries').onSnapshot(s => { S.raw = s.docs.map(d => ({id: d.id, ...d.data(opt)})); S.loaded.e = 1; render(); }, err));
  unsubs.push(db.collection('requests').onSnapshot(s => { S.reqRaw = s.docs.map(d => ({id: d.id, ...d.data(opt)})); render(); }, err));
  unsubs.push(db.doc('settings/main').onSnapshot(s => { S.baseExists = s.exists; S.base = s.exists ? s.data() : null; render(); }, () => {}));
}
auth.onAuthStateChanged(async u => {
  S.authReady = true;
  if (!u) { S.me = null; stopData(); render(); return; }
  const n = await nameOfEmail(u.email);
  if (!n) { $('lErr').textContent = 'This login is not one of the three partners.'; auth.signOut(); return; }
  S.me = n; S.errMsg = null; touch(); startData(); render();
});
$('people').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; pickedPerson = b.dataset.p;
  const se = savedEmail(pickedPerson); if (se) $('lEmail').value = se;
  renderLock(); $('lErr').textContent = ''; ($('lEmail').value ? $('lPass') : $('lEmail')).focus(); });
$('lockLogin').addEventListener('submit', async e => {
  e.preventDefault();
  if (!pickedPerson) { $('lErr').textContent = 'Tap your name first.'; return; }
  const em = $('lEmail').value.trim().toLowerCase();
  if (!em) { $('lErr').textContent = 'Type your email.'; $('lEmail').focus(); return; }
  if ((await nameOfEmail(em)) !== pickedPerson) { $('lErr').textContent = 'This email is not ' + pickedPerson + "'s login email."; return; }
  const pw = $('lPass').value; if (!pw) { $('lErr').textContent = 'Type your password.'; return; }
  $('lGo').disabled = true; $('lErr').textContent = '';
  try { await auth.signInWithEmailAndPassword(em, pw); saveEmail(pickedPerson, em); $('lPass').value = ''; }
  catch (err) {
    const c = err && err.code;
    $('lErr').textContent = c === 'auth/network-request-failed' ? 'No internet. Signing in needs internet.' :
      c === 'auth/too-many-requests' ? 'Too many wrong tries. Wait a few minutes and try again.' :
      c === 'auth/user-not-found' ? 'No login exists for ' + pickedPerson + ' yet. Create it in Firebase.' :
      'Wrong password for ' + pickedPerson + '.';
  } finally { $('lGo').disabled = false; }
});
$('lForgot').onclick = async () => {
  const em = $('lEmail').value.trim().toLowerCase();
  if (!pickedPerson || !em) { $('lErr').textContent = 'Tap your name and type your email, then tap Forgot password.'; return; }
  if ((await nameOfEmail(em)) !== pickedPerson) { $('lErr').textContent = 'This email is not ' + pickedPerson + "'s login email."; return; }
  try { await auth.sendPasswordResetEmail(em); $('lErr').textContent = 'A reset link was emailed to ' + pickedPerson + '.'; }
  catch (e) { $('lErr').textContent = 'Could not send the reset email. Check your internet.'; }
};
function lock() { ['ovEntry', 'ovView', 'ovSet'].forEach(i => $(i).hidden = true); pickedPerson = null; auth.signOut(); }
$('btnLock').onclick = lock;
let lastAct = Date.now(); const touch = () => lastAct = Date.now();
['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, touch, {passive: true}));
setInterval(() => { if (S.me && Date.now() - lastAct > 15 * 60 * 1000) { lock(); toast('Locked after 15 minutes without use'); } }, 30000);
window.addEventListener('online', render); window.addEventListener('offline', render);

/* ---------- entry form ---------- */
function setType(k) { S.type = k; const t = TYPES[k];
  document.querySelectorAll('#typePick button').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === k));
  $('wrapMode').hidden = !(t.bank && t.kind !== 'xfer'); $('wrapRef').hidden = !t.bank; $('wrapAcc').hidden = !t.bank; $('wrapCh').hidden = t.kind !== 'in';
}
function openEntry(type, entry) {
  if (S.me !== ENTRY) return;
  S.mode = entry ? 'request' : 'new'; S.editing = entry ? entry.id : null;
  $('formTitle').textContent = entry ? 'Request a change' : 'New entry';
  $('btnAgain').hidden = !!entry; $('btnSave').textContent = entry ? 'Send for approval' : 'Save';
  $('wrapReason').hidden = !entry;
  $('lockNote').textContent = entry ? 'The entry changes only after both Bhavesh and Jatin approve.' : 'Once saved, this entry is locked. Changing it later needs approval from Bhavesh and Jatin.';
  $('eAmt').value = entry ? entry.amount : ''; $('eDate').value = entry ? entry.date : today();
  $('eParty').value = entry?.party || ''; $('eChallan').value = entry?.challan || ''; $('eCat').value = entry?.category || '';
  $('eRef').value = entry?.ref || ''; $('eNote').value = entry?.note || ''; $('eReason').value = '';
  $('eMode').value = entry?.mode || 'UPI'; $('eErr').textContent = '';
  $('eAcc').value = entry && TYPES[entry.type].bank ? accOf(entry) : '';
  setType(entry ? entry.type : type); $('ovEntry').hidden = false; setTimeout(() => $('eAmt').focus(), 30);
}
function closeEntry() { $('ovEntry').hidden = true; S.editing = null; }
function readForm() {
  const amt = parseFloat($('eAmt').value), t = TYPES[S.type];
  if (!(amt > 0)) return 'Enter an amount greater than 0.';
  if (!$('eDate').value) return 'Choose a date.';
  const party = $('eParty').value.trim() || (t.kind === 'xfer' ? t.sub : '');
  if (!party) return 'Add a name or what it was for.';
  if (t.bank && !$('eAcc').value) return 'Choose the account: Javed, Bhavesh or Jatin.';
  const o = {date: $('eDate').value, type: S.type, amount: Math.round(amt * 100) / 100, party: party.slice(0, 200), category: $('eCat').value.trim(), note: $('eNote').value.trim()};
  if (t.kind === 'in') { const ch = $('eChallan').value.trim().toUpperCase(); if (ch) o.challan = ch; }
  if (t.bank) { o.account = $('eAcc').value; o.ref = $('eRef').value.trim(); if (t.kind !== 'xfer') o.mode = $('eMode').value; }
  return o;
}
function saveEntry(again) {
  if (S.me !== ENTRY) return;
  const o = readForm(); if (typeof o === 'string') { $('eErr').textContent = o; return; }
  if (S.mode === 'request') {
    const e = S.entries.find(x => x.id === S.editing); if (!e) return;
    if (pendingFor(e.id)) { $('eErr').textContent = 'This entry already has a request waiting for approval.'; return; }
    const reason = $('eReason').value.trim(); if (!reason) { $('eErr').textContent = 'Write the reason for the change.'; $('eReason').focus(); return; }
    send(db.collection('requests').doc().set({action: 'edit', entryId: e.id, before: only(e, FIELDS), data: o, reason, by: ENTRY, at: TS(), status: 'pending', approvals: {}}),
      'Sent to Bhavesh and Jatin for approval');
    closeEntry();
  } else {
    send(db.collection('entries').doc().set({...o, by: ENTRY, createdAt: TS()}), `${TYPES[S.type].label} ${fmt(o.amount)} saved and locked`);
    if (again) { const d = $('eDate').value, ty = S.type; openEntry(ty); $('eDate').value = d; } else closeEntry();
  }
}

/* ---------- view a locked entry ---------- */
function openView(e) {
  S.viewing = e.id; const t = TYPES[e.type];
  $('vTitle').textContent = t.label + ' · ' + fmt(e.amount);
  $('vFacts').innerHTML = fieldList(e).filter(([k, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('') +
    `<dt>Entered by</dt><dd>${esc(e.by || ENTRY)} · ${when(e.createdAt)}</dd>`;
  const p = pendingFor(e.id);
  $('vLock').textContent = p ? `A ${p.action === 'delete' ? 'delete' : 'change'} request is waiting for approval.` : 'This entry is locked. Javed can request a change, which needs approval from Bhavesh and Jatin.';
  $('vHistWrap').hidden = !e.history.length;
  $('vHist').innerHTML = e.history.map(x => `<div><b>${when(x.approvedAt)}</b>: ${x.action === 'delete' ? 'deleted' : 'changed'} at ${esc(x.by)}'s request, approved by ${listNames(APPROVERS)}.${x.reason ? ' Reason: ' + esc(x.reason) + '.' : ''}<br>Before: ${esc(short(x.before || {}))}</div>`).join('');
  $('vReqBtns').hidden = S.me !== ENTRY || !!p; $('vDelBox').hidden = true; $('vReason').value = ''; $('vErr').textContent = '';
  $('vDel').textContent = 'Request delete';
  $('ovView').hidden = false;
}
$('vClose').onclick = () => $('ovView').hidden = true;
$('ovView').addEventListener('click', e => { if (e.target.id === 'ovView') $('ovView').hidden = true; });
$('vEdit').onclick = () => { const e = S.entries.find(x => x.id === S.viewing); $('ovView').hidden = true; if (e) openEntry(e.type, e); };
$('vDel').onclick = () => {
  if ($('vDelBox').hidden) { $('vDelBox').hidden = false; $('vDel').textContent = 'Send delete request'; $('vReason').focus(); return; }
  const reason = $('vReason').value.trim(); if (!reason) { $('vErr').textContent = 'Write the reason for deleting.'; return; }
  const e = S.entries.find(x => x.id === S.viewing); if (!e || pendingFor(e.id)) return;
  send(db.collection('requests').doc().set({action: 'delete', entryId: e.id, before: only(e, FIELDS), reason, by: ENTRY, at: TS(), status: 'pending', approvals: {}}),
    'Delete request sent to Bhavesh and Jatin');
  $('ovView').hidden = true;
};

/* ---------- approvals ---------- */
$('approvals').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const ref = id => db.collection('requests').doc(id);
  if (b.dataset.ap && APPROVERS.includes(S.me)) {
    const r = S.reqs.find(x => x.id === b.dataset.ap); const other = APPROVERS.find(a => a !== S.me);
    send(ref(b.dataset.ap).update({['approvals.' + S.me]: TS()}), r && r.approvals && r.approvals[other] ? 'Approved by both. Change is now final.' : 'Approved. Waiting for ' + other + '.');
  } else if (b.dataset.rj && APPROVERS.includes(S.me)) {
    send(ref(b.dataset.rj).update({status: 'rejected', rejectedBy: S.me, rejectedAt: TS()}), 'Request rejected');
  } else if (b.dataset.cn && S.me === ENTRY) {
    send(ref(b.dataset.cn).update({status: 'cancelled', cancelledAt: TS()}), 'Request cancelled');
  } else if (b.dataset.ok && S.me === ENTRY) {
    send(ref(b.dataset.ok).update({closed: true}), 'Dismissed');
  }
});

/* ---------- opening balance ---------- */
function openSettings() {
  $('sCash').value = S.settings.openingCash || 0; ACCOUNTS.forEach((n, i) => $('sAcc' + i).value = (S.settings.opening || {})[n] || 0);
  const isEntry = S.me === ENTRY, first = !S.baseExists, pend = S.reqs.some(r => r.state === 'pending' && r.action === 'opening');
  document.querySelectorAll('#setGrid input').forEach(i => i.disabled = !isEntry || pend);
  $('sSave').hidden = !isEntry || pend; $('sSave').textContent = first ? 'Save' : 'Send for approval';
  $('wrapSReason').hidden = !isEntry || first || pend; $('sReason').value = '';
  $('sNote').textContent = pend ? 'A change to the opening balance is waiting for approval.' : !isEntry ? 'Money held before the first entry. Only Javed can set it; changes need approval from Bhavesh and Jatin.' :
    first ? 'Money you had before your first entry. After you save, changing it needs approval from Bhavesh and Jatin.' : 'Changing the opening balance needs approval from Bhavesh and Jatin.';
  $('sErr').textContent = ''; $('ovSet').hidden = false;
}
function saveSettings() {
  if (S.me !== ENTRY) return;
  const opening = {}; ACCOUNTS.forEach((n, i) => opening[n] = r2($('sAcc' + i).value));
  const o = {openingCash: r2($('sCash').value), opening};
  if (!S.baseExists) send(db.doc('settings/main').set(o), 'Opening balance saved and locked');
  else {
    const reason = $('sReason').value.trim(); if (!reason) { $('sErr').textContent = 'Write the reason for the change.'; return; }
    send(db.collection('requests').doc().set({action: 'opening', data: o, before: {openingCash: S.settings.openingCash || 0, opening: S.settings.opening || {}}, reason, by: ENTRY, at: TS(), status: 'pending', approvals: {}}),
      'Sent to Bhavesh and Jatin for approval');
  }
  $('ovSet').hidden = true;
}

/* ---------- CSV ---------- */
function downloadCsv() {
  const C = compute(); const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['Date','Type','Challan no.','Name / particulars','Category','Account','Mode','Ref','Note','Received','Paid','Balance','Entered by','Edited'].map(q).join(',')];
  for (const r of C.rows) { const e = r.e; lines.push([e.date, r.t.label, e.challan, e.party, e.category, r.t.bank ? accOf(e) : 'Cash', e.mode || '', e.ref, e.note, r.delta > 0 ? r.delta : '', r.delta < 0 ? -r.delta : '', r.bal, e.by || '', e.history.length ? 'Yes' : ''].map(q).join(',')); }
  const name = `premier-pools-cashbook_${C.from === '0000-01-01' ? 'all' : C.from}_${C.to === '9999-12-31' ? today() : C.to}.csv`;
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], {type: 'text/csv'}));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- events ---------- */
renderStatic();
$('btnCsv').hidden = false;
$('quick').addEventListener('click', e => { const b = e.target.closest('.qbtn'); if (b) openEntry(b.dataset.type); });
$('periods').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; S.period = b.dataset.p;
  if (S.period === 'custom' && !S.from) { const r = new Date(); S.from = iso(new Date(r.getFullYear(), r.getMonth(), 1)); S.to = today(); $('fFrom').value = S.from; $('fTo').value = S.to; } render(); });
$('fFrom').onchange = e => { S.from = e.target.value; render(); }; $('fTo').onchange = e => { S.to = e.target.value; render(); };
$('acct').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.acct = b.dataset.a; render(); } });
$('fCat').onchange = e => { S.cat = e.target.value; render(); };
let qT; $('fQ').oninput = e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value; render(); }, 150); };
$('ledger').addEventListener('click', e => { const b = e.target.closest('.entry'); if (!b) return; const en = S.entries.find(x => x.id === b.dataset.id); if (en) openView(en); });
$('typePick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setType(b.dataset.t); });
$('formEntry').addEventListener('submit', e => { e.preventDefault(); saveEntry(false); });
$('btnAgain').onclick = () => saveEntry(true); $('btnCancel').onclick = closeEntry;
$('ovEntry').addEventListener('click', e => { if (e.target.id === 'ovEntry') closeEntry(); });
$('btnSettings').onclick = openSettings; $('sCancel').onclick = () => $('ovSet').hidden = true;
$('formSet').addEventListener('submit', e => { e.preventDefault(); saveSettings(); });
$('ovSet').addEventListener('click', e => { if (e.target.id === 'ovSet') $('ovSet').hidden = true; });
$('btnCsv').onclick = downloadCsv;
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeEntry(); ['ovView', 'ovSet'].forEach(i => $(i).hidden = true); } });
render();
})();
