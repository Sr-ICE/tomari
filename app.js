// 今夜の泊まり先 — ふたりがそれぞれ自分の質問に答えて、明日の朝から逆算した「崩れにくい泊まり先」を当てる
// 保存はこの端末の localStorage だけ。答え・予定・設定は「#s=」付きのリンクで送り合う

const KEY = 'tomari.v2';
const OLD_KEY = 'tomari.v1';
const FRESH_MS = 16 * 60 * 60 * 1000; // これより古い相手の答えは「今夜の分」とみなさない

// 崩れやすさの初期見込み（記録が増えるほど実績に寄る）
const RISK = { low: 0.15, mid: 0.4, high: 0.7 };
const RISK_LABEL = { low: '低い', mid: 'ふつう', high: '高い' };
// 体調の不安を「分」に置き換えた重み
const HEALTH = { none: 0, some: 15, high: 30 };
const HEALTH_LABEL = { none: 'なし', some: '少し', high: 'ある' };
const BODY = { good: 0.5, ok: 1, throat: 2, bad: 4 };
const COLD = { cold: 1.5, normal: 1, warm: 0.6 };
const CAFE = { ok: 1, meh: 1.6, ng: 2.5 };
// 相手の移動1分あたりの重みと、翌朝の予定による倍率
const MOVE = { fine: 0.05, some: 0.15, lot: 0.35 };
const PMORNING = { none: 1, am: 1.5, early: 2.5 };

const DEFAULT = {
  role: '', // この端末を使っている人：'self'（撮影する人）／'partner'
  morning: { ready: '09:00', prep: 30, getup: 30, ideal: '06:00', priority: 'time', meet: '' },
  places: { selfName: '撮影する人', base: '', baseWalk: 10, partnerName: '相手', partner: '', partnerWalk: 10, buffer: 10 },
  times: {},
  answers: { self: {}, partner: {} },
  candidates: [
    { id: 'a', name: '撮影する人の家', kind: 'base', station: '', walk: 0, weak: '', risk: 'mid', delay: 60, health: 'none', tips: '', ok: 0, ng: 0 },
    { id: 'b', name: '相手の家', kind: 'partner', station: '', walk: 0, weak: '', risk: 'mid', delay: 90, health: 'none', tips: '', ok: 0, ng: 0 },
    { id: 'c', name: 'ネットカフェ', kind: 'other', station: '', walk: 5, weak: '', risk: 'low', delay: 30, health: 'some', tips: '', ok: 0, ng: 0 },
  ],
  decided: null,
};

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number(v) || 0;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let state = load();

function merge(s) {
  const a = s.answers || {};
  return {
    ...clone(DEFAULT), ...s,
    morning: { ...DEFAULT.morning, ...(s.morning || {}) },
    places: { ...DEFAULT.places, ...(s.places || {}) },
    answers: { self: { ...(a.self || {}) }, partner: { ...(a.partner || {}) } },
    times: { ...(s.times || {}) },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(JSON.parse(raw));
    // v1（駅なし）からの引き継ぎ：候補は「そのほか」にして、入っていた移動時間を手入力値として残す
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const o = JSON.parse(old);
      const s = merge({ morning: o.morning });
      if (Array.isArray(o.candidates)) s.candidates = o.candidates.map((c) => ({ kind: 'other', station: '', walk: 0, ...c }));
      return s;
    }
  } catch (e) { /* 保存が使えない環境でも初期値で動かす */ }
  return clone(DEFAULT);
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 無視 */ }
}

/* ---------- 名前・役割 ---------- */

const selfName = () => state.places.selfName || '撮影する人';
const partnerName = () => state.places.partnerName || '相手';
const nameOf = (role) => (role === 'self' ? selfName() : partnerName());
const otherRole = (role) => (role === 'self' ? 'partner' : 'self');
const isFresh = (ans) => !!(ans && ans.at && Date.now() - ans.at < FRESH_MS);
// 計算に使う答え（古い答えは使わない）
const ans = (role) => (isFresh(state.answers[role]) || role === state.role ? state.answers[role] : {});

/* ---------- 時刻 ---------- */

const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmt = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

/* ---------- 駅と移動時間 ---------- */

const pairKey = (a, b) => [a, b].sort().join('⇄');

// 駅から駅の電車の時間。同じ駅は0、未入力は null
function train(a, b) {
  if (!a || !b) return null;
  if (a === b) return 0;
  const v = state.times[pairKey(a, b)];
  return v === '' || v == null ? null : num(v);
}

function stationOf(c) {
  if (c.kind === 'base') return state.places.base;
  if (c.kind === 'partner') return state.places.partner;
  return c.station;
}

// 泊まり先の建物から最寄り駅までの徒歩
function walkOf(c) {
  if (c.kind === 'base') return num(state.places.baseWalk);
  if (c.kind === 'partner') return num(state.places.partnerWalk);
  return num(c.walk);
}

