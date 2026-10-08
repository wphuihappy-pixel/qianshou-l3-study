/**
 * ECContent · 真实内容管线
 * 双通道（用户确认）：① curator.py 采集包 JSON 导入 ② 手动粘贴
 * 版权原则：不存全文——只存标题/来源/URL/摘录（前1200字符）+ AI 生成的学习材料
 * 内置 3 篇原创种子短文（标 seed），保证 Day1 无外部内容也能完整跑通学习闭环
 */
(function () {
  'use strict';
  if (window.ECContent) return;

  var EXCERPT_MAX = 1200;

  /* ---------- 难度粗估（本地、可解释、不冒充 CEFR 权威） ---------- */
  function estimateDifficulty(text) {
    var t = String(text || '');
    if (t.length < 50) return { score: 1, label: '短文本（粗估）', note: '本地词长句长粗估，非 CEFR 权威定级' };
    var sentences = t.split(/[.!?]+/).filter(function (s) { return s.trim().length > 0; });
    var words = t.toLowerCase().match(/[a-z']+/g) || [];
    if (!words.length) return { score: 1, label: '无法估', note: '未识别到英文单词' };
    var avgLen = words.reduce(function (a, w) { return a + w.length; }, 0) / words.length;
    var avgSent = words.length / Math.max(1, sentences.length);
    var score = 1;
    if (avgLen > 5.0 || avgSent > 18) score = 3;
    else if (avgLen > 4.4 || avgSent > 13) score = 2;
    return {
      score: score,
      label: ['简单（粗估A1-A2）', '中等（粗估A2-B1）', '较难（粗估B1-B2）'][score - 1],
      avgWordLen: +avgLen.toFixed(1), avgSentenceLen: Math.round(avgSent), wordCount: words.length
    };
  }

  function makeItem(o) {
    var text = String(o.text || '');
    return {
      id: EDB.uid(),
      title: String(o.title || '未命名内容').slice(0, 160),
      source: String(o.source || '').slice(0, 120),
      url: String(o.url || '').slice(0, 500),
      published: o.published || '',
      excerpt: text.slice(0, EXCERPT_MAX),
      tags: Array.isArray(o.tags) ? o.tags.slice(0, 8) : [],
      status: 'raw',            /* raw → processed */
      seed: !!o.seed,
      difficulty: o.difficulty || null,
      material: null,           /* 加工后：level1/keyPoints/vocab/questions/listeningScript */
      created_at: EDB.nowIso()
    };
  }

  /* ---------- 导入：curator.py 内容包 ---------- */
  function importPack(jsonText) {
    var pack;
    try { pack = JSON.parse(jsonText); } catch (e) {
      return Promise.reject(new Error('不是合法 JSON 文件'));
    }
    var items = pack && Array.isArray(pack.items) ? pack.items : (Array.isArray(pack) ? pack : null);
    if (!items) return Promise.reject(new Error('内容包缺少 items 数组（应为 curator.py 输出格式）'));
    var valid = items.filter(function (it) {
      return it && (it.title || it.text);
    }).map(function (it) {
      var item = makeItem(it);
      if (!item.difficulty) item.difficulty = estimateDifficulty(item.excerpt);
      return item;
    });
    if (!valid.length) return Promise.reject(new Error('内容包里没有可用条目（需要 title 或 text）'));
    return EDB.putAll('content', valid).then(function () { return { imported: valid.length }; });
  }

  /* ---------- 导入：手动粘贴 ---------- */
  function importPaste(title, url, text, source) {
    if (!text || !text.trim()) return Promise.reject(new Error('请粘贴正文内容'));
    var item = makeItem({
      title: title || String(text).trim().split('\n')[0].slice(0, 80) || '粘贴的内容',
      url: url || '', text: text, source: source || '手动粘贴',
      tags: ['paste']
    });
    item.difficulty = estimateDifficulty(item.excerpt);
    return EDB.put('content', item).then(function () { return item; });
  }

  /* ---------- 加工：English Tutor 生成学习材料 ---------- */
  function process(id, digestText) {
    return EDB.get('content', id).then(function (item) {
      if (!item) throw new Error('内容不存在');
      if (item.status === 'processed') return item;
      /* 加工用"完整可用文本"：导入时的 excerpt（版权：仅此节选送 AI 加工，不存全文） */
      return ECA.processContent({ title: item.title, source: item.source, text: item.excerpt }, digestText)
        .then(function (material) {
          item.material = {
            level1: material.level1,
            keyPoints: material.keyPoints || [],
            vocab: (material.vocab || []).map(function (v) {
              return {
                word: v.word, cls: v.cls, meaning: v.meaning, pos: v.pos,
                example: v.example, related: v.related || [], aiGenerated: true
              };
            }),
            questions: material.questions || [],
            listeningScript: material.listeningScript || material.level1,
            aiGenerated: true
          };
          item.status = 'processed';
          item.processed_at = EDB.nowIso();
          return EDB.put('content', item).then(function () { return item; });
        });
    });
  }

  /* ---------- 列表查询 ---------- */
  function listContent(status) {
    return EDB.getAll('content').then(function (rows) {
      return rows.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); })
        .filter(function (c) { return !status || c.status === status; });
    });
  }
  function pickUnread() {
    return EDB.getAll('reading').then(function (readRows) {
      var readIds = {};
      readRows.forEach(function (r) { readIds[r.contentId] = true; });
      return EDB.getAll('content').then(function (rows) {
        var processed = rows.filter(function (c) { return c.status === 'processed' && !readIds[c.id]; });
        if (processed.length) return processed[0];
        /* 无未读则重读最早一篇（真实内容值得读两遍） */
        var any = rows.filter(function (c) { return c.status === 'processed'; });
        return any.length ? any[any.length - 1] : null;
      });
    });
  }

  /* ---------- 阅读完成记录（查词密度 → 隐式评估信号） ---------- */
  function logReading(contentId, level, lookupCount, durationMin) {
    var row = {
      id: EDB.uid(), contentId: contentId, date: EDB.dayKey(), level: level,
      lookupCount: lookupCount, durationMin: durationMin || 0, created_at: EDB.nowIso()
    };
    return EDB.put('reading', row).then(function () { return row; });
  }

  /* ---------- 词汇入库（A 类词进语言资产库） ---------- */
  function addVocab(v, sourceInfo) {
    var word = String(v.word || '').trim().toLowerCase();
    if (!word) return Promise.reject(new Error('空词条'));
    return EDB.byIndex('vocabulary', 'byWord', word).then(function (rows) {
      if (rows && rows.length) return rows[0];   /* 已存在：不重复建 */
      var item = {
        id: EDB.uid(), word: word,
        meaning: v.meaning || '', part_of_speech: v.pos || '', pronunciation: v.pron || '',
        example: v.example || '',
        source: { contentId: (sourceInfo && sourceInfo.contentId) || null, url: (sourceInfo && sourceInfo.url) || '', context: (sourceInfo && sourceInfo.context) || '' },
        my_sentence: '', my_errors: [],
        mastery: 1, mastery_evidence: [{ level: 1, evidence: 'first_seen', when: EDB.nowIso() }],
        last_seen: EDB.nowIso(),
        next_review: EDB.dayKey(),
        related_phrases: v.related || [], collocations: [],
        tags: ['A_class'].concat(sourceInfo && sourceInfo.seed ? ['seed'] : []),
        review_count: 0, created_at: EDB.nowIso(), updated_at: EDB.nowIso()
      };
      return EDB.put('vocabulary', item).then(function () {
        /* 新词进入复习队列（当天） */
        return ECR.create(item.id, 'vocabulary', item.word).then(function () { return item; });
      });
    });
  }

  /* ---------- 内置种子内容（原创，Day1 即可学习） ---------- */
  var SEEDS = [
    {
      title: 'What is an AI Agent?',
      source: '内置种子 · 原创示例',
      tags: ['seed', 'ai', 'agent'],
      text: 'An AI agent is a program that can do tasks for you. It does not just answer questions. It can plan, use tools, and check its own work.\n\nFor example, you can ask an agent to plan a trip. The agent will search for flights, compare prices, and give you a plan. You do not need to do each step yourself.\n\nA chatbot only talks. An agent acts. This is the big difference. Agents can read files, search the web, write code, and send messages.\n\nMany people think agents will change how we work. Small teams can now do more with less time. But agents still make mistakes, so people must check the results.\n\nIn the future, you may have a team of agents. One writes, one checks, one sends emails. You become the manager.'
    },
    {
      title: 'Why Small Teams Love AI',
      source: '内置种子 · 原创示例',
      tags: ['seed', 'ai', 'startup'],
      text: 'Ten years ago, a small company could not build smart software. They needed a big team and a lot of money. Today, AI changes this.\n\nA team of three people can now write code with AI help. They can test ideas in days, not months. If an idea fails, they lose less.\n\nAI also helps with daily work. It writes first drafts, summarizes long documents, and answers simple emails. People save hours every week.\n\nBut AI is not magic. The team still needs clear goals. AI works best when people ask good questions and check the answers.\n\nSo the new skill is not only coding. It is knowing what to build and how to ask. Small teams that learn this can move very fast.'
    },
    {
      title: 'How to Read a GitHub README',
      source: '内置种子 · 原创示例',
      tags: ['seed', 'github', 'developer'],
      text: 'When you open a GitHub project, the first page is the README. It is the front door of the project. Reading it well saves you time.\n\nMost README files have the same parts. First, the project name and a short line: what is this and why does it exist? Second, a quick start: how to install and run it in a few commands. Third, examples of how to use it.\n\nSome README files also have a "Requirements" part. Check it first. If your system is too old, nothing will work.\n\nIf you want to use the code in your company, look for the "License" part. No license means you should ask first.\n\nIf you get an error, do not give up. Search the "Issues" page. Other people often had the same problem. Reading English issues is slow at first, but it gets faster every week.'
    }
  ];

  function seedIfNeeded() {
    return EDB.getAll('content').then(function (rows) {
      var hasSeed = rows.some(function (c) { return c.seed; });
      if (hasSeed) return 0;
      var items = SEEDS.map(function (s) {
        var item = makeItem(s);
        item.seed = true;
        item.difficulty = estimateDifficulty(item.excerpt);
        return item;
      });
      return EDB.putAll('content', items).then(function () { return items.length; });
    });
  }

  window.ECContent = {
    importPack: importPack, importPaste: importPaste,
    process: process, listContent: listContent, pickUnread: pickUnread,
    logReading: logReading, addVocab: addVocab,
    estimateDifficulty: estimateDifficulty, seedIfNeeded: seedIfNeeded
  };
})();
