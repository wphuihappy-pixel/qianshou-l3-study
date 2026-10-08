/**
 * EDB · AI英语教练 IndexedDB 数据层
 * 库名 coach_agent_db（与英语 qs_ / 产数数智 qianshou_ / szn_agent_db 完全隔离）
 * 迁移策略：只加表/索引，不做破坏性变更（onupgradeneeded 兼容升级）
 */
(function () {
  'use strict';
  if (window.EDB) return;

  var DB_NAME = 'coach_agent_db';
  var VERSION = 2;   /* v2：activities 补 byDate 索引（onupgradeneeded 只加缺失，兼容旧库） */

  /* 表定义：[名称, keyPath, 索引{名:字段}] */
  var STORE_DEFS = [
    ['profile',            'id', { bySkill: 'skill', byState: 'state' }],
    ['assessments',        'id', { byType: 'type', byDate: 'date' }],
    ['dailyPlans',         'id', { byDate: 'date', byStatus: 'status' }],
    ['sessions',           'id', { byDate: 'date', byStatus: 'status' }],
    ['activities',         'id', { bySession: 'sessionId', byType: 'type', byDate: 'date' }],
    ['content',            'id', { byStatus: 'status', byDiff: 'difficulty', byTag: 'tag' }],
    ['reading',            'id', { byContent: 'contentId', byDate: 'date' }],
    ['vocabulary',         'id', { byMastery: 'mastery', byDue: 'nextReview', byWord: 'word' }],
    ['expressions',        'id', { byMastery: 'mastery', byDue: 'nextReview' }],
    ['conversations',      'id', { byDate: 'date', byScenario: 'scenario' }],
    ['turns',              'id', { byConv: 'conversationId' }],
    ['corrections',        'id', { byTurn: 'turnId', byMistake: 'mistakeId' }],
    ['mistakes',           'id', { byType: 'mistake_type', byDue: 'next_review', byResolved: 'resolved' }],
    ['pronunciationIssues','id', { byWord: 'word', byPhoneme: 'phoneme' }],
    ['listeningIssues',    'id', { byType: 'type' }],
    ['grammarPatterns',    'id', { byPattern: 'pattern', byMastery: 'mastery' }],
    ['reviews',            'id', { byItem: 'itemId', byDue: 'dueDay', byState: 'state' }],
    ['events',             'id', { byType: 'type', byDate: 'date' }],
    ['weeklyReports',      'id', { byWeek: 'weekStart' }]
  ];

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
  function nowIso() { return new Date().toISOString(); }
  /* 本地日期键：YYYY-MM-DD（用于 date 索引与"今日"判断） */
  function dayKey(d) {
    var t = d ? new Date(d) : new Date();
    var m = String(t.getMonth() + 1).padStart(2, '0');
    var day = String(t.getDate()).padStart(2, '0');
    return t.getFullYear() + '-' + m + '-' + day;
  }
  function weekStart(d) {
    var t = d ? new Date(d) : new Date();
    t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); /* 周一为一周开始 */
    return dayKey(t);
  }

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function (e) {
        var db = req.result;
        STORE_DEFS.forEach(function (def) {
          var name = def[0], keyPath = def[1], indexes = def[2] || {};
          var store;
          if (!db.objectStoreNames.contains(name)) {
            store = db.createObjectStore(name, { keyPath: keyPath });
          } else {
            store = e.target.transaction.objectStore(name);
          }
          Object.keys(indexes).forEach(function (idxName) {
            if (!store.indexNames.contains(idxName)) {
              store.createIndex(idxName, indexes[idxName], { unique: false });
            }
          });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
    });
    return dbPromise;
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tick() { if (window.ECSync) ECSync.markDirty(); }

  function put(store, val) {
    return tx(store, 'readwrite').then(function (s) {
      return wrap(s.put(val)).then(function (r) { tick(); return r; });
    });
  }
  function putAll(store, arr) {
    return tx(store, 'readwrite').then(function (s) {
      return Promise.all(arr.map(function (v) { return wrap(s.put(v)); }))
        .then(function (r) { tick(); return r; });
    });
  }
  function get(store, key) {
    return tx(store, 'readonly').then(function (s) { return wrap(s.get(key)); });
  }
  function getAll(store) {
    return tx(store, 'readonly').then(function (s) { return wrap(s.getAll()); });
  }
  function del(store, key) {
    return tx(store, 'readwrite').then(function (s) {
      return wrap(s.delete(key)).then(function (r) { tick(); return r; });
    });
  }
  /* clear（批量清空）不挂同步钩子；wipe 后由 app.js 显式决定是否推送新起点快照 */
  function clear(store) {
    return tx(store, 'readwrite').then(function (s) { return wrap(s.clear()); });
  }
  function count(store) {
    return tx(store, 'readonly').then(function (s) { return wrap(s.count()); });
  }
  function byIndex(store, index, value) {
    return tx(store, 'readonly').then(function (s) {
      return wrap(s.index(index).getAll(value));
    });
  }
  function byIndexRange(store, index, upper) {
    return tx(store, 'readonly').then(function (s) {
      var range = IDBKeyRange.upperBound(upper);
      return wrap(s.index(index).getAll(range));
    });
  }

  /* ---------- 导出 / 导入（多端同步与备份） ---------- */
  function exportAll() {
    var out = { app: 'coach', exportedAt: nowIso(), stores: {} };
    var chain = Promise.resolve();
    STORE_DEFS.forEach(function (def) {
      chain = chain.then(function () {
        return getAll(def[0]).then(function (rows) { out.stores[def[0]] = rows; });
      });
    });
    return chain.then(function () { return out; });
  }

  function importAll(data) {
    if (!data || typeof data.stores !== 'object') {
      return Promise.reject(new Error('备份文件结构不受支持（缺少 stores）'));
    }
    var applied = 0, total = 0;
    var chain = Promise.resolve();
    STORE_DEFS.forEach(function (def) {
      var rows = data.stores[def[0]];
      if (!Array.isArray(rows) || !rows.length) return;
      total += rows.length;
      chain = chain.then(function () {
        return putAll(def[0], rows).then(function () { applied += rows.length; });
      });
    });
    return chain.then(function () { return { applied: applied, total: total }; });
  }

  window.EDB = {
    DB_NAME: DB_NAME,
    STORES: STORE_DEFS.map(function (d) { return d[0]; }),
    open: open,
    put: put, putAll: putAll,
    get: get, getAll: getAll,
    del: del, clear: clear, count: count,
    byIndex: byIndex, byIndexRange: byIndexRange,
    exportAll: exportAll, importAll: importAll,
    uid: uid, nowIso: nowIso, dayKey: dayKey, weekStart: weekStart
  };
})();
