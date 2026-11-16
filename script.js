'use strict';

/* ============================================================
   設定（計測IDはここ1箇所だけ）
   Google Analytics 4 の測定ID（G- から始まる文字列）を貼ると、
   匿名の計測が自動で始まります。空のままでもアプリは動きます。
   ============================================================ */
const GA_MEASUREMENT_ID = '';

/* ===== 定数 ===== */
const STORAGE_KEY = 'studyfeed.prod.v1';
const INTERVALS = {
  fast:   { bad: 3, fuzzy: 6,  label: '早め' },
  normal: { bad: 5, fuzzy: 10, label: 'ふつう' },
  slow:   { bad: 8, fuzzy: 15, label: '遅め' }
};
const MAX_REQUEUE = 3; // 同じ問題の再出題は最大3回まで
const SUBJECT_LABEL = { english: '英単語', social: '社会' };
const JUDGE_LABEL = { know: '覚えてた', fuzzy: 'あいまい', bad: 'ダメだった' };

/* ===== 端末内データ（LocalStorage） ===== */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') return Object.assign(defaultStore(), s);
    }
  } catch (e) { /* 保存できない環境では初期値で動く */ }
  return defaultStore();
}
function defaultStore() {
  return {
    answers: {},        // qid -> { last: 'know'|'fuzzy'|'bad', count: 回数 }
    weak: [],           // 苦手マークした qid の配列
    settings: { interval: 'normal' },
    lastVisitDate: '',  // 'YYYY-MM-DD'
    noticeDismissed: false
  };
}
let store = loadStore();
function saveStore() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* 何もしない */ }
}

/* ===== 匿名計測（GA4・任意） ===== */
function initAnalytics() {
  if (!GA_MEASUREMENT_ID) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
}
function ga(eventName, params) {
  if (!GA_MEASUREMENT_ID || typeof window.gtag !== 'function') return;
  try { window.gtag('event', eventName, params || {}); } catch (e) { /* 計測失敗で本体を止めない */ }
}

/* ===== アプリの高さを実測で固定（iOSアプリ内ブラウザ対策） ===== */
const feedEl = document.getElementById('feed');
function fitAppHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (h) document.documentElement.style.setProperty('--app-height', h + 'px');
}
function realignFeed() {
  const slide = feedEl.children[currentIdx];
  if (slide) feedEl.scrollTo({ top: slide.offsetTop - 12, behavior: 'auto' });
}
function refit() { fitAppHeight(); realignFeed(); }
window.addEventListener('resize', fitAppHeight);
window.addEventListener('orientationchange', refit);
window.addEventListener('pageshow', refit);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitAppHeight);

/* ===== セッション状態 ===== */
let questions = [];       // questions.json の全データ
let queue = [];           // { qid, attempt, state: 'pending'|'judged', revealed, result }
let currentIdx = 0;
let filter = 'all';       // 'all' | 'english' | 'social'
let weakOnly = false;
let sessionJudged = 0;    // このセッションで判定した回数（再出題分も数える）
let sessionByResult = { know: 0, fuzzy: 0, bad: 0 };
let chunkShown = 0;       // 小結果を出した回数
let sessionEnded = false;

