/**
 * 专项练习 · 三题型
 *   grammar 语法填空——把句中已有的正确变形挖空，括号里给原形（data/forms.js）
 *   first   首字母填空——同一题库，只给首字母和中文提示（多词答案除外）
 *   order   连词成句——句库语块打乱拖拽排序（data/sentences.js 的 chunks）
 * 难度 / 题量 / 抽题规则全部沿用首页设置（Store 的 level / size）。
 *
 * ── 契约 ─────────────────────────────────────────────
 * 依赖：window.SENTENCES（order 题源）· window.FORMS（grammar/first 题源）· window.Store
 *       window.WORDS 可选（词信息兜底，缺失不报错）
 * 导出：window.__EXAM（调试 / 冒烟测试句柄）
 * 加载序：Store 之后即可；入口按钮 #openExam（首页）
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const ITEMS = (window.FORMS && window.FORMS.items) || [];
  const SENT = (window.SENTENCES && window.SENTENCES.sentences) || [];
  const KEY = "examprog";
  const ETYPES = [["grammar", "语法填空"], ["first", "首字母填空"], ["order", "连词成句"]];
  const WHY_ORDER = "先找主语和谓语搭出主干，再按中文意思把修饰语挂上去；标点跟着它所在的语块走。";
  /* 一轮多少题不单独设，跟首页「本轮题量」（20 句 / 50 句 / 全部）保持一致 */
  function readSize(pool) {
    let raw = "20";
    try {
      raw = (window.Store && Store.get("size")) || "20";
    } catch (e) {
      raw = "20";
    }
    if (raw === "all") return pool.length;
    const n = Number(raw);
    return Math.min(Number.isFinite(n) && n > 0 ? n : 20, pool.length);
  }

  const S = { list: [], i: 0, ok: 0, bad: 0, phase: "ask", prog: {}, wrongIds: [], kind: "",
    etype: "grammar", order: [], pick: -1 };

  /* 考点中文名与展示顺序（无提示题在前，主干在前，补充考点在后） */
  const KIND_NAME = {
    art: "冠词", prep: "介词",
    s: "名词复数", 3: "三单", ing: "现在进行时", ger: "动名词", p: "过去式",
    pp: "被动语态", perf: "完成时",
    r: "比较级", t: "最高级", adv: "形容词变副词",
    po: "代词宾格", pa: "形容词性物主", pn: "名词性物主", poss: "名词所有格", ord: "序数词",
    refl: "反身代词", inf: "非谓语 to do", der: "构词法派生", be: "be 动词",
  };
  const KIND_ORDER = ["art", "prep", "s", "3", "ing", "ger", "p", "pp", "perf", "r", "t",
    "adv", "be", "po", "pa", "pn", "poss", "ord", "refl", "inf", "der"];

  function readEtype() {
    try {
      const v = window.Store && Store.get("etype");
      if (ETYPES.some(([k]) => k === v)) return v;
    } catch (e) { /* 忽略 */ }
    return "grammar";
  }

  function saveEtype() {
    if (window.Store) Store.set("etype", S.etype);
  }

  function readLevels() {
    let arr = [];
    try {
      const v = JSON.parse((window.Store && Store.get("level")) || '["primary"]');
      arr = Array.isArray(v) ? v : [v];
    } catch (e) {
      arr = ["primary"];
    }
    return arr.length ? arr : ["primary"];
  }

  function loadProg() {
    try {
      S.prog = JSON.parse((window.Store && Store.get(KEY)) || "{}") || {};
    } catch (e) {
      S.prog = {};
    }
  }

  function saveProg() {
    if (window.Store) Store.set(KEY, JSON.stringify(S.prog));
  }

  function mark(id, good) {
    const p = S.prog[id] || { o: 0, w: 0 };
    if (good) p.o += 1;
    else p.w += 1;
    p.t = Date.now();
    S.prog[id] = p;
    saveProg();
  }

  function levelPool() {
    const levels = readLevels();
    return ITEMS.filter((it) => levels.includes("all") || levels.includes(it.l));
  }

  function currentPool() {
    let base = levelPool();
    if (S.etype === "first") base = base.filter((it) => !it.a.includes(" "));
    return S.kind ? base.filter((it) => it.k === S.kind) : base;
  }

  /* 连词成句池：语块数 4–10，且语块拼回来必须等于原句（防止 build 断块异常） */
  function orderPool() {
    const levels = readLevels();
    const out = [];
    for (const st of SENT) {
      if (!(levels.includes("all") || levels.includes(st.level))) continue;
      if (!st.chunks || st.chunks.length < 4 || st.chunks.length > 10) continue;
      const words = st.chunks.map((g) => g.map((t) => t.t).join(" "));
      if (norm(words.join(" ")) !== norm(st.en)) continue;
      out.push({
        id: "o" + st.id, l: st.level, s: st.en, zh: st.zh,
        a: words, k: "order", b: "", t: WHY_ORDER,
      });
    }
    return out;
  }

  /* 考点统计条：总题数 + 每类多少，点一下就只练这一类 */
  function renderKinds(pool) {
    if (S.etype === "order") { $("exKinds").hidden = true; return; }
    $("exKinds").hidden = false;
    const base = pool || levelPool();
    const cnt = new Map();
    base.forEach((it) => cnt.set(it.k, (cnt.get(it.k) || 0) + 1));
    if (S.kind && !cnt.get(S.kind)) S.kind = "";
    const box = $("exKinds");
    if (!box) return;
    box.textContent = "";
    const add = (key, label, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ekind" + (S.kind === key ? " on" : "");
      b.dataset.k = key;
      b.append(document.createTextNode(label));
      const num = document.createElement("b");
      num.textContent = n;
      b.append(num);
      b.addEventListener("click", () => {
        S.kind = S.kind === key ? "" : key;
        start();
      });
      box.append(b);
    };
    add("", "全部", base.length);
    KIND_ORDER.forEach((k) => {
      if (cnt.get(k)) add(k, KIND_NAME[k] || k, cnt.get(k));
    });
  }

  function buildOrderRound() {
    const pool = orderPool();
    if (!pool.length) return [];
    const heat = (it) => {
      const p = S.prog[it.id] || {};
      return (p.w || 0) * 2 - (p.o || 0) + (p.t ? 0 : 0.4) + Math.random() * 1.2;
    };
    const n = readSize(pool);
    return pool.slice().sort((a, b) => heat(b) - heat(a)).slice(0, n)
      .sort(() => Math.random() - 0.5);
  }

  function buildRound() {
    if (S.etype === "order") return buildOrderRound();
    const pool = currentPool();
    if (!pool.length) return [];
    const heat = (it) => {
      const p = S.prog[it.id] || {};
      return (p.w || 0) * 2 - (p.o || 0) + (p.t ? 0 : 0.4) + Math.random() * 1.2;
    };
    // 按考点分组：过去式/复数占题库七成，纯按热度抽会一轮全是一种
    const groups = new Map();
    pool.forEach((it) => {
      const arr = groups.get(it.k) || [];
      arr.push(it);
      groups.set(it.k, arr);
    });
    groups.forEach((arr) => arr.sort((a, b) => heat(b) - heat(a)));
    const n = readSize(pool);
    /* 每类轮转的起点逐轮后移：题量小于考点数时（20 题对 21 类），
       固定顺序会让末尾的构词法/非谓语永远轮不到，偏移一位就能几轮转完 */
    const kinds = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
    S.kindShift = ((S.kindShift || 0) + 1) % kinds.length;
    const rotated = kinds.slice(S.kindShift).concat(kinds.slice(0, S.kindShift));
    const cursor = new Map(rotated.map((k) => [k, 0]));
    const picked = [];
    const take = (k) => {
      const arr = groups.get(k);
      const i = cursor.get(k);
      if (i >= arr.length) return false;
      picked.push(arr[i]);
      cursor.set(k, i + 1);
      return true;
    };
    for (const k of rotated) {        // 先保证每类考点各来一道
      if (picked.length >= n) break;
      take(k);
    }
    while (picked.length < n) {       // 剩下按池子大小轮转补齐
      let moved = false;
      for (const k of rotated) {
        if (picked.length >= n) break;
        if (take(k)) moved = true;
      }
      if (!moved) break;
    }
    for (let i = picked.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    return picked;
  }

  function goScreen(id) {
    document.querySelectorAll(".screen").forEach((el) => {
      el.classList.toggle("is-on", el.id === id);
    });
  }

  function norm(s) {
    return String(s || "")
      .replace(/[\u200b-\u200f\ufeff]/g, "")      // 零宽字符：复制粘贴/输入法夹带，肉眼不可见却必判错
      .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
                                                  // 全角字母数字→半角：中文输入法全角模式打出 ｌｅａｒｎｉｎｇ 肉眼难辨
      .replace(/[\u2018\u2019]/g, "'")            // 中文弯引号→英文直引号（teacher's 类答案）
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")                       // "to  buy" 这类多空格归一再比
      .replace(/^[\s"'“”‘’]+|[\s.,!?;:"'“”‘’]+$/g, "");
  }

  let input = null;

  /* 词性 → 首页词块底色：查词库的 p 字段（3270 词全带词性） */
  const POS_CSS = [
    ["n.", "--n"], ["v.", "--v"], ["adj.", "--adj"], ["adv.", "--adv"],
    ["pron.", "--pron"], ["aux.", "--aux"], ["art.", "--det"], ["det.", "--det"],
    ["prep.", "--prep"], ["conj.", "--conj"], ["num.", "--num"], ["int.", "--int"],
    ["phr.", "--phr"], ["abbr.", "--abbr"],
  ];
  /* 词库不收的常见虚词：手写映射（同首页词性配色） */
  const FUNCS = new Map([
    ["the", "--det"], ["a", "--det"], ["an", "--det"], ["this", "--det"], ["that", "--det"],
    ["these", "--det"], ["those", "--det"], ["some", "--det"], ["any", "--det"],
    ["and", "--conj"], ["but", "--conj"], ["or", "--conj"], ["so", "--conj"],
    ["because", "--conj"], ["if", "--conj"], ["when", "--conj"], ["than", "--conj"], ["that", "--conj"],
    ["in", "--prep"], ["on", "--prep"], ["at", "--prep"], ["to", "--prep"], ["for", "--prep"],
    ["of", "--prep"], ["with", "--prep"], ["from", "--prep"], ["by", "--prep"], ["about", "--prep"],
    ["into", "--prep"], ["over", "--prep"], ["after", "--prep"], ["before", "--prep"],
    ["under", "--prep"], ["near", "--prep"], ["up", "--prep"], ["down", "--prep"],
    ["i", "--pron"], ["you", "--pron"], ["he", "--pron"], ["she", "--pron"], ["it", "--pron"],
    ["we", "--pron"], ["they", "--pron"], ["me", "--pron"], ["him", "--pron"], ["her", "--pron"],
    ["us", "--pron"], ["them", "--pron"], ["my", "--pron"], ["your", "--pron"], ["his", "--pron"],
    ["its", "--pron"], ["our", "--pron"], ["their", "--pron"], ["mine", "--pron"], ["yours", "--pron"],
    ["hers", "--pron"], ["ours", "--pron"], ["theirs", "--pron"], ["who", "--pron"], ["what", "--pron"],
    ["one", "--num"], ["two", "--num"], ["three", "--num"], ["first", "--num"],
    ["is", "--aux"], ["am", "--aux"], ["are", "--aux"], ["was", "--aux"], ["were", "--aux"],
    ["be", "--aux"], ["been", "--aux"], ["being", "--aux"], ["do", "--aux"], ["does", "--aux"],
    ["did", "--aux"], ["have", "--aux"], ["has", "--aux"], ["had", "--aux"], ["will", "--aux"],
    ["would", "--aux"], ["can", "--aux"], ["could", "--aux"], ["should", "--aux"],
    ["may", "--aux"], ["might", "--aux"], ["must", "--aux"], ["shall", "--aux"],
  ]);
  const LEX = (() => {
    const m = new Map();
    ((window.WORDS && window.WORDS.items) || []).forEach((it) => {
      if (it.w) m.set(it.w.toLowerCase(), it.p);
    });
    return m;
  })();
  function wordColor(tok) {
    const key = tok.toLowerCase().replace(/[^a-z']/g, "");
    if (!key) return null;               // 纯标点：不上底色，回归自然文本
    const f = FUNCS.get(key);
    if (f) return f;
    const p = LEX.get(key);
    if (p) {
      for (const [pre, css] of POS_CSS) {
        if (p.startsWith(pre)) return css;
      }
      return "--unk";
    }
    return /^[A-Z]/.test(tok) ? "--name" : "--unk";  // 没收录：大写开头当专有名词，其余灰蓝
  }

  function render() {
    const it = S.list[S.i];
    if (!it) return finish();
    S.phase = "ask";
    $("exIdx").textContent = String(S.i + 1);
    $("exTotal").textContent = String(S.list.length);
    $("exBar").style.width = (S.i / S.list.length) * 100 + "%";

    const card = document.querySelector("#exam .ecard");
    card.classList.remove("is-ok", "is-bad");
    $("exFeed").hidden = true;
    $("exZh").hidden = true;
    $("exWhy").hidden = true;
    /* 按钮状态必须在 order 分支之前重置：order 没有 input，早退后残留的
       「下一题可见 + 检查隐藏」会让下一题点下一题没反应、检查按钮消失 */
    $("exCheck").hidden = false;
    $("exNext").hidden = true;
    $("exSent").hidden = S.etype === "order";
    $("exChips").hidden = S.etype !== "order";

    if (S.etype === "order") {
      renderOrder(it);
      return;
    }
    const p = $("exSent");
    p.textContent = "";
    // 词块化题面：每个词照首页「一句一屏」上词性色块，查不到词性的走灰蓝底
    const putTokens = (text) => {
      if (!text) return;
      text.split(/\s+/).forEach((seg) => {
        if (!seg) return;
        const c = wordColor(seg);
        if (!c) {                            // 纯标点：自然文本，带空格贴排
          p.append(document.createTextNode(seg + " "));
          return;
        }
        const w = document.createElement("span");
        w.className = "ewd";
        w.style.setProperty("--c", "var(" + c + ")");
        w.textContent = seg;
        p.append(w);
      });
    };
    const [before, after] = it.s.split("___");
    putTokens(before);
    input = document.createElement("input");
    input.className = "eblank";
    input.type = "text";
    input.autocomplete = "off";
    input.autocorrect = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.setAttribute("inputmode", "latin");
    input.setAttribute("aria-label", it.b ? "填入单词的正确形式" : "填入合适的词");
    /* 框宽：ch 单位按数字 0 量宽，特粗体的大写 M/W 实际接近 1.7ch，首字母预填的
       常是大写字母，按 len+1ch 给框必窄；且居中对齐下一旦超宽两端同时被裁（吞字观感）。
       改用 0.8em/字符估宽并随输入自动加宽；无提示题保底 4 字符宽度，不泄露答案长度 */
    const firstMode = S.etype === "first";
    const minLen = firstMode || it.b ? it.a.length : 4;
    const fit = () => {
      input.style.width = (Math.max(input.value.length, minLen) * 0.8 + 1.6) + "em";
    };
    fit();
    input.addEventListener("input", fit);
    p.append(input);
    const base = document.createElement("span");
    if (firstMode) {
      base.className = "ebase";
      base.textContent = " (" + it.a[0] + "…" + (it.z ? " · " + it.z : "") + ")";
    } else if (it.b) {
      base.className = "ebase";
      base.textContent = " (" + it.b + ")";
    } else {
      base.className = "ebase ebase-none";
      base.textContent = "（无提示）";
    }
    p.append(base);
    putTokens(after);
    if (firstMode) input.value = it.a[0];

    $("exCheck").hidden = false;
    $("exNext").hidden = true;
    $("exWhy").hidden = true;
    /* 首字母模式预填了首字母：部分手机浏览器 focus() 会把光标放到最前面，
       孩子打的字全插到预填字母前面，看起来就是「吞字/乱序」——强制钉到末尾 */
    setTimeout(() => {
      if (!input) return;
      input.focus();
      const n = input.value.length;
      try { input.setSelectionRange(n, n); } catch (e) { /* 某些类型不支持时忽略 */ }
    }, 30);
  }

  function shuffleOrder(it) {
    const arr = it.a.slice();
    for (let tries = 0; tries < 12; tries += 1) {
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      if (arr.length < 2 || arr.some((t, i) => t !== it.a[i])) break;
    }
    return arr;
  }

  /* 语块底色：从首页词性的彩色块里轮换取色，还原「一句一屏」的视觉 */
  const CHIP_COLORS = ["--n", "--v", "--adj", "--adv", "--phr", "--aux", "--pat", "--pron"];

  function renderChips() {
    const box = $("exChips");
    box.textContent = "";
    S.order.forEach((tok, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "echunk";
      b.style.setProperty("--c", "var(" + CHIP_COLORS[i % CHIP_COLORS.length] + ")");
      b.textContent = tok;
      bindChip(b);
      box.append(b);
    });
  }

  /* 从 DOM 顺序同步回 S.order（拖拽插入后调用） */
  function syncOrder() {
    S.order = [...$("exChips").children].map((c) => c.textContent);
  }

  function bindChip(chip) {
    chip.addEventListener("pointerdown", (e) => {
      if (S.phase !== "ask") return;
      e.preventDefault();
      try { chip.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件/无活动指针时忽略 */ }
      chip.classList.add("dragging");
      const box = $("exChips");
      const r0 = chip.getBoundingClientRect();
      const dx = e.clientX - r0.left;   // 按下时指针在语块内的落点
      const dy = e.clientY - r0.top;
      let moved = false;
      const sx = e.clientX, sy = e.clientY;
      let tx = 0, ty = 0;               // 当前位移量

      // 把语块位移限制在语块框内，拖不出去
      const apply = (ev) => {
        const r = chip.getBoundingClientRect();   // 含当前 transform
        const lx = r.left - tx, ly = r.top - ty;  // 未变换时的布局位置
        tx = ev.clientX - dx - lx;
        ty = ev.clientY - dy - ly;
        const b = box.getBoundingClientRect();
        tx = Math.min(Math.max(tx, b.left - lx), Math.max(b.right - r.width - lx, b.left - lx));
        ty = Math.min(Math.max(ty, b.top - ly), Math.max(b.bottom - r.height - ly, b.top - ly));
        chip.style.transform = "translate(" + tx + "px," + ty + "px)";
      };

      const onMove = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 7) moved = true;
        if (!moved) return;
        apply(ev);
        // 指针落在哪个语块上，就插到它的前/后
        for (const other of [...box.children]) {
          if (other === chip) continue;
          const r = other.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right &&
              ev.clientY >= r.top && ev.clientY <= r.bottom) {
            box.insertBefore(chip, ev.clientX < r.left + r.width / 2 ? other : other.nextSibling);
            syncOrder();
            break;
          }
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        chip.classList.remove("dragging");
        chip.style.transform = "";
        tx = 0; ty = 0;
        if (moved) { syncOrder(); return; }
        // 没拖动 = 点选：两次点击交换位置（触屏/鼠标通用的兜底）
        const idx = [...box.children].indexOf(chip);
        if (S.pick < 0) {
          S.pick = idx;
          chip.classList.add("picked");
        } else if (S.pick === idx) {
          S.pick = -1;
          chip.classList.remove("picked");
        } else {
          const prev = box.children[S.pick];
          const a = S.pick, bIdx = idx;
          [S.order[a], S.order[bIdx]] = [S.order[bIdx], S.order[a]];
          S.pick = -1;
          if (prev) prev.classList.remove("picked");
          renderChips();
        }
      };
      // 挂在 window 上：指针跑出语块/窗口边缘也能收到 move/up，不会卡在拖拽态
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }

  function renderOrder(it) {
    $("exSent").hidden = true;
    $("exChips").hidden = false;
    S.order = shuffleOrder(it);
    S.pick = -1;
    renderChips();
  }

  function check() {
    if (S.phase !== "ask") return;
    const it = S.list[S.i];
    /* 连词成句没有输入框，必须先分流——原代码先读 input.value，order 模式下
       input 为 null 直接抛 TypeError，检查按钮就「没反应」了 */
    if (S.etype === "order") { checkOrder(it); return; }
    const val = norm(input.value);
    if (!val) {
      input.focus();
      return;
    }
    S.phase = "done";
    const good = val === norm(it.a);
    const card = document.querySelector("#exam .ecard");
    card.classList.add(good ? "is-ok" : "is-bad");
    input.disabled = true;

    if (good) {
      S.ok += 1;
      $("exFeed").textContent = "✅ 正确";
    } else {
      S.bad += 1;
      S.wrongIds.push(it.id);
      $("exFeed").textContent = "❌ 正确答案：" + it.a;
      input.value = it.a;
    }
    $("exFeed").hidden = false;
    // 讲评：答错时讲清规则，答对时也留一句，趁热打铁
    const why = $("exWhy");
    if (why) {
      if (it.t) {
        why.textContent = (good ? "规则：" : "为什么：") + it.t;
        why.classList.toggle("is-bad", !good);
        why.hidden = false;
      } else {
        why.hidden = true;
      }
    }
    if (it.zh) {
      $("exZh").textContent = it.zh;
      $("exZh").hidden = false;
    }
    $("exStat").textContent = "对 " + S.ok + " · 错 " + S.bad;
    mark(it.id, good);

    $("exCheck").hidden = true;
    $("exNext").hidden = false;
    $("exNext").focus();
  }

  function checkOrder(it) {
    const good = S.order.length === it.a.length && S.order.every((t, i) => t === it.a[i]);
    S.phase = "done";
    const card = document.querySelector("#exam .ecard");
    card.classList.add(good ? "is-ok" : "is-bad");
    /* 检查后焦点会滚到「下一题」按钮，语块区（英文）常被推出屏幕外——
       反馈行必须自带完整英文句，否则屏幕里只剩讲评和中文翻译 */
    const sentText = it.a.join(" ");
    if (good) {
      S.ok += 1;
      $("exFeed").textContent = "✅ 正确：" + sentText;
      $("exChips").querySelectorAll(".echunk").forEach((c) => c.classList.add("ok"));
    } else {
      S.bad += 1;
      S.wrongIds.push(it.id);
      $("exFeed").textContent = "❌ 正确答案：" + sentText;
      /* 保留孩子自己的排列：放对位置的语块标绿、放错的标红——原来整句替换成
         正确语序再全涂红，红块明明是正确答案，语义却像「全错」，也看不出错在哪 */
      $("exChips").querySelectorAll(".echunk").forEach((c, i) => {
        c.classList.add(S.order[i] === it.a[i] ? "ok" : "bad");
      });
    }
    $("exFeed").hidden = false;
    const why = $("exWhy");
    if (why) {
      why.textContent = (good ? "思路：" : "为什么：") + WHY_ORDER;
      why.classList.toggle("is-bad", !good);
      why.hidden = false;
    }
    if (it.zh) {
      $("exZh").textContent = it.zh;
      $("exZh").hidden = false;
    }
    $("exStat").textContent = "对 " + S.ok + " · 错 " + S.bad;
    mark(it.id, good);
    $("exCheck").hidden = true;
    $("exNext").hidden = false;
    $("exNext").focus();
  }

  function next() {
    if (S.phase !== "done") return;
    S.i += 1;
    if (S.i >= S.list.length) finish();
    else render();
  }

  function hint() {
    if (S.phase !== "ask") return;
    if (S.etype === "order") {
      const it = S.list[S.i];
      for (let i = 0; i < it.a.length; i += 1) {
        if (S.order[i] !== it.a[i]) {
          const j = S.order.indexOf(it.a[i], i + 1);
          if (j >= 0) {
            S.order.splice(j, 1);
            S.order.splice(i, 0, it.a[i]);
          }
          break;
        }
      }
      S.pick = -1;
      renderChips();
      return;
    }
    if (!input) return;
    const ans = S.list[S.i].a;
    const cur = input.value;
    if (cur.length >= ans.length) {
      input.value = ans;
    } else {
      let n = cur.length + 1;
      while (n < ans.length && ans[n - 1] === " ") n += 1;   // 空格不占一次提示
      input.value = ans.slice(0, n);
    }
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function finish() {
    $("exStage").querySelector(".ecard").hidden = true;
    $("exActions").hidden = true;
    $("exDone").hidden = false;
    const total = S.ok + S.bad;
    $("exScore").textContent = S.ok + " / " + total;
    const rate = total ? Math.round((S.ok / total) * 100) : 0;
    $("exSub").textContent = rate >= 90 ? "很稳，换个难度再来"
      : rate >= 60 ? "错的那几句已经被记下来，下轮优先出"
        : "点「👀 中文」看句意，按空格一个个字母试";
    $("exBar").style.width = "100%";
  }

  function updateHint() {
    const n = `共 ${S.list.length} 题`;
    if (S.etype === "order") {
      $("exHintBar").textContent = `拖动语块（或点两个交换）拼出完整句子　难度/题量沿用首页设置　${n}`;
      return;
    }
    $("exHintBar").textContent = S.kind
      ? `只练：${KIND_NAME[S.kind] || S.kind}　${n}`
      : S.etype === "first"
        ? `按首字母和中文提示填出整词　难度/题量沿用首页设置　${n}`
        : `括号里给原形的填正确形式，没括号的填合适的词　${n}`;
  }

  function start() {
    if (!ITEMS.length) {
      alert("题库还没生成，请先运行 python build_forms.py");
      return;
    }
    loadProg();
    renderTypes();
    renderKinds();
    S.list = buildRound();
    if (!S.list.length) {
      alert("当前难度下还没有题目，请先选小学到初三里的一个");
      return;
    }
    S.i = 0;
    S.ok = 0;
    S.bad = 0;
    S.wrongIds = [];
    updateHint();
    $("exStat").textContent = "对 0 · 错 0";
    $("exStage").querySelector(".ecard").hidden = false;
    $("exActions").hidden = false;
    $("exDone").hidden = true;
    goScreen("exam");
    render();
  }

  document.addEventListener("keydown", (e) => {
    const on = $("exam").classList.contains("is-on");
    if (!on) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (S.phase === "ask") check();
      else next();
      return;
    }
    if (e.key === " " && document.activeElement === input) {
      /* 空格键 = 逐字母提示，是给「无提示语法题」的福利；但答案本身带空格时
         （to help / teacher's 短语类），孩子必须能打进空格，否则永远拼不出来
         ——原版一律 preventDefault 劫持空格，多词答案必错 */
      const curIt = S.list[S.i];
      if (curIt && curIt.a.includes(" ")) return;
      e.preventDefault();
      hint();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      quit();
    }
  });

  function quit() {
    if (S.ok + S.bad > 0) finish();
    else goScreen("start");
  }

  function renderTypes() {
    const box = $("exTypes");
    if (!box || box.dataset.built) { 
      box.querySelectorAll(".etype").forEach((b) => b.classList.toggle("on", b.dataset.et === S.etype));
      return;
    }
    box.dataset.built = "1";
    ETYPES.forEach(([k, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "etype" + (k === S.etype ? " on" : "");
      b.dataset.et = k;
      b.textContent = label;
      b.addEventListener("click", () => {
        if (S.etype === k) return;
        S.etype = k;
        saveEtype();
        start();
      });
      box.append(b);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    S.etype = readEtype();
    const btn = $("openExam");
    if (btn) btn.addEventListener("click", start);
    const reg = (id, fn) => {
      const el = $(id);
      if (el) el.addEventListener("click", fn);
    };
    reg("exCheck", check);
    reg("exNext", next);
    reg("exTip", hint);
    reg("exSkip", () => {
      if (S.phase === "ask") {
        S.bad += 1;
        S.wrongIds.push(S.list[S.i].id);
        mark(S.list[S.i].id, false);
        $("exStat").textContent = "对 " + S.ok + " · 错 " + S.bad;
      }
      S.i += 1;
      if (S.i >= S.list.length) finish();
      else render();
    });
    reg("exZhBtn", () => {
      const el = $("exZh");
      const it = S.list[S.i];
      if (!it) return;
      el.textContent = it.zh;
      el.hidden = !el.hidden;
    });
    reg("exQuit", quit);
    reg("exBack", () => goScreen("start")); // 左上角返回：直接回首页，不等结算
    reg("exAgain", () => {
      S.list = buildRound();
      S.i = 0;
      S.ok = 0;
      S.bad = 0;
      S.wrongIds = [];
      updateHint();
      $("exStat").textContent = "对 0 · 错 0";
      $("exStage").querySelector(".ecard").hidden = false;
      $("exActions").hidden = false;
      $("exDone").hidden = true;
      renderTypes();
      renderKinds();
      render();
    });
    reg("exHome", () => goScreen("start"));
  });

  /* 调试 / 自动化测试句柄 */
  window.__EXAM = S;
})();
