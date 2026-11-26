'use strict';

/* ============================================================
   設定（計測IDはここ1箇所だけ）
   Google Analytics 4 の測定ID（G- から始まる文字列）を貼ると、
   匿名の計測が自動で始まります。空のままでもアプリは動きます。
   ============================================================ */
const GA_MEASUREMENT_ID = 'G-55DZP8B6B8';

// ブラウザのスクロール位置の自動復元を止める。再読み込み・タブ復帰のときに
// 前回のフィード位置が復元されると、開始直後に問題が飛んで見える原因になる（2026-11-22）
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/* ===== 定数 ===== */
const STORAGE_KEY = 'studyfeed.prod.v1';
/* 注意バーを閉じた記録専用のキー（2026-11-26）。本体ストアとは別に持つことで、
   本体ストアだけが初期化・移行されても「閉じた」事実が残るようにする */
const NOTICE_KEY = 'studyfeed.noticeDismissed.v1';
const INTERVALS = {
  fast:   { bad: 3, fuzzy: 6,  label: '早め' },
  normal: { bad: 5, fuzzy: 10, label: 'ふつう' },
  slow:   { bad: 8, fuzzy: 15, label: '遅め' }
};
const MAX_REQUEUE = 3; // 同じ問題の再出題は最大3回まで
/* 教科レジストリ（2026-11-25 科目タブの土台）。教科を増やすときはここに1行足すだけで
   タブ・チップ・自作問題の教科選択に反映される。問題が0問の教科はタブを選ぶと
   「準備中」表示になる（questions.json のスキーマ変更は不要：subject の値が増えるだけ） */
const SUBJECTS = [
  { key: 'english',  label: '英単語' },
  { key: 'social',   label: '社会' },
  { key: 'math',     label: '数学' },
  { key: 'science',  label: '理科' },
  { key: 'japanese', label: '国語' }
];
const SUBJECT_LABEL = {};
SUBJECTS.forEach(s => { SUBJECT_LABEL[s.key] = s.label; });
/* 復習キュー（間隔反復）の間隔（日数）。間違えた問題を翌日→3日後→7日後の段階で再出題する */
const SRS_INTERVALS = [1, 3, 7];
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
    settings: { interval: 'normal', tts: false },
    lastVisitDate: '',  // 'YYYY-MM-DD'
    noticeDismissed: false,
    studySeconds: {},   // 'YYYY-MM-DD' -> その日の学習秒数（端末内のみ。先生側指標「何分勉強したか」の基礎）
    review: {},         // 復習キュー（間隔反復）: qid -> { stage: 0..2, due: 'YYYY-MM-DD' }。端末内のみ
    customQuestions: [], // 自作問題（questions.json と同じ {id, subject, question, answer, explanation} 形式。端末内のみ）
    playlists: [] // プレイリスト（{id, name, qids: []}。塾側の宿題配信とも形式を共通化する想定。端末内のみ）
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
let lastFitWidth = 0;
function fitAppHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (!h) return;
  // 幅が変わったとき（回転・ウィンドウのリサイズ）だけ高さを決め直す。
  // URLバーの出入りなど「高さだけ」の変化で組み直すと、スナップ位置が全部ずれて
  // 問題が飛んだり、だんだん画面に収まらなくなる不具合の原因になる（2026-11-22）
  if (lastFitWidth && window.innerWidth === lastFitWidth) return;
  lastFitWidth = window.innerWidth;
  document.documentElement.style.setProperty('--app-height', h + 'px');
}
function realignFeed() {
  const slide = feedEl.children[currentIdx];
  if (!slide) return;
  // offsetTop は body 基準でヘッダー・注意バーの高さ分ずれるため、画面上の実測差分で合わせる
  const delta = slide.getBoundingClientRect().top - feedEl.getBoundingClientRect().top;
  if (delta) feedEl.scrollTo({ top: feedEl.scrollTop + delta, behavior: 'auto' });
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
let customOnly = false;
let activePlaylistId = null; // 解いているプレイリストの id。null = 通常フィード
let sessionJudged = 0;    // このセッションで判定した回数（再出題分も数える）
let sessionByResult = { know: 0, fuzzy: 0, bad: 0 };
let chunkShown = 0;       // 小結果を出した回数
let sessionEnded = false;

/* ===== ストップウォッチ（2026-11-20 本人決定で自動計測から変更） ===== */
// 自動判定は曖昧で実感とズレるため、手動のストップウォッチにする。
// バッジをタップしてスタート／一時停止。裏に回したときだけ自動で一時停止し、戻ると再開する。
// セッション終了時に今日の合計秒数へ加算して端末内に保存する（先生側指標「何分勉強したか」の基礎）。
let swStartTs = null;       // 計測中の開始時刻（Date.now()）。停止中は null
let swElapsedMs = 0;        // 停止中に溜めた経過ミリ秒
let swIntervalId = null;
let swAutoPaused = false;   // 裏に回して自動停止中かどうか（手動停止と区別する）
const statTime = document.getElementById('statTime');
const swBtn = document.getElementById('swBtn');
const swLabel = document.getElementById('swLabel');

function formatClock(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor(totalSeconds % 3600 / 60);
  const s = totalSeconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}
function formatDurationJa(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor(totalSeconds % 3600 / 60);
  const s = totalSeconds % 60;
  if (h) return h + '時間' + m + '分';
  if (m) return m + '分' + s + '秒';
  return s + '秒';
}
function swNowMs() {
  return swElapsedMs + (swStartTs ? Date.now() - swStartTs : 0);
}
function swRunning() { return swStartTs !== null; }
function updateTimerDisplay() {
  if (statTime) statTime.textContent = formatClock(Math.floor(swNowMs() / 1000));
  if (swLabel) swLabel.textContent = swRunning() ? '⏸' : '▶';
  if (swBtn) swBtn.classList.toggle('is-paused', !swRunning());
}
function swStart() {
  if (swRunning() || sessionEnded) return;
  swAutoPaused = false;
  swStartTs = Date.now();
  if (!swIntervalId) swIntervalId = setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();
}
function swPause(auto) {
  if (swStartTs) { swElapsedMs += Date.now() - swStartTs; swStartTs = null; }
  swAutoPaused = !!auto;
  if (swIntervalId) { clearInterval(swIntervalId); swIntervalId = null; }
  updateTimerDisplay();
}
if (swBtn) swBtn.addEventListener('click', () => { if (swRunning()) swPause(false); else swStart(); });
// 新しいセッションでは 0・停止状態から始める（自動では始めない）
function resetStopwatch() {
  if (swIntervalId) { clearInterval(swIntervalId); swIntervalId = null; }
  swStartTs = null;
  swElapsedMs = 0;
  swAutoPaused = false;
  updateTimerDisplay();
}
// セッション終了時：止めて今日の合計に加算して保存し、今回の秒数を返す
function commitStopwatch() {
  swPause(false);
  const secs = Math.round(swElapsedMs / 1000);
  swElapsedMs = 0;
  swAutoPaused = false;
  updateTimerDisplay();
  if (secs > 0) {
    const today = todayStr();
    store.studySeconds[today] = (store.studySeconds[today] || 0) + secs;
    saveStore();
  }
  return secs;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (swRunning()) swPause(true); }
  else if (swAutoPaused && !sessionEnded) swStart();
});
// 途中で閉じてもここまでの時間を失わないよう、離脱時に保存する
window.addEventListener('pagehide', () => { if (!sessionEnded && swNowMs() >= 1000) commitStopwatch(); });

