// 今夜の泊まり先 — 明日の朝の時刻から逆算して、崩れにくい順に候補を並べる
// 保存はこの端末の localStorage だけ。相手には「#s=」付きのリンクで予定と候補を渡す

const KEY = 'tomari.v1';

// 崩れやすさの初期見込み（記録が増えるほど実績に寄る）
const RISK = { low: 0.15, mid: 0.4, high: 0.7 };
const RISK_LABEL = { low: '低い', mid: 'ふつう', high: '高い' };
// 体調の不安を「分」に置き換えた重み
const HEALTH = { none: 0, some: 15, high: 30 };
const HEALTH_LABEL = { none: 'なし', some: '少し', high: 'ある' };
const BODY = { ok: 1, throat: 2, bad: 4 };
const BODY_LABEL = { ok: '普通', throat: '喉が気になる', bad: 'よくない' };
const PRIORITY_LABEL = { time: '朝の時間', health: '体調' };

const DEFAULT = {
  morning: { ready: '09:00', prep: 30, getup: 30, ideal: '06:00', body: 'ok', priority: 'time' },
  candidates: [
    { id: 'a', name: '自分の家', travel: 0, weak: '', risk: 'mid', delay: 60, health: 'none', tips: '', ok: 0, ng: 0 },
    { id: 'b', name: '相手の家', travel: 90, weak: '', risk: 'mid', delay: 90, health: 'none', tips: '', ok: 0, ng: 0 },
    { id: 'c', name: 'ネットカフェ', travel: 30, weak: '', risk: 'low', delay: 30, health: 'some', tips: '', ok: 0, ng: 0 },
  ],
  decided: null, // { at, due, id, name, wake, leave, ready, tips }
};

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { ...clone(DEFAULT), ...s, morning: { ...DEFAULT.morning, ...s.morning } };
    }
  } catch (e) { /* 保存が使えない環境でも初期値で動かす */ }
  return clone(DEFAULT);
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 無視 */ }
}

/* ---------- 時刻 ---------- */

const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmt = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

/* ---------- 計算 ---------- */

function compute() {
  const m = state.morning;
  const ready = toMin(m.ready);
  const ideal = toMin(m.ideal);
  const prep = Number(m.prep) || 0;
  const getup = Number(m.getup) || 0;

  const rows = state.candidates.map((c) => {
    const travel = Number(c.travel) || 0;
    const leave = ready - prep - travel;         // 出発・解散
    const wake = leave - getup;                   // 遅くともこの時刻に起きる
    const earliest = ideal + getup + travel + prep; // 理想どおり起きたときの準備完了
    const ok = Number(c.ok) || 0;
    const ng = Number(c.ng) || 0;
    const pFail = (ng + 2 * (RISK[c.risk] ?? RISK.mid)) / (ok + ng + 2);
    const expDelay = pFail * (Number(c.delay) || 0);
    const health = (HEALTH[c.health] ?? 0) * (BODY[m.body] ?? 1) * (m.priority === 'health' ? 3 : 1);
    return { c, leave, wake, earliest, pFail, expDelay, health, needEarly: wake < ideal };
  });

  const best = Math.min(...rows.map((r) => r.earliest));
  rows.forEach((r) => {
    r.offset = (r.earliest - best) * 0.5;
    r.loss = r.offset + r.expDelay + r.health;
  });
  rows.sort((a, b) => a.loss - b.loss);
  return { rows, ready, ideal, prep, getup };
}

/* ---------- 明日の朝 ---------- */

function renderMorning() {
  const m = state.morning;
  $('#m-ready').value = m.ready;
  $('#m-prep').value = m.prep;
  $('#m-getup').value = m.getup;
  $('#m-ideal').value = m.ideal;
  seg('#m-body', BODY_LABEL, m.body, (v) => { m.body = v; });
  seg('#m-priority', PRIORITY_LABEL, m.priority, (v) => { m.priority = v; });
}

function seg(sel, labels, current, onPick) {
  const box = $(sel);
  box.innerHTML = Object.entries(labels)
    .map(([k, v]) => `<button type="button" data-v="${k}" aria-pressed="${k === current}">${v}</button>`)
    .join('');
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    onPick(b.dataset.v);
    box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    save();
    renderRanking();
  };
}

