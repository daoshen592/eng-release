/* 本机多档案：游客 / 男生 / 女生，三个档案各存各的进度
 *
 * 1) 浏览器里始终存一份（localStorage，键前缀 chunk.<档案>.），断网、没装 PHP 也能用；
 * 2) 同目录若有 progress.php，则每个档案整体镜像成一个文件：
 *      progress/guest.json、progress/boy.json、progress/girl.json
 *    页面打开时「以文件为准」—— 想清空某个档案的进度，直接删掉对应文件即可。
 * 3) 男生 / 女生档案需要密码（默认 12345，界面上不提示）。密码由 progress.php
 *    校验并存在 progress/pass.config.php；没有 PHP 时退回本机 localStorage 里的
 *    密码。解锁状态只在本标签页有效（sessionStorage），关掉页面就要重新输入。
 * 没有接口（纯静态托管）时自动退回 1)，不报错。
 *
 * ── 契约 ─────────────────────────────────────────────
 * 依赖：无（仅 DOM / localStorage，不碰任何 data 全局）
 * 导出：window.Store（唯一持久化口，get/set/profile/unlock…）
 * 加载序：功能模块中必须第一个 —— wordbook/exam/cloze/app 都依赖 Store
 */
(function () {
  "use strict";

  const PK = "chunk.profile.v1";
  const MIGRATE = "chunk.migrated.v2";
  const INIT = "chunk.sync.init"; // 这个浏览器已经接过文件同步的标记
  const PROFILES = [["guest", "游客"], ["boy", "男生"], ["girl", "女生"]];
  const LOCKED = new Set(["boy", "girl"]);
  const DEFAULT_PASS = "12345";
  const RESERVED = new Set([PK, MIGRATE]);
  const API = "progress.php";
  const DELAY = 700; // 连续写入合并成一次

  /* 密码：解锁状态放 sessionStorage（关页面即失效），本机兜底密码放 localStorage */
  const passKey = (p) => `chunk.pass.${p}`;
  const localPassKey = (p) => `chunk.lock.${p}`;

  let cur = localStorage.getItem(PK);
  if (!PROFILES.some(([k]) => k === cur)) cur = "guest";
  /* 默认游客：要密码的档案只在本标签页解锁过才恢复，新开页面一律回游客 */
  if (LOCKED.has(cur) && !sessionStorage.getItem(passKey(cur))) cur = "guest";

  const key = (name) => `chunk.${cur}.${name}`;
  const pfx = () => `chunk.${cur}.`;

  /* 一次性迁移：把无前缀的历史数据（chunk.srs.v1 / chunk.level / chunk.cursor.* …）搬进当前档案 */
  try {
    if (!localStorage.getItem(MIGRATE)) {
      const olds = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("chunk.") || RESERVED.has(k)) continue;
        if (/^chunk\.(guest|boy|girl)\./.test(k)) continue; // 已带档案前缀
        if (k.startsWith("chunk.pass.") || k.startsWith("chunk.lock.")) continue; // 密码相关
        olds.push(k);
      }
      olds.forEach((k) => {
        const v = localStorage.getItem(k);
        const nk = key(k.slice("chunk.".length));
        if (v != null && localStorage.getItem(nk) == null) localStorage.setItem(nk, v);
      });
      localStorage.setItem(MIGRATE, "1");
    }
  } catch (e) {}

  /* ---------------- 文件同步 ---------------- */
  let status = "local"; // local 没有接口 | empty 还没文件 | synced | lock 需要密码 | error
  let hasApi = false;
  let timer = 0;
  let chain = Promise.resolve();
  let lastSent = ""; // 上次已落盘的内容指纹，避免重复写

  function snapshot() {
    const data = {};
    const p = pfx();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(p)) data[k] = localStorage.getItem(k);
    }
    return { v: 1, ts: Date.now(), data };
  }

  /* 只比较「数据」，不比较时间戳 */
  function dataJson() {
    const d = snapshot().data;
    return JSON.stringify(Object.keys(d).sort().map((k) => [k, d[k]]));
  }

  function clearProfile() {
    const p = pfx();
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(p)) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  }

  function restore(obj) {
    clearProfile();
    const data = obj && obj.data;
    if (!data || typeof data !== "object") return;
    const p = pfx();
    Object.keys(data).forEach((k) => {
      if (k.startsWith(p) && typeof data[k] === "string") localStorage.setItem(k, data[k]);
    });
  }

  function request(qs, method, body, headers) {
    const ctrl = new AbortController();
    const ms = method === "GET" ? 2500 : 6000;
    const t = setTimeout(() => ctrl.abort(), ms);
    const h = Object.assign({}, headers || {});
    if (body) h["Content-Type"] = "application/json";
    return fetch(API + "?" + qs, {
      method: method,
      cache: "no-store",
      headers: Object.keys(h).length ? h : undefined,
      body: body,
      signal: ctrl.signal,
    })
      .then((r) => {
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        if (!ct.includes("json")) throw new Error("no-json"); // .php 被当静态文件返回了
        return r.json().then((j) => {
          /* 接口约定：一律 200，错误放在 {"error":"…"} 里
             （DSM 的 nginx 会把 4xx/5xx 换成 HTML 错误页，拿不到 JSON） */
          if (j && j.error) {
            const err = new Error(j.error);
            err.code = j.error;
            err.payload = j;
            throw err;
          }
          if (!r.ok) throw new Error("http-" + r.status);
          return j;
        });
      })
      .finally(() => clearTimeout(t));
  }

  function apiFor(p, method, body) {
    const h = {};
    if (LOCKED.has(p)) {
      const pass = sessionStorage.getItem(passKey(p));
      if (pass) h["X-Profile-Pass"] = pass;
    }
    return request("p=" + encodeURIComponent(p), method, body, h);
  }

  /* 打开 / 切档案：以文件为准；文件不存在 = 该档案没有进度
     例外：第一次接入文件同步（本机已有进度、还没接过文件）→ 先把本机进度上传成文件，
     这样"先用纯静态、后来才装 PHP"不会把已有进度清掉；此后删文件才是清空。 */
  async function hydrate(reloadIfChanged) {
    const before = dataJson();
    try {
      const j = await apiFor(cur, "GET");
      hasApi = true;
      const hasFile = j && j.data && typeof j.data === "object" && Object.keys(j.data).length;
      if (hasFile) {
        restore(j);
        status = "synced";
        lastSent = dataJson(); // 刚读回来的内容不需要再写一遍
      } else if (dataJson() !== "[]" && !localStorage.getItem(INIT)) {
        status = "empty";
        lastSent = "";
        commit(); // 首次接入：把本机进度写成第一个文件
        localStorage.setItem(INIT, "1");
      } else {
        clearProfile();
        status = "empty";
        lastSent = "";
      }
    } catch (e) {
      if (e && (e.code === "need-pass" || e.code === "bad-pass")) {
        /* 需要密码 / 密码不对：不动本地数据，等用户解锁 */
        hasApi = true;
        status = "lock";
        return;
      }
      hasApi = false;
      status = "local";
    }
    if (reloadIfChanged && dataJson() !== before) location.reload();
  }

  /* 串行写盘：同一档案的多次写入按顺序落盘，避免并发覆盖 */
  function enqueue(p, snap, sig) {
    chain = chain.then(() =>
      apiFor(p, "POST", JSON.stringify(snap)).then(
        () => {
          if (p === cur) {
            lastSent = sig;
            if (!localStorage.getItem(INIT)) localStorage.setItem(INIT, "1");
            status = "synced";
          }
        },
        () => {
          if (p === cur) status = "error";
        }
      )
    );
  }

  /* 只有内容真的变了、且不是空档案时才写盘：
     空档案不落盘 —— 删掉文件后不会被"自动重建" */
  function commit() {
    if (!hasApi || status === "lock") return;
    const sig = dataJson();
    if (sig === "[]" || sig === lastSent) return;
    enqueue(cur, snapshot(), sig);
  }

  function schedule() {
    if (!hasApi || status === "lock") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      commit();
    }, DELAY);
  }

  function flushNow() {
    if (!hasApi || status === "lock") return;
    clearTimeout(timer);
    timer = 0;
    commit();
  }

  /* 关页面 / 切到后台时把还没落盘的那几百毫秒补上 */
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushNow();
  });

  window.Store = {
    profiles: PROFILES,
    profile: () => cur,
    label: (p) => (PROFILES.find(([k]) => k === p) || ["", ""])[1],
    ready: hydrate(false),
    syncState: () => status,

    /* ---- 密码 ---- */
    needsPass: (p) => LOCKED.has(p || cur),
    hasPass: (p) => !!sessionStorage.getItem(passKey(p || cur)),

    /* 解锁：成功返回 true，密码缓存在本标签页 */
    async unlock(p, pass) {
      if (!LOCKED.has(p)) return true;
      pass = String(pass == null ? "" : pass);
      if (hasApi) {
        try {
          await request("p=pass&act=check", "POST", JSON.stringify({ profile: p, pass: pass }));
        } catch (e) {
          return false;
        }
      } else {
        const saved = localStorage.getItem(localPassKey(p)) || DEFAULT_PASS;
        if (saved !== pass) return false;
      }
      sessionStorage.setItem(passKey(p), pass);
      return true;
    },

    /* 改密码：返回 {ok:true} 或 {ok:false, error:"…"} */
    async changePass(p, oldPass, newPass) {
      if (!LOCKED.has(p)) return { ok: false, error: "该档案不需要密码" };
      if (!newPass || String(newPass).length < 4) return { ok: false, error: "新密码至少 4 位" };
      if (String(newPass).length > 32) return { ok: false, error: "新密码最长 32 位" };
      if (hasApi) {
        try {
          await request(
            "p=pass&act=set",
            "POST",
            JSON.stringify({ profile: p, pass: String(oldPass || ""), new: String(newPass) })
          );
        } catch (e) {
          const code = e && e.payload && e.payload.error;
          const msg =
            code === "bad-pass" ? "原密码不对" : code === "need-pass" ? "请先输入密码" : code || "修改失败";
          return { ok: false, error: msg };
        }
      } else {
        const saved = localStorage.getItem(localPassKey(p)) || DEFAULT_PASS;
        if (saved !== String(oldPass || "")) return { ok: false, error: "原密码不对" };
        localStorage.setItem(localPassKey(p), String(newPass));
      }
      sessionStorage.setItem(passKey(p), String(newPass));
      return { ok: true };
    },

    setProfile(p) {
      if (!PROFILES.some(([k]) => k === p)) return false;
      if (p === cur) return true;
      flushNow(); // 旧档案最后的状态先入队（快照此刻取，取的是旧档案）
      cur = p;
      localStorage.setItem(PK, p);
      status = hasApi ? "empty" : "local";
      hydrate(true); // 新档案回灌；文件里的数据不一样就刷新页面
      return true;
    },

    /* 解锁后重新拉一次当前档案（不刷新页面） */
    refresh: () => hydrate(true),

    get: (name) => localStorage.getItem(key(name)),
    set: (name, v) => {
      localStorage.setItem(key(name), v);
      schedule();
    },
    del: (name) => {
      localStorage.removeItem(key(name));
      schedule();
    },
  };
})();