function questionById(qid) { return questions.find(q => q.id === qid); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue() {
  let pool = questions.filter(q => filter === 'all' || q.subject === filter);
  if (weakOnly) pool = pool.filter(q => store.weak.includes(q.id));
  queue = shuffle(pool).map(q => ({ qid: q.id, attempt: 0, state: 'pending', revealed: false, result: '' }));
  currentIdx = 0;
  sessionJudged = 0;
  sessionByResult = { know: 0, fuzzy: 0, bad: 0 };
  chunkShown = 0;
  sessionEnded = false;
}

/* ===== 描画 ===== */
const statDone = document.getElementById('statDone');
const statLeft = document.getElementById('statLeft');
const statWeak = document.getElementById('statWeak');
const progressFill = document.getElementById('progressFill');
const footLabel = document.getElementById('footLabel');
const judgeRow = document.getElementById('judgeRow');
let observer = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slideHtml(entry, idx) {
  const q = questionById(entry.qid);
  const isWord = q.subject === 'english';
  const weakOn = store.weak.includes(q.id);
  const answerHtml = entry.revealed
    ? '<div class="answer-box"><span class="answer-label">答え</span><p class="answer-text">' + escapeHtml(q.answer) + '</p></div>'
    : '<p class="tap-hint">タップすると答えが見られるよ</p>';
  return '' +
    '<div class="card">' +
      '<div class="card-scroll">' +
        '<span class="subject-chip subject-' + q.subject + '">' + SUBJECT_LABEL[q.subject] + '</span>' +
        '<span class="card-count">' + (idx + 1) + ' / ' + queue.length + ' 問目</span>' +
        '<p class="card-label">問題</p>' +
        '<p class="card-question' + (isWord ? ' is-word' : '') + '">' + escapeHtml(q.question) + '</p>' +
        (isWord ? '<p class="card-sub">この単語の意味は？</p>' : '') +
        answerHtml +
      '</div>' +
      '<div class="rail">' +
        '<button type="button" class="rail-btn rail-btn-why" data-act="explain" aria-label="解説"><span class="rail-icon">📖</span>解説</button>' +
        '<button type="button" class="rail-btn' + (weakOn ? ' is-on' : '') + '" data-act="weak" aria-label="苦手マーク"><span class="rail-icon">🔖</span>苦手</button>' +
      '</div>' +
    '</div>';
}

function render(keepScroll) {
  suppressNav = true;
  if (observer) observer.disconnect();
  if (queue.length === 0) {
    feedEl.innerHTML = '<p class="feed-message">' + (weakOnly
      ? '苦手マークの問題がまだありません。\n問題カードの「苦手」ボタンでマークできます。'
      : '問題がありません。') + '</p>';
    syncAll();
    suppressNav = false;
    return;
  }
  feedEl.innerHTML = queue.map((entry, i) =>
    '<section class="slide" data-idx="' + i + '">' + slideHtml(entry, i) + '</section>').join('');
  // はみ出すカードだけ内側スクロールを有効化（描画レイヤーの継ぎ目対策）
  feedEl.querySelectorAll('.card-scroll').forEach(el => {
    if (el.scrollHeight > el.clientHeight + 2) el.classList.add('can-scroll');
  });
  observer = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) onCurrentChange(Number(en.target.dataset.idx)); });
  }, { root: feedEl, threshold: 0.6 });
  feedEl.querySelectorAll('.slide').forEach(sl => observer.observe(sl));
  if (keepScroll) realignFeed(); else feedEl.scrollTo({ top: 0, behavior: 'auto' });
  syncAll();
  // 再描画直後の監視コールバックでは並び替えをしない（iOSで再描画→監視→再描画が連鎖し、問題が高速で入れ替わり続ける不具合の対策）
  requestAnimationFrame(() => setTimeout(() => { suppressNav = false; }, 80));
}

function pendingCount() { return queue.filter(e => e.state === 'pending').length; }

function syncAll() {
  statDone.textContent = sessionJudged;
  statLeft.textContent = pendingCount();
  statWeak.textContent = store.weak.length;
  const total = sessionJudged + pendingCount();
  progressFill.style.width = total ? Math.round(sessionJudged / total * 100) + '%' : '0%';
  syncFooter();
}

function syncFooter() {
  const entry = queue[currentIdx];
  if (!entry || sessionEnded) {
    footLabel.textContent = 'おつかれさま';
    footLabel.hidden = false;
    judgeRow.hidden = true;
    return;
  }
  if (entry.state === 'judged') {
    const iv = INTERVALS[store.settings.interval] || INTERVALS.normal;
    let note = '「' + JUDGE_LABEL[entry.result] + '」で記録したよ';
    if (entry.result === 'bad') note += '（約' + iv.bad + '問後にもう一度出るよ）';
    if (entry.result === 'fuzzy') note += '（約' + iv.fuzzy + '問後にもう一度出るよ）';
    footLabel.textContent = note;
    footLabel.hidden = false;
    judgeRow.hidden = true;
  } else if (entry.revealed) {
    footLabel.textContent = '答えを見た感想は？ 正直に選ぼう';
    footLabel.hidden = false;
    judgeRow.hidden = false;
  } else {
    footLabel.textContent = 'カードをタップすると答えが見られるよ';
    footLabel.hidden = false;
    judgeRow.hidden = true;
  }
}

/* ===== フィードの移動・スキップ処理 ===== */
let suppressNav = false;
let navTimer = null;
function onCurrentChange(idx) {
  if (sessionEnded) return;
  if (idx === currentIdx) { syncFooter(); return; }
  // 再描画・位置合わせ直後は現在位置だけ取り込み、並び替えはしない
  if (suppressNav) { currentIdx = idx; syncFooter(); return; }
  // スクロールが落ち着いてから確定させる（通過しただけのスライドで並び替えない）
  if (navTimer) clearTimeout(navTimer);
  navTimer = setTimeout(() => commitNav(idx), 140);
}
function commitNav(idx) {
  if (idx === currentIdx || sessionEnded) { syncFooter(); return; }
  const prev = queue[currentIdx];
  const leavingIdx = currentIdx;
  currentIdx = idx;
  // 判定しないまま通り過ぎた問題は、キューの一番後ろに戻す
  if (prev && prev.state === 'pending' && leavingIdx < queue.length - 1) {
    queue.splice(leavingIdx, 1);
    queue.push(prev);
    if (currentIdx > leavingIdx) currentIdx -= 1;
    render(true);
    return;
  }
  syncFooter();
}

