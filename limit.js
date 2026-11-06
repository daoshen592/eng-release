/* GitHub Pages 专属：每天每 IP 限 30 分钟（纯客户端实现）
 * 仅部署在 eng-release（GitHub），群晖站不含此文件，不受影响。
 * 原理：取访客公网 IP（ipify 接口）→ 以「日期+IP」为键，累计页面可见时长
 *      → 满 30 分钟弹出全屏遮罩，指引用户去不限时的自建站。
 * 局限：清浏览器数据 / 无痕模式 / 换网络可绕过，属劝导型限制。
 */
(function () {
  var MAX_SEC = 30 * 60; // 每天上限：30 分钟
  var SITE = "https://www.hujb.online:28669/eng/";

  function dstr() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function key(ip) { return "limit." + dstr() + "." + ip; }

  var ip = localStorage.getItem("limit.ip") || "unknown";
  var blocked = false;

  /* 清理非今天的旧键，防止 localStorage 积累 */
  try {
    var keep = key(ip);
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && k.indexOf("limit.") === 0 && k !== keep && k !== "limit.ip") {
        localStorage.removeItem(k);
      }
    }
  } catch (e) {}

  function used() { return parseInt(localStorage.getItem(key(ip)) || "0", 10) || 0; }
  function add(n) { localStorage.setItem(key(ip), String(used() + n)); }

  /* 取公网 IP（取不到则退化为按浏览器限制） */
  fetch("https://api.ipify.org?format=json")
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ip) {
        var migrated = used(); /* IP 未取到期间已累计的时长迁移到 IP 键下 */
        ip = j.ip;
        localStorage.setItem("limit.ip", ip);
        if (migrated > 0) {
          var merged = (parseInt(localStorage.getItem(key(ip)) || "0", 10) || 0) + migrated;
          localStorage.setItem(key(ip), String(merged));
          localStorage.removeItem(key("unknown"));
        }
        if (used() >= MAX_SEC) block();
      }
    })
    .catch(function () { /* 保持 unknown 按浏览器限 */ });

  /* 全屏遮罩（内联样式，不依赖任何 css 文件） */
  var mask = null;
  function ensureMask() {
    if (mask) return mask;
    mask = document.createElement("div");
    mask.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#0a0b0f;color:#eef1f6;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "text-align:center;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;" +
      "padding:24px;";
    mask.innerHTML =
      '<div style="font-size:44px;margin-bottom:14px">\u23f0</div>' +
      '<div style="font-size:20px;font-weight:700;margin-bottom:10px">今日 30 分钟学习时间已用完</div>' +
      '<div style="font-size:14px;color:#9aa4b6;line-height:1.9">明天再来吧！本站（GitHub 镜像）每天限 30 分钟<br>' +
      '不限时完整版：<a href="' + SITE + '" style="color:#f5b942">' + SITE + "</a></div>";
    (document.body || document.documentElement).appendChild(mask);
    return mask;
  }
  function block() { if (!blocked) { blocked = true; ensureMask(); } }

  if (used() >= MAX_SEC) block();

  /* 每 5 秒结算一次：仅页面可见（前台）时累计，切后台/锁屏不计时 */
  setInterval(function () {
    if (blocked || document.visibilityState !== "visible") return;
    add(5);
    if (used() >= MAX_SEC) block();
  }, 5000);
})();