// 朝：泊まり先 → 撮影場所
function morningTravel(c) {
  if (c.kind === 'base') return { total: 0, train: 0 };
  const p = state.places;
  const t = train(stationOf(c), p.base);
  if (t == null) {
    // 駅が入っていない古い候補は、手入力の移動時間を使う
    if (!stationOf(c) && c.travel != null) return { total: num(c.travel), train: null };
    return null;
  }
  return { total: t + walkOf(c) + num(p.baseWalk) + (t ? num(p.buffer) : 0), train: t };
}

// 相手：泊まり先 ⇄ 相手の家（片道）
function partnerTravel(c) {
  if (c.kind === 'partner') return 0;
  const p = state.places;
  const t = train(p.partner, stationOf(c));
  if (t == null) return null;
  return t + num(p.partnerWalk) + walkOf(c) + (t ? num(p.buffer) : 0);
}

// 今夜：合流する駅 → 泊まり先
function nightTravel(c) {
  const meet = state.morning.meet;
  if (!meet) return 0;
  const t = train(meet, stationOf(c));
  if (t == null) return null;
  return t + walkOf(c) + (t ? num(state.places.buffer) : 0);
}

// 画面に出すべき駅の組み合わせ（撮影場所・相手・合流・候補の駅どうし）
function neededPairs() {
  const p = state.places;
  const others = [...new Set(state.candidates.filter((c) => c.kind === 'other' && c.station).map((c) => c.station))];
  const pairs = [];
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    const k = pairKey(a, b);
    if (!pairs.some((x) => x.k === k)) pairs.push({ k, a, b });
  };
  add(p.base, p.partner);
  others.forEach((s) => { add(s, p.base); add(s, p.partner); });
  if (state.morning.meet) [p.base, p.partner, ...others].forEach((s) => add(state.morning.meet, s));
  return pairs;
}

function knownStations() {
  const p = state.places;
  return [...new Set([p.base, p.partner, ...state.candidates.map((c) => c.station)].filter(Boolean))];
}

/* ---------- 計算 ---------- */

function riskAdj(c) {
  const s = ans('self');
  const p = ans('partner');
  if (c.kind === 'base') {
    // 撮影する人の家：相手が朝に帰れるかは、相手本人の答えで見る。朝に予定があれば帰りやすい
    const promise = { sure: -0.25, try: -0.05, hard: 0.15 }[p.promise] ?? 0;
    const busy = p.morning === 'am' || p.morning === 'early' ? -0.1 : 0;
    return promise + busy;
  }
  if (c.kind === 'partner') return { sure: -0.25, maybe: 0, no: 0.15 }[s.wake] ?? 0;
  return 0;
}

function compute() {
  const m = state.morning;
  const s = ans('self');
  const p = ans('partner');
  const ready = toMin(m.ready);
  const ideal = toMin(m.ideal);
  const prep = num(m.prep);
  const getup = num(m.getup);
  const body = Math.max(BODY[s.body] ?? 1, BODY[p.body] ?? 1);
  const cafe = Math.max(CAFE[s.cafe] ?? 1, CAFE[p.cafe] ?? 1);
  const burdenW = (MOVE[p.move] ?? MOVE.some) * (PMORNING[p.morning] ?? 1);

  const rows = state.candidates.map((c) => {
    const mt = morningTravel(c);
    const pt = partnerTravel(c);
    const nt = nightTravel(c);
    const missing = mt == null;
    const travel = mt ? mt.total : 0;
    const leave = ready - prep - travel;          // 出発・解散
    const wake = leave - getup;                    // 遅くともこの時刻に起きる
    const earliest = ideal + getup + travel + prep; // 理想どおり起きたときの準備完了
    const ok = num(c.ok);
    const ng = num(c.ng);
    const prior = clamp((RISK[c.risk] ?? RISK.mid) + riskAdj(c), 0.05, 0.95);
    const pFail = (ng + 2 * prior) / (ok + ng + 2);
    const expDelay = pFail * num(c.delay);
    const health = (HEALTH[c.health] ?? 0) * body * (COLD[s.cold] ?? 1) * (c.kind === 'other' ? cafe : 1) * (m.priority === 'health' ? 3 : 1);
    // 相手は「今夜こっちへ来る」と「朝帰る」の2回動く。合流が決まっていれば今夜の分はふたり一緒の移動
    const partnerNight = c.kind === 'partner' ? 0 : (m.meet ? (nt ?? 0) : (pt ?? 0));
    const partnerTotal = c.kind === 'partner' ? (nt ?? 0) : partnerNight + (pt ?? 0);
    const burden = partnerTotal * burdenW;
    const night = (nt ?? 0) * 0.2;
    return { c, mt, pt, nt, missing, travel, leave, wake, earliest, pFail, expDelay, health, burden, night, partnerTotal, needEarly: wake < ideal };
  });

  const valid = rows.filter((r) => !r.missing);
  const best = valid.length ? Math.min(...valid.map((r) => r.earliest)) : 0;
  rows.forEach((r) => {
    r.offset = (r.earliest - best) * 0.5;
    r.loss = r.missing ? Infinity : r.offset + r.expDelay + r.health + r.burden + r.night;
  });
  rows.sort((a, b) => a.loss - b.loss);
  return { rows, ready, ideal, prep, getup };
}

/* ---------- 質問（秋ネーター風・ふたり別々） ---------- */

