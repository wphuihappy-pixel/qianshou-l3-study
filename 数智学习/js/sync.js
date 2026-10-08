/**
 * 数智学习 · 云同步（手机/PC 学习记录同步）
 * ============================================================
 * 原理（复用英语学习模块的成熟机制）：学习记录打包为单个 JSON
 * （szn-data.json）存到 GitHub 私有仓库，双端通过 GitHub Contents API
 * 读写同一份文件：pull → 记录级合并（含删除墓碑）→ push。
 *
 * 触发：
 *  - 本地任何 IndexedDB 写操作（db.js notifyChange → markDirty）防抖 5 秒推送
 *  - 启动 2 秒后首同步 + 每 60 秒轮询（页面可见时）
 *
 * 边界（诚实）：
 *  - 音频 Blob（audioFiles）与原件 Blob（sources.fileBlob）永不入包
 *  - 超大来源解析文本（>200KB）只同步登记信息；整包超 800KB 时裁剪来源文本
 *    （GitHub Contents API 单文件上限 1MB）
 *  - TTS/AI 密钥在 localStorage（szn_tts_config / 设置中心），永不入包
 *  - 合并规则：同 id 记录取时间戳新者；无时间戳且本地有 → 信任本地；
 *    删除通过墓碑（deleted 表）传播：记录未被再修改（时间戳早于墓碑）即删除
 */