function questionById(qid) { return questions.find(q => q.id === qid); }

/* ===== 日付ユーティリティ・復習キュー・ストリーク（2026-11-25） ===== */
function addDaysStr(dateStr, n) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 期限（今日以前）が来ている復習問題の qid 一覧
function dueReviewIds() {
  const today = todayStr();
  return Object.keys(store.review || {}).filter(qid => {
    const e = store.review[qid];
    return e && e.due && e.due <= today;
  });
}
// 判定結果に応じて復習キューの予定を更新する。
// ダメだった→段階0・翌日／あいまい→同じ段階の間隔で再設定／覚えてた→段階を進め、最終段階を終えたら卒業（キューから外す）。
// 初めて正解した問題は登録しない（間違えた問題だけが復習キューの対象）。
function scheduleReview(qid, result) {
  if (!store.review) store.review = {};
  const today = todayStr();
  const cur = store.review[qid];
  if (result === 'bad') {
    store.review[qid] = { stage: 0, due: addDaysStr(today, SRS_INTERVALS[0]) };
  } else if (result === 'fuzzy') {
    const stage = cur ? cur.stage : 0;
    store.review[qid] = { stage: stage, due: addDaysStr(today, SRS_INTERVALS[stage]) };
  } else if (result === 'know' && cur) {
    const next = cur.stage + 1;
    if (next >= SRS_INTERVALS.length) delete store.review[qid];
    else store.review[qid] = { stage: next, due: addDaysStr(today, SRS_INTERVALS[next]) };
  }
}
// 連続学習日数。今日まだ記録がなければ昨日から数える（朝の時点で0日にならないように）
function calcStreak() {
  let streak = 0;
  let cursor = todayStr();
  if (!(store.studySeconds[cursor] > 0)) cursor = addDaysStr(cursor, -1);
  while (store.studySeconds[cursor] > 0) { streak += 1; cursor = addDaysStr(cursor, -1); }
  return streak;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function activePlaylist() {
  if (!activePlaylistId) return null;
  return (store.playlists || []).find(p => p.id === activePlaylistId) || null;
}
function questionInAnyPlaylist(qid) {
  return (store.playlists || []).some(p => p.qids.indexOf(qid) >= 0);
}

function buildQueue() {
  let pool = questions.filter(q => filter === 'all' || q.subject === filter);
  if (weakOnly) pool = pool.filter(q => store.weak.includes(q.id));
  if (customOnly) pool = pool.filter(q => q.id.indexOf('custom-') === 0);
  const pl = activePlaylist();
  if (pl) {
    // プレイリスト再生時は登録順（qids の並び）を基準にし、shuffle 設定のときだけ混ぜる
    const byId = {};
    pool.forEach(q => { byId[q.id] = q; });
    pool = pl.qids.map(id => byId[id]).filter(Boolean);
    if (pl.shuffle !== false) pool = shuffle(pool);
  } else {
    pool = shuffle(pool);
  }
  // 復習キュー：通常フィードのときだけ、期限が来た問題を先頭に出す（2026-11-25）。
  // 「苦手だけ復習」・自作だけ・プレイリストとは対象の決め方が違うため競合させない
  // （それらのモードでは復習キューの先頭寄せはしない）。
  let reviewSet = new Set();
  if (!pl && !weakOnly && !customOnly) {
    const due = new Set(dueReviewIds());
    const duePool = pool.filter(q => due.has(q.id));
    if (duePool.length) {
      const rest = pool.filter(q => !due.has(q.id));
      pool = shuffle(duePool).concat(rest);
      reviewSet = new Set(duePool.map(q => q.id));
    }
  }
  queue = pool.map(q => ({ qid: q.id, attempt: 0, state: 'pending', revealed: false, result: '', review: reviewSet.has(q.id) }));
  currentIdx = 0;
  sessionJudged = 0;
  sessionByResult = { know: 0, fuzzy: 0, bad: 0 };
  chunkShown = 0;
  sessionEnded = false;
  resetStopwatch();
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
  const isCustom = q.id.indexOf('custom-') === 0;
  const inAnyPl = questionInAnyPlaylist(q.id);
  const answerHtml = entry.revealed
    ? '<div class="answer-box"><span class="answer-label">答え</span><p class="answer-text">' + escapeHtml(q.answer) + '</p></div>'
    : '<p class="tap-hint">タップすると答えが見られるよ</p>';
  return '' +
    '<div class="card">' +
      '<div class="card-scroll">' +
        '<span class="subject-chip subject-' + q.subject + '">' + (SUBJECT_LABEL[q.subject] || q.subject) + '</span>' +
        (isCustom ? ' <span class="subject-chip subject-custom">自作</span>' : '') +
        (entry.review ? ' <span class="subject-chip subject-review">🔁 復習</span>' : '') +
        '<span class="card-count">' + (idx + 1) + ' / ' + queue.length + ' 問目</span>' +
        '<p class="card-label">問題</p>' +
        '<p class="card-question' + (isWord ? ' is-word' : '') + '">' + escapeHtml(q.question) + '</p>' +
        (isWord ? '<p class="card-sub">この単語の意味は？</p>' : '') +
        answerHtml +
      '</div>' +
      '<div class="rail">' +
        '<button type="button" class="rail-btn rail-btn-why" data-act="explain" aria-label="解説"><span class="rail-icon">📖</span>解説</button>' +
        '<button type="button" class="rail-btn' + (weakOn ? ' is-on' : '') + '" data-act="weak" aria-label="苦手マーク"><span class="rail-icon">🔖</span>苦手</button>' +
        '<button type="button" class="rail-btn' + (inAnyPl ? ' is-on' : '') + '" data-act="playlist" aria-label="プレイリストに追加"><span class="rail-icon">📋</span>リスト</button>' +
        '<button type="button" class="rail-btn rail-btn-speak" data-act="speak" aria-label="問題を読み上げる"><span class="rail-icon">🔊</span>読む</button>' +
      '</div>' +
    '</div>';
}

function render(keepScroll) {
  suppressNav = true;
  if (observer) observer.disconnect();
  if (queue.length === 0) {
    const pl = activePlaylist();
    // 問題が1問もない教科（数学・理科・国語など）は「準備中」と明示する（2026-11-25 科目タブの土台）
    const preparing = filter !== 'all' && !questions.some(q => q.subject === filter);
    feedEl.innerHTML = '<p class="feed-message">' + (pl
      ? '「' + pl.name + '」には問題がまだありません。\n問題カードの「リスト」ボタンから追加できます。'
      : customOnly
      ? '自作問題がまだありません。\n設定の「自作問題の登録・管理」から追加できます。'
      : weakOnly
      ? '苦手マークの問題がまだありません。\n問題カードの「苦手」ボタンでマークできます。'
      : preparing
      ? '「' + (SUBJECT_LABEL[filter] || filter) + '」の問題は準備中です。\nもう少し待ってね。他の教科は今まで通り解けます。'
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
  // 描画後1秒は「落ち着き待ち」にする。読み込み直後はブラウザ側の表示確定（ツールバーの
  // アニメーション等）で監視報告が乱れやすく、そのまま取り込むと開始直後に問題が飛ぶ（2026-11-22）。
  // この間は suppressNav の分岐（スクロールの意思があるときだけ取り込む）が効く
  setTimeout(() => { suppressNav = false; }, 1000);
}

function pendingCount() { return queue.filter(e => e.state === 'pending').length; }

function syncPlaylistBadge() {
  const badge = document.getElementById('playlistBadge');
  const nameEl = document.getElementById('playlistBadgeName');
  const pl = activePlaylist();
  if (!badge) return;
  badge.hidden = !pl;
  if (pl && nameEl) nameEl.textContent = pl.name;
}

// 苦手だけ復習中は画面上部にピルを常時表示する（2026-11-25 キュー#4）。
// ピル自体が「全問題に戻る」ボタンになる（プレイリストのバッジと同じ流儀）。
const weakBadge = document.getElementById('weakBadge');
function syncWeakBadge() {
  if (!weakBadge) return;
  weakBadge.hidden = !weakOnly;
}

function syncAll() {
  statDone.textContent = sessionJudged;
  statLeft.textContent = pendingCount();
  statWeak.textContent = store.weak.length;
  const total = sessionJudged + pendingCount();
  progressFill.style.width = total ? Math.round(sessionJudged / total * 100) + '%' : '0%';
  syncPlaylistBadge();
  syncWeakBadge();
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
// 実際にスクロールするつもりの操作（指のドラッグ／ホイール）があった時刻。
// タップだけではスクロール扱いしない（タップ起因のスナップずれで次へ進む不具合の対策, 2026-11-22）
let lastNavIntentAt = 0;
let touchStartY = null;
let touchMaxDelta = 0;
feedEl.addEventListener('touchstart', ev => {
  touchStartY = ev.touches[0].clientY;
  touchMaxDelta = 0;
}, { passive: true });
feedEl.addEventListener('touchmove', ev => {
  if (touchStartY === null) return;
  const d = Math.abs(ev.touches[0].clientY - touchStartY);
  if (d > touchMaxDelta) touchMaxDelta = d;
  if (touchMaxDelta > 12) lastNavIntentAt = Date.now();
}, { passive: true });
feedEl.addEventListener('touchend', () => { touchStartY = null; }, { passive: true });
feedEl.addEventListener('wheel', () => { lastNavIntentAt = Date.now(); }, { passive: true });
feedEl.addEventListener('pointermove', ev => { if (ev.buttons) lastNavIntentAt = Date.now(); }, { passive: true });
function onCurrentChange(idx) {
  if (sessionEnded) return;
  if (idx === currentIdx) { syncFooter(); return; }
  // 再描画・位置合わせ直後の報告は、そのまま現在位置として取り込まない（問題が飛ぶ原因になる）。
  // スワイプの勢いが続いているときだけ取り込み、それ以外は現在の問題へ整列し直す
  if (suppressNav) {
    if (Date.now() - lastNavIntentAt <= 1000) currentIdx = idx; else realignFeed();
    syncFooter();
    return;
  }
  // スクロールが落ち着いてから確定させる（通過しただけのスライドで並び替えない）
  if (navTimer) clearTimeout(navTimer);
  navTimer = setTimeout(() => commitNav(idx), 140);
}
function commitNav(idx) {
  if (idx === currentIdx || sessionEnded) { syncFooter(); return; }
  // 直近にスクロール操作がなければ、タップ等でスナップ位置がずれただけとみなし、移動しない
  if (Date.now() - lastNavIntentAt > 1000) { realignFeed(); syncFooter(); return; }
  const prev = queue[currentIdx];
  const leavingIdx = currentIdx;
  currentIdx = idx;
  // 判定しないまま通り過ぎた問題は、キューの一番後ろに戻す。ただし答えを
  // 見た問題はその場に残し、戻って判定できるようにする（2026-11-25 キュー#4）。
  // 並び替えはDOM全体の再描画ではなく、該当スライドだけを末尾へ移動する。
  if (prev && prev.state === 'pending' && !prev.revealed && leavingIdx < queue.length - 1) {
    queue.splice(leavingIdx, 1);
    queue.push(prev);
    if (currentIdx > leavingIdx) currentIdx -= 1;
    const slideEl = feedEl.children[leavingIdx];
    if (slideEl && slideEl.classList.contains('slide')) {
      feedEl.appendChild(slideEl);
      renumberSlides(leavingIdx);
      suppressNavBriefly();
      realignFeed();
    } else {
      render(true);
      return;
    }
    syncFooter();
    return;
  }
  syncFooter();
}

/* ===== 並び替えの surgical DOM 操作（2026-11-25 キュー#4・カクつき対策） ===== */
// キューの並び替え・再出題のたびにDOM全体を作り直すと120枚のスライドを描き直すため、
// 該当スライドだけを移動・挿入する。要素の移動では IntersectionObserver の
// 監視は外れないので、新規挿入の要素だけ observe し直す。
function renumberSlides(fromIdx) {
  const slides = feedEl.children;
  for (let i = fromIdx; i < slides.length; i++) {
    const sl = slides[i];
    if (!sl.classList || !sl.classList.contains('slide')) continue;
    sl.dataset.idx = String(i);
    const cc = sl.querySelector('.card-count');
    if (cc) cc.textContent = (i + 1) + ' / ' + queue.length + ' 問目';
  }
}
function refreshCardScroll(el) {
  if (!el) return;
  el.classList.toggle('can-scroll', el.scrollHeight > el.clientHeight + 2);
}
function suppressNavBriefly() {
  suppressNav = true;
  setTimeout(() => { suppressNav = false; }, 1000);
}
function insertSlideAt(entry, idx) {
  const sec = document.createElement('section');
  sec.className = 'slide';
  sec.dataset.idx = String(idx);
  sec.innerHTML = slideHtml(entry, idx);
  const ref = feedEl.children[idx];
  if (ref) feedEl.insertBefore(sec, ref); else feedEl.appendChild(sec);
  renumberSlides(idx);
  refreshCardScroll(sec.querySelector('.card-scroll'));
  if (observer) observer.observe(sec);
}
function revealSlideAnswer(slide, entry) {
  const q = questionById(entry.qid);
  const cardScroll = slide.querySelector('.card-scroll');
  if (!cardScroll || !q) return;
  const box = document.createElement('div');
  box.className = 'answer-box';
  const label = document.createElement('span');
  label.className = 'answer-label';
  label.textContent = '答え';
  const text = document.createElement('p');
  text.className = 'answer-text';
  text.textContent = q.answer;
  box.appendChild(label);
  box.appendChild(text);
  const hint = cardScroll.querySelector('.tap-hint');
  if (hint) cardScroll.replaceChild(box, hint); else cardScroll.appendChild(box);
  refreshCardScroll(cardScroll);
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
    if (railBtn.dataset.act === 'playlist') openPlaylistPicker(entry);
    if (railBtn.dataset.act === 'speak') speakQuestion(entry);
    return;
  }
  if (idx !== currentIdx) return;
  if (!entry.revealed && entry.state === 'pending') {
    entry.revealed = true;
    ga('reveal', { subject: questionById(entry.qid).subject });
    // 答えの表示は該当スライドだけをその場で書き換える（全体の再描画はしない・2026-11-25）
    revealSlideAnswer(slide, entry);
    syncFooter();
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
  scheduleReview(qid, result); // 復習キュー（間隔反復）の予定も同じタイミングで更新する
  saveStore();

  sessionJudged += 1;
  sessionByResult[result] += 1;
  ga('judge', { subject: questionById(qid).subject, result: result });

  // 再出題：ダメだった・あいまいは間隔をあけてキューの後方へ再挿入
  // 挿入は該当スライドだけをDOMに追加する（全体の再描画はしない・2026-11-25）
  if ((result === 'bad' || result === 'fuzzy') && entry.attempt < MAX_REQUEUE) {
    const iv = INTERVALS[store.settings.interval] || INTERVALS.normal;
    const offset = result === 'bad' ? iv.bad : iv.fuzzy;
    const insertAt = Math.min(currentIdx + offset, queue.length);
    const newEntry = { qid: qid, attempt: entry.attempt + 1, state: 'pending', revealed: false, result: '' };
    queue.splice(insertAt, 0, newEntry);
    insertSlideAt(newEntry, insertAt);
  }

  syncAll();

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
  if (!resultsOverlay.hidden) return; // 二重表示を防ぐ（時間の二重加算も防ぐ）
  const secs = commitStopwatch();
  const todayTotal = store.studySeconds[todayStr()] || 0;
  ga('session_time', { seconds: secs });
  document.getElementById('resultsText').textContent =
    '解いた問題：' + sessionJudged + '問\n覚えてた ' + sessionByResult.know + '問／あいまい ' + sessionByResult.fuzzy +
    '問／ダメだった ' + sessionByResult.bad + '問\n苦手マーク：' + store.weak.length + '件' +
    '\n学習時間：' + formatDurationJa(secs) + '（今日の合計：' + formatDurationJa(todayTotal) + '）';
  document.getElementById('resultsWeak').disabled = store.weak.length === 0;
  // 苦手だけ・自作だけのセッションで終わったときだけ「全問題に戻る」を出す（2026-11-25 キュー#4）
  document.getElementById('resultsAll').hidden = !(weakOnly || customOnly);
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
  activePlaylistId = null;
  weakOnly = true;
  syncWeakModeBtn();
  buildQueue();
  render(false);
});
document.getElementById('resultsAll').addEventListener('click', () => {
  resultsOverlay.hidden = true;
  activePlaylistId = null;
  weakOnly = false;
  customOnly = false;
  syncWeakModeBtn();
  syncCustomModeBtn();
  buildQueue();
  render(false);
});

/* ===== 教科タブ ===== */
document.getElementById('tabs').addEventListener('click', ev => {
  const tab = ev.target.closest('[data-filter]');
  if (!tab) return;
  filter = tab.dataset.filter;
  activePlaylistId = null; // 教科タブを切り替えるとプレイリストのセッションは終わる
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('is-active', t === tab));
  buildQueue();
  render(false);
});

/* ===== 設定 ===== */
const settingsOverlay = document.getElementById('settingsOverlay');
const weakModeBtn = document.getElementById('weakModeBtn');
const customModeBtn = document.getElementById('customModeBtn');
function syncIntervalSeg() {
  document.querySelectorAll('#intervalSeg button').forEach(b =>
    b.classList.toggle('is-active', b.dataset.interval === store.settings.interval));
}
function syncWeakModeBtn() {
  weakModeBtn.textContent = '苦手だけ復習：' + (weakOnly ? 'オン' : 'オフ');
  weakModeBtn.classList.toggle('is-on', weakOnly);
}
function syncCustomModeBtn() {
  customModeBtn.textContent = '自作だけ解く：' + (customOnly ? 'オン' : 'オフ');
  customModeBtn.classList.toggle('is-on', customOnly);
}
function renderStudyLog() {
  const el = document.getElementById('studyLogList');
  if (!el) return;
  const days = Object.keys(store.studySeconds).filter(d => store.studySeconds[d] > 0).sort().reverse();
  el.innerHTML = '';
  if (!days.length) { el.textContent = 'まだ記録がありません'; return; }
  const total = days.reduce((a, d) => a + store.studySeconds[d], 0);
  const head = document.createElement('div');
  head.className = 'study-log-row study-log-total';
  const hs = document.createElement('span'); hs.textContent = '合計';
  const hv = document.createElement('span'); hv.textContent = formatDurationJa(total);
  head.appendChild(hs); head.appendChild(hv);
  el.appendChild(head);
  days.slice(0, 14).forEach(d => {
    const p = d.split('-');
    const row = document.createElement('div');
    row.className = 'study-log-row';
    const ds = document.createElement('span'); ds.textContent = Number(p[1]) + '月' + Number(p[2]) + '日';
    const vs = document.createElement('span'); vs.textContent = formatDurationJa(store.studySeconds[d]);
    row.appendChild(ds); row.appendChild(vs);
    el.appendChild(row);
  });
}
document.getElementById('settingsBtn').addEventListener('click', () => {
  syncIntervalSeg();
  syncWeakModeBtn();
  syncCustomModeBtn();
  syncTtsBtn();
  syncCustomCount();
  syncPlaylistCount();
  renderStudyLog();
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
  activePlaylistId = null;
  syncWeakModeBtn();
  settingsOverlay.hidden = true;
  buildQueue();
  render(false);
});
customModeBtn.addEventListener('click', () => {
  customOnly = !customOnly;
  activePlaylistId = null;
  syncCustomModeBtn();
  settingsOverlay.hidden = true;
  buildQueue();
  render(false);
});

/* ===== 自作問題の登録・管理（2026-11-20 キュー#2） ===== */
// 形式は questions.json と同じ {id, subject, question, answer, explanation}。
// id は 'custom-' + 時刻 + 乱数で公式問題（eng-/soc-）と衝突しない。
// プレイリスト（キュー#3）・塾の問題登録（B2B (3)）ともこの形式を共有する想定。
let customSubject = 'english';
const customOverlay = document.getElementById('customOverlay');
const customQuestionInput = document.getElementById('customQuestion');
const customAnswerInput = document.getElementById('customAnswer');
const customExplainInput = document.getElementById('customExplain');
const customError = document.getElementById('customError');
const CUSTOM_PLACEHOLDERS = {
  english: { q: '例：apple', a: '例：りんご', e: '例：an apple a day keeps the doctor away.（なくてもOK）' },
  social: { q: '例：明治維新が起きたのは何年？', a: '例：1868年', e: '例：江戸幕府が終わり、明治政府が始まった出来事。（なくてもOK）' },
  math: { q: '例：3x + 5 = 14 の x の値は？', a: '例：3', e: '例：移項すると 3x = 9、両辺を3で割って x = 3。（なくてもOK）' },
  science: { q: '例：水を電気分解すると、2種類の気体ができる。何と何？', a: '例：水素と酸素', e: '例：水素：酸素 = 2：1 の体積比で出てくる。（なくてもOK）' },
  japanese: { q: '例：「美しい」は何という品詞？', a: '例：形容詞', e: '例：「い」で終わり、ものの様子を表す言葉。（なくてもOK）' }
};

function syncCustomCount() {
  const n = (store.customQuestions || []).length;
  const c1 = document.getElementById('customCount');
  const c2 = document.getElementById('customListCount');
  if (c1) c1.textContent = n;
  if (c2) c2.textContent = n;
}
function syncCustomSubjectSeg() {
  document.querySelectorAll('#customSubjectSeg button').forEach(b =>
    b.classList.toggle('is-active', b.dataset.subject === customSubject));
  const ph = CUSTOM_PLACEHOLDERS[customSubject];
  customQuestionInput.placeholder = ph.q;
  customAnswerInput.placeholder = ph.a;
  customExplainInput.placeholder = ph.e;
}
function renderCustomList() {
  const el = document.getElementById('customList');
  el.innerHTML = '';
  const list = store.customQuestions || [];
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'custom-empty';
    p.textContent = 'まだ登録がありません。テストや模試で間違えた問題からどうぞ。';
    el.appendChild(p);
    return;
  }
  list.forEach(q => {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const chip = document.createElement('span');
    chip.className = 'subject-chip subject-' + q.subject;
    chip.textContent = SUBJECT_LABEL[q.subject] || q.subject;
    const qt = document.createElement('span');
    qt.className = 'custom-q';
    qt.textContent = q.question + ' → ' + q.answer;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'custom-del';
    del.textContent = '削除';
    del.addEventListener('click', () => deleteCustomQuestion(q.id));
    row.appendChild(chip);
    row.appendChild(qt);
    row.appendChild(del);
    el.appendChild(row);
  });
}
function openCustom() {
  syncCustomSubjectSeg();
  renderCustomList();
  syncCustomCount();
  customError.hidden = true;
  customOverlay.hidden = false;
}
function closeCustom() { customOverlay.hidden = true; }
function refreshQueueIfIdle() {
  // まだ1問も判定していないセッションなら、その場でキューを作り直して反映する。
  // 解いている途中は今のセッションを壊さないよう、次セッションから反映する。
  if (sessionJudged === 0 && !sessionEnded) {
    buildQueue();
    render(false);
  }
}
function addCustomQuestion() {
  const question = customQuestionInput.value.trim();
  const answer = customAnswerInput.value.trim();
  const explanation = customExplainInput.value.trim();
  if (!question || !answer) { customError.hidden = false; return; }
  customError.hidden = true;
  const q = {
    id: 'custom-' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
    subject: customSubject,
    question: question,
    answer: answer,
    explanation: explanation
  };
  store.customQuestions.push(q);
  questions.push(q);
  saveStore();
  ga('custom_add', { subject: q.subject });
  customQuestionInput.value = '';
  customAnswerInput.value = '';
  customExplainInput.value = '';
  renderCustomList();
  syncCustomCount();
  refreshQueueIfIdle();
}
function deleteCustomQuestion(qid) {
  store.customQuestions = (store.customQuestions || []).filter(q => q.id !== qid);
  questions = questions.filter(q => q.id !== qid);
  // プレイリストに入っていた場合も一緒に外す
  (store.playlists || []).forEach(pl => {
    const i = pl.qids.indexOf(qid);
    if (i >= 0) pl.qids.splice(i, 1);
  });
  saveStore();
  ga('custom_delete', {});
  renderCustomList();
  syncCustomCount();
  refreshQueueIfIdle();
}
document.getElementById('customBtn').addEventListener('click', () => {
  settingsOverlay.hidden = true;
  openCustom();
});
document.getElementById('customClose').addEventListener('click', closeCustom);
customOverlay.addEventListener('click', ev => { if (ev.target === customOverlay) closeCustom(); });
document.getElementById('customSubjectSeg').addEventListener('click', ev => {
  const btn = ev.target.closest('[data-subject]');
  if (!btn) return;
  customSubject = btn.dataset.subject;
  syncCustomSubjectSeg();
});
document.getElementById('customAddBtn').addEventListener('click', addCustomQuestion);

/* ===== プレイリスト（生徒版・2026-11-21 キュー#3） ===== */
// 形式は {id, name, qids: [], shuffle}。qids は公式・自作を問わず問題 id の配列。
// shuffle はプレイリスト単位の出題順設定（true=シャッフル／false=登録順）。未設定（旧データ）は true 扱い。
// 塾側の宿題配信（B2B (2)）も「塾が作ったプレイリストを配る」形でこの形式を共有する想定。
const playlistOverlay = document.getElementById('playlistOverlay');
const playlistPickOverlay = document.getElementById('playlistPickOverlay');
const playlistNameInput = document.getElementById('playlistName');
const playlistError = document.getElementById('playlistError');
const playlistPickNameInput = document.getElementById('playlistPickName');
const playlistPickError = document.getElementById('playlistPickError');
let pickEntry = null; // ピッカーで追加対象にしている問題エントリ

function playlistById(id) { return (store.playlists || []).find(p => p.id === id) || null; }
function syncPlaylistCount() {
  const n = (store.playlists || []).length;
  const el = document.getElementById('playlistCount');
  if (el) el.textContent = n;
}
function newPlaylistId() {
  return 'pl-' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
}
function createPlaylist(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { error: '名前を入れてください。' };
  if ((store.playlists || []).some(p => p.name === trimmed)) return { error: '同じ名前のプレイリストがあります。' };
  const pl = { id: newPlaylistId(), name: trimmed, qids: [], shuffle: true };
  store.playlists.push(pl);
  saveStore();
  ga('playlist_create', {});
  syncPlaylistCount();
  return { playlist: pl };
}
function deletePlaylist(id) {
  const wasActive = activePlaylistId === id;
  store.playlists = (store.playlists || []).filter(p => p.id !== id);
  if (wasActive) activePlaylistId = null;
  saveStore();
  ga('playlist_delete', {});
  syncPlaylistCount();
  renderPlaylistList();
  // 再生中のプレイリストを消したときだけキューを作り直す（解いている途中は壊さない）
  if (wasActive) { buildQueue(); render(false); }
}
function renderPlaylistList() {
  const el = document.getElementById('playlistList');
  el.innerHTML = '';
  const list = store.playlists || [];
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'custom-empty';
    p.textContent = 'まだプレイリストがありません。「テスト範囲」「苦手な英単語」など、解きたい問題のセットを作れます。';
    el.appendChild(p);
    return;
  }
  list.forEach(pl => {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.className = 'custom-q';
    name.textContent = pl.name + '（' + pl.qids.length + '問）' + (pl.id === activePlaylistId ? ' ▶解いている' : '');
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'playlist-play';
    play.textContent = '解く';
    play.disabled = pl.qids.length === 0;
    play.addEventListener('click', () => playPlaylist(pl.id));
    const shuf = document.createElement('button');
    shuf.type = 'button';
    shuf.className = 'playlist-toggle' + (pl.shuffle !== false ? ' is-on' : '');
    shuf.textContent = 'シャッフル ' + (pl.shuffle !== false ? 'ON' : 'OFF');
    shuf.addEventListener('click', () => togglePlaylistShuffle(pl.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'custom-del';
    del.textContent = '削除';
    del.addEventListener('click', () => deletePlaylist(pl.id));
    row.appendChild(name);
    row.appendChild(play);
    row.appendChild(shuf);
    row.appendChild(del);
    el.appendChild(row);
  });
}
function togglePlaylistShuffle(id) {
  const pl = playlistById(id);
  if (!pl) return;
  pl.shuffle = !(pl.shuffle !== false);
  saveStore();
  ga('playlist_shuffle', { on: pl.shuffle });
  renderPlaylistList();
}
function openPlaylistManager() {
  syncPlaylistCount();
  renderPlaylistList();
  playlistError.hidden = true;
  playlistOverlay.hidden = false;
}
function closePlaylistManager() { playlistOverlay.hidden = true; }
function playPlaylist(id) {
  const pl = playlistById(id);
  if (!pl || !pl.qids.length) return;
  activePlaylistId = id;
  weakOnly = false;
  customOnly = false;
  syncWeakModeBtn();
  syncCustomModeBtn();
  // プレイリストは教科をまたぐので、教科フィルターは「すべて」に戻す
  filter = 'all';
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('is-active', t.dataset.filter === 'all'));
  ga('playlist_play', { count: pl.qids.length });
  closePlaylistManager();
  settingsOverlay.hidden = true;
  buildQueue();
  render(false);
}
function exitPlaylistMode() {
  activePlaylistId = null;
  buildQueue();
  render(false);
}
function openPlaylistPicker(entry) {
  pickEntry = entry;
  renderPlaylistPicker();
  playlistPickError.hidden = true;
  playlistPickOverlay.hidden = false;
}
function closePlaylistPicker() { playlistPickOverlay.hidden = true; pickEntry = null; }
function renderPlaylistPicker() {
  const el = document.getElementById('playlistPickList');
  el.innerHTML = '';
  const list = store.playlists || [];
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'custom-empty';
    p.textContent = 'まだプレイリストがありません。下の欄から新しく作れます。';
    el.appendChild(p);
    return;
  }
  list.forEach(pl => {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.className = 'custom-q';
    name.textContent = pl.name + '（' + pl.qids.length + '問）';
    const inPl = pickEntry && pl.qids.indexOf(pickEntry.qid) >= 0;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'playlist-toggle' + (inPl ? ' is-on' : '');
    toggle.textContent = inPl ? '追加済み ✓' : '追加する';
    toggle.addEventListener('click', () => togglePlaylistMembership(pl.id));
    row.appendChild(name);
    row.appendChild(toggle);
    el.appendChild(row);
  });
}
function togglePlaylistMembership(plId) {
  if (!pickEntry) return;
  const pl = playlistById(plId);
  if (!pl) return;
  const i = pl.qids.indexOf(pickEntry.qid);
  if (i >= 0) { pl.qids.splice(i, 1); ga('playlist_remove', {}); }
  else { pl.qids.push(pickEntry.qid); ga('playlist_add', {}); }
  saveStore();
  renderPlaylistPicker();
  // カードの「リスト」ボタンの表示も合わせる
  const railBtn = feedEl.querySelector('.slide[data-idx="' + currentIdx + '"] [data-act="playlist"]');
  if (railBtn) railBtn.classList.toggle('is-on', questionInAnyPlaylist(pickEntry.qid));
  // 再生中のプレイリストへの変更で、まだ判定前ならキューに反映する
  if (plId === activePlaylistId) refreshQueueIfIdle();
}
document.getElementById('playlistBtn').addEventListener('click', () => {
  settingsOverlay.hidden = true;
  openPlaylistManager();
});
document.getElementById('playlistClose').addEventListener('click', closePlaylistManager);
playlistOverlay.addEventListener('click', ev => { if (ev.target === playlistOverlay) closePlaylistManager(); });
document.getElementById('playlistCreateBtn').addEventListener('click', () => {
  const res = createPlaylist(playlistNameInput.value);
  if (res.error) { playlistError.textContent = res.error; playlistError.hidden = false; return; }
  playlistError.hidden = true;
  playlistNameInput.value = '';
  renderPlaylistList();
});
document.getElementById('playlistPickClose').addEventListener('click', closePlaylistPicker);
playlistPickOverlay.addEventListener('click', ev => { if (ev.target === playlistPickOverlay) closePlaylistPicker(); });
document.getElementById('playlistPickCreateBtn').addEventListener('click', () => {
  const res = createPlaylist(playlistPickNameInput.value);
  if (res.error) { playlistPickError.textContent = res.error; playlistPickError.hidden = false; return; }
  playlistPickError.hidden = true;
  playlistPickNameInput.value = '';
  // 作ったプレイリストに今の問題をそのまま追加する
  if (pickEntry) { res.playlist.qids.push(pickEntry.qid); saveStore(); ga('playlist_add', {}); }
  renderPlaylistPicker();
});
document.getElementById('playlistBadge').addEventListener('click', exitPlaylistMode);

