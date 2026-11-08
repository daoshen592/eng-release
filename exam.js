/**
 * 专项练习 · 三入口
 *   lex     词法——把句中已有的正确变形挖空，括号里给原形（data/forms.js 的词法类考点）
 *   syntax  句法句型——同一题库，挖功能词/结构词（data/forms.js 的句法类考点）
 *   order   连词成句——句库语块打乱拖拽排序（data/sentences.js 的 chunks）
 * 难度 / 题量 / 抽题规则全部沿用首页设置（Store 的 level / size）。
 *
 * ── 契约 ─────────────────────────────────────────────
 * 依赖：window.SENTENCES（order 题源）· window.FORMS（lex/syntax 题源）· window.Store
 *       window.WORDS 可选（词信息兜底，缺失不报错）
 * 导出：window.__EXAM（调试 / 冒烟测试句柄）
 * 加载序：Store 之后即可；入口按钮 #openExam（首页）
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const ITEMS = (window.FORMS && window.FORMS.items) || [];
  const SENT = (window.SENTENCES && window.SENTENCES.sentences) || [];
  const KEY = "examprog";
  const ETYPES = [["lex", "词法"], ["syntax", "句法句型"], ["order", "连词成句"]];
  const WHY_ORDER = "先找主语和谓语搭出主干，再按中文意思把修饰语挂上去；标点跟着它所在的语块走。";

  /* ---- 复习调度（与首页同一套 FSRS，参数一致）----
     抽题优先级完全对齐首页智能模式：错题(当天回锅) > 新题 > 到期复习 > 未到期。
     存储用独立键 exam.srs：专项题 id(f/sy/g/o 前缀)与首页句 id 不混，掌握度各自独立。 */
  const F_LIB = window.FSRS;
  const F_SCHED = F_LIB ? F_LIB.fsrs(
    F_LIB.generatorParameters({ enable_fuzz: true, enable_short_term: false, request_retention: 0.9 })
  ) : null;
  const F_GOOD = F_LIB ? F_LIB.Rating.Good : null;
  const F_AGAIN = F_LIB ? F_LIB.Rating.Again : null;
  const F_MAX_IVAL = 365; // 天
  const SRS_KEY = "exam.srs";

  function dayNum() { return Math.floor(Date.now() / 86400000); }
  function srsAll() {
    try { return JSON.parse((window.Store && Store.get(SRS_KEY)) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function reviveCard(c) {
    c.due = new Date(c.due);
    if (c.last_review) c.last_review = new Date(c.last_review);
    return c;
  }
  function dueDay(rec) { return Math.floor(new Date(rec.due).getTime() / 86400000); }
  /* 判对错时更新掌握度（与首页 gradeSentence 同款二值映射 + miss 标记 + 当天回锅） */
  function gradeItem(id, ok) {
    if (!F_SCHED || !id) return;
    const all = srsAll();
    const now = new Date();
    const card = all[id] ? reviveCard(all[id]) : F_LIB.createEmptyCard(now);
    const next = F_SCHED.next(card, now, ok ? F_GOOD : F_AGAIN).card;
    next.miss = !ok;
    if (!ok) {
      next.due = new Date(now.getTime() + 5 * 60000);      // 答错 5 分钟后回锅
    } else {
      if ((next.due - now) / 86400000 > F_MAX_IVAL) {
        next.due = new Date(now.getTime() + F_MAX_IVAL * 86400000);
      }
      if (dueDay(next.due) <= dayNum()) {
        next.due = new Date(now.getTime() + 86400000);     // 下限 1 天
      }
    }
    all[id] = next;
    if (window.Store) Store.set(SRS_KEY, JSON.stringify(all));
  }
  /* 抽题优先级（与首页 smartPick 一致）：错题 > 新题 > 到期复习 > 未到期 */
  function srsHeat(it) {
    const all = srsAll();
    const today = dayNum();
    const r = all[it.id];
    if (!r) return 1;                                    // 新题：次高优先
    if (dueDay(r) <= today && r.miss) return 0;          // 错题：最高优先
    if (dueDay(r) <= today) return 2;                    // 到期复习
    return 3;                                            // 未到期
  }
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
    etype: "lex", order: [], pick: -1 };

  /* 考点中文名与展示顺序（无提示题在前，主干在前，补充考点在后） */
  const KIND_NAME = {
    art: "冠词", prep: "介词",
    s: "名词复数", 3: "三单", ing: "现在进行时", ger: "动名词", p: "过去式",
    pp: "被动语态", perf: "完成时",
    r: "比较级", t: "最高级", adv: "形容词变副词",
    po: "代词宾格", pa: "形容词性物主", pn: "名词性物主", poss: "名词所有格", ord: "序数词",
    refl: "反身代词", indef: "不定代词", freq: "频度副词", num: "数词与时间",
    inf: "非谓语 to do", der: "构词法派生", be: "be 动词",
    /* 句法句型：练句子怎么搭、结构词怎么用 */
    there: "There be", impy: "祈使句", excl: "感叹句", q_gen: "一般疑问句",
    q_wh: "特殊疑问句", future: "一般将来时", conj: "并列句", mod: "情态动词",
    cl_o: "宾语从句", cl_r: "定语从句", cl_a: "状语从句",
    so_that: "so…that", too_to: "too…to", usedto: "used to", it: "it 形式主语",
    q_tag: "反意疑问句",
  };
  const KIND_ORDER = ["art", "prep", "s", "3", "ing", "ger", "p", "pp", "perf", "r", "t",
    "adv", "be", "po", "pa", "pn", "poss", "ord", "refl", "indef", "freq", "num", "inf", "der",
    "there", "impy", "excl", "q_gen", "q_wh", "future", "conj", "mod",
    "cl_o", "cl_r", "cl_a", "so_that", "too_to", "usedto", "it", "q_tag"];
  /* 考点分组：句法句型（其余 KIND_ORDER 里的都是词法类） */
  const SYNTAX_KINDS = new Set(["there", "impy", "excl", "q_gen", "q_wh", "future",
    "conj", "mod", "cl_o", "cl_r", "cl_a", "so_that", "too_to",
    "usedto", "it", "q_tag"]);
  /* 当前入口只出哪一类考点：lex 取词法、syntax 取句法、order 不适用 */
  function kindInEtype(k) {
    if (S.etype === "syntax") return SYNTAX_KINDS.has(k);
    if (S.etype === "lex") return !SYNTAX_KINDS.has(k);
    return true;
  }

  function readEtype() {
    try {
      const v = window.Store && Store.get("etype");
      if (ETYPES.some(([k]) => k === v)) return v;
    } catch (e) { /* 忽略 */ }
    return "lex";
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
    gradeItem(id, good);   // 同步更新 FSRS 掌握度，抽题优先级与首页对齐
  }

  function levelPool() {
    const levels = readLevels();
    return ITEMS.filter((it) => levels.includes("all") || levels.includes(it.l));
  }

  function currentPool() {
    let base = levelPool();
    if (S.etype !== "order") base = base.filter((it) => kindInEtype(it.k));
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
        /* 讲评要用：语法标签（imp/excl/there/modal/comp/clause_*）
           与每块首词词性（v./aux./det./prep.…），据此判断句型与成分位置 */
        g: Array.isArray(st.g) ? st.g : [],
        ps: st.chunks.map((g) => (g.length && g[0].pos) || ""),
      });
    }
    return out;
  }

  /* ---------- 连词成句讲评 ----------
     原来每道题共用一句 WHY_ORDER（"先找主语和谓语搭出主干…"），做两道就麻木了。
     这里按每句话自己的结构现算「句型 + 本题 + 差在」三段：
       句型 —— 这类句子为什么这样排（规则）
       本题 —— 这句话的抓手：谁是主语谓语，状语该挂哪儿
       差在 —— 答错时指出第一处错位，能判定成两块互换就直接说互换
     判断依据是句子自带的语法标签 g（imp/excl/there/modal/comp/clause_*）
     与每块首词的词性 ps（v./aux./det./prep.…），不靠猜。 */
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const B = (s) => "<b>" + esc(String(s == null ? "" : s).replace(/[\s.,!?;:]+$/, "")) + "</b>";

  /* 句库里有少量「句子」其实是两句连写（How are you? I'm fine.）——
     句型按第一句判，讲评先讲第一句，避免把 How 当主语这种笑话。
     缩写（Mr. / Mrs. / Dr.）用词表挡住，别把它当成句子结束。 */
  const O_ABBR = /^(mr|mrs|ms|dr|st|prof|sr|jr|no|etc|vs|mt)$/i;
  /* a.m. / p.m. 里的句点不是句末，切句前先打码 */
  const maskAmPm = (s) => String(s || "").replace(/\b([ap])\.m\./gi, "$1·m·");
  function orderHead(s) {
    const t = String(s || "").trim();
    const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
    return (m ? m[0] : t).trim();
  }
  function orderSegs(s) {
    const parts = maskAmPm(String(s || "").trim()).match(/[^.!?]+[.!?]*/g) || [];
    const segs = [];
    let pend = "";
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      if (O_ABBR.test(t.replace(/[.!?]+$/, ""))) { pend += t + " "; continue; }
      segs.push((pend + t).trim());
      pend = "";
    }
    if (pend) {
      if (segs.length) segs[segs.length - 1] += " " + pend.trim();
      else segs.push(pend.trim());
    }
    return segs;
  }
  function orderSegCount(s) { return orderSegs(s).length; }

  /* 句型 → [名称, 规则]。一句话说清「为什么这样排」，控制在 40 字以内，手机上不占屏 */
  const OTYPE = {
    stmt: ["陈述句", "按「主语 → 谓语 → 宾语 → 地点 → 时间」排；中文先说时间地点，英语都甩到句末。"],
    ynq: ["一般疑问句", "be / 助动词 / 情态提到主语前面，实义动词用原形，句末问号。"],
    whq: ["特殊疑问句", "疑问词 + 一般疑问句语序：疑问词打头，be / 助动词再提到主语前。"],
    imp: ["祈使句", "省略主语 you，动词原形打头；否定用 Don't / Never 起句。"],
    excl: ["感叹句", "What 管名词（What a nice day!），How 管形容词和副词（How nice!）。"],
    there: ["There be 句型", "There + be + 名词 + 地点；be 跟后面第一个名词一致（就近原则）。"],
    comp: ["含比较级", "A + be / 动词 + 比较级 + than + B，than 后面必须跟对比对象。"],
    prog: ["含现在进行时", "be + 现在分词，be 在前、doing 在后，中间不插别的成分。"],
    perf: ["含现在完成时", "have / has + 过去分词，have / has 跟主语的人称和数变。"],
    modal: ["含情态动词", "情态动词 + 动词原形，放在主语之后、实义动词之前。"],
    clause: ["含状语从句", "先搭主句，从句由连词引导、整块放在后面。"],
    dobj: ["含双宾语", "动词 + 人 + 物；物提前时要用 to / for 引出人。"],
    inf: ["含不定式", "to + 动词原形，跟在动词后面表目的或作宾语。"],
    freq: ["含频率副词", "频率副词放实义动词前、be 和助动词后。"],
    be: ["be 动词句", "主语 + be（am / is / are）+ 表语；be 跟主语的人称和数变。"],
    past: ["一般过去时", "谓语用过去式（-ed 或不规则变化），时间状语放句末。"],
    greet: ["日常寒暄 / 固定说法", "固定说法整块记（Good morning. / Nice to meet you.），不用拆主谓。"],
  };

  const O_TIME = /^(yesterday|today|tomorrow|now|soon|then|tonight|last |next |this (morning|afternoon|evening|week|month|year|spring|summer|autumn|winter|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|every |once |twice |three times|at (\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)|in the (morning|afternoon|evening)|on (sunday|monday|tuesday|wednesday|thursday|friday|saturday)|in \d{4}|ago|\d+ (o'clock|years|months|weeks|days|minutes|hours)|after (school|lunch|dinner|class|breakfast))/i;
  const O_PREP = /^((in|at|on|under|behind|near|beside|between|next to|in front of|across|around|over|with) |to (the|a|an|my|his|her|their|our|your|school|bed|work)\b)/i;
  const O_FREQ = /^(always|usually|often|sometimes|never|seldom|hardly|ever|once|twice)$/i;
  /* 以 -ed 结尾但不是过去式的原形（need / feed…），判时态时先排除 */
  const ED_BASE = /^(need|feed|seed|speed|bleed|breed|succeed|proceed|exceed|bed|red)$/i;

  function orderTypeOf(it) {
    const g = it.g || [];
    const has = (k) => g.indexOf(k) >= 0;
    const head = orderHead(it.s);            // 多句连写的取第一句判句型
    const txt = " " + norm(head) + " ";
    const end = head.slice(-1);
    const first = norm(it.a[0] || "").split(" ")[0];
    const ps = it.ps || [];
    const vi = ps.findIndex((p) => p === "v." || p === "aux.");
    const verb = vi >= 0 ? norm(it.a[vi]).split(" ")[0] : "";
    if (end === "?") {
      return /^(what|where|when|who|whose|which|why|how)$/.test(first) ? "whq" : "ynq";
    }
    /* 多句里的寒暄首句（Hello! / Good morning.）不套主谓宾规则 */
    if (orderSegs(it.s).length > 1 && /^(hello|hi|good morning|good afternoon|good evening|goodbye|bye|thanks|thank you|sorry|excuse me|ok|okay|nice to meet you|see you)\b/.test(norm(head))) {
      return "greet";
    }
    if (has("excl")) return "excl";
    if (has("imp")) return "imp";
    if (has("there")) return "there";
    if (has("comp")) return "comp";
    if (/\b(is|are|am|was|were) \w+ing\b/.test(txt)) return "prog";
    if (/\b(have|has) \w+(ed|en)\b/.test(txt)) return "perf";
    if (has("modal")) return "modal";
    if (has("clause_adv")) return "clause";
    if (/\b(give|gives|gave|show|shows|showed|tell|tells|told|buy|buys|bought|send|sends|sent|bring|brings|brought|pass|passes|passed|lend|lends|lent) (me|him|her|us|them|you)\b/.test(txt)) return "dobj";
    if (/^(i|we|they|you) (want|hope|need|try|like|plan|decide|begin|start) to\b/.test(txt)) return "inf";
    if (it.a.some((x) => O_FREQ.test(norm(x)))) return "freq";
    /* be 动词句与一般过去时：把最常见的两类陈述句拆出来，规则话术不再千篇一律 */
    if (/^(is|am|are|was|were)$/.test(verb)) return "be";
    if (ED_BASE.test(verb)) return "stmt";           // need / feed 这类以 -ed 结尾的原形，不是过去式
    if (/ed$/.test(verb) && verb.length > 4) return "past";
    if (it.a.some((x) => /(yesterday|last (night|week|month|year)|ago)$/i.test(norm(x)))) return "past";
    return "stmt";
  }

  /* 「本题」段：把这句话的骨架点名，最多 3 条 */
  function orderHand(it, type) {
    const A = it.a, ps = it.ps || [], W = A.map((x) => norm(x));
    const out = [];
    /* 多句连写时，所有成分只在第一句里找（否则会把第二句的 am 当成提前的助动词） */
    const segs = orderSegs(it.s);
    const flat = (s) => norm(s).replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
    const headN = flat(orderHead(it.s));
    let hi = A.length - 1;
    if (segs.length > 1) {
      let acc = "";
      for (let i = 0; i < A.length; i += 1) {
        acc = flat(acc + " " + A[i]);
        if (acc === headN) { hi = i; break; }
      }
    }
    const vi = ps.findIndex((p, i) => i <= hi && (p === "v." || p === "aux."));
    let time = -1, place = -1;
    W.forEach((w, i) => {
      if (i > hi) return;
      if (O_TIME.test(w)) time = i;
      else if (O_PREP.test(w) && place < 0) place = i;
    });
    if (segs.length > 1) {
      const cut = orderHead(it.s).replace(/[.!?]+$/, "");
      out.push(`这句其实是 ${segs.length} 句话拼在一起：先摆「${B(cut)}」（前 ${hi + 1} 块），剩下的接在后面。`);
    }
    const placeWord = /^with /i.test(W[place] || "") ? "伴随状语" : "地点状语";

    if (type === "imp") {
      const f = W[0];
      if (/^(don't|do not|never)$/.test(f)) out.push(`否定祈使句：${B(A[0])} 打头，后面接动词原形。`);
      else if (/^please$/.test(f)) out.push(`${B(A[0])} 放句首后面直接跟动词原形；放句末时前面要加逗号。`);
      else if (/^(let's|let us)$/.test(f)) out.push(`${B(A[0])} 后面跟动词原形，表示建议。`);
      else out.push(`句首 ${B(A[0])} 就是动词原形 —— 祈使句没有主语，直接接宾语或状语。`);
      if (time >= 0) out.push(`时间状语 ${B(A[time])} 放句末。`);
      return out;
    }
    if (type === "excl") {
      const f = W[0];
      if (f === "what") out.push(`这里是 What 管名词：按「(a/an) + 形容词 + 名词」排，主谓放到最后。`);
      else if (f === "how") out.push(`这里是 How 管形容词 / 副词：紧跟在 How 后面，再接主谓。`);
      else out.push(`句首 ${B(A[0])} 是感叹中心，其余成分按正常语序接在后面。`);
      return out;
    }
    if (type === "there") {
      out.push(`句首 ${B(A[0])} 跟 be 动词连用，名词紧跟在 be 后面。`);
      if (place >= 0 && time >= 0) out.push(`${B(A[place])} 是地点、${B(A[time])} 是时间 —— 地点永远排时间前面。`);
      else if (place >= 0) out.push(`${B(A[place])} 是地点状语，放句末。`);
      return out;
    }
    if (type === "whq") {
      /* 疑问词后面可能先跟形容词（How old / What colour），真正提前的 be / 助动词在后面一块 */
      const aux = ps.map((p, i) => (p === "aux." && i > 0 && i <= hi ? i : -1)).filter((i) => i >= 0).pop();
      if (aux > 0) {
        out.push(`疑问词 ${B(A[0])} 打头，${B(A[aux])} 提到主语 ${B(A[aux + 1] || "")} 前面 —— 这就是「疑问词 + 一般疑问句语序」。`);
      } else {
        out.push(`疑问词 ${B(A[0])} 直接作主语，后面按正常语序接谓语 ${B(A[1] || "")}，不用再加 do / does。`);
      }
      return out;
    }
    if (type === "ynq") {
      /* 首块不是 be / 助动词时（回声疑问：Japan lies to the west?），不能套「提前」那套话 */
      const auxFirst = /^(is|am|are|was|were|do|does|did|can|could|may|might|must|will|would|shall|should|have|has|had|need|dare)$/i.test(W[0]);
      out.push(auxFirst
        ? `${B(A[0])} 是提到句首的 be / 助动词，主语 ${B(A[1] || "")} 紧随其后，实义动词用原形。`
        : `句末是问号，但语序还是「主语 + 谓语」—— 这是靠升调发问的回声疑问，不用倒装。`);
      if (place >= 0) out.push(`${B(A[place])} 是地点状语，放句末。`);
      return out;
    }
    if (type === "comp") {
      const ti = W.findIndex((w, i) => i <= hi && (w === "than" || w.startsWith("than ")));
      if (ti > 0) out.push(`${B(A[ti])} 前面是比较级 ${B(A[ti - 1])}，后面是对比对象 —— than 不能单独放句末。`);
      else out.push(`含 than 的那一块要放在比较级后面，中间别插别的成分。`);
      return out;
    }

    /* 陈述类：先点名主干，再说这类句子的注意点，最后是状语位置 */
    const verb0 = vi >= 0 ? (W[vi].split(" ")[0] || "") : "";
    /* 谓语前面紧挨的频率副词（We often play）不算主语，往前退到真正的名词块 */
    let si = vi - 1;
    while (si > 0 && (ps[si] === "adv." || ps[si] === "conj.")) si -= 1;
    const subjTxt = vi > 0 ? A.slice(0, si + 1).join(" ") : "";
    const subj0 = vi > 0 ? norm(A[0]).split(" ")[0] : "";
    const is3rd = ps[vi] === "v." && /^[a-z]{3,}s$/.test(verb0)
      && !/^(is|has|does|was|us|this|his|its|always|sometimes)$/.test(verb0)
      && !/^(i|you|we|they)$/.test(subj0);
    if (vi > 0) {
      out.push(is3rd
        ? `主语是 ${B(subjTxt)}，谓语 ${B(A[vi])} 是三单形式（第三人称单数加 -s / -es）。`
        : `主语是 ${B(subjTxt)}，谓语 ${B(A[vi])} 紧跟其后。`);
    }
    if (type === "modal") out.push(`情态动词后面的动词一律用原形，不加 -s / -ed。`);
    else if (type === "prog") out.push(`be 和 doing 要连在一起，中间不能插别的成分。`);
    else if (type === "perf") out.push(`have / has 跟着主语变，后面的过去分词不变。`);
    else if (type === "clause") out.push(`从句部分整块放，连词紧跟从句的主语，不能把连词单独留在句末。`);
    else if (type === "be") out.push(`be 后面接名词、形容词或地点作表语，别拿 do / does 顶替。`);
    else if (type === "past") out.push(`谓语要用过去式，别写成原形，也别加 -s。`);
    else if (type === "freq") {
      const fi = W.findIndex((w, i) => i < vi && O_FREQ.test(w));
      if (fi >= 0 && fi !== si) out.push(`${B(A[fi])} 是频率副词，放在实义动词 ${B(A[vi])} 前面。`);
    }
    if (place >= 0 && time >= 0 && place < time) {
      out.push(`${B(A[place])} 是${placeWord}、${B(A[time])} 是时间状语 —— 英语里地点在前、时间在后，正好和中文相反。`);
    } else if (time >= 0) {
      out.push(`时间状语 ${B(A[time])} 放句末：中文常把时间放句首，英语要挪到句子后面。`);
    } else if (place >= 0) {
      out.push(`${B(A[place])} 是${placeWord}，放句末。`);
    }
    /* 并列连词才讲「两边对等」；than / because / when / if 不是并列连词，别乱套 */
    const cj = A.find((x, i) => ps[i] === "conj." && /^(and|but|or|so)$/i.test(norm(x)));
    if (cj) out.push(`${B(cj)} 连接的两边要对等 —— 都是名词、都是动词或都是短语，不能一边长一边短。`);
    if (!out.length) out.push(`这句只有主干，没有可挪的状语 —— 按「主语 + 谓语 + 宾语」摆就是正确语序。`);
    return out.slice(0, segs.length > 1 ? 3 : 2);
  }

  /* 「差在」段：答错时给具体位置，两块互换就直接说互换 */
  function orderFix(it, picked) {
    const A = it.a, P = picked || [];
    if (!P.length || P.length !== A.length) return "";
    const bad = [];
    for (let i = 0; i < A.length; i++) if (P[i] !== A[i]) bad.push(i);
    if (!bad.length) return "";
    if (bad.length === 2 && P[bad[0]] === A[bad[1]] && P[bad[1]] === A[bad[0]]) {
      return `${B(A[bad[0]])} 和 ${B(A[bad[1]])} 位置调换了 —— 这两块换回来就对了。`;
    }
    const i = bad[0];
    const more = bad.length > 1 ? `（另外还有 ${bad.length - 1} 处位置也不对）` : "";
    return `第 ${i + 1} 块你放的是 ${B(P[i])}，这里应该是 ${B(A[i])}${more}。`;
  }

  function orderWhyHtml(it, good, picked) {
    const type = orderTypeOf(it);
    const [name, rule] = OTYPE[type] || OTYPE.stmt;
    const rows = [`<span class="ewl"><em>句型</em>${esc(name)}：${esc(rule)}</span>`];
    const hand = orderHand(it, type);
    if (hand.length) rows.push(`<span class="ewl"><em>本题</em>${hand.join("　")}</span>`);
    if (!good) {
      const fix = orderFix(it, picked);
      if (fix) rows.push(`<span class="ewl"><em>差在</em>${fix}</span>`);
    }
    return rows.join("");
  }

  /* 考点统计条：总题数 + 每类多少，点一下就只练这一类 */
  function renderKinds(pool) {
    if (S.etype === "order") { $("exKinds").hidden = true; return; }
    $("exKinds").hidden = false;
    const base = pool || levelPool().filter((it) => kindInEtype(it.k));
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
      if (!cnt.get(k)) return;
      add(k, KIND_NAME[k] || k, cnt.get(k));
    });
  }

  function buildOrderRound() {
    const pool = orderPool();
    if (!pool.length) return [];
    const n = readSize(pool);
    return pool.slice().sort((a, b) => srsHeat(a) - srsHeat(b) || Math.random() - 0.5)
      .slice(0, n)
      .sort(() => Math.random() - 0.5);
  }

  function buildRound() {
    if (S.etype === "order") return buildOrderRound();
    const pool = currentPool();
    if (!pool.length) return [];
    // 按考点分组：过去式/复数占题库比例大，纯按热度抽会一轮全是一种
    const groups = new Map();
    pool.forEach((it) => {
      const arr = groups.get(it.k) || [];
      arr.push(it);
      groups.set(it.k, arr);
    });
    // 组内按 FSRS 优先级排序（错题>新题>到期>未到期），同优先级随机打散
    groups.forEach((arr) => arr.sort((a, b) => srsHeat(a) - srsHeat(b) || Math.random() - 0.5));
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
    /* footer 文案随题型/答案变化：多词答案（to help 类）空格是正常输入，
       不能再引导孩子「按空格提示」——那会把空格劫持成提示、永远拼不出来 */
    $("exFoot").textContent =
      S.etype === "order" ? "拖动或点击词块排好语序，按 Enter 检查；不会就按空格提示"
      : it.a.includes(" ") ? "答案含空格：空格直接打进框里，提示用右下按钮"
      : "填完按 Enter 检查；不会就按空格提示";

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
    input.setAttribute("enterkeyhint", "go"); // 手机键盘右下角显示「前往」而非「换行」
    input.setAttribute("aria-label", it.b ? "填入单词的正确形式" : "填入合适的词");
    /* 框宽：ch 单位按数字 0 量宽，特粗体的大写 M/W 实际接近 1.7ch，按 len+1ch 给框必窄；
       且居中对齐下一旦超宽两端同时被裁（吞字观感）。
       改用 0.8em/字符估宽并随输入自动加宽；无提示题保底 4 字符宽度，不泄露答案长度 */
    const minLen = it.b ? it.a.length : 4;
    const fit = () => {
      input.style.width = (Math.max(input.value.length, minLen) * 0.8 + 1.6) + "em";
    };
    fit();
    input.addEventListener("input", fit);
    /* 失焦自动回焦（对齐一屏一句）：手机上点到别处输入框失灵是常见卡壳点。
       刚点了按钮/已判分/已退出时不抢焦点 */
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!input || S.phase !== "ask") return;
        if (!$("exam").classList.contains("is-on")) return;
        const act = document.activeElement;
        if (act && (act.tagName === "BUTTON" || act.tagName === "INPUT")) return;
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
      }, 120);
    });
    p.append(input);
    const base = document.createElement("span");
    if (it.b) {
      base.className = "ebase";
      base.textContent = " (" + it.b + ")";
    } else if (it.z) {
      // 句法句型里的语义实词（数词/频度副词/不定代词）：无原形提示，给中文方向提示
      base.className = "ebase";
      base.textContent = "（" + it.z + "）";
    } else {
      base.className = "ebase ebase-none";
      base.textContent = "（无提示）";
    }
    p.append(base);
    putTokens(after);

    $("exCheck").hidden = false;
    $("exNext").hidden = true;
    $("exWhy").hidden = true;
    setTimeout(() => {
      if (!input) return;
      input.focus();
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
    // 讲评：答错时讲清规则，答对时也留一句，趁热打铁（标签与连词成句的样式统一）
    const why = $("exWhy");
    if (why) {
      if (it.t) {
        why.innerHTML = `<span class="ewl"><em>${good ? "规则" : "为什么"}</em>${esc(it.t)}</span>`;
        why.classList.toggle("is-bad", !good);
        why.classList.toggle("is-ok", good);
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
    /* 讲评按本题结构现算：句型规则 + 本题骨架（答错再加「差在」） */
    const why = $("exWhy");
    if (why) {
      why.innerHTML = orderWhyHtml(it, good, S.order);
      why.classList.toggle("is-bad", !good);
      why.classList.toggle("is-ok", good);
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

  /* 看中文：按钮和 Tab 共用同一个开关（Tab 在练习页被接管，不会跳焦点） */
  function toggleZh() {
    const el = $("exZh");
    const it = S.list[S.i];
    if (!el || !it) return;
    el.textContent = it.zh || "";
    el.hidden = !el.hidden;
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
      /* 提示后必须给个回声：只挪一块语块、颜色又随位置轮换，孩子容易觉得
         「点了没反应」。用 footer 报剩余错位数 */
      const left = it.a.reduce((n, t, i) => n + (S.order[i] === t ? 0 : 1), 0);
      $("exFoot").textContent = left
        ? `已提示一块，还有 ${left} 块位置不对；不会就继续按空格`
        : "语序已经排好了，按 Enter 检查";
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
    if (e.key === "Tab") {
      /* Tab = 看中文（默认 Tab 会跳焦点：输入框 → 检查按钮 → 提示…，练习时打断输入） */
      e.preventDefault();
      toggleZh();
      return;
    }
    /* 空格 = 提示。原判定只认 activeElement === input，而连词成句根本没有
       输入框（按钮上却写着「💡 提示 · 空格」），order 模式下按空格彻底没反应
       → order 单独放行，焦点在语块或按钮上都当提示 */
    if (e.key === " " && (S.etype === "order" || document.activeElement === input)) {
      /* 词法/句法：答案本身带空格时（to help / teacher's 短语类），孩子必须
         能打进空格，否则永远拼不出来——这种情况不劫持 */
      const curIt = S.list[S.i];
      if (S.etype !== "order" && curIt && curIt.a.includes(" ")) return;
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
        S.kind = "";   // 换入口就回到「全部」，不残留上次选的考点
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
    reg("exZhBtn", toggleZh);
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
  S._orderPool = orderPool;     // 连词成句题池（带 g / ps）
  S._why = orderWhyHtml;        // 讲评生成器：orderWhyHtml(it, good, picked)
  window.__EXAM = S;
})();