(function () {
  'use strict';
  if (window.SZSync) return;

  /* 配置复用千手统一设置中心「云同步」（qs_sync_config：user/repo/token/enabled），
     与英语栏目、AI英语教练共用同一份 GitHub 配置（数据文件仍独立为 szn-data.json）。
     数智学习专属的同步状态（lastSyncAt/lastStatus）单独存 szn_sync_state，绝不写入共享配置。 */
  var SHARED_CFG_KEY = 'qs_sync_config';   /* 千手设置中心共享，只读，勿写入 */
  var STATE_KEY = 'szn_sync_state';        /* 数智学习专属同步状态 */
  var API_OVERRIDE_KEY = 'szn_sync_api';   /* 测试/mock 专用：可选，覆盖 GitHub API 地址（默认真实 api.github.com），不影响正常使用 */
  var FILE = 'szn-data.json';
  var API_BASE = 'https://api.github.com';
  /* 数智学习的 DB 是闭包内局部变量（window.SZDB），这里显式取全局引用 */
  var DB = window.SZDB;

  /* toast 也是 app.js 闭包内函数；统一经 SZNApp 暴露，找不到时静默降级为 console（绝不让同步流程因 UI 函数缺失而卡死） */
  function uiToast(msg, ms) {
    try { if (window.SZNApp && typeof window.SZNApp.toast === 'function') { window.SZNApp.toast(msg, ms); return; } } catch (e) { }
    try { if (typeof toast === 'function') { toast(msg, ms); return; } } catch (e) { }
    try { console.log('[云同步]', msg); } catch (e) { }
  }
  /* 参与同步的表（audioFiles=音频 Blob 不入包；deleted 单独处理） */
  var SYNC_STORES = ['meta', 'sources', 'competency', 'goals', 'courses', 'lessons', 'audioTasks', 'annotations', 'events', 'profile', 'reviews', 'offline'];
  var MAX_SOURCE_TEXT = 200 * 1024;   /* 单来源解析文本 JSON 化后 >200KB 只同步登记信息 */
  var MAX_PACK = 800 * 1024;          /* 整包 >800KB 裁剪来源文本（GitHub 单文件上限 1MB） */
  var MAX_TOMB = 3000;                /* 墓碑数量上限，超出保留最老的之外（按时间升序截断） */

  function tsOf(r) {
    if (!r) return 0;
    var v = r.updatedAt || r.createdAt || r.at || r.generatedAt || r.confirmedAt || r.generated || 0;
    if (!v) return 0;
    var t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }

  var Sync = {
    POLL_INTERVAL: 60000,
    DEBOUNCE_MS: 5000,
    dirty: false,
    syncing: false,
    applying: false,          /* 同步回写本地时置位，db.js notifyChange 会跳过 */
    _debounceTimer: null,
    _pollTimer: null,

    getConfig: function () {
      var shared = {}, st = {};
      try { shared = JSON.parse(localStorage.getItem(SHARED_CFG_KEY) || '{}') || {}; } catch (e) { shared = {}; }
      try { st = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (e) { st = {}; }
      return {
        enabled: !!shared.enabled,
        user: shared.user || '',
        repo: shared.repo || 'taotao-english-data',
        token: shared.token || '',
        fileName: FILE,
        apiBase: (function () { try { var a = localStorage.getItem(API_OVERRIDE_KEY); if (a) return a; } catch (e) { } return API_BASE; })(),
        lastSyncAt: st.lastSyncAt || 0,
        lastStatus: st.lastStatus || ''
      };
    },

    /* 融合后凭据由千手设置中心（qs_sync_config）管理；本方法只持久化本栏目同步状态，不写共享配置 */
    saveConfig: function (cfg) {
      var st = {};
      try { st = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (e) { st = {}; }
      if (cfg) { st.lastSyncAt = cfg.lastSyncAt || 0; st.lastStatus = cfg.lastStatus || ''; }
      try { localStorage.setItem(STATE_KEY, JSON.stringify(st)); } catch (e) {}
    },

    isReady: function () {
      var c = this.getConfig();
      return !!(c.enabled && c.user && c.repo && c.token);
    },

    /* 本地数据变更 → 延迟推送（db.js 的 put/bulkPut/del 都会通知这里） */
    markDirty: function () {
      if (!this.isReady() || this.applying) return;
      var self = this;
      this.dirty = true;
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(function () { self.syncNow('auto'); }, this.DEBOUNCE_MS);
    },

    /* ---------- GitHub Contents API（apiBase 可配置，测试时可指向本地 mock） ---------- */
    _api: function (method, path, body) {
      var cfg = this.getConfig();
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, cfg.apiBase + path, true);
        xhr.setRequestHeader('Authorization', 'token ' + cfg.token);
        xhr.setRequestHeader('Accept', 'application/vnd.github.v3+json');
        if (body) xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            var json = null;
            try { json = JSON.parse(xhr.responseText || '{}'); } catch (e) { }
            resolve({ status: xhr.status, json: json });
          } else if (xhr.status === 404) {
            resolve({ status: 404, json: null });
          } else {
            var msg = 'HTTP ' + xhr.status;
            try { var j = JSON.parse(xhr.responseText); if (j && j.message) msg = j.message; } catch (e) { }
            reject(new Error(msg));
          }
        };
        xhr.onerror = function () { reject(new Error('网络错误（需可访问 ' + cfg.apiBase + '）')); };
        xhr.send(body ? JSON.stringify(body) : null);
      });
    },

    pull: function () {
      var self = this;
      var cfg = this.getConfig();
      return this._api('GET', '/repos/' + cfg.user + '/' + cfg.repo + '/contents/' + cfg.fileName, null).then(function (r) {
        if (r.status === 404) return { data: null, sha: null };
        var b64 = String(r.json.content || '').replace(/\s/g, '');
        var json = decodeURIComponent(escape(atob(b64)));
        return { data: JSON.parse(json), sha: r.json.sha };
      });
    },

    push: function (payload, sha) {
      var cfg = this.getConfig();
      var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      var body = { message: 'sync ' + new Date().toISOString(), content: b64 };
      if (sha) body.sha = sha;
      return this._api('PUT', '/repos/' + cfg.user + '/' + cfg.repo + '/contents/' + cfg.fileName, body);
    },

    /* ---------- 打包 / 合并（纯函数，Node 单测可直接提取） ---------- */
    packLocal: function () {
      var self = this;
      var now = new Date().toISOString();
      return Promise.all(SYNC_STORES.map(function (n) { return DB.getAll(n); })).then(function (rows) {
        var stores = {};
        SYNC_STORES.forEach(function (n, i) {
          stores[n] = rows[i].map(function (r) {
            var copy = Object.assign({}, r);
            if (copy.fileBlob) { copy.fileBlobOmitted = true; delete copy.fileBlob; }
            if (copy.blob) { copy.blobOmitted = true; delete copy.blob; }
            return copy;
          });
        });
        return DB.getAll('deleted').then(function (dels) {
          var deleted = dels.map(function (d) { return { store: d.store, rid: d.rid, at: d.at }; });
          return self.protectPack(stores, deleted, now);
        });
      });
    },

    /* 大小保护：单来源 >200KB 裁掉解析文本；整包 >800KB 再按大到小裁 */
    protectPack: function (stores, deleted, packedAt) {
      var pack = { format: 'szn-sync', version: 2, app: '数智学习', packedAt: packedAt, stores: stores, deleted: deleted || [] };
      (stores.sources || []).forEach(function (s) {
        if (s.pages && JSON.stringify(s.pages).length > MAX_SOURCE_TEXT) {
          s.pagesOmitted = true; s.pagesCount = (s.pages || []).length; delete s.pages;
        }
      });
      var size = function () { return JSON.stringify(pack).length; };
      if (size() <= MAX_PACK) return pack;
      var big = (stores.sources || []).filter(function (s) { return s.pages; })
        .sort(function (a, b) { return JSON.stringify(b.pages).length - JSON.stringify(a.pages).length; });
      big.forEach(function (s) {
        if (size() <= MAX_PACK) return;
        s.pagesOmitted = true; s.pagesCount = (s.pages || []).length; delete s.pages;
      });
      return pack;
    },

    /* 墓碑合并：双端同 (store,rid) 取 at 新者；按时间升序保留最近 MAX_TOMB 条 */
    mergeTombstones: function (localDels, cloudDels) {
      var map = {};
      (localDels || []).concat(cloudDels || []).forEach(function (d) {
        if (!d || !d.store || !d.rid || !d.at) return;
        var key = d.store + '|' + d.rid;
        var t = new Date(d.at).getTime() || 0;
        if (!map[key] || t > map[key].atTs) map[key] = { store: d.store, rid: d.rid, at: d.at, atTs: t };
      });
      var arr = Object.keys(map).map(function (k) { return map[k]; });
      arr.sort(function (a, b) { return a.atTs - b.atTs; });
      if (arr.length > MAX_TOMB) arr = arr.slice(arr.length - MAX_TOMB);
      return arr;
    },

    /* 记录级合并：同 id 取时间戳新者；墓碑时间戳不早于记录 → 删（记录没被再改过）
       保护：本地存在且无时间戳的记录信任本地（不因墓碑误删重建/演示数据） */
    mergeList: function (localRows, cloudRows, tombMap) {
      var out = [];
      var map = {};
      var hasLocal = {};
      (localRows || []).forEach(function (r) { if (r && r.id) { map[r.id] = r; hasLocal[r.id] = true; } });
      (cloudRows || []).forEach(function (r) {
        if (!r || !r.id) return;
        if (!map[r.id]) map[r.id] = r;
        else if (tsOf(r) > tsOf(map[r.id])) map[r.id] = r;
      });
      Object.keys(map).forEach(function (id) {
        var rec = map[id];
        var tomb = tombMap[id];
        if (tomb) {
          if (hasLocal[id] && !tsOf(rec)) { out.push(rec); return; }   /* 本地无时间戳数据信任本地 */
          if (tomb.atTs >= tsOf(rec)) return;                          /* 记录早于墓碑删除时间 → 删 */
        }
        out.push(rec);
      });
      return out;
    },

    /* 双端合并 → 合并后的完整包 */
    mergeAll: function (local, cloud) {
      var self = this;
      var dels = this.mergeTombstones(local.deleted, cloud.deleted);
      var stores = {};
      SYNC_STORES.forEach(function (n) {
        var tmap = {};
        dels.forEach(function (d) { if (d.store === n) tmap[d.rid] = d; });
        stores[n] = self.mergeList(local.stores[n], cloud.stores[n], tmap);
      });
      return { format: 'szn-sync', version: 2, packedAt: new Date().toISOString(), stores: stores, deleted: dels };
    },

    /* 把合并结果写回本地（applying 置位防再触发同步）；墓碑一并写回 */
    applyMerged: function (merged) {
      var self = this;
      this.applying = true;
      var chain = Promise.all(SYNC_STORES.map(function (n) {
        return DB.clear(n).then(function () { return DB.bulkPut(n, merged.stores[n] || []); });
      }));
      return chain.then(function () {
        return DB.clear('deleted').then(function () {
          var rows = (merged.deleted || []).map(function (d) { return { id: d.store + '|' + d.rid, store: d.store, rid: d.rid, at: d.at }; });
          return rows.length ? DB.bulkPut('deleted', rows) : null;
        });
      }).then(function () {
        self.applying = false;
        return merged;
      }, function (e) { self.applying = false; throw e; });
    },

    /* ---------- 主流程 ---------- */
    syncNow: function (mode) {
      var self = this;
      if (!this.isReady()) return Promise.resolve('not-ready');
      if (this.syncing) return Promise.resolve('busy');
      this.syncing = true;
      return this.packLocal().then(function (local) {
        return self.pull().then(function (r) {
          if (!r.data) {
            /* 云端无数据：直接上传本地 */
            return self.push(local, null).then(function () { return { applied: false }; });
          }
          var merged = self.mergeAll(local, r.data);
          return self.applyMerged(merged).then(function () {
            return self.push(merged, r.sha).then(function () { return { applied: true }; });
          });
        });
      }).then(function (res) {
        self.dirty = false;
        var c = self.getConfig();
        c.lastSyncAt = Date.now();
        c.lastStatus = 'ok';
        self.saveConfig(c);
        self.updateStatusUI();
        if (mode === 'manual') { uiToast('云同步成功'); }
        if (res && res.applied) {
          /* 合并回写了本地：刷新当前视图让新数据可见 */
          try { if (window.SZNApp && window.SZNApp.refresh) window.SZNApp.refresh(); } catch (e) { }
        }
        return 'ok';
      }).catch(function (err) {
        var c = self.getConfig();
        c.lastStatus = '失败：' + err.message;
        self.saveConfig(c);
        self.updateStatusUI();
        if (mode === 'manual') uiToast('云同步失败：' + err.message);
        return 'fail';
      }).then(function (result) {
        self.syncing = false;
        return result;
      });
    },

    /* 状态栏 */
    updateStatusUI: function () {
      var el = document.getElementById('sync-status');
      if (!el) return;
      var c = this.getConfig();
      if (!c.enabled) { el.textContent = '未启用'; el.className = 'sync-status off'; return; }
      var t = c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : '从未';
      if (c.lastStatus === 'ok') { el.textContent = '已同步 · ' + t; el.className = 'sync-status ok'; }
      else if (c.lastStatus) { el.textContent = c.lastStatus + ' · ' + t; el.className = 'sync-status fail'; }
      else { el.textContent = '已启用，尚未同步'; el.className = 'sync-status off'; }
    },

    /* 启动自动同步：2 秒后首同步 + 60 秒轮询（页面可见时） */
    startAutoSync: function () {
      var self = this;
      if (this._pollTimer) clearInterval(this._pollTimer);
      if (!this.isReady()) { this.updateStatusUI(); return; }
      setTimeout(function () { if (self.isReady()) self.syncNow('auto'); }, 2000);
      this._pollTimer = setInterval(function () {
        if (!self.isReady() || self.syncing) return;
        if (document.hidden) return;
        if (self.dirty) return;
        self.syncNow('auto');
      }, this.POLL_INTERVAL);
    },

    /* 仅清除本栏目同步状态；绝不触碰千手共享的 qs_sync_config（同时驱动英语/AI英语教练栏目） */
    clearConfig: function () {
      try { localStorage.removeItem(STATE_KEY); } catch (e) { }
    }
  };

  window.SZSync = Sync;
})();