// 苦手だけ復習中のバッジをタップすると、通常フィードへ戻る（2026-11-25 キュー#4）
function exitWeakMode() {
  weakOnly = false;
  syncWeakModeBtn();
  buildQueue();
  render(false);
}
if (weakBadge) weakBadge.addEventListener('click', exitWeakMode);

/* ===== 音声読み上げ（端末TTS・2026-11-25） ===== */
// 端末の SpeechSynthesis で問題文を読む。自動再生はせず、設定でオンにしたときだけ
// カードに「🔊 読む」ボタンが出て、押したときだけ読み上げる（声質・対応は端末依存）。
function speakQuestion(entry) {
  const q = questionById(entry.qid);
  if (!q || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(q.question);
    // 英単語は英語の声で、その他の教科は日本語で読む
    u.lang = q.subject === 'english' ? 'en-US' : 'ja-JP';
    u.rate = q.subject === 'english' ? 0.9 : 1.0;
    window.speechSynthesis.speak(u);
    ga('tts_speak', { subject: q.subject });
  } catch (e) { /* 読み上げできない環境では何もしない */ }
}
const ttsBtn = document.getElementById('ttsBtn');
function syncTtsBtn() {
  if (!ttsBtn) return;
  const on = !!(store.settings && store.settings.tts);
  ttsBtn.textContent = '音声読み上げ：' + (on ? 'オン' : 'オフ');
  ttsBtn.classList.toggle('is-on', on);
  feedEl.classList.toggle('tts-on', on);
}
if (ttsBtn) ttsBtn.addEventListener('click', () => {
  if (!store.settings) store.settings = { interval: 'normal', tts: false };
  store.settings.tts = !store.settings.tts;
  saveStore();
  syncTtsBtn();
  ga('tts_toggle', { on: store.settings.tts ? 1 : 0 });
});

