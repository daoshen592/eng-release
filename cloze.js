/**
 * 完形填空 · 独立模块（data/clozes.js，源头 src/cloze/*.json，python build_cloze.py 生成）
 *
 * 与首页设置完全解耦：
 *   - 难度：本模块自带年级多选（初一/初二/初三），存 Store 的 cloze.levels
 *   - 题量：一轮一篇（10 空），无题量选项
 *   - 抽题：没做过的篇先随机轮一遍（绝不重复），全轮完后按错题热度加权随机（cloze.prog），不读首页 level/size/order
 * 判分：逐空即时判定（选完即对错），错空进错空重做池（cloze.wrong，按空记）。
 *
 * ── 契约 ─────────────────────────────────────────────
 * 依赖：window.CLOZES（题库）· window.Store（cloze.levels/prog/wrong 三键）
 *       window.WORDS 可选（点词查义，缺失只禁用查词不报错）
 * 导出：window.__CLOZE（调试 / 冒烟测试句柄）
 * 加载序：Store 之后即可；入口按钮 #openCloze（首页），一轮一篇不读首页 level/size
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const ITEMS = (window.CLOZES && window.CLOZES.items) || [];
  const LEVELS = [["g7", "初一"], ["g8", "初二"], ["g9", "初三"]];
  const K_LEVELS = "cloze.levels";
  const K_PROG = "cloze.prog";
  const K_WRONG = "cloze.wrong";
  const SCORE_EACH = 1.5; // 湖南卷：每小题 1.5 分

  const S = {
    levels: [],          // 本模块自己的年级多选
    prog: {},            // {pieceId: {o,w,t}} 篇级战绩
    wrong: {},           // {pieceId: [num,...]} 错空重做池
    list: [],            // 本轮篇目
    i: 0,                // 当前篇下标
    answers: {},         // 当前篇 {num: "A"}
    cur: 0,              // 当前空题号
    ok: 0,
    bad: 0,
    hints: 0,            // 本篇用了几次提示
    redo: false,         // 本轮是否错空重做
    judged: false,       // 当前篇是否已全部判完
  };

  /* ---------- Store 读写（都在本模块自己的键里，不碰首页设置） ---------- */
  function stGet(k) {
    try { return window.Store ? window.Store.get(k) : null; } catch (e) { return null; }
  }
  function stSet(k, v) {
    try { if (window.Store) window.Store.set(k, v); } catch (e) { /* 纯本地兜底 */ }
  }
  function loadLevels() {
    try { const v = JSON.parse(stGet(K_LEVELS) || "null"); if (Array.isArray(v) && v.length) return v; } catch (e) {}
    return ["g7", "g8", "g9"];
  }
  function loadJson(key, fb) {
    try { const v = JSON.parse(stGet(key) || "null"); return v && typeof v === "object" ? v : fb; } catch (e) { return fb; }
  }

  function saveWrong() {
    const out = {};
    Object.keys(S.wrong).forEach((id) => { if (S.wrong[id].length) out[id] = S.wrong[id]; });
    S.wrong = out;
    stSet(K_WRONG, JSON.stringify(out));
  }

  /* ---------- 题池 ---------- */
  function pool() {
    return ITEMS.filter((it) => S.levels.includes(it.meta.level));
  }
  function pickPiece() {
    const p = pool();
    if (!p.length) return null;
    // 没做过的篇优先随机轮一遍，保证同一篇绝不连续出现
    const fresh = p.filter((it) => !(S.prog[it.id] || {}).t);
    if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
    // 全做过之后：按错题热度加权随机（随机权重放大，避免固定盯一篇）
    const heat = (it) => {
      const pr = S.prog[it.id] || {};
      return (pr.w || 0) * 2 - (pr.o || 0) + Math.random() * 2;
    };
    return p.slice().sort((a, b) => heat(b) - heat(a))[0];
  }
  function wrongPieces() {
    return pool().filter((it) => (S.wrong[it.id] || []).length);
  }

  /* ---------- 屏幕切换 ---------- */
  function goScreen(id) {
    document.querySelectorAll(".screen").forEach((el) => {
      el.classList.toggle("is-on", el.id === id);
    });
  }

  /* ---------- 渲染 ---------- */
  /* ---------- 辅助学习 1：点词查义（用现有词库 data/words.js） ---------- */
  let DICT = null;
  const IRREG = { went: "go", came: "come", said: "say", got: "get", made: "make", took: "take",
    saw: "see", knew: "know", thought: "think", found: "find", gave: "give", told: "tell",
    felt: "feel", left: "leave", began: "begin", kept: "keep", stood: "stand", ran: "run",
    grew: "grow", flew: "fly", broke: "break", brought: "bring", sat: "sit", lost: "lose",
    met: "meet", held: "hold", caught: "catch", wrote: "write", spent: "spend", sent: "send",
    built: "build", heard: "hear", fell: "fall", taught: "teach", led: "lead", won: "win",
    wore: "wear", spoke: "speak", drove: "drive", ate: "eat", drank: "drink", hid: "hide",
    rode: "ride", sold: "sell", understood: "understand", became: "become", meant: "mean",
    paid: "pay", laid: "lay", woke: "wake" };

  function wordBases(w) {
    const out = new Set([w]);
    if (IRREG[w]) out.add(IRREG[w]);
    [["'s", ""], ["ies", "y"], ["ves", "f"], ["es", ""], ["s", ""],
     ["ing", ""], ["ed", ""], ["er", ""], ["est", ""], ["ly", ""]].forEach(([suf, rep]) => {
      if (w.endsWith(suf) && w.length > suf.length + 2) {
        const stem = w.slice(0, -suf.length) + rep;
        out.add(stem);
        if (suf === "ing" || suf === "ed") {
          out.add(stem + "e"); // hoping→hope
          if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) out.add(stem.slice(0, -1)); // stopped→stop
        }
        if (suf === "er" || suf === "est") out.add(stem.replace(/i$/, "y")); // happier→happy
      }
    });
    return out;
  }

  function lookupWord(w) {
    if (!DICT) {
      DICT = new Map();
      ((window.WORDS && window.WORDS.words) || []).forEach((it) => {
        const k = String(it.k || it.w || "").toLowerCase();
        if (k && !DICT.has(k)) DICT.set(k, it);
      });
    }
    const lw = w.toLowerCase();
    for (const b of wordBases(lw)) if (DICT.has(b)) return DICT.get(b);
    return null;
  }

  function lookupTap(word, span) {
    const el = $("czDict");
    const same = el.hidden === false && el.dataset.w === word.toLowerCase();
    document.querySelectorAll("#czPass .czword.on").forEach((s) => s.classList.remove("on"));
    if (same) { el.hidden = true; return; } // 再点同一个词 = 收起
    const e = lookupWord(word);
    el.dataset.w = word.toLowerCase();
    el.textContent = "";
    const head = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = word;
    head.append(b);
    if (e) {
      const ipa = document.createElement("span");
      ipa.className = "czipa";
      ipa.textContent = e.i || "";
      head.append(ipa);
      if (e.p) head.append(document.createTextNode(e.p + " "));
      head.append(document.createTextNode(e.z || ""));
    } else {
      head.append(document.createTextNode("（词库未收录）"));
    }
    el.append(head);
    if (e && e.e && e.e.en) {
      const ex = document.createElement("span");
      ex.className = "czex";
      ex.textContent = e.e.en + (e.e.zh ? "　" + e.e.zh : "");
      el.append(ex);
    }
    el.hidden = false;
    if (span) span.classList.add("on");
  }

  function appendWords(box, text) {
    const re = /[A-Za-z][A-Za-z'-]*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) box.append(document.createTextNode(text.slice(last, m.index)));
      const word = m[0]; // 先捕获，闭包不能引用循环变量 m（exec 跑完为 null）
      const span = document.createElement("span");
      span.className = "czword";
      span.textContent = word;
      span.addEventListener("click", () => lookupTap(word, span));
      box.append(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) box.append(document.createTextNode(text.slice(last)));
  }

  /* ---------- 辅助学习 2：当前空提示 ---------- */
  function hint() {
    if (S.judged || S.answers[S.cur]) return;
    const q = qByNum(S.cur);
    if (!q) return;
    const word = q.options[q.answer] || "";
    const e = word ? lookupWord(word) : null;
    const tail = e && e.z
      ? "释义：" + e.z + " · 以 " + word.charAt(0) + " 开头（" + word.length + " 个字母）"
      : "释义未收录 · 以 " + (word.charAt(0) || "?") + " 开头（" + word.length + " 个字母）";
    showWhy("💡 提示（第 " + S.cur + " 空）\u3000" + tail, false);
    S.hints += 1;
  }

  /* ---------- 辅助学习 3：结算页中英对照（空位填正确答案） ---------- */
  function toggleTrans() {
    const box = $("czTransBox");
    const btn = $("czTrans");
    if (!box || !btn) return;
    if (!box.hidden) { box.hidden = true; btn.textContent = "📝 中英对照"; return; }
    box.textContent = "";
    const p = S.list[S.i];
    const ans = {};
    p.questions.forEach((q) => { ans[q.num] = q.options[q.answer] || ""; });
    const trs = p.trans || [];
    p.passage.forEach((para, i) => {
      // 英文段：空位填答案词并高亮
      const en = document.createElement("p");
      en.className = "czten";
      let last = 0;
      let m;
      const nums = [];
      const re = /___(\d+)___/g;
      while ((m = re.exec(para))) {
        if (m.index > last) en.append(document.createTextNode(para.slice(last, m.index)));
        nums.push(m[1]);
        const b = document.createElement("b");
        b.className = "czfill";
        b.textContent = ans[m[1]] || "____";
        en.append(b);
        last = m.index + m[0].length;
      }
      if (last < para.length) en.append(document.createTextNode(para.slice(last)));
      box.append(en);
      // 中文段：____ 依次填答案词的中文释义（查不到就放英文词）
      const zh = document.createElement("p");
      zh.className = "cztzh";
      let k = 0;
      zh.textContent = (trs[i] || "（本段无译文）").replace(/_{2,}/g, () => {
        const w = ans[nums[k++]] || "";
        const e = w ? lookupWord(w) : null;
        return "「" + (e && e.z ? e.z : w) + "」";
      });
      box.append(zh);
    });
    if (!trs.length) box.append(document.createTextNode("（本篇暂无译文）"));
    box.hidden = false;
    btn.textContent = "📝 收起对照";
  }

  function renderLevels() {
    const box = $("czLevels");
    if (!box) return;
    box.textContent = "";
    const counts = {};
    ITEMS.forEach((it) => { counts[it.meta.level] = (counts[it.meta.level] || 0) + 1; });
    LEVELS.forEach(([k, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "etype" + (S.levels.includes(k) ? " on" : "");
      b.dataset.lv = k;
      b.append(document.createTextNode(label));
      const num = document.createElement("b");
      num.textContent = counts[k] || 0;
      b.append(num);
      b.addEventListener("click", () => {
        const on = S.levels.includes(k);
        if (on && S.levels.length === 1) return; // 至少留一个年级
        S.levels = on ? S.levels.filter((x) => x !== k) : S.levels.concat(k);
        stSet(K_LEVELS, JSON.stringify(S.levels));
        start(); // 年级属于本模块自己的设置，改完立刻换池重开
      });
      box.append(b);
    });
  }

  function blankBtn(num) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cblank";
    b.dataset.num = num;
    b.textContent = String(num);
    return b;
  }

  function renderPassage() {
    const box = $("czPass");
    box.textContent = "";
    const p = S.list[S.i];
    const re = /___(\d+)___/g;
    p.passage.forEach((para, pi) => {
      if (pi) box.append(document.createElement("br"));
    let last = 0;
    let m;
    while ((m = re.exec(para))) {
      if (m.index > last) appendWords(box, para.slice(last, m.index));
      const num = Number(m[1]);
      const b = blankBtn(num);
      b.addEventListener("click", () => tapBlank(num));
      box.append(b);
      last = m.index + m[0].length;
    }
    if (last < para.length) appendWords(box, para.slice(last));
    });
  }

  function qByNum(num) {
    return S.list[S.i].questions.find((q) => q.num === num);
  }

  function renderOptions() {
    const box = $("czOpts");
    box.textContent = "";
    const q = qByNum(S.cur);
    if (!q) return;
    ["A", "B", "C", "D"].slice(0, Object.keys(q.options).length).forEach((L) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "copt";
      b.dataset.l = L;
      const tag = document.createElement("b");
      tag.textContent = L;
      b.append(tag, document.createTextNode(q.options[L]));
      b.addEventListener("click", () => answer(q.num, L));
      box.append(b);
    });
  }

  function showWhy(text, isBad) {
    const el = $("czWhy");
    el.textContent = text;
    el.classList.toggle("is-bad", !!isBad);
    el.hidden = !text;
  }

  function updateHud() {
    const total = S.list[S.i].questions.length;
    const done = Object.keys(S.answers).length;
    $("czBar").style.width = (done / total) * 100 + "%";
    $("czStat").textContent = "对 " + S.ok + " · 错 " + S.bad;
  }

  function markBlank(num, state, word) {
    const b = document.querySelector('#czPass .cblank[data-num="' + num + '"]');
    if (!b) return;
    b.classList.remove("cur", "ok", "bad", "rev");
    b.classList.add(state);
    b.textContent = word || String(num);
  }

  function tapBlank(num) {
    const q = qByNum(num);
    if (!q) return;
    const answered = S.answers[num];
    if (!answered && !S.judged) {
      S.cur = num;                      // 还没答的空：切换当前空
      paintCur();
      renderOptions();
      showWhy("", false);
      return;
    }
    // 已判定的空：看解析（答错后随时回看）
    document.querySelectorAll("#czPass .cblank").forEach((b) => b.classList.remove("cur"));
    document.querySelector('#czPass .cblank[data-num="' + num + '"]').classList.add("rev");
    const chosen = answered && answered !== "-"
      ? answered + ". " + q.options[answered] + "（你的选择）"
      : "（跳过）";
    const head = "第 " + num + " 题 · " + (q.point || "") + "\u3000正确答案：" + q.answer + ". " + q.options[q.answer];
    showWhy(head + "\u3000—\u3000" + (q.analysis || "（本篇暂无解析）") + "\u3000｜\u3000你选了：" + chosen,
      answered !== q.answer);
  }

  function paintCur() {
    document.querySelectorAll("#czPass .cblank").forEach((b) => {
      const n = Number(b.dataset.num);
      b.classList.toggle("cur", n === S.cur && !S.answers[n] && !S.judged);
    });
    // 不做任何自动滚动：篇章完全由用户自己滚，杜绝首行被顶走
  }

  function nextUnanswered() {
    const qs = S.list[S.i].questions;
    return qs.find((q) => !S.answers[q.num]) || null;
  }

  function answer(num, L) {
    if (S.judged || S.answers[num]) return;
    const q = qByNum(num);
    if (!q) return;
    if (L && !q.options[L]) return;
    S.answers[num] = L || "-";
    const good = !!L && L === q.answer;
    if (good) {
      S.ok += 1;
      markBlank(num, "ok", q.options[L]);
      showWhy("✅ 正确 +" + SCORE_EACH + " 分\u3000" + (q.analysis || ""), false);
      // 答对即从错空池销账
      if (S.wrong[S.list[S.i].id]) {
        S.wrong[S.list[S.i].id] = S.wrong[S.list[S.i].id].filter((n) => n !== num);
        saveWrong();
      }
    } else {
      S.bad += 1;
      markBlank(num, "bad", L ? q.options[L] : "—");
      const arr = S.wrong[S.list[S.i].id] || [];
      if (!arr.includes(num)) arr.push(num);
      S.wrong[S.list[S.i].id] = arr;
      saveWrong();
      showWhy("❌ 正确答案：" + q.answer + ". " + q.options[q.answer] +
        "（你选了：" + (L ? L + ". " + q.options[L] : "跳过") + "）\u3000" + (q.analysis || ""), true);
    }
    updateHud();
    const nx = nextUnanswered();
    if (nx) {
      S.cur = nx.num;
      paintCur();
      renderOptions();
    } else {
      finishPiece();
    }
  }

  function finishPiece() {
    S.judged = true;
    paintCur();
    $("czOpts").textContent = "";
    $("czSkip").hidden = true;
    $("czHintBtn").hidden = true;
    // 篇级战绩：全对记 o，否则记 w
    const id = S.list[S.i].id;
    const p = S.prog[id] || { o: 0, w: 0 };
    if (S.bad === 0) p.o += 1; else p.w += 1;
    p.t = Date.now();
    S.prog[id] = p;
    stSet(K_PROG, JSON.stringify(S.prog));
    if (S.i + 1 < S.list.length) {
      $("czNext").hidden = false;
      $("czNext").textContent = "下一篇 · Enter";
      $("czNext").focus();
    } else {
      finishRound();
    }
  }

  function finishRound() {
    $("czCard").hidden = true;
    $("czOpts").hidden = true;
    $("czActions").hidden = true;
    $("czDone").hidden = false;
    const blanks = S.ok + S.bad;
    const score = S.ok * SCORE_EACH;
    const full = blanks * SCORE_EACH;
    $("czScore").textContent = (score % 1 ? score.toFixed(1) : score) + " / " + (full % 1 ? full.toFixed(1) : full);
    const rate = blanks ? Math.round((S.ok / blanks) * 100) : 0;
    $("czSub").textContent = rate >= 90 ? "语感在线，再来一篇保持手感"
      : rate >= 60 ? "错空已进重做池，点「🔁 只练错空」定点补"
        : "先通读全文再下手，答案常藏在前文里";
    if (S.hints) $("czSub").textContent += " · 本篇用了 " + S.hints + " 次提示";
    $("czBar").style.width = "100%";
    $("czRedo").hidden = !wrongPieces().length;
  }

  function nextPiece() {
    if (!S.judged) return;
    S.i += 1;
    if (S.i >= S.list.length) { finishRound(); return; }
    renderPiece();
  }

  function renderPiece() {
    const p = S.list[S.i];
    S.answers = {};
    S.ok = 0;
    S.bad = 0;
    S.hints = 0;
    S.judged = false;
    S.cur = p.questions[0].num;
    $("czPiece").textContent = String(S.i + 1);
    $("czPieces").textContent = String(S.list.length);
    $("czMeta").textContent = p.meta.wordCount + " 词" + (p.meta.topic ? " · " + p.meta.topic : "");
    renderPassage();
    paintCur();
    renderOptions();
    $("czStage").scrollTop = 0; // 整页回顶，防上篇残留滚动把首行顶出
    $("czPass").scrollTop = 0;  // 篇章回顶，首行完整露出
    showWhy("", false);
    $("czCard").hidden = false;
    $("czOpts").hidden = false;
    $("czActions").hidden = false;
    $("czDone").hidden = true;
    $("czSkip").hidden = false;
    $("czNext").hidden = true;
    $("czWhy").hidden = true;
    $("czDict").hidden = true; // 换篇收起查词面板
    const transBox = $("czTransBox");
    if (transBox) { transBox.hidden = true; $("czTrans").textContent = "📝 中英对照"; }
    $("czHintBtn").hidden = false;
    updateHud();
    $("czHint").textContent = (S.redo ? "🔁 错空重做 · " : "") +
      S.levels.map((l) => (LEVELS.find(([k]) => k === l) || ["", l])[1]).join("/") +
      "　共 " + p.questions.length + " 空，选完自动判分";
  }

  /* ---------- 回合 ---------- */
  function buildRound(redo) {
    S.redo = !!redo;
    if (redo) {
      S.list = wrongPieces();
      if (!S.list.length) { S.redo = false; S.list = []; }
    } else {
      const one = pickPiece();
      S.list = one ? [one] : [];
    }
    S.i = 0;
    if (!S.list.length) {
      alert(S.redo ? "错空池是空的，先做完几篇再说" : "选的年级里还没有题库，请先跑 python build_cloze.py");
      return false;
    }
    renderPiece();
    return true;
  }

  function start(redo) {
    if (!ITEMS.length) {
      alert("完形题库还没生成，请先运行 python build_cloze.py");
      return;
    }
    S.levels = loadLevels();
    S.prog = loadJson(K_PROG, {});
    S.wrong = loadJson(K_WRONG, {});
    renderLevels();
    goScreen("cloze");
    buildRound(!!redo);
  }

  function skip() {
    if (S.judged || S.answers[S.cur]) return;
    answer(S.cur, ""); // 无效字母 = 跳过判错
  }

  function quit() {
    if (S.ok + S.bad > 0) finishRound();
    else goScreen("start");
  }

  document.addEventListener("keydown", (e) => {
    if (!$("cloze").classList.contains("is-on")) return;
    if (e.key === "Escape") { e.preventDefault(); quit(); return; }
    if (S.judged) {
      if (e.key === "Enter") { e.preventDefault(); nextPiece(); }
      return;
    }
    const q = qByNum(S.cur);
    if (!q) return;
    const n = Number(e.key);
    if (n >= 1 && n <= Object.keys(q.options).length) {
      e.preventDefault();
      answer(S.cur, "ABCD"[n - 1]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      skip();
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    const btn = $("openCloze");
    if (btn) btn.addEventListener("click", () => start(false));
    const reg = (id, fn) => {
      const el = $(id);
      if (el) el.addEventListener("click", fn);
    };
    reg("czBack", () => goScreen("start"));
    reg("czSkip", skip);
    reg("czHintBtn", hint);
    reg("czTrans", toggleTrans);
    reg("czQuit", quit);
    reg("czNext", nextPiece);
    reg("czAgain", () => buildRound(false));
    reg("czRedo", () => buildRound(true));
    reg("czHome", () => goScreen("start"));
  });

  /* 调试 / 自动化测试句柄 */
  window.__CLOZE = S;
})();
