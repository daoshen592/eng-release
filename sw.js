/* 词块 · Service Worker（离线缓存）
 *
 * 策略：
 *   - 页面 / 脚本 / 数据 / 图标：network-first（在线时永远拿最新，断网才用缓存）
 *     ——改完文件刷新即可看到，不必清缓存 / 改版本号
 *   - 音频：先回缓存、后台更新（stale-while-revalidate，听得越多缓存越全）
 *   - progress.php：绝不缓存（进度要实时读写）
 *
 * VER 只在 CORE 列表本身变化时才需要改（用来清掉旧缓存里的废弃条目）。
 */
const VER = 'chunk-20261108t';
const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'wordbook.js',
  'exam.js',
  'cloze.js',
  'search.js',
  'profile.js',
  'vendor/ts-fsrs.umd.js',
  'data/sentences.js',
  'data/words.js',
  'data/audio_extra.js',
  'data/forms.js',
  'data/clozes.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VER).then(function (c) {
      // 个别文件缺失不阻塞安装
      return Promise.allSettled(CORE.map(function (u) { return c.add(u); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VER; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('progress.php')) return; // 进度接口直连

  /* 音频：命中缓存先回，同时后台刷新 */
  if (url.pathname.indexOf('/audio/') !== -1) {
    e.respondWith(
      caches.open(VER).then(function (c) {
        return c.match(req).then(function (hit) {
          var net = fetch(req).then(function (r) {
            if (r && r.ok) c.put(req, r.clone());
            return r;
          }).catch(function () { return hit; });
          return hit || net;
        });
      })
    );
    return;
  }

  /* 其余：network-first —— 在线永远拿最新，失败才回落到缓存（断网可用） */
  e.respondWith(
    fetch(req).then(function (r) {
      if (r && r.ok) {
        var copy = r.clone();
        caches.open(VER).then(function (c) { c.put(req, copy); });
      }
      return r;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        return caches.match('index.html');
      });
    })
  );
});
