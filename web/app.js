const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const local = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v))
};
const getJSON = url => fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4V10zM7 10l4-8a3 3 0 0 1 3 3v4h6a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21H7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3h3v11zM17 14l-4 8a3 3 0 0 1-3-3v-4H4a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.4 3H17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>'
};

let CFG, T, weeks = [], rounds = [], W = null, R = null, PF = {}, PR = null, FB = {}, credits = {};
let portion, tab = local.get('tab', 'pick');
const cur = () => CFG.currency || '€';
const money = n => n.toFixed(2).replace('.', CFG.language === 'de' ? ',' : '.') + ' ' + cur();
const num = n => n.toLocaleString(CFG.language);
const fixedSum = () => (CFG.fixed_meals || []).reduce((a, f) => ({ kcal: a.kcal + (f.kcal || 0), p: a.p + (f.protein || 0), kh: a.kh + (f.carbs || 0) }), { kcal: 0, p: 0, kh: 0 });
const daySum = ms => ms.reduce((a, m) => ({ kcal: a.kcal + m.kcal, p: a.p + m.p, kh: a.kh + m.kh }), fixedSum());
const person = id => CFG.persons.find(p => p.id === id) || {};
const stripQ = s => String(s || '').split('?')[0];

/* ---------------- API (with optional PIN) ---------------- */
async function send(method, url, body) {
  for (let tries = 0; tries < 2; tries++) {
    const r = await fetch(url, { method, headers: { 'X-Pin': local.get('pin', '') }, body: JSON.stringify(body) }).catch(() => null);
    if (r?.status === 401) { const p = prompt(T.pin); if (!p) return r; local.set('pin', p); continue }
    return r;
  }
}

/* ---------------- Load ---------------- */
async function init() {
  CFG = await getJSON('api/config');
  T = I18N[CFG.language] || I18N.en;
  document.documentElement.lang = CFG.language;
  document.title = CFG.name;
  const [a, ...b] = CFG.name.split(' ');
  $('#logo').innerHTML = `${esc(a)} <span>${esc(b.join(' '))}</span>`;
  portion = local.get('portion', CFG.persons[0].id);
  if (!CFG.persons.some(p => p.id === portion)) portion = CFG.persons[0].id;
  $('#seg').innerHTML = CFG.persons.map(p => `<button data-p="${esc(p.id)}">${esc(p.label || p.id)}</button>`).join('');
  $$('#seg button').forEach(b => b.onclick = () => { portion = b.dataset.p; local.set('portion', portion); render() });
  $('#kitchenBtn').setAttribute('aria-label', T.kitchen);
  $('#kitchenBtn').onclick = openKitchen;
  $('#week').onchange = e => { local.set('week', e.target.value); loadWeek(e.target.value).then(render) };
  await loadAll();
  pollStatus(true);
}

async function loadAll() {
  const idx = await getJSON('api/index') || { weeks: [], rounds: [] };
  ({ weeks, rounds } = idx);
  credits = await getJSON('img/credits.json') || {};
  const sel = $('#week');
  sel.innerHTML = weeks.slice().reverse().map(w => `<option value="${w}">${T.week_from} ${w.split('-').reverse().slice(0, 2).join('.')}.</option>`).join('');
  sel.hidden = !weeks.length;
  let wid = local.get('week', weeks.at(-1));
  if (!weeks.includes(wid)) wid = weeks.at(-1);
  sel.value = wid || '';
  await Promise.all([wid && loadWeek(wid), loadRound()]);
  render();
}

async function loadWeek(id) {
  W = await getJSON(`weeks/${id}.json`);
  FB = (await getJSON(`api/mailbox/feedback-${id}`)) || {};
}

async function loadRound() {
  const id = rounds.at(-1);
  if (!id) { R = null; return }
  [R, PF, PR] = await Promise.all([getJSON(`rounds/${id}.json`), getJSON(`api/mailbox/${id}`), getJSON(`rounds/${id}-preise.json`)]);
  PF ||= {};
  PF.auswahl ||= {}; PF.reaktionen ||= {}; PF.wuensche ||= []; PF.nachrichten ||= [];
}

/* ---------------- Mailbox ---------------- */
let saveT;
function save(now) {
  clearTimeout(saveT);
  const go = async () => {
    $('#saved') && ($('#saved').textContent = T.saving);
    const r = await send('PUT', `api/mailbox/${R.id}`, { ...PF, runde: R.id });
    $('#saved') && ($('#saved').textContent = r?.ok ? T.saved : T.not_saved);
  };
  return now ? go() : (saveT = setTimeout(go, 600));
}
let fbT;
function saveFB() {
  clearTimeout(fbT);
  fbT = setTimeout(async () => {
    const r = await send('PUT', `api/mailbox/feedback-${W.id}`, { ...FB, woche: W.id });
    $('#fbsaved') && ($('#fbsaved').textContent = r?.ok ? T.saved : T.not_saved);
  }, 600);
}

/* ---------------- Claude ---------------- */
const localTime = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19) };
async function run(action, id, text) {
  if (text && R) { PF.nachrichten.push({ zeit: localTime(), text }); await save(true) }
  const r = await send('POST', 'api/run', { action, id });
  if (r?.status === 409) return bar('err', T.busy);
  if (!r?.ok) return bar('err', T.start_fail + ((await r?.json().catch(() => ({})))?.error || r?.status || ''));
  hidden = false;
  pollStatus();
}

let pollT, sawRunning = false, lastPhase = '';
async function pollStatus(first) {
  clearTimeout(pollT);
  const s = await getJSON('api/status');
  if (!s) return;
  if (s.running) {
    sawRunning = true;
    const sec = Math.round((Date.now() - new Date(s.start)) / 1000);
    bar('run', `${T.action[s.action] || s.action}: Claude ${T.phase[s.phase] || s.phase} … ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} · ${T.usually}`);
    // the round is written before photos arrive — show it as soon as it exists
    if (s.phase !== lastPhase && ['prices', 'images'].includes(s.phase)) await loadAll();
    lastPhase = s.phase;
    pollT = setTimeout(pollStatus, s.phase === 'images' ? 2500 : 1500);
  } else if (sawRunning && !first) {
    sawRunning = false; lastPhase = '';
    bar(s.ok ? 'done' : 'err', (s.ok ? T.finished : '⚠ ') + (s.summary || '') + (s.seconds ? ` (${s.seconds} s)` : ''));
    await loadAll();
  }
}

let hidden = false;
function bar(kind, text) {
  if (kind === 'run' && hidden) return;
  if (kind !== 'run') hidden = false;
  const el = $('#statusbar');
  el.innerHTML = `<div class="statusbar ${kind === 'run' ? '' : kind}">${kind === 'run' ? '<div class="spin"></div>' : ''}<p>${esc(text)}</p><button aria-label="${T.hide}">✕</button></div>`;
  $('button', el).onclick = () => { el.innerHTML = ''; hidden = kind === 'run' };
}