/* ===== 答え表示 ===== */
feedEl.addEventListener('click', ev => {
  const railBtn = ev.target.closest('[data-act]');
  const slide = ev.target.closest('.slide');
  if (!slide) return;
  const idx = Number(slide.dataset.idx);
  const entry = queue[idx];
  if (!entry) return;
  if (railBtn) {
    if (railBtn.dataset.act === 'explain') openSheet(entry);
    if (railBtn.dataset.act === 'weak') toggleWeak(entry, railBtn);
    return;
  }
  if (idx !== currentIdx) return;
  if (!entry.revealed && entry.state === 'pending') {
    entry.revealed = true;
    ga('reveal', { subject: questionById(entry.qid).subject });
    render(true);
  }
});

/* ===== 苦手マーク ===== */
function toggleWeak(entry, btn) {
  const qid = entry.qid;
  const i = store.weak.indexOf(qid);
  const on = i < 0;
  if (on) store.weak.push(qid); else store.weak.splice(i, 1);
  saveStore();
  ga('weak_toggle', { subject: questionById(qid).subject, on: on ? 1 : 0 });
  if (btn) btn.classList.toggle('is-on', on);
  statWeak.textContent = store.weak.length;
}

/* ===== 解説シート ===== */
const sheet = document.getElementById('sheet');
const sheetOverlay = document.getElementById('sheetOverlay');
function openSheet(entry) {
  const q = questionById(entry.qid);
  document.getElementById('sheetAnswer').textContent = q.answer;
  document.getElementById('sheetBody').textContent = q.explanation;
  sheet.hidden = false;
  sheetOverlay.hidden = false;
}
function closeSheet() { sheet.hidden = true; sheetOverlay.hidden = true; }
document.getElementById('sheetClose').addEventListener('click', closeSheet);
sheetOverlay.addEventListener('click', closeSheet);
let sheetTouchY = null;
sheet.addEventListener('touchstart', ev => { sheetTouchY = ev.touches[0].clientY; }, { passive: true });
sheet.addEventListener('touchend', ev => {
  if (sheetTouchY === null) return;
  const dy = ev.changedTouches[0].clientY - sheetTouchY;
  sheetTouchY = null;
  if (dy > 60) closeSheet();
}, { passive: true });

/* ===== 自己判定 ===== */
judgeRow.addEventListener('click', ev => {
  const btn = ev.target.closest('[data-judge]');
  if (!btn) return;
  judge(btn.dataset.judge);
});

function judge(result) {
  const entry = queue[currentIdx];
  if (!entry || entry.state !== 'pending' || !entry.revealed || sessionEnded) return;
  entry.state = 'judged';
  entry.result = result;
  const qid = entry.qid;
  const rec = store.answers[qid] || { last: '', count: 0 };
  rec.last = result;
  rec.count += 1;
  store.answers[qid] = rec;
  saveStore();

  sessionJudged += 1;
  sessionByResult[result] += 1;
  ga('judge', { subject: questionById(qid).subject, result: result });

  // 再出題：ダメだった・あいまいは間隔をあけてキューの後方へ再挿入
  if ((result === 'bad' || result === 'fuzzy') && entry.attempt < MAX_REQUEUE) {
    const iv = INTERVALS[store.settings.interval] || INTERVALS.normal;
    const offset = result === 'bad' ? iv.bad : iv.fuzzy;
    const insertAt = Math.min(currentIdx + offset, queue.length);
    queue.splice(insertAt, 0, { qid: qid, attempt: entry.attempt + 1, state: 'pending', revealed: false, result: '' });
  }

  render(true);

  // 10問ごとの小結果
  if (sessionJudged % 10 === 0 && pendingCount() > 0) {
    chunkShown += 1;
    ga('chunk_reached', { chunk: chunkShown });
    showChunk();
    return;
  }
  // すべて判定し終えたら結果へ
  if (pendingCount() === 0) {
    sessionEnded = true;
    setTimeout(showResults, 450);
  }
}