const hasKind = (k) => state.candidates.some((c) => c.kind === k);
const hasCafe = () => state.candidates.some((c) => c.kind === 'other' && c.health !== 'none');
const timeOpts = (list) => list.map((v) => ({ v, label: fmt(toMin(v)) }));
const BODY_OPTS = [
  { v: 'good', label: '元気' },
  { v: 'ok', label: '普通' },
  { v: 'throat', label: '喉や頭が気になる' },
  { v: 'bad', label: 'よくない' },
];
const CAFE_OPTS = [
  { v: 'ok', label: '平気' },
  { v: 'meh', label: 'ちょっと苦手' },
  { v: 'ng', label: 'できれば避けたい' },
];
// 答えの置き場所：answers[role][key]。撮影の時刻など設定に効くものは morning に書く
const putAns = (role, key) => ({
  get: () => state.answers[role][key],
  set: (v) => { state.answers[role][key] = v; },
});
const putMorning = (key) => ({
  get: () => state.morning[key],
  set: (v) => { state.morning[key] = v; },
});

const QUESTIONS = {
  self: [
    { id: 'ready', ask: () => '明日は何時までに、撮影の準備を終えたい？', options: () => timeOpts(['08:00', '08:30', '09:00', '09:30', '10:00']), ...putMorning('ready') },
    { id: 'ideal', ask: () => 'ほんとは何時に起きたい？', note: () => '早く撮れるほどいい、の目安にします', options: () => timeOpts(['05:30', '06:00', '06:30', '07:00', '07:30']), ...putMorning('ideal') },
    { id: 'body', ask: () => 'いまの体調は？', options: () => BODY_OPTS, ...putAns('self', 'body') },
    { id: 'cold', skip: () => !hasCafe(), ask: () => '今夜は冷えそう？', options: () => [{ v: 'cold', label: '冷えそう' }, { v: 'normal', label: 'ふつう' }, { v: 'warm', label: 'あたたかい' }], ...putAns('self', 'cold') },
    { id: 'cafe', skip: () => !hasCafe(), ask: () => '漫画喫茶みたいな所で寝るのは平気？', options: () => CAFE_OPTS, ...putAns('self', 'cafe') },
    {
      id: 'wake', skip: () => !hasKind('partner'),
      ask: () => `${partnerName()}の家だったら、朝ちゃんとベッドから出られそう？`,
      options: () => [{ v: 'sure', label: '出られる' }, { v: 'maybe', label: 'たぶん' }, { v: 'no', label: '無理かも' }],
      ...putAns('self', 'wake'),
    },
    {
      id: 'meet', ask: () => `今夜、${partnerName()}と合流するのはどの駅のあたり？`,
      options: () => [...knownStations().map((v) => ({ v, label: v })), { v: '', label: 'まだ決めてない' }],
      ...putMorning('meet'),
    },
    { id: 'priority', ask: () => '最後に。いちばん守りたいのは？', options: () => [{ v: 'time', label: '朝の時間' }, { v: 'health', label: '体調' }], ...putMorning('priority') },
  ],
  partner: [
    { id: 'body', ask: () => 'いまの体調は？', options: () => BODY_OPTS, ...putAns('partner', 'body') },
    {
      id: 'morning', ask: () => '明日の朝、予定はある？',
      options: () => [{ v: 'none', label: 'ない' }, { v: 'am', label: '午前中にある' }, { v: 'early', label: '朝早くにある' }],
      ...putAns('partner', 'morning'),
    },
    {
      id: 'promise', skip: () => !hasKind('base'),
      ask: () => {
        const m = state.morning;
        return `${selfName()}の家に泊まるなら、明日の朝${fmt(toMin(m.ideal) + num(m.getup))}に帰れる？`;
      },
      note: () => `${selfName()}は、そのあとすぐ撮影の準備に入ります`,
      options: () => [{ v: 'sure', label: '帰れる' }, { v: 'try', label: 'がんばれば' }, { v: 'hard', label: '正直むずかしい' }],
      ...putAns('partner', 'promise'),
    },
    {
      id: 'move', ask: () => '移動はどのくらいまでなら平気？',
      note: () => '今夜と明日の朝の、片道の目安',
      options: () => [{ v: 'fine', label: '1時間以上でも平気' }, { v: 'some', label: '30分くらいまで' }, { v: 'lot', label: 'なるべく動きたくない' }],
      ...putAns('partner', 'move'),
    },
    { id: 'cafe', skip: () => !hasCafe(), ask: () => '漫画喫茶みたいな所で寝るのは平気？', options: () => CAFE_OPTS, ...putAns('partner', 'cafe') },
  ],
};

// quiz.step: -1=はじめ / 0..=質問の番号 / 'done'=答え終わり
const quiz = { step: -1, preview: false };

const myQuestions = () => (QUESTIONS[state.role] || []).filter((q) => !(q.skip && q.skip()));
const otherReady = () => state.role && isFresh(state.answers[otherRole(state.role)]);

