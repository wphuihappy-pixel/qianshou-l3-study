/**
 * ECA · AI英语教练 Agent 编排层
 * 5 个角色（Learning Coach / Content Curator / English Tutor / Conversation Coach /
 * Progress Analyst）= 5 套 Prompt + 一个共享 User Learning Profile。
 *
 * 铁律（与数智学习同边界）：
 *  - 程序控制学习逻辑：掌握度、复习日期、分数记录全部由确定性规则计算，AI 不直接写库
 *  - AI 输出必须结构化 JSON；解析失败用规则兜底，不伪造 AI 结果
 *  - 推理型模型思考占大量 token：生成类调用 max_tokens 40000 / timeout 600s
 *    对话轮次调用 max_tokens 3000 / timeout 180s（口语流不能太慢）
 *  - 幻觉式评价禁令：无法可靠判断的必须说"不确定"，不假装知道
 */
(function () {
  'use strict';
  if (window.ECA) return;

  var PROFILE_ID = 'main';
  var SKILLS = ['vocabulary', 'listening', 'reading', 'speaking', 'pronunciation', 'writing', 'fluency', 'grammar', 'naturalness'];
  var SKILL_CN = {
    vocabulary: '词汇', listening: '听力', reading: '阅读', speaking: '口语',
    pronunciation: '发音', writing: '写作', fluency: '流利度', grammar: '语法', naturalness: '自然度'
  };

  /* ---------- 底层调用 ---------- */
  function chat(messages, opts) {
    if (!window.AgentShared || !AgentShared.AI.isReady()) {
      return Promise.reject(new Error('AI 未配置：请在千手首页「设置中心 → AI 服务」填写 OpenAI 兼容地址与密钥（MiniMax 填 https://api.minimax.cn 即可）'));
    }
    return AgentShared.AI.chat(messages, opts);
  }

  function parseJson(txt) {
    if (!txt) return null;
    var s = String(txt).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(s); } catch (e) {}
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
    }
    return null;
  }

  function chatJson(system, user, opts) {
    var o = Object.assign({ max_tokens: 4000, timeout: 300000, temperature: 0.4 }, opts || {});
    return chat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], o).then(function (txt) {
      var j = parseJson(txt);
      if (!j) throw new Error('AI 返回的不是有效 JSON');
      return j;
    });
  }

  /* ---------- Profile（共享记忆，所有 Agent 注入同一份） ---------- */
  function defaultProfile() {
    var skills = {};
    SKILLS.forEach(function (k) { skills[k] = 0; });
    return {
      id: PROFILE_ID, name: '鹏辉', variant: 'en-US',
      baseline: null,            /* {date, level, vocabEst, summary} */
      skills: skills,            /* 9 维 0–5（证据驱动更新，非 AI 主观分） */
      phase: 1,                  /* 1/2/3 */
      phaseStart: null,           /* ISO 日期：当前阶段起始 */
      dailyMinutesWeekday: 30,
      dailyMinutesWeekend: 60,
      goals: [
        '基本英语交流', '获取国外科技资讯', '阅读 AI/Agent/数字化英文文章',
        '阅读 GitHub README 与技术文档', '看 YouTube 英文科技内容',
        '与外国人简单交流', '写简单英文邮件', '用英语和 AI 连续交流'
      ],
      updated_at: null
    };
  }

  function getProfile() {
    return EDB.get('profile', PROFILE_ID).then(function (p) { return p || null; });
  }
  function saveProfile(p) {
    p.updated_at = EDB.nowIso();
    return EDB.put('profile', p).then(function () { return p; });
  }
  function hasBaseline() {
    return getProfile().then(function (p) { return !!(p && p.baseline); });
  }

  /**
   * buildDigest · 共享 Profile 摘要（注入每个 Agent 的上下文）
   * 每次调用实时聚合：画像 + 近期错误 + 弱词 + 复习压力 + 最近内容
   */
  function buildDigest() {
    var today = EDB.dayKey();
    return Promise.all([
      getProfile(),
      EDB.getAll('mistakes'),
      EDB.getAll('vocabulary'),
      EDB.byIndexRange('reviews', 'byDue', today),
      EDB.getAll('content')
    ]).then(function (r) {
      var p = r[0] || defaultProfile();
      var mistakes = (r[1] || []).filter(function (m) { return !m.resolved; })
        .sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); })
        .slice(0, 6)
        .map(function (m) { return '- ' + (m.mistake_type || '?') + ': "' + (m.original || '').slice(0, 60) + '" → "' + (m.corrected || '').slice(0, 60) + '"'; });
      var weakWords = (r[2] || []).filter(function (v) { return v.mastery <= 2 && (v.review_count || 0) >= 1; })
        .sort(function (a, b) { return (a.mastery - b.mastery) || ((b.review_count || 0) - (a.review_count || 0)); })
        .slice(0, 10)
        .map(function (v) { return v.word + '(m' + v.mastery + ')'; });
      var dueReviews = (r[3] || []).length;
      var recentContent = (r[4] || []).filter(function (c) { return c.status === 'processed'; })
        .sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); })
        .slice(0, 3)
        .map(function (c) { return '- "' + (c.title || '').slice(0, 50) + '" [' + (c.tags || []).join(',') + ']'; });

      var skillLines = SKILLS.map(function (k) {
        return SKILL_CN[k] + ' ' + (p.skills[k] || 0).toFixed(1);
      }).join(' / ');

      var lines = [
        '【用户档案】',
        '称呼：' + (p.name || '用户') + '；英语变体：美式英语；当前阶段：Phase ' + (p.phase || 1) + '（90天计划，真实内容占比 20-30%→50-60%→70-80%）',
        '可用时间：工作日 ' + (p.dailyMinutesWeekday || 30) + ' 分钟（碎片），周末 ' + (p.dailyMinutesWeekend || 60) + ' 分钟',
        '9维能力（0-5，训练证据内部估计）：' + skillLines,
        p.baseline ? ('基线：' + (p.baseline.level || 'A1-A2') + '，词汇量约 ' + (p.baseline.vocabEst || 1000)) : '基线：未测评',
        '目标：' + (p.goals || []).join('；'),
        '【近期未解决错误】', (mistakes.length ? mistakes.join('\n') : '（无）'),
        '【记不住的词】', (weakWords.length ? weakWords.join(', ') : '（暂无）'),
        '【今日到期复习】' + dueReviews + ' 项',
        '【最近学习内容】', (recentContent.length ? recentContent.join('\n') : '（暂无）')
      ];
      return { text: lines.join('\n'), profile: p, dueReviews: dueReviews };
    });
  }

  /* ---------- 基线测评（规则 + LLM 协同） ---------- */
  var ASSESS_SYS = [
    '你是"AI英语教练"的测评分析师（Progress Analyst 角色）。服务对象：一名做 AI/Agent/数字化工作的中国成年人，20多年未系统使用英语，词汇量约1000，被动理解略好于主动输出。',
    '任务：根据五段式基线测评数据（阅读/听力/词汇/口语/写作），给出 9 维能力初值（0-5，允许小数如1.5）与整体水平判断。',
    '要求：',
    '1. 只依据给出的证据判断，证据不足的维度给保守值并在 why 里说明"证据不足"',
    '2. 不给"英语总分"，不给考试分数预测，不夸奖不贬低',
    '3. 口语/发音维度基于转写文本可推断的信息（如能否成句、词汇丰富度）给保守估计，明确这是"内部估计"而非精确诊断',
    '4. 全部用中文写 summary 与 focusAreas（focusAreas 是未来90天最该优先补的3项）',
    '5. 输出严格 JSON：',
    '{"skills":{"vocabulary":n,"listening":n,"reading":n,"speaking":n,"pronunciation":n,"writing":n,"fluency":n,"grammar":n,"naturalness":n},"level":"A1|A1-A2|A2|A2-B1","vocabEst":n,"summary":"120字内中文评价","focusAreas":["...","...","..."],"why":{"speaking":"...","pronunciation":"..."}}'
  ].join('\n');

  function assessBaseline(evidence) {
    /* 规则兜底：LLM 失败时的粗估 */
    function fallback() {
      var r = evidence.readingRate, l = evidence.listeningRate, v = evidence.vocabRate;
      return {
        skills: {
          vocabulary: +(v * 2.2).toFixed(1), listening: +(l * 1.8).toFixed(1), reading: +(r * 2.2).toFixed(1),
          speaking: evidence.speakingText ? 1.0 : 0.5, pronunciation: 0.8, writing: evidence.writingText ? 1.0 : 0.5,
          fluency: 0.8, grammar: 1.0, naturalness: 0.8
        },
        level: r > 0.7 ? 'A2' : 'A1-A2', vocabEst: Math.round(evidence.vocabRate * 1000),
        summary: '（规则估计）阅读理解率 ' + Math.round(r * 100) + '%，听力 ' + Math.round(l * 100) + '%，词汇认识率 ' + Math.round(v * 100) + '%。',
        focusAreas: ['口语输出', '听力', '高频词汇'], why: {}
      };
    }
    return chatJson(ASSESS_SYS, JSON.stringify(evidence), { max_tokens: 3000, timeout: 300000, temperature: 0.3 })
      .then(function (j) {
        /* 校验：9 维必须是 0-5 数字 */
        var ok = SKILLS.every(function (k) { return typeof (j.skills && j.skills[k]) === 'number' && j.skills[k] >= 0 && j.skills[k] <= 5; });
        if (!ok) throw new Error('skills 校验失败');
        return j;
      })
      .catch(function () { return fallback(); });
  }

  /* ---------- Learning Coach · 每日计划精化 ---------- */
  var PLAN_SYS = [
    '你是"AI英语教练"（Learning Coach 角色）。服务对象见用户档案。你的职责：替用户决定今天学什么，生成 Today\'s Mission。',
    '你会收到一份"规则骨架草稿"（复习块、按阶段权重分配的块、已选内容）。你的工作是精化：调整顺序、润色 why（给用户看的一句话理由）、确定当日 focus（1-2个技能重点）。',
    '硬规则：',
    '1. 复习块必须在最前且不可删（间隔复习是铁律）',
    '2. 每块 5-15 分钟，总时长不得超过用户可用时间',
    '3. block.type 只能是 review/reading/listening/conversation/writing 之一',
    '4. Phase 1（前30天）以高频词、基础句型、自我介绍、工作介绍为主，真实内容少量；Phase 2 加大真实文章；Phase 3 以真实内容为主',
    '5. why 用中文一句话，具体、不说空话（如"3天没练口语了，今天说5分钟"而不是"巩固提升"）',
    '6. 输出严格 JSON：',
    '{"blocks":[{"type":"review|reading|listening|conversation|writing","minutes":n,"label":"中文块名","why":"一句话","contentId":"可选，已选内容ID"}],"focus":"如：口语+听力","note":"20字内教练开场白"}',
    '7. 分钟数总和 = 用户可用分钟数'
  ].join('\n');

  function dailyPlan(minutes, draft) {
    return buildDigest().then(function (d) {
      var user = '可用时间：' + minutes + ' 分钟\n用户档案与近期数据：\n' + d.text +
        '\n\n规则骨架草稿（JSON，请精化，保持类型与总时长约束）：\n' + JSON.stringify(draft);
      return chatJson(PLAN_SYS, user, { max_tokens: 3000, timeout: 300000, temperature: 0.5 })
        .then(function (j) {
          if (!Array.isArray(j.blocks) || !j.blocks.length) throw new Error('blocks 校验失败');
          var sum = 0;
          j.blocks.forEach(function (b) {
            if (['review', 'reading', 'listening', 'conversation', 'writing'].indexOf(b.type) < 0) throw new Error('block.type 非法');
            sum += (b.minutes || 0);
          });
          if (sum > minutes + 5) throw new Error('总时长超限');
          return j;
        })
        .catch(function (err) {
          /* 规则草稿兜底：LLM 不可用也要有可用计划 */
          draft.fallback = true;
          draft.fallbackReason = err.message;
          return draft;
        });
    });
  }

  /* ---------- English Tutor · 内容加工（三级文本 + 词汇A/B/C + 问题） ---------- */
  var PROCESS_SYS = [
    '你是"AI英语教练"的阅读导师（English Tutor 角色）。服务对象见档案：词汇量约1000的 AI 从业者，正在从基础重建英语，目标是用英语获取 AI/科技信息。',
    '任务：把一篇真实英文内容加工成学习材料。输出严格 JSON：',
    '{"level1":"简化版英文文本，250-400词，用用户当前水平能懂的句式改写（保留原文核心信息，不是翻译，不加中文）","keyPoints":["原文3-5个核心要点，中文"],"vocab":[{"word":"原词","cls":"A|B|C","meaning":"简明中文义","pos":"词性","example":"一个简单英文例句","related":["2-4个常见搭配"]}],"questions":["围绕文章内容的3个讨论引导问题，英文，简单句"],"listeningScript":"用level1改写的听力版，150-250词，句子更短更清晰"}',
    '词汇 A/B/C 分类标准：',
    'A类=高频词且对 AI/数字化工作重要（如 leverage, deploy, workflow）→ 建议学习',
    'B类=有帮助但非核心 → 简单解释即可',
    'C类=低频专业词或不重要 → 不打断阅读',
    '每篇 A 类词不超过 8 个，宁缺毋滥。例句必须是简单、地道的美式英语。'
  ].join('\n');

  function processContent(item, digestText) {
    return chatJson(PROCESS_SYS,
      '用户档案：\n' + digestText + '\n\n待加工内容：\n标题：' + (item.title || '') + '\n来源：' + (item.source || '') + '\n正文（节选）：\n' + String(item.text || '').slice(0, 3000),
      { max_tokens: 30000, timeout: 600000, temperature: 0.4 })
      .then(function (j) {
        if (!j.level1 || !Array.isArray(j.vocab)) throw new Error('加工结果校验失败');
        return j;
      });
  }

  var WORD_SYS = [
    '你是"AI英语教练"的词汇导师（English Tutor 角色）。用户在阅读中点击了一个词。给出快速、有用的查询结果。输出严格 JSON：',
    '{"cls":"A|B|C","meaning":"简明中文义（结合原句语境）","pos":"词性","pron":"音标","example":"一个含该词的简单英文例句（附中文翻译）","related":["2-3个高频搭配"]}',
    'A类=高频且对 AI/数字化工作重要；B类=有帮助非核心；C类=低频不重要。判断要果断，解释要简短。'
  ].join('\n');

  function wordLookup(word, sentenceCtx) {
    return chatJson(WORD_SYS,
      '用户档案要点：词汇量约1000，AI从业者，美式英语。\n查询词：' + word + '\n所在原句：' + (sentenceCtx || '（无）'),
      { max_tokens: 600, timeout: 120000, temperature: 0.3 });
  }

  /* ---------- Conversation Coach · 对话与分层纠错 ---------- */
  var CONV_SYS = [
    '你是"AI英语教练"的口语教练（Conversation Coach 角色），正在和用户进行英语语音对话。服务对象与近期数据见用户档案。',
    '人格：专业、耐心、直接、鼓励但不幼稚、不说鸡汤、不过度表扬。用简单清晰的美式英语（按用户水平调整），必要时一句中文注解（Phase 1 中文可多一点，Phase 3 尽量纯英文）。',
    '对话原则：',
    '1. 围绕真实情境与用户工作（AI/Agent/数字化），不闲聊无关话题；若给了"最近读过的内容"，优先围绕它提问',
    '2. 每轮只问一个问题，句子短，用词简单',
    '3. 分层纠错（核心纪律）：',
    '   - L1 影响理解 → 在 reply 里自然重述正确说法并继续对话',
    '   - L2 不自然或语法错误但不影响理解 → 不直接改。在 reply 里先简短回应内容，再放一个苏格拉底式提示（corrections 数组给出），让用户自己想',
    '   - L3 小瑕疵 → 不纠，记住即可',
    '4. 每轮最多纠 1-2 个问题，按优先级：影响理解 > 严重语法 > 高频表达 > 不自然 > 发音 > 小语法',
    '5. 表达四档：Incorrect / Understandable but unnatural（不当严重错误）/ Natural / Native-like',
    '6. 幻觉禁令：你只能基于转写文本判断，不能评价发音细节；若用户话语无法理解，回复里温和请用户重说',
    '输出严格 JSON：',
    '{"reply":"你的英文回应（可含最多一句中文注解，格式：English sentence (中文)")","corrections":[{"level":2,"type":"verb_tense|intensifier|article|preposition|word_order|collocation|naturalness|subject_verb|other","original":"用户原话片段","hintQ":"苏格拉底提示问题（英文，如 Which word usually comes before like?）","finalCorrected":"最终自然表达（英文）"}],"flow":"continue|end"}'
  ].join('\n');

  function convStart(scenario, digestText, recentContent) {
    var user = '用户档案：\n' + digestText +
      '\n\n开启新对话。情境：' + scenario +
      (recentContent ? '\n最近读过的内容（优先围绕它提问）：' + recentContent : '') +
      '\n请生成开场白 + 第一个问题。输出同 schema 的 JSON（corrections 为空数组）。';
    return chatJson(CONV_SYS, user, { max_tokens: 1500, timeout: 180000, temperature: 0.7 })
      .catch(function () {
        /* 规则兜底：固定开场，保证离线也能对话流程 */
        return {
          reply: "Hi! I'm your English coach today. Let's talk about " + scenario.toLowerCase() + ". So, what do you do in your work?",
          corrections: [], flow: 'continue', fallback: true
        };
      });
  }

  function convTurn(userText, history, digestText) {
    var hist = (history || []).slice(-10).map(function (h) {
      return (h.role === 'user' ? 'User: ' : 'Coach: ') + h.text;
    }).join('\n');
    return chatJson(CONV_SYS,
      '用户档案：\n' + digestText +
      '\n\n对话记录：\n' + hist +
      '\n\nUser（最新一句，语音转写）: ' + userText +
      '\n请按规则回应。输出 JSON。',
      { max_tokens: 2500, timeout: 180000, temperature: 0.6 })
      .then(function (j) {
        if (!j.reply) throw new Error('reply 缺失');
        return j;
      })
      .catch(function () {
        return {
          reply: "Sorry, I didn't catch that. Could you say it again in a simpler way?",
          corrections: [], flow: 'continue', fallback: true
        };
      });
  }

  var ASSESS_CONV_SYS = [
    '你是口语评估分析师。基于一段对话的全部转写（含你的提问），给用户一次诚实的评估。输出严格 JSON：',
    '{"fluency":"低/中/高 + 一句依据（基于词数与停顿的粗估，标注为估计）","vocabulary":"用词观察（2句内）","grammar":"1-2个最值得注意的语法问题（没有就说没有明显问题）","naturalness":"四档：Understandable but unnatural / Natural 等 + 一句说明","focusToday":"今天最值得改进的一件事（中文，具体可执行，如：把 very like 换成 really like）","highlight":"今天做得好的一件事（英文或中文，具体，不空夸）"}',
    '幻觉禁令：你只有文字转写，没有音频；禁止评价发音细节；流利度只能基于文本长度与完整性粗估并注明是估计。'
  ].join('\n');

  function convAssess(turns) {
    var txt = turns.map(function (t) {
      return (t.role === 'user' ? 'User: ' : 'Coach: ') + t.text;
    }).join('\n');
    return chatJson(ASSESS_CONV_SYS, '对话转写：\n' + txt.slice(0, 4000),
      { max_tokens: 1200, timeout: 240000, temperature: 0.3 });
  }

  /* ---------- 写作评估 ---------- */
  var WRITE_SYS = [
    '你是"AI英语教练"的写作教练。评估用户的英文写作（邮件/消息/介绍）。原则：保留用户表达能力水平，不替用户写成完美英语。输出严格 JSON：',
    '{"meaning":"意思是否清楚（一句）","myVersion":"用户原意的轻度整理版（尽量保留用户用词，只改必须改的）","naturalVersion":"更自然的版本","notes":["1-2条最值得说的改进点，中文"]}',
    '评估五维：Meaning/Grammar/Naturalness/Tone/Professionalism，但 notes 只挑 1-2 个最重要的说。'
  ].join('\n');

  function assessWriting(text, task) {
    return chatJson(WRITE_SYS, '写作任务：' + (task || '自由表达') + '\n用户原文：\n' + String(text).slice(0, 2000),
      { max_tokens: 1500, timeout: 240000, temperature: 0.4 });
  }

  /* ---------- Progress Analyst · 每日反馈与周报 ---------- */
  var DAILY_SYS = [
    '你是"AI英语教练"的学习分析师（Progress Analyst 角色）。根据今日学习统计给用户一段简短的每日反馈。诚实、具体、不空夸。输出严格 JSON：',
    '{"improved":"今天进步了什么（具体，1-2句）","needsAttention":"需要关注什么（1项）","tomorrowFocus":"明天建议重点（如：口语+听力）","coachWord":"教练一句话（可适度督促，如用户今天没学可以说 You missed today. Let\'s do a 5-minute speaking session tomorrow.）"}',
    '禁止出现"恭喜完成"这类空洞说法。若数据里某项是空的，就如实说今天没有练这一项，不编造。'
  ].join('\n');

  function dailyDigest(dayStats) {
    return chatJson(DAILY_SYS, JSON.stringify(dayStats), { max_tokens: 1200, timeout: 240000, temperature: 0.4 })
      .catch(function () {
        return {
          improved: '（离线模式）今日练习已记录：' + (dayStats.totalMinutes || 0) + ' 分钟。',
          needsAttention: 'AI 暂不可用，反馈将在下次生成。',
          tomorrowFocus: '复习 + 口语', coachWord: 'Keep going.', fallback: true
        };
      });
  }

  var WEEK_SYS = [
    '你是"AI英语教练"的学习分析师（Progress Analyst 角色）。生成本周报告。核心问题：与上周相比，用户到底进步了什么？为什么？输出严格 JSON：',
    '{"summary":"本周整体一句话（中文）","deltas":[{"skill":"9维之一的中文名","from":n,"to":n,"why":"具体依据"}],"trulyMastered":["本周 mastery 提升的词/表达，来自数据"],"mistakesTop":["高频错误1-3个"],"nextWeekAdjust":"下周自动调整（具体，如：听力落后，下周听力时间从5分钟加到10分钟）"}',
    '禁止编造数据里没有的进步。若数据不足，如实说"数据不足以下结论"。'
  ].join('\n');

  function weeklyReport(weekStats) {
    return chatJson(WEEK_SYS, JSON.stringify(weekStats), { max_tokens: 2500, timeout: 300000, temperature: 0.4 });
  }

  window.ECA = {
    SKILLS: SKILLS, SKILL_CN: SKILL_CN,
    chat: chat, parseJson: parseJson,
    getProfile: getProfile, saveProfile: saveProfile, hasBaseline: hasBaseline,
    defaultProfile: defaultProfile, buildDigest: buildDigest,
    assessBaseline: assessBaseline,
    dailyPlan: dailyPlan,
    processContent: processContent, wordLookup: wordLookup,
    convStart: convStart, convTurn: convTurn, convAssess: convAssess,
    assessWriting: assessWriting,
    dailyDigest: dailyDigest, weeklyReport: weeklyReport
  };
})();
