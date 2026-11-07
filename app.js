/* 主控：路由（屏幕切换）、词块拆句主玩法、设置与首页 HUD。
 * 必须最后加载 —— 依赖前面所有模块导出的全局。
 *
 * ── 契约 ─────────────────────────────────────────────
 * 依赖：window.SENTENCES（主玩法题源）· window.Store · window.AUDIO_EXTRA（预合成音频）
 *       window.FSRS（句子侧复习调度）· window.WordBook（背单词入口）
 * 导出：window.AppHome / window.WordBookHome（供各模块「回首页」惰性调用）
 * 加载序：最后。各功能模块通过 DOM 按钮与本模块互调，均带 window.X && 守卫
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const POS_CN = {
    "n.": "名词", "v.": "动词", "adj.": "形容词", "adv.": "副词",
    "pron.": "代词", "prep.": "介词", "conj.": "连词", "det.": "限定词",
    "num.": "数词", "int.": "感叹词", "phr.": "短语", "pat.": "句型",
    "abbr.": "缩写", "aux.": "助动词", "name.": "专名",
  };
  const POS_KEY = {
    "n.": "n", "v.": "v", "adj.": "adj", "adv.": "adv", "pron.": "pron",
    "prep.": "prep", "conj.": "conj", "det.": "det", "num.": "num",
    "int.": "int", "aux.": "aux", "phr.": "phr", "pat.": "pat",
    "abbr.": "abbr", "name.": "name",
  };
  const TYPEABLE = /[A-Za-z0-9']/;

  const state = {
    data: [],
    pool: [],
    queue: [],
    i: 0,
    mode: "copy",
    levels: ["primary"],
    size: "20",
    order: "smart",
    typed: "",
    target: "",
    chars: [],
    lastLen: 0,
    keys: 0,
    okKeys: 0,
    typedTotal: 0,
    hintCount: 0,
    hintUsed: false,
    hintWord: null,
    silent: false,
    cur: null,
    combo: 0,
    best: 0,
    done: 0,
    startedAt: 0,
    audio: null,
    autoSpeakTimer: 0,
    speakTimer: 0,
    watchTimer: 0,
    seqId: 0,
    answered: false,
    locked: false,
    settledAt: 0,
    sessionWrong: [], // 本轮答错 / 跳过的句子 id，结果页可「只练本次错句」
  };
  const SPACE_COOLDOWN = 350;
  const AUTO_SPEAK_DELAY = 1000;

  /* ---------------- 音效 ---------------- */
  let ctx;
  function beep(freq, dur = 0.07, type = "sine", gain = 0.05) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = gain;
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + dur);
    } catch (_) {}
  }
  const sfxOk = () => { beep(880, 0.06); setTimeout(() => beep(1320, 0.09), 55); };
  const sfxBad = () => beep(170, 0.09, "square", 0.04);

  /* 键盘「嗒」声：预生成噪声段 + 带通滤波，每次微调音色避免机械感 */
  let noiseBuf;
  state.kbdSound = Store.get("kbdSound") !== "0";
  function clack() {
    if (!state.kbdSound) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      if (!noiseBuf) {
        noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.028), ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      }
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 2200 + Math.random() * 1200;
      f.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      s.connect(f).connect(g).connect(ctx.destination);
      s.start();
    } catch (_) {}
  }
  function renderKbdBtn() {
    $("kbdBtn").textContent = state.kbdSound ? "🎹 键盘声" : "🔇 键盘声";
  }
  renderKbdBtn();

  /* ---------------- 音频 ---------------- */
  /* 只停「文件播放」和逐词队列，不碰语音合成 */
  function stopFiles() {
    if (state.audio) { state.audio.pause(); state.audio.currentTime = 0; state.audio = null; }
    state.seqId++;                 // 让上一次的逐词队列失效
    clearTimeout(state.speakTimer);
    clearTimeout(state.watchTimer);
  }
  function stopAudio() {
    stopFiles();
    try { speechSynthesis.cancel(); } catch (_) {}
  }
  function playFile(path, rate = 1, onFail) {
    stopAudio();
    const a = new Audio(path);
    a.playbackRate = rate;
    state.audio = a;
    a.play().catch(() => {
      if (state.audio === a) state.audio = null;
      if (onFail) onFail();
    });
  }
  /* 英音优先（和整句录音的英音 Sonia 一致），其次美音，再退回任意英语。
     Chrome 首次 getVoices() 常返回空数组，等 voiceschanged 后会自然补上。 */
  function pickVoice() {
    let list = [];
    try { list = speechSynthesis.getVoices() || []; } catch (_) {}
    if (!list.length) return null;
    return list.find((x) => /en[-_]GB/i.test(x.lang))
      || list.find((x) => /en[-_]US/i.test(x.lang))
      || list.find((x) => /^en/i.test(x.lang))
      || null;
  }
  /* 朗读的坑（都是实测踩过的）：
     1) Chrome 里 cancel() 之后同一拍 speak() 会被整条丢弃 → 必须隔一拍再说；
        但 iOS 要求 speak 必须在点击的手势调用栈里 → 没在朗读时千万别 cancel，直接同步说。
     2) 长时间静默后引擎会停在 paused → speak 前先 resume。
     3) 800ms 没 onstart、也没排队 → 判定这台机器 TTS 不可用，交给 onFail 兜底。 */
  function speak(text, rate = 0.92, onFail) {
    if (!("speechSynthesis" in window) || !text) return;
    stopFiles();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    u.rate = rate;
    const v = pickVoice();
    if (v) u.voice = v;

    let started = false;
    u.onstart = () => { started = true; clearTimeout(state.watchTimer); };
    u.onerror = () => { if (!started && onFail) onFail(); };

    const fire = () => {
      try { speechSynthesis.resume(); speechSynthesis.speak(u); } catch (_) { if (onFail) onFail(); }
      state.watchTimer = setTimeout(() => {
        if (started) return;
        let busy = false;
        try { busy = speechSynthesis.speaking || speechSynthesis.pending; } catch (_) {}
        if (!busy && onFail) onFail();
      }, 800);
    };

    let busy = false;
    try { busy = speechSynthesis.speaking || speechSynthesis.pending; } catch (_) {}
    if (busy) {
      try { speechSynthesis.cancel(); } catch (_) {}
      state.speakTimer = setTimeout(fire, 90); // 要打断上一句，只能让出一拍
    } else {
      fire();                                   // 空的，直接说：保住 iOS 的用户手势
    }
  }
  function playSentence(s) {
    if (s.audio) playFile("audio/" + s.audio, 1, () => speak(s.en));
    else speak(s.en);
  }
  function playWord(word, rate = 1) {
    const key = normKey(word.t);
    const fallback = () => {
      const f2 = EXTRA.words[key];
      if (f2) playFile("audio/" + f2, rate);
      else speak(word.t.replace(/[^A-Za-z']/g, ""), 0.85);
    };
    // 只有录音文件名与词形完全一致才敢用真人录音：
    // teacher→teach、summer→sum、it's→it 这类旧映射点了会读成别的词，优先用重录的音
    if (word.a && word.a === key) {
      playFile("audio/w/" + word.a + ".mp3", rate, fallback); // 文件缺失→合成音→TTS
      return;
    }
    const f = EXTRA.words[key];
    if (f) {
      playFile("audio/" + f, rate, () => {
        if (word.a) playFile("audio/w/" + word.a + ".mp3", rate, () => speak(word.t.replace(/[^A-Za-z']/g, ""), 0.85));
        else speak(word.t.replace(/[^A-Za-z']/g, ""), 0.85);
      });
      return;
    }
    if (word.a) { playFile("audio/w/" + word.a + ".mp3", rate, () => speak(word.t.replace(/[^A-Za-z']/g, ""), 0.85)); return; }
    speak(word.t.replace(/[^A-Za-z']/g, ""), 0.85); // 再不行才用系统 TTS
  }
  /* 兜底：TTS 不出声时，按词序逐个播真人录音（没录音的虚词跳过），
     至少能听见这个语块，不至于「点了没反应」。 */
  function playSeq(group) {
    const items = group.filter((w) => w.a);
    if (!items.length) return;
    stopAudio();
    const id = state.seqId;
    let i = 0;
    const step = () => {
      if (id !== state.seqId || i >= items.length) return;
      const a = new Audio("audio/w/" + items[i++].a + ".mp3");
      state.audio = a;
      a.addEventListener("ended", () => setTimeout(step, 120));
      a.play().catch(() => setTimeout(step, 60));
    };
    step();
  }

  /* 预生成音频表（build_audio_extra.py 产出）：多词语块 / 缺真人录音的单词。
     浏览器 TTS 靠系统语音包，中文 Windows 常只有中文音色，读英文会直接没声；
     改成播 mp3 后点哪读哪，手机电脑一致。 */
  const EXTRA = (window.AUDIO_EXTRA && window.AUDIO_EXTRA.chunks) ? window.AUDIO_EXTRA : { chunks: {}, words: {} };
  /* 与 build_audio_extra.py 的 norm() 必须完全一致 */
  function normKey(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").replace(/\s+/g, " ").trim();
  }

  /* 点击语块发音：预生成整块音频 → 系统 TTS → 逐词真人音 */
  function playChunk(group) {
    if (!group || !group.length) return;
    if (group.length === 1) { playWord(group[0]); return; }
    const f = EXTRA.chunks[normKey(group.map((w) => w.t).join(" "))];
    if (f) { playFile("audio/" + f, 1, () => playSeq(group)); return; }
    const text = group
      .map((w) => w.t)
      .join(" ")
      .replace(/(\.{2,}|…)/g, ", ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;
    if ("speechSynthesis" in window) speak(text, 0.9, () => playSeq(group));
    else playSeq(group);
  }

  /* iOS 键盘遮挡处理：布局视口不随键盘缩小，用 visualViewport 差值写 --kb，
     .screen / .lockmask 的 bottom 据此上抬（Android 视口自己缩，差值≈0 不生效） */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const applyKb = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--kb", kb + "px");
    };
    vv.addEventListener("resize", applyKb);
    vv.addEventListener("scroll", applyKb);
  }

  /* ---------------- 渲染 ---------------- */
  function renderSentence(s) {
    const blocks = $("blocks");
    blocks.innerHTML = "";
    state.cur = s;
    state.hintUsed = false;
    state.hintWord = null;
    blocks.dataset.level = s.level || "";
    blocks.dataset.mode = state.mode;
    setHintText("");
    state.chars = [];
    state.charWords = [];
    state.target = "";
    state.typed = "";
    state.lastLen = 0;
    $("typer").value = "";
    state.locked = false;
    state.answered = false;
    $("skip").textContent = "跳过";

    if (state.mode !== "copy") blocks.classList.add("hidden-mode");
    else blocks.classList.remove("hidden-mode");

    s.chunks.forEach((group) => {
      const chunk = document.createElement("div");
      chunk.className = "chunk" + (state.mode !== "copy" ? " hidden muted" : "");

      const phones = document.createElement("div");
      phones.className = "phones";
      const words = document.createElement("div");
      words.className = "words";
      const tags = document.createElement("div");
      tags.className = "tags";
      const zhs = document.createElement("div");
      zhs.className = "zhs";

      let posKey = "unk";
      group.forEach((w) => {
        posKey = POS_KEY[w.pos] || (posKey === "unk" ? "unk" : posKey);
        const ph = document.createElement("span");
        ph.textContent = w.p || "—";
        phones.appendChild(ph);

        const wEl = document.createElement("span");
        wEl.className = "w";
        Array.from(w.t).forEach((ch) => {
          const span = document.createElement("span");
          span.className = "ch";
          const ti = TYPEABLE.test(ch) ? state.target.length : -1;
          if (ti >= 0) {
            state.chars.push(span);
            state.charWords.push(w);
            state.target += ch.toLowerCase();
            span.dataset.disp = ch;
          } else {
            span.textContent = ch;
            span.classList.add("ok");
          }
          wEl.appendChild(span);
        });
        words.appendChild(wEl);

        const tag = document.createElement("span");
        tag.textContent = POS_CN[w.pos] || "词";
        tags.appendChild(tag);

        const zh = document.createElement("span");
        zh.textContent = w.zh || "";
        zhs.appendChild(zh);
      });

      chunk.style.setProperty("--c", `var(--${posKey})`);
      words.addEventListener("click", (e) => {
        e.stopPropagation();
        playChunk(group);
        words.classList.remove("speaking");
        void words.offsetWidth; // 重排一次，连点也能重新触发动画
        words.classList.add("speaking");
        setTimeout(() => words.classList.remove("speaking"), 460);
      });
      chunk.appendChild(phones);
      chunk.appendChild(words);
      chunk.appendChild(tags);
      chunk.appendChild(zhs);
      blocks.appendChild(chunk);
    });

    $("zh").textContent = state.mode === "listen" ? "" : s.zh;
    $("zh").classList.toggle("dim", state.mode === "listen");
    $("idx").textContent = state.i + 1;
    $("total").textContent = state.queue.length;
    $("barFill").style.width = `${(state.i / state.queue.length) * 100}%`;
    paint();
    const autoHint = state.mode === "listen" ? "先听一遍，再默写" : "1 秒后自动朗读本句";
    setHintText(autoHint);
    clearTimeout(state.autoSpeakTimer);
    state.autoSpeakTimer = setTimeout(() => {
      if (state.cur !== s || state.locked) return;
      playSentence(s);
      if ($("hint").textContent === autoHint) setHintText("");
    }, AUTO_SPEAK_DELAY);
    focusTyper();
  }

  /* 中译英 / 听写：没打出来的字母保留原字宽（排版不跳），只显示一条下划线空位 */
  function blank(span, disp) {
    span.textContent = disp || "";
    span.classList.add("blank");
  }

  function paint() {
    const t = state.typed;
    state.chars.forEach((span, i) => {
      const disp = span.dataset.disp;
      let text = disp;
      span.className = "ch";
      if (i < t.length) {
        const ok = t[i] === state.target[i];
        // 打对的字符一律按原文大小写显示（首字母、专有名词自动正确），打错的才显示你实际敲的
        text = state.mode === "copy" || ok ? disp : t[i];
        span.classList.add(ok ? "ok" : "bad");
        // 光标统一由「下一个待打字符」承担，打错时也不再额外加一根，避免双光标
        span.textContent = text;
      } else if (state.mode === "copy") {
        // 跟打：英文可见，光标停在当前字母前面
        if (i === t.length) span.classList.add("caret");
        span.textContent = text;
      } else {
        // 中译英 / 听写：每个字母一个等宽下划线空位，光标停在空位前面，打一个才跳下一个
        if (i === t.length) span.classList.add("caret");
        blank(span, disp);
      }
    });
    updateStats();
  }

  function updateStats() {
    const elapsed = state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0;
    const wpm = elapsed > 1 ? Math.round(state.typedTotal / 5 / (elapsed / 60)) : 0;
    $("wpm").textContent = wpm;
    $("acc").textContent = state.keys ? Math.round((state.okKeys / state.keys) * 100) : 100;
    $("combo").classList.toggle("hot", state.combo > 0);
    $("comboN").textContent = state.combo;
  }

  /* ---------------- 输入 ---------------- */
  function focusTyper() {
    const el = $("typer");
    try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  }

  function onInput() {
    if (state.locked) return;
    const el = $("typer");
    const raw = el.value;
    const typed = raw.replace(/[^A-Za-z0-9']/g, "").toLowerCase();
    if (!state.startedAt && typed && !state.silent) state.startedAt = performance.now();

    // 新增字符计入正确率（提示自动补入的不计）
    if (!state.silent && typed.length > state.lastLen) {
      for (let i = state.lastLen; i < typed.length; i++) {
        state.keys++;
        state.typedTotal++;
        if (typed[i] === state.target[i]) { state.okKeys++; clack(); }
        else sfxBad();
      }
    }
    state.lastLen = typed.length;
    state.typed = typed;
    paint();
    /* 长句 + 小屏 + 键盘遮挡：把正在打的词块滚进可视区（已可见时 nearest 不滚动） */
    const sp = state.chars[state.typed.length];
    const ck = sp && sp.closest ? sp.closest(".chunk") : null;
    if (ck && ck.scrollIntoView) ck.scrollIntoView({ block: "nearest" });

    if (typed.length >= state.target.length) {
      if (typed === state.target) complete();
      else shake();
    }
  }

  function setHintText(t) {
    $("hint").textContent = t || "点一下屏幕就能开始打字";
  }

  /* ---------------- 提示 ---------------- */
  function hintNext() {
    if (state.locked) return;
    // 回退到第一个打错的位置
    let pos = 0;
    while (pos < state.typed.length && state.typed[pos] === state.target[pos]) pos++;
    if (pos >= state.target.length) return;
    state.hintUsed = true;
    state.hintCount++;
    state.combo = 0;
    updateStats();
    const el = $("typer");
    state.silent = true;
    // 保留原始大小写展示已揭示的部分
    el.value = state.chars.slice(0, pos + 1).map((c) => c.dataset.disp || "").join("");
    onInput();
    state.silent = false;
    if (state.locked) return; // 已把整句填完 → 进入答案状态，别再覆盖提示文案
    /* 提示朗读：走到「新单词」才发音，同一个词里连按空格不再重复读。
       这样空格 = 逐词过一遍（拼写卡住时用），点语块 = 整块连读（听语流），分工不重叠。 */
    const word = state.charWords[pos];
    if (word && word !== state.hintWord) {
      playWord(word);
      state.hintWord = word;
    }
    setHintText(`已揭示 1 个字符 · 本句不计连击（提示 ×${state.hintCount}）`);
  }

  function revealAll() {
    if (state.locked) return;
    stopAudio();
    state.hintUsed = true;
    state.hintCount++;
    state.combo = 0;
    state.typed = state.target;
    state.lastLen = state.target.length;
    $("typer").value = state.chars.map((c) => c.dataset.disp || "").join("");
    paint();
    settleAnswer("这就是答案 · 按 Enter 继续");
  }

  function complete() {
    if (state.hintUsed) {
      state.chars.forEach((s) => (s.className = "ch ok"));
      settleAnswer("答案已揭晓 · 按 Enter 下一句");
    } else {
      perfect();
    }
  }

  function shake() {
    const b = $("blocks");
    b.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-7px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }],
      { duration: 220 }
    );
  }

  /* 打对（或用过提示）后停在答案上，等用户确认再继续 */
  function settleAnswer(text) {
    if (!state.answered) gradeSentence(!state.hintUsed);
    state.locked = true;
    state.answered = true;
    state.settledAt = performance.now();
    const blocks = $("blocks");
    blocks.classList.remove("hidden-mode");
    blocks.querySelectorAll(".chunk").forEach((c) => c.classList.remove("hidden", "muted"));
    if (state.mode === "listen") {
      $("zh").textContent = state.cur.zh;
      $("zh").classList.remove("dim");
    }
    state.chars.forEach((s) => (s.className = "ch ok"));
    $("skip").textContent = "下一句 →";
    updateStats();
    setHintText(text);
    focusTyper();
  }

  const MILESTONES = [10, 20, 30, 50, 100];

  function mileFlash(n) {
    const el = $("milestone");
    if (!el) return;
    el.textContent = "🔥 连击 ×" + n;
    el.classList.remove("go");
    void el.offsetWidth; // 强制回流，动画可重复触发
    el.classList.add("go");
  }

  function perfect() {
    state.combo++;
    state.done++;
    if (state.combo > state.best) state.best = state.combo;
    const c = $("combo");
    c.classList.add("pop");
    setTimeout(() => c.classList.remove("pop"), 340);
    if (MILESTONES.includes(state.combo)) {
      mileFlash(state.combo);
      beep(660, 0.08);
      setTimeout(() => beep(990, 0.1), 75);
      setTimeout(() => beep(1320, 0.15), 155);
    } else {
      sfxOk();
    }
    settleAnswer("打对了 · 按 Enter 下一句");
  }

  /* ---------------- 会话 ---------------- */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------------- 句子掌握度（FSRS 调度，vendor/ts-fsrs.umd.js） ----------------
     只服务「智能 · 错题优先」的到期判定；顺序模式不看这些数据。
     二值评分映射：对=Good / 错=Again；关闭分钟级短期调度，按天粒度；间隔封顶一年。 */
  const F_LIB = window.FSRS;
  const F_SCHED = F_LIB.fsrs(
    F_LIB.generatorParameters({ enable_fuzz: true, enable_short_term: false, request_retention: 0.9 })
  );
  const F_GOOD = F_LIB.Rating.Good;
  const F_AGAIN = F_LIB.Rating.Again;
  const F_MAX_IVAL = 365; // 天：练得再熟，一年也要回来见一面
  const SRS_KEY = "srs.sent.v2";

  function dayNum() {
    return Math.floor(Date.now() / 86400000);
  }

  function srsAll() {
    try {
      return JSON.parse(Store.get(SRS_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  /* 序列化时 Date 变成了 ISO 字符串，调度前还原 */
  function reviveCard(c) {
    c.due = new Date(c.due);
    if (c.last_review) c.last_review = new Date(c.last_review);
    return c;
  }

  function gradeSentence(ok) {
    if (!state.cur) return;
    const all = srsAll();
    const now = new Date();
    const card = all[state.cur.id] ? reviveCard(all[state.cur.id]) : F_LIB.createEmptyCard(now);
    const next = F_SCHED.next(card, now, ok ? F_GOOD : F_AGAIN).card;
    // miss 标记：FSRS 的 lapses 只在复习后答错才 +1，"新卡答错"它认不出来，自己记
    next.miss = !ok;
    if (!ok) {
      // 答错当天就要回锅（错题优先靠"已到期"识别），不复用 FSRS 的 +1 天
      next.due = new Date(now.getTime() + 5 * 60000);
    } else {
      if ((next.due - now) / 86400000 > F_MAX_IVAL) {
        next.due = new Date(now.getTime() + F_MAX_IVAL * 86400000);
      }
      // 下限 1 天：fuzz 可能把新句间隔缩到几小时，当天不该又变"待复习"
      if (dueDay(next.due) <= dayNum()) {
        next.due = new Date(now.getTime() + 86400000);
      }
    }
    all[state.cur.id] = next;
    Store.set(SRS_KEY, JSON.stringify(all));
    if (!ok && !state.sessionWrong.includes(state.cur.id)) state.sessionWrong.push(state.cur.id);
  }

  /* 到期日 → 天序号（FSRS 的 due 是时刻，池子逻辑只看"是否到期"） */
  function dueDay(rec) {
    return Math.floor(new Date(rec.due).getTime() / 86400000);
  }

  function levelPool() {
    if (state.levels.includes("all")) return state.data;
    const set = new Set(state.levels);
    return state.data.filter((s) => set.has(s.level));
  }

  function levelName() {
    if (state.levels.includes("all")) return "所有";
    return state.levels
      .map((k) => (LEVELS.find((l) => l[0] === k) || ["", ""])[1])
      .filter(Boolean)
      .join("+");
  }

  /* 智能：错题（到期）> 新句 > 到期复习 > 未到期，同级内部打散。
     miss 是我们自己在评分时打的标记（FSRS 的 lapses 认不出"新卡答错"） */
  const F_IS_MISS = (r) => !!r.miss;
  function smartPick(pool, take) {
    const all = srsAll();
    const today = dayNum();
    const g = [[], [], [], []];
    pool.forEach((s) => {
      const r = all[s.id];
      if (!r) g[1].push(s);
      else if (dueDay(r) <= today && F_IS_MISS(r)) g[0].push(s);
      else if (dueDay(r) <= today) g[2].push(s);
      else g[3].push(s);
    });
    // 错题内部也打散（先洗牌再按错次稳定排序），避免同一句永远排第一
    g[0] = shuffle(g[0]).sort((a, b) => all[b.id].lapses - all[a.id].lapses);
    g[2] = shuffle(g[2]);
    g[3].sort((a, b) => dueDay(all[a.id]) - dueDay(all[b.id]));
    return [...g[0], ...shuffle(g[1]), ...g[2], ...g[3]].slice(0, take);
  }

  function pickQueue(pool, take) {
    if (state.order === "seq") {
      // 末段固定 all：旧版键里存的是语法筛选值，保留它才不会让老用户「接着上次」的进度归零
      const key = `cursor.${state.levels.join("+")}.all`;
      let pos = Number(Store.get(key) || 0);
      if (!(pos >= 0 && pos < pool.length)) pos = 0;
      const out = [];
      for (let k = 0; k < take; k++) out.push(pool[(pos + k) % pool.length]);
      Store.set(key, String((pos + take) % pool.length));
      return out;
    }
    return smartPick(pool, take);
  }

  /* 别让最近几局的开头句又打头（错题只有一句时最容易一进门就撞见同一句） */
  function leadHistory() {
    try {
      const v = JSON.parse(Store.get("lastLead") || "[]");
      if (Array.isArray(v)) return v;
      return typeof v === "number" ? [v] : []; // 兼容旧格式：单个数字
    } catch (e) {
      return [];
    }
  }
  function saveLead(id) {
    if (!id) return;
    Store.set("lastLead", JSON.stringify([id, ...leadHistory()].slice(0, 3)));
  }
  function varyLead(queue) {
    if (!queue.length) return queue;
    const recent = leadHistory();
    if (recent.includes(queue[0].id)) {
      const end = Math.min(queue.length, 12);
      for (let k = 1; k < end; k++) {
        if (!recent.includes(queue[k].id)) {
          [queue[0], queue[k]] = [queue[k], queue[0]];
          break;
        }
      }
    }
    saveLead(queue[0].id);
    return queue;
  }

  function updateBegin() {
    if (!state.data.length || !$("begin")) return;
    const n = levelPool().length;
    $("begin").disabled = n === 0;
    if (!n) {
      $("begin").textContent = `该难度暂时没有例句`;
      return;
    }
    const take = state.size === "all" ? n : Math.min(Number(state.size) || 20, n);
    const tag = state.order === "seq" ? " · 接着上次" : "";
    $("begin").textContent =
      state.size === "all"
        ? `开始 · 全部 ${take} 句（${levelName()}${tag}）`
        : `开始 · ${take} 句（${levelName()} ${n} 句${tag}）`;
  }

  function renderSrsInfo() {
    const el = $("srsInfo");
    if (!el || !state.data.length) return;
    const pool = levelPool();
    const all = srsAll();
    const today = dayNum();
    let done = 0;
    let due = 0;
    let fresh = 0;
    pool.forEach((s) => {
      const r = all[s.id];
      if (!r) {
        fresh++;
        return;
      }
      done++;
      if (dueDay(r) <= today) due++;
    });
    el.textContent = `${levelName()} 共 ${pool.length} 句 · 已练 ${done} · 待复习 ${due} · 未练 ${fresh}`;
  }

  function start() {
    const pool = levelPool().slice().sort((a, b) => a.id - b.id);
    state.pool = pool.length ? pool : state.data;
    const take = state.size === "all" ? state.pool.length : Math.min(Number(state.size) || 20, state.pool.length);
    state.queue = pickQueue(state.pool, take);
    // 顺序模式保持严格顺序，其余模式保证换一局不是同一句打头
    if (state.order !== "seq") varyLead(state.queue);
    else saveLead(state.queue[0] && state.queue[0].id);
    resetRun();
  }

  /* 结果页「只练本次错句」：把本轮答错 / 跳过的句子再开一轮（打散顺序） */
  function startWrong() {
    const ids = state.sessionWrong.slice();
    if (!ids.length) return;
    state.pool = state.data.filter((s) => ids.includes(s.id));
    state.queue = shuffle(state.pool);
    resetRun();
  }

  /* 开一局的公共初始化：queue 已就位，重置统计后进练习页 */
  function resetRun() {
    state.i = 0;
    state.combo = 0;
    state.best = 0;
    state.done = 0;
    state.keys = 0;
    state.okKeys = 0;
    state.typedTotal = 0;
    state.hintCount = 0;
    state.startedAt = 0;
    state.sessionWrong = [];
    updateStats();
    show("game");
    renderSentence(state.queue[0]);
  }

  function next() {
    state.i++;
    if (state.i >= state.queue.length) return finish();
    renderSentence(state.queue[state.i]);
  }

  function finish() {
    clearTimeout(state.autoSpeakTimer);
    stopAudio();
    $("resCombo").textContent = state.best;
    $("resDone").textContent = `${state.done} 句`;
    $("resHint").textContent = `× ${state.hintCount}`;
    const elapsed = state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0;
    $("resWpm").textContent = `${elapsed > 1 ? Math.round(state.typedTotal / 5 / (elapsed / 60)) : 0} WPM`;
    $("resAcc").textContent = `${state.keys ? Math.round((state.okKeys / state.keys) * 100) : 100}%`;
    const prev = Number(Store.get("best") || 0);
    if (state.best > prev) Store.set("best", String(state.best));
    const aw = $("againWrong");
    if (aw) {
      aw.hidden = !state.sessionWrong.length;
      aw.textContent = "🔁 只练本次错句 · " + state.sessionWrong.length + " 句";
    }
    show("result");
  }

  function show(id) {
    ["start", "game", "result", "words", "exam"].forEach((k) => {
      const el = $(k);
      if (el) el.classList.toggle("is-on", k === id);
    });
    // 回首页时刷新统计与按钮文案（刚练完一轮，数字可能变了）
    if (id === "start" && state.data.length) {
      updateBegin();
      renderSrsInfo();
    }
  }

  /* 任意子页面回首页：先停掉正在播的音频/定时器，再切屏 */
  function goHome() {
    stopAudio();
    stopFiles();
    show("start");
  }
  window.AppHome = goHome;

  /* ---------------- 难度（可多选；「所有」独占） ---------------- */
  const LEVELS = [
    ["all", "所有"], ["primary", "小学"], ["g7", "初一"], ["g8", "初二"], ["g9", "初三"],
    /* 高中三档先占位，题库还没有内容：渲染成虚线胶囊、点了不响应 */
    ["g10", "高一"], ["g11", "高二"], ["g12", "高三"],
  ];
  const LEVEL_ORDER = LEVELS.map(([k]) => k);

  /* 存的是数组；兼容旧版本存裸字符串（"g7"）或更早的单选值 */
  function readLevels() {
    const saved = Store.get("level");
    let arr = [];
    if (saved) {
      try {
        const v = JSON.parse(saved);
        arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      } catch (e) {
        arr = [saved]; // 旧格式：直接存的 "g7" / "primary" / "all"
      }
    }
    arr = arr.filter((k) => LEVEL_ORDER.includes(k));
    if (!arr.length) return ["primary"];
    if (arr.includes("all")) return ["all"];
    return LEVEL_ORDER.filter((k) => arr.includes(k)); // 固定顺序：小学 → 初一 → 初二 → 初三
  }

  function saveLevels() {
    const v = JSON.stringify(state.levels);
    if (Store.get("level") !== v) Store.set("level", v); // 没变就不写，免得每次打开都动进度文件
  }

  function syncChips() {
    ["levels", "levels2"].forEach((id) => {
      const el = $(id);
      if (el) [...el.children].forEach((b) => b.classList.toggle("is-on", state.levels.includes(b.dataset.level)));
    });
  }

  function renderChips() {
    const counts = {};
    state.data.forEach((s) => (counts[s.level] = (counts[s.level] || 0) + 1));
    const html = LEVELS.map(([v, label]) => {
      const n = v === "all" ? state.data.length : counts[v] || 0;
      const on = state.levels.includes(v) ? " is-on" : "";
      if (v !== "all" && !n) {
        return `<button class="chip is-empty" data-level="${v}" disabled title="内容待补">${label}<small>待补</small></button>`;
      }
      return `<button class="chip${on}" data-level="${v}">${label} · ${n}</button>`;
    }).join("");
    ["levels", "levels2"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.innerHTML = html;
      el.onclick = (e) => {
        const btn = e.target.closest(".chip");
        if (btn && !btn.disabled) toggleLevel(btn.dataset.level);
      };
    });
  }

  /* 点「所有」= 只留所有；点具体年级 = 在已选里加减，最后一个不允许取消 */
  function toggleLevel(v) {
    if (!LEVEL_ORDER.includes(v)) return;
    if (v === "all") {
      if (state.levels.length === 1 && state.levels[0] === "all") return;
      state.levels = ["all"];
    } else {
      let cur = state.levels.filter((k) => k !== "all");
      if (cur.includes(v)) {
        if (cur.length === 1) return; // 至少保留一个年级
        cur = cur.filter((k) => k !== v);
      } else {
        cur.push(v);
      }
      state.levels = LEVEL_ORDER.filter((k) => cur.includes(k));
    }
    saveLevels();
    syncChips();
    if (state.data.length) {
      updateBegin();
      renderSrsInfo();
      }
  }

  /* ---------------- 题量与抽题规则 ---------------- */
  const SIZES = [["20", "20 句"], ["50", "50 句"], ["100", "100 句"], ["all", "全部"]];
  const ORDERS = [["smart", "智能 · 错题优先"], ["seq", "顺序 · 接着上次"]];

  function renderSizes() {
    $("sizes").innerHTML = SIZES.map(
      ([v, label]) => `<button class="chip${state.size === v ? " is-on" : ""}" data-size="${v}">${label}</button>`
    ).join("");
    $("orders").innerHTML = ORDERS.map(
      ([v, label]) => `<button class="chip${state.order === v ? " is-on" : ""}" data-order="${v}">${label}</button>`
    ).join("");
  }

  /* ---------------- 绑定 ---------------- */
  $("modes").addEventListener("click", (e) => {
    const btn = e.target.closest(".mode");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    Store.set("mode", state.mode);
    [...$("modes").children].forEach((b) => b.classList.toggle("is-on", b === btn));
  });

  $("profiles").addEventListener("click", (e) => {
    const btn = e.target.closest(".pbtn");
    if (btn) switchProfile(btn.dataset.p);
  });

  /* 密码锁：确认 / 取消 / 回车 / 点背景关闭 */
  $("lockOk").addEventListener("click", submitLock);
  $("lockCancel").addEventListener("click", () => closeLock(false));
  $("lockMask").addEventListener("click", (e) => {
    if (e.target === $("lockMask")) closeLock(false);
  });
  $("lockPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitLock();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeLock(false);
    }
  });
  $("lockChange").addEventListener("click", openPassChange);

  /* 改密码弹窗 */
  $("passOk").addEventListener("click", submitPassChange);
  $("passCancel").addEventListener("click", closePassChange);
  $("passMask").addEventListener("click", (e) => {
    if (e.target === $("passMask")) closePassChange();
  });
  ["passOld", "passNew", "passNew2"].forEach((id) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitPassChange();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePassChange();
      }
    });
  });

  $("begin").addEventListener("click", start);
  $("sizes").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    state.size = btn.dataset.size;
    Store.set("size", state.size);
    [...$("sizes").children].forEach((b) => b.classList.toggle("is-on", b === btn));
    updateBegin();
  });
  $("orders").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    state.order = btn.dataset.order;
    Store.set("order", state.order);
    [...$("orders").children].forEach((b) => b.classList.toggle("is-on", b === btn));
    updateBegin();
  });
  $("openWords").addEventListener("click", () => {
    show("words");
    window.WordBook.start(state.levels);
  });
  window.WordBookHome = () => {
    show("start");
  };
  $("wBack").addEventListener("click", () => {
    stopAudio();
    window.WordBookHome && window.WordBookHome();
  });
  $("gBack").addEventListener("click", goHome);
  $("again").addEventListener("click", start);
  $("againWrong").addEventListener("click", startWrong);
  $("home").addEventListener("click", () => show("start"));
  $("skip").addEventListener("click", () => {
    if (state.answered) { next(); return; }
    gradeSentence(false);   // 直接跳过 = 没掌握，下一轮优先再来
    state.combo = 0;
    next();
  });
  $("quit").addEventListener("click", finish);
  $("hintBtn").addEventListener("click", hintNext);
  $("answerBtn").addEventListener("click", revealAll);
  $("kbdBtn").addEventListener("click", () => {
    state.kbdSound = !state.kbdSound;
    Store.set("kbdSound", state.kbdSound ? "1" : "0");
    renderKbdBtn();
    if (state.kbdSound) clack(); // 开启时给一声反馈
  });
  $("playSentence").addEventListener("click", () => playSentence(state.queue[state.i]));
  $("playSlow").addEventListener("click", () => {
    const s = state.queue[state.i];
    if (s.audio) playFile("audio/" + s.audio, 0.7);
    else speak(s.en, 0.65);
  });

  $("stage").addEventListener("click", focusTyper);
  $("typer").addEventListener("input", onInput);
  $("typer").addEventListener("blur", () => setTimeout(() => { if ($("game").classList.contains("is-on")) focusTyper(); }, 120));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if ($("game").classList.contains("is-on")) finish(); return; }
    if (e.key === "Tab") {
      if ($("game").classList.contains("is-on")) {
        e.preventDefault();
        e.shiftKey ? revealAll() : hintNext();
      }
      return;
    }
    if (e.key === " " || e.code === "Space") {
      if ($("game").classList.contains("is-on")) {
        e.preventDefault();
        if (state.answered) {
          /* 刚打完的一瞬间忽略空格，防止连击跳过下一题开头 */
          if (performance.now() - state.settledAt >= SPACE_COOLDOWN) next();
        }
        else hintNext();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if ($("game").classList.contains("is-on")) {
        if (state.answered) {
          if (performance.now() - state.settledAt >= SPACE_COOLDOWN) next();
          return;
        }
        if (e.ctrlKey) { revealAll(); return; }
        state.combo = 0;
        next();
      } else if ($("start").classList.contains("is-on")) start();
      return;
    }
    if (!$("game").classList.contains("is-on")) return;
    if (e.key.length === 1 || e.key === "Backspace") focusTyper();
  });

  /* ---------------- 档案（男 / 女，各自独立进度） ---------------- */
  const MODES = ["copy", "recall", "listen"];

  function readMode() {
    const v = Store.get("mode");
    return MODES.includes(v) ? v : "copy";
  }
  function renderMode() {
    [...$("modes").children].forEach((b) => b.classList.toggle("is-on", b.dataset.mode === state.mode));
  }
  function readSize() {
    const v = Store.get("size");
    return SIZES.some(([k]) => k === v) ? v : "20";
  }
  function readOrder() {
    const v = Store.get("order");
    return ORDERS.some(([k]) => k === v) ? v : "smart";
  }
  function syncProfileUI() {
    const box = $("profiles");
    if (!box) return;
    [...box.children].forEach((b) => {
      b.classList.toggle("is-on", b.dataset.p === Store.profile());
      const locked =
        Store.needsPass && Store.needsPass(b.dataset.p) && !Store.hasPass(b.dataset.p);
      b.classList.toggle("is-locked", !!locked);
    });
  }

  /* ---------------- 档案密码锁 ---------------- */
  let lockResolve = null;
  let lockTarget = "boy";

  function lockError(msg) {
    const el = $("lockErr");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  /* 弹出密码框，返回 Promise<boolean>：true 解锁成功，false 用户取消 */
  function askPass(p) {
    lockTarget = p;
    $("lockTitle").textContent = Store.label(p) + "档案";
    $("lockSub").textContent = "输入密码进入";
    $("lockPass").value = "";
    lockError("");
    $("lockMask").hidden = false;
    setTimeout(() => {
      try {
        $("lockPass").focus();
      } catch (e) {}
    }, 40);
    return new Promise((res) => {
      lockResolve = res;
    });
  }

  function closeLock(ok) {
    $("lockMask").hidden = true;
    $("lockPass").value = "";
    const r = lockResolve;
    lockResolve = null;
    if (r) r(!!ok);
  }

  async function submitLock() {
    const pass = $("lockPass").value.trim();
    if (!pass) {
      lockError("请输入密码");
      return;
    }
    const btn = $("lockOk");
    btn.disabled = true;
    const ok = await Store.unlock(lockTarget, pass);
    btn.disabled = false;
    if (!ok) {
      lockError("密码不对，再试一次");
      $("lockPass").value = "";
      try {
        $("lockPass").focus();
      } catch (e) {}
      return;
    }
    closeLock(true);
  }

  function passError(msg) {
    const el = $("passErr");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function openPassChange() {
    $("passTitle").textContent = "修改" + Store.label(lockTarget) + "的密码";
    $("passOld").value = "";
    $("passNew").value = "";
    $("passNew2").value = "";
    passError("");
    $("passMask").hidden = false;
    setTimeout(() => {
      try {
        $("passOld").focus();
      } catch (e) {}
    }, 40);
  }

  function closePassChange() {
    $("passMask").hidden = true;
    $("passOld").value = "";
    $("passNew").value = "";
    $("passNew2").value = "";
  }

  async function submitPassChange() {
    const oldP = $("passOld").value.trim();
    const n1 = $("passNew").value.trim();
    const n2 = $("passNew2").value.trim();
    if (!oldP) return passError("请输入原密码");
    if (n1.length < 4) return passError("新密码至少 4 位");
    if (n1 !== n2) return passError("两次输入的新密码不一致");
    const btn = $("passOk");
    btn.disabled = true;
    const r = await Store.changePass(lockTarget, oldP, n1);
    btn.disabled = false;
    if (!r.ok) return passError(r.error || "修改失败");
    closePassChange();
    closeLock(true); // 改完直接用新密码进入
  }

  /* 切换档案：整套偏好和进度都换成对方那一份，页面就地刷新，不用重新加载 */
  async function switchProfile(p) {
    if (Store.needsPass && Store.needsPass(p) && !Store.hasPass(p)) {
      const ok = await askPass(p);
      if (!ok) return;
    }
    if (!Store.setProfile(p)) return;
    state.mode = readMode();
    state.levels = readLevels();
    state.size = readSize();
    state.order = readOrder();
    state.kbdSound = Store.get("kbdSound") !== "0";
    renderKbdBtn();
    syncProfileUI();
    renderMode();
    renderSizes();
    renderChips();
    if (state.data.length) {
      updateBegin();
      renderSrsInfo();
      }
  }

  /* ---------------- 数据 ---------------- */
  async function load() {
    // 等进度文件回灌到本地存储后再开始读偏好（没接口时会立刻返回）
    if (window.Store && Store.ready) {
      try {
        await Store.ready;
      } catch (e) {}
    }
    if (window.SENTENCES) return window.SENTENCES.sentences;
    const res = await fetch("data/sentences.json");
    const json = await res.json();
    return json.sentences;
  }

  load()
    .then((list) => {
      state.data = list;
      // 恢复当前档案上次的选择
      state.mode = readMode();
      state.levels = readLevels();
      state.size = readSize();
      state.order = readOrder();
      syncProfileUI();
      renderMode();
      renderSizes();
      renderChips();
      $("begin").disabled = false;
      // 这里不再回写 level：没改动就不产生写盘，删掉进度文件后不会一打开又冒出来
      updateBegin();
      renderSrsInfo();
        // 兜底：万一停在要密码的档案（正常不会，profile.js 已默认回游客）→ 直接退回游客
      if (window.Store && Store.syncState && Store.syncState() === "lock") {
        switchProfile("guest");
      }
    })
    .catch(() => {
      $("begin").textContent = "数据加载失败，请用本地服务器打开";
    });
})();
