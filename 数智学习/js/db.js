/**
 * 数智学习 · 本地数据层（IndexedDB 封装）
 * ============================================================
 * 纯前端本地单用户模式：
 *  - 所有课程、来源、批注、事件、画像、音频都存本机 IndexedDB，
 *    不上传任何远端服务器（云 LLM/TTS 调用见隐私说明）。
 *  - store 定义见 STORES；迁移只加 store/索引，不做破坏性变更。
 *  - 原始资料以只读副本（Blob）入库，原件永不修改；
 *    批注/画像等派生数据独立存储，与原件分离。
 * ============================================================
 */
(function () {
  'use strict';
  if (window.SZDB) return;

  var DB_NAME = 'szn_agent_db';
  /* v2：新增 deleted 表（云同步墓碑）。版本必须递增——旧库（v1、无 deleted 表）只有请求更高版本号才会触发
     onupgradeneeded 补建缺失表；否则任何 DB.del（内部写墓碑）都会因 store 不存在报错。 */
  var DB_VERSION = 2;

  /* objectStore 定义：keyPath + indexes */
  var STORES = {
    meta:        { keyPath: 'id', indexes: [] },                                   /* 通用 kv：schemaVersion、flags */
    sources:     { keyPath: 'id', indexes: ['name', 'type', 'status', 'demo'] },  /* 资料来源登记 + 原件只读副本 */
    competency:  { keyPath: 'id', indexes: ['path', 'code'] },                     /* 能力树（来自认证标准） */
    goals:       { keyPath: 'id', indexes: [] },                                   /* 学习目标与偏好 */
    courses:     { keyPath: 'id', indexes: ['status', 'version'] },                 /* 30 天课程计划（草案/锁定版本） */
    lessons:     { keyPath: 'id', indexes: ['courseId', 'day'] },                   /* 教案（按课） */
    audioTasks:  { keyPath: 'id', indexes: ['lessonId', 'status', 'idempotencyKey'] }, /* 异步音频任务 */
    audioFiles:  { keyPath: 'id', indexes: ['taskId', 'lessonId', 'format'] },     /* 真实音频 Blob（mp3/wav） */
    annotations: { keyPath: 'id', indexes: ['sourceId', 'lessonId', 'kind', 'label'] }, /* 批注（独立图层） */
    events:      { keyPath: 'id', indexes: ['type', 'lessonId', 'at', 'confidence'] }, /* 学习事件（显式反馈 vs 行为信号） */
    profile:     { keyPath: 'id', indexes: ['concept', 'state', 'origin'] },       /* 学习画像条目 */
    reviews:     { keyPath: 'id', indexes: ['lessonId', 'concept', 'dueDay', 'state'] }, /* 间隔复习计划 */
    offline:     { keyPath: 'id', indexes: ['kind', 'refId'] },                    /* 离线下载登记 */
    deleted:     { keyPath: 'id', indexes: ['store', 'at'] }                     /* 删除墓碑（云同步）：id = store|rid，记录哪条记录被删过，合并时把删除传播到另一端 */
  };

  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        Object.keys(STORES).forEach(function (name) {
          var def = STORES[name];
          if (!db.objectStoreNames.contains(name)) {
            var st = db.createObjectStore(name, { keyPath: def.keyPath });
            (def.indexes || []).forEach(function (ix) {
              st.createIndex(ix, ix, { unique: false });
            });
          } else {
            /* 迁移：只补索引，不删已有数据 */
            var st2 = e.target.transaction.objectStore(name);
            (def.indexes || []).forEach(function (ix) {
              if (!st2.indexNames.contains(ix)) st2.createIndex(ix, ix, { unique: false });
            });
          }
        });
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function (e) { reject(new Error('IndexedDB 打开失败：' + (e.target.error && e.target.error.message || '未知'))); };
    });
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function _wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function (e) { reject(e.target.error || new Error('数据库操作失败')); };
    });
  }

  /* ---------- 变更通知（云同步自动触发；SZSync 未启用/正在回写时跳过） ---------- */
  function notifyChange() {
    try {
      if (window.SZSync && !window.SZSync.applying && typeof window.SZSync.markDirty === 'function') {
        window.SZSync.markDirty();
      }
    } catch (e) { }
  }

  /* ---------- 删除墓碑（云同步需要把「删除」传播到另一端） ---------- */
  function markDeleted(store, id) {
    if (store === 'deleted') return Promise.resolve(null);
    return put('deleted', { id: store + '|' + id, store: store, rid: id, at: nowIso() });
  }
  function markDeletedMany(store, ids) {
    if (store === 'deleted' || !ids || !ids.length) return Promise.resolve(0);
    var arr = ids.map(function (id) { return { id: store + '|' + id, store: store, rid: id, at: nowIso() }; });
    return bulkPut('deleted', arr);
  }

  function put(store, obj) {
    return tx(store, 'readwrite').then(function (st) { return _wrap(st.put(obj)); }).then(function (r) { notifyChange(); return r; });
  }
  function bulkPut(store, arr) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, 'readwrite');
        var st = t.objectStore(store);
        arr.forEach(function (o) { st.put(o); });
        t.oncomplete = function () { resolve(arr.length); };
        t.onerror = function (e) { reject(e.target.error || new Error('批量写入失败')); };
      });
    }).then(function (n) { notifyChange(); return n; });
  }
  function get(store, id) {
    return tx(store, 'readonly').then(function (st) { return _wrap(st.get(id)); });
  }
  function getAll(store) {
    return tx(store, 'readonly').then(function (st) { return _wrap(st.getAll()); });
  }
  function byIndex(store, index, value) {
    return tx(store, 'readonly').then(function (st) {
      return _wrap(st.index(index).getAll(value));
    });
  }
  function del(store, id) {
    return markDeleted(store, id).then(function () {
      return tx(store, 'readwrite').then(function (st) { return _wrap(st.delete(id)); });
    });
  }
  function delWhere(store, index, value) {
    return byIndex(store, index, value).then(function (rows) {
      var ids = rows.map(function (r) { return r[STORES[store].keyPath]; });
      return markDeletedMany(store, ids).then(function () {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction(store, 'readwrite');
            var st = t.objectStore(store);
            var n = 0;
            rows.forEach(function (r) { st.delete(r[STORES[store].keyPath]); n++; });
            t.oncomplete = function () { resolve(n); };
            t.onerror = function (e) { reject(e.target.error); };
          });
        });
      });
    });
  }
  function clear(store) {
    if (store === 'deleted') return tx(store, 'readwrite').then(function (st) { return _wrap(st.clear()); });
    return getAll(store).then(function (rows) {
      var ids = rows.map(function (r) { return r[STORES[store].keyPath]; });
      return markDeletedMany(store, ids).then(function () {
        return tx(store, 'readwrite').then(function (st) { return _wrap(st.clear()); });
      });
    });
  }

  /* ---------- 工具 ---------- */
  function newId(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }
  function nowIso() { return new Date().toISOString(); }

  /* ---------- 便捷查询 ---------- */
  function latestGoals() {
    return getAll('goals').then(function (all) {
      if (!all.length) return null;
      return all.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })[0];
    });
  }
  function activeCourse() {
    return getAll('courses').then(function (all) {
      var locked = all.filter(function (c) { return c.status === 'locked'; });
      if (locked.length) {
        return locked.sort(function (a, b) { return (b.confirmedAt || '').localeCompare(a.confirmedAt || ''); })[0];
      }
      var drafts = all.filter(function (c) { return c.status === 'draft'; });
      if (drafts.length) {
        return drafts.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })[0];
      }
      return null;
    });
  }
  function lessonOf(courseId, day) {
    return byIndex('lessons', 'courseId', courseId).then(function (rows) {
      return rows.filter(function (l) { return l.day === day; })[0] || null;
    });
  }

  /* ---------- 学习事件（显式反馈 vs 行为信号分开存） ---------- */
  function logEvent(ev) {
    var rec = {
      id: newId('ev'),
      at: nowIso(),
      type: ev.type || 'other',          /* feedback | behavior | listen | read | annotate | generate */
      lessonId: ev.lessonId || '',
      sourceId: ev.sourceId || '',
      concept: ev.concept || '',
      origin: ev.origin || 'explicit',   /* explicit=用户明确标记；inferred=行为推测（低置信） */
      confidence: (typeof ev.confidence === 'number') ? ev.confidence : null, /* 仅 inferred 有值 0~1 */
      payload: ev.payload || {},
      note: ev.note || ''
    };
    return put('events', rec).then(function () { return rec; });
  }

  window.SZDB = {
    DB_NAME: DB_NAME,
    STORES: STORES,
    open: open,
    put: put,
    bulkPut: bulkPut,
    get: get,
    getAll: getAll,
    byIndex: byIndex,
    del: del,
    delWhere: delWhere,
    clear: clear,
    newId: newId,
    nowIso: nowIso,
    latestGoals: latestGoals,
    activeCourse: activeCourse,
    lessonOf: lessonOf,
    logEvent: logEvent,
    /* 云同步辅助 */
    markDeleted: markDeleted,
    markDeletedMany: markDeletedMany
  };
})();
