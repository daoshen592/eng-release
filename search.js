/* 查词：背单词页的第三个模式（卡片 / 拼写补全 / 查词）
 * 数据：data/words.js（window.WORDS），跨册重复按拼写合并
 * 匹配：英文拼写（完全相同 > 前缀 > 短语整词命中 > 包含）+ 中文释义包含
 * 点结果 → 回调给 wordbook.js，打开该词的卡片
 *
 * ── 契约 ─────────────────────────────────────────────
 * 依赖：window.WORDS（只读）
 * 导出：window.WordSearch（被 wordbook.js 调起；选中词经 open() 的回调参数回传）
 * 加载序：Store 之后、wordbook 之前即可（无状态，不依赖其他模块）
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LIMIT = 60;
  const LV_CN = { primary: "小学", g7: "初一", g8: "初二", g9: "初三" };
  const LV_RANK = { primary: 0, g7: 1, g8: 2, g9: 3 };

  let items = null; // 去重后的词条
  let rows = []; // 当前结果（点击时按序号取）
  let pickFn = null;
  let bound = false;

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* 高亮命中的片段（英文忽略大小写，中文直接找） */
  function hl(text, q) {
    const t = String(text == null ? "" : text);
    if (!q) return esc(t);
    const low = t.toLowerCase();
    const idx = low.indexOf(q);
    if (idx < 0) return esc(t);
    return esc(t.slice(0, idx)) + "<mark>" + esc(t.slice(idx, idx + q.length)) + "</mark>" + esc(t.slice(idx + q.length));
  }

  function pool() {
    if (items) return items;
    const all = (window.WORDS && window.WORDS.words) || [];
    const seen = new Set();
    const out = [];
    all.forEach((w) => {
      if (!w || !w.k || seen.has(w.k)) return;
      seen.add(w.k);
      out.push(w);
    });
    items = out;
    return items;
  }

  /* 返回 -1 表示不匹配；数字越小越靠前 */
  function score(w, q, zh) {
    const k = w.k;
    if (zh) return String(w.z || "").indexOf(q) >= 0 ? 1 : -1;
    if (k === q) return 0;
    if (k.startsWith(q)) return 1;
    if (k.indexOf(" " + q) > 0) return 2; // 短语里的整词命中，如 water 命中 hot water
    if (k.indexOf(q) > 0) return 3;
    return -1;
  }

  function search(raw) {
    const q = String(raw || "").trim().toLowerCase();
    if (!q) return [];
    const zh = /[\u4e00-\u9fff]/.test(q);
    const hits = [];
    for (const w of pool()) {
      const s = score(w, q, zh);
      if (s < 0) continue;
      hits.push({ w, s });
    }
    hits.sort(
      (a, b) =>
        a.s - b.s ||
        a.w.k.length - b.w.k.length ||
        (LV_RANK[a.w.l] || 0) - (LV_RANK[b.w.l] || 0) ||
        a.w.k.localeCompare(b.w.k)
    );
    return hits.slice(0, LIMIT).map((x) => x.w);
  }

  function itemHTML(w, q, i) {
    const ex = (w.e && w.e.en) || (w.e2 && w.e2.en) || "";
    const col = w.col && w.col.length ? w.col[0] : "";
    const lv = LV_CN[w.l] || "";
    return (
      `<button class="sritem" type="button" data-i="${i}">` +
      `<span class="srline"><b class="srw">${hl(w.k, q)}</b>` +
      `<span class="sripa">${esc(w.i || "")}</span>` +
      `<span class="srpos">${esc(w.p || "")}</span>` +
      `<span class="srzh">${hl(w.z || "", q)}</span></span>` +
      `<span class="srmeta">${esc(w.u || "")}${lv ? " · " + lv : ""}</span>` +
      (ex ? `<span class="srexline">${esc(ex)}</span>` : col ? `<span class="srexline">${esc(col)}</span>` : "") +
      `</button>`
    );
  }

  function render() {
    const input = $("wsInput"), list = $("wsList"), tip = $("wsTip");
    if (!input) return;
    const q = String(input.value || "").trim();
    if (!q) {
      rows = [];
      list.innerHTML = "";
      tip.textContent = `${pool().length.toLocaleString("en-US")} 个词条（含短语）· 点结果打开该词的卡片`;
      return;
    }
    rows = search(q);
    if (!rows.length) {
      list.innerHTML = "";
      tip.textContent = `没找到「${q}」——试试只输前几个字母，或换中文释义`;
      return;
    }
    tip.textContent = rows.length >= LIMIT ? `显示前 ${LIMIT} 条 · 点一条打开卡片` : `共 ${rows.length} 条 · 点一条打开卡片`;
    const ql = q.toLowerCase();
    const zhq = /[\u4e00-\u9fff]/.test(q) ? q : "";
    list.innerHTML = rows.map((w, i) => itemHTML(w, zhq || ql, i)).join("");
    list.scrollTop = 0;
  }

  function bind() {
    if (bound) return;
    const input = $("wsInput"), list = $("wsList");
    if (!input || !list) return;
    bound = true;
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (rows.length) pick(0); // 回车 = 打开第一条
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const first = list.querySelector(".sritem");
        if (first) first.focus();
      }
    });
    list.addEventListener("click", (e) => {
      const it = e.target.closest(".sritem");
      if (!it) return;
      pick(Number(it.dataset.i));
    });
    list.addEventListener("keydown", (e) => {
      const it = e.target.closest(".sritem");
      if (!it) return;
      const i = Number(it.dataset.i);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick(i);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const nx = list.querySelectorAll(".sritem")[i + 1];
        if (nx) nx.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const pv = list.querySelectorAll(".sritem")[i - 1];
        if (pv) pv.focus();
        else $("wsInput").focus();
      }
    });
  }

  function pick(i) {
    const w = rows[i];
    if (!w) return;
    if (pickFn) pickFn(w);
  }

  window.WordSearch = {
    /* 切到查词模式：初始化 → 清空 → 聚焦 */
    open() {
      bind();
      const input = $("wsInput"), list = $("wsList"), tip = $("wsTip");
      if (!input) return;
      input.value = "";
      list.innerHTML = "";
      rows = [];
      tip.textContent = `${pool().length.toLocaleString("en-US")} 个词条（含短语）· 点结果打开该词的卡片`;
      setTimeout(() => input.focus(), 30);
    },
    close() {
      try { speechSynthesis.cancel(); } catch (_) {}
    },
    /* wordbook.js 注册「点结果 → 打开卡片」 */
    onPick(fn) {
      bind();
      pickFn = fn;
    },
  };

  bind();
})();