[['#m-ready', 'ready'], ['#m-ideal', 'ideal'], ['#m-prep', 'prep'], ['#m-getup', 'getup']].forEach(([sel, key]) => {
  $(sel).addEventListener('input', (e) => {
    state.morning[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    save();
    renderRanking();
  });
});

/* ---------- おすすめ順 ---------- */

function renderRanking() {
  const { rows, ready, ideal } = compute();
  if (!rows.length) {
    $('#ranking').innerHTML = '<li class="row"><p class="weak">候補がありません。下の「候補を足す」から入れてください。</p></li>';
    return;
  }

  // タイムラインの表示範囲：いちばん早い起床（か理想の起床）の少し前から、準備完了の少し後まで
  const start = Math.floor((Math.min(ideal, ...rows.map((r) => r.wake)) - 15) / 60) * 60;
  const end = Math.ceil((ready + 15) / 60) * 60;
  const pct = (t) => ((t - start) / (end - start)) * 100;
  const ticks = [];
  for (let t = start; t <= end; t += 60) {
    // 両端の目盛りははみ出さないよう内側に寄せる
    const shift = t === start ? '0' : t === end ? '-100%' : '-50%';
    ticks.push(`<span class="tl-tick" style="left:${pct(t)}%;transform:translateX(${shift})">${fmt(t)}</span>`);
  }

  const legend = `<li class="legend" aria-hidden="true"><span><i style="background:var(--seg-getup)"></i>身支度</span><span><i style="background:var(--seg-move)"></i>移動</span><span><i style="background:var(--moon)"></i>準備</span><span><i class="dot" style="background:var(--pink)"></i>理想の起床</span></li>`;

  $('#ranking').innerHTML = legend + rows.map((r, i) => {
    const c = r.c;
    const arrive = r.leave + (Number(c.travel) || 0);
    const why = [
      `崩れる見込み ${Math.round(r.pFail * 100)}%・崩れたら +${Number(c.delay) || 0}分`,
      r.health ? `体調の不安 +${Math.round(r.health)}` : '',
      (Number(c.ok) + Number(c.ng)) ? `記録 守れた${c.ok}・守れなかった${c.ng}` : '',
    ].filter(Boolean).join('　');
    return `
      <li class="row${i === 0 ? ' top' : ''}">
        <div class="row-head">
          <span class="icon" aria-hidden="true">${iconFor(c.name)}</span>
          <span class="name-wrap">
            ${i === 0 ? '<span class="badge">いちばんおすすめ</span>' : `<span class="rank-no">${i + 1}番目</span>`}
            <span class="name">${esc(c.name) || '（名前なし）'}</span>
          </span>
          <button type="button" class="pick" data-id="${esc(c.id)}">これにする</button>
        </div>
        <div class="times">
          <div class="${r.needEarly ? 'warn' : ''}"><em>遅くとも起床</em><b>${fmt(r.wake)}</b></div>
          <div><em>${Number(c.travel) ? '出発・解散' : '解散'}</em><b>${fmt(r.leave)}</b></div>
          <div><em>最速の準備完了</em><b>${fmt(r.earliest)}</b></div>
        </div>
        <div class="tl" aria-hidden="true">
          <div class="tl-track"></div>
          <div class="tl-seg getup" style="left:${pct(r.wake)}%;width:${pct(r.leave) - pct(r.wake)}%"></div>
          <div class="tl-seg move" style="left:${pct(r.leave)}%;width:${pct(arrive) - pct(r.leave)}%"></div>
          <div class="tl-seg prep" style="left:${pct(arrive)}%;width:${pct(ready) - pct(arrive)}%"></div>
          <div class="tl-ideal" style="left:${pct(ideal)}%"></div>
          ${ticks.join('')}
        </div>
        ${c.weak ? `<p class="weak">崩れるところ：${esc(c.weak)}</p>` : ''}
        <p class="why">${why}${r.needEarly ? '　<span class="warn">理想より早起きが必要</span>' : ''}</p>
      </li>`;
  }).join('');
}

// 名前から小さなアイコンを選ぶ（家／カフェ・漫画喫茶／それ以外はまくら）
const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5V19h12V9.5"/><path d="M10 19v-5h4v5"/></svg>',
  cafe: '<svg viewBox="0 0 24 24"><path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M9 3.5c-.8 1 .8 2-.1 3M12.5 3.5c-.8 1 .8 2-.1 3"/></svg>',
  pillow: '<svg viewBox="0 0 24 24"><path d="M4 8c3-1.5 13-1.5 16 0 1 3 1 5 0 8-3 1.5-13 1.5-16 0-1-3-1-5 0-8z"/><path d="M8 12h.01M16 12h.01"/></svg>',
};
function iconFor(name) {
  const n = String(name || '');
  // 「漫画喫茶（家の近く）」を家にしないよう、カフェ類を先に見る
  if (/カフェ|喫茶|漫|ネカフェ|ホテル/.test(n)) return ICONS.cafe;
  if (/家|宅|うち|ホーム/.test(n)) return ICONS.home;
  return ICONS.pillow;
}

$('#ranking').addEventListener('click', (e) => {
  const b = e.target.closest('.pick');
  if (!b) return;
  decide(b.dataset.id);
});

/* ---------- 決める・共有する ---------- */