/* ===== 教科タブの生成（2026-11-25 科目タブの土台） ===== */
// タブは SUBJECTS レジストリから作る。教科が増えてもHTMLを書き換えなくてよい。
function buildTabs() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  nav.innerHTML = '';
  const mk = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (filter === key ? ' is-active' : '');
    b.dataset.filter = key;
    b.textContent = label;
    return b;
  };
  nav.appendChild(mk('all', 'すべて'));
  SUBJECTS.forEach(s => nav.appendChild(mk(s.key, s.label)));
}

/* ===== 記録専用画面（2026-11-25） ===== */
// フィードで解かずに、学習の見える化（週間グラフ・連続日数）と履歴・復習予定だけを見る画面。
const recordsOverlay = document.getElementById('recordsOverlay');
function fmtMin(totalSeconds) { return Math.round(totalSeconds / 60); }
function renderRecords() {
  const body = document.getElementById('recordsBody');
  if (!body) return;
  body.innerHTML = '';
  const today = todayStr();
  const days = Object.keys(store.studySeconds).filter(d => store.studySeconds[d] > 0).sort().reverse();
  const totalSecs = days.reduce((a, d) => a + store.studySeconds[d], 0);
  const todaySecs = store.studySeconds[today] || 0;
  let weekSecs = 0;
  for (let i = 0; i < 7; i++) weekSecs += store.studySeconds[addDaysStr(today, -i)] || 0;
  const judgedTotal = Object.keys(store.answers || {}).reduce((a, k) => a + (store.answers[k].count || 0), 0);

  const addRow = (label, value, cls) => {
    const row = document.createElement('div');
    row.className = 'study-log-row' + (cls ? ' ' + cls : '');
    const a = document.createElement('span'); a.textContent = label;
    const b = document.createElement('span'); b.textContent = value;
    row.appendChild(a); row.appendChild(b);
    body.appendChild(row);
  };
  const addLabel = text => {
    const p = document.createElement('p');
    p.className = 'setting-label';
    p.textContent = text;
    body.appendChild(p);
  };

  addLabel('つづき具合');
  addRow('🔥 連続学習日数', calcStreak() + '日', 'study-log-total');
  addRow('今日の学習時間', formatDurationJa(todaySecs));
  addRow('今週（直近7日）の合計', formatDurationJa(weekSecs));
  addRow('累計の学習時間', formatDurationJa(totalSecs));
  addRow('判定した回数（累計）', judgedTotal + '回');
  addRow('苦手マーク', store.weak.length + '件');

  // 週間グラフ：直近7日の学習時間（分）を棒グラフで出す
  addLabel('今週のグラフ（学習時間）');
  const week = [];
  let maxMin = 0;
  for (let i = 6; i >= 0; i--) {
    const d = addDaysStr(today, -i);
    const mins = fmtMin(store.studySeconds[d] || 0);
    week.push({ date: d, mins: mins });
    if (mins > maxMin) maxMin = mins;
  }
  const chart = document.createElement('div');
  chart.className = 'week-chart';
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  week.forEach(w => {
    const p = w.date.split('-').map(Number);
    const col = document.createElement('div');
    col.className = 'week-col';
    const min = document.createElement('span');
    min.className = 'week-min';
    min.textContent = w.mins ? w.mins + '分' : '';
    const wrap = document.createElement('div');
    wrap.className = 'week-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'week-bar' + (w.date === today ? ' is-today' : '');
    bar.style.height = w.mins ? Math.max(8, Math.round(w.mins / (maxMin || 1) * 100)) + '%' : '2px';
    wrap.appendChild(bar);
    const day = document.createElement('span');
    day.className = 'week-day';
    day.textContent = p[1] + '/' + p[2] + '(' + DOW[new Date(p[0], p[1] - 1, p[2]).getDay()] + ')';
    col.appendChild(min); col.appendChild(wrap); col.appendChild(day);
    chart.appendChild(col);
  });
  body.appendChild(chart);

  // 復習キューの予定
  addLabel('復習キュー');
  const enrolled = Object.keys(store.review || {}).filter(qid => questionById(qid));
  const dueNow = dueReviewIds().filter(qid => questionById(qid));
  addRow('今日の復習', dueNow.length + '問');
  addRow('復習中の問題（全部）', enrolled.length + '問');
  if (enrolled.length) {
    const nextDue = enrolled.map(qid => store.review[qid].due).filter(Boolean).sort()[0];
    if (nextDue && dueNow.length === 0) {
      const p = nextDue.split('-').map(Number);
      addRow('次の復習日', p[1] + '月' + p[2] + '日');
    }
  }

  // 日別の履歴
  addLabel('履歴');
  if (!days.length) {
    const p = document.createElement('p');
    p.className = 'custom-empty';
    p.textContent = 'まだ記録がありません。フィードで勉強すると、ここに残ります。';
    body.appendChild(p);
  } else {
    const list = document.createElement('div');
    list.className = 'study-log';
    days.slice(0, 30).forEach(d => {
      const p = d.split('-').map(Number);
      const row = document.createElement('div');
      row.className = 'study-log-row';
      const a = document.createElement('span');
      a.textContent = p[0] + '年' + p[1] + '月' + p[2] + '日';
      const b = document.createElement('span');
      b.textContent = formatDurationJa(store.studySeconds[d]);
      row.appendChild(a); row.appendChild(b);
      list.appendChild(row);
    });
    body.appendChild(list);
  }
}
function openRecords() {
  renderRecords();
  if (recordsOverlay) recordsOverlay.hidden = false;
}
function closeRecords() { if (recordsOverlay) recordsOverlay.hidden = true; }
const recordsBtn = document.getElementById('recordsBtn');
if (recordsBtn) recordsBtn.addEventListener('click', openRecords);
const recordsClose = document.getElementById('recordsClose');
if (recordsClose) recordsClose.addEventListener('click', closeRecords);
if (recordsOverlay) recordsOverlay.addEventListener('click', ev => { if (ev.target === recordsOverlay) closeRecords(); });

