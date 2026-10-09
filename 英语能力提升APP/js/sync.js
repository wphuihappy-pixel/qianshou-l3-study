/**
 * ECSync · 多端同步（GitHub 私有仓库，与千手英语栏目同模式）
 * ================================================================
 * 策略：
 *  - 配置：复用千手统一设置中心「云同步」（qs_sync_config：user/repo/token），
 *    零额外配置——千手首页配一次，英语栏目与本栏目共用同一个仓库
 *  - 数据文件：coach-data.json（本栏目独占文件，与英语栏目数据互不干扰）
 *  - 推送：任何写库（db.js put/putAll/del）→ markDirty → 防抖 25s 自动 push
 *  - 拉取：启动 2s 后自动 pull；云端更新时间比上次同步新 → 本地先留档，再导入
 *  - 冲突保护（绝不丢数据）：push 覆盖云端前，云端旧快照自动留档
 *    coach-archive-{时间}.json；pull 覆盖本地前，本地快照留档到仓库同一前缀。
 *    任何一端的数据被覆盖前，都会以归档文件形式留在仓库里，可随时找回
 *  - 「实时」的诚实定义：静态仓库无服务端推送，做到的是"变更后≈25秒自动
 *    上传 + 打开应用自动拉取 + 每5分钟兜底"，单人双设备体验等同实时同步
 */
(function () {
  'use strict';
  if (window.ECSync) return;

  var CONFIG_KEY = 'qs_sync_config';   /* 与千手首页设置中心、英语栏目共用 */
  var STATE_KEY = 'coach_sync_state';
  var DATA_FILE = 'coach-data.json';
  var ARCHIVE_PREFIX = 'coach-archive-';
  var DEBOUNCE_MS = 25000;

  var state = { syncing: false, dirty: false, timer: null, lastStatus: '', lastSyncAt: 0 };

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveStateKey(st) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(st)); } catch (e) {}
  }

  function config() {
    try {
      var c = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      return { enabled: !!c.enabled, user: c.user || '', repo: c.repo || '', token: c.token || '' };
    } catch (e) { return { enabled: false, user: '', repo: '', token: '' }; }
  }
  function isReady() {
    var c = config();
    return !!(c.enabled && c.user && c.repo && c.token);
  }

  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

  function api(path) {
    var c = config();
    return 'https://api.github.com/repos/' + c.user + '/' + c.repo + '/contents/' + path;
  }
  function headers() {
    return { 'Authorization': 'token ' + config().token, 'Accept': 'application/vnd.github+json' };
  }

  /* 云端读取：{found:false} 或 {found:true, sha, updatedAt, snapshot} */
  function cloudGet(file) {
    return fetch(api(file) + '?_=' + Date.now(), { headers: headers(), cache: 'no-store' }).then(function (res) {
      if (res.status === 404) return { found: false };
      if (!res.ok) throw new Error('GitHub GET ' + res.status);
      return res.json().then(function (j) {
        if (j.encoding !== 'base64' || !j.content) return { found: false };
        var snap = JSON.parse(b64decode(j.content.replace(/\s/g, '')));
        return { found: true, sha: j.sha, updatedAt: snap.updatedAt || '', snapshot: snap };
      });
    });
  }

  function cloudPut(file, jsonText, message, sha) {
    var body = { message: message, content: b64encode(jsonText) };
    if (sha) body.sha = sha;
    return fetch(api(file) + '?_=' + Date.now(), {
      method: 'PUT', headers: headers(), body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error('GitHub PUT ' + res.status + '：' + String(t).slice(0, 120)); });
      }
      return res.json();
    });
  }

  function localSnapshot() {
    return EDB.exportAll().then(function (data) {
      data.app = 'coach';
      data.updatedAt = EDB.nowIso();
      return data;
    });
  }

  /* 留档：覆盖前把旧数据存为 coach-archive-{时间}.json，失败不阻断主流程 */
  function archive(snapshot, reason) {
    var ts = EDB.nowIso().replace(/[:.]/g, '-');
    var name = ARCHIVE_PREFIX + ts + '.json';
    var text = JSON.stringify(Object.assign({ archivedReason: reason, archivedAt: EDB.nowIso() }, snapshot));
    return cloudPut(name, text, 'archive ' + name + ' (' + reason + ')', null)
      .catch(function (e) { if (window.console) console.warn('[ECSync] 留档失败（不阻断）:', e.message); });
  }

  /* ---------- push：本地 → 云端 ---------- */
  function pushNow(mode) {
    if (state.syncing) return Promise.resolve('busy');
    if (!isReady()) return Promise.resolve('not-ready');
    state.syncing = true;
    state.lastStatus = 'pushing';
    updateStatusUI();
    var mine = null, cloud = null;
    return localSnapshot()
      .then(function (snap) { mine = snap; return cloudGet(DATA_FILE); })
      .then(function (c) {
        cloud = c;
        var st = loadState();
        /* 另一台设备推过更新的数据且本地又要覆盖 → 先留档云端，绝不静默丢 */
        if (cloud.found && st.lastCloudAt && cloud.updatedAt > st.lastCloudAt) {
          return archive(cloud.snapshot, 'cloud-overwritten-by-push').then(function () { return cloud; });
        }
        return cloud;
      })
      .then(function () {
        return cloudPut(DATA_FILE, JSON.stringify(mine),
          'coach sync ' + mine.updatedAt + ' (' + (mode || 'auto') + ')',
          cloud.found ? cloud.sha : null);
      })
      .then(function () {
        saveStateKey({ lastCloudAt: mine.updatedAt });
        state.dirty = false;
        state.lastStatus = 'ok';
        state.lastSyncAt = Date.now();
        state.syncing = false;
        updateStatusUI();
        return 'ok';
      })
      .catch(function (e) {
        state.lastStatus = 'fail: ' + e.message;
        state.syncing = false;
        updateStatusUI();
        return Promise.reject(e);
      });
  }

  /* ---------- pull：云端 → 本地 ---------- */
  function pullNow(mode) {
    if (state.syncing) return Promise.resolve('busy');
    if (!isReady()) return Promise.resolve('not-ready');
    state.syncing = true;
    state.lastStatus = 'pulling';
    updateStatusUI();
    return cloudGet(DATA_FILE)
      .then(function (cloud) {
        if (!cloud.found) {
          state.lastStatus = 'ok';
          state.syncing = false;
          updateStatusUI();
          return 'cloud-empty';
        }
        var st = loadState();
        if (st.lastCloudAt && cloud.updatedAt <= st.lastCloudAt) {
          /* 云端不比上次同步新：本地不动（本地新改动交给防抖 push） */
          state.lastStatus = 'ok';
          state.syncing = false;
          updateStatusUI();
          return 'up-to-date';
        }
        /* 云端更新（另一台设备推的）：本地先留档到仓库，再导入 */
        return localSnapshot()
          .then(function (snap) { return archive(snap, 'before-pull-import'); })
          .then(function () { return EDB.importAll(cloud.snapshot); })
          .then(function () {
            saveStateKey({ lastCloudAt: cloud.updatedAt });
            state.dirty = false;
            state.lastStatus = 'ok';
            state.lastSyncAt = Date.now();
            state.syncing = false;
            updateStatusUI();
            try {
              EDB.put('events', {
                id: EDB.uid(), type: 'sync_pulled', date: EDB.dayKey(),
                data: { cloudUpdatedAt: cloud.updatedAt }, created_at: EDB.nowIso()
              });
            } catch (e) {}
            return 'imported';
          });
      })
      .catch(function (e) {
        state.lastStatus = 'fail: ' + e.message;
        state.syncing = false;
        updateStatusUI();
        return Promise.reject(e);
      });
  }

  /* ---------- 变更标记（db.js 每次写库调用；wipe 除外） ---------- */
  function markDirty() {
    state.dirty = true;
    if (!isReady() || state.syncing) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      state.timer = null;
      pushNow('auto').catch(function () { });
    }, DEBOUNCE_MS);
  }