/* ---------------- Render ---------------- */
function render() {
  $$('#seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === portion));
  const tabs = [['pick', R?.status === 'geplant' ? T.tab_pick_done : T.tab_pick], W && ['menu', T.tab_menu], W && ['shop', T.tab_shop], W && ['prep', T.tab_prep], W && ['day', T.tab_day], W && ['fb', T.tab_fb]].filter(Boolean);
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  const views = { pick: R ? pickView : emptyView, menu: menuView, shop: shopView, prep: prepView, day: dayView, fb: fbView };
  $('#app').innerHTML = `
    ${tab !== 'pick' && W ? hero() : ''}
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</nav>
    <section>${views[tab]?.() ?? `<div class="empty">${T.nothing}</div>`}</section>
    ${creditsHtml()}`;
  $$('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; local.set('tab', tab); render(); scrollTo({ top: 0 }) });
  ({ pick: R ? bindPick : bindEmpty, menu: bindMenu, shop: bindChecks, prep: bindPrep, day: bindDay, fb: bindFb })[tab]?.();
}

function hero() {
  const P = person(portion), sum = daySum(W.rezepte.map(r => r.makros[portion]));
  return `<div class="hero ${W.hero ? '' : 'plain'}">${W.hero ? `<img src="${W.hero}" alt="">` : ''}
    <div class="in"><div class="kicker">${esc(W.zeitraum)}</div><h1>${esc(W.titel)}</h1>
      <div class="stats">
        <div class="stat"><b>${money(W.budget.summe)}</b>${T.shopping} · ${esc((W.einkaufstag || '').split('·')[1] || '')}</div>
        <div class="stat"><b>${esc((W.preptag || '').split('·')[1] || '')}</b>${T.prep} ${esc((W.preptag || '').split('·')[0])}</div>
        <div class="stat"><b>${num(sum.kcal)} kcal</b>${esc(P.label)} · ${esc(P.name || '')}</div>
      </div></div></div>`;
}

const placeholder = title => `<div class="ph-empty"><span>${esc(title)}</span></div>`;
const img = (src, title) => src ? `<img src="${src}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph-empty',innerHTML:'<span>${esc(title).replace(/'/g, '')}</span>'}))">` : placeholder(title);

/* ---------------- Empty state ---------------- */
function emptyView() {
  return `<div class="empty-state"><h2>${T.empty_title}</h2><p>${T.empty_text}</p>
    <button class="big plan" id="newRound"><span>${T.btn_new}<small>${T.btn_new_sub}</small></span></button></div>`;
}
function bindEmpty() { $('#newRound').onclick = () => run('neue_runde', '') }

/* ---------------- Choose ---------------- */
function pickView() {
  const chat = [...(R.verlauf || []).map(v => ({ ...v, von: v.von || 'claude' })), ...PF.nachrichten.map(n => ({ ...n, von: 'ihr' }))]
    .sort((a, b) => (a.zeit || '').slice(0, 19).localeCompare((b.zeit || '').slice(0, 19)));
  const planned = R.status === 'geplant', all = CFG.meals.every(m => PF.auswahl[m.id]);
  return `
    <div class="round">
      <div class="kicker">${esc(R.zeitraum)} · ${T.shopping} ${esc(R.einkaufstag)} · ${T.prep} ${esc(R.preptag)}</div>
      <h2>${planned ? T.plan_ready : T.what_cook}</h2>
      ${chat.length ? `<div class="chat">${chat.slice(-8).map(v => `<div class="bubble ${v.von === 'ihr' ? 'ihr' : 'claude'}"><small>${v.von === 'ihr' ? T.you : T.claude} · ${esc((v.zeit || '').slice(5, 16).replace('T', ' '))}</small>${esc(v.text)}</div>`).join('')}</div>` : `<p>${esc(R.nachricht)}</p>`}
      ${R.hinweise?.length ? `<div class="notes">${R.hinweise.map(esc).join(' · ')}</div>` : ''}
    </div>
    ${CFG.meals.map(m => `
      <div class="slothead"><h2>${esc(m.label || m.id)}</h2><span>${T.pick_one}</span></div>
      <div class="cands">${R.kandidaten.filter(k => k.slot === m.id).map(candCard).join('')}</div>`).join('')}
    <div class="slothead"><h2>${T.wishes_head}</h2><span>${T.wishes_sub}</span></div>
    <div class="wishes">${T.wishes.map(w => `<button class="wish" data-w="${esc(w)}" aria-pressed="${PF.wuensche.includes(w)}">${esc(w)}</button>`).join('')}</div>
    <textarea class="idea" id="idea" placeholder="${esc(T.idea_ph)}">${esc(PF.idee || '')}</textarea>
    <div class="saved" id="saved"></div>
    <div class="actions">
      <button class="big claude" id="askClaude"><span>${T.btn_revise}<small>${T.btn_revise_sub}</small></span></button>
      ${planned ? `<button class="big plan" id="newRound"><span>${T.btn_new}<small>${T.btn_new_sub}</small></span></button>`
        : `<button class="big plan" id="makePlan" ${all ? '' : 'disabled'}><span>${T.btn_plan}<small>${all ? T.btn_plan_sub : T.btn_plan_need}</small></span></button>`}
    </div>
    <p class="hint">${T.chat_hint}</p>
    ${comboBar()}`;
}

function candCard(k) {
  const m = k.makros?.[portion], re = PF.reaktionen[k.id] || {}, sel = PF.auswahl[k.slot] === k.id;
  return `<article class="cand ${sel ? 'sel' : ''} ${re.daumen === -1 ? 'down' : ''}">
    <div class="ph" data-open="${k.id}">${img(k.bild, k.titel)}${k.neu ? `<span class="flag">${T.new_badge}</span>` : ''}<span class="selmark">${T.picked_badge}</span></div>
    <div class="body">
      <h3>${esc(k.titel)}</h3><div class="u">${esc(k.untertitel)}</div>
      ${k.antwort ? `<div class="answer"><b>${T.claude}:</b> ${esc(k.antwort)}</div>` : ''}
      <div class="chips">${m ? `<span class="chip k">${m.kcal} kcal</span><span class="chip">${m.p} g P</span><span class="chip">${m.kh} g ${T.carbs}</span>` : ''}
        ${k.kosten ? `<span class="chip">~${money(k.kosten)}</span>` : ''}<span class="chip o">${k.aktiv} min</span></div>
      <div class="acts">
        <button class="pick" data-pick="${k.id}">${sel ? T.picked : T.pick}</button>
        <button class="ib up" data-d="1" data-id="${k.id}" aria-pressed="${re.daumen === 1}" aria-label="${T.up}">${ICON.up}</button>
        <button class="ib dn" data-d="-1" data-id="${k.id}" aria-pressed="${re.daumen === -1}" aria-label="${T.down}">${ICON.down}</button>
        <button class="ib" data-open="${k.id}" aria-label="${T.details}">${ICON.info}</button>
      </div>
      <textarea class="note" data-note="${k.id}" rows="1" placeholder="${esc(T.note_ph)}">${esc(re.notiz || '')}</textarea>
    </div></article>`;
}

/* combo: macros, time, prices across stores */
function selection() {
  const sel = CFG.meals.map(m => R.kandidaten.find(k => k.id === PF.auswahl[m.id])).filter(Boolean);
  const items = {};
  sel.forEach(k => (k.berechnet?.einkaufsliste || []).forEach(l => { items[l.zutat] ||= { ...l, g: 0 }; items[l.zutat].g += l.g }));
  return { sel, items: Object.values(items) };
}
const packs = it => Math.max(1, Math.ceil(it.g / it.pack_g - 0.03));
function priceIn(store, it) {
  const p = PR?.zutaten?.[it.zutat];
  const base = (p?.regulaer_eur_kg ?? it.eur_kg) * (PR?.aufschlag?.[store] || 1);
  const a = p?.angebote?.[store];
  return a && a.eur_kg < base ? { eur_kg: a.eur_kg, offer: a } : { eur_kg: base };
}
function costIn(stores, items) {
  let sum = 0; const rows = [];
  items.filter(i => i.laden !== 'Vorrat').forEach(it => {
    let best = null;
    stores.forEach(s => { const p = priceIn(s, it); if (!best || p.eur_kg < best.eur_kg) best = { ...p, store: s } });
    const e = packs(it) * it.pack_g / 1000 * best.eur_kg;
    sum += e; rows.push({ it, e, ...best });
  });
  return { sum, rows };
}
function compareStores(items) {
  if (!PR) return null;
  const L = Object.keys(PR.laeden);
  const single = L.map(l => ({ stores: [l], ...costIn([l], items) })).sort((a, b) => a.sum - b.sum);
  const pairs = [];
  L.forEach((a, i) => L.slice(i + 1).forEach(b => pairs.push({ stores: [a, b], ...costIn([a, b], items) })));
  pairs.sort((a, b) => a.sum - b.sum);
  return { single, pair: pairs[0], all: { stores: L, ...costIn(L, items) } };
}
const storeName = ls => ls.map(l => PR?.laeden?.[l] || l).join(' + ');

function comboBar() {
  const { sel, items } = selection();
  if (sel.length < CFG.meals.length) return `<div class="combo"><div class="l1"><span>${T.combo_empty}</span><b>–</b></div><div class="l2">${T.combo_empty_sub}</div></div>`;
  const t = daySum(sel.map(k => k.makros[portion]));
  const v = compareStores(items), best = v?.single[0], pair = v?.pair;
  const price = best ? best.sum : items.reduce((a, it) => a + (it.laden === 'Vorrat' ? 0 : packs(it) * it.pack_g / 1000 * it.eur_kg), 0);
  const min = sel.reduce((a, k) => a + (k.aktiv || 0), 0) + 10;
  const extra = pair && best.sum - pair.sum > (PR.zweiter_laden_ab ?? 3) ? ` · ${T.two_stores} ${money(pair.sum)}` : '';
  return `<div class="combo ${price > CFG.budget ? 'over' : 'ok'}" id="combo">
    <div class="l1"><span>${sel.map(k => esc(k.titel)).join(' + ')}</span><b class="eur">${money(price)}</b></div>
    <div class="l2">${esc(person(portion).label)}: ${num(t.kcal)} kcal · ${t.p} g P · ${t.kh} g ${T.carbs} · ~${min} min · ${best ? `${T.one_store}: ${storeName(best.stores)}${extra} ›` : T.est_prices}</div></div>`;
}

function openSheet(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  if (!d.open) d.showModal();
  d.scrollTop = 0;
  $$('.close', d).forEach(b => b.onclick = () => d.close());
  d.onclick = e => { if (e.target === d) d.close() };
  return d;
}

/* ---------------- Kitchen inventory ---------------- */
async function openKitchen() {
  const k = await getJSON('api/kitchen');
  if (!k) return bar('err', T.k_load_fail);
  const items = (k.items || []).map(i => ({ name: i.name || '', anz: i.anz ?? 1, notiz: i.notiz || '' }));
  const rows = () => items.map((i, n) => `<div class="krow" data-n="${n}">
      <input class="kn" maxlength="80" value="${esc(i.name)}" placeholder="${esc(T.k_name)}" aria-label="${esc(T.k_name)}">
      <div class="step"><button data-s="-1" aria-label="${T.k_less}">−</button><b>${i.anz}</b><button data-s="1" aria-label="${T.k_more}">+</button></div>
      <button class="ib kdel" aria-label="${T.k_del}">✕</button>
      <input class="kt" maxlength="200" value="${esc(i.notiz)}" placeholder="${esc(T.k_note)}" aria-label="${esc(T.k_note)}"></div>`).join('') || `<p class="hint">${T.k_empty}</p>`;
  const d = openSheet(`<div class="sheet"><button class="close" style="position:static;float:right" aria-label="${T.close}">✕</button>
    <h2>${T.kitchen_head}</h2><p class="hint">${T.kitchen_sub}</p>
    <div id="krows">${rows()}</div>
    <button class="kadd" id="kadd">${T.k_add}</button>
    <div class="saved" id="ksaved"></div>
    <button class="big plan" id="ksave"><span>${T.k_save}</span></button></div>`);
  const draw = () => { $('#krows', d).innerHTML = rows(); bind() };
  const bind = () => $$('.krow', d).forEach(r => {
    const i = items[r.dataset.n];
    $('.kn', r).oninput = e => i.name = e.target.value;
    $('.kt', r).oninput = e => i.notiz = e.target.value;
    $$('.step button', r).forEach(b => b.onclick = () => { i.anz = Math.max(0, Math.min(99, i.anz + +b.dataset.s)); $('.step b', r).textContent = i.anz });
    $('.kdel', r).onclick = () => { items.splice(r.dataset.n, 1); draw() };
  });
  bind();
  $('#kadd', d).onclick = () => { items.push({ name: '', anz: 1, notiz: '' }); draw(); $$('.kn', d).at(-1).focus() };
  $('#ksave', d).onclick = async () => {
    const msg = $('#ksaved', d);
    if (items.some(i => !i.name.trim())) return msg.textContent = T.k_name_req;
    msg.textContent = T.saving;
    const r = await send('PUT', 'api/kitchen', { items });
    msg.textContent = r?.ok ? T.k_saved : T.not_saved;
  };
}

function openCombo() {
  const { items } = selection(), v = compareStores(items);
  if (!v) return;
  const until = d => (d || '').slice(5).split('-').reverse().join('.') + '.';
  openSheet(`<div class="sheet"><button class="close" style="position:static;float:right" aria-label="${T.close}">✕</button>
    <div class="kicker" style="color:var(--muted)">${esc(CFG.offers.zip)} · ${T.offers_until} ${esc(PR.stichtag)}</div>
    <h2>${T.where_shop}</h2>
    <table class="stores">${v.single.map((e, i) => `<tr class="${i === 0 ? 'best' : ''}"><td>${i === 0 ? `<span class="badge-best">${T.best}</span>` : ''}${storeName(e.stores)}</td><td>${money(e.sum)}</td></tr>`).join('')}
      <tr><td><b>${T.two}:</b> ${storeName(v.pair.stores)}</td><td>${money(v.pair.sum)}</td></tr>
      <tr><td>${T.all_stores}</td><td>${money(v.all.sum)}</td></tr></table>
    <p class="hint">${T.price_note}</p>
    <h3 style="margin-top:18px">${T.list_best}</h3>
    <table class="stores">${v.all.rows.map(z => `<tr><td>${packs(z.it)} × ${esc(z.it.name)}${z.offer ? `<span class="offer">${esc(PR.laeden[z.store])}: ${esc(z.offer.produkt)} · ${z.offer.eur_kg.toFixed(2)} ${cur()}/kg · ${until(z.offer.bis)}${z.offer.treue ? ' · ' + T.loyalty : ''}</span>` : `<span class="offer" style="color:var(--muted)">${T.no_offer}</span>`}</td><td>${money(z.e)}</td></tr>`).join('')}</table>
    <p class="hint">${T.from_pantry}: ${items.filter(i => i.laden === 'Vorrat').map(i => esc(i.name)).join(', ') || '–'}</p></div>`);
}

function openCand(id) {
  const k = R.kandidaten.find(x => x.id === id), b = k.berechnet || {}, m = k.makros?.[portion], fix = k.rechnung?.pro_portion || {};
  const name = z => (b.einkaufsliste || []).find(l => l.zutat === z)?.name || z;
  const n = CFG.days * CFG.persons.length;
  const d = openSheet(`
    <div class="sheet-img">${img(k.bild, k.titel)}<button class="close" aria-label="${T.close}">✕</button></div>
    <div class="sheet">
      <div class="kicker" style="color:var(--muted)">${esc(CFG.meals.find(x => x.id === k.slot)?.label || k.slot)} · ${k.aktiv} ${T.active_min} · ~${money(k.kosten || 0)}</div>
      <h2>${esc(k.titel)}</h2><p class="sub" style="margin:0">${esc(k.untertitel)}</p>
      ${k.bild_suche ? `<button class="ghost swap" id="swap">${T.other_photo}</button>` : ''}${k.bild ? ` <span class="hint">${T.stock_photo}</span>` : ''}
      ${m ? `<div class="macro"><div><b>${m.kcal}</b><small>kcal</small></div><div><b>${m.p} g</b><small>${T.protein}</small></div><div><b>${m.kh} g</b><small>${T.carbs}</small></div></div>` : ''}
      <p>${esc(k.pitch)}</p>
      ${k.antwort ? `<div class="box ok"><h4>${T.reply}</h4><p>${esc(k.antwort)}</p></div>` : ''}
      ${k.warum ? `<div class="box ok"><h4>${T.why}</h4><p>${esc(k.warum)}</p></div>` : ''}
      ${k.risiko ? `<div class="box warn"><h4>${T.risk}</h4><p>${esc(k.risiko)}</p></div>` : ''}
      ${b.mengen ? `<h3 style="margin-top:20px">${T.ingr_for(n)}</h3><div class="ing"><ul>
        ${Object.entries(b.mengen).map(([z, g]) => `<li>${num(g)} g ${esc(name(z))}</li>`).join('')}
        ${Object.entries(fix).map(([z, g]) => `<li>${g} g ${esc(name(z))} <span class="est">${T.per_portion}</span></li>`).join('')}
        <li class="est">${T.spices_later}</li></ul></div>
        <p class="hint">${T.portioning}: ${CFG.persons.map(p => `${esc(p.label)} ${(b.anteil[p.id] * 100).toFixed(1)} %`).join(', ')} ${T.of_main}.</p>` : ''}
    </div>`);
  const sw = $('#swap', d);
  if (sw) sw.onclick = async () => {
    sw.disabled = true; sw.textContent = '…';
    const r = await send('POST', 'api/image', { round: R.id, id });
    const j = await r?.json().catch(() => null);
    if (j?.ok) { k.bild = j.bild; credits = await getJSON('img/credits.json') || {}; render(); openCand(id) }
    else { sw.textContent = T.no_photo }
  };
}

function bindPick() {
  $$('[data-pick]').forEach(b => b.onclick = () => {
    const k = R.kandidaten.find(x => x.id === b.dataset.pick);
    PF.auswahl[k.slot] = PF.auswahl[k.slot] === k.id ? null : k.id;
    save(); render();
  });
  $$('.ib[data-d]').forEach(b => b.onclick = () => {
    const r = PF.reaktionen[b.dataset.id] ||= {}, d = +b.dataset.d;
    r.daumen = r.daumen === d ? 0 : d;
    save(); render();
  });
  $$('[data-open]').forEach(b => b.onclick = () => openCand(b.dataset.open));
  $$('[data-note]').forEach(t => t.oninput = () => { (PF.reaktionen[t.dataset.note] ||= {}).notiz = t.value; save() });
  $$('.wish').forEach(b => b.onclick = () => {
    const w = b.dataset.w;
    PF.wuensche = PF.wuensche.includes(w) ? PF.wuensche.filter(x => x !== w) : [...PF.wuensche, w];
    b.setAttribute('aria-pressed', PF.wuensche.includes(w)); save();
  });
  $('#idea').oninput = e => { PF.idee = e.target.value; save() };
  $('#combo')?.addEventListener('click', openCombo);
  $('#askClaude').onclick = () => {
    const parts = [], title = id => R.kandidaten.find(k => k.id === id)?.titel || id, re = Object.entries(PF.reaktionen);
    const ups = re.filter(([, r]) => r.daumen === 1).map(([id]) => title(id)), downs = re.filter(([, r]) => r.daumen === -1).map(([id]) => title(id));
    if (ups.length) parts.push('+ ' + ups.join(', '));
    if (downs.length) parts.push('− ' + downs.join(', '));
    re.filter(([, r]) => r.notiz?.trim()).forEach(([id, r]) => parts.push(`${title(id)}: ${r.notiz.trim()}`));
    if (PF.wuensche.length) parts.push(`${T.ideas}: ${PF.wuensche.join(', ')}`);
    if (PF.idee?.trim()) parts.push(`${T.idea}: ${PF.idee.trim()}`);
    if (!parts.length && !confirm(T.confirm_empty)) return;
    run('ueberarbeiten', R.id, parts.join('\n') || '…');
  };
  $('#makePlan') && ($('#makePlan').onclick = () => run('plan_erstellen', R.id, T.plan_msg(CFG.meals.map(m => R.kandidaten.find(k => k.id === PF.auswahl[m.id])?.titel).join(' + '))));
  $('#newRound') && ($('#newRound').onclick = () => run('neue_runde', ''));
}

/* ---------------- Week plan ---------------- */
function menuView() {
  const P = person(portion), ms = W.rezepte.map(r => r.makros[portion]), sum = daySum(ms);
  const colors = ['var(--lime)', 'var(--pumpkin)', '#7aa7c7', '#c97a9a'];
  const parts = [...(CFG.fixed_meals || []).map(f => ({ n: f.name, v: f.kcal || 0, c: '#c9bfa8' })),
    ...W.rezepte.map((r, i) => ({ n: r.slot.split('·')[0].trim(), v: r.makros[portion].kcal, c: colors[i % 4] }))];
  const diff = sum.kcal - P.kcal;
  return `
    <div class="day"><div class="day-row"><span>${T.per_day} · <b>${esc(P.label)}</b> (${esc(P.name || '')})</span>
      <strong>${num(sum.kcal)} <small style="font:500 14px var(--sans);color:var(--muted)">/ ${num(P.kcal)} kcal</small></strong></div>
      <div class="bar">${parts.map(p => `<i style="width:${p.v / Math.max(sum.kcal, P.kcal) * 100}%;background:${p.c}"></i>`).join('')}</div>
      <div class="legend">${parts.map(p => `<span style="--c:${p.c}">${esc(p.n)} ${p.v}</span>`).join('')}
        <span style="--c:transparent">· ${sum.p} g ${T.protein} · ${sum.kh} g ${T.carbs} · ${diff >= 0 ? '+' : ''}${diff} ${T.to_target}</span></div></div>
    ${W.fruehstueck ? `<div class="mini"><div class="ico">${esc(W.fruehstueck.name[0])}</div><div><b>${esc(W.fruehstueck.name)}</b><br><small>${esc(W.fruehstueck.text)} · ${W.fruehstueck.kcal} kcal · ${W.fruehstueck.p} g P</small></div></div>` : ''}
    <div class="grid">${W.rezepte.map(r => {
      const m = r.makros[portion];
      return `<button class="card" data-id="${r.id}"><div class="ph">${img(r.bild, r.titel)}<span class="slot">${esc(r.slot)}</span></div>
        <div class="body"><h3>${esc(r.titel)}</h3><p>${esc(r.untertitel)}</p>
        <div class="chips"><span class="chip k">${m.kcal} kcal</span><span class="chip">${m.p} g ${T.protein}</span><span class="chip">${m.kh} g ${T.carbs}</span><span class="chip o">${r.aktiv} ${T.active_min}</span>
        ${(r.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>${parts_(r)}</div></button>`;
    }).join('')}</div>
    ${extrasHtml()}
    ${W.warum ? `<h2>${T.why_plan}</h2><div class="cards2">${W.warum.map(w => `<div class="why"><h3>${esc(w.titel)}</h3><p>${esc(w.text)}</p></div>`).join('')}</div>` : ''}`;
}
const parts_ = r => r.bausteine ? `<div class="parts">${r.bausteine.map(b => `<figure><img src="${b.bild}" alt="" loading="lazy"><figcaption>${esc(b.name)}</figcaption></figure>`).join('')}</div>` : '';

// Sides shared by several dishes (e.g. a pickled salad): written once, shown below the dishes.
function extrasHtml() {
  if (!W.extras?.length) return '';
  return `<div class="slothead"><h2>${T.extras}</h2><span>${T.extras_sub}</span></div>
    ${W.extras.map(x => `<button class="mini xcard" data-x="${esc(x.id)}"><div class="ico">${esc(x.titel[0])}</div>
      <div><b>${esc(x.titel)}</b><br><small>${esc(x.untertitel || '')}${x.haltbar ? ` · ${esc(x.haltbar)}` : ''}</small></div><span class="go">›</span></button>`).join('')}`;
}
const ingHtml = zutaten => `<div class="ing">${(zutaten || []).map(g => `<h4>${esc(g.gruppe)}</h4><ul>${g.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}</div>`;
const stepsHtml = steps => steps?.length ? `<ol class="steps">${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : '';

function bindMenu() {
  $$('.card').forEach(c => c.onclick = () => openRecipe(c.dataset.id));
  $$('.xcard').forEach(c => c.onclick = () => openExtra(c.dataset.x));
}

function openExtra(id) {
  const x = W.extras.find(e => e.id === id);
  openSheet(`<div class="sheet"><button class="close" style="position:static;float:right" aria-label="${T.close}">✕</button>
    <div class="kicker" style="color:var(--muted)">${T.extras}</div>
    <h2>${esc(x.titel)}</h2>${x.untertitel ? `<p class="sub" style="margin:0">${esc(x.untertitel)}</p>` : ''}
    ${x.haltbar ? `<div class="box ok"><h4>${T.keeps}</h4><p>${esc(x.haltbar)}</p></div>` : ''}
    <h3 style="margin-top:22px">${T.how}</h3>${stepsHtml(x.schritte)}
    <h3 style="margin-top:22px">${T.ingr}</h3>${ingHtml(x.zutaten)}</div>`);
}

function openRecipe(id) {
  const r = W.rezepte.find(x => x.id === id), m = r.makros[portion], P = person(portion);
  const daily = r.zusammenbau?.packen?.length ? packHtml(r) : stepsHtml(r.anrichten);
  const d = openSheet(`
    <div class="sheet-img">${img(r.bild, r.titel)}<button class="close" aria-label="${T.close}">✕</button></div>
    <div class="sheet">
      <div class="kicker" style="color:var(--muted)">${esc(r.slot)} · ${r.portionen}</div>
      <h2>${esc(r.titel)}</h2><p class="sub" style="margin:0">${esc(r.untertitel)}</p>
      ${r.bild ? `<p class="hint">${esc(r.bild_hinweis || T.stock_photo)}</p>` : ''}
      <div class="macro"><div><b>${m.kcal}</b><small>kcal</small></div><div><b>${m.p} g</b><small>${T.protein}</small></div><div><b>${m.kh} g</b><small>${T.carbs}</small></div></div>
      ${r.reihenfolge && !r.zusammenbau?.essen?.length ? `<div class="order">${T.order.map(o => `<span>${o}</span>`).join('<em>→</em>')}</div>` : ''}
      ${parts_(r)}
      ${r.portion?.[portion] ? `<div class="box ok"><h4>${T.your_portion} · ${esc(P.label)}</h4><ul>${r.portion[portion].map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${(W.extras || []).map(x => `<button class="ghost xlink" data-x="${esc(x.id)}">${T.with}: ${esc(x.titel)} ›</button>`).join('')}
      ${r.schritte?.length ? `<h3 style="margin-top:22px">${T.how}</h3>${stepsHtml(r.schritte)}` : ''}
      <div class="box warn"><h4>${T.risk}</h4><p>${esc(r.kipppunkt)}</p></div>
      <h3 style="margin-top:22px">${T.ingr_all(r.portionen)}</h3>${ingHtml(r.zutaten)}
      <h3 style="margin-top:22px">${T.plating}</h3>${daily}
      ${r.rechner ? `<details class="box ok"><summary><h4>${T.calc}</h4></summary>
        <div class="calc"><input id="calcIn" type="number" inputmode="numeric" placeholder="4800"> g ${esc(r.rechner.label)}</div>
        <p style="margin-top:8px">${CFG.persons.map(p => `${esc(p.label)}: <output data-calc="${esc(p.id)}">–</output>`).join(' · ')} <span class="est">${T.calc_each}</span></p></details>` : ''}
    </div>`);
  $$('.xlink', d).forEach(b => b.onclick = () => openExtra(b.dataset.x));
  const ci = $('#calcIn', d);
  if (ci) ci.oninput = () => $$('[data-calc]', d).forEach(o => { const f = r.rechner[o.dataset.calc]; o.textContent = +ci.value && f ? Math.round(ci.value * f) + ' g' : '–' });
}

const key = k => `${k}:${W.id}`;
function shopView() {
  const done = local.get(key('shop'), {});
  let total = 0, open = 0;
  const groups = W.einkauf.map(g => `<div class="panel"><h3>${esc(g.bereich)}</h3>${g.items.map((it, i) => {
    const id = `e-${g.bereich}-${i}`, s = it.anz * it.preis; total += s; if (!done[id]) open += s;
    return `<div class="row ${done[id] ? 'done' : ''}"><input type="checkbox" id="${esc(id)}" data-k="shop" ${done[id] ? 'checked' : ''}>
      <label for="${esc(id)}">${it.anz > 1 ? `<b>${it.anz} ×</b> ` : ''}${esc(it.name)}${it.a ? '<span class="badge">%</span>' : ''}${it.laden ? ` <span class="est">· ${esc(it.laden)}</span>` : ''}</label>
      <span class="price">${it.a ? '' : '<span class="est">~</span>'}${money(s)}</span></div>`;
  }).join('')}</div>`).join('');
  return `<h2>${T.shop_list}</h2>
    <p class="sub">${esc(W.einkaufstag)} · ${T.card_hint} · <span class="est">${T.est}</span></p>
    ${groups}
    ${W.vorrat?.length ? `<div class="panel"><h3>${T.check_pantry}</h3>${W.vorrat.map(v => `<div class="row"><label>${esc(v)}</label></div>`).join('')}</div>` : ''}
    ${W.nicht_kaufen?.length ? `<div class="panel"><h3 style="color:#b23b1e">${T.dont_buy}</h3>${W.nicht_kaufen.map(v => `<div class="row"><label>✕ ${esc(v)}</label></div>`).join('')}</div>` : ''}
    <div class="sumbar"><div><small>${T.open} ${money(open)}</small><br><b>${money(total)}</b> <small>${T.of} ${money(W.budget.limit)}</small></div><button class="ghost" id="reset">${T.reset}</button></div>`;
}

// Recipes and extras share one colour each, in the menu and on every prep step.
const DISH_COLORS = ['#8cc63f', '#e8792b', '#7aa7c7', '#c97a9a', '#b5a36a'];
const dishes = () => [...W.rezepte, ...(W.extras || [])];
function dishTag(id) {
  const all = dishes(), i = all.findIndex(x => x.id === id);
  if (i < 0) return '';
  return `<span class="dish" style="--c:${DISH_COLORS[i % DISH_COLORS.length]}">${esc(all[i].kurz || all[i].titel.split(' ')[0])}</span>`;
}

function prepView() {
  const done = local.get(key('prep'), {});
  const used = new Set(W.prep.map(s => s.gericht).filter(Boolean));
  return `<h2>${T.prep} · ${esc(W.preptag)}</h2><p class="sub">${T.timers_hint}</p>
    ${used.size ? `<div class="dish-legend">${dishes().filter(x => used.has(x.id)).map(x => dishTag(x.id)).join('')}</div>` : ''}
    <div class="panel">${W.prep.map((s, i) => {
      const id = `p-${i}`;
      const label = s.titel ? `<span class="step-h">${dishTag(s.gericht)}<b>${esc(s.titel)}</b></span><span class="step-t">${esc(s.text)}</span>` : esc(s.text);
      return `<div class="row ${s.neben ? 'neben' : ''} ${s.wichtig ? 'wichtig' : ''} ${done[id] ? 'done' : ''}">
        <input type="checkbox" id="${id}" data-k="prep" ${done[id] ? 'checked' : ''}><span class="time">${s.neben ? '↳' : esc(s.t)}</span>
        <label for="${id}">${label}</label>
        ${s.timer ? `<button class="tbtn" data-min="${s.timer}" data-label="${esc(s.titel || s.text.slice(0, 40))}">⏱ ${s.timer}′</button>` : ''}</div>`;
    }).join('')}</div>
    <div class="panel"><h3>${T.equipment}</h3>${W.geraete.map(g => `<div class="row"><label>${esc(g)}</label></div>`).join('')}</div>
    ${containersHtml()}
    <p><button class="ghost" id="resetp">${T.reset_checks}</button></p>`;
}
function bindPrep() { bindChecks(); $$('.tbtn').forEach(b => b.onclick = () => startTimer(+b.dataset.min, b.dataset.label)) }

function bindChecks() {
  // older weeks stored shopping checks under "einkauf"
  if (!localStorage.getItem(key('shop')) && localStorage.getItem(key('einkauf'))) local.set(key('shop'), local.get(key('einkauf'), {}));
  $$('input[data-k]').forEach(cb => cb.onchange = () => {
    const k = key(cb.dataset.k), v = local.get(k, {});
    v[cb.id] = cb.checked; local.set(k, v);
    if (cb.dataset.k === 'shop') return render();
    cb.closest('.row').classList.toggle('done', cb.checked);
  });
  $('#reset') && ($('#reset').onclick = () => { local.set(key('shop'), {}); render() });
  $('#resetp') && ($('#resetp').onclick = () => { local.set(key('prep'), {}); render() });
}

/* ---------------- Daily: every day + special dates ---------------- */
const isoOf = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d) };
function isoFromLabel(label) {  // "So 11.10." → ISO date in the plan's year
  const m = String(label || '').match(/(\d{1,2})\.(\d{1,2})\./);
  if (!m) return null;
  let y = +W.id.slice(0, 4);
  if (+m[2] === 12 && W.id.slice(5, 7) === '01') y -= 1;
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
const dayLabel = iso => { const s = new Date(iso + 'T12:00:00').toLocaleDateString(CFG.language, { weekday: 'long', day: '2-digit', month: '2-digit' }); return s[0].toUpperCase() + s.slice(1) };

// One meal's daily routine: "take this → do that", then how to eat it. Falls back to free-text "anrichten".
function routineCard(r) {
  const z = r.zusammenbau || {};
  const rows = z.packen?.length ? z.packen.map(p => `<div class="pack-row"><b>${esc(p.wo)}</b><span>${esc(p.was)}</span></div>`).join('')
    : (r.anrichten || []).map(s => `<div class="pack-row one"><span>${esc(s)}</span></div>`).join('');
  return `<div class="routine">
    <div class="routine-h"><span class="when">${esc(z.wann || r.slot)}</span>${z.min ? `<span class="mins">${z.min} ${T.min}</span>` : ''}</div>
    <h3>${esc(r.titel)}</h3>
    <div class="pack">${rows}</div>
    ${z.essen?.length ? `<p class="eat"><b>${T.how_eat}:</b> ${z.essen.map(esc).join(' → ')}</p>` : ''}</div>`;
}

function packHtml(r) { return routineCard(r).replace(/<h3>.*?<\/h3>/, '') }
function containersHtml() {
  if (!W.behaelter?.length) return '';
  return `<div class="panel"><h3>${T.containers}</h3>${W.behaelter.map(b => `<div class="box-row"><div class="box-n">${b.anzahl ? esc(b.anzahl) + '×' : ''}</div>
    <div><b>${esc(b.name)}</b> – ${esc(b.inhalt)}${b.hinweis ? `<br><small>${esc(b.hinweis)}</small>` : ''}</div></div>`).join('')}</div>`;
}

function dayView() {
  const done = local.get(key('day'), {}), today = isoOf(new Date());
  const last = addDays(W.id, CFG.days - 1), n = Math.round((new Date(today) - new Date(W.id)) / 864e5) + 1;
  const dates = new Map();
  const add = (iso, it) => { if (!iso) return; dates.has(iso) || dates.set(iso, []); dates.get(iso).push(it) };
  add(isoFromLabel(W.einkaufstag), { link: 'shop', text: T.shop_day, btn: T.shop_link });
  add(isoFromLabel(W.preptag), { link: 'prep', text: T.prep_day, btn: T.prep_link });
  (W.vorbereitung || []).forEach(v => add(v.datum, { text: v.text, wann: v.wann }));
  const termine = [...dates.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `<h2>${T.day_head}</h2>
    ${today >= W.id && today <= last ? `<div class="today-banner">${T.today}: ${T.eat_day(n)} / ${CFG.days}</div>` : ''}
    <div class="slothead"><h2>${T.every_day}</h2><span>${dayLabel(W.id).split(',')[0]} – ${dayLabel(last).split(',')[0]}</span></div>
    <div class="routines">${W.rezepte.map(routineCard).join('')}</div>
    ${W.behaelter?.length ? `<div class="slothead"><h2>${T.containers}</h2><span>${T.containers_sub}</span></div>
      <div class="panel">${W.behaelter.map(b => `<div class="box-row"><div class="box-n">${b.anzahl ? esc(b.anzahl) + '×' : ''}</div>
        <div><b>${esc(b.name)}</b> – ${esc(b.inhalt)}${b.hinweis ? `<br><small>${esc(b.hinweis)}</small>` : ''}</div></div>`).join('')}</div>` : ''}
    <div class="slothead"><h2>${T.dates}</h2></div>
    <div class="panel">${termine.map(([iso, items]) => items.map((it, i) => {
      const id = `${iso}-${i}`;
      return `<div class="row dayrow ${done[id] ? 'done' : ''} ${iso === today ? 'is-today' : ''}">
        ${it.link ? '<span class="dot"></span>' : `<input type="checkbox" id="${id}" data-k="day" ${done[id] ? 'checked' : ''}>`}
        <label for="${id}"><span class="date">${esc(dayLabel(iso))}${it.wann ? ', ' + esc(it.wann) : ''}</span><br>${esc(it.text)}</label>
        ${it.link ? `<button class="ghost" data-goto="${it.link}">${esc(it.btn)} ›</button>` : ''}</div>`;
    }).join('')).join('')}</div>`;
}
function bindDay() {
  bindChecks();
  $$('[data-goto]').forEach(b => b.onclick = () => { tab = b.dataset.goto; local.set('tab', tab); render(); scrollTo({ top: 0 }) });
}

/* ---------------- Feedback ---------------- */
// FB.gerichte[dish][person] = {note, tags[], wieder, kommentar}; FB.fakten = {prep_min, ausgaben, hunger, portion}
const scoreColor = v => v >= 8 ? '#3c8a1f' : v >= 6 ? '#8cc63f' : v >= 4 ? '#e8a23b' : '#d0573a';
function rating(dish, pid) {
  FB.gerichte ||= {};
  const g = FB.gerichte[dish] ||= {};
  if ('note' in g || 'kommentar' in g) {  // older single-rating format → first person
    const old = { note: g.note, kommentar: g.kommentar }; delete g.note; delete g.kommentar;
    g[CFG.persons[0].id] = old;
  }
  return g[pid] ||= {};
}
function fbCount() {
  let n = 0;
  W.rezepte.forEach(r => CFG.persons.forEach(p => { if (FB.gerichte?.[r.id]?.[p.id]?.note) n++ }));
  return n;
}
function fbView() {
  FB.antworten ||= {}; FB.fakten ||= {};
  const P = person(portion), total = W.rezepte.length * CFG.persons.length, n = fbCount(), res = W.feedback_ergebnis;
  const seg = (field, opts, val) => `<div class="seg3" data-fact="${field}">${opts.map(o => `<button aria-pressed="${val === o}">${esc(o)}</button>`).join('')}</div>`;
  return `<h2>${T.fb_head}</h2><p class="sub">${T.fb_sub}</p>
    <div class="progress"><span>${T.fb_progress(n, total)}</span><div class="bar"><i style="width:${n / total * 100}%;background:var(--lime)"></i></div></div>
    ${W.rezepte.map(r => {
      const g = rating(r.id, portion);
      const others = CFG.persons.filter(p => p.id !== portion).map(p => {
        const o = FB.gerichte[r.id]?.[p.id];
        return `${esc(p.label)}: ${o?.note ? o.note + '/10' : '–'}${o?.tags?.length ? ' · ' + o.tags.map(esc).join(', ') : ''}`;
      }).join(' · ');
      return `<div class="fb2" data-dish="${r.id}">
        <div class="head">${r.bild ? `<img src="${r.bild}" alt="">` : placeholder('')}<div><small>${esc(r.slot)}</small><b>${esc(r.titel)}</b>
          <div class="others">${others}</div></div></div>
        <div class="inner">
          <label class="l">${T.fb_rate_as(esc(P.label))} · ${g.note ? g.note + '/10' : T.fb_unrated}</label>
          <div class="score" data-v="${g.note || ''}" style="--c:${scoreColor(g.note || 0)}">
            ${Array.from({ length: 10 }, (_, i) => `<button data-score="${i + 1}" aria-pressed="${g.note === i + 1}">${i + 1}</button>`).join('')}</div>
          <div class="tags" style="margin-top:12px">
            ${T.fb_tags_good.map(x => `<button class="tag good" data-tag="${esc(x)}" aria-pressed="${!!g.tags?.includes(x)}">${esc(x)}</button>`).join('')}
            ${T.fb_tags_bad.map(x => `<button class="tag bad" data-tag="${esc(x)}" aria-pressed="${!!g.tags?.includes(x)}">${esc(x)}</button>`).join('')}</div>
          <label class="l">${T.fb_again}</label>
          <div class="seg3" data-again>${[T.fb_yes, T.fb_maybe, T.fb_no].map(o => `<button aria-pressed="${g.wieder === o}">${esc(o)}</button>`).join('')}</div>
          <textarea data-comment placeholder="${esc(T.fb_ph)}">${esc(g.kommentar || '')}</textarea>
        </div></div>`;
    }).join('')}
    <div class="panel"><h3>${T.fb_week}</h3><div class="facts">
      <div><label>${T.fb_prep_min}</label><input type="number" inputmode="numeric" data-num="prep_min" value="${esc(FB.fakten.prep_min ?? '')}" placeholder="${esc((W.preptag || '').replace(/\D+/g, ' ').trim().split(' ').pop() || '75')}"></div>
      <div><label>${T.fb_spent} (${cur()})</label><input type="number" inputmode="decimal" step="0.01" data-num="ausgaben" value="${esc(FB.fakten.ausgaben ?? '')}" placeholder="${W.budget.summe.toFixed(2)}"></div>
      <div class="full"><label>${T.fb_hunger}</label>${seg('hunger', T.fb_hunger_opts, FB.fakten.hunger)}</div>
      <div class="full"><label>${T.fb_size}</label>${seg('portion', T.fb_size_opts, FB.fakten.portion)}</div>
    </div></div>
    ${(W.feedback || []).length ? `<div class="panel"><h3>${T.fb_q}</h3>${W.feedback.map((f, i) => `<div class="row" style="display:block"><label style="display:block;margin-bottom:6px">${esc(f)}</label><textarea data-fbq="${i}">${esc(FB.antworten[i] || '')}</textarea></div>`).join('')}</div>` : ''}
    <div class="saved" id="fbsaved"></div>
    ${res || W.feedback_antwort ? `<div class="box ok result"><h4>${T.fb_read}</h4><p>${esc(W.feedback_antwort || '')}</p>
      ${res?.bewertungen?.length ? `<h4>${T.fb_rows}</h4><ul>${res.bewertungen.map(b => `<li><b>${esc(b.gericht)}</b> ${esc(b.note)} – ${esc(b.kommentar)}</li>`).join('')}</ul>` : ''}
      ${res?.gesperrt?.length ? `<h4>${T.fb_blocked}</h4><ul>${res.gesperrt.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${res?.regeln?.length ? `<h4>${T.fb_rules}</h4><ul>${res.regeln.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    <div class="actions"><button class="big claude" id="fbRun" ${n ? '' : 'disabled'}><span>${T.fb_btn}<small>${n ? T.fb_btn_sub : T.fb_need}</small></span></button>
    ${!R || R.status === 'geplant' ? `<button class="big plan" id="newRound"><span>${T.btn_new}<small>${T.btn_new_sub}</small></span></button>` : ''}</div>`;
}
function bindFb() {
  const rerender = () => { const y = scrollY; saveFB(); render(); scrollTo(0, y) };
  $$('.fb2').forEach(card => {
    const g = rating(card.dataset.dish, portion);
    $$('[data-score]', card).forEach(b => b.onclick = () => { const v = +b.dataset.score; g.note = g.note === v ? undefined : v; rerender() });
    $$('[data-tag]', card).forEach(b => b.onclick = () => {
      const x = b.dataset.tag; g.tags ||= [];
      g.tags = g.tags.includes(x) ? g.tags.filter(y => y !== x) : [...g.tags, x];
      b.setAttribute('aria-pressed', g.tags.includes(x)); saveFB();
    });
    $$('[data-again] button', card).forEach(b => b.onclick = () => { g.wieder = g.wieder === b.textContent ? undefined : b.textContent; rerender() });
    $('[data-comment]', card).oninput = e => { g.kommentar = e.target.value; saveFB() };
  });
  $$('[data-num]').forEach(i => i.oninput = () => { FB.fakten[i.dataset.num] = i.value === '' ? undefined : +i.value; saveFB() });
  $$('[data-fact]').forEach(s => $$('button', s).forEach(b => b.onclick = () => {
    const f = s.dataset.fact; FB.fakten[f] = FB.fakten[f] === b.textContent ? undefined : b.textContent; rerender();
  }));
  $$('[data-fbq]').forEach(t => t.oninput = () => { FB.antworten[t.dataset.fbq] = t.value; saveFB() });
  $('#fbRun').onclick = () => run('feedback_uebernehmen', W.id);
  $('#newRound') && ($('#newRound').onclick = () => run('neue_runde', ''));
}

/* ---------------- Credits ---------------- */
function creditsHtml() {
  const used = new Set();
  if (W) [W.hero, ...W.rezepte.flatMap(r => [r.bild, ...(r.bausteine || []).map(b => b.bild)])].forEach(x => x && used.add(stripQ(x)));
  if (R && tab === 'pick') R.kandidaten.forEach(k => k.bild && used.add(stripQ(k.bild)));
  const list = Object.entries(credits).filter(([f]) => used.has('img/' + f));
  return list.length ? `<p class="credits">${T.credits}: ${list.map(([, c]) => `<a href="${esc(c.source_url)}" target="_blank" rel="noopener">${esc(c.title)}</a> – ${esc(c.creator || T.unknown)} (${esc(c.license)})`).join(' · ')}</p>` : '';
}

/* ---------------- Timers ---------------- */
const timers = [];
let audio;
function startTimer(min, label) {
  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  timers.push({ end: Date.now() + min * 60000, label, id: Math.random() });
  tick();
}
function beep() {
  if (!audio) return;
  [0, .35, .7].forEach(t => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(.25, audio.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + t + .3);
    o.start(audio.currentTime + t); o.stop(audio.currentTime + t + .3);
  });
  navigator.vibrate?.([300, 150, 300]);
}
function tick() {
  const box = $('#timers');
  box.innerHTML = timers.map(t => {
    const left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
    if (left === 0) t.ringing = true;
    return `<div class="timer ${t.ringing ? 'ring' : ''}"><div><b>${t.ringing ? T.done : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</b><small>${esc(t.label)}</small></div><button data-id="${t.id}">${t.ringing ? 'OK' : '✕'}</button></div>`;
  }).join('');
  $$('button', box).forEach(b => b.onclick = () => { timers.splice(timers.findIndex(t => t.id == b.dataset.id), 1); tick() });
  if (timers.some(t => t.ringing)) beep();
}
setInterval(() => timers.length && tick(), 1000);

init().catch(e => { $('#app').innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>` });
