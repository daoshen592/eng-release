/* 背单词：卡片 + FSRS 间隔复习（vendor/ts-fsrs.umd.js，与句子侧同一调度器）
 * 数据：data/words.js（window.WORDS），进度存 localStorage
 *
 * ── 契约 ─────────────────────────────────────────────
 * 依赖：window.WORDS · window.WORDIMG（配图名单）· window.AUDIO_EXTRA（预合成音频）
 *       window.FSRS（vendor/ts-fsrs.umd.js）· window.Store · window.WordSearch
 * 导出：window.WordBook = { start, finish, dueCount }（app.js 调起）
 * 回首页：window.WordBookHome（app.js 定义，惰性调用须 && 守卫 —— app 加载在后）
 */
(function () {
  "use strict";

  const KEY = "srs.v2"; // 由 profile.js 按档案加前缀
  const F = window.FSRS;
  const SCHED = F.fsrs(
    F.generatorParameters({ enable_fuzz: true, enable_short_term: false, request_retention: 0.9 })
  );
  const MAX_IVAL = 365; // 天封顶：再熟的词一年也要回来见一面
  /* 一轮多少词：跟随首页「本轮数量」（Store 的 size：20 / 50 / all）。
     2026-11-08 之前这里是写死的 20，用户要求与首页一致。 */
  function roundSize() {
    let v = "20";
    try {
      v = Store.get("size") || "20";
    } catch (_) { /* 无 Store 时按 20 */ }
    if (v === "all") return Infinity;
    const n = Number(v);
    return n > 0 ? n : 20;
  }
  const LEVEL_CN = {
    all: "所有", primary: "小学", g7: "初一", g8: "初二", g9: "初三",
    g10: "高一", g11: "高二", g12: "高三",
  };

  let queue = [];
  let pos = 0;
  let level = "primary";
  let revealed = false;
  let cur = null;
  let stat = { ok: 0, again: 0, spOk: 0, spBad: 0 };
  let audioEl = null;
  let autoTimer = 0;
  let counts = { due: 0, fresh: 0 };
  let mode = "card"; // card 卡片记忆 | spell 拼写补全 | search 查词
  let spell = null; // 当前拼写题：{ chars, pos, answer, typed, checked }
  let missed = []; // 本轮拼错的词
  // 有配图的词名单（data/wordimg.js 生成，图在 img/w/<k>.webp）
  // IMGVER：配图内容重画但文件名不变，靠这个查询串让浏览器/HTTP 缓存换新；图有更新就改这里
  const IMGVER = "20261108a";
  let IMGSET = null;
  try {
    if (window.WORDIMG) IMGSET = new Set(window.WORDIMG.split(","));
  } catch (_) {
    IMGSET = null;
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- 存储 ---------- */
  function readStore() {
    try {
      return JSON.parse(Store.get(KEY) || "{}");
    } catch (_) {
      return {};
    }
  }
  function writeStore(v) {
    try {
      Store.set(KEY, JSON.stringify(v));
    } catch (_) {}
  }

  /* ---------- 音频 ---------- */
  function stopSay() {
    clearTimeout(autoTimer);
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.currentTime = 0;
      } catch (_) {}
      audioEl = null;
    }
    try {
      speechSynthesis.cancel();
    } catch (_) {}
  }
  function tts(text) {
    if (!("speechSynthesis" in window) || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    u.rate = 0.9;
    speechSynthesis.speak(u);
  }
  /* 预合成音频表（data/audio_extra.js）：没有真人录音的词/短语走这里，避免手机中文语音包读不出英文 */
  const EXTRA = (window.AUDIO_EXTRA && window.AUDIO_EXTRA.words) ? window.AUDIO_EXTRA : { chunks: {}, words: {} };
  function normKey(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").replace(/\s+/g, " ").trim();
  }

  function say(word) {
    if (!word) return;
    stopSay();
    const src = EXTRA.words[normKey(word.w)];
    const playExtra = () => {
      if (!src) { tts(word.w); return; }
      audioEl = new Audio("audio/" + src);
      audioEl.play().catch(() => tts(word.w));
    };
    if (word.a) {
      // a 指向的真人录音可能缺文件（word-atlas 映射悬空）→ 合成音 → 系统 TTS
      audioEl = new Audio("audio/w/" + word.a + ".mp3");
      audioEl.play().catch(playExtra);
      return;
    }
    playExtra();
  }

  /* 拼写模式把焦点还给输入框：点「听一遍」「提示」这类按钮后别让键盘收起来。
     移动端要在 click 手势内同步调用才允许唤起键盘，所以别放进 setTimeout。 */
  function focusSpell() {
    if (mode !== "spell") return;
    const inp = $("wInput");
    if (inp && !inp.disabled) {
      try {
        inp.focus({ preventScroll: true });
      } catch (_) {}
    }
  }

  /* ---------- 队列 ---------- */
  function shuffle(a) {
    const x = a.slice();
    for (let i = x.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
  }

  /* 难度可以是单个 key，也可以是数组（首页难度支持多选） */
  function levelLabel(lv) {
    const keys = Array.isArray(lv) ? lv : [lv];
    const txt = keys.map((k) => LEVEL_CN[k] || "").filter(Boolean).join("+");
    return txt || "小学";
  }

  /* 卡片的有效年级：归属学段 + 出处里出现过的册次
     （三上…六下 → 小学，七上/七下 → 初一，八上/八下 → 初二，九上/九下 → 初三）。
     一个词四年级学过、八年级教材里又出现，那么只选「小学」或只选「初二」都该刷到它。
     进度按词 key 存，同词进多个池共用一条复习记录，不会重复计数。 */
  const BOOK_LV = {
    "三": "primary", "四": "primary", "五": "primary", "六": "primary",
    "七": "g7", "八": "g8", "九": "g9",
  };
  function levelSetOf(w) {
    const set = new Set();
    if (w.l) set.add(w.l);
    const u = w.u || "";
    const re = /([三四五六七八九])([上下])[US]?\d+/g;
    let m;
    while ((m = re.exec(u))) {
      const lv = BOOK_LV[m[1]];
      if (lv) set.add(lv);
    }
    return set;
  }

  function poolWords(lv) {
    const all = (window.WORDS && window.WORDS.words) || [];
    const keys = Array.isArray(lv) ? lv : [lv];
    const seen = new Set(); // 跨级重复的词只保留一次
    if (keys.includes("all")) {
      return all.filter((w) => (seen.has(w.k) ? false : (seen.add(w.k), true)));
    }
    const set = new Set(keys);
    const out = [];
    all.forEach((w) => {
      if (seen.has(w.k)) return;
      for (const l of levelSetOf(w)) {
        if (!set.has(l)) continue;
        seen.add(w.k);
        out.push(w);
        return;
      }
    });
    return out;
  }

  function buildQueue(lv, onlyDue) {
    const ROUND = roundSize();
    const all = poolWords(lv);
    const store = readStore();
    const due = [];
    const fresh = [];
    all.forEach((w) => {
      const r = store[w.k];
      if (!r) fresh.push(w);
      else if (isDue(r)) due.push(w);
    });
    counts = { due: due.length, fresh: fresh.length };
    if (onlyDue) return shuffle(due).slice(0, ROUND); // 只复习：全抽待复习词
    const q = shuffle(due).slice(0, ROUND).concat(freshQ(fresh));
    // 都复习完且没有新词时，随机抽一批已学词"提前复习"，避免卡住
    if (!q.length) return shuffle(all).slice(0, ROUND);
    return q.slice(0, ROUND);
  }

  /* 新词怎么抽：高频优先开着 → 按频次分从高到低排队（同分内随机）；
     关着 → 纯随机。频次分来自构建期（语料出现次数 + 题库考点次数 × 2） */
  function freqOn() {
    try {
      return Store.get("wfreq") !== "0";
    } catch (_) {
      return true;
    }
  }
  function freshQ(fresh) {
    const ROUND = roundSize();
    if (!freqOn()) return shuffle(fresh).slice(0, ROUND);
    const byF = new Map();
    fresh.forEach((w) => {
      const f = FREQ.get(w.k) || 0;
      if (!byF.has(f)) byF.set(f, []);
      byF.get(f).push(w);
    });
    const out = [];
    [...byF.keys()]
      .sort((a, b) => b - a)
      .forEach((f) => out.push(...shuffle(byF.get(f))));
    return out.slice(0, ROUND);
  }

  /* 首页「复习待复习」按钮用的计数 */
  function dueCount(lv) {
    const all = poolWords(lv);
    const store = readStore();
    let due = 0;
    let fresh = 0;
    all.forEach((w) => {
      const r = store[w.k];
      if (!r) fresh++;
      else if (isDue(r)) due++;
    });
    return { due, fresh };
  }

  function refreshCounts() {
    const store = readStore();
    let due = 0;
    let fresh = 0;
    poolWords(level).forEach((w) => {
      const r = store[w.k];
      if (!r) fresh++;
      else if (isDue(r)) due++;
    });
    counts = { due, fresh };
    updateHud();
  }

  function updateHud() {
    $("wStat").innerHTML =
      `<span class="wlv">${levelLabel(level)}</span><span class="dot d1"> · </span>` +
      `<button class="due-link" title="只复习待复习的词">待复习 ${counts.due}</button>` +
      `<span class="dot d2"> · </span>新词 ${counts.fresh}` +
      `<span class="dot d3"> · </span>` +
      `<button class="due-link fr-link${freqOn() ? " is-on" : ""}" title="开：新词先背语料和考题里最常见的词">★高频${freqOn() ? "开" : "关"}</button>`;
    $("wTotal").textContent = Math.max(queue.length, 1);
  }

  /* ---------- 渲染 ---------- */
  /* 词形变化表：构建期写在词条上（'v goes went gone going'），同词跨册只存一份，
     这里建 k → fm 的索引，非首次出现的词条也能查到 */
  const FORMS = new Map();
  const FREQ = new Map(); // 词 → 中考频次分（构建期算好），高频优先排序用
  ((window.WORDS && window.WORDS.words) || []).forEach((w) => {
    if (w.fm && !FORMS.has(w.k)) FORMS.set(w.k, w.fm);
    if (!FREQ.has(w.k)) FREQ.set(w.k, Number(w.f) || 0);
  });
  const FM_LABEL = {
    n: ["复数"],
    v: ["三单", "过去式", "过去分词", "现在分词"],
    adj: ["比较级", "最高级"],
    adv: ["比较级", "最高级"],
  };
  const FM_POS = { n: "n.", v: "v.", adj: "adj.", adv: "adv." };
  function formsHtml(s) {
    const a = String(s).split(" ");
    const tag = a[0];
    const labels = FM_LABEL[tag] || [];
    /* 构建期把形式内部空格写成 / 占位（more beautiful → more/beautiful，
       was/were 同槽双形式），这里还原成空格显示 */
    const parts = a.slice(1).map((f, i) => `<span><i>${esc(labels[i] || "")}</i>${esc(f).replace(/\//g, " ")}</span>`);
    return `<b>词形</b><em>${esc(FM_POS[tag] || "")}</em>${parts.join("")}`;
  }

  function render() {
    cur = queue[pos];
    if (!cur) return finish();
    revealed = false;
    spell = null;
    $("wIdx").textContent = pos + 1;
    $("wBarFill").style.width = (pos / queue.length) * 100 + "%";
    $("wFrom").textContent = cur.u || "";
    /* 配图：词 → 图直接联想；没有图的词隐藏图片并还原布局 */
    const img = $("wImg");
    if (IMGSET && IMGSET.has(cur.k)) {
      img.onerror = () => {
        img.hidden = true;
        $("wCard").classList.remove("has-img");
      };
      img.alt = cur.w;
      img.src = "img/w/" + encodeURIComponent(cur.k) + ".webp?v=" + IMGVER;
      img.hidden = false;
      $("wCard").classList.add("has-img");
    } else {
      img.onerror = null;
      img.removeAttribute("src");
      img.hidden = true;
      $("wCard").classList.remove("has-img");
    }
    $("wPos").textContent = cur.p || "";
    $("wZh").textContent = cur.z || "";
    /* 词形变化（构建期生成，见 src/wordforms.py）：同一个词跨册只存一份，按 k 建索引查 */
    const fm = cur.fm || FORMS.get(cur.k);
    if (fm) {
      $("wForms").innerHTML = formsHtml(fm);
      $("wForms").hidden = false;
    } else {
      $("wForms").innerHTML = "";
      $("wForms").hidden = true;
    }
    /* 例句 / 第二例句 / 搭配 / 辨析：卡片和拼写两种模式都随当前词更新
       （拼写模式下这些平时隐藏，答完才显示，所以内容必须是当前词的） */
    if (cur.e) {
      $("wEx").innerHTML = `<b>${esc(cur.e.en)}</b><span>${esc(cur.e.zh)}</span>`;
    } else {
      $("wEx").innerHTML = "";
    }
    const e2 = cur.e2;
    $("wEx2").hidden = !e2;
    if (e2) $("wEx2").innerHTML = `<b>${esc(e2.en)}</b><span>${esc(e2.zh)}</span>`;
    const col = cur.col || [];
    $("wCol").hidden = !col.length;
    if (col.length) {
      $("wCol").innerHTML = col
        .map((c) => {
          const i = String(c).indexOf("｜");
          const en = i < 0 ? c : c.slice(0, i);
          const zh = i < 0 ? "" : c.slice(i + 1);
          return `<span>${esc(en)}<i>${esc(zh)}</i></span>`;
        })
        .join("");
    }
    $("wDisc").hidden = !cur.tip;
    $("wDisc").textContent = cur.tip ? "💡 " + cur.tip : "";

    $("wCard").classList.remove("revealed", "done", "flipping", "flip-in");
    $("wCard").classList.toggle("spell", mode === "spell");
    $("wGrade").classList.remove("on");
    $("wNext").hidden = true;
    $("wFeed").textContent = "";
    $("wFeed").className = "wfeed";

    if (mode === "spell") return renderSpell();

    $("wSpell").hidden = true;
    $("wWord").textContent = cur.w;
    $("wIpa").textContent = cur.i || "";
    $("wReveal").hidden = false;
    $("wHint").textContent = "看清单词，按空格翻面";
    $("wKbd").textContent = "空格 翻面 · 1 不认识 / 2 认识 · Esc 退出";
    stopSay();
    autoTimer = setTimeout(() => say(cur), 400);
  }

  /* ---------- 拼写补全：出题 ---------- */
  /* 随机挖掉若干字母（首字母永远保留），返回题面结构 */
  function spellOf(word) {
    const chars = String(word).split("");
    const pos = [];
    chars.forEach((c, i) => {
      if (/[A-Za-z]/.test(c) && i > 0) pos.push(i); // 首字母留着，认词更容易
    });
    if (!pos.length && chars.length) pos.push(0);
    const total = pos.length;
    let n = total <= 2 ? 1 : total <= 4 ? 2 : total <= 7 ? 3 : total <= 10 ? 4 : 5;
    n = Math.min(n, Math.max(1, Math.round(total * 0.6)), total); // 至少留 4 成字母可见
    const pick = shuffle(pos).slice(0, n).sort((a, b) => a - b);
    return {
      chars,
      pos: pick,
      answer: pick.map((i) => chars[i]).join("").toLowerCase(),
      typed: "",
      hints: new Set(), // 被「提示」揭开的空位序号
      checked: false,
    };
  }

  /* 题面：缺的字母画线，打进去的显示出来，光标停在下一个空位；提示揭开的字母标金色 */
  function patternHtml(sp, typed, hints) {
    let k = 0;
    let html = "";
    sp.chars.forEach((c, i) => {
      if (sp.pos.indexOf(i) < 0) {
        html += `<span class="sl${/[A-Za-z]/.test(c) ? "" : " sep"}">${esc(c)}</span>`;
        return;
      }
      const idx = k++;
      const t = typed[idx] || "";
      const cls = ["sl", t ? "fill" : "gap"];
      if (hints && hints.has(idx)) cls.push("hint");
      if (!t && idx === typed.length) cls.push("cur");
      html += `<span class="${cls.join(" ")}">${esc(t || c)}</span>`;
    });
    return html;
  }

  /* 判分后的题面：对的绿、错的红 */
  function resultHtml(sp, typed) {
    let k = 0;
    let html = "";
    sp.chars.forEach((c, i) => {
      if (sp.pos.indexOf(i) < 0) {
        html += `<span class="sl${/[A-Za-z]/.test(c) ? "" : " sep"}">${esc(c)}</span>`;
        return;
      }
      const t = typed[k] || "";
      k++;
      const ok = t.toLowerCase() === c.toLowerCase();
      html += `<span class="sl fill ${ok ? "good" : "bad"}">${esc(t || c)}</span>`;
    });
    return html;
  }

  function renderSpell() {
    spell = spellOf(cur.w);
    $("wWord").innerHTML = patternHtml(spell, "");
    $("wIpa").textContent = cur.i || "";
    $("wReveal").hidden = true;
    $("wSpell").hidden = false;
    const inp = $("wInput");
    inp.value = "";
    inp.disabled = false;
    inp.maxLength = spell.pos.length;
    $("wTip").hidden = false;
    $("wTip").disabled = false;
    $("wTip").textContent = "💡 提示 · 补一个字母";
    $("wFeed").className = "wfeed";
    $("wFeed").textContent = `${spell.pos.length} 个字母待补全`;
    $("wHint").textContent = "补全缺少的字母，按 Enter 检查";
    $("wKbd").textContent = "Enter 检查 / 下一题 · Ctrl+H 提示 · Esc 退出";
    stopSay();
    autoTimer = setTimeout(() => say(cur), 500);
    setTimeout(() => {
      try {
        inp.focus({ preventScroll: true });
      } catch (_) {}
    }, 60);
  }

  /* 提示：按顺序揭开下一个空位的正确字母；用过提示的这题不延长复习间隔 */
  function hintSpell() {
    if (mode !== "spell" || !spell || spell.checked) return;
    const inp = $("wInput");
    const typed = String(inp.value || "").replace(/[^A-Za-z]/g, "");
    if (typed.length >= spell.pos.length) {
      $("wFeed").className = "wfeed";
      $("wFeed").textContent = "已经填满了，按 Enter 检查";
      return;
    }
    const idx = typed.length;
    const letter = spell.chars[spell.pos[idx]];
    spell.hints.add(idx);
    const next = typed + letter;
    inp.value = next;
    $("wWord").innerHTML = patternHtml(spell, next, spell.hints);
    $("wFeed").className = "wfeed";
    $("wFeed").textContent = `已提示 ${spell.hints.size} 个字母 · 这题不会延长复习间隔`;
    return next;
  }

  function checkSpell() {
    if (!spell || spell.checked || !cur) return;
    const val = String($("wInput").value || "").replace(/[^A-Za-z]/g, "");
    if (!val) {
      $("wFeed").className = "wfeed";
      $("wFeed").textContent = "先输入缺少的字母，或点「提示」";
      return;
    }
    spell.typed = val;
    spell.checked = true;
    const ok = val.toLowerCase() === spell.answer;
    const usedHint = spell.hints.size > 0;
    $("wWord").innerHTML = resultHtml(spell, val);
    $("wInput").disabled = true;
    $("wTip").disabled = true;
    $("wCard").classList.add("done");
    $("wFeed").className = "wfeed " + (ok ? "ok" : "bad");
    $("wFeed").textContent = ok
      ? `✓ 拼对了　${cur.w}${usedHint ? "（用了提示，下次还会考）" : ""}`
      : `✗ 正确拼写是 ${cur.w}（缺的字母：${spell.answer}）`;
    $("wHint").textContent = "看结果，按 Enter 下一题";
    $("wNext").hidden = false;

    const key = cur.k;
    if (ok) {
      stat.spOk++;
      stat.ok++;
      applyGrade(key, usedHint ? 3 : 2); // 用了提示：盒子不动，隔一阵再考
    } else {
      stat.spBad++;
      stat.again++;
      applyGrade(key, 0);
      missed.push(cur.w);
      const store = readStore();
      const rec = store[key] || {};
      store[key] = Object.assign({}, rec, { sw: (Number(rec.sw) || 0) + 1 });
      writeStore(store);
    }
    refreshCounts();
    say(cur);
  }

  function nextSpell() {
    if (!spell || !spell.checked) return checkSpell();
    pos++;
    if (pos >= queue.length) return finish();
    render();
  }

  function reveal() {
    if (!cur || revealed) return;
    revealed = true;
    const card = $("wCard");
    card.classList.add("flipping");
    setTimeout(() => {
      card.classList.add("revealed");
      $("wReveal").hidden = true;
      $("wGrade").classList.add("on");
      $("wHint").textContent = "记住了吗？按 1 不认识 · 2 认识";
      card.classList.remove("flipping");
      card.classList.add("flip-in");
      setTimeout(() => card.classList.remove("flip-in"), 260);
    }, 170);
  }

  /* 把评价写进 FSRS 存储（卡片模式和拼写模式共用同一份进度）
     g: 2 认识=Good / 0 不认识=Again / 1 有点模糊=Hard / 3 不动不排程 */
  function revCard(c) {
    c.due = new Date(c.due);
    if (c.last_review) c.last_review = new Date(c.last_review);
    return c;
  }
  function applyGrade(key, g) {
    if (g === 3) return readStore()[key] || null;
    const store = readStore();
    const now = new Date();
    let card = store[key] ? revCard(store[key]) : F.createEmptyCard(now);
    card = SCHED.next(card, now, g === 2 ? F.Rating.Good : g === 1 ? F.Rating.Hard : F.Rating.Again).card;
    if (g === 0) {
      // 不认识的词当天还要再见到（"只复习"按到期取词）
      card.due = new Date(now.getTime() + 5 * 60000);
    } else {
      if ((card.due - now) / 86400000 > MAX_IVAL) {
        card.due = new Date(now.getTime() + MAX_IVAL * 86400000);
      }
      // 下限 1 天：认识/模糊的词当天不该又变"待复习"
      if (Math.floor(card.due.getTime() / 86400000) <= Math.floor(now.getTime() / 86400000)) {
        card.due = new Date(now.getTime() + 86400000);
      }
    }
    store[key] = card;
    writeStore(store);
    return store[key];
  }
  /* 到期判定：FSRS 的 due 是时刻，按"天序号"比今天 */
  function isDue(r) {
    if (!r || !r.due) return true;
    return Math.floor(new Date(r.due).getTime() / 86400000) <= Math.floor(Date.now() / 86400000);
  }

  function grade(g) {
    if (!cur) return;
    if (!revealed) {
      reveal();
      return;
    }
    if (g === 2) stat.ok++;
    else stat.again++;
    applyGrade(cur.k, g === 2 ? 2 : 0);
    refreshCounts();

    pos++;
    if (pos >= queue.length) return finish();
    render();
  }

  function finish() {
    stopSay();
    const sp = mode === "spell";
    $("wCard").hidden = true;
    $("wReveal").hidden = true;
    $("wNext").hidden = true;
    $("wGrade").classList.remove("on");
    $("wDone").classList.add("on");
    $("wDone").classList.toggle("spell", sp);
    $("wLbl0").textContent = sp ? "拼对" : "认识";
    $("wLbl2").textContent = sp ? "拼错" : "不认识";
    $("wOk").textContent = sp ? stat.spOk : stat.ok;
    $("wAgain").textContent = sp ? stat.spBad : stat.again;
    if (sp && missed.length) {
      $("wMiss").innerHTML = `<b>拼错 ${missed.length} 个</b> · ${missed.slice(0, 12).map(esc).join(" · ")}`;
      $("wMiss").hidden = false;
    } else {
      $("wMiss").hidden = true;
    }
    $("wHint").textContent = "本轮结束";
    $("wBarFill").style.width = "100%";
  }

  /* ---------- 模式切换 ---------- */
  function syncModeChips() {
    const box = $("wModes");
    if (!box) return;
    [...box.children].forEach((b) => b.classList.toggle("is-on", b.dataset.wm === mode));
  }
  function setMode(m) {
    if (!["card", "spell", "search"].includes(m) || m === mode) return;
    mode = m;
    if (m !== "search") {           // 查词是随手工具，不当作下次进入的模式记住
      try {
        Store.set("wmode", m);
      } catch (_) {}
    }
    syncModeChips();

    if (m === "search") {
      stopSay();
      $("wDone").classList.remove("on");
      $("wCard").hidden = true;
      $("wActions").hidden = true;
      $("wSearch").hidden = false;
      $("wHint").textContent = "输入英文或中文，点结果打开该词的卡片";
      $("wKbd").textContent = "Enter 打开第一条 · Esc 返回卡片";
      window.WordSearch && window.WordSearch.open();
      return;
    }

    window.WordSearch && window.WordSearch.close();
    $("wSearch").hidden = true;
    $("wCard").hidden = false;
    $("wActions").hidden = false;
    if (queue.length && pos < queue.length && !$("wDone").classList.contains("on")) {
      stopSay();
      render();
    } else {
      $("wHint").textContent = m === "spell" ? "点「再来一轮」开始拼写" : "点「再来一轮」开始";
    }
  }

  /* 查词结果 → 打开该词的卡片。
     把它插进队列当前位置，既不打断原有进度，也能用「下一题」继续往后背 */
  function pickWord(w) {
    if (!w || !w.k) return;
    mode = "card";
    try {
      Store.set("wmode", "card");
    } catch (_) {}
    syncModeChips();
    window.WordSearch && window.WordSearch.close();
    $("wSearch").hidden = true;
    $("wCard").hidden = false;
    $("wActions").hidden = false;
    $("wDone").classList.remove("on");
    if (!queue.length) {
      queue = [w];
      pos = 0;
    } else if (pos >= queue.length) {
      queue.push(w);
      pos = queue.length - 1;
    } else {
      queue.splice(pos, 0, w);
    }
    render();
    if (!revealed) reveal(); // 查词就是要看释义，直接翻面
    updateHud();
  }


  /* ---------- 对外 ---------- */
  function start(lv, onlyDue) {
    if (Array.isArray(lv)) {
      const keys = lv.filter((k) => LEVEL_CN[k]);
      level = keys.length ? keys : ["primary"];
    } else {
      level = LEVEL_CN[lv] ? lv : "primary";
    }
    stat = { ok: 0, again: 0, spOk: 0, spBad: 0 };
    missed = [];
    queue = buildQueue(level, onlyDue);
    if (onlyDue && !queue.length) queue = buildQueue(level, false); // 没有待复习就按正常规则来
    pos = 0;
    if (mode === "search") mode = "card"; // 从查词模式进新一轮 → 回到卡片
    syncModeChips();
    $("wSearch").hidden = true;
    $("wCard").hidden = false;
    $("wActions").hidden = false;
    $("wDone").classList.remove("on");
    $("wCard").hidden = false;
    $("wReveal").hidden = false;
    $("wNext").hidden = true;
    updateHud();
    render();
  }

  window.WordBook = { start, finish, dueCount };


  /* ---------- 绑定 ---------- */
  try {
    const saved = Store.get("wmode");
    if (saved === "spell") mode = "spell";
  } catch (_) {}
  syncModeChips();

  $("wModes").addEventListener("click", (e) => {
    const btn = e.target.closest(".wmode");
    if (btn) setMode(btn.dataset.wm);
  });
  /* 查词结果 → 打开该词的卡片（search.js 负责搜索，这里负责展示） */
  if (window.WordSearch) window.WordSearch.onPick(pickWord);
  $("wInput").addEventListener("input", () => {
    if (!spell || spell.checked) return;
    const inp = $("wInput");
    const v = String(inp.value || "")
      .replace(/[^A-Za-z]/g, "")
      .slice(0, spell.pos.length);
    inp.value = v;
    // 退格删掉的提示位不再标金
    [...spell.hints].forEach((i) => {
      if (i >= v.length) spell.hints.delete(i);
    });
    $("wWord").innerHTML = patternHtml(spell, v, spell.hints);
  });
  $("wInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (spell && spell.checked) nextSpell();
      else checkSpell();
      return;
    }
    // Ctrl+H / F1 也能叫提示，手不用离开键盘
    if (e.key === "F1" || (e.ctrlKey && String(e.key).toLowerCase() === "h")) {
      e.preventDefault();
      hintSpell();
    }
  });
  $("wTip").addEventListener("click", () => {
    hintSpell();
    focusSpell();
  });
  $("wNext").addEventListener("click", nextSpell);
  $("wReveal").addEventListener("click", reveal);
  /* 听一遍：鼠标按下时不让按钮抢焦点（否则拼写模式的输入框立刻失焦），
     点完再兜一次底——移动端 tap 不走 mousedown，靠这里在手势内把焦点要回来 */
  $("wSay").addEventListener("mousedown", (e) => e.preventDefault());
  $("wSay").addEventListener("click", () => {
    say(cur);
    focusSpell();
  });
  $("wCard").addEventListener("click", (e) => {
    if (mode === "spell") {
      // 拼写模式点卡片（不是按钮）只是重新聚焦输入框，别把答案翻出来
      if (!e.target.closest("button, input")) focusSpell();
      return;
    }
    reveal();
  });
  $("wStat").addEventListener("click", (e) => {
    // 点「待复习 N」→ 只复习这批词
    if (e.target.closest(".due-link") && counts.due > 0 && !e.target.closest(".fr-link")) start(level, true);
    // 点「★高频」→ 切换高频优先，下一轮生效（不打断本轮）
    if (e.target.closest(".fr-link")) {
      try {
        Store.set("wfreq", freqOn() ? "0" : "1");
      } catch (_) {}
      updateHud();
      $("wHint").textContent = freqOn() ? "高频优先已开，下一轮生效" : "高频优先已关，下一轮生效";
    }
  });
  $("wGrade").addEventListener("click", (e) => {
    const btn = e.target.closest(".gbtn");
    if (!btn) return;
    grade(Number(btn.dataset.g));
  });
  $("wAgainBtn").addEventListener("click", () => start(level));
  $("wHomeBtn").addEventListener("click", () => window.WordBookHome && window.WordBookHome());

  /* 重置进度：点一次变「再点一次确认」，3 秒内再点才真清——避免误触清掉整学期记录 */
  let resetTimer = 0;
  const resetBtn = $("wReset");
  function disarmReset() {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = 0;
    resetBtn.textContent = "重置进度";
    resetBtn.classList.remove("is-armed");
  }
  resetBtn.addEventListener("click", () => {
    if (!resetTimer) {
      resetBtn.textContent = "再点一次确认";
      resetBtn.classList.add("is-armed");
      resetTimer = setTimeout(disarmReset, 3000);
      return;
    }
    disarmReset();
    Store.set(KEY, "{}"); // 只清当前档案的背词记录（Leitner 盒子 + 拼写错误次数）
    counts = { due: 0, fresh: 0 };
    start(level);
  });

  document.addEventListener("keydown", (e) => {
    if (!$("words").classList.contains("is-on")) return;
    if (e.key === "Escape") {
      if (mode === "search") {
        // 查词模式下 Esc 只是回到卡片，不直接退到首页
        e.preventDefault();
        setMode("card");
        return;
      }
      stopSay();
      window.WordBookHome && window.WordBookHome();
      return;
    }
    if (mode === "search") return; // 查词模式：按键交给搜索框自己处理
    if (mode === "spell") {
      if (e.target && e.target.id === "wInput") return; // 输入框里的按键交给输入框自己处理
      if (e.key === "Enter") {
        e.preventDefault();
        if (spell && spell.checked) nextSpell();
        else checkSpell();
        return;
      }
      /* 焦点万一被抢走（点了页面别处之类），直接敲字母也能接上：
         keydown 里再聚焦，字符不会自动落到新焦点元素，所以手动补一位 */
      if (/^[A-Za-z]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const inp = $("wInput");
        if (inp && !inp.disabled && spell && !spell.checked && !$("wCard").classList.contains("done")) {
          e.preventDefault();
          focusSpell();
          inp.value = (String(inp.value || "") + e.key).slice(0, spell.pos.length);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      return;
    }
    if (e.key === " " || e.code === "Space" || e.key === "Enter") {
      e.preventDefault();
      if ($("wDone").classList.contains("on")) return; // 完成态用按钮，防误触
      if (revealed) {
        grade(2);
      } else {
        reveal();
      }
      return;
    }
    if (["1", "2", "3"].includes(e.key)) {
      // 去掉了「模糊」档：1 不认识，2/3 都算认识（3 是老习惯键位）
      e.preventDefault();
      grade(e.key === "1" ? 0 : 2);
    }
  });
})();