// 吹き出しの主（月）。考え中は目を閉じ、答えのときは目がひらく
const moonSvg = (awake) => `
  <svg class="moon quiz-moon${awake ? ' awake' : ''}" viewBox="0 0 52 52" aria-hidden="true">
    <path class="body" d="M33 6a21 21 0 1 0 13 33A18 18 0 0 1 33 6z"/>
    ${awake
      ? '<circle class="eye" cx="19.5" cy="27" r="1.9"/><circle class="eye" cx="29.5" cy="30" r="1.9"/><path class="face" d="M21 35q3 2.6 6 0"/>'
      : '<path class="face" d="M17 27q2.5 2.5 5 0M27 30q2.5 2.5 5 0M22 35q2 1.6 4 0"/>'}
    <circle class="cheek" cx="15.5" cy="32" r="2.2"/>
    <circle class="cheek" cx="33" cy="35" r="2.2"/>
  </svg>`;

const bubble = (text, awake, kicker) => `
  <div class="bubble-wrap">
    ${moonSvg(awake)}
    ${kicker ? `<p class="q-no">${esc(kicker)}</p>` : ''}
    <p class="bubble">${text}</p>
  </div>`;

function renderQuiz() {
  const box = $('#quiz');
  renderQuizBody(box);
  // 答えが出るまでは「ぜんぶの候補」を隠す（中で step が 'done' に変わることがあるので最後に見る）
  $('#all').hidden = !(quiz.step === 'done' && (otherReady() || quiz.preview));
}

