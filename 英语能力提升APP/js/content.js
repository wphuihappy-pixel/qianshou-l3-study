/**
 * ECContent · 真实内容管线
 * 双通道（用户确认）：① curator.py 采集包 JSON 导入 ② 手动粘贴
 * 版权原则：不存全文——只存标题/来源/URL/摘录（前1200字符）+ AI 生成的学习材料
 * 内置 3 篇原创种子短文（标 seed）：学习材料随内容预置（非 AI 生成，诚实标注 aiGenerated:false），
 * 直接以 processed 状态入库——Day1 无外部内容、未配 AI 也能完整跑通学习闭环；
 * 早期版本入库的 raw 种子会在下次打开时自动迁移（补预置材料 + 置 processed）
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
  /* 选一篇未读内容；targetScore（1/2/3，可选）= i+1 目标难度档：
     档内有货只在该档里选（踮脚够得着），缺货回退全部未读（不因缺货空转） */
  function pickUnread(targetScore) {
    return EDB.getAll('reading').then(function (readRows) {
      var readIds = {};
      readRows.forEach(function (r) { readIds[r.contentId] = true; });
      return EDB.getAll('content').then(function (rows) {
        var processed = rows.filter(function (c) { return c.status === 'processed' && !readIds[c.id]; });
        var pool = processed;
        if (targetScore) {
          var hit = processed.filter(function (c) { return c.difficulty && c.difficulty.score === targetScore; });
          if (hit.length) pool = hit;
        }
        if (pool.length) return pool[0];
        /* 无未读则重读最早一篇（真实内容值得读两遍） */
        var any = rows.filter(function (c) { return c.status === 'processed'; });
        return any.length ? any[any.length - 1] : null;
      });
    });
  }

  /* ---------- i+1 选文：目标难度档（设计文档·第三章：目标难度 = 当前 Reading 维度 + 0.5） ----------
     reading 0-5 → 舒适档 1/2/3；目标档 = 舒适档 + 1（上限 3）；
     降档保护：最近一次阅读查词密度 > 8% → 目标降回舒适档（可解释，不硬踮） */
  function readingTargetScore(profile, lastReading, contents) {
    var r = (profile && profile.skills && profile.skills.reading) || 0;
    var comfy = r < 2.0 ? 1 : (r < 3.5 ? 2 : 3);
    var target = Math.min(3, comfy + 1);
    if (lastReading && Array.isArray(contents)) {
      var c = contents.filter(function (x) { return x.id === lastReading.contentId; })[0];
      var wc = c && c.difficulty && c.difficulty.wordCount;
      if (wc && (lastReading.lookupCount || 0) / wc > 0.08) {
        target = comfy;
      }
    }
    return target;
  }

  /* ---------- 复述/跟读相似度：词级重合率（0-1，本地规则，不冒充语义评分） ---------- */
  function retellOverlap(transcript, script) {
    var toks = function (s) {
      return String(s || '').toLowerCase().match(/[a-z']+/g) || [];
    };
    var a = toks(transcript), b = toks(script);
    if (!b.length) return 0;
    if (!a.length) return 0;
    var bSet = {};
    b.forEach(function (w) { bSet[w] = (bSet[w] || 0) + 1; });
    var hit = 0;
    a.forEach(function (w) { if (bSet[w] > 0) { hit++; bSet[w]--; } });
    return +(hit / b.length).toFixed(2);
  }

  /* ---------- 听力语速阶梯判定（设计文档：0.75→0.9→1.0→1.1x，复述准确率≥70% 升档） ----------
     复述词重合 ≥0.4（口语复述天然稀疏，阈值校准过）→ up；有转写但 <0.2 → down；其余 stay */
  function ladderStep(overlap) {
    if (overlap >= 0.4) return { dir: 'up', reason: '复述词重合 ' + overlap + '：语速升一档' };
    if (overlap < 0.2) return { dir: 'down', reason: '复述词重合 ' + overlap + '：语速降一档' };
    return { dir: 'stay', reason: '复述词重合 ' + overlap + '：维持当前语速档' };
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

  /* ---------- 种子学习材料（预置，非 AI 生成；按标题关联 SEEDS，与 AI 加工同构） ---------- */
  var SEED_MATERIAL = {
    'What is an AI Agent?': {
      level1: 'An AI agent is a program that does tasks for you. It does not just answer questions like a chatbot. An agent can plan the steps, use tools, and check its own work.\n\nFor example, you can ask an agent to plan a trip for you. The agent will search for flights, compare the prices, and give you a clear plan. You do not need to do each small step yourself. The agent does the work, and you make the final choice.\n\nHere is the big difference: a chatbot only talks, but an agent acts. An agent can read files, search the web, write code, and send messages for you.\n\nMany people think agents will change how we work. A small team can now do more work in less time. But agents still make mistakes, so people must check the results. Do not trust an agent 100 percent.\n\nIn the future, you may have a team of agents. One agent writes, one agent checks, and one agent sends emails. You do not do the small tasks anymore. You become the manager, and the agents work for you.',
      keyPoints: [
        'AI agent 是能替你做事的程序：会规划步骤、使用工具、检查自己的工作',
        '核心区别：chatbot 只会"说"，agent 会"做"',
        'agent 仍会犯错，人必须检查结果，不能 100% 信任',
        '未来你可能管理一个 agent 团队：你变成管理者，不是执行者'
      ],
      vocab: [
        { word: 'agent', cls: 'A', meaning: '智能体；能替你执行任务的 AI 程序', pos: 'n.', pron: '/ˈeɪdʒənt/', example: 'An AI agent can plan a trip for you.', related: ['AI agent', 'agent team', 'use an agent'] },
        { word: 'task', cls: 'A', meaning: '任务；要做的事情', pos: 'n.', pron: '/tæsk/', example: 'The agent does small tasks for me every day.', related: ['do a task', 'finish a task', 'daily tasks'] },
        { word: 'plan', cls: 'A', meaning: '计划；规划', pos: 'n./v.', pron: '/plæn/', example: 'The agent can plan the steps for you.', related: ['make a plan', 'plan a trip', 'business plan'] },
        { word: 'tool', cls: 'A', meaning: '工具', pos: 'n.', pron: '/tuːl/', example: 'Search and email are tools the agent can use.', related: ['use a tool', 'the right tool for the job'] },
        { word: 'check', cls: 'A', meaning: '检查；核对', pos: 'v.', pron: '/tʃek/', example: "People must check the agent's work.", related: ['check the results', 'double-check'] },
        { word: 'compare', cls: 'B', meaning: '比较', pos: 'v.', pron: '/kəmˈper/', example: 'The agent will compare the prices for you.', related: ['compare prices', 'compare with'] },
        { word: 'mistake', cls: 'A', meaning: '错误', pos: 'n.', pron: '/mɪˈsteɪk/', example: 'Agents still make mistakes sometimes.', related: ['make a mistake', 'learn from mistakes'] },
        { word: 'manage', cls: 'B', meaning: '管理', pos: 'v.', pron: '/ˈmænɪdʒ/', example: 'You manage a team of agents.', related: ['manage a team', 'manage time'] }
      ],
      questions: [
        'What is the big difference between a chatbot and an agent?',
        "Why must people check an agent's work?",
        'If you had a team of agents, what task would you give them first?'
      ],
      listeningScript: 'An AI agent is a program that does tasks for you. It does not just talk. It can plan the steps, use tools, and check its own work. A chatbot only talks, but an agent acts. This is the big difference. For example, you can ask an agent to plan a trip. The agent will search for flights. It will compare the prices. Then it will give you a clear plan. You do not need to do each small step yourself. But remember, agents still make mistakes. People must check the results. Do not trust an agent one hundred percent. In the future, you may have a team of agents. One writes. One checks. One sends emails. You become the manager.'
    },
    'Why Small Teams Love AI': {
      level1: 'Ten years ago, a small company could not build smart software. They needed a big team and a lot of money. Today, AI changes this.\n\nA team of three people can now write code with AI help. They can test new ideas in days, not months. If an idea fails, they lose less money and less time.\n\nAI also helps with daily work. It writes first drafts, summarizes long documents, and answers simple emails. People save hours every week. They can spend this time on more important work.\n\nBut AI is not magic. The team still needs clear goals. AI works best when people ask good questions and check the answers. If you do not know what you want, AI cannot help you.\n\nSo the new skill is not only coding. It is knowing what to build and how to ask. Small teams that learn this can move very fast.',
      keyPoints: [
        '十年前小公司做不了智能软件（缺人缺钱），AI 改变了这一点',
        '3 人团队借助 AI 写代码、几天内验证想法，失败损失更小',
        'AI 还能写初稿、总结长文档、回简单邮件，每周省数小时',
        'AI 不是魔法：需要清晰目标、好问题、人检查答案',
        '新技能不只是写代码，而是"知道做什么 + 会提问"'
      ],
      vocab: [
        { word: 'draft', cls: 'A', meaning: '草稿；初稿', pos: 'n.', pron: '/dræft/', example: 'AI writes the first draft, and you improve it.', related: ['first draft', 'draft an email', 'rough draft'] },
        { word: 'summarize', cls: 'A', meaning: '总结；概括', pos: 'v.', pron: '/ˈsʌməraɪz/', example: 'AI can summarize a long document in one minute.', related: ['summarize a document', 'to summarize'] },
        { word: 'goal', cls: 'A', meaning: '目标', pos: 'n.', pron: '/ɡoʊl/', example: 'The team still needs clear goals.', related: ['clear goals', 'set a goal', 'team goal'] },
        { word: 'skill', cls: 'A', meaning: '技能；本事', pos: 'n.', pron: '/skɪl/', example: 'The new skill is knowing what to build.', related: ['new skill', 'soft skill', 'skill set'] },
        { word: 'fail', cls: 'B', meaning: '失败；没做成', pos: 'v.', pron: '/feɪl/', example: 'If an idea fails, they lose less.', related: ['fail fast', 'fail an exam'] },
        { word: 'magic', cls: 'C', meaning: '魔法（文中是比喻：AI 不是万能的）', pos: 'n.', pron: '/ˈmædʒɪk/', example: 'But AI is not magic.', related: ['not magic'] }
      ],
      questions: [
        'How does AI help a small team test ideas faster?',
        'Why does a team still need clear goals when using AI?',
        'What daily work can AI do for you?'
      ],
      listeningScript: 'Ten years ago, a small company could not build smart software. They needed a big team and a lot of money. Today, AI changes this. A team of three people can write code with AI help. They can test new ideas in days, not months. AI also helps with daily work. It writes first drafts. It summarizes long documents. It answers simple emails. People save hours every week. But AI is not magic. The team still needs clear goals. AI works best when people ask good questions and check the answers. So the new skill is not only coding. It is knowing what to build and how to ask.'
    },
    'How to Read a GitHub README': {
      level1: 'When you open a GitHub project, the first page is the README. It is the front door of the project. Reading it well saves you a lot of time.\n\nMost README files have the same parts. First, the project name and one short line: What is this? Why does it exist? Second, a quick start: how to install it and run it in a few commands. Third, examples of how to use it.\n\nSome README files also have a "Requirements" part. Check it first. If your system is too old, nothing will work.\n\nIf you want to use the code in your company, look for the "License" part. No license means you should ask first, before you use it.\n\nIf you get an error, do not give up. Search the "Issues" page. Other people often had the same problem, and the answer is already there. Reading English issues is slow at first, but it gets faster every week.',
      keyPoints: [
        'README 是项目的"门面"（front door），读好它能省大量时间',
        '常见结构：项目名+一句话介绍 → Quick Start 安装运行 → 使用示例',
        '先看 Requirements：系统太老什么都跑不起来',
        '商用前必看 License：没有 license 要先问作者',
        '报错去 Issues 页搜：别人常已问过；读英文 issue 会越来越快'
      ],
      vocab: [
        { word: 'license', cls: 'A', meaning: '许可证（规定代码能不能商用）', pos: 'n.', pron: '/ˈlaɪsns/', example: 'Check the License part before you use the code.', related: ['open source license', 'under the MIT license', 'no license'] },
        { word: 'requirement', cls: 'A', meaning: '要求；必要条件', pos: 'n.', pron: '/rɪˈkwaɪərmənt/', example: 'Check the Requirements part first.', related: ['system requirements', 'meet the requirements'] },
        { word: 'install', cls: 'A', meaning: '安装', pos: 'v.', pron: '/ɪnˈstɔːl/', example: 'The quick start shows how to install and run it.', related: ['install and run', 'install a package'] },
        { word: 'issue', cls: 'A', meaning: '（GitHub 上的）问题；议题', pos: 'n.', pron: '/ˈɪʃuː/', example: 'Search the Issues page for the same error.', related: ['open an issue', 'search issues'] },
        { word: 'error', cls: 'A', meaning: '报错；错误', pos: 'n.', pron: '/ˈerər/', example: 'If you get an error, do not give up.', related: ['get an error', 'error message', 'fix an error'] },
        { word: 'command', cls: 'B', meaning: '命令', pos: 'n.', pron: '/kəˈmænd/', example: 'You can run it with a few commands.', related: ['run a command', 'command line'] },
        { word: 'give up', cls: 'C', meaning: '放弃（动词短语）', pos: 'phr.v.', pron: '/ɡɪv ʌp/', example: 'If you get an error, do not give up.', related: ['never give up'] }
      ],
      questions: [
        'What are the common parts of a README?',
        'Why should you check the License before using code at work?',
        'What do you do first when you get an error?'
      ],
      listeningScript: 'When you open a GitHub project, the first page is the README. It is the front door of the project. Most README files have the same parts. The project name and one short line. A quick start: how to install and run it. And some examples. Check the Requirements part first. If your system is too old, nothing will work. If you want to use the code in your company, look for the License part. No license means you should ask first. If you get an error, do not give up. Search the Issues page. Other people often had the same problem. Reading English issues is slow at first, but it gets faster every week.'
    }
  };

  function buildSeedMaterial(def) {
    var m = SEED_MATERIAL[(def && def.title)] || {};
    return {
      level1: m.level1 || '',
      keyPoints: m.keyPoints || [],
      vocab: (m.vocab || []).map(function (v) {
        return {
          word: v.word, cls: v.cls, meaning: v.meaning, pos: v.pos,
          pron: v.pron || '', example: v.example, related: v.related || [],
          aiGenerated: false
        };
      }),
      questions: m.questions || [],
      listeningScript: m.listeningScript || m.level1 || '',
      aiGenerated: false
    };
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
      var seeds = (rows || []).filter(function (c) { return c.seed; });
      if (!seeds.length) {
        /* 全新安装：种子直接以 processed 状态入库（学习材料已预置，无需 AI 加工） */
        var items = SEEDS.map(function (s) {
          var item = makeItem(s);
          item.seed = true;
          item.difficulty = estimateDifficulty(item.excerpt);
          item.material = buildSeedMaterial(s);
          item.status = 'processed';
          item.processed_at = EDB.nowIso();
          return item;
        });
        return EDB.putAll('content', items).then(function () { return items.length; });
      }
      /* 存量迁移：早期版本以 raw 入库、无材料的种子 → 补预置材料并置 processed */
      var legacy = seeds.filter(function (c) { return c.status === 'raw' && !c.material; });
      if (!legacy.length) return 0;
      var ups = legacy.map(function (c) {
        var def = SEEDS.filter(function (s) { return s.title === c.title; })[0];
        if (!def) return Promise.resolve(null);   /* 标题对不上的旧种子不动，仍可手动 AI 加工 */
        c.material = buildSeedMaterial(def);
        c.status = 'processed';
        c.processed_at = EDB.nowIso();
        return EDB.put('content', c);
      });
      return Promise.all(ups).then(function () { return legacy.length; });
    });
  }

  /* ---------- Day1 启动词包：词汇表为空时，把种子文章①的 A 类词入库并进入今日复习队列 ---------- */
  function seedStarterVocab() {
    return EDB.getAll('vocabulary').then(function (rows) {
      if (rows && rows.length) return 0;
      var aWords = buildSeedMaterial(SEEDS[0]).vocab.filter(function (v) { return v.cls === 'A'; }).slice(0, 6);
      var adds = aWords.map(function (v) {
        return addVocab(v, {
          contentId: null, url: '',
          context: 'Day1 启动词包（内置种子 · 《' + SEEDS[0].title + '》）',
          seed: true
        });
      });
      return Promise.all(adds).then(function () { return aWords.length; });
    });
  }

  /* ---------- 表达沉淀：对话 L2 纠错学到的自然说法 → 「我的表达」资产 + 复习队列 ----------
     设计依据：表达四档中“Understandable but unnatural”不当严重错误，
     应沉淀为要主动用起来的表达（复习形式：在新对话中主动使用），与“我的错误”分流 */
  function saveExpression(corr, scenario) {
    var text = String((corr && corr.finalCorrected) || '').trim();
    if (!text) return Promise.resolve(null);
    var row = {
      id: EDB.uid(), text: text.slice(0, 300),
      original: String((corr && corr.original) || '').slice(0, 300),
      scenario: String(scenario || 'conversation').slice(0, 120),
      meaning: text.slice(0, 120),          /* 复习卡 loadAnswer 读 meaning：直接显示表达本身 */
      example: '', source: 'conversation',
      mastery: 1, mastery_evidence: [{ level: 1, evidence: 'first_seen', when: EDB.nowIso() }],
      next_review: EDB.dayKey(), review_count: 0,
      created_at: EDB.nowIso()
    };
    return EDB.put('expressions', row).then(function () {
      return ECR.create(row.id, 'expression', text.slice(0, 60)).then(function () { return row; });
    });
  }

  /* ---------- 听力复述沉淀：5 遍法第 5 遍复述转写 → 听力难点资产 + 复习队列（重听+再复述） ---------- */
  function saveListeningRetell(contentId, title, transcript) {
    var tr = String(transcript || '').trim();
    if (!tr) return Promise.resolve(null);
    var row = {
      id: EDB.uid(), contentId: contentId || null, type: 'retell',
      title: String(title || '').slice(0, 120),
      transcript: tr.slice(0, 300),
      meaning: '重听《' + String(title || '').slice(0, 40) + '》一遍，再用自己的话复述（下面是你上次第 5 遍的复述记录）',
      example: tr.slice(0, 150),
      mastery: 1, next_review: EDB.dayKey(), review_count: 0,
      created_at: EDB.nowIso()
    };
    return EDB.put('listeningIssues', row).then(function () {
      return ECR.create(row.id, 'listening', (String(title || '') + ' · 复述').slice(0, 60)).then(function () { return row; });
    });
  }

  /* ---------- 发音难点沉淀：跟读后 ASR 可懂度低 → 入库进复习队列 ----------
     诚实边界：这不是音素评分，是“能不能被听懂”的可懂度代理（设计文档·第五章）；
     同一目标句 3 天内已记录过不重复建（防泛滥） */
  function savePronunciationIssue(label, targetText, transcript, score) {
    var target = String(targetText || '').trim();
    if (!target) return Promise.resolve(null);
    return EDB.getAll('pronunciationIssues').then(function (rows) {
      var recent = (rows || []).filter(function (r) {
        return r.target === target && (Date.now() - new Date(r.created_at).getTime()) < 3 * 86400000;
      });
      if (recent.length) return null;
      var row = {
        id: EDB.uid(), word: String(label || target.slice(0, 30)).slice(0, 60),
        target: target.slice(0, 200), transcript: String(transcript || '').slice(0, 200),
        note: '跟读后 ASR 可懂度低（词重合 ' + score + '，阈值 0.55）——可懂度代理，非音素评分',
        meaning: '跟读这句话，点“跟读验证”看 ASR 能否听懂（可懂度代理）',
        example: target.slice(0, 150),
        mastery: 1, phoneme: null, review_count: 0,
        created_at: EDB.nowIso()
      };
      return EDB.put('pronunciationIssues', row).then(function () {
        return ECR.create(row.id, 'pronunciation', row.word).then(function () { return row; });
      });
    });
  }

  /* ---------- 语法句型沉淀：对话评估/写作评估的诚实观察 → 入库进复习队列（pattern 去重） ---------- */
  function saveGrammarNote(text, scenario) {
    var t = String(text || '').trim();
    if (!t || t.length < 4) return Promise.resolve(null);
    /* “没有明显问题”类观察不入库 */
    if (/没有|无明显|不太明显|no (obvious|major|notable)/i.test(t)) return Promise.resolve(null);
    return EDB.getAll('grammarPatterns').then(function (rows) {
      if ((rows || []).some(function (r) { return r.pattern === t.slice(0, 200); })) return null;
      var row = {
        id: EDB.uid(), pattern: t.slice(0, 200), scenario: String(scenario || '').slice(0, 120),
        meaning: '表达时注意这个语法点（来源：' + (scenario || '评估') + '的诚实观察）——复习即在新情境中注意它',
        example: t.slice(0, 150),
        mastery: 1, review_count: 0,
        created_at: EDB.nowIso()
      };
      return EDB.put('grammarPatterns', row).then(function () {
        return ECR.create(row.id, 'grammar', row.pattern.slice(0, 60)).then(function () { return row; });
      });
    });
  }

  window.ECContent = {
    importPack: importPack, importPaste: importPaste,
    process: process, listContent: listContent, pickUnread: pickUnread,
    readingTargetScore: readingTargetScore, retellOverlap: retellOverlap, ladderStep: ladderStep,
    savePronunciationIssue: savePronunciationIssue, saveGrammarNote: saveGrammarNote,
    logReading: logReading, addVocab: addVocab,
    estimateDifficulty: estimateDifficulty, seedIfNeeded: seedIfNeeded,
    seedStarterVocab: seedStarterVocab,
    saveExpression: saveExpression, saveListeningRetell: saveListeningRetell
  };
})();