function decide(id) {
  const { rows, ready } = compute();
  const r = rows.find((x) => x.c.id === id);
  if (!r) return;
  // 朝の結果を聞くのは、次に来る「準備を終えたい時刻」を過ぎてから
  const now = new Date();
  const due = new Date(now);
  due.setHours(Math.floor(ready / 60), ready % 60, 0, 0);
  if (due <= now) due.setDate(due.getDate() + 1);

  // 早いほどいいので、間に合うなら理想の起床から組む。「遅くとも」は添え書きに残す
  const m = state.morning;
  const ideal = toMin(m.ideal);
  const useIdeal = ideal <= r.wake;
  const wake = useIdeal ? ideal : r.wake;
  const leave = useIdeal ? ideal + (Number(m.getup) || 0) : r.leave;
  const doneAt = useIdeal ? r.earliest : ready;

  state.decided = {
    at: now.getTime(),
    due: due.getTime(),
    id: r.c.id,
    name: r.c.name,
    wake: fmt(wake),
    leave: fmt(leave),
    ready: fmt(doneAt),
    latest: useIdeal && r.wake > ideal ? `遅くとも ${fmt(r.wake)} 起床・${fmt(r.leave)} ${r.c.travel ? '出発' : '解散'}なら ${fmt(ready)} に間に合う` : '',
    deadline: fmt(ready),
    travel: Number(r.c.travel) || 0,
    tips: tipsOf(r.c),
  };
  save();
  renderDecided();
  $('#decided').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const tipsOf = (c) => String(c.tips || '').split('\n').map((s) => s.trim()).filter(Boolean);

function planCard(p, kicker) {
  return `
    <div class="plan-card">
      <p class="plan-kicker">${esc(kicker)}</p>
      <p class="plan-name">${esc(p.name)}</p>
      <div class="plan-times">
        <div><em>起床</em><b>${esc(p.wake)}</b></div>
        <div><em>${p.travel ? '出発・解散' : '解散'}</em><b>${esc(p.leave)}</b></div>
        <div><em>準備完了</em><b>${esc(p.ready)}</b></div>
      </div>
      ${p.latest ? `<p class="plan-latest">${esc(p.latest)}</p>` : ''}
      ${p.tips && p.tips.length ? `<ul class="plan-tips">${p.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="actions" data-slot></div>
    </div>`;
}

function renderDecided() {
  const d = state.decided;
  const box = $('#decided');
  if (!d || recordDue()) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h2>決めた予定</h2>${planCard(d, '今夜は')}`;
  box.querySelector('[data-slot]').innerHTML = `
    <button type="button" class="primary" data-act="share">相手に送る</button>
    <button type="button" class="ghost" data-act="copy">リンクをコピー</button>
    <button type="button" class="ghost" data-act="cancel">取り消す</button>`;
  box.querySelector('[data-slot]').onclick = async (e) => {
    const act = e.target.dataset.act;
    if (act === 'share') share(d);
    if (act === 'copy') copy(shareUrl(d), 'リンクをコピーしました');
    if (act === 'cancel') { state.decided = null; save(); renderDecided(); }
  };
}

function shareText(d) {
  const lines = [`今夜は ${d.name}`, `${d.wake} 起床／${d.leave} ${d.travel ? '出発・解散' : '解散'}／${d.ready} 準備完了`];
  if (d.latest) lines.push(`（${d.latest}）`);
  if (d.tips.length) lines.push('', ...d.tips.map((t) => `・${t}`));
  return lines.join('\n');
}

// 予定と候補を #s= に詰める（# の後ろはサーバーに送られない）
function shareUrl(d) {
  const payload = { v: 1, plan: d, morning: state.morning, candidates: state.candidates };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#s=${b64}`;
}

function readShared() {
  const m = location.hash.match(/^#s=([\w-]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return data && data.v === 1 && data.plan ? data : null;
  } catch (e) { return null; }
}

async function share(d) {
  const url = shareUrl(d);
  const text = shareText(d);
  if (navigator.share) {
    try { await navigator.share({ title: '今夜の泊まり先', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(`${text}\n${url}`, '予定とリンクをコピーしました');
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* 無視 */ }
    ta.remove();
  }
  toast(msg);
}

function renderShared() {
  const data = readShared();
  const box = $('#shared');
  if (!data) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = planCard(data.plan, '送られてきた予定');
  box.querySelector('[data-slot]').innerHTML = `
    <button type="button" class="ghost" data-act="import">この候補を自分の画面にも入れる</button>
    <button type="button" class="ghost" data-act="close">閉じる</button>`;
  box.querySelector('[data-slot]').onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'import') {
      if (!confirm('いまの候補と朝の設定を、送られてきた内容で置き換えます。よいですか？')) return;
      state.morning = { ...DEFAULT.morning, ...data.morning };
      state.candidates = Array.isArray(data.candidates) ? data.candidates : state.candidates;
      save();
      renderAll();
      toast('候補を入れました');
    }
    if (act === 'close' || act === 'import') {
      history.replaceState(null, '', location.pathname);
      box.hidden = true;
    }
  };
}

/* ---------- 朝の結果の記録 ---------- */

const recordDue = () => !!(state.decided && Date.now() >= state.decided.due);

function renderRecord() {
  const box = $('#record');
  const d = state.decided;
  if (!recordDue()) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `
    <h2>けさの記録</h2>
    <div class="plan-card">
      <p class="plan-kicker">ゆうべは</p>
      <p class="plan-name">${esc(d.name)}</p>
      <p class="plan-ask">${esc(d.deadline || d.ready)} までに準備を終えられましたか？</p>
      <div class="actions">
        <button type="button" class="primary" data-act="ok">守れた</button>
        <button type="button" class="ghost" data-act="ng">守れなかった</button>
        <button type="button" class="ghost" data-act="skip">記録しない</button>
      </div>
    </div>`;
  box.querySelector('.actions').onclick = (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const c = state.candidates.find((x) => x.id === d.id);
    if (c && act === 'ok') c.ok = (Number(c.ok) || 0) + 1;
    if (c && act === 'ng') c.ng = (Number(c.ng) || 0) + 1;
    state.decided = null;
    save();
    renderAll();
    if (act !== 'skip') toast('記録しました');
  };
}

/* ---------- 候補の編集 ---------- */

function opts(labels, current) {
  return Object.entries(labels).map(([k, v]) => `<option value="${k}"${k === current ? ' selected' : ''}>${v}</option>`).join('');
}

function renderCands() {
  $('#cands').innerHTML = state.candidates.map((c) => `
    <div class="cand" data-id="${esc(c.id)}">
      <div class="cand-head">
        <input type="text" data-k="name" value="${esc(c.name)}" placeholder="候補の名前" aria-label="候補の名前">
        <button type="button" class="cand-del" data-act="del">外す</button>
      </div>
      <div class="cand-grid">
        <label class="field"><span>移動</span><span class="unit"><input type="number" data-k="travel" value="${esc(c.travel)}" min="0" step="5" inputmode="numeric">分</span></label>
        <label class="field"><span>崩れたら遅れる</span><span class="unit"><input type="number" data-k="delay" value="${esc(c.delay)}" min="0" step="10" inputmode="numeric">分</span></label>
        <label class="field"><span>崩れやすさ</span><select data-k="risk">${opts(RISK_LABEL, c.risk)}</select></label>
        <label class="field"><span>体調の不安</span><select data-k="health">${opts(HEALTH_LABEL, c.health)}</select></label>
        <label class="field wide"><span>崩れるところ</span><input type="text" data-k="weak" value="${esc(c.weak)}" placeholder="例：朝ベッドから起き上がれない"></label>
        <label class="field wide"><span>対策（1行に1つ）</span><textarea data-k="tips" placeholder="例：前の晩に解散の時刻を決めておく">${esc(c.tips)}</textarea></label>
        <div class="field wide"><span>これまでの記録</span>
          <span class="counts">
            <span class="unit">守れた<input type="number" data-k="ok" value="${esc(c.ok)}" min="0" inputmode="numeric">回</span>
            <span class="unit">守れなかった<input type="number" data-k="ng" value="${esc(c.ng)}" min="0" inputmode="numeric">回</span>
          </span>
        </div>
      </div>
    </div>`).join('');
}

$('#cands').addEventListener('input', (e) => {
  const el = e.target;
  const k = el.dataset.k;
  const id = el.closest('.cand')?.dataset.id;
  const c = state.candidates.find((x) => x.id === id);
  if (!c || !k) return;
  c[k] = el.type === 'number' ? Number(el.value) : el.value;
  save();
  renderRanking();
});

$('#cands').addEventListener('click', (e) => {
  if (e.target.dataset.act !== 'del') return;
  const id = e.target.closest('.cand').dataset.id;
  const c = state.candidates.find((x) => x.id === id);
  if (!confirm(`「${c?.name || '名前なし'}」を候補から外しますか？`)) return;
  state.candidates = state.candidates.filter((x) => x.id !== id);
  save();
  renderCands();
  renderRanking();
});

$('#add').addEventListener('click', () => {
  state.candidates.push({ id: Date.now().toString(36), name: '', travel: 30, weak: '', risk: 'mid', delay: 60, health: 'none', tips: '', ok: 0, ng: 0 });
  save();
  renderCands();
  renderRanking();
  $('#cands .cand:last-child input').focus();
});

/* ---------- その他 ---------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

function renderAll() {
  renderShared();
  renderRecord();
  renderMorning();
  renderRanking();
  renderDecided();
  renderCands();
}

window.addEventListener('hashchange', renderShared);
renderAll();