function renderQuizBody(box) {

  // この端末を誰が使っているか、まだ決まっていない
  if (!state.role) {
    box.innerHTML = `
      ${bubble('こんばんは。<br>この画面を使っているのはどっち？', false)}
      <div class="answers">
        <button type="button" class="answer" data-role="self">${esc(selfName())}</button>
        <button type="button" class="answer" data-role="partner">${esc(partnerName())}</button>
      </div>`;
    box.querySelector('.answers').onclick = (e) => {
      const b = e.target.closest('[data-role]');
      if (!b) return;
      state.role = b.dataset.role;
      save();
      renderAll();
    };
    return;
  }

  const me = nameOf(state.role);
  const other = nameOf(otherRole(state.role));
  const qs = myQuestions();

  if (quiz.step === -1) {
    const mineDone = isFresh(state.answers[state.role]);
    const got = otherReady() ? `<br>${esc(other)}の答えは、もう届いてるよ。` : '';
    // 今夜の分をもう答えていれば、結果か「送る」へすぐ行けるようにする
    const next = mineDone ? `<button type="button" class="ghost" data-act="resume">${otherReady() ? '結果を見る' : `${esc(other)}に答えを送る`}</button>` : '';
    box.innerHTML = `
      ${bubble(`${esc(me)}への質問だよ。<br>答えたら、${esc(other)}に送ってね。${got}`, false)}
      <div class="actions center">
        <button type="button" class="primary big" data-act="start">${mineDone ? '答えなおす' : 'はじめる'}</button>
        ${next}
      </div>
      <div class="quiz-foot center"><button type="button" class="link" data-act="swap">${esc(other)}として使う</button></div>`;
    box.querySelector('.actions').onclick = (e) => {
      const act = e.target.dataset.act;
      if (act === 'start') { quiz.step = 0; quiz.preview = false; renderQuiz(); }
      if (act === 'resume') { if (otherReady()) { quiz.step = 'done'; renderQuiz(); } else sendAnswers(); }
    };
    box.querySelector('[data-act="swap"]').onclick = () => { state.role = otherRole(state.role); quiz.step = -1; save(); renderAll(); };
    return;
  }

  if (quiz.step === 'done' || quiz.step >= qs.length) {
    quiz.step = 'done';
    // 自分の答えに時刻を残す（相手の画面で「今夜の分」かを見分ける）
    if (!state.answers[state.role].at) { state.answers[state.role].at = Date.now(); save(); }
    if (otherReady() || quiz.preview) renderAnswer(box);
    else renderWaiting(box);
    return;
  }

  const q = qs[quiz.step];
  const cur = q.get();
  const dots = qs.map((_, i) => `<i class="${i < quiz.step ? 'done' : i === quiz.step ? 'now' : ''}"></i>`).join('');
  box.innerHTML = `
    <div class="progress" aria-label="${quiz.step + 1} / ${qs.length}">${dots}</div>
    ${bubble(esc(q.ask()), false, `${me}への しつもん ${quiz.step + 1}`)}
    ${q.note ? `<p class="q-note">${esc(q.note())}</p>` : ''}
    <div class="answers">
      ${q.options().map((o) => `<button type="button" class="answer${o.v === cur ? ' was' : ''}" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join('')}
    </div>
    <div class="quiz-foot">
      <button type="button" class="link" data-act="back">${quiz.step === 0 ? 'はじめに戻る' : 'ひとつ戻る'}</button>
    </div>`;
  box.querySelector('.answers').onclick = (e) => {
    const b = e.target.closest('.answer');
    if (!b) return;
    q.set(b.dataset.v);
    state.answers[state.role].at = Date.now();
    save();
    quiz.step += 1;
    renderAll();
  };
  box.querySelector('.quiz-foot').onclick = (e) => {
    if (e.target.dataset.act !== 'back') return;
    quiz.step = quiz.step === 0 ? -1 : quiz.step - 1;
    renderQuiz();
  };
}

// 自分は答え終わって、相手の答えがまだ届いていない
function renderWaiting(box) {
  const other = nameOf(otherRole(state.role));
  box.innerHTML = `
    ${bubble(`ありがとう！<br>${esc(other)}にも答えてもらおう。<br>このリンクを送ってね。`, true, '答え終わり')}
    <div class="actions center">
      <button type="button" class="primary big" data-act="send">${esc(other)}に送る</button>
    </div>
    <div class="quiz-foot">
      <button type="button" class="link" data-act="again">答えなおす</button>
      <button type="button" class="link" data-act="peek">いまの答えだけで見てみる</button>
    </div>`;
  box.querySelector('[data-act="send"]').onclick = () => sendAnswers();
  box.querySelector('.quiz-foot').onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'again') { quiz.step = 0; renderQuiz(); }
    if (act === 'peek') { quiz.preview = true; renderQuiz(); }
  };
}

// 勝った候補の決め手と、次点との差を言葉にする
function reasons(r, second) {
  const c = r.c;
  const pn = partnerName();
  const out = [];
  if (c.kind === 'base') out.push('移動0分。起きたらすぐ撮影の準備に入れる');
  else out.push(`朝は撮影場所まで約${Math.round(r.travel)}分。${fmt(toMin(state.morning.ideal))}に起きれば${fmt(r.earliest)}に準備が終わる`);
  out.push(`崩れる見込みは${Math.round(r.pFail * 100)}%${c.weak ? `（${c.weak}）` : ''}`);
  if (r.health > 0) out.push('体調の不安はあるので、対策をしていく');
  if (c.kind !== 'partner' && r.pt != null) out.push(`${pn}の移動は片道約${Math.round(r.pt)}分`);
  if (second && isFinite(second.loss)) {
    const parts = [
      ['朝が遅くなる', second.offset - r.offset],
      ['崩れやすい', second.expDelay - r.expDelay],
      ['体調の不安が大きい', second.health - r.health],
      [`${pn}の移動が長い`, second.burden - r.burden],
      ['今夜の移動が長い', second.night - r.night],
    ].sort((a, b) => b[1] - a[1]);
    const why = parts.filter((x) => x[1] > 1).slice(0, 2).map((x) => x[0]);
    if (why.length) out.push(`次点の「${second.c.name}」は、${why.join('・')}ぶん少し不利`);
  }
  return out;
}

function renderAnswer(box) {
  const { rows } = compute();
  const r = rows[0];
  const other = nameOf(otherRole(state.role));
  if (!r || r.missing) {
    box.innerHTML = `
      ${bubble('移動時間がまだ入っていない候補があって、当てられなかった…。<br>下の「くわしい設定」で駅と時間を入れてね。', false)}
      <div class="actions center"><button type="button" class="ghost" data-act="again">質問からやり直す</button></div>`;
    box.querySelector('[data-act="again"]').onclick = () => { quiz.step = 0; renderQuiz(); };
    return;
  }
  const tips = tipsOf(r.c);
  const provisional = !otherReady();
  box.innerHTML = `
    ${bubble(provisional ? `${esc(other)}の答えはまだだけど、<br>いまのところ今夜は……` : 'ふたりの答えがそろったよ。<br>今夜は……', true, 'わかった！')}
    <div class="answer-card">
      <span class="icon big-icon" aria-hidden="true">${iconFor(r.c)}</span>
      <p class="answer-name">${esc(r.c.name)}</p>
      <p class="answer-sub">${provisional ? 'かも？' : 'でしょう！'}</p>
      <ul class="why-list">${reasons(r, rows[1]).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      ${tips.length ? `<p class="tips-h">持っていく・やっておく</p><ul class="plan-tips">${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="actions">
        ${provisional
          ? `<button type="button" class="primary" data-act="send">${esc(other)}に答えを送る</button>`
          : '<button type="button" class="primary" data-act="pick">これにする</button>'}
        <button type="button" class="ghost" data-act="again">答えなおす</button>
      </div>
    </div>`;
  box.querySelector('.answer-card .actions').onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'pick') decide(r.c.id);
    if (act === 'send') sendAnswers();
    if (act === 'again') { quiz.step = 0; quiz.preview = false; renderQuiz(); }
  };
}

/* ---------- 明日の朝（くわしい設定） ---------- */

function renderMorning() {
  const m = state.morning;
  $('#m-ready').value = m.ready;
  $('#m-prep').value = m.prep;
  $('#m-getup').value = m.getup;
  $('#m-ideal').value = m.ideal;
}

