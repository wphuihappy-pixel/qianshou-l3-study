/**
 * 数智学习 · Service Worker（离线缓存壳）
 * 仅 http(s) 部署（如 GitHub Pages）时注册；本地 file:// 双击打开自动跳过。
 * 离线范围：应用壳（HTML/CSS/JS）+ 已访问过的 CDN 解析库。
 * 不拦截：blob:（IndexedDB 音频直接本地播放）、AI/TTS 的 POST 请求（新内容生成需联网，失败如实报错）。
 */
var CACHE = 'szn-shell-v1';
var SHELL = [
  './',
  './index.html',
  './app.css',
  './js/db.js',
  './js/sync.js',
  './js/parse.js',
  './js/tts.js',
  './js/reader.js',
  './js/app.js',
  './vendor/jszip.min.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/mammoth.browser.min.js',
  './vendor/lame.min.js',
  './vendor/terms-slim.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    /* CDN 不可达时不阻断安装（跨域 opaque），壳资源必须成功 */
    return Promise.all(SHELL.map(function (u) {
      return c.add(u).catch(function () { return null; });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;               /* POST（AI/TTS）不缓存 */
  var url = new URL(req.url);
  if (url.protocol === 'blob:') return;           /* 本地音频直接播放 */
  if (url.hostname === location.hostname) {
    /* 同源：缓存优先，后台更新 */
    e.respondWith(caches.match(req).then(function (hit) {
      if (hit) {
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        }).catch(function () { });
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      });
    }));
  } else {
    /* CDN：stale-while-revalidate */
    e.respondWith(caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          caches.open(CACHE).then(function (c) { c.put(req, res); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    }));
  }
});