/* ===== 10問ごとの小結果 ===== */
const chunkOverlay = document.getElementById('chunkOverlay');
function showChunk() {
  const from = sessionJudged - 9;
  document.getElementById('chunkTitle').textContent = sessionJudged + '問おつかれさま';
  document.getElementById('chunkText').textContent =
    'ここまでの判定：覚えてた ' + sessionByResult.know + '問／あいまい ' + sessionByResult.fuzzy +
    '問／ダメだった ' + sessionByResult.bad + '問（' + from + '〜' + sessionJudged + '問目を含む累計）\n苦手マークは ' + store.weak.length + ' 件です。';
  chunkOverlay.hidden = false;
}
document.getElementById('chunkContinue').addEventListener('click', () => { chunkOverlay.hidden = true; });
document.getElementById('chunkFinish').addEventListener('click', () => {
  chunkOverlay.hidden = true;
  sessionEnded = true;
  showResults();
});

/* ===== 結果画面 ===== */
const resultsOverlay = document.getElementById('resultsOverlay');
function showResults() {
  document.getElementById('resultsText').textContent =
    '解いた問題：' + sessionJudged + '問\n覚えてた ' + sessionByResult.know + '問／あいまい ' + sessionByResult.fuzzy +
    '問／ダメだった ' + sessionByResult.bad + '問\n苦手マーク：' + store.weak.length + '件';
  document.getElementById('resultsWeak').disabled = store.weak.length === 0;
  resultsOverlay.hidden = false;
  syncFooter();
}
document.getElementById('resultsAgain').addEventListener('click', () => {
  resultsOverlay.hidden = true;
  buildQueue();
  render(false);
});
document.getElementById('resultsWeak').addEventListener('click', () => {
  resultsOverlay.hidden = true;
  weakOnly = true;
  syncWeakModeBtn();
  buildQueue();
  render(false);
});

/* ===== 教科タブ ===== */
document.getElementById('tabs').addEventListener('click', ev => {
  const tab = ev.target.closest('[data-filter]');
  if (!tab) return;
  filter = tab.dataset.filter;
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('is-active', t === tab));
  buildQueue();
  render(false);
});

/* ===== 設定 ===== */
const settingsOverlay = document.getElementById('settingsOverlay');
const weakModeBtn = document.getElementById('weakModeBtn');
function syncIntervalSeg() {
  document.querySelectorAll('#intervalSeg button').forEach(b =>
    b.classList.toggle('is-active', b.dataset.interval === store.settings.interval));
}
function syncWeakModeBtn() {
  weakModeBtn.textContent = '苦手だけ復習：' + (weakOnly ? 'オン' : 'オフ');
}
document.getElementById('settingsBtn').addEventListener('click', () => {
  syncIntervalSeg();
  syncWeakModeBtn();
  settingsOverlay.hidden = false;
});
document.getElementById('settingsClose').addEventListener('click', () => { settingsOverlay.hidden = true; });
document.getElementById('intervalSeg').addEventListener('click', ev => {
  const btn = ev.target.closest('[data-interval]');
  if (!btn) return;
  store.settings.interval = btn.dataset.interval;
  saveStore();
  syncIntervalSeg();
});
weakModeBtn.addEventListener('click', () => {
  weakOnly = !weakOnly;
  syncWeakModeBtn();
  settingsOverlay.hidden = true;
  buildQueue();
  render(false);
});

/* ===== 記録リセット ===== */
const confirmOverlay = document.getElementById('confirmOverlay');
document.getElementById('resetBtn').addEventListener('click', () => { confirmOverlay.hidden = false; });
document.getElementById('confirmCancel').addEventListener('click', () => { confirmOverlay.hidden = true; });
document.getElementById('confirmReset').addEventListener('click', () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 何もしない */ }
  location.reload();
});

/* ===== 初回注意バー ===== */
const noticeBar = document.getElementById('noticeBar');
if (!store.noticeDismissed) noticeBar.hidden = false;
document.getElementById('noticeClose').addEventListener('click', () => {
  noticeBar.hidden = true;
  store.noticeDismissed = true;
  saveStore();
  refit();
});

/* ===== 初期化 ===== */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function init() {
  initAnalytics();
  fitAppHeight();

  // 再訪（継続率）の計測：前回訪問日が今日より前なら「再訪」
  const today = todayStr();
  const returning = store.lastVisitDate && store.lastVisitDate < today;
  ga('session_start', { returning: returning ? 1 : 0 });
  store.lastVisitDate = today;
  saveStore();

  try {
    const res = await fetch('questions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('fetch failed');
    questions = await res.json();
  } catch (e) {
    feedEl.innerHTML = '<p class="feed-message">問題データを読み込めませんでした。\n公開環境（https:// のURL）で開いているか確認してください。</p>';
    return;
  }
  buildQueue();
  render(false);
  // 表示直後の高さ再計測（アプリ内ブラウザのツールバー確定に合わせる）
  setTimeout(refit, 250);
  setTimeout(refit, 900);
}

init();