[['#m-ready', 'ready'], ['#m-ideal', 'ideal'], ['#m-prep', 'prep'], ['#m-getup', 'getup']].forEach(([sel, key]) => {
  $(sel).addEventListener('input', (e) => {
    state.morning[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    save();
    renderRanking();
  });
});

/* ---------- 駅と移動時間（くわしい設定） ---------- */

function renderPlaces() {
  const p = state.places;
  $('#s-self-name').value = p.selfName;
  $('#s-base').value = p.base;
  $('#s-base-walk').value = p.baseWalk;
  $('#s-partner-name').value = p.partnerName;
  $('#s-partner').value = p.partner;
  $('#s-partner-walk').value = p.partnerWalk;
  $('#s-buffer').value = p.buffer;
  renderPairs();
}

function renderPairs() {
  const pairs = neededPairs();
  $('#pairs').innerHTML = pairs.length
    ? pairs.map((x) => {
      const v = state.times[x.k];
      const missing = v === '' || v == null;
      return `<label class="pair${missing ? ' missing' : ''}">
        <span class="pair-name">${esc(x.a)}<i>⇄</i>${esc(x.b)}</span>
        <span class="unit"><input type="number" data-pair="${esc(x.k)}" value="${missing ? '' : esc(v)}" min="0" inputmode="numeric" placeholder="?">分</span>
      </label>`;
    }).join('')
    : '<p class="pairs-empty">撮影場所・相手の家・候補の駅を入れると、ここに区間が出ます。</p>';
  $('#station-list').innerHTML = knownStations().map((s) => `<option value="${esc(s)}">`).join('');
}

[['#s-self-name', 'selfName'], ['#s-base', 'base'], ['#s-base-walk', 'baseWalk'], ['#s-partner-name', 'partnerName'], ['#s-partner', 'partner'], ['#s-partner-walk', 'partnerWalk'], ['#s-buffer', 'buffer']].forEach(([sel, key]) => {
  $(sel).addEventListener('input', (e) => {
    state.places[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value.trim();
    save();
    renderPairs();
    renderRanking();
    renderQuiz();
  });
});

$('#pairs').addEventListener('input', (e) => {
  const k = e.target.dataset.pair;
  if (!k) return;
  state.times[k] = e.target.value === '' ? '' : Number(e.target.value);
  e.target.closest('.pair').classList.toggle('missing', e.target.value === '');
  save();
  renderRanking();
});

/* ---------- ぜんぶの候補 ---------- */

// 名前と種類から小さなアイコンを選ぶ（家／カフェ・漫画喫茶／それ以外はまくら）
const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5V19h12V9.5"/><path d="M10 19v-5h4v5"/></svg>',
  cafe: '<svg viewBox="0 0 24 24"><path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M9 3.5c-.8 1 .8 2-.1 3M12.5 3.5c-.8 1 .8 2-.1 3"/></svg>',
  pillow: '<svg viewBox="0 0 24 24"><path d="M4 8c3-1.5 13-1.5 16 0 1 3 1 5 0 8-3 1.5-13 1.5-16 0-1-3-1-5 0-8z"/><path d="M8 12h.01M16 12h.01"/></svg>',
};
function iconFor(c) {
  const n = String(c.name || '');
  if (c.kind === 'base' || c.kind === 'partner') return ICONS.home;
  // 「漫画喫茶（家の近く）」を家にしないよう、カフェ類を先に見る
  if (/カフェ|喫茶|漫|ネカフェ|ホテル/.test(n)) return ICONS.cafe;
  if (/家|宅|うち|ホーム/.test(n)) return ICONS.home;
  return ICONS.pillow;
}

function renderRanking() {
  const { rows, ready, ideal } = compute();
  if (!rows.length) {
    $('#ranking').innerHTML = '<li class="row"><p class="weak">候補がありません。「くわしい設定」から入れてください。</p></li>';
    return;
  }

  // タイムラインの表示範囲：いちばん早い起床（か理想の起床）の少し前から、準備完了の少し後まで
  const valid = rows.filter((r) => !r.missing);
  const start = Math.floor((Math.min(ideal, ...valid.map((r) => r.wake)) - 15) / 60) * 60;
  const end = Math.ceil((ready + 15) / 60) * 60;
  const pct = (t) => clamp(((t - start) / (end - start)) * 100, 0, 100);
  const ticks = [];
  for (let t = start; t <= end; t += 60) {
    // 両端の目盛りははみ出さないよう内側に寄せる
    const shift = t === start ? '0' : t === end ? '-100%' : '-50%';
    ticks.push(`<span class="tl-tick" style="left:${pct(t)}%;transform:translateX(${shift})">${fmt(t)}</span>`);
  }
  const pn = partnerName();
  const canPick = otherReady();

  const legend = `<li class="legend" aria-hidden="true"><span><i style="background:var(--seg-getup)"></i>身支度</span><span><i style="background:var(--seg-move)"></i>移動</span><span><i style="background:var(--moon)"></i>準備</span><span><i class="dot" style="background:var(--pink)"></i>理想の起床</span></li>`;

  $('#ranking').innerHTML = legend + rows.map((r, i) => {
    const c = r.c;
    const head = `
        <div class="row-head">
          <span class="icon" aria-hidden="true">${iconFor(c)}</span>
          <span class="name-wrap">
            ${r.missing ? '<span class="rank-no">移動時間が未入力</span>' : i === 0 ? '<span class="badge">いちばんおすすめ</span>' : `<span class="rank-no">${i + 1}番目</span>`}
            <span class="name">${esc(c.name) || '（名前なし）'}</span>
          </span>
          ${r.missing || !canPick ? '' : `<button type="button" class="pick" data-id="${esc(c.id)}">これにする</button>`}
        </div>`;
    if (r.missing) {
      return `<li class="row">${head}<p class="route missing-note">「くわしい設定」の駅と移動時間を入れると並びます</p></li>`;
    }
    const arrive = r.leave + r.travel;
    const st = stationOf(c);
    const route = c.kind === 'base'
      ? '撮影場所なので移動なし'
      : `撮影場所まで <b>約${Math.round(r.travel)}分</b>${r.mt.train != null ? `（${esc(st)}から電車${r.mt.train}分＋歩き・余裕）` : ''}`;
    const partnerLine = c.kind === 'partner' ? '' : r.pt != null ? `　${esc(pn)}の家まで 片道約${Math.round(r.pt)}分` : '';
    const why = [
      `崩れる見込み ${Math.round(r.pFail * 100)}%・崩れたら +${num(c.delay)}分`,
      r.health ? `体調の不安 +${Math.round(r.health)}` : '',
      (num(c.ok) + num(c.ng)) ? `記録 守れた${c.ok}・守れなかった${c.ng}` : '',
    ].filter(Boolean).join('　');
    return `
      <li class="row${i === 0 ? ' top' : ''}">
        ${head}
        <div class="times">
          <div class="${r.needEarly ? 'warn' : ''}"><em>遅くとも起床</em><b>${fmt(r.wake)}</b></div>
          <div><em>${r.travel ? '出発・解散' : '解散'}</em><b>${fmt(r.leave)}</b></div>
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
        <p class="route">${route}${partnerLine}</p>
        ${c.weak ? `<p class="weak">崩れるところ：${esc(c.weak)}</p>` : ''}
        <p class="why">${why}${r.needEarly ? '　<span class="warn">理想より早起きが必要</span>' : ''}</p>
      </li>`;
  }).join('');
}

$('#ranking').addEventListener('click', (e) => {
  const b = e.target.closest('.pick');
  if (!b) return;
  decide(b.dataset.id);
});

/* ---------- 決める ---------- */

function decide(id) {
  const { rows, ready } = compute();
  const r = rows.find((x) => x.c.id === id);
  if (!r || r.missing) return;
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
  const leave = useIdeal ? ideal + num(m.getup) : r.leave;
  const doneAt = useIdeal ? r.earliest : ready;

  state.decided = {
    at: now.getTime(),
    due: due.getTime(),
    id: r.c.id,
    name: r.c.name,
    wake: fmt(wake),
    leave: fmt(leave),
    ready: fmt(doneAt),
    latest: useIdeal && r.wake > ideal ? `遅くとも ${fmt(r.wake)} 起床・${fmt(r.leave)} ${r.travel ? '出発' : '解散'}なら ${fmt(ready)} に間に合う` : '',
    deadline: fmt(ready),
    travel: r.travel,
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
    <button type="button" class="primary" data-act="share">${esc(nameOf(otherRole(state.role || 'self')))}に送る</button>
    <button type="button" class="ghost" data-act="cancel">取り消す</button>`;
  box.querySelector('[data-slot]').onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'share') share(shareText(d), buildUrl(d), '今夜の泊まり先');
    if (act === 'cancel') { state.decided = null; save(); renderDecided(); }
  };
}

function shareText(d) {
  const lines = [`今夜は ${d.name}`, `${d.wake} 起床／${d.leave} ${d.travel ? '出発・解散' : '解散'}／${d.ready} 準備完了`];
  if (d.latest) lines.push(`（${d.latest}）`);
  if (d.tips.length) lines.push('', ...d.tips.map((t) => `・${t}`));
  return lines.join('\n');
}

/* ---------- リンクで送り合う ---------- */

// 自分の答え（と、撮影する人なら設定一式・決めた予定）を #s= に詰める。# の後ろはサーバーに送られない
function buildUrl(plan) {
  const role = state.role || 'self';
  const payload = { v: 3, from: role, answers: state.answers[role] };
  // 相手の答えも持っていれば一緒に渡す（両方の画面で同じ結果になる）
  const oth = otherRole(role);
  if (isFresh(state.answers[oth])) payload.other = state.answers[oth];
  if (role === 'self') Object.assign(payload, { morning: state.morning, places: state.places, times: state.times, candidates: state.candidates });
  if (plan) payload.plan = plan;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#s=${b64}`;
}

function sendAnswers() {
  const me = nameOf(state.role);
  const other = nameOf(otherRole(state.role));
  share(`${me}の答えを送ります。開いて、${other}の質問に答えてね`, buildUrl(null), '今夜どこでねる？');
}

function readShared() {
  const m = location.hash.match(/^#s=([\w-]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) { return null; }
}

// 届いたリンクを取り込む。答えは黙って受け取り、設定は撮影する人から届いたときだけ上書きする
function receiveShared() {
  const data = readShared();
  if (!data) return;
  history.replaceState(null, '', location.pathname);
  const from = data.from || 'self';

  // setup=true は「設定だけ渡す」最初の1回用。誰が開いても設定を入れ、役割と答えには触らない
  if (data.setup || data.v === 2 || from === 'self') {
    for (const k of ['morning', 'places', 'times', 'candidates']) {
      if (data[k]) state[k] = k === 'candidates' ? data[k] : (k === 'times' ? { ...data[k] } : { ...DEFAULT[k], ...data[k] });
    }
  }
  if (data.v === 3 && !data.setup) {
    // 初めて開いた端末は、送ってきた人の相手として使う
    if (!state.role) state.role = otherRole(from);
    if (from !== state.role) {
      state.answers[from] = { ...data.answers };
      if (data.other && from !== state.role) {
        // 送り主が持っていた「こちらの答え」は、手元のほうが新しければ手元を使う
        const mine = state.answers[state.role];
        if (!isFresh(mine) || (data.other.at || 0) > (mine.at || 0)) state.answers[state.role] = { ...data.other };
      }
    }
  }
  if (data.plan) state.received = data.plan;
  save();

  const who = nameOf(from);
  if (data.plan) toast(`${who}から予定が届きました`);
  else if (data.v === 3 && !data.setup) toast(`${who}の答えを受け取りました`);
  else toast('設定を受け取りました');
  // 自分がもう答え終わっていれば、そのまま結果を出す
  if (state.role && isFresh(state.answers[state.role]) && isFresh(state.answers[otherRole(state.role)])) quiz.step = 'done';
}

function renderShared() {
  const box = $('#shared');
  const p = state.received;
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = planCard(p, '決まった予定');
  box.querySelector('[data-slot]').innerHTML = '<button type="button" class="ghost" data-act="close">閉じる</button>';
  box.querySelector('[data-slot]').onclick = () => { state.received = null; save(); renderShared(); };
}

async function share(text, url, title) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(`${text}\n${url}`, 'コピーしました。LINEなどに貼ってね');
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
    if (c && act === 'ok') c.ok = num(c.ok) + 1;
    if (c && act === 'ng') c.ng = num(c.ng) + 1;
    state.decided = null;
    save();
    renderAll();
    if (act !== 'skip') toast('記録しました');
  };
}

/* ---------- 候補の編集（くわしい設定） ---------- */

function opts(labels, current) {
  return Object.entries(labels).map(([k, v]) => `<option value="${k}"${k === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function renderCands() {
  const p = state.places;
  const kinds = { base: `${selfName()}の家（撮影場所）`, partner: `${partnerName()}の家`, other: 'そのほか' };
  $('#cands').innerHTML = state.candidates.map((c) => {
    const where = c.kind === 'base'
      ? `<p class="fixed-station wide">駅：${esc(p.base || '（上の「撮影場所の駅」）')}</p>`
      : c.kind === 'partner'
        ? `<p class="fixed-station wide">駅：${esc(p.partner || '（上の「相手の家の駅」）')}</p>`
        : `<label class="field"><span>最寄り駅</span><input type="text" data-k="station" value="${esc(c.station)}" placeholder="例：〇〇" list="station-list"></label>
           <label class="field"><span>駅から歩き</span><span class="unit"><input type="number" data-k="walk" value="${esc(c.walk)}" min="0" inputmode="numeric">分</span></label>`;
    return `
    <div class="cand" data-id="${esc(c.id)}">
      <div class="cand-head">
        <input type="text" data-k="name" value="${esc(c.name)}" placeholder="候補の名前" aria-label="候補の名前">
        <button type="button" class="cand-del" data-act="del">外す</button>
      </div>
      <div class="cand-grid">
        <label class="field wide"><span>種類</span><select data-k="kind">${opts(kinds, c.kind)}</select></label>
        ${where}
        <label class="field"><span>崩れやすさ</span><select data-k="risk">${opts(RISK_LABEL, c.risk)}</select></label>
        <label class="field"><span>崩れたら遅れる</span><span class="unit"><input type="number" data-k="delay" value="${esc(c.delay)}" min="0" step="10" inputmode="numeric">分</span></label>
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
    </div>`;
  }).join('');
}

$('#cands').addEventListener('input', (e) => {
  const el = e.target;
  const k = el.dataset.k;
  const id = el.closest('.cand')?.dataset.id;
  const c = state.candidates.find((x) => x.id === id);
  if (!c || !k) return;
  c[k] = el.type === 'number' ? Number(el.value) : k === 'station' ? el.value.trim() : el.value;
  save();
  if (k === 'kind') renderCands();
  if (k === 'kind' || k === 'station') renderPairs();
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
  renderPairs();
  renderRanking();
});

$('#add').addEventListener('click', () => {
  state.candidates.push({ id: Date.now().toString(36), name: '', kind: 'other', station: '', walk: 5, weak: '', risk: 'mid', delay: 60, health: 'none', tips: '', ok: 0, ng: 0 });
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
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function renderAll() {
  renderShared();
  renderRecord();
  renderQuiz();
  renderMorning();
  renderPlaces();
  renderRanking();
  renderDecided();
  renderCands();
}

window.addEventListener('hashchange', () => { receiveShared(); renderAll(); });
receiveShared();
renderAll();
