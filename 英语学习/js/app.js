/**
 * 千手-淘淘英语学习 - 应用主逻辑
 * 实现产品设计文档 V1.0 P0 功能
 * 纯前端离线应用，数据存于 localStorage
 */
(function () {
'use strict';

/* ================================================================
 * 存储管理
 * ================================================================ */
var Store = {
  KEYS: {
    words: 'qs_words',
    states: 'qs_states',
    attempts: 'qs_attempts',
    settings: 'qs_settings',
    session: 'qs_session'
  },

  get: function (key, def) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : def;
    } catch (e) { return def; }
  },

  set: function (key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) {
      console.error('保存失败：', key, e);
      if (typeof App !== 'undefined' && App.toast) App.toast('保存失败：浏览器存储空间不可用，请先导出备份');
      return false;
    }
  },

  remove: function (key) {
    try { localStorage.removeItem(key); } catch (e) {}
  },

  /* 获取词库（用户自定义覆盖默认；旧版本数据自动迁移，不重置学习状态） */
  getWords: function () {
    var custom = this.get(this.KEYS.words, null);
    if (custom && custom.version === WORD_DATA.version) return custom;
    if (custom && custom.sets && Array.isArray(custom.sets)) {
      /* 迁移：保留用户已有词库与学习记录，补充新版本新增的默认词库 */
      var merged = JSON.parse(JSON.stringify(custom));
      merged.version = WORD_DATA.version;
      var has = {};
      merged.sets.forEach(function (s) { has[s.id] = true; });
      WORD_DATA.sets.forEach(function (ds) {
        if (!has[ds.id]) merged.sets.push(JSON.parse(JSON.stringify(ds)));
      });
      return merged;
    }
    return JSON.parse(JSON.stringify(WORD_DATA));
  },

  saveWords: function (data) { var ok = this.set(this.KEYS.words, data); if (ok && window.Sync) Sync.markDirty(); return ok; },

  getStates: function () { return this.get(this.KEYS.states, {}); },
  saveStates: function (s) { var ok = this.set(this.KEYS.states, s); if (ok && window.Sync) Sync.markDirty(); return ok; },

  getAttempts: function () { return this.get(this.KEYS.attempts, []); },
  saveAttempts: function (a) { var ok = this.set(this.KEYS.attempts, a); if (ok && window.Sync) Sync.markDirty(); return ok; },

  getSettings: function () {
    return this.get(this.KEYS.settings, {
      newLimit: 8,
      speechRate: 1.0
    });
  },
  saveSettings: function (s) { var ok = this.set(this.KEYS.settings, s); if (ok && window.Sync) Sync.markDirty(); return ok; },

  getSession: function () { return this.get(this.KEYS.session, null); },
  saveSession: function (s) { return this.set(this.KEYS.session, s); },
  clearSession: function () { this.remove(this.KEYS.session); },

  importBackup: function (data) {
    if (!data || !/^1\.\d+$/.test(String(data.version)) || !data.words ||
        ['1.0', '1.1'].indexOf(String(data.words.version)) < 0 || !Array.isArray(data.words.sets)) return false;
    var validWords = data.words.sets.length > 0 && data.words.sets.every(function (set) {
      return set && typeof set.id === 'string' && typeof set.name === 'string' && Array.isArray(set.words) &&
        set.words.every(function (w) { return w && typeof w.lemma === 'string' && typeof w.meanings === 'string'; });
    });
    if (!validWords || !data.states || typeof data.states !== 'object' || Array.isArray(data.states) ||
        !Array.isArray(data.attempts) || !data.settings || typeof data.settings !== 'object' ||
        !Number.isFinite(Number(data.settings.newLimit)) ||
        !data.attempts.every(function (a) { return a && typeof a.wordId === 'string' &&
          Skills.list.indexOf(a.skill) >= 0 && ['correct', 'wrong', 'hint', 'idk', 'guess'].indexOf(a.outcome) >= 0 && Number.isFinite(Number(a.ts)); })) return false;
    var payloads = {}; payloads[this.KEYS.words] = data.words; payloads[this.KEYS.states] = data.states;
    payloads[this.KEYS.attempts] = data.attempts; payloads[this.KEYS.settings] = data.settings;
    var previous = {};
    try {
      Object.keys(payloads).forEach(function (key) { previous[key] = localStorage.getItem(key); });
      Object.keys(payloads).forEach(function (key) { localStorage.setItem(key, JSON.stringify(payloads[key])); });
      return true;
    } catch (e) {
      Object.keys(previous).forEach(function (key) { try {
        if (previous[key] === null) localStorage.removeItem(key); else localStorage.setItem(key, previous[key]);
      } catch (_) {} });
      return false;
    }
  }
};

/* ================================================================
 * 词汇管理
 * ================================================================ */
var Words = {
  data: null,
  flat: [],      // 全部词条平铺（含 setId 和全局序号）

  init: function () {
    this.data = Store.getWords();
    var migrated = false;
    this.data.sets.forEach(function (set) { set.words.forEach(function (w, i) {
      if (!w.id) { w.id = set.id + '_' + (i + 1); migrated = true; }
    }); });
    if (migrated) Store.saveWords(this.data);
    this.rebuildFlat();
  },

  rebuildFlat: function () {
    this.flat = [];
    var self = this;
    this.data.sets.forEach(function (set) {
      set.words.forEach(function (w, i) {
        if (!w.id) w.id = set.id + '_' + (i + 1);
        self.flat.push({
          id: w.id,
          setId: set.id,
          setName: set.name,
          index: i + 1,
          globalIndex: self.flat.length + 1,
          lemma: w.lemma,
          pron: w.pron || '',
          pos: w.pos || '',
          meanings: w.meanings || ''
        });
      });
    });
  },

  all: function () { return this.flat; },

  byId: function (id) {
    return this.flat.find(function (w) { return w.id === id; });
  },

  bySet: function (setId) {
    return this.flat.filter(function (w) { return w.setId === setId; });
  },

  count: function (setId) {
    if (!setId) return this.flat.length;
    return this.bySet(setId).length;
  },

  /* 添加词条 */
  add: function (word, setId) {
    var set = this.data.sets.find(function (s) { return s.id === setId; });
    if (!set) return false;
    word.id = word.id || ('w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9));
    set.words.push(word);
    if (!Store.saveWords(this.data)) { this.init(); return false; }
    this.rebuildFlat();
    return true;
  },

  /* 更新词条 */
  update: function (wordId, fields) {
    var w = this.byId(wordId);
    if (!w) return false;
    var set = this.data.sets.find(function (s) { return s.id === w.setId; });
    var entry = set.words.find(function (item) { return item.id === wordId; });
    Object.keys(fields).forEach(function (k) { entry[k] = fields[k]; });
    if (!Store.saveWords(this.data)) { this.init(); return false; }
    this.rebuildFlat();
    return true;
  },

  /* 删除词条 */
  remove: function (wordId) {
    var w = this.byId(wordId);
    if (!w) return false;
    var set = this.data.sets.find(function (s) { return s.id === w.setId; });
    set.words.splice(set.words.findIndex(function (entry) { return entry.id === wordId; }), 1);
    if (!Store.saveWords(this.data)) { this.init(); return false; }
    var states = Store.getStates(); delete states[wordId]; Store.saveStates(states);
    Store.saveAttempts(Store.getAttempts().filter(function (a) { return a.wordId !== wordId; }));
    this.rebuildFlat();
    return true;
  },

  /* 重置为默认词库 */
  reset: function () {
    Store.remove(Store.KEYS.words);
    this.data = JSON.parse(JSON.stringify(WORD_DATA));
    this.rebuildFlat();
  },

  /* CSV 导入（追加） */
  importCSV: function (rows, defaultSetId) {
    var self = this;
    var count = 0;
    var imported = {};
    rows.forEach(function (r) {
      if (!r.lemma || !r.lemma.trim()) return;
      var setId = r.setId || defaultSetId;
      var destination = self.data.sets.find(function (s) { return s.id === setId || s.name === setId; });
      if (!destination) return;
      /* 去重：同词库中已存在相同 lemma+pos 则跳过 */
      var exists = destination.words.some(function (w) {
        return w.lemma.toLowerCase() === r.lemma.trim().toLowerCase() && (w.pos || '').toLowerCase() === (r.pos || 'n.').trim().toLowerCase();
      });
      var key = destination.id + '|' + r.lemma.trim().toLowerCase() + '|' + (r.pos || 'n.').trim().toLowerCase();
      if (exists || imported[key]) return;
      imported[key] = true;
      destination.words.push({ id: 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9),
        lemma: r.lemma.trim(),
        pron: (r.pron || '').trim(),
        pos: (r.pos || '').trim() || 'n.',
        meanings: (r.meanings || '').trim()
      });
      count++;
    });
    if (count > 0) {
      if (!Store.saveWords(this.data)) { this.init(); return 0; }
      this.rebuildFlat();
    }
    return count;
  },

  exportCSV: function () {
    var lines = ['lemma,pron,pos,meanings,set'];
    this.flat.forEach(function (w) {
      var esc = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
      lines.push([esc(w.lemma), esc(w.pron), esc(w.pos), esc(w.meanings), esc(w.setId)].join(','));
    });
    return lines.join('\n');
  }
};

/* ================================================================
 * 学习状态与间隔复习
 * 设计文档 §8：状态机 未开始→初识→练习中→基本掌握→稳定掌握，需加强
 * ================================================================ */