/* ---------- 启动 ---------- */
  function start() {
    if (!isReady()) return;
    if (state._pollTimer) clearInterval(state._pollTimer);
    setTimeout(function () {
      pullNow('startup').then(function (r) {
        /* 云端空/不比本地新，但本地有未推改动 → 启动时补推 */
        if ((r === 'cloud-empty' || r === 'up-to-date') && state.dirty) {
          return pushNow('startup');
        }
      }).catch(function () { });
    }, 2000);
    /* 兜底：每 5 分钟若仍有未推送改动（防抖失败/断网恢复）则推 */
    setInterval(function () {
      if (state.dirty && !state.syncing) pushNow('interval').catch(function () { });
    }, 300000);
    /* 周期拉取（2026-10-09 修复）：页面可见时每 60s 拉一次云端，
       另一端推的新数据自动同步到本端并刷新视图（此前只启动拉一次+兜底 push，双端常开时不同步）。
       拉取前若本地有未推改动，先推再拉，避免拉取覆盖本地新改动。 */
    state._pollTimer = setInterval(function () {
      if (!isReady() || state.syncing) return;
      if (document.hidden) return;
      var run = state.dirty
        ? pushNow('poll-push').then(function () { return pullNow('poll'); })
        : pullNow('poll');
      run.then(function (r) {
        if (r === 'imported') {
          /* 拉取到新数据：刷新当前视图让新内容可见 */
          try { if (window.EApp && window.EApp.go && window.EApp.view) window.EApp.go(window.EApp.view); } catch (e) {}
        }
      }).catch(function () { });
    }, 60000);
  }

  /* ---------- 设置页状态 ---------- */
  function updateStatusUI() {
    var el = document.getElementById('coach-sync-status');
    if (!el) return;
    var c = config();
    if (!c.enabled || !c.token) {
      el.textContent = '未启用 — 到千手首页「设置中心 → 云同步」配置后自动生效';
      el.className = 'status off';
      return;
    }
    var where = c.user + '/' + c.repo;
    if (state.lastStatus === 'pushing') { el.textContent = '正在上传… ' + where; el.className = 'status off'; return; }
    if (state.lastStatus === 'pulling') { el.textContent = '正在拉取… ' + where; el.className = 'status off'; return; }
    if (state.lastStatus.indexOf('fail') === 0) { el.textContent = '失败：' + state.lastStatus.slice(6); el.className = 'status fail'; return; }
    if (state.lastStatus === 'ok') {
      el.textContent = '已同步 · ' + where + ' · ' + new Date(state.lastSyncAt || Date.now()).toLocaleTimeString() +
        (state.dirty ? ' · 有待上传的改动' : '');
      el.className = 'status ok';
      return;
    }
    el.textContent = '已配置 · ' + where + '（学习数据变化后约 25 秒自动上传，打开应用自动拉取）';
    el.className = 'status ok';
  }

  window.ECSync = {
    config: config, isReady: isReady,
    markDirty: markDirty,
    pushNow: pushNow, pullNow: pullNow,
    start: start,
    updateStatusUI: updateStatusUI,
    dumpState: function () { return JSON.parse(JSON.stringify(state)); }
  };
})();