/* ===== 記録リセット ===== */
const confirmOverlay = document.getElementById('confirmOverlay');
document.getElementById('resetBtn').addEventListener('click', () => { confirmOverlay.hidden = false; });
document.getElementById('confirmCancel').addEventListener('click', () => { confirmOverlay.hidden = true; });
document.getElementById('confirmReset').addEventListener('click', () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 何もしない */ }
  location.reload();
});

/* ===== 初回注意バー =====
   仕様（2026-11-26 本人の不具合報告で統一）：
   - 出すのは「本当の初回」だけ。過去の訪問・学習データが端末に残っている
     （＝初回ではない）端末には出さない。
   - ×で閉じたら二度と出さない。本体ストアの noticeDismissed と、専用キー
     NOTICE_KEY の両方に記録し、どちらか残っていれば非表示を維持する。
   - バナーは通常フロー内の静的表示（fixed/sticky ではない）で、閉じれば
     そのぶんフィードが広がる。 */
const noticeBar = document.getElementById('noticeBar');
function noticeIsDismissed() {
  if (store.noticeDismissed) return true;
  try { return localStorage.getItem(NOTICE_KEY) === '1'; } catch (e) { return false; }
}
const hasPriorHistory = Boolean(store.lastVisitDate)
  || Object.keys(store.answers).length > 0
  || Object.keys(store.studySeconds).length > 0
  || (store.customQuestions && store.customQuestions.length > 0);
if (!noticeIsDismissed() && !hasPriorHistory) noticeBar.hidden = false;
document.getElementById('noticeClose').addEventListener('click', () => {
  noticeBar.hidden = true;
  store.noticeDismissed = true;
  try { localStorage.setItem(NOTICE_KEY, '1'); } catch (e) { /* 保存できない環境では今回の表示だけ閉じる */ }
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
  buildTabs();   // 教科タブは SUBJECTS レジストリから生成する
  syncTtsBtn();  // 音声読み上げの設定をフィードへ反映する

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
    // 自作問題を公式問題に混ぜる（同じ形式なので判定・再出題・苦手マークがそのまま使える）
    if (store.customQuestions && store.customQuestions.length) {
      const known = new Set(questions.map(q => q.id));
      store.customQuestions.forEach(q => { if (!known.has(q.id)) questions.push(q); });
    }
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