var Skills = {
  /* 核心技能维度（V1） */
  list: ['recognition', 'recall', 'reverse', 'spelling'],
  labels: { recognition: '识义', recall: '回忆', reverse: '反向', spelling: '拼写' },

  /* 复习间隔（天）：0=当回合, 1, 3, 7, 14 */
  intervals: [0, 1, 3, 7, 14],

  defaultState: function () {
    return {
      state: '未开始',
      evidence: 0,       /* 证据数 */
      correct: 0,        /* 独立正确次数 */
      hintCorrect: 0,    /* 提示后正确 */
      wrong: 0,           /* 错误次数 */
      guessed: 0,
      idk: 0,
      correctDays: {},    /* 正确日期记录（跨时间证据，§8.1） */
      lastAt: null,
      dueAt: null
    };
  },

  getWordState: function (states, wordId) {
    if (!states[wordId]) states[wordId] = {};
    var self = this;
    this.list.forEach(function (sk) {
      if (!states[wordId][sk]) states[wordId][sk] = self.defaultState();
    });
    return states[wordId];
  },

  /* 根据答题结果更新状态（确定性规则，§4.3/§8.2） */
  update: function (states, wordId, skill, outcome) {
    /* outcome: 'correct' | 'hint' | 'wrong' | 'idk' */
    var ws = this.getWordState(states, wordId);
    var s = ws[skill];
      s.lastAt = Date.now();
    s.evidence++;

    if (outcome === 'correct') {
      s.correct++;
      /* 记录正确日期（用于跨时间证据） */
      var now = new Date();
      var today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
      s.correctDays[today] = true;
      var dayCount = Object.keys(s.correctDays).length;

      if (s.state === '未开始') s.state = '初识';
      else if (s.state === '初识') s.state = '练习中';
      else if (s.state === '练习中' && dayCount >= 2 && s.correct >= 3) s.state = '基本掌握';
      else if (s.state === '基本掌握' && dayCount >= 3 && s.correct >= 5) s.state = '稳定掌握';
      else if (s.state === '需加强') s.state = '练习中';

      /* 间隔递增：新学后当回合再测(0)、次日(1)、3天、7天、14天 */
      var idx = Math.min(s.correct - 1, this.intervals.length - 1);
      var days = this.intervals[idx];
      s.dueAt = Date.now() + days * 86400000;
    } else if (outcome === 'hint') {
      s.hintCorrect++;
      if (s.state === '未开始') s.state = '初识';
      /* 提示后正确较早复现：次日 */
      s.dueAt = Date.now() + 86400000;
    } else if (outcome === 'guess') {
      s.guessed++;
      s.dueAt = Date.now() + 4 * 3600000;
    } else if (outcome === 'idk') {
      s.idk++;
      s.dueAt = Date.now() + 4 * 3600000;
    } else {
      s.wrong++;
      s.state = '需加强';
      /* 错误更早复现：当回合后 4 小时 */
      s.dueAt = Date.now() + 4 * 3600000;
    }
    return s;
  },

  /* 判断词的整体掌握状态（取最低技能状态） */
  overallState: function (states, wordId) {
    var ws = states[wordId];
    if (!ws) return '未学习';
    var order = ['未开始', '初识', '练习中', '基本掌握', '稳定掌握'];
    var minRank = 99;
    var hasAny = false;
    var self = this;
    this.list.forEach(function (sk) {
      if (ws[sk] && ws[sk].state !== '未开始') {
        hasAny = true;
        var rank = order.indexOf(ws[sk].state);
        if (ws[sk].state === '需加强') rank = -1;
        if (rank < minRank) minRank = rank;
      }
    });
    if (!hasAny) return '未学习';
    if (minRank === -1) return '需加强';
    if (minRank === 0) return '初识';
    if (minRank === 1) return '初识';
    if (minRank === 2) return '练习中';
    if (minRank === 3) return '基本掌握';
    return '稳定掌握';
  },

  /* 是否到期复习 */
  isDue: function (states, wordId) {
    var ws = states[wordId];
    if (!ws) return false;
    var due = false;
    var self = this;
    this.list.forEach(function (sk) {
      if (ws[sk] && ws[sk].dueAt && ws[sk].dueAt <= Date.now()) due = true;
    });
    return due;
  },

  repairLegacyEvidence: function () {
    var states = Store.getStates();
    if (states.__repairVersion >= 2) return;
    var attempts = Store.getAttempts();
    var bySkill = {};
    attempts.forEach(function (a) {
      if (!a || !a.wordId || !a.skill) return;
      var key = a.wordId + '|' + a.skill;
      if (!bySkill[key]) bySkill[key] = { guesses: 0, idk: 0, validDays: {}, guessDays: {}, lastReal: null, latest: null, correctCount: 0 };
      var item = bySkill[key];
      var ts = Number(a.ts) || 0;
      var guessed = a.outcome === 'guess' || (a.outcome === 'correct' && a.isGuess);
      if (guessed) {
        item.guesses++;
        var gDate = new Date(ts);
        item.guessDays[gDate.toISOString().slice(0, 10)] = true;
        item.guessDays[[gDate.getFullYear(), String(gDate.getMonth() + 1).padStart(2, '0'), String(gDate.getDate()).padStart(2, '0')].join('-')] = true;
      } else if (a.outcome === 'idk') item.idk++;
      else if (a.outcome === 'correct') {
        item.correctCount++;
        var date = new Date(ts);
        item.validDays[[date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')] = true;
        item.validDays[date.toISOString().slice(0, 10)] = true;
        item.lastReal = { outcome: 'correct', ts: ts };
      } else if (a.outcome === 'wrong') item.lastReal = { outcome: 'wrong', ts: ts };
      if (!item.latest || ts >= item.latest.ts) item.latest = { outcome: guessed ? 'guess' : a.outcome, ts: ts, correctCount: item.correctCount };
    });
    Object.keys(states).forEach(function (wordId) {
      if (wordId === '__repairVersion') return;
      var word = states[wordId];
      Skills.list.forEach(function (skill) {
        var s = word && word[skill];
        var evidence = bySkill[wordId + '|' + skill];
        if (!s || !evidence) return;
        s.correct = Math.max(0, (s.correct || 0) - evidence.guesses);
        s.wrong = Math.max(0, (s.wrong || 0) - evidence.idk);
        s.guessed = (s.guessed || 0) + evidence.guesses;
        s.idk = (s.idk || 0) + evidence.idk;
        s.correctDays = s.correctDays || {};
        Object.keys(evidence.guessDays).forEach(function (day) {
          if (!evidence.validDays[day]) delete s.correctDays[day];
        });
        var days = Object.keys(s.correctDays).length;
        if (evidence.lastReal && evidence.lastReal.outcome === 'wrong') s.state = '需加强';
        else if (s.correct >= 5 && days >= 3) s.state = '稳定掌握';
        else if (s.correct >= 3 && days >= 2) s.state = '基本掌握';
        else if (s.correct >= 2) s.state = '练习中';
        else if (s.correct >= 1 || s.hintCorrect > 0) s.state = '初识';
        else if (!s.wrong) s.state = '未开始';
        if (evidence.latest) {
          s.lastAt = evidence.latest.ts;
          var hours = evidence.latest.outcome === 'wrong' || evidence.latest.outcome === 'idk' || evidence.latest.outcome === 'guess';
          var interval = evidence.latest.outcome === 'hint' ? 86400000 : hours ? 4 * 3600000 : this.intervals[Math.min(Math.max(evidence.latest.correctCount - 1, 0), this.intervals.length - 1)] * 86400000;
          s.dueAt = evidence.latest.ts + interval;
        }
      }, this);
    }, this);
    states.__repairVersion = 2;
    Store.saveStates(states);
  }
};

/* ================================================================
 * 题目生成
 * 设计文档 §9 题型体系
 * ================================================================ */
var Quiz = {
  /* 生成英→中选择题干扰项 */
  makeOptions: function (target, pool, count) {
    /* 同词性优先（§9.2：干扰项应同词性、同语义范围） */
    var samePos = pool.filter(function (w) {
      return w.id !== target.id && w.pos === target.pos;
    });
    var others = pool.filter(function (w) {
      return w.id !== target.id && w.pos !== target.pos;
    });
    /* 随机打乱 */
    var shuffle = function (arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    };
    var picks = shuffle(samePos).slice(0, count - 1);
    if (picks.length < count - 1) {
      picks = picks.concat(shuffle(others).slice(0, count - 1 - picks.length));
    }
    var options = picks.concat([target]);
    return shuffle(options);
  },

  /* 根据技能生成题目 */
  generate: function (word, skill, pool) {
    var q = { wordId: word.id, skill: skill, word: word };
    var self = this;

    if (skill === 'recognition') {
      /* 英→中：选择 or 回忆（随机） */
      if (Math.random() < 0.6) {
        q.type = 'en2cn_select';
        q.prompt = '选择最接近的中文释义';
        q.display = word.lemma;
        q.options = this.makeOptions(word, pool, 4).map(function (w) { return w.meanings.split('；')[0]; });
        q.answer = word.meanings.split('；')[0];
        q.options = this.uniqueOptions(q.options, q.answer);
      } else {
        q.type = 'en2cn_recall';
        q.prompt = '写出这个单词的中文释义';
        q.display = word.lemma;
        q.answer = word.meanings;
        q.acceptAny = word.meanings.split(/[;；]/).map(function (s) { return s.trim(); });
      }
    } else if (skill === 'reverse') {
      /* 中→英：选择 */
      q.type = 'cn2en_select';
      q.prompt = '选择对应的英文单词';
      q.display = word.meanings.split('；')[0];
      q.options = this.makeOptions(word, pool, 4).map(function (w) { return w.lemma; });
      q.answer = word.lemma;
      q.options = this.uniqueOptions(q.options, q.answer);
    } else if (skill === 'recall') {
      /* 英→中回忆 */
      q.type = 'en2cn_recall';
      q.prompt = '写出这个单词的中文释义';
      q.display = word.lemma;
      q.answer = word.meanings;
      q.acceptAny = word.meanings.split(/[;；]/).map(function (s) { return s.trim(); });
    } else if (skill === 'spelling') {
      /* 中→英拼写 */
      q.type = 'cn2en_spell';
      q.prompt = '根据中文释义拼出英文单词';
      q.display = word.meanings.split('；')[0];
      q.answer = word.lemma;
      q.hintText = word.lemma.charAt(0) + '_'.repeat(Math.max(0, word.lemma.length - 1));
    }
    return q;
  },

  uniqueOptions: function (arr, answer) {
    /* 去重并保证包含答案 */
    var seen = {};
    var out = [];
    arr.forEach(function (v) {
      if (!seen[v]) { seen[v] = true; out.push(v); }
    });
    if (out.indexOf(answer) === -1) out.push(answer);
    /* 最多4个 */
    if (out.length > 4) {
      var idx = out.indexOf(answer);
      out.splice(idx, 1);
      out = out.slice(0, 3);
      out.push(answer);
    }
    /* 打乱 */
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  },

  /* 判分（§11 错因分类） */
  judge: function (q, response) {
    var result = { correct: false, errorCode: null };

    if (q.type === 'en2cn_select' || q.type === 'cn2en_select') {
      result.correct = String(response).trim() === q.answer;
      if (!result.correct) {
        result.errorCode = q.type === 'cn2en_select' ? 'form_confusion' : 'meaning_confusion';
      }
    } else if (q.type === 'en2cn_recall') {
      var resp = String(response).trim().toLowerCase();
      result.correct = q.acceptAny.some(function (a) {
        return resp === a.toLowerCase() || resp === a.toLowerCase().replace(/\s/g, '');
      });
      if (!result.correct) result.errorCode = 'meaning_confusion';
    } else if (q.type === 'cn2en_spell') {
      var r = String(response).trim().toLowerCase();
      var a = q.answer.toLowerCase();
      result.correct = r === a;
      if (!result.correct) {
        /* 拼写比对：检测漏字母或顺序错误 */
        if (r.length !== a.length) result.errorCode = 'spelling_omission';
        else result.errorCode = 'spelling_order';
      }
    }
    return result;
  }
};

/* ================================================================
 * TTS 发音（浏览器内置，离线可用）
 * ================================================================ */
var TTS = {
  speak: function (text, rate) {
    if (!('speechSynthesis' in window)) return false;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = rate || parseFloat(Store.getSettings().speechRate) || 1.0;
      speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
};

/* ================================================================
 * 学习会话
 * ================================================================ */
var Session = {
  current: null,   /* { questions: [], index: 0, correct: 0, wrong: 0, startedAt } */

  start: function (mode, size, scope) {
    var states = Store.getStates();
    /* 支持多词库选择：scope 可为数组（多个词库 id 或 'all'） */
    var pool;
    if (Array.isArray(scope)) {
      pool = [];
      var seen = {};
      scope.forEach(function (id) {
        (id === 'all' ? Words.all() : Words.bySet(id)).forEach(function (w) {
          if (!seen[w.id]) { seen[w.id] = true; pool.push(w); }
        });
      });
    } else {
      pool = scope === 'all' ? Words.all() : Words.bySet(scope);
    }
    if (pool.length === 0) { App.toast('所选词库为空'); return false; }

    var settings = Store.getSettings();
    var questions = [];

    /* 按模式选题（§5 学习闭环：到期复习词优先 + 少量新词） */
    var due = pool.filter(function (w) { return Skills.isDue(states, w.id); });
    var unlearned = pool.filter(function (w) { return Skills.overallState(states, w.id) === '未学习'; });
    var learning = pool.filter(function (w) {
      var st = Skills.overallState(states, w.id);
      return st !== '未学习' && !Skills.isDue(states, w.id);
    });

    /* 打乱 */
    var shuffle = function (arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    };

    if (mode === 'newonly') {
      var newLimit = Math.min(size, parseInt(settings.newLimit) || 8);
      questions = shuffle(unlearned).slice(0, newLimit);
    } else if (mode === 'review') {
      var dueItems = [];
      due.forEach(function (w) {
        var ws = states[w.id] || {};
        Skills.list.forEach(function (sk) {
          if (ws[sk] && ws[sk].dueAt && ws[sk].dueAt <= Date.now()) {
            dueItems.push({ word: w, skill: sk, dueAt: ws[sk].dueAt, wrong: ws[sk].wrong || 0, hint: ws[sk].hintCorrect || 0 });
          }
        });
      });
      dueItems.sort(function (a, b) { return a.dueAt - b.dueAt || (b.wrong + b.hint) - (a.wrong + a.hint); });
      questions = dueItems.slice(0, size).map(function (item) { var q = Quiz.generate(item.word, item.skill, pool); q.dueSkill = item.skill; return q; });
    } else if (mode === 'recognition') {
      var mix = shuffle(due).concat(shuffle(unlearned));
      questions = mix.slice(0, size);
    } else if (mode === 'spelling') {
      /* 拼写训练：已学过的词优先 */
      var learned = pool.filter(function (w) { return Skills.overallState(states, w.id) !== '未学习'; });
      questions = shuffle(learned).slice(0, size);
      if (questions.length < size) {
        questions = questions.concat(shuffle(unlearned).slice(0, size - questions.length));
      }
    } else {
      /* mixed：到期优先 + 新词，交错安排（§4.2） */
      var newLimit2 = Math.min(Math.ceil(size * 0.4), parseInt(settings.newLimit) || 8);
      questions = shuffle(due).slice(0, size - newLimit2)
        .concat(shuffle(unlearned).slice(0, newLimit2));
      /* 不足时补充练习中的词 */
      if (questions.length < size) {
        questions = questions.concat(shuffle(learning).slice(0, size - questions.length));
      }
      questions = shuffle(questions);
    }

    if (questions.length === 0) {
      App.toast(mode === 'review' ? '当前没有到期复习词' : '没有可选的词');
      return false;
    }

    /* 为每个词选技能/题型 */
    var sessionQuestions = questions.map(function (w) {
      if (w && w.wordId) return w;
      var skill = App.pickSkill(w, mode);
      return Quiz.generate(w, skill, pool);
    });

    this.current = {
      questions: sessionQuestions,
      index: 0,
      correct: 0,
      wrong: 0,
      guessed: 0,
      idk: 0,
      mode: mode,
      scope: scope,
      startedAt: Date.now()
    };
    Store.saveSession(this.current);
    return true;
  },

  currentQ: function () {
    if (!this.current) return null;
    return this.current.questions[this.current.index];
  },

  record: function (outcome, latencyMs) {
    if (!this.current) return;
    var q = this.currentQ();
    if (!q) return;
    var states = Store.getStates();
    /* 选择题正确且极短作答 → 疑似猜测，标记低置信（§11 guess_or_rush） */
    var isGuess = (outcome === 'correct' && latencyMs < 1200 &&
      (q.type === 'en2cn_select' || q.type === 'cn2en_select'));

    var recordedOutcome = isGuess ? 'guess' : outcome;
    Skills.update(states, q.wordId, q.skill, recordedOutcome);
    Store.saveStates(states);

    /* 记录尝试（只追加，§20.2） */
    var attempts = Store.getAttempts();
    attempts.push({
      wordId: q.wordId,
      skill: q.skill,
      type: q.type,
      outcome: recordedOutcome,
      latency: latencyMs,
      isGuess: isGuess,
      ts: Date.now()
    });
    /* 只保留最近 5000 条 */
    if (attempts.length > 5000) attempts = attempts.slice(-5000);
    Store.saveAttempts(attempts);

    if (outcome === 'correct' && !isGuess) this.current.correct++;
    else if (isGuess) this.current.guessed = (this.current.guessed || 0) + 1;
    else if (outcome === 'wrong') this.current.wrong++;
    else if (outcome === 'idk') this.current.idk = (this.current.idk || 0) + 1;
    Store.saveSession(this.current);
  },

  next: function () {
    if (!this.current) return 'end';
    this.current.index++;
    Store.saveSession(this.current);
    if (this.current.index >= this.current.questions.length) return 'end';
    return 'next';
  },

  /* 恢复中断的会话（§10.2 超时或离开时保存进度） */
  tryResume: function () {
    var saved = Store.getSession();
    if (saved && saved.questions && saved.index < saved.questions.length) {
      this.current = saved;
      return true;
    }
    return false;
  }
};

/* ================================================================
 * 云同步（手机/PC 学习记录同步）
 * 原理：学习记录打包存到 GitHub 私有仓库 taotao-english-data
 *       双端通过 GitHub API 读写同一份 progress.json
 * 合并：attempts 按时间戳去重合并；states 由合并后 attempts 重放重建
 * ================================================================ */
var Sync = {
  CONFIG_KEY: 'qs_sync_config',
  POLL_INTERVAL: 60000,   /* 轮询间隔 60 秒 */
  DEBOUNCE_MS: 5000,      /* 本地变更后 5 秒推送 */
  dirty: false,
  syncing: false,
  applying: false,        /* 同步内部写本地，防止触发再同步 */
  _debounceTimer: null,
  _pollTimer: null,

  getConfig: function () {
    var c = Store.get(this.CONFIG_KEY, {});
    return {
      enabled: !!c.enabled,
      user: c.user || '',
      repo: c.repo || 'taotao-english-data',
      token: c.token || '',
      lastSyncAt: c.lastSyncAt || 0,
      lastStatus: c.lastStatus || ''
    };
  },

  saveConfig: function (cfg) {
    Store.set(this.CONFIG_KEY, {
      enabled: !!cfg.enabled,
      user: (cfg.user || '').trim(),
      repo: (cfg.repo || 'taotao-english-data').trim(),
      token: (cfg.token || '').trim(),
      lastSyncAt: cfg.lastSyncAt || 0,
      lastStatus: cfg.lastStatus || ''
    });
  },

  isReady: function () {
    var c = this.getConfig();
    return !!(c.enabled && c.user && c.token && c.repo);
  },

  /* 本地学习数据变更 → 延迟推送 */
  markDirty: function () {
    if (!this.isReady() || this.applying) return;
    var self = this;
    this.dirty = true;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(function () { self.syncNow('auto'); }, this.DEBOUNCE_MS);
  },

  /* ---------- GitHub API ---------- */
  _api: function (method, path, body) {
    var cfg = this.getConfig();
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, 'https://api.github.com' + path, true);
      xhr.setRequestHeader('Authorization', 'token ' + cfg.token);
      xhr.setRequestHeader('Accept', 'application/vnd.github.v3+json');
      if (body) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          var json = null;
          try { json = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
          resolve({ status: xhr.status, json: json });
        } else if (xhr.status === 404) {
          resolve({ status: 404, json: null });
        } else {
          var msg = 'HTTP ' + xhr.status;
          try { var j = JSON.parse(xhr.responseText); if (j && j.message) msg = j.message; } catch (e) {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = function () { reject(new Error('网络错误（需可访问 api.github.com）')); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  },

  /* 拉取云端数据；404 视为云端无数据 */
  pull: function () {
    var self = this;
    var cfg = this.getConfig();
    return this._api('GET', '/repos/' + cfg.user + '/' + cfg.repo + '/contents/progress.json', null).then(function (r) {
      if (r.status === 404) return { data: null, sha: null };
      var b64 = String(r.json.content || '').replace(/\s/g, '');
      var json = decodeURIComponent(escape(atob(b64)));
      return { data: JSON.parse(json), sha: r.json.sha };
    });
  },

  /* 推送数据到云端 */
  push: function (payload, sha) {
    var cfg = this.getConfig();
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    var body = { message: 'sync ' + new Date().toISOString(), content: b64 };
    if (sha) body.sha = sha;
    return this._api('PUT', '/repos/' + cfg.user + '/' + cfg.repo + '/contents/progress.json', body);
  },

  /* ---------- 打包 / 合并 ---------- */
  packLocal: function () {
    return {
      version: '1.0',
      packedAt: new Date().toISOString(),
      words: Store.getWords(),
      attempts: Store.getAttempts(),
      settings: Store.getSettings(),
      states: Store.getStates()
    };
  },

  /* attempts 去重合并（wordId+skill+ts+outcome 为唯一键），按时间排序 */
  mergeAttempts: function (a, b) {
    var seen = {};
    var out = [];
    (a || []).concat(b || []).forEach(function (x) {
      if (!x || !x.wordId || !x.ts) return;
      var key = x.wordId + '|' + x.skill + '|' + x.ts + '|' + x.outcome;
      if (seen[key]) return;
      seen[key] = true;
      out.push(x);
    });
    out.sort(function (p, q) { return p.ts - q.ts; });
    if (out.length > 5000) out = out.slice(-5000);
    return out;
  },

  /* words 合并：版本不匹配取本地；词条数多者为准；等量取本地 */
  mergeWords: function (local, cloud) {
    if (!cloud || !cloud.sets || !Array.isArray(cloud.sets)) return local;
    if (String(cloud.version || '') !== String(local.version || '')) return local;
    var count = function (d) {
      var n = 0;
      d.sets.forEach(function (s) { n += (s.words || []).length; });
      return n;
    };
    return count(cloud) > count(local) ? cloud : local;
  },

  /* states 由合并后 attempts 重放重建（与实时 Skills.update 完全一致） */
  rebuildStates: function (attempts, words) {
    var states = {};
    var valid = {};
    words.sets.forEach(function (s) {
      (s.words || []).forEach(function (w) { valid[w.id] = true; });
    });
    attempts.forEach(function (a) {
      if (!valid[a.wordId]) return;
      if (Skills.list.indexOf(a.skill) < 0) return;
      Skills.update(states, a.wordId, a.skill, a.outcome);
    });
    return states;
  },

  /* ---------- 主流程 ---------- */
  syncNow: function (mode) {
    var self = this;
    if (!this.isReady()) return Promise.resolve('not-ready');
    if (this.syncing) return Promise.resolve('busy');
    this.syncing = true;
    return this.pull().then(function (r) {
      var merged;
      if (!r.data) {
        /* 云端无数据：直接上传本地 */
        merged = self.packLocal();
      } else {
        /* 云端有数据：合并双端 */
        var local = self.packLocal();
        var attempts = self.mergeAttempts(local.attempts, r.data.attempts);
        var words = self.mergeWords(local.words, r.data.words);
        merged = {
          version: '1.0',
          packedAt: new Date().toISOString(),
          words: words,
          attempts: attempts,
          states: self.rebuildStates(attempts, words),
          settings: local.settings
        };
        /* 合并结果应用到本地 */
        self.applying = true;
        try {
          Store.saveWords(merged.words);
          Store.saveAttempts(merged.attempts);
          Store.saveStates(merged.states);
          Store.saveSettings(merged.settings);
        } finally { self.applying = false; }
        /* 刷新界面（不打断进行中的训练题目，仅刷新统计与列表） */
        if (typeof App !== 'undefined') {
          Words.init();
          App.updateHomeStats();
          App.renderHomeSets();
          App.renderBrowseList();
          App.renderManageList();
          App.renderReview();
          App.renderParentReport();
        }
      }
      return self.push(merged, r.sha);
    }).then(function () {
      self.dirty = false;
      var c = self.getConfig();
      c.lastSyncAt = Date.now();
      c.lastStatus = 'ok';
      self.saveConfig(c);
      self.updateStatusUI();
      if (mode === 'manual') App.toast('云同步成功');
      return 'ok';
    }).catch(function (err) {
      var c = self.getConfig();
      c.lastStatus = '失败：' + err.message;
      self.saveConfig(c);
      self.updateStatusUI();
      if (mode === 'manual') App.toast('云同步失败：' + err.message);
      return 'fail';
    }).then(function (result) {
      self.syncing = false;
      return result;
    });
  },

  /* 状态栏显示 */
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

  /* 启动自动同步：2 秒后首同步 + 定时轮询（页面可见时） */
  startAutoSync: function () {
    var self = this;
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (!this.isReady()) return;
    setTimeout(function () { if (self.isReady()) self.syncNow('auto'); }, 2000);
    this._pollTimer = setInterval(function () {
      if (!self.isReady() || self.syncing) return;
      if (document.hidden) return;
      if (self.dirty) return;
      self.syncNow('auto');
    }, this.POLL_INTERVAL);
  }
};

/* ================================================================
 * 应用主控制器
 * ================================================================ */
var App = {

  hintLevel: 0,      /* 当前题提示级别 0/1/2/3 */
  questionStartAt: 0,
  answered: false,

  /* ---------- 初始化 ---------- */
  init: function () {
    Words.init();
    Skills.repairLegacyEvidence();
    this.applySettings();
    this.updateHomeStats();
    this.renderHomeSets();
    this.renderBrowseList();
    this.renderManageList();
    this.renderReview();
    this.renderParentReport();

    /* 检查是否有未完成的会话可恢复 */
    var self = this;
    if (Session.tryResume()) {
      this.showConfirm('检测到上次未完成的训练，是否继续？', function () {
        self.showView('study');
        document.getElementById('study-setup').classList.add('hidden');
        document.getElementById('study-session').classList.remove('hidden');
        self.renderQuestion();
      });
    }

    /* 支持 URL hash 导航（#browse / #study / #review 等） */
    var hash = location.hash.replace('#', '');
    if (hash && document.getElementById('view-' + hash)) {
      this.showView(hash);
    }

    /* 启动云同步（手机/PC 学习记录同步，需在设置中启用） */
    Sync.startAutoSync();
    Sync.updateStatusUI();
  },

  /* ---------- 视图切换 ---------- */
  showView: function (name) {
    var views = document.querySelectorAll('.view');
    views.forEach(function (v) { v.classList.remove('active'); });
    var el = document.getElementById('view-' + name);
    if (el) el.classList.add('active');

    var links = document.querySelectorAll('.nav-link');
    links.forEach(function (l) {
      l.classList.toggle('active', l.getAttribute('data-view') === name);
    });

    if (name === 'home') this.updateHomeStats();
    if (name === 'browse') this.renderBrowseList();
    if (name === 'review') this.renderReview();
    if (name === 'parent') this.renderParentReport();
    if (name === 'manage') this.renderManageList();
    if (name === 'settings') { this.applySettings(); this.applySyncConfigToUI(); }
  },

  /* ---------- 首页 ---------- */
  updateHomeStats: function () {
    var states = Store.getStates();
    var all = Words.all();
    var learned = 0, mastered = 0, due = 0;
    var evidenceIds = {};
    Store.getAttempts().forEach(function (a) { evidenceIds[a.wordId] = true; });
    all.forEach(function (w) {
      var st = Skills.overallState(states, w.id);
      if (evidenceIds[w.id]) learned++;
      if (st === '基本掌握' || st === '稳定掌握') mastered++;
      if (Skills.isDue(states, w.id)) due++;
    });
    document.getElementById('stat-total').textContent = all.length;
    document.getElementById('stat-learned').textContent = learned;
    document.getElementById('stat-mastered').textContent = mastered;
    document.getElementById('stat-due').textContent = due;
  },

  renderHomeSets: function () {
    var states = Store.getStates();
    var attempts = Store.getAttempts();
    var container = document.getElementById('home-sets');
    var html = '';
    Words.data.sets.forEach(function (set) {
      var words = Words.bySet(set.id);
      var evidence = {};
      attempts.forEach(function (a) { evidence[a.wordId] = true; });
      var learned = words.filter(function (w) { return evidence[w.id]; }).length;
      var pct = words.length ? Math.round(learned / words.length * 100) : 0;
      html += '<div class="set-overview" data-set-overview="' + App.esc(set.id) + '">' +
        '<div class="set-name">' + App.esc(set.name) + '</div>' +
        '<div class="set-desc">' + App.esc(set.description) + '</div>' +
        '<div class="set-progress-bar"><div class="set-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="set-progress-text">' + learned + ' / ' + words.length + ' 有训练记录（' + pct + '%）</div>' +
        '</div>';
    });
    container.innerHTML = html;
    container.querySelectorAll('[data-set-overview]').forEach(function (el) {
      el.addEventListener('click', function () { App.filterSet(el.getAttribute('data-set-overview')); App.showView('browse'); });
    });
  },

  /* ---------- 学习训练 ---------- */
  pickSkill: function (word, mode) {
    var states = Store.getStates();
    var ws = Skills.getWordState(states, word.id);

    if (mode === 'recognition') return Math.random() < 0.7 ? 'recognition' : 'recall';
    if (mode === 'spelling') return 'spelling';
    if (mode === 'review') {
      /* 复习时选最薄弱的技能 */
      var weakest = 'recognition';
      var minCorrect = 999;
      Skills.list.forEach(function (sk) {
        if (ws[sk].correct < minCorrect) { minCorrect = ws[sk].correct; weakest = sk; }
      });
      return weakest;
    }

    /* mixed：按状态推进（§4.1 从识别到提取再到迁移） */
    var st = ws.recognition.state;
    if (st === '未开始' || st === '初识') return 'recognition';
    if (st === '练习中') {
      var r = Math.random();
      if (r < 0.4) return 'recall';
      if (r < 0.7) return 'reverse';
      return 'spelling';
    }
    /* 基本掌握及以上：混合测试 */
    var r2 = Math.random();
    if (r2 < 0.3) return 'recall';
    if (r2 < 0.6) return 'spelling';
    if (r2 < 0.8) return 'reverse';
    return 'recognition';
  },

  startTraining: function (mode) {
    var size = parseInt(document.getElementById('round-size').value) || 15;
    var scope = this.resolveScope();
    if (Session.start(mode, size, scope)) {
      document.getElementById('study-setup').classList.add('hidden');
      document.getElementById('study-session').classList.remove('hidden');
      document.getElementById('session-summary').classList.add('hidden');
      this.hintLevel = 0;
      this.answered = false;
      this.questionStartAt = Date.now();
      this.renderQuestion();
      this.updateSessionProgress();
    }
  },

  startFocusMode: function () {
    this.showView('study');
    this.resolveScope(true);
    this.startTraining('mixed');
    /* 启动专注计时器 25 分钟 */
    this.startFocusTimer(25);
  },

  /* 读取词库范围选择（支持多选），返回数组或 'all' */
  resolveScope: function (forceAll) {
    var el = document.getElementById('round-scope');
    if (!el) return 'all';
    if (forceAll) {
      var allOpt = el.querySelector('option[value="all"]');
      if (allOpt) allOpt.selected = true;
      return 'all';
    }
    var vals = [];
    Array.prototype.forEach.call(el.selectedOptions || [], function (o) { vals.push(o.value); });
    if (!vals.length || vals.indexOf('all') >= 0) return 'all';
    return vals;
  },

  startFocusTimer: function (minutes, isBreak) {
    var self = this;
    var overlay = document.getElementById('focus-overlay');
    overlay.classList.remove('hidden');
    document.querySelector('.focus-tip').textContent = isBreak ? '休息时间' : '专注回合进行中';
    var controls = document.querySelectorAll('.focus-controls button');
    controls[0].textContent = isBreak ? '跳过休息' : '暂停';
    controls[0].onclick = isBreak ? function () { self.skipFocusBreak(); } : function () { self.pauseFocus(); };
    controls[1].textContent = isBreak ? '结束学习' : '结束回合';
    var remain = minutes * 60;
    clearInterval(this._focusInterval);
    this._focusInterval = setInterval(function () {
      remain--;
      if (remain < 0) {
        if (isBreak) { self.endFocus(); self.toast('休息结束，可以开始下一回合'); }
        else { self.toast('专注回合结束，进入 5 分钟休息'); self.startFocusTimer(5, true); }
        return;
      }
      var m = Math.floor(remain / 60);
      var s = remain % 60;
      document.getElementById('focus-timer').textContent =
        (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }, 1000);
  },

  pauseFocus: function () {
    clearInterval(this._focusInterval);
    document.getElementById('focus-overlay').classList.add('hidden');
    this.toast('已暂停，可随时从"学习训练"继续');
  },

  endFocus: function () {
    clearInterval(this._focusInterval);
    document.getElementById('focus-overlay').classList.add('hidden');
    var controls = document.querySelectorAll('.focus-controls button');
    controls[0].textContent = '暂停'; controls[0].onclick = function () { App.pauseFocus(); };
    controls[1].textContent = '结束回合'; controls[1].onclick = function () { App.endFocus(); };
    document.querySelector('.focus-tip').textContent = '专注回合进行中';
  },

  skipFocusBreak: function () {
    this.endFocus();
    this.toast('已结束休息，可以继续学习');
  },

  renderQuestion: function () {
    var q = Session.currentQ();
    if (!q) { this.showSummary(); return; }

    var area = document.getElementById('question-area');
    var html = '';
    var skillLabel = Skills.labels[q.skill] || q.skill;
    var typeLabel = { 'en2cn_select': '英语 → 中文 · 选择', 'en2cn_recall': '英语 → 中文 · 回忆',
      'cn2en_select': '中文 → 英语 · 选择', 'cn2en_spell': '中文 → 英语 · 拼写' }[q.type];

    html += '<div class="q-type-label">' + skillLabel + ' · ' + typeLabel + '</div>';

    /* 发音按钮（仅英文显示时） */
    if (q.type === 'en2cn_select' || q.type === 'en2cn_recall') {
      html += '<div class="q-prompt">' + q.prompt + '</div>';
      html += '<div class="q-word" data-speak-word="' + this.esc(q.word.lemma) + '">' + this.esc(q.word.lemma) + '</div>';
      if (q.word.pron) html += '<div class="q-pron">' + this.esc(q.word.pron) + '</div>';
      html += '<button class="q-audio-btn" data-speak-word="' + this.esc(q.word.lemma) + '">🔊 播放发音</button>';
      if (q.word.pos) html += '<div class="q-pos">' + this.esc(q.word.pos) + '</div>';

      if (q.type === 'en2cn_select') {
        html += '<div class="q-options">';
        q.options.forEach(function (opt, i) {
          html += '<button class="q-option" onclick="App.answerSelect(' + i + ', this)">' + App.esc(opt) + '</button>';
        });
        html += '</div>';
      } else {
        html += '<div class="q-input-area">' +
          '<input type="text" class="q-input" id="q-input" placeholder="输入中文释义…" ' +
          'onkeydown="if(event.key===\'Enter\')App.answerInput()">' +
          '<button class="btn btn-primary q-submit" onclick="App.answerInput()">提交</button></div>';
      }
    } else {
      /* 中→英 */
      html += '<div class="q-prompt">' + q.prompt + '</div>';
      html += '<div class="q-word">' + this.esc(q.display) + '</div>';
      if (q.word.pos) html += '<div class="q-pos">' + this.esc(q.word.pos) + '</div>';

      if (q.type === 'cn2en_select') {
        html += '<div class="q-options">';
        q.options.forEach(function (opt, i) {
          html += '<button class="q-option" onclick="App.answerSelect(' + i + ', this)">' + App.esc(opt) + '</button>';
        });
        html += '</div>';
      } else {
        html += '<div class="q-input-area">' +
          '<input type="text" class="q-input" id="q-input" placeholder="拼写英文单词…" autocomplete="off" autocapitalize="off" ' +
          'onkeydown="if(event.key===\'Enter\')App.answerInput()">' +
          '<button class="btn btn-primary q-submit" onclick="App.answerInput()">提交</button></div>';
      }
    }

    area.innerHTML = html;
    area.querySelectorAll('[data-speak-word]').forEach(function (el) {
      el.addEventListener('click', function () { App.speakWord(el.getAttribute('data-speak-word')); });
    });
    document.getElementById('session-footer').classList.remove('hidden');
    document.getElementById('btn-next').classList.add('hidden');
    document.getElementById('feedback-area').innerHTML = '';
    this.hintLevel = 0;
    this.answered = false;
    this.questionStartAt = Date.now();

    /* 聚焦输入框 */
    var inp = document.getElementById('q-input');
    if (inp) inp.focus();
  },

  esc: function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  speakWord: function (text) {
    TTS.speak(text);
  },

  answerSelect: function (idx, btn) {
    if (this.answered) return;
    var q = Session.currentQ();
    var chosen = q.options[idx];
    var latency = Date.now() - this.questionStartAt;
    var result = Quiz.judge(q, chosen);
    this.answered = true;

    /* 标记选项 */
    var btns = document.querySelectorAll('.q-option');
    btns.forEach(function (b) { b.disabled = true; });
    btn.classList.add(result.correct ? 'correct' : 'wrong');
    if (!result.correct) {
      /* 标出正确答案 */
      btns.forEach(function (b) {
        if (b.textContent === q.answer) b.classList.add('correct');
      });
    }

    this.recordAnswer(result.correct ? 'correct' : 'wrong', latency, result.errorCode, q);
  },

  answerInput: function () {
    if (this.answered) return;
    var inp = document.getElementById('q-input');
    if (!inp || !inp.value.trim()) { this.toast('请输入答案'); return; }
    var q = Session.currentQ();
    var latency = Date.now() - this.questionStartAt;
    var result = Quiz.judge(q, inp.value);
    this.answered = true;
    inp.disabled = true;
    this.recordAnswer(result.correct ? 'correct' : 'wrong', latency, result.errorCode, q);
  },

  recordAnswer: function (outcome, latency, errorCode, q) {
    Session.record(outcome, latency);

    /* 反馈（§11：结果 → 原因 → 动作） */
    var fb = document.getElementById('feedback-area');
    var word = q.word;
    var html = '';

    if (outcome === 'correct') {
      html = '<div class="feedback-card ok"><span class="fb-word">✓ 正确</span>' +
        '<span class="fb-meaning">' + this.esc(word.lemma) + ' — ' + this.esc(word.meanings) + '</span></div>';
    } else {
      var errMeaning = {
        meaning_confusion: '词义混淆，注意区分相近释义',
        form_confusion: '词形混淆，注意选择正确的英文形式',
        spelling_omission: '拼写有遗漏字母，注意完整拼写',
        spelling_order: '字母顺序有误，观察单词结构'
      }[errorCode] || '再试一次';
      html = '<div class="feedback-card err"><span class="fb-word">✗ ' + errMeaning + '</span>' +
        '<span class="fb-meaning">正确答案：<b>' + this.esc(q.answer) + '</b>' +
        (word.meanings && q.type.indexOf('cn2en') === 0 ? ' — ' + this.esc(word.meanings) : '') +
        '</span></div>';
    }

    fb.innerHTML = html;
    document.getElementById('btn-next').classList.remove('hidden');
    this.updateSessionProgress();
  },

  requestHint: function () {
    if (this.answered) return;
    var q = Session.currentQ();
    if (!q) return;
    this.hintLevel++;

    var fb = document.getElementById('feedback-area');
    var hint = '';
    var word = q.word;

    /* 提示阶梯（§10.1） */
    if (this.hintLevel === 1) {
      /* 轻提示：词性、首字母或类别 */
      if (q.type === 'en2cn_select' || q.type === 'en2cn_recall') {
        hint = '轻提示：词性 ' + this.esc(word.pos || '未知') + '；释义开头：' + this.esc(word.meanings.charAt(0)) + '…';
      } else {
        hint = '轻提示：首字母 ' + this.esc(word.lemma.charAt(0)) + '，共 ' + word.lemma.length + ' 个字母';
      }
    } else if (this.hintLevel === 2) {
      /* 强提示：关键搭配或近义对比 */
      if (q.type === 'cn2en_spell') {
        hint = '强提示：' + this.esc(word.lemma.charAt(0)) + ' _ '.repeat(Math.max(0, word.lemma.length - 2)) + this.esc(word.lemma.charAt(word.lemma.length - 1));
      } else {
        hint = '强提示：释义包含关键词「' + this.esc(word.meanings.split('；')[0].slice(0, 4)) + '」';
      }
    } else {
      /* 查看答案（记录为提示后） */
      this.answered = true;
      var latency = Date.now() - this.questionStartAt;
      Session.record('hint', latency);
      hint = '答案：<b>' + this.esc(q.answer) + '</b>';
      document.getElementById('btn-next').classList.remove('hidden');
      fb.innerHTML = '<div class="feedback-card info"><span class="fb-word">已查看答案</span>' +
        '<span class="fb-meaning">' + this.esc(word.lemma) + ' — ' + this.esc(word.meanings) + '</span></div>';
      this.updateSessionProgress();
      return;
    }

    fb.innerHTML = '<div class="feedback-card info">' + hint + '</div>';
  },

  sayIdk: function () {
    if (this.answered) return;
    var q = Session.currentQ();
    if (!q) return;
    this.answered = true;
    var latency = Date.now() - this.questionStartAt;
    Session.record('idk', latency);

    /* 展示简明讲解（§10.1 选择"我不知道"后可直接看讲解） */
    var fb = document.getElementById('feedback-area');
    fb.innerHTML = '<div class="feedback-card info">' +
      '<span class="fb-word">' + this.esc(q.word.lemma) + (q.word.pron ? ' ' + this.esc(q.word.pron) : '') + ' ' + this.esc(q.word.pos) + '</span>' +
      '<span class="fb-meaning">' + this.esc(q.word.meanings) + '</span>' +
      '<span class="fb-meaning" style="margin-top:6px;font-size:0.85rem">已记录为主动求助，这个词会在下次训练中较早出现</span></div>';
    document.getElementById('btn-next').classList.remove('hidden');
    this.updateSessionProgress();
  },

  nextQuestion: function () {
    var r = Session.next();
    if (r === 'end') { this.showSummary(); }
    else { this.renderQuestion(); }
  },

  updateSessionProgress: function () {
    if (!Session.current) return;
    var total = Session.current.questions.length;
    var cur = Session.current.index;
    document.getElementById('session-count').textContent = (cur + 1) + ' / ' + total;
    document.getElementById('session-progress').style.width =
      ((cur) / total * 100) + '%';
    document.getElementById('session-correct').textContent = '✓ ' + Session.current.correct;
    document.getElementById('session-wrong').textContent = '✗ ' + Session.current.wrong;
  },

  showSummary: function () {
    Store.clearSession();
    document.getElementById('study-session').classList.add('hidden');
    var summary = document.getElementById('session-summary');
    summary.classList.remove('hidden');

    var c = Session.current;
    var total = c ? c.questions.length : 0;
    var independentTotal = c ? c.correct + c.wrong : 0;
    var pct = independentTotal ? Math.round(c.correct / independentTotal * 100) : 0;

    summary.innerHTML = '<div class="summary-title">回合完成</div>' +
      '<div class="summary-stats">' +
      '<div class="summary-stat"><div class="num" style="color:var(--ink)">' + total + '</div><div class="lbl">总题数</div></div>' +
      '<div class="summary-stat"><div class="num" style="color:var(--success)">' + c.correct + '</div><div class="lbl">正确</div></div>' +
      '<div class="summary-stat"><div class="num" style="color:var(--error)">' + c.wrong + '</div><div class="lbl">错误</div></div>' +
      '<div class="summary-stat"><div class="num" style="color:var(--ink-light)">' + (c.guessed || 0) + '</div><div class="lbl">快速猜中</div></div>' +
      '<div class="summary-stat"><div class="num" style="color:var(--ink-light)">' + (c.idk || 0) + '</div><div class="lbl">主动求助</div></div>' +
      '<div class="summary-stat"><div class="num" style="color:var(--vermilion)">' + pct + '%</div><div class="lbl">正确率</div></div>' +
      '</div>' +
      '<div class="summary-actions">' +
      '<button class="btn btn-primary" onclick="App.backToSetup()">再来一轮</button>' +
      '<button class="btn btn-outline" onclick="App.showView(\'home\')">返回首页</button>' +
      '</div>';

    this.updateHomeStats();
    this.renderHomeSets();
  },

  backToSetup: function () {
    document.getElementById('session-summary').classList.add('hidden');
    document.getElementById('study-setup').classList.remove('hidden');
    Session.current = null;
  },

  exitSession: function () {
    /* 进度已保存于 localStorage，下次进入可恢复 */
    this.showConfirm('退出训练？进度已自动保存，下次可继续。', function () {
      App.backToSetup();
      App.showView('home');
    });
  },

  /* ---------- 词库浏览 ---------- */
  currentSet: 'day1',

  filterSet: function (setId) {
    this.currentSet = setId;
    var tabs = document.querySelectorAll('.set-tab');
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-set') === setId); });
    this.renderBrowseList();
  },

  renderBrowseList: function () {
    var search = (document.getElementById('browse-search').value || '').toLowerCase();
    var filter = document.getElementById('browse-filter').value;
    var states = Store.getStates();
    var words = Words.bySet(this.currentSet);

    var html = '';
    words.forEach(function (w) {
      var st = Skills.overallState(states, w.id);
      var isDue = Skills.isDue(states, w.id);

      /* 过滤 */
      if (filter === 'unlearned' && st !== '未学习') return;
      if (filter === 'learning' && st !== '初识' && st !== '练习中' && st !== '需加强') return;
      if (filter === 'mastered' && st !== '基本掌握' && st !== '稳定掌握') return;
      if (search && w.lemma.toLowerCase().indexOf(search) === -1 &&
          w.meanings.toLowerCase().indexOf(search) === -1) return;

      var stClass = { '未学习': 'st-unlearned', '初识': 'st-learning', '练习中': 'st-learning',
        '需加强': 'st-due', '基本掌握': 'st-mastered', '稳定掌握': 'st-mastered' }[st] || 'st-unlearned';
      var stLabel = isDue ? '待复习' : st;

      html += '<div class="word-card" data-speak-word="' + App.esc(w.lemma) + '">' +
        '<div class="word-status ' + stClass + '">' + stLabel + '</div>' +
        '<div class="word-card-head">' +
        '<span class="word-index">' + w.index + '</span>' +
        '<span class="word-lemma">' + App.esc(w.lemma) + '</span>' +
        (w.pron ? '<span class="word-pron">' + App.esc(w.pron) + '</span>' : '') +
        '<span class="word-pos">' + App.esc(w.pos) + '</span>' +
        '</div>' +
        '<div class="word-meaning">' + App.esc(w.meanings) + '</div>' +
        '</div>';
    });

    if (!html) html = '<div style="text-align:center;color:var(--ink-lighter);padding:40px">没有匹配的词条</div>';
    document.getElementById('word-list').innerHTML = html;
    document.getElementById('word-list').querySelectorAll('[data-speak-word]').forEach(function (el) {
      el.addEventListener('click', function () { App.speakWord(el.getAttribute('data-speak-word')); });
    });
  },

  /* ---------- 复习计划 ---------- */
  renderReview: function () {
    var states = Store.getStates();
    var all = Words.all();
    var dueNow = 0, dueSoon = 0, learned = 0;
    var evidenceIds = {};
    Store.getAttempts().forEach(function (a) { evidenceIds[a.wordId] = true; });

    all.forEach(function (w) {
      var st = Skills.overallState(states, w.id);
      if (evidenceIds[w.id]) learned++;
      if (Skills.isDue(states, w.id)) dueNow++;
      else {
        /* 24小时内到期 */
        var ws = states[w.id];
        if (ws) {
          for (var sk in ws) {
            if (ws[sk] && ws[sk].dueAt && ws[sk].dueAt > Date.now() &&
                ws[sk].dueAt < Date.now() + 86400000) { dueSoon++; break; }
          }
        }
      }
    });

    document.getElementById('review-summary').innerHTML =
      '<div class="review-stat"><div class="stat-num">' + dueNow + '</div><div class="stat-label">现在到期</div></div>' +
      '<div class="review-stat"><div class="stat-num">' + dueSoon + '</div><div class="stat-label">24小时内</div></div>' +
      '<div class="review-stat"><div class="stat-num">' + learned + '</div><div class="stat-label">有训练记录</div></div>' +
      '<div class="review-stat"><div class="stat-num">' + (all.length - learned) + '</div><div class="stat-label">未学习</div></div>';

    /* 到期词列表 */
    var dueWords = all.filter(function (w) { return Skills.isDue(states, w.id); });
    var html = '';
    dueWords.slice(0, 50).forEach(function (w) {
      html += '<div class="word-card">' +
        '<div class="word-card-head">' +
        '<span class="word-index">' + App.esc(w.setName) + '</span>' +
        '<span class="word-lemma">' + App.esc(w.lemma) + '</span>' +
        '<span class="word-pos">' + App.esc(w.pos) + '</span>' +
        '</div>' +
        '<div class="word-meaning">' + App.esc(w.meanings) + '</div>' +
        '</div>';
    });
    if (!html) html = '<div style="text-align:center;color:var(--ink-lighter);padding:40px">当前没有到期复习词。完成训练后，系统会按间隔自动安排复习。</div>';
    document.getElementById('due-list').innerHTML = html;
  },

  /* ---------- 家长报告 ---------- */
  renderParentReport: function () {
    var states = Store.getStates();
    var attempts = Store.getAttempts();
    var all = Words.all();

    /* 统计各技能表现 */
    var skillStats = {};
    Skills.list.forEach(function (sk) {
      skillStats[sk] = { total: 0, correct: 0, hint: 0, wrong: 0 };
    });
    attempts.forEach(function (a) {
      if (skillStats[a.skill]) {
        if ((a.outcome === 'correct' && !a.isGuess) || a.outcome === 'wrong') skillStats[a.skill].total++;
        if (a.outcome === 'correct' && !a.isGuess) skillStats[a.skill].correct++;
        else if (a.outcome === 'hint') skillStats[a.skill].hint++;
      }
    });

    /* 掌握分布 */
    var dist = { '未学习': 0, '初识': 0, '练习中': 0, '需加强': 0, '基本掌握': 0, '稳定掌握': 0 };
    all.forEach(function (w) {
      var st = Skills.overallState(states, w.id);
      dist[st]++;
    });

    /* 高频错因（§11） */
    var errorCodes = {};
    attempts.forEach(function (a) {
      if (a.outcome !== 'correct') {
        errorCodes[a.skill] = (errorCodes[a.skill] || 0) + 1;
      }
    });

    /* 薄弱词（需加强） */
    var weakWords = all.filter(function (w) {
      return Skills.overallState(states, w.id) === '需加强';
    });

    var html = '';

    /* 完成情况 */
    html += '<div class="report-section"><h3>完成情况</h3>' +
      '<table class="report-table"><tr><th>指标</th><th>数值</th></tr>' +
      '<tr><td>总词条数</td><td>' + all.length + '</td></tr>' +
      '<tr><td>有训练记录</td><td>' + Object.keys(attempts.reduce(function (acc, a) { acc[a.wordId] = true; return acc; }, {})).length + '</td></tr>' +
      '<tr><td>基本掌握 + 稳定掌握</td><td>' + (dist['基本掌握'] + dist['稳定掌握']) + '</td></tr>' +
      '<tr><td>需加强（重复错误）</td><td>' + dist['需加强'] + '</td></tr>' +
      '<tr><td>最近保留的答题记录（最多 5000）</td><td>' + attempts.length + '</td></tr>' +
      '</table></div>';

    /* 技能表现 */
    html += '<div class="report-section"><h3>各技能独立正确率</h3>' +
      '<table class="report-table"><tr><th>技能</th><th>独立作答数</th><th>独立正确</th><th>提示后正确</th><th>猜测正确</th><th>主动求助</th><th>正确率</th><th>评估</th></tr>';
    Skills.list.forEach(function (sk) {
      var s = skillStats[sk];
      var guesses = attempts.filter(function (a) { return a.skill === sk && a.outcome === 'guess'; }).length;
      var idkCount = attempts.filter(function (a) { return a.skill === sk && a.outcome === 'idk'; }).length;
      var hints = attempts.filter(function (a) { return a.skill === sk && a.outcome === 'hint'; }).length;
      var rate = s.total ? Math.round(s.correct / s.total * 100) : 0;
      var tag = 'none';
      if (s.total >= 3) tag = rate >= 70 ? 'good' : (rate >= 50 ? 'mid' : 'low');
      html += '<tr><td>' + Skills.labels[sk] + '</td><td>' + s.total + '</td><td>' + s.correct +
        '</td><td>' + hints + '</td><td>' + guesses + '</td><td>' + idkCount + '</td><td>' + rate + '%</td>' +
        '<td><span class="skill-tag ' + tag + '">' +
        (s.total === 0 ? '暂无数据' : (rate >= 70 ? '表现良好' : (rate >= 50 ? '需多练习' : '薄弱环节')) ) +
        '</span></td></tr>';
    });
    html += '</table>' +
      '<p style="font-size:0.8rem;color:var(--ink-lighter);margin-top:8px">注：答题明细仅保留最近 5000 条；正确率分母仅含独立作答的对/错，不含猜测、提示或主动求助。</p></div>';

    /* 薄弱词 */
    html += '<div class="report-section"><h3>需优先关注的词（' + weakWords.length + '个）</h3>';
    if (weakWords.length === 0) {
      html += '<p style="color:var(--ink-lighter)">暂无，保持当前节奏即可。</p>';
    } else {
      html += '<table class="report-table"><tr><th>词</th><th>词性</th><th>释义</th></tr>';
      weakWords.slice(0, 20).forEach(function (w) {
        html += '<tr><td><b>' + App.esc(w.lemma) + '</b></td><td>' + App.esc(w.pos) + '</td><td>' + App.esc(w.meanings) + '</td></tr>';
      });
      html += '</table>';
      if (weakWords.length > 20) html += '<p style="font-size:0.85rem;color:var(--ink-lighter)">仅显示前 20 个</p>';
    }
    html += '</div>';

    /* 报告说明（§17：描述行为证据，不做人格推断） */
    html += '<div class="report-section"><h3>报告说明</h3>' +
      '<p style="font-size:0.9rem;color:var(--ink-light)">本报告基于系统自动记录的答题证据生成，包括正确性、提示使用和答题时长。' +
      '短期正确率不等于长期掌握，建议以延迟保持率（间隔后复测的正确率）为主要观察指标。' +
      '报告不评价学习态度或人格特征，仅呈现可核查的学习行为数据。</p></div>';

    document.getElementById('parent-report').innerHTML = html;
  },

  /* ---------- 纸质巩固包（§12.1 / §21.3） ---------- */
  exportPaperPack: function () {
    var states = Store.getStates();
    var all = Words.all();

    /* 选出需巩固的词：需加强优先，然后是练习中 */
    var weak = all.filter(function (w) { return Skills.overallState(states, w.id) === '需加强'; });
    var practicing = all.filter(function (w) { return Skills.overallState(states, w.id) === '练习中'; });
    var selected = weak.concat(practicing).slice(0, 40);

    if (selected.length === 0) {
      selected = all.slice(0, 30);
      this.toast('暂无薄弱词，已导出前 30 个词作为巩固材料');
    }

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>住校巩固包</title><style>' +
      'body{font-family:"SimSun","Georgia",serif;max-width:700px;margin:0 auto;padding:40px;color:#1a1a1a;line-height:1.8}' +
      'h1{font-size:1.5rem;border-bottom:2px solid #1a1a1a;padding-bottom:10px}' +
      'h2{font-size:1.1rem;margin-top:30px}' +
      'ol{padding-left:24px}li{margin-bottom:8px}' +
      '.answer-page{page-break-before:always}' +
      '.blank{display:inline-block;min-width:120px;border-bottom:1px solid #999}' +
      '@media print{body{padding:10px}}' +
      '</style></head><body>';

    html += '<h1>住校期间英语巩固材料</h1>';
    html += '<p>生成时间：' + new Date().toLocaleString('zh-CN') + '</p>';
    html += '<p>说明：住校期间可选完成，不把未完成视为失败。回家后先做短测，按真实表现重新安排。</p>';

    /* 第一部分：英→中回忆 */
    html += '<h2>第一部分：看英文写中文（共' + selected.length + '题）</h2><ol>';
    selected.forEach(function (w) {
      html += '<li>' + App.esc(w.lemma) + ' (' + App.esc(w.pos) + ') <span class="blank"></span></li>';
    });
    html += '</ol>';

    /* 第二部分：中→英拼写 */
    html += '<h2>第二部分：看中文拼英文（共' + Math.min(selected.length, 20) + '题）</h2><ol>';
    selected.slice(0, 20).forEach(function (w) {
      html += '<li>' + App.esc(w.meanings.split('；')[0]) + ' <span class="blank"></span></li>';
    });
    html += '</ol>';

    /* 答案页 */
    html += '<div class="answer-page"><h1>答案页（请家长保管）</h1>';
    html += '<h2>第一部分答案</h2><ol>';
    selected.forEach(function (w) {
      html += '<li>' + App.esc(w.lemma) + ' — ' + App.esc(w.meanings.split('；').slice(0, 3).join('；')) + '</li>';
    });
    html += '</ol><h2>第二部分答案</h2><ol>';
    selected.slice(0, 20).forEach(function (w) {
      html += '<li>' + App.esc(w.meanings.split('；')[0]) + ' — ' + App.esc(w.lemma) + '</li>';
    });
    html += '</ol></div></body></html>';

    /* 下载 */
    this.downloadFile(html, '住校巩固包_' + Date.now() + '.html', 'text/html');
    this.toast('巩固包已导出，可用浏览器打开后打印');
  },

  /* ---------- 词库管理 ---------- */
  renderManageList: function () {
    var states = Store.getStates();
    var html = '';
    Words.data.sets.forEach(function (set) {
      html += '<h3 style="font-family:var(--serif);margin:16px 0 10px">' + App.esc(set.name) + '（' + set.words.length + '词）</h3>';
      set.words.forEach(function (w, i) {
        var wordId = w.id || (set.id + '_' + (i + 1));
        html += '<div class="word-card">' +
          '<div class="word-card-head">' +
          '<span class="word-index">' + (i + 1) + '</span>' +
          '<span class="word-lemma">' + App.esc(w.lemma) + '</span>' +
          '<span class="word-pos">' + App.esc(w.pos) + '</span>' +
          '</div>' +
          '<div class="word-meaning">' + App.esc(w.meanings) + '</div>' +
          '<button class="word-edit-btn" data-edit-word="' + App.esc(wordId) + '">编辑</button>' +
          '<button class="word-edit-btn" style="right:60px" data-delete-word="' + App.esc(wordId) + '">删除</button>' +
          '</div>';
      });
    });
    document.getElementById('manage-list').innerHTML = html;
    document.getElementById('manage-list').querySelectorAll('[data-edit-word]').forEach(function (el) {
      el.addEventListener('click', function () { App.editWord(el.getAttribute('data-edit-word')); });
    });
    document.getElementById('manage-list').querySelectorAll('[data-delete-word]').forEach(function (el) {
      el.addEventListener('click', function () { App.deleteWord(el.getAttribute('data-delete-word')); });
    });
  },

  showAddWord: function () {
    document.getElementById('edit-form').classList.remove('hidden');
    document.getElementById('edit-form-title').textContent = '添加词条';
    document.getElementById('edit-word-id').value = '';
    document.getElementById('edit-lemma').value = '';
    document.getElementById('edit-pron').value = '';
    document.getElementById('edit-pos').value = '';
    document.getElementById('edit-meanings').value = '';
  },

  editWord: function (wordId) {
    var w = Words.byId(wordId);
    if (!w) return;
    document.getElementById('edit-form').classList.remove('hidden');
    document.getElementById('edit-form-title').textContent = '编辑词条';
    document.getElementById('edit-word-id').value = wordId;
    document.getElementById('edit-lemma').value = w.lemma;
    document.getElementById('edit-pron').value = w.pron;
    document.getElementById('edit-pos').value = w.pos;
    document.getElementById('edit-meanings').value = w.meanings;
    document.getElementById('edit-set').value = w.setId;
    document.getElementById('edit-form').scrollIntoView({ behavior: 'smooth' });
  },

  saveWord: function () {
    var lemma = document.getElementById('edit-lemma').value.trim();
    var meanings = document.getElementById('edit-meanings').value.trim();
    if (!lemma || !meanings) { this.toast('单词和释义不能为空'); return; }

    var wordId = document.getElementById('edit-word-id').value;
    var fields = {
      lemma: lemma,
      pron: document.getElementById('edit-pron').value.trim(),
      pos: document.getElementById('edit-pos').value.trim() || 'n.',
      meanings: meanings
    };

    if (wordId) {
      if (!Words.update(wordId, fields)) return;
      this.toast('词条已更新');
    } else {
      var setId = document.getElementById('edit-set').value;
      if (!Words.add(fields, setId)) return;
      this.toast('词条已添加');
    }
    this.hideEditForm();
    this.renderManageList();
    this.renderBrowseList();
    this.updateHomeStats();
  },

  deleteWord: function (wordId) {
    var self = this;
    this.showConfirm('确认删除这个词条？', function () {
      Words.remove(wordId);
      self.renderManageList();
      self.renderBrowseList();
      self.updateHomeStats();
      self.toast('已删除');
    });
  },

  hideEditForm: function () {
    document.getElementById('edit-form').classList.add('hidden');
  },

  importCSV: function (input) {
    var self = this;
    var file = input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result;
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      var rows = [];
      var headers = self.parseCSVLine((lines[0] || '').replace(/^\uFEFF/, '')).map(function (h) { return h.toLowerCase(); });
      var hasHeader = headers.indexOf('lemma') >= 0;
      var col = function (name, fallback) { var n = headers.indexOf(name); return n >= 0 ? n : fallback; };
      /* 解析CSV（支持带引号字段） */
      lines.forEach(function (line, i) {
        if (i === 0 && hasHeader) return;
        var fields = self.parseCSVLine(line);
        if (fields.length >= 2) {
          rows.push({ lemma: fields[col('lemma', 0)] || '', pron: fields[col('pron', 1)] || '',
            pos: fields[col('pos', 2)] || '', meanings: fields[col('meanings', 3)] || '',
            setId: fields[col('set', -1)] || '' });
        }
      });
      if (rows.length === 0) { self.toast('未解析到有效数据'); return; }
      var sets = Words.data.sets;
      var seen = {};
      var add = 0, duplicate = 0, invalidSet = 0, missing = 0;
      rows.forEach(function (row) {
        var dest = sets.find(function (s) { return s.id === row.setId || s.name === row.setId; }) || (!row.setId ? sets[0] : null);
        if (!row.lemma.trim() || !row.meanings.trim()) { missing++; return; }
        if (!dest) { invalidSet++; return; }
        var key = dest.id + '|' + row.lemma.trim().toLowerCase() + '|' + (row.pos || 'n.').trim().toLowerCase();
        var exists = dest.words.some(function (w) { return w.lemma.toLowerCase() === row.lemma.trim().toLowerCase() && (w.pos || '').toLowerCase() === (row.pos || 'n.').trim().toLowerCase(); });
        if (exists || seen[key]) duplicate++;
        else { seen[key] = true; row.setId = dest.id; add++; }
      });
      self.showConfirm('导入预览：新增 ' + add + ' 条，重复跳过 ' + duplicate + ' 条，缺少必填字段 ' + missing + ' 条，词库无效 ' + invalidSet + ' 条。继续导入？', function () {
        var count = Words.importCSV(rows, sets[0].id);
        self.toast('已导入 ' + count + ' 条');
        self.renderManageList(); self.renderBrowseList(); self.updateHomeStats();
      });
    };
    reader.readAsText(file, 'UTF-8');
    input.value = '';
  },

  parseCSVLine: function (line) {
    var out = [];
    var cur = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  },

  exportCSV: function () {
    var csv = Words.exportCSV();
    /* BOM for Excel */
    this.downloadFile('\ufeff' + csv, '词库导出_' + Date.now() + '.csv', 'text/csv');
    this.toast('CSV 已导出');
  },

  /* ---------- 设置 ---------- */
  applySettings: function () {
    var s = Store.getSettings();
    document.getElementById('cfg-newlimit').value = s.newLimit;
    document.getElementById('cfg-rate').value = s.speechRate;
  },

  saveSetting: function (key, value) {
    var s = Store.getSettings();
    s[key] = value;
    if (Store.saveSettings(s)) this.toast('设置已保存');
  },

  /* ---------- 云同步（手机/PC 学习记录同步） ---------- */
  applySyncConfigToUI: function () {
    var c = Sync.getConfig();
    var elE = document.getElementById('sync-enabled');
    if (!elE) return;
    elE.checked = c.enabled;
    document.getElementById('sync-user').value = c.user || 'wphuihappy-pixel';
    document.getElementById('sync-repo').value = c.repo || 'taotao-english-data';
    document.getElementById('sync-token').value = c.token;
    Sync.updateStatusUI();
  },

  saveSyncConfig: function () {
    var c = {
      enabled: document.getElementById('sync-enabled').checked,
      user: document.getElementById('sync-user').value,
      repo: document.getElementById('sync-repo').value,
      token: document.getElementById('sync-token').value,
      lastSyncAt: Sync.getConfig().lastSyncAt,
      lastStatus: Sync.getConfig().lastStatus
    };
    if (c.enabled && (!c.user || !c.token || !c.repo)) {
      this.toast('启用同步需要填写 GitHub 用户名、仓库名和访问令牌');
      return;
    }
    Sync.saveConfig(c);
    Sync.startAutoSync();
    Sync.updateStatusUI();
    this.toast('云同步配置已保存' + (c.enabled ? '，稍后自动同步' : ''));
  },

  syncNow: function () {
    Sync.syncNow('manual');
  },

  /* ---------- 数据管理 ---------- */
  exportData: function (format) {
    var data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      words: Store.getWords(),
      states: Store.getStates(),
      attempts: Store.getAttempts(),
      settings: Store.getSettings()
    };
    if (format === 'csv') {
      var attempts = data.attempts;
      var csv = 'wordId,skill,type,outcome,latency,isGuess,timestamp\n';
      attempts.forEach(function (a) {
        csv += [a.wordId, a.skill, a.type, a.outcome, a.latency, a.isGuess, new Date(a.ts).toISOString()].join(',') + '\n';
      });
      this.downloadFile('\ufeff' + csv, '学习记录_' + Date.now() + '.csv', 'text/csv');
    } else {
      this.downloadFile(JSON.stringify(data, null, 2), '淘淘英语学习_备份_' + Date.now() + '.json', 'application/json');
    }
    this.toast('数据已导出');
  },

  importData: function (input) {
    var self = this;
    var file = input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = JSON.parse(e.target.result);
        if (!Store.importBackup(data)) { self.toast('备份结构或版本不受支持，现有数据未更改'); return; }
        self.toast('数据已恢复');
        location.reload();
      } catch (err) {
        self.toast('文件格式错误，现有数据未更改');
      }
    };
    reader.readAsText(file);
    input.value = '';
  },

  confirmReset: function () {
    var self = this;
    this.showConfirm('确认清空全部学习记录？此操作不可恢复，建议先导出备份。', function () {
      Store.remove(Store.KEYS.states);
      Store.remove(Store.KEYS.attempts);
      Store.remove(Store.KEYS.session);
      self.toast('学习记录已清空');
      location.reload();
    });
  },

  /* ---------- 工具 ---------- */
  downloadFile: function (content, filename, mime) {
    var blob = new Blob([content], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  },

  toastTimer: null,
  toast: function (msg) {
    var el = document.getElementById('toast');
    if (!el) { console.warn(msg); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2500);
  },

  confirmCallback: null,
  showConfirm: function (text, callback) {
    document.getElementById('confirm-text').textContent = text;
    document.getElementById('confirm-modal').classList.remove('hidden');
    this.confirmCallback = callback;
    var yes = document.getElementById('confirm-yes');
    var newYes = yes.cloneNode(true);
    yes.parentNode.replaceChild(newYes, yes);
    newYes.onclick = function () {
      document.getElementById('confirm-modal').classList.add('hidden');
      if (App.confirmCallback) App.confirmCallback();
    };
  },

  closeConfirm: function () {
    document.getElementById('confirm-modal').classList.add('hidden');
  }
};

/* 暴露到全局 */
window.App = App;
window.Store = Store;
window.Words = Words;
window.Skills = Skills;
window.Quiz = Quiz;
window.Session = Session;
window.TTS = TTS;
window.Sync = Sync;

/* 启动 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { App.init(); });
} else {
  App.init();
}

})();
