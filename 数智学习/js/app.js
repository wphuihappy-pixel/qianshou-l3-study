/**
 * 数智学习 · 主应用
 * ============================================================
 * 视图：今日学习台 / 资料库 / 能力树 / 学习目标 / 课程计划 /
 *       复习计划 / 学习画像 / 音频与数据设置
 * 依赖：SZDB(本地库) SZParse(解析) SZTTS(音频) SZReader(阅读批注)
 *       AgentShared.AI(共享 LLM 配置，OpenAI 兼容)
 * 原则：
 *  - 学习者显式反馈优先；行为推测只作低置信候选，不覆盖掌握状态。
 *  - 证据不足用「待核实」，不编造；演示模板醒目标注，不冒充真实资料。
 *  - 原件只读；批注/画像/复习独立存储，可查看、可纠正、可删除。
 * ============================================================
 */
(function () {
  'use strict';
  if (window.SZNApp) return;

  var DB, TTS, PARSE, AI;
  var state = {
    view: 'home',
    day: 1,
    readerSourceId: '',
    readerLessonId: ''
  };

  /* ============================================================
   * 授课风格库（2026-10-06 新增）
   * 每种风格提炼为“语言特征描述”，注入教案 prompt 指导 AI 生成讲稿化音频脚本。
   * 2026-10-08 重构：三种风格按学习场景分工（senior=首次学习·默认 / dense=复习回顾 / sanders=客户沟通与方案评审），
   * 风格只改变表达方式与节奏，不改变事实准确性、课程深度与证据要求（教案 prompt 有硬性约束，见 generateLesson）。
   * 内置库基于公开教学风格调研；自定义风格存 localStorage，用户可手动粘贴讲稿让 AI 提炼。
   * ============================================================ */
  var TEACHING_STYLES = [
    { id: 'senior', name: '资深同事口述', desc: '像一位懂业务、也懂技术的资深同事，陪学习者逐步看懂一个技术问题。表达自然、务实、有判断，但不假设学习者懂技术。先解释必要术语，再讲系统中的位置、工作机制、设计理由、替代方案、收益与限制，最后落到项目案例和客户交流。可以用简短类比帮助理解，但随后必须给出准确技术解释。避免说教、空泛鼓励和未经证实的结论。',
      audioHint: '像资深同事面对面讲解一个新领域。开头用一个真实业务问题引出本课目标；遇到新术语时先用一句通俗但准确的话解释，再说明它在系统里做什么、如何与其他组件配合。讲清设计原因、可选方案、取舍和边界；结合导入案例时明确区分材料事实、分析推断和待核实内容。每课至少带学习者完整分析一个例子，并给出能用于客户沟通的提问。语气自然，节奏适中，不要为了显得专业而堆术语，也不要为了简短省略机制。' },
    { id: 'dense', name: '高密度知识简报', desc: '面向已经学过本主题的学习者，快速回顾关键术语、机制、架构关系、方案差异和风险边界。表达紧凑、有层次，但不得省略概念之间的逻辑关系。首次出现的专业术语仍需简要释义；不得把高密度误解为只报名称或只给结论。',
      audioHint: '适用于复习已学内容，不是首次接触技术概念时的入门讲解。开头简要说明本次复习的问题和结构，然后按“概念—机制—取舍—风险—客户追问”快速回顾。首次出现的术语仍用一句话准确解释。每个结论都要保留关键依据和适用条件；比较方案时至少说明比较维度与主要代价。避免寒暄和重复铺垫，但不得删去理解机制所需的上下文。结尾用两到三个问题帮助学习者自测。' },
    { id: 'sanders', name: '实战顾问简报', desc: '从客户场景和项目决策出发，带学习者分析真实问题、技术方案和交付边界。重点讲如何澄清业务目标、判断技术方案是否适用、比较备选方案、识别风险和组织客户沟通。既提供可以使用的话术，也解释话术背后的技术与业务依据，不把个人经验冒充为普遍规律。',
      audioHint: '从一个客户可能提出的需求或方案切入。先说明要澄清的业务问题，再解释相关技术概念和工作机制。带学习者比较至少两种处理思路，说明各自收益、成本、适用条件和风险；如果当前材料不足以判断，要给出需要追问的证据。随后示范如何向客户解释，并提供可直接使用的澄清问题。话术要与实际判断逻辑对应，不能只给“客户通常会怎么做”或“这里容易踩坑”之类经验结论。收尾给出一份简短的评审检查项，帮助学习者迁移到其他客户场景。' }
  ];
  var STYLE_KEY = 'szn_teaching_styles';
  var DEFAULT_STYLE_KEY = 'szn_default_style';

  /* 精选音色库：MiniMax 系统音色（公开文档常见）；OpenAI 兼容用 alloy/echo 等。
   * 切换 Provider 时重建下拉。每个音色：id（API voice_id）+ name（人眼标签）+ desc（一句风格描述）。 */
  var VOICE_LIBRARY = {
    minimax: [
      { id: 'male-qn-qingse', name: '青涩男声', desc: '青年男声，清亮自然，通用讲解' },
      { id: 'male-qn-jingying', name: '精英男声', desc: '成熟男声，沉稳商务' },
      { id: 'male-qn-badao', name: '霸道男声', desc: '中年男声，有力坚定' },
      { id: 'male-qn-daxuesheng', name: '大学生男声', desc: '年轻男声，活泼亲切' },
      { id: 'female-shaonv', name: '少女女声', desc: '少女音，甜美清亮' },
      { id: 'female-yujie', name: '御姐女声', desc: '成熟女声，沉稳知性' },
      { id: 'female-chengshu', name: '成熟女声', desc: '中年女声，温和稳重' },
      { id: 'female-tianmei', name: '甜美女声', desc: '甜美亲切，适合轻松内容' },
      { id: 'presenter_male', name: '男主持人', desc: '播报风，字正腔圆' },
      { id: 'presenter_female', name: '女主持人', desc: '播报风，清晰专业' },
      { id: 'audiobook_male_1', name: '男声有声书', desc: '叙事感强，适合长听' },
      { id: 'audiobook_female_1', name: '女声有声书', desc: '叙事温柔，适合长听' }
    ],
    openai: [
      { id: 'alloy', name: 'Alloy', desc: '中性平稳，通用' },
      { id: 'echo', name: 'Echo', desc: '男声，温和' },
      { id: 'fable', name: 'Fable', desc: '中性，叙事感' },
      { id: 'onyx', name: 'Onyx', desc: '男声，沉稳' },
      { id: 'nova', name: 'Nova', desc: '女声，清亮' },
      { id: 'shimmer', name: 'Shimmer', desc: '女声，温暖' }
    ]
  };

  function voicesFor(provider) {
    return VOICE_LIBRARY[provider] || VOICE_LIBRARY.minimax;
  }
  function loadCustomStyles() {
    try { return JSON.parse(localStorage.getItem(STYLE_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveCustomStyles(arr) { localStorage.setItem(STYLE_KEY, JSON.stringify(arr || [])); }
  function allStyles() { return TEACHING_STYLES.concat(loadCustomStyles()); }
  function getStyle(id) { return allStyles().find(function (s) { return s.id === id; }) || TEACHING_STYLES[0]; }
  function getDefaultStyleId() { return localStorage.getItem(DEFAULT_STYLE_KEY) || 'senior'; }
  function setDefaultStyleId(id) { localStorage.setItem(DEFAULT_STYLE_KEY, id); }
  var LAST_KEY = 'szn_last_state';
  var ROUTES = [
    { id: 'home', name: '今日学习台', ico: '今' },
    { id: 'sources', name: '资料库', ico: '资' },
    { id: 'competency', name: '能力树', ico: '能' },
    { id: 'goals', name: '学习目标', ico: '标' },
    { id: 'course', name: '课程计划', ico: '课' },
    { id: 'reviews', name: '复习计划', ico: '复' },
    { id: 'profile', name: '学习画像', ico: '像' },
    { id: 'settings', name: '音频与数据', ico: '音' }
  ];
  var TITLES = {
    home: ['今日学习台', '两步内继续上次学习'],
    sources: ['资料库', '导入获准资料并登记来源（原件只读）'],
    competency: ['能力树', '来自《附件1 复合型产数工程师认证能力标准》'],
    goals: ['学习目标', '路径 / 基础水平 / 每日时间 / 音频偏好'],
    course: ['课程计划', '30 天课程草案 · 确认后锁定生成教案'],
    reviews: ['复习计划', '按 0/1/3/7/14 天间隔安排，规则可解释'],
    profile: ['学习画像', '你说了算：可查看、可纠正、可删除'],
    settings: ['音频与数据', 'TTS Provider 配置 · 备份导出 · 删除'],
    lesson: ['课程学习', '教案 · 音频 · 反馈 · 来源引用'],
    reader: ['阅读与批注', '原件只读 · 批注存独立图层']
  };

  /* ================================================================
   * 工具
   * ================================================================ */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function $(id) { return document.getElementById(id); }
  function toast(msg, ms) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.style.display = 'none'; }, ms || 2600);
  }

  /* ---- 全局等待状态条 + 进度条（2026-10-06 升级）----
   * 通用顶部状态条，支持两种模式：
   *  - ai（默认）：AI 生成类调用，进度不可知 -> 流动动画条（不谎报百分比）
   *  - percent/count：可计量的等待（资料导入、音频批量合成）-> 真实百分比 + 计数
   * 触发按钮任务期间禁用；genBusyUpdate 更新进度/文案；完成或失败后 genBusyEnd 自动消失恢复。 */
  var genBusy = false, genBusyBtn = null, genBusyMode = 'ai', genBusyCount = null;
  function genBusyStart(msg, btnId, opts) {
    if (genBusy) { toast('上一个任务还在进行中，请等它完成（见顶部状态条）', 4000); return false; }
    genBusy = true;
    genBusyBtn = btnId ? $(btnId) : null;
    if (genBusyBtn) genBusyBtn.disabled = true;
    opts = opts || {};
    genBusyMode = opts.mode || 'ai';
    genBusyCount = (opts.mode === 'count' && opts.total > 0) ? { done: 0, total: opts.total } : null;
    var bar = document.createElement('div');
    bar.id = 'szn-gen-bar';
    bar.setAttribute('data-prefix', msg);
    bar.innerHTML = '<span class="szn-gen-text"></span><span class="szn-gen-hint"></span>' +
      '<div class="szn-gen-progress"><div class="szn-gen-fill' + (genBusyMode === 'ai' ? ' flow' : '') + '"></div></div>';
    var t = bar.querySelector('.szn-gen-text'), h = bar.querySelector('.szn-gen-hint');
    t.textContent = msg;
    if (genBusyMode === 'ai') h.textContent = '（AI 处理中，通常需 30 秒到 2 分钟；完成前请勿重复点击、勿关闭页面）';
    if (genBusyCount) t.textContent = msg + '（0/' + genBusyCount.total + '）';
    document.body.appendChild(bar);
    return true;
  }
  function genBusyUpdate(o) {
    if (!genBusy) return;
    var bar = $('szn-gen-bar');
    if (!bar) return;
    o = o || {};
    var fill = bar.querySelector('.szn-gen-fill');
    var t = bar.querySelector('.szn-gen-text');
    if (genBusyCount) {
      if (typeof o.done === 'number') genBusyCount.done = o.done;
      var pct = Math.max(0, Math.min(100, Math.round(genBusyCount.done / (genBusyCount.total || 1) * 100)));
      if (fill) fill.style.width = pct + '%';
      if (t) t.textContent = bar.getAttribute('data-prefix') + '（' + genBusyCount.done + '/' + genBusyCount.total + '）';
    } else if (genBusyMode === 'percent') {
      var p2 = Math.max(0, Math.min(100, Math.round(typeof o.pct === 'number' ? o.pct : 0)));
      if (fill) fill.style.width = p2 + '%';
      if (o.msg && t) t.textContent = o.msg;
    } else if (genBusyMode === 'ai') {
      if (o && o.msg && t) t.textContent = o.msg;
    }
  }
  function genBusyEnd() {
    genBusy = false; genBusyMode = 'ai'; genBusyCount = null;
    if (genBusyBtn) { genBusyBtn.disabled = false; genBusyBtn = null; }
    var bar = $('szn-gen-bar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }
  function fmtSize(n) {
    if (!n && n !== 0) return '-';
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
    return Math.round(n / 1024) + 'KB';
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function saveLast(patch) {
    try {
      var cur = {};
      try { cur = JSON.parse(localStorage.getItem(LAST_KEY) || '{}'); } catch (e) {}
      Object.assign(cur, patch);
      localStorage.setItem(LAST_KEY, JSON.stringify(cur));
    } catch (e) { }
  }

  /* 从 LLM 回复提取 JSON（兼容 ```json 包裹与前后杂文） */
  function extractJson(txt) {
    if (!txt) throw new Error('AI 返回为空');
    var s = String(txt).trim();
    /* 完全没 { ：多半是纯思考文本/正文被截断，直接给明确提示而不是 JSON.parse 报模糊错 */
    if (s.indexOf('{') < 0) {
      throw new Error('AI 返回的内容里没有 JSON（返回的是：' + s.slice(0, 120) + '…）。可能是 max_tokens 不够导致正文没输出，请 Ctrl+F5 强刷后用新版再试。');
    }
    /* 推理型模型（M2.5/M3/M3.1-Flash）会把思考过程放在 content 前面，JSON 在最后。
     * 优先：匹配所有 ```json...``` 代码块取最后一个（跳过思考里的片段） */
    var blocks = s.match(/```json\s*([\s\S]*?)```/g);
    if (blocks && blocks.length) {
      var inner = blocks[blocks.length - 1].replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
      return JSON.parse(inner);
    }
    /* 兜底1：平衡括号从后往前找最后一个顶层 JSON 对象（跳过思考里的大括号） */
    var depth = 0, start = -1;
    for (var k = s.length - 1; k >= 0; k--) {
      if (s[k] === '}') depth++;
      else if (s[k] === '{') { depth--; if (depth === 0) { start = k; break; } }
    }
    if (start >= 0) return JSON.parse(s.slice(start));
    /* 兜底2：原逻辑 */
    var m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) s = m[1].trim();
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    return JSON.parse(s);
  }

  function aiReady() {
    return AI && AI.isReady && AI.isReady();
  }

  /* ================================================================
   * 初始化与路由
   * ================================================================ */
  function init() {
    DB = window.SZDB; TTS = window.SZTTS; PARSE = window.SZParse; AI = (window.AgentShared && window.AgentShared.AI) || null;
    if (!DB || !TTS || !PARSE) { alert('数智学习依赖未加载完整，请检查 js 文件'); return; }

    bindNav();
    window.addEventListener('hashchange', route);
    registerSW();
    route();
    /* 云同步（多设备）：启用后 2 秒首同步 + 60 秒轮询；本地写操作由 db.js 通知自动推送 */
    if (window.SZSync) window.SZSync.startAutoSync();
  }

  function bindNav() {
    var nav = $('nav');
    var html = '<a class="nav-item" href="../index.html" style="color:#F2EEE6"><span class="ico">‹</span>返回统一首页</a>' +
      '<div class="grouptag">数智学习 AGENT</div>';
    ROUTES.forEach(function (r) {
      html += '<button class="nav-item" data-view="' + r.id + '"><span class="ico">' + r.ico + '</span>' + r.name + '</button>';
    });
    nav.innerHTML = html;
    nav.querySelectorAll('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { location.hash = '#/' + b.getAttribute('data-view'); });
    });
  }

  function registerSW() {
    /* PWA 仅在 http(s) 下可用；file:// 双击打开时跳过并诚实提示 */
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('SW 注册失败（不影响使用，仅影响离线缓存）：', e.message);
      });
    }
  }

  function route() {
    var h = location.hash.replace(/^#\/?/, '') || 'home';
    var parts = h.split('?');
    var view = parts[0] || 'home';
    if (parts[1]) {
      parts[1].split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0] === 'day') state.day = +p[1] || 1;
        if (p[0] === 'src') state.readerSourceId = decodeURIComponent(p[1]);
      });
    }
    /* lesson 与 reader 为子视图（不占导航位，但为合法路由） */
    var VALID = ROUTES.map(function (r) { return r.id; }).concat(['lesson', 'reader']);
    if (VALID.indexOf(view) < 0) view = 'home';
    state.view = view;
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    var t = TITLES[view] || ['', ''];
    $('page-title').textContent = t[0];
    $('page-sub').textContent = t[1];
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    var sec = $('view-' + view);
    if (sec) sec.classList.remove('hidden');
    var fn = { home: renderHome, sources: renderSources, competency: renderCompetency, goals: renderGoals, course: renderCourse, reviews: renderReviews, profile: renderProfile, settings: renderSettings, lesson: renderLesson }[view];
    if (fn) fn();
    saveLast({ view: view });
  }

  function goto(view) { location.hash = '#/' + view; }

  /* ================================================================
   * 视图：今日学习台
   * ================================================================ */
  function renderHome() {
    Promise.all([DB.latestGoals(), DB.activeCourse(), DB.getAll('sources'), DB.byIndex('reviews', 'state', 'pending')]).then(function (r) {
      var goals = r[0], course = r[1], sources = r[2], pendings = r[3];
      var today = todayStr();
      var due = pendings.filter(function (v) { return v.dueDay <= today; });
      var html = '';

      if (!goals) {
        html += '<div class="hero"><div class="daytag">开始</div><h1>三步开始数智学习</h1>' +
          '<p>1. 在「学习目标」选认证路径与偏好；2. 在「资料库」导入获准的案例与《附件1 认证能力标准》；3. 回到「课程计划」生成 30 天课程草案，确认后锁定。</p>' +
          '<div class="focus"><button class="btn btn-primary" onclick="location.hash=\'#/goals\'">去设置学习目标</button>' +
          '<button class="btn btn-ghost" onclick="location.hash=\'#/sources\'">去导入资料</button></div></div>';
      } else {
        var nextDay = (course && course.progress) ? (course.progress.day || 1) : 1;
        if (nextDay > 30) nextDay = 30;
        var dayInfo = course ? (course.days[nextDay - 1] || null) : null;
        html += '<div class="hero"><div class="daytag">路径 ' + esc(goals.path) + ' · 基础 ' + esc(goals.baseLevel) + '</div>' +
          '<h1>' + (course ? ('第 ' + nextDay + ' 天：' + esc(dayInfo ? dayInfo.theme : '课程已完成')) : '还没有确认课程') + '</h1>' +
          '<p>每日 ' + esc(goals.dailyMinutes) + ' 分钟（音频约 ' + esc(goals.audioMinutes) + ' 分钟）· 每周复盘：' + esc(goals.reviewDay) + ' · TTS ' + (TTS.loadCfg().enabled ? '已配置' : '未配置') + '</p>' +
          '<div class="focus">' +
          (course && course.status === 'locked'
            ? '<button class="btn btn-primary" onclick="location.hash=\'#/lesson?day=' + nextDay + '\'">进入今天的学习</button>' +
            '<button class="btn btn-ghost" onclick="location.hash=\'#/course\'">课程计划</button>'
            : '<button class="btn btn-primary" onclick="location.hash=\'#/course\'">生成 / 确认课程</button>') +
          '</div></div>';
        if (course && course.status === 'draft') {
          html += '<div class="alert warn">课程草案尚未确认锁定：锁定后才生成教案与音频。<button class="btn btn-sm btn-success" onclick="location.hash=\'#/course\'">去确认</button></div>';
        }
      }

      html += '<div class="card"><h2>资料与状态</h2><div class="row">' +
        kvCard('已登记资料', sources.length + ' 份', '#/sources') +
        kvCard('待复习', due.length + ' 项', '#/reviews') +
        kvCard('演示数据', sources.filter(function (s) { return s.demo; }).length + ' 份', '#/sources') +
        '</div>' +
        '<p class="note">案例文件（方案/立项/需求/汇报）中「计划、目标、试点、评审中」的内容不会在教案中表述为既成成果；教案对每段内容标注 来源事实 / 推断 / 课堂假设。真实外部履历指标（项目金额、签约金额、标杆案例数等）只能记录你的真实证据，应用不会宣称认证通过。</p></div>';

      if (due.length) {
        html += '<div class="card"><h2>今天到期的复习</h2>' +
          due.slice(0, 5).map(function (v) {
            return '<div class="list-item" onclick="location.hash=\'#/lesson?day=' + v.day + '\'"><div class="li-title">第 ' + v.day + ' 天 · ' + esc(v.concept) + '</div><div class="li-meta">原因：' + esc(v.reason || '完成学习') + ' · 安排于 ' + esc(v.dueDay) + '</div></div>';
          }).join('') +
          '<button class="btn btn-outline btn-sm" onclick="location.hash=\'#/reviews\'">查看复习计划</button></div>';
      }

      $('view-home').innerHTML = html;
    }).catch(function (e) { $('view-home').innerHTML = errHtml(e); });
  }

  function kvCard(k, v, href) {
    return '<div class="card" style="margin:0"><div class="muted" style="font-size:12px">' + k + '</div>' +
      '<div style="font-size:26px;font-weight:800;color:var(--cinnabar)">' + esc(v) + '</div>' +
      '<a href="' + href + '" style="font-size:12px">查看 →</a></div>';
  }
  function errHtml(e) {
    return '<div class="alert warn">加载失败：' + esc(e && e.message || e) + '</div>';
  }

  /* ================================================================
   * 视图：资料库（导入 + 来源登记）
   * ================================================================ */
  function renderSources() {
    DB.getAll('sources').then(function (all) {
      all.sort(function (a, b) { return b.addedAt.localeCompare(a.addedAt); });
      var html = '<div class="card"><h2>导入资料</h2>' +
        '<p class="sub">支持 PDF / DOCX / PPTX / HTML。文件先做类型与大小校验，解析为「页/段/幻灯片/内容块」锚点模型；<b>原件只读，永不修改</b>。仅导入你有权使用的资料。</p>' +
        '<div class="row"><div class="field"><label>选择文件</label><input type="file" id="src-file" accept=".pdf,.docx,.pptx,.html,.htm" multiple></div>' +
        '<div class="field"><label>来源 URL（引用外部资料时填写）</label><input type="text" id="src-url" placeholder="https://…（可选）"></div></div>' +
        '<button class="btn btn-primary" id="btn-import">导入并解析</button>' +
        '<div id="import-status"></div>' +
        '<div class="divider"></div><p class="note">安全策略：伪装格式（文件头不符）会被拒绝；含宏的文件仅隔离提示、不解析宏；文档内容一律作为数据处理，检测到疑似「指令型文本」只提示、绝不执行。压缩包内含可执行条目直接拒绝。</p></div>';

      html += '<div class="card"><h2>来源登记表</h2>';
      if (!all.length) {
        html += '<div class="empty">还没有登记资料。建议先导入《附件1 复合型产数工程师认证能力标准》与至少一份获准的案例材料。</div>';
      } else {
        html += '<table class="tbl"><tr><th>名称</th><th>类型</th><th>大小</th><th>版本</th><th>状态</th><th>锚点</th><th>敏感级</th><th>来源</th><th></th></tr>';
        all.forEach(function (s) {
          var statusTag = s.status === 'parsed' ? '<span class="tag green">已解析</span>'
            : s.status === 'failed' ? '<span class="tag red">解析失败</span>'
              : '<span class="tag gold">' + esc(s.status) + '</span>';
          html += '<tr><td><b>' + esc(s.name) + '</b>' + (s.demo ? ' <span class="tag demo">演示</span>' : '') + (s.isStandard ? ' <span class="tag ink">能力标准</span>' : '') +
            (s.injections && s.injections.length ? '<br><span class="tag red">疑似指令文本 ' + s.injections.length + ' 处（已隔离为数据）</span>' : '') +
            (s.warnings && s.warnings.length ? '<br><span class="tag gold">' + esc(s.warnings[0]) + '</span>' : '') +
            '</td><td>' + esc(s.type) + '</td><td>' + fmtSize(s.size) + '</td><td>v' + esc(s.version) + '</td>' +
            '<td>' + statusTag + (s.error ? '<br><span style="font-size:11px;color:var(--cinnabar)">' + esc(s.error) + '</span>' : '') + '</td>' +
            '<td style="font-size:12px">' + esc(s.anchorType || '-') + '</td>' +
            '<td>' + (s.accessLevel === 'restricted' ? '<span class="tag red">内部资料·禁外传</span>' : '<span class="tag">私有</span>') + '</td>' +
            '<td style="font-size:12px">' + (s.originUrl ? esc(s.originUrl) + '<br>' + esc(s.accessDate) : '本地文件') + '</td>' +
            '<td><button class="btn btn-sm btn-outline" data-read="' + s.id + '">阅读/批注</button> ' +
            '<button class="btn btn-sm btn-danger" data-del="' + s.id + '">删除</button></td></tr>';
        });
        html += '</table>';
      }
      $('view-sources').innerHTML = html;

      $('btn-import').addEventListener('click', doImport);
      $('view-sources').querySelectorAll('[data-read]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.readerSourceId = b.getAttribute('data-read');
          state.readerLessonId = '';
          openReader(b.getAttribute('data-read'), '');
        });
      });
      $('view-sources').querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () { deleteSource(b.getAttribute('data-del')); });
      });
    }).catch(function (e) { $('view-sources').innerHTML = errHtml(e); });
  }

  function doImport() {
    var files = $('src-file').files;
    var url = $('src-url').value.trim();
    var box = $('import-status');
    if (!files.length && !url) { toast('请选择文件或填写来源 URL'); return; }
    var list = Array.prototype.slice.call(files);
    var total = list.length;
    var chain = Promise.resolve();
    var results = [];
    if (total > 0) genBusyStart('正在导入并解析资料', 'btn-import', { mode: 'percent' });
    list.forEach(function (f, idx) {
      chain = chain.then(function () {
        return importOne(f, url, box, idx, total).then(function (r) { results.push(r); });
      });
    });
    chain.then(function () {
      genBusyEnd();
      box.innerHTML = '<div class="alert ' + (results.some(function (r) { return !r.ok; }) ? 'warn' : 'ok') + '">' +
        results.map(function (r) { return (r.ok ? '√ ' : '× ') + esc(r.name) + '：' + esc(r.msg); }).join('<br>') + '</div>';
      toast('导入完成，' + results.length + ' 个文件');
      renderSources();
    });
  }

  function importOne(file, url, box, idx, total) {
    var chk = PARSE.checkFile(file);
    if (!chk.ok) {
      if (total) genBusyUpdate({ pct: Math.round((idx + 1) / total * 100), msg: '跳过 ' + file.name + '：' + chk.reason });
      return Promise.resolve({ ok: false, name: file.name, msg: chk.reason });
    }
    var isStandard = /认证能力标准|附件1/.test(file.name);
    return PARSE.parse(file, function (p, pct) {
      box.innerHTML = '<div class="alert info">正在解析 ' + esc(file.name) + '：' + esc(p) + '</div>';
      if (total) {
        var overall = Math.round(((idx + (typeof pct === 'number' ? pct : 0)) / total) * 100);
        genBusyUpdate({ pct: overall, msg: '正在解析（' + (idx + 1) + '/' + total + '）：' + file.name });
      }
    }).then(function (model) {
      var rec = {
        id: DB.newId('src'),
        name: file.name,
        type: model.kind,
        mime: model.meta.mime,
        size: file.size,
        version: 1,
        status: 'parsed',
        accessLevel: 'restricted',       /* 内部/未定案资料默认禁止外传 */
        isStandard: isStandard,
        originUrl: url || '',
        accessDate: url ? DB.nowIso() : '',
        originPath: '本地导入',
        demo: false,
        addedAt: DB.nowIso(),
        updatedAt: DB.nowIso(),
        anchorType: model.anchorType,
        pageNote: model.pageNote,
        warnings: model.warnings,
        injections: model.injections,
        pageBlocks: model.pages.map(function (p) { return p.blocks; }),
        pageTexts: model.pages.map(function (p) {
          return p.blocks.map(function (b) { return b.text; }).join('\n');
        }),
        pagesMeta: model.pages.map(function (p) { return { num: p.num, count: p.blocks.length }; }),
        fullText: model.fullText,
        fileBlob: file.slice(0, file.size, file.type || 'application/octet-stream') /* 只读副本 */
      };
      return DB.put('sources', rec).then(function () {
        return DB.logEvent({ type: 'generate', payload: { action: 'import', source: file.name }, note: '导入资料' });
      }).then(function () {
        return { ok: true, name: file.name, msg: '解析成功（' + model.pages.length + (model.anchorType === 'slide' ? ' 张幻灯片' : model.anchorType === 'para' ? ' 个流' : ' 页') + '）' + (model.injections.length ? '；含疑似指令文本已按数据隔离' : '') + (isStandard ? '；已识别为能力标准' : '') };
      });
    }).catch(function (e) {
      /* 登记失败记录（验收要求：解析失败显示具体文件与原因） */
      var rec2 = {
        id: DB.newId('src'),
        name: file.name, type: chk.kind || '?', size: file.size, version: 1,
        status: 'failed', error: e.message || String(e),
        accessLevel: 'restricted', isStandard: isStandard, originUrl: url || '',
        accessDate: '', originPath: '本地导入', demo: false,
        addedAt: DB.nowIso(), updatedAt: DB.nowIso()
      };
      return DB.put('sources', rec2).then(function () {
        return { ok: false, name: file.name, msg: (e && e.message) || String(e) };
      });
    });
  }

  function deleteSource(id) {
    if (!confirm('删除该资料登记？已产生的批注将一并删除；课程/教案中引用会标记「来源已删除」。此操作不可撤销。')) return;
    Promise.all([
      DB.delWhere('annotations', 'sourceId', id),
      DB.del('sources', id)
    ]).then(function () {
      toast('已删除登记与批注');
      renderSources();
    });
  }

  /* ================================================================
   * 视图：能力树
   * ================================================================ */
  function renderCompetency() {
    DB.getAll('competency').then(function (items) {
      var hasStandard = false;
      return DB.getAll('sources').then(function (srcs) {
        hasStandard = srcs.some(function (s) { return s.isStandard && s.status === 'parsed'; });
        var html = '';
        if (!items.length) {
          html += '<div class="alert info">能力树用于把《附件1》三条路径（业务顾问 L4 / 行业解决方案 L4 / 产品能力运营 L3）的能力项转成可考核目标。' +
            (hasStandard ? '已检测到已导入的能力标准文件，可自动提取。' : '请先在资料库导入《附件1 复合型产数工程师认证能力标准(1).docx》。') + '</div>';
        }
        html += '<div class="card"><h2>生成能力树</h2>' +
          '<p class="sub">自动提取：把已导入的《附件1》全文交给 AI 结构化为能力项（含权重、证据要求、履历项/学习项区分）。<b>三条路径全部补全知识点清单</b>（每个能力项 3-8 个需掌握的概念/术语），目标路径标"目标路径"标签置顶。知识点参考产数学习模块的 78 个术语库 + AI 公开知识补充（AI 智能化、数字化、方案设计、产品设计等）。</p>' +
          '<button class="btn btn-primary" id="btn-comp-extract" ' + (hasStandard ? '' : 'disabled') + '>从《附件1》提取能力树 + 补全知识点（AI）</button> ' +
          '<button class="btn btn-outline" id="btn-comp-demo">载入演示模板能力树</button> ' +
          '<button class="btn btn-outline" id="btn-comp-export">导出能力树 JSON</button> ' +
          (!hasStandard ? '<div class="alert warn" style="margin-top:10px"><b>还缺：</b>已导入且解析成功的《附件1 复合型产数工程师认证能力标准(1).docx》。请先到「<a href="#/sources">资料库</a>」导入该文件，自动提取按钮才能启用。</div>' : '') +
          (aiReady() ? '' : '<div class="alert warn" style="margin-top:10px">AI 未配置：自动提取不可用。演示模板会<b>醒目标注</b>且不冒充真实标准（权重为示意）。配置入口在统一首页「设置中心 → AI 服务」。</div>') +
          '</div>';

        if (items.length) {
          var paths = {};
          items.forEach(function (c) { (paths[c.path] = paths[c.path] || []).push(c); });
          Object.keys(paths).forEach(function (p) {
            var arr = paths[p];
            var isDemo = arr.some(function (c) { return c.demo; });
            var hasFocus = arr.some(function (c) { return c.focus; });
            html += '<div class="card"><h2>' + esc(p) + (hasFocus ? ' <span class="tag green">目标路径</span>' : '') + (isDemo ? ' <span class="tag demo">演示模板·非真实标准权重</span>' : '') + '</h2>' +
              (isDemo ? '<div class="demo-banner">这是演示模板能力树：结构与名称为通用示意，未从《附件1》原文提取。正式备考请配置 AI 后自动提取，或人工对照原文校对。</div>' : '') +
              '<table class="tbl"><tr><th>编号</th><th>能力项</th><th>权重</th><th>类型</th><th>证据要求</th><th>需掌握的知识点</th><th></th></tr>';
            arr.forEach(function (c) {
              var kpHtml = '-';
              if (c.knowledgePoints && c.knowledgePoints.length) {
                kpHtml = '<div style="font-size:12px;line-height:1.8">' + c.knowledgePoints.map(function (kp) {
                  var tag = kp.source === 'terms' ? '<span class="tag" style="font-size:10px">术语库</span>' : '<span class="tag gold" style="font-size:10px">AI补</span>';
                  return '<div style="margin-bottom:4px">' + tag + ' <b>' + esc(kp.term) + '</b>：' + esc(kp.brief) + '</div>';
                }).join('') + '</div>';
              }
              html += '<tr><td>' + esc(c.code) + '</td><td>' + esc(c.name) + '</td><td>' + esc(c.weight) + '</td>' +
                '<td>' + (c.type === 'resume'
                  ? '<span class="tag red">履历项·需真实项目证明</span>'
                  : '<span class="tag green">学习项</span>') + '</td>' +
                '<td style="font-size:12px">' + esc(c.evidence || '-') + '</td>' +
                '<td>' + kpHtml + '</td>' +
                '<td><button class="btn btn-sm btn-danger" data-cdel="' + c.id + '">删</button></td></tr>';
            });
            html += '</table></div>';
          });
          html += '<div class="card"><h2>人工校对入口</h2><p class="sub">自动提取后请对照原文核对权重与表述；发现偏差直接删除错误项后在此补充：</p>' +
            '<div class="row"><div class="field"><label>路径</label><select id="cp-path">' +
            ['业务顾问 L4', '行业解决方案 L4', '产品能力运营 L3'].map(function (x) { return '<option>' + x + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="field"><label>编号</label><input type="text" id="cp-code" placeholder="如 1.2"></div>' +
            '<div class="field"><label>能力项名称</label><input type="text" id="cp-name"></div>' +
            '<div class="field"><label>权重</label><input type="text" id="cp-weight" placeholder="如 20% 或 原文未标注"></div></div>' +
            '<div class="row"><div class="field"><label>类型</label><select id="cp-type"><option value="learning">学习项</option><option value="resume">履历项（需真实项目证明）</option></select></div>' +
            '<div class="field"><label>证据要求</label><input type="text" id="cp-evidence" placeholder="原文中的证明要求（照抄）"></div></div>' +
            '<button class="btn btn-primary" id="btn-comp-add">添加能力项</button></div>';
        }
        $('view-competency').innerHTML = html;

        $('btn-comp-extract').addEventListener('click', extractCompetency);
        $('btn-comp-demo').addEventListener('click', loadDemoCompetency);
        $('btn-comp-export').addEventListener('click', function () {
          TTS.downloadBlob(new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' }), '能力树.json');
        });
        var addBtn = $('btn-comp-add');
        if (addBtn) addBtn.addEventListener('click', addCompetencyItem);
        $('view-competency').querySelectorAll('[data-cdel]').forEach(function (b) {
          b.addEventListener('click', function () {
            if (confirm('删除该能力项？')) DB.del('competency', b.getAttribute('data-cdel')).then(renderCompetency);
          });
        });
      });
    }).catch(function (e) { $('view-competency').innerHTML = errHtml(e); });
  }

  /* 目标路径→附件1章节映射 */
  var PATH_MAP = {
    '业务顾问 L4': { focus: '业务顾问方向 L4', ref: ['行业解决方案 L4', '产品能力运营 L3'] },
    '行业解决方案 L4': { focus: '行业解决方案 L4', ref: ['业务顾问 L4', '产品能力运营 L3'] },
    '产品能力运营 L3': { focus: '产品能力运营 L3', ref: ['业务顾问 L4', '行业解决方案 L4'] }
  };

  function extractCompetency() {
    if (!aiReady()) { toast('请先在设置中心配置 AI 服务'); return; }
    DB.getAll('sources').then(function (srcs) {
      var std = srcs.find(function (s) { return s.isStandard && s.status === 'parsed'; });
      if (!std) { toast('未找到已解析的能力标准文件'); return; }
      /* 读学习目标，确定目标路径 */
      return DB.getAll('goals').then(function (goalsArr) {
        var goals = goalsArr[0] || {};
        var targetPath = goals.path || '业务顾问 L4';
        var pm = PATH_MAP[targetPath] || PATH_MAP['业务顾问 L4'];
        if (!genBusyStart('正在按目标「' + targetPath + '」提取能力树 + 补全知识点', 'btn-comp-extract')) return;
        var text = String(std.fullText || '');
        /* 术语库摘要：78个术语名称+一句话说明，供 AI 补全知识点参考 */
        var termsSlim = (window.TERM_LIBRARY_SLIM || []).map(function (t) { return t.n + '（' + t.p + '）'; }).join('；');
        var prompt = '你是认证标准解析器 + AI/数字化领域专家。以下是《复合型产数工程师认证能力标准》的原文文本。\n' +
          '学习者的目标路径是「' + targetPath + '」。请按目标裁剪提取能力树，并为每个能力项补全「需要掌握的知识点」。\n\n' +
          '要求：\n' +
          '1. 只输出 JSON：{"paths":[{"path":"业务顾问 L4","focus":true,"items":[{"code":"","name":"","weight":"","type":"learning|resume","evidence":"","knowledgePoints":[{"term":"","brief":"","source":"terms|ai-knowledge"}]}]}]}\n' +
          '2. 三条路径都全量提取能力项，每个能力项都必须补全 knowledgePoints（3-8 个知识点）；\n' +
          '3. 目标路径（' + targetPath + '）标 focus:true（作为重点置顶），其他路径标 focus:false，但所有路径都补全 knowledgePoints；\n' +
          '4. weight 必须照抄原文权重（如原文未标注写"原文未标注"），禁止编造数字；\n' +
          '5. type 区分：需要外部真实履历（项目金额、签约金额、部署数量等）才能证明的填 resume；可通过学习与练习提升的填 learning；\n' +
          '6. evidence 照抄原文对该项的证明要求；原文没有对应内容的项不要编造；\n' +
          '7. **knowledgePoints 补全规则**：为每个能力项（所有路径）列出 3-8 个需要掌握的知识点，包括 AI 智能化、数字化、方案设计、产品设计、商务等需掌握的概念/术语/技术原理。每个知识点：\n' +
          '   a) term：知识点名称（术语名，如"RAG"、"Agent五层架构"、"数据治理"）；\n' +
          '   b) brief：一句话说明该知识点与这个能力项的关系（如"AI方案设计必须掌握的检索增强生成技术"）；\n' +
          '   c) source："terms"=来自下方术语库列表，"ai-knowledge"=术语库未覆盖但 AI 基于公开知识补充；\n' +
          '   d) 优先使用术语库列表中的术语，不足时可用 ai-knowledge 补充（如"本体建模""星辰智能体"等附件1提到但术语库未列的概念）；\n' +
          '   e) 不准编造可证伪的具体数字；知识点只列概念名称和关系说明，不展开原理。\n' +
          '8. 原文提取不到某条路径时，该路径输出空 items。\n\n' +
          '【参考术语库】（产数学习模块78个术语，优先从中选知识点）：' + termsSlim + '\n\n原文文本：\n' + text.slice(0, 60000);
        return AI.chat([{ role: 'user', content: prompt }], { temperature: 0.1, max_tokens: 40000, timeout: 480000 }).then(function (txt) {
        var j;
        try { j = extractJson(txt); } catch (e) { throw new Error('AI 输出不是有效 JSON：' + e.message); }
        var rows = [];
        (j.paths || []).forEach(function (p) {
          (p.items || []).forEach(function (it, i) {
            rows.push({
              id: DB.newId('cp'), path: p.path, code: it.code || String(i + 1),
              name: it.name || '', weight: it.weight || '原文未标注',
              type: it.type === 'resume' ? 'resume' : 'learning',
              evidence: it.evidence || '', standardSource: std.name,
              standardVersion: std.version, demo: false,
              focus: !!p.focus,
              knowledgePoints: it.knowledgePoints || [],
              addedAt: DB.nowIso()
            });
          });
        });
        if (!rows.length) throw new Error('AI 未提取到能力项，请检查原文是否包含三条路径');
        return DB.clear('competency').then(function () {
          return DB.bulkPut('competency', rows);
        }).then(function () {
          return DB.logEvent({ type: 'generate', payload: { action: 'extract_competency', n: rows.length, source: std.name } });
        }).then(function () {
          var kpCount = rows.reduce(function (s, r) { return s + (r.knowledgePoints || []).length; }, 0);
          toast('已提取 ' + rows.length + ' 个能力项（已补全 ' + kpCount + ' 个知识点，请人工对照原文校对）');
          renderCompetency();
          genBusyEnd();
        });
      });
      });
    }).catch(function (e) {
      toast('提取失败：' + (e && e.message || e), 5000);
      genBusyEnd();
    });
  }

  function loadDemoCompetency() {
    if (!confirm('载入演示模板能力树？它不是《附件1》真实权重，会醒目标注，用于先跑通流程。')) return;
    var demo = demoCompetency();
    DB.clear('competency').then(function () { return DB.bulkPut('competency', demo); }).then(function () {
      toast('已载入演示模板（醒目标注，不冒充真实标准）');
      renderCompetency();
    });
  }

  function demoCompetency() {
    var P = function (path, code, name, type, evidence) {
      return {
        id: DB.newId('cp'), path: path, code: code, name: name,
        weight: '示意（未从原文提取）', type: type, evidence: evidence,
        standardSource: '演示模板', standardVersion: '-', demo: true, addedAt: DB.nowIso()
      };
    };
    return [
      P('业务顾问 L4', 'D1', '行业与政策理解', 'learning', '能解读行业政策并转译为业务语言'),
      P('业务顾问 L4', 'D2', '客户需求洞察与引导', 'learning', '现场访谈/需求澄清记录'),
      P('业务顾问 L4', 'D3', '解决方案叙事与汇报', 'learning', '方案文档与汇报演示'),
      P('业务顾问 L4', 'D4', '商机识别与推进', 'learning', '商机登记与推进记录'),
      P('业务顾问 L4', 'D5', '大型项目签约金额', 'resume', '需真实项目履历证明，应用只提示你记录真实证据'),
      P('业务顾问 L4', 'D6', '标杆案例数量', 'resume', '需真实项目履历证明，应用只提示你记录真实证据'),
      P('行业解决方案 L4', 'F1', '解决方案架构设计', 'learning', '架构设计文档'),
      P('行业解决方案 L4', 'F2', '数据要素与数据资产方案', 'learning', '数据方案设计稿'),
      P('行业解决方案 L4', 'F3', '生态伙伴协同', 'learning', '联合方案记录'),
      P('行业解决方案 L4', 'F4', '行业模型设计', 'learning', '模型设计说明'),
      P('行业解决方案 L4', 'F5', '项目部署数量', 'resume', '需真实项目履历证明，应用只提示你记录真实证据'),
      P('产品能力运营 L3', 'Y1', '产品能力梳理与包装', 'learning', '能力清单与包装材料'),
      P('产品能力运营 L3', 'Y2', '培训与赋能交付', 'learning', '培训记录与课件'),
      P('产品能力运营 L3', 'Y3', '试点运营与迭代', 'learning', '试点数据与迭代记录'),
      P('产品能力运营 L3', 'Y4', '客户成功案例沉淀', 'learning', '案例文档')
    ];
  }

  function addCompetencyItem() {
    var rec = {
      id: DB.newId('cp'), path: $('cp-path').value, code: $('cp-code').value.trim() || '-',
      name: $('cp-name').value.trim(), weight: $('cp-weight').value.trim() || '原文未标注',
      type: $('cp-type').value, evidence: $('cp-evidence').value.trim(),
      standardSource: '人工录入', standardVersion: '-', demo: false, addedAt: DB.nowIso()
    };
    if (!rec.name) { toast('请填能力项名称'); return; }
    DB.put('competency', rec).then(function () { toast('已添加'); renderCompetency(); });
  }

  /* ================================================================
   * 视图：学习目标
   * ================================================================ */
  function renderGoals() {
    DB.latestGoals().then(function (g) {
      var c = TTS.loadCfg();
      var voicesHint = c.provider === 'minimax'
        ? 'MiniMax 音色 ID（如 male-qn-qingse / female-shaonv，具体以你账号可用音色为准）'
        : 'OpenAI 兼容音色（如 alloy / echo / nova…）';
      var html = '<div class="card"><h2>学习目标与偏好</h2>' +
        '<p class="sub">可随时修改；修改后重新生成课程草案即可生效。敏感问题可跳过不答。</p>' +
        '<div class="row">' +
        fld('认证路径', 'g-path', '业务顾问 L4', ['业务顾问 L4', '行业解决方案 L4', '产品能力运营 L3'], g && g.path, 'select') +
        fld('基础水平', 'g-base', '有实践', ['零基础', '了解概念', '有实践', '熟练'], g && g.baseLevel, 'select') +
        '</div><div class="row">' +
        fld('每天可学时间（分钟）', 'g-daily', 45, null, g && g.dailyMinutes, 'number') +
        fld('其中音频时长（分钟）', 'g-audio', 15, null, g && g.audioMinutes, 'number') +
        '</div><div class="row">' +
        fld('每周复盘日', 'g-review', '周日', ['周日', '周六', '周一', '周五'], g && g.reviewDay, 'select') +
        fld('音色', 'g-voice', '', null, g && g.voice, 'text', voicesHint) +
        fld('语速', 'g-speed', '1.0', [0.8, 1.0, 1.2, 1.5], g && g.speed, 'select') +
        '</div>' +
        '<button class="btn btn-primary" id="btn-goals-save">保存目标</button>' +
        '<div class="divider"></div>' +
        '<p class="note">音色/语速实际由「音频与数据」页的 TTS Provider 决定；这里的偏好会写入音频任务参数。外部履历类目标（项目金额、签约金额、部署数量、标杆案例数量）需要你的真实项目证据，应用只帮你记录证据清单，不会宣称你已达标或认证通过。</p>' +
        '</div>';
      $('view-goals').innerHTML = html;
      $('btn-goals-save').addEventListener('click', function () {
        var rec = {
          id: DB.newId('gl'),
          path: $('g-path').value,
          baseLevel: $('g-base').value,
          dailyMinutes: +$('g-daily').value || 45,
          audioMinutes: +$('g-audio').value || 15,
          reviewDay: $('g-review').value,
          voice: $('g-voice').value.trim(),
          speed: parseFloat($('g-speed').value) || 1.0,
          createdAt: (g && g.createdAt) || DB.nowIso(),
          updatedAt: DB.nowIso()
        };
        DB.put('goals', rec).then(function () {
          toast('目标已保存，可到「课程计划」生成/更新课程');
          renderGoals();
        });
      });
    }).catch(function (e) { $('view-goals').innerHTML = errHtml(e); });
  }

  function fld(label, id, ph, opts, val, type, hint) {
    var h = '<div class="field"><label>' + label + '</label>';
    if (type === 'select') {
      h += '<select id="' + id + '">' + opts.map(function (o) {
        var v = String(o), sel = (val !== undefined && val !== null && String(val) === v) ? ' selected' : '';
        return '<option value="' + esc(v) + '"' + sel + '>' + esc(v) + '</option>';
      }).join('') + '</select>';
    } else {
      h += '<input type="' + (type === 'number' ? 'number' : 'text') + '" id="' + id + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">';
    }
    if (hint) h += '<div class="hint">' + esc(hint) + '</div>';
    return h + '</div>';
  }

  /* ================================================================
   * 视图：课程计划
   * ================================================================ */
  function renderCourse() {
    Promise.all([DB.latestGoals(), DB.getAll('competency'), DB.activeCourse(), DB.getAll('courses'), DB.getAll('sources')]).then(function (r) {
      var goals = r[0], comps = r[1], course = r[2], allCourses = r[3], sources = r[4];
      var cases = sources.filter(function (s) { return s.status === 'parsed' && !s.isStandard; });
      var canGen = !!(goals && comps.length && cases.length);
      var missing = [];
      if (!goals) missing.push('<a href="#/goals">学习目标</a>');
      if (!comps.length) missing.push('<a href="#/competency">能力树</a>');
      if (!cases.length) missing.push('<a href="#/sources">≥1 份已解析案例</a>');
      var html = '<div class="card"><h2>生成 30 天课程草案</h2><div class="row">' +
        kv('学习目标', goals ? esc(goals.path) + ' · 每天 ' + esc(goals.dailyMinutes) + ' 分钟' : '<span class="tag red">未设置</span>') +
        kv('能力项', comps.length + ' 项' + (comps.some(function (c) { return c.demo; }) ? '（含演示模板）' : '')) +
        kv('案例资料', cases.length + ' 份') +
        '</div>' +
        '<div style="margin-top:10px"><button class="btn btn-primary" id="btn-course-gen" ' +
        (canGen ? '' : 'disabled') + '>生成课程草案</button>' +
        '<span class="muted" style="margin-left:10px;font-size:12px">生成需要：已保存目标 + 能力树 + ≥1 份已解析案例。成功生成后<b>需你确认才锁定</b>；重新生成会创建新版本，可与旧版对比。</span></div>' +
        (canGen ? '' : '<div class="alert warn" style="margin-top:10px"><b>还缺：</b>' + missing.join('；') + '。补齐后本按钮自动启用。</div>') +
        (aiReady() ? '' : '<div class="alert warn" style="margin-top:10px">AI 未配置：将生成<b>演示模板课程</b>（醒目标注、能力映射与案例关联不真实），仅用于跑通流程，不能作为备考依据。</div>') +
        '</div>';

      if (course) {
        var isDemo = !!course.demo;
        html += '<div class="card"><h2>当前' + (course.status === 'draft' ? '草案' : '正式课程') +
          ' · v' + course.version + (isDemo ? ' <span class="tag demo">演示模板</span>' : '') + '</h2>';
        if (isDemo) html += '<div class="demo-banner">演示模板课程：未由 AI 基于真实案例生成，主题为通用示意。请配置 AI 后重新生成正式课程。</div>';
        /* 版本对比（重新生成后） */
        if (course.status === 'draft' && allCourses.some(function (c) { return c.status === 'locked'; })) {
          var old = allCourses.filter(function (c) { return c.status === 'locked'; })
            .sort(function (a, b) { return b.confirmedAt.localeCompare(a.confirmedAt); })[0];
          html += '<div class="alert info"><b>与已锁定版 v' + old.version + ' 的差异：</b>' + diffDays(old.days, course.days) + '</div>';
        }
        html += '<table class="tbl course-tbl"><colgroup><col class="c-day"><col class="c-theme"><col class="c-comp"><col class="c-src"><col class="c-del"><col class="c-act"></colgroup><tr><th>天</th><th>主题</th><th>能力映射</th><th>案例来源</th><th>练习/产物</th><th>操作</th></tr>';
        course.days.forEach(function (d) {
          html += '<tr><td><b>' + d.day + '</b></td><td>' + esc(d.theme) + '</td>' +
            '<td style="font-size:12px">' + (d.competencyNames || []).map(function (n) { return esc(n); }).join('；') + '</td>' +
            '<td style="font-size:12px">' + ((d.sourceNames || []).map(function (n) { return esc(n); }).join('；') || '-') + '</td>' +
            '<td style="font-size:12px">' + esc(d.deliverable || '') + '</td>' +
            '<td class="c-act-cell"><button class="btn btn-sm btn-outline" data-editday="' + d.day + '">改主题</button> ' +
            '<button class="btn btn-sm btn-primary" data-lockday="' + d.day + '">生成教案</button></td></tr>';
        });
        html += '</table>';
        if (course.status === 'draft') {
          html += '<div style="margin-top:12px"><button class="btn btn-success" id="btn-course-lock">确认并锁定整个 30 天计划</button></div>';
        } else {
          html += '<div class="alert ok" style="margin-top:12px">已锁定于 ' + esc(course.confirmedAt || '') + '。点击任一天「生成教案」逐课生成教案；对已锁计划重新生成会另存草案，确认后才替换。</div>';
        }
        html += '</div>';
      }
      $('view-course').innerHTML = html;

      var gen = $('btn-course-gen');
      if (gen) gen.addEventListener('click', function () { generateCourse(goals, comps, cases); });
      var lock = $('btn-course-lock');
      if (lock) lock.addEventListener('click', function () { lockCourse(course); });
      $('view-course').querySelectorAll('[data-editday]').forEach(function (b) {
        b.addEventListener('click', function () {
          var day = +b.getAttribute('data-editday');
          var d = course.days[day - 1];
          var t = prompt('第 ' + day + ' 天主题（可修改草案）：', d.theme);
          if (t !== null && t.trim()) { d.theme = t.trim(); course.updatedAt = DB.nowIso(); DB.put('courses', course).then(renderCourse); }
        });
      });
      $('view-course').querySelectorAll('[data-lockday]').forEach(function (b) {
        b.addEventListener('click', function () {
          var day = +b.getAttribute('data-lockday');
          lockCourse(course).then(function () { location.hash = '#/lesson?day=' + day; });
        });
      });
    }).catch(function (e) { $('view-course').innerHTML = errHtml(e); });
  }

  function kv(k, v) {
    return '<div style="flex:1;min-width:200px;border:1px solid var(--line);padding:10px 14px;background:#fff">' +
      '<div class="muted" style="font-size:12px">' + k + '</div><div style="font-weight:700">' + v + '</div></div>';
  }

  function diffDays(oldDays, newDays) {
    var changes = [];
    var n = Math.max(oldDays.length, newDays.length);
    for (var i = 0; i < n; i++) {
      var a = oldDays[i] ? oldDays[i].theme : '(无)';
      var b = newDays[i] ? newDays[i].theme : '(无)';
      if (a !== b) changes.push('第' + (i + 1) + '天：' + a + ' → ' + b);
    }
    return changes.length ? changes.slice(0, 8).join('；') + (changes.length > 8 ? ' 等 ' + changes.length + ' 处' : '') : '每日主题无变化';
  }

  function generateCourse(goals, comps, cases) {
    if (!genBusyStart('正在生成 30 天课程草案', 'btn-course-gen')) return;
    var compJson = comps.map(function (c) { return { path: c.path, code: c.code, name: c.name, type: c.type }; });
    var caseBrief = cases.map(function (s) {
      return { id: s.id, name: s.name, summary: String(s.fullText || '').slice(0, 800) };
    });
    var finish = function (days, stats, demo) {
      var ver = 1;
      return DB.getAll('courses').then(function (all) {
        ver = all.length ? Math.max.apply(null, all.map(function (c) { return c.version || 1; })) + 1 : 1;
        /* 名称映射（幂等，repair 前后均可执行） */
        var nameMap = {};
        comps.forEach(function (c) { nameMap[c.code] = c.name; nameMap[c.name] = c.name; });
        var srcMap = {};
        cases.forEach(function (s) { srcMap[s.id] = s.name; });
        days.forEach(function (d) {
          d.competencyNames = (d.competencyIds || []).map(function (x) { return nameMap[x] || x; });
          d.sourceNames = (d.sourceIds || []).map(function (x) { return srcMap[x] || x; });
        });
        var rec = {
          id: DB.newId('co'), version: ver, status: 'draft', goalsId: goals.id,
          path: goals.path, demo: !!demo, days: days,
          createdAt: DB.nowIso(), updatedAt: DB.nowIso(), progress: { day: 1 }
        };
        return DB.put('courses', rec);
      }).then(function () {
        var msg = '草案已生成（v' + ver + '）';
        if (stats && (stats.src || stats.ex || stats.dl)) {
          var p = [];
          if (stats.src) p.push(stats.src + ' 天来源已自动检索补全');
          if (stats.ex) p.push(stats.ex + ' 天练习用模板补全');
          if (stats.dl) p.push(stats.dl + ' 天产物用模板补全');
          msg += '。' + p.join('，') + '（系统补全项已标待核实，请核对）';
        } else {
          msg += '，请核对后确认锁定';
        }
        toast(msg, 7000);
        renderCourse();
        genBusyEnd();
      });
    };

    if (!aiReady()) {
      /* 无 AI：演示模板（醒目标注），仍关联真实案例名但内容为通用框架 */
      var days = [];
      var cycle = ['原理讲解', '案例拆解', '完整解题示范', '变式练习', '复盘与迁移'];
      for (var i = 1; i <= 30; i++) {
        var theme = cycle[(i - 1) % 5] + '：' + (comps[(i - 1) % comps.length] ? comps[(i - 1) % comps.length].name : '主题');
        days.push({
          day: i, theme: theme, objectives: ['（演示模板）跑通学习流程'],
          competencyIds: comps.length ? [comps[(i - 1) % comps.length].code] : [],
          sourceIds: cases.length ? [cases[0].id] : [],
          exercise: '（演示模板）按当天主题写一页分析笔记',
          deliverable: '（演示模板）' + theme + ' 的分析记录一页',
          pendingVerify: true
        });
      }
      return finish(days, null, true);
    }

    /* ---- 分段生成 + 本地兜底补全（2026-10-06）----
     * 30 天拆成 1-15 / 16-30 两段分别调用：每段输出量减半，降低长输出被截断概率；
     * 合并后 repairDays 做字段级校验：缺 sourceIds 用本地 searchBlocks 按主题检索最相关案例，
     * 缺 exercise/deliverable 用系统模板补全并标 pendingVerify（诚实标注，不冒充 AI 设计）。 */
    function pickDays(list, from, to) {
      var seen = {}, out = [];
      (list || []).forEach(function (d) {
        var n = parseInt(d.day, 10);
        if (n >= from && n <= to && !seen[n]) { seen[n] = 1; d.day = n; out.push(d); }
      });
      out.sort(function (a, b) { return a.day - b.day; });
      return out;
    }
    function segPrompt(from, to, focus) {
      /* 2026-10-08 提示词整体重构：面向成人学习者的场景化课程设计（用户确认的优化版） */
      return '你是一名面向成人学习者的数字化与人工智能课程设计师，也是一名严谨的解决方案顾问。\n\n' +
        '你的任务是为学习者设计一个 30 天学习计划中的第 ' + from + '～' + to + ' 天。学习计划的目标不是罗列主题，而是帮助学习者逐步建立技术概念、架构理解、方案判断和客户沟通能力。\n' +
        '本段定位：' + focus + '\n\n' +
        '【学习者情况】\n' +
        '学习者有商务、市场、客户沟通和方案相关经验，但数字化、人工智能、数据技术和系统架构基础较弱。课程要从必要的技术基础讲起，不得假设学习者已经理解常见技术术语。学习者日常工作繁忙，主要利用音频学习，也会阅读教案、批注和复习。\n\n' +
        '【学习目标】\n' +
        '认证路径：' + goals.path + '\n' +
        '基础水平：' + goals.baseLevel + '\n' +
        '每天可投入：' + goals.dailyMinutes + ' 分钟，其中音频约 ' + goals.audioMinutes + ' 分钟。\n\n' +
        '【认证能力项】\n' +
        '以下能力项来自已导入的认证能力树。请按这些能力项设计映射，不得自行伪造认证能力项或认证要求。competencyIds 必须使用对应 code。\n' +
        JSON.stringify(compJson) + '\n\n' +
        '【可用项目案例资料】\n' +
        '以下是项目资料的简要摘要。sourceIds 必须使用真实资料 id。\n' +
        JSON.stringify(caseBrief) + '\n\n' +
        '资料中的“规划、建议、拟建、计划、目标、试点、评审中”等内容，不得写成已建成、已上线或已验收事实。摘要未提供的细节不得补造。必要时将主题设计为“基于现有证据的初步分析与待核实问题”。\n\n' +
        '【课程设计要求】\n' +
        '1. 按顺序设计每天课程，day 从 ' + from + ' 连续递增到 ' + to + '，不得遗漏、重复或超出范围。\n' +
        '2. 每天只设置一个主要学习主题，避免把多个大主题塞进一课。\n' +
        '3. 课程整体应从基础概念和技术全景逐步进入组件机制、架构设计、项目案例、方案比较、客户交流和综合实战。\n' +
        '4. 先修概念应先于依赖它的主题。涉及新术语时，主题名称或 objectives 中要明确说明这是入门理解、机制理解、方案比较还是综合应用。\n' +
        '5. 每个技术主题都应服务于认证能力、实际项目理解或客户沟通，不安排与目标无关的纯知识堆砌。\n' +
        '6. 在适合的课程中穿插术语复习、前课回忆和跨主题综合练习。课程后半段要安排综合任务，要求学习者把多个概念连接起来。\n' +
        '7. 每天必须包含：\n' +
        '   - objectives：2～4 条可观察、可检查的学习目标；\n' +
        '   - exercise：一道可以实际完成的练习，优先使用项目材料；\n' +
        '   - deliverable：一个可评价的工作产物，例如术语解释卡、架构草图、接口问题清单、方案比较表、客户访谈提纲或汇报稿；\n' +
        '   - competencyIds：相关认证能力项 code；\n' +
        '   - sourceIds：相关真实资料 id。\n' +
        '8. 练习和产物必须适合学习者当前水平。若任务需要尚未讲授的概念，必须先安排先修课程。\n' +
        '9. 案例资料不足时，不得用关键词命中来假装案例与主题相关。当天 pendingVerify=true，并在 objectives 中写明“待核实：……”。\n' +
        '10. 履历类能力项涉及金额、项目数、部署数、签约额、标杆案例数等真实经历时，deliverable 只能要求整理学习者自己的真实证据，不得替学习者宣称达标。\n' +
        '11. 不得编造案例事实、认证标准、项目成果、数字或客户情况。\n' +
        '12. 课程要为后续教案和音频讲稿提供足够明确的教学方向。主题不能只写“学习某技术”或“了解某平台”，要指出当天要理解的具体问题。\n\n' +
        '【课程节奏参考】\n' +
        '按整体学习进度安排以下类型的活动，而非每天机械重复同一个模板：\n' +
        '- 建立技术全景与基础词汇；\n' +
        '- 理解核心机制和组件关系；\n' +
        '- 使用真实项目材料分析问题与方案；\n' +
        '- 比较设计选项、适用边界、收益和代价；\n' +
        '- 完成案例练习并形成可复用工作产物；\n' +
        '- 回忆、纠错、复习和综合迁移；\n' +
        '- 练习向客户解释、澄清需求和提出技术问题。\n\n' +
        '【输出格式】\n' +
        '只输出严格 JSON，不要 Markdown 代码围栏或额外说明。\n\n' +
        'JSON 结构必须是：\n' +
        '{\n' +
        '  "days": [\n' +
        '    {\n' +
        '      "day": ' + from + ',\n' +
        '      "theme": "当天具体主题",\n' +
        '      "objectives": ["可检查的学习目标"],\n' +
        '      "competencyIds": ["能力项code"],\n' +
        '      "sourceIds": ["真实资料id"],\n' +
        '      "exercise": "当天练习",\n' +
        '      "deliverable": "当天可评价产物",\n' +
        '      "pendingVerify": false\n' +
        '    }\n' +
        '  ]\n' +
        '}\n\n' +
        '只输出本次要求范围内的 days。不得更改字段名称或增添 JSON 字段。';
    }
    /* 本地兜底补全：缺来源自动检索最相关案例；缺练习/产物用稳定模板（标 pendingVerify） */
    function repairDays(days) {
      var stats = { src: 0, ex: 0, dl: 0 };
      /* 中文主题/能力名 → 关键词集（整词 + 3~4 字 ngram，避免整句匹配失败） */
      function ngramKeys(text) {
        var s = String(text || '').replace(/[，。；：、\s\-–—（）()《》「」…·,.:;]+/g, ' ').split(' ').filter(Boolean);
        var keys = {};
        s.forEach(function (p) {
          if (p.length >= 2) keys[p] = 1;
          for (var n = 3; n <= 4 && p.length >= n; n++) {
            for (var i = 0; i + n <= p.length; i++) keys[p.slice(i, i + n)] = 1;
          }
        });
        return Object.keys(keys);
      }
      function calcScore(text, keys) {
        var t = String(text || '');
        if (!t) return 0;
        var score = 0;
        keys.forEach(function (k) {
          var idx = t.indexOf(k);
          if (idx >= 0) {
            score += k.length >= 4 ? k.length * 2 : 1;
            if (idx < 300) score += 2; /* 标题/开头加权 */
          }
        });
        return score;
      }
      days.forEach(function (d) {
        var hasSrc = (d.sourceIds || []).some(function (id) { return cases.some(function (s) { return s.id === id; }); });
        if (!hasSrc) {
          var keys = ngramKeys((d.theme || '') + ' ' + (d.competencyNames || []).join(' '));
          var best = null, bestScore = 0;
          cases.forEach(function (s) {
            var sc = calcScore(s.fullText || (s.pageTexts || []).join('\n'), keys);
            if (sc > bestScore) { best = s.id; bestScore = sc; }
          });
          d.sourceIds = best ? [best] : [];
          d.pendingVerify = true;
          stats.src++;
        }
        if (!d.exercise || !String(d.exercise).trim()) {
          d.exercise = '（系统补全）按当天主题在案例资料中找一段真实内容，写一页分析笔记（概念、推断、结论各一条）。';
          d.pendingVerify = true; stats.ex++;
        }
        if (!d.deliverable || !String(d.deliverable).trim()) {
          d.deliverable = '（系统补全）整理当天证据记录一页（含案例出处与待核实项）。';
          d.pendingVerify = true; stats.dl++;
        }
      });
      return stats;
    }

    genBusyUpdate({ msg: '正在生成 30 天课程草案（第 1/2 段：第 1~15 天）' });
    return AI.chat([{ role: 'user', content: segPrompt(1, 15, '本段为课程前半程：优先安排学习项能力的课程学习与案例拆解，可穿插基础履历项的证据整理。') }],
        { temperature: 0.4, max_tokens: 40000, timeout: 600000 })
      .then(function (c1) {
        var part1 = pickDays(extractJson(c1).days || [], 1, 15);
        if (part1.length < 15) throw new Error('AI 第 1~15 天只返回 ' + part1.length + ' 天，不满足 15 天');
        genBusyUpdate({ msg: '正在生成 30 天课程草案（第 2/2 段：第 16~30 天）' });
        return AI.chat([{ role: 'user', content: segPrompt(16, 30, '本段为课程后半程：以履历项的证据整理与综合实战、复盘迁移为主，兼顾未覆盖的学习项。') }],
            { temperature: 0.4, max_tokens: 40000, timeout: 600000 })
          .then(function (c2) {
            var part2 = pickDays(extractJson(c2).days || [], 16, 30);
            if (part2.length < 15) throw new Error('AI 第 16~30 天只返回 ' + part2.length + ' 天，不满足 15 天');
            var days = part1.concat(part2);
            var nameMap = {};
            comps.forEach(function (c) { nameMap[c.code] = c.name; nameMap[c.name] = c.name; });
            days.forEach(function (d) { d.competencyNames = (d.competencyIds || []).map(function (x) { return nameMap[x] || x; }); });
            var stats = repairDays(days);
            return finish(days, stats, false);
          });
      }).catch(function (e) {
        toast('课程生成失败：' + (e && e.message || e) + '。可检查 AI 配置或稍后重试', 6000);
        genBusyEnd();
      });
  }

  function lockCourse(course) {
    if (course.status === 'locked') return Promise.resolve();
    if (!confirm('确认锁定该 30 天计划？锁定后即可逐课生成教案与音频；仍可在画像/反馈中调整学习，但课程目标结构不再变更。')) return Promise.resolve();
    course.status = 'locked';
    course.confirmedAt = DB.nowIso();
    course.updatedAt = DB.nowIso();
    return DB.put('courses', course).then(function () {
      toast('课程已锁定，进入课程计划点任意天生成教案');
      renderCourse();
    });
  }

  /* ================================================================
   * 视图：课程（教案） lesson
   * ================================================================ */
  function renderLesson() {
    var day = state.day;
    DB.activeCourse().then(function (course) {
      if (!course || course.status !== 'locked') {
        $('view-lesson').innerHTML = '<div class="alert warn">请先在「课程计划」确认锁定课程，再进入课程学习。<button class="btn btn-sm btn-ghost" onclick="location.hash=\'#/course\'">去课程计划</button></div>';
        return;
      }
      var d = course.days[day - 1];
      if (!d) { $('view-lesson').innerHTML = '<div class="alert warn">没有第 ' + day + ' 天</div>'; return; }
      DB.lessonOf(course.id, day).then(function (lesson) {
        if (!lesson) { renderLessonView(course, d, lesson, {}); return; }
        /* 段落标记状态回显：显式反馈事件按时间序取最新（含取消标记 label=''）。
           用 events 而非 profile：payload.label 能区分「不确定」与「需练习」（profile 里都是 uncertain），
           且历史点过的标记全部能精确回显，无需重新点 */
        DB.byIndex('events', 'lessonId', lesson.id).then(function (evs) {
          var fbMap = {};
          (evs || []).filter(function (e) { return e.type === 'feedback' && e.origin === 'explicit' && e.concept; })
            .sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); })
            .forEach(function (e) { fbMap[e.concept] = (e.payload && e.payload.label) || ''; });
          renderLessonView(course, d, lesson, fbMap);
        });
      });
    }).catch(function (e) { $('view-lesson').innerHTML = errHtml(e); });
  }

  function renderLessonView(course, d, lesson, fbMap) {
    fbMap = fbMap || {};
    /* 重渲染保留滚动位置（标记一段不应把视图甩回页顶） */
    var keepScroll = window.scrollY || document.documentElement.scrollTop || 0;
    var day = d.day;
    var prev = Math.max(1, day - 1), next = Math.min(30, day + 1);
    var html = '<div class="topbar" style="border-bottom:1px solid var(--line);padding-bottom:10px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
      '<div><b style="font-size:18px">第 ' + day + ' 天 · ' + esc(d.theme) + '</b>' +
      (lesson && lesson.demo ? ' <span class="tag demo">演示教案</span>' : '') + '</div>' +
      '<div><button class="btn btn-sm btn-outline" onclick="location.hash=\'#/lesson?day=' + prev + '\'">前一天</button> ' +
      '<button class="btn btn-sm btn-outline" onclick="location.hash=\'#/lesson?day=' + next + '\'">后一天</button> ' +
      '<button class="btn btn-sm btn-ghost" onclick="location.hash=\'#/course\'">课程计划</button></div></div>';

    if (!lesson) {
      var styles = allStyles();
      var defId = getDefaultStyleId();
      html += '<div class="card"><h2>生成教案</h2><p class="sub">教案将包含：带页/段引用的正文、术语解释、完整解题示范、回忆题、变式练习与当日工作物。<b>音频讲稿会按所选授课风格生成，可反复听。</b></p>' +
        '<div class="field" style="margin-bottom:12px"><label>授课风格</label>' +
        '<select id="sel-lesson-style" style="width:100%;max-width:380px">' +
        styles.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === defId ? ' selected' : '') + '>' + esc(s.name) + (s.desc ? ' · ' + esc(s.desc.slice(0, 30)) + (s.desc.length > 30 ? '…' : '') : '') + '</option>'; }).join('') +
        '</select>' +
        '<div class="hint" id="style-hint" style="margin-top:6px;font-size:12px;color:var(--ink2)">' + esc(getStyle(defId).desc) + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-sm btn-outline" id="btn-style-set-default">设为默认风格</button>' +
        '<button class="btn btn-sm btn-outline" id="btn-style-custom">自定义风格（粘贴讲稿让 AI 提炼）</button>' +
        '<button class="btn btn-sm btn-ghost" id="btn-style-manage">管理自定义风格</button>' +
        '</div></div>' +
        '<button class="btn btn-primary" id="btn-lesson-gen">按所选风格生成第 ' + day + ' 天教案</button>' +
        (aiReady() ? '' : '<div class="alert warn" style="margin-top:10px">AI 未配置：将生成<b>演示教案</b>（引用片段来自真实案例检索，讲解文字为模板示意并醒目标注）。</div>') +
        '</div>';
      $('view-lesson').innerHTML = html;
      $('btn-lesson-gen').addEventListener('click', function () {
        var sid = $('sel-lesson-style').value;
        generateLesson(course, d, sid);
      });
      $('sel-lesson-style').addEventListener('change', function () {
        var s = getStyle(this.value);
        $('style-hint').textContent = s.desc || '';
      });
      $('btn-style-set-default').addEventListener('click', function () {
        setDefaultStyleId($('sel-lesson-style').value);
        toast('已设为默认授课风格');
      });
      $('btn-style-custom').addEventListener('click', openCustomStyleDialog);
      $('btn-style-manage').addEventListener('click', openManageStylesDialog);
      return;
    }

    /* ===== 教案正文 ===== */
    /* 本课标记汇总：让用户一眼看到「点了多少、都记住了」 */
    var fbCnt = { '没懂': 0, '不确定': 0, '需练习': 0, '已掌握': 0 };
    lesson.sections.forEach(function (sec) {
      var c = fbMap[sec.heading];
      if (c && fbCnt[c] != null) fbCnt[c]++;
    });
    var fbMarked = fbCnt['没懂'] + fbCnt['不确定'] + fbCnt['需练习'] + fbCnt['已掌握'];
    var fbSummary = fbMarked
      ? '已标记 ' + fbMarked + '/' + lesson.sections.length + ' 段 · 没懂 ' + fbCnt['没懂'] + ' · 不确定 ' + fbCnt['不确定'] + ' · 需练习 ' + fbCnt['需练习'] + ' · 已掌握 ' + fbCnt['已掌握']
      : '还没有标记——每段读完在段末选择掌握状态，标记会进入复习计划与学习画像';
    html += '<div class="card"><h2>教案正文</h2>' +
      '<p class="sub" style="margin-top:-4px">状态回显 · 本课 ' + lesson.sections.length + ' 段 · ' + fbSummary + '</p>';
    lesson.sections.forEach(function (sec, si) {
      var ev = sec.evidence === 'fact' ? 'evidence-fact' : sec.evidence === 'inference' ? 'evidence-infer' : 'evidence-sim';
      var evTag = sec.evidence === 'fact' ? '<span class="tag green">来源事实</span>'
        : sec.evidence === 'inference' ? '<span class="tag gold">推断</span>' : '<span class="tag blue">课堂假设/模拟</span>';
      /* 当前段标记状态（回显） */
      var cur = fbMap[sec.heading] || '';
      var fbBadge = cur === '没懂' ? '<span class="tag red">没懂</span>'
        : cur === '不确定' ? '<span class="tag gold">不确定</span>'
        : cur === '需练习' ? '<span class="tag blue">需练习</span>'
        : cur === '已掌握' ? '<span class="tag green">已掌握</span>' : '';
      html += '<div class="' + ev + '" style="padding:10px 12px;margin:10px 0">' +
        '<h4>' + esc(sec.heading) + ' ' + evTag + (fbBadge ? ' ' + fbBadge : '') + '</h4>';
      (sec.paragraphs || []).forEach(function (p) {
        html += '<p>' + esc(p) + '</p>';
      });
      (sec.terms || []).forEach(function (t) {
        html += '<p style="font-size:13px"><span class="term">【' + esc(t.term) + '】</span>' + esc(t.explain) + '</p>';
      });
      if (sec.cites && sec.cites.length) {
        html += '<div class="cite">引用：' + sec.cites.map(function (c, i) {
          return '<a href="#" data-cite="' + day + '|' + si + '|' + i + '">' + esc(c.sourceName || '来源') + (c.anchor ? '（' + (c.anchor.slide != null ? '幻灯片 ' + c.anchor.slide : c.anchor.para != null ? '段落 ' + c.anchor.para : '页 ' + (c.anchor.page || '?')) + '）' : '') + '</a>';
        }).join('；') + '</div>';
      }
      /* 显式反馈按钮（每节）：单选状态器——选中的实心高亮，可改可取消（2026-10-08 状态回显改造） */
      var FB_DEFS = [
        { l: '没懂', cls: 'btn-danger', txt: '这段没懂' },
        { l: '不确定', cls: 'btn-outline', txt: '不确定' },
        { l: '需练习', cls: 'btn-outline', txt: '需练习' },
        { l: '已掌握', cls: 'btn-success', txt: '已掌握' }
      ];
      html += '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">' +
        FB_DEFS.map(function (o) {
          var on = o.l === cur;
          return '<button class="btn btn-sm ' + o.cls + (on ? ' fb-active' : '') + '" data-fb="' + o.l + '" data-sec="' + si + '" aria-pressed="' + on + '">' + (on ? '✓ ' : '') + o.txt + '</button>';
        }).join('') +
        (cur ? '<span style="font-size:12px;color:var(--ink2)">已标记「' + esc(cur) + '」· 点其他按钮可改 · 再点一次可取消</span>' : '') +
        '</div></div>';
    });
    /* 自适应补充（替代解释） */
    (lesson.adaptive || []).forEach(function (ad) {
      html += '<div class="card" style="border-left:4px solid var(--blue)"><h2>替代解释（你选择了：' + esc(ad.pref) + '）</h2>' +
        '<p class="sub">原因：' + esc(ad.reason) + ' · 生成于 ' + esc(ad.at) + (ad.demo ? ' · <b>演示内容</b>' : ' · AI 生成') + '</p>' +
        '<div style="white-space:pre-wrap">' + esc(ad.text) + '</div>' +
        (ad.variant ? '<div class="divider"></div><p><b>变式题：</b>' + esc(ad.variant) + '</p>' : '') +
        '</div>';
    });
    html += '</div>';

    /* ===== 回忆题 / 变式练习 / 工作物 ===== */
    html += '<div class="card"><h2>回忆题 / 变式练习 / 当日工作物</h2>' +
      '<h4>回忆题（合上教案回答）</h4><ol>' + (lesson.recall || []).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>' +
      '<h4>变式练习</h4><ol>' + (lesson.variants || []).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>' +
      '<h4>当日工作物（可评价）</h4><p>' + esc(lesson.deliverable || d.deliverable || '') + '</p>' +
      (lesson.pendingVerify ? '<div class="alert warn">本课存在<b>待核实</b>项：案例材料对该主题证据不足，请查证后再作为事实使用。</div>' : '') +
      '</div>';

    /* ===== 删除本课重选风格生成 ===== */
    html += '<div class="card"><h2>重选风格重生本课教案</h2>' +
      '<p class="sub">如果这课教案是旧版生成的（没有授课风格），或你想换风格重生：删除本课教案后可重选风格重新生成。</p>' +
      '<p class="sub warn">注意：删除后本课的音频任务/音频文件/批注/事件/复习/画像条目会一并清除（资料库原件保留）。</p>' +
      '<button class="btn btn-danger btn-sm" id="btn-lesson-del-regen">删除本课教案并重选风格生成</button></div>';

    /* ===== 音频区 ===== */
    var scriptSegs = splitAudioScript(lesson.audioScript || []).filter(function (s) { return s && s.text; });
    html += '<div class="card"><h2>课程音频</h2>' +
      '<p class="sub">分段合成真实 MP3（云端 TTS）与 WAV（本机重编码）；任务可取消/重试，文件头校验不过不能下载。合并下载 = 本机把各段拼成整课单个 MP3（离线编码，不新增联网）。</p>' +
      '<button class="btn btn-primary" id="btn-audio-gen">生成本课音频（MP3 + WAV）</button> ' +
      '<button class="btn btn-outline" id="btn-audio-merge">合并下载整课音频（MP3）</button> ' +
      '<button class="btn btn-outline" id="btn-audio-download-all">下载全部音频（ZIP）</button>' +
      (scriptSegs.length
        ? '<details style="margin-top:14px;border:1px solid var(--line);border-radius:8px;padding:10px 12px"><summary style="cursor:pointer;font-weight:600">查看本课语音讲稿全文（音频实际内容 · ' + scriptSegs.length + ' 段）</summary>' +
          '<p class="sub" style="margin-top:8px">讲稿是合成语音时朗读的内容：按授课风格口语化改写，与教案正文是两套写法——正文适合逐字阅读核对，讲稿适合反复听。两套都覆盖同一课的知识点，但句子不会逐字对应。</p>' +
          scriptSegs.map(function (s, i) {
            return '<p style="margin:8px 0"><span style="color:var(--ink2);font-size:13px">段 ' + (i + 1) + '</span>　' + esc(s.text) + '</p>';
          }).join('') + '</details>'
        : '') +
      '<div id="audio-tasks" style="margin-top:14px"></div></div>';

    /* ===== 删除本课教案重选风格生成（事件绑定移至 bindLessonEvents，在 innerHTML 设置之后） ===== */

    var srcIds = d.sourceIds || [];
    if (srcIds.length) {
      html += '<div class="card"><h2>本课案例来源（原件只读）</h2>' +
        srcIds.map(function (sid) {
          return '<button class="btn btn-outline btn-sm" data-opensrc="' + sid + '" style="margin:4px">打开阅读并批注</button>';
        }).join('') +
        '<p class="note">批注支持：高亮、下划线、自由绘制、文字批注与「没懂/不确定/需练习/已掌握」标签；批注锚定页/段/幻灯片，导出的是副本，原件不会被修改。</p></div>';
    }

    html += '<div id="modal-root"></div>';
    $('view-lesson').innerHTML = html;
    saveLast({ view: 'lesson', day: day });
    try { window.scrollTo(0, keepScroll); } catch (e) { }

    bindLessonEvents(course, d, lesson, fbMap);
    renderAudioTasks(lesson.id);
  }

  function bindLessonEvents(course, d, lesson, fbMap) {
    fbMap = fbMap || {};
    /* 删除本课教案重选风格生成（必须在 innerHTML 设置之后绑定，否则按钮不在 DOM） */
    var btnDelRegen = $('btn-lesson-del-regen');
    if (btnDelRegen) btnDelRegen.addEventListener('click', function () {
      if (!confirm('删除本课教案及其全部派生数据（音频/批注/事件/复习/画像条目），然后重选风格重新生成？资料库原件保留。此操作不可撤销。')) return;
      var lid = lesson.id;
      Promise.all([
        DB.byIndex('audioTasks', 'lessonId', lid),
        DB.getAll('audioFiles'), DB.getAll('annotations'), DB.getAll('events'),
        DB.getAll('reviews'), DB.getAll('profile')
      ]).then(function (r) {
        var tasks = r[0], files = r[1], anns = r[2], evs = r[3], rvs = r[4], pfs = r[5];
        var chain = Promise.resolve();
        tasks.forEach(function (t) { chain = chain.then(function () { return DB.del('audioTasks', t.id); }); });
        files.filter(function (f) { return f.lessonId === lid; }).forEach(function (f) { chain = chain.then(function () { return DB.del('audioFiles', f.id); }); });
        anns.filter(function (a) { return a.lessonId === lid; }).forEach(function (a) { chain = chain.then(function () { return DB.del('annotations', a.id); }); });
        evs.filter(function (e) { return e.lessonId === lid; }).forEach(function (e) { chain = chain.then(function () { return DB.del('events', e.id); }); });
        rvs.filter(function (v) { return v.lessonId === lid; }).forEach(function (v) { chain = chain.then(function () { return DB.del('reviews', v.id); }); });
        pfs.filter(function (p) { return (p.evidence || '').indexOf(lid) >= 0; }).forEach(function (p) { chain = chain.then(function () { return DB.del('profile', p.id); }); });
        chain = chain.then(function () { return DB.del('lessons', lid); });
        return chain;
      }).then(function () {
        toast('已删除本课教案，请重选风格生成');
        location.hash = '#/lesson?day=' + d.day;
        setTimeout(function () { location.reload(); }, 300);
      }).catch(function (e) { toast('删除失败：' + (e && e.message || e), 5000); });
    });

    /* 引用点击 -> 打开对应来源 */
    $('view-lesson').querySelectorAll('[data-cite]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var p = a.getAttribute('data-cite').split('|');
        var sec = lesson.sections[+p[1]];
        var cite = sec && sec.cites && sec.cites[+p[2]];
        if (cite) openReader(cite.sourceId, lesson.id);
        else toast('该引用的来源已被删除，无法跳转');
      });
    });
    $('view-lesson').querySelectorAll('[data-opensrc]').forEach(function (b) {
      b.addEventListener('click', function () { openReader(b.getAttribute('data-opensrc'), lesson.id); });
    });
    /* 显式反馈：点已选中的=取消标记；点未选中/不同的=正常反馈流程（换状态） */
    $('view-lesson').querySelectorAll('[data-fb]').forEach(function (b) {
      b.addEventListener('click', function () {
        var label = b.getAttribute('data-fb');
        var secIdx = +b.getAttribute('data-sec');
        var sec = lesson.sections[secIdx];
        var cur = sec ? (fbMap[sec.heading] || '') : '';
        if (cur === label && label) { removeFeedback(course, d, lesson, label, secIdx); return; }
        feedbackFlow(label, secIdx, course, d, lesson);
      });
    });
    /* 音频 */
    $('btn-audio-gen').addEventListener('click', function () { genLessonAudio(course, d, lesson); });
    $('btn-audio-download-all').addEventListener('click', function () { downloadAllAudio(lesson.id, d.day); });
    /* 合并整课音频：本机解码各段并编码为单个 MP3（lamejs 本地库，无新增出网） */
    $('btn-audio-merge').addEventListener('click', function () {
      var btn = $('btn-audio-merge');
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = '合并中…（本机编码，页面可能短暂无响应）';
      TTS.mergeLessonAudio(lesson.id).then(function (r) {
        var nm = '第' + d.day + '天_整课音频_' + new Date().toISOString().slice(0, 10) + '.mp3';
        TTS.downloadBlob(r.blob, nm);
        var msg = '已合并下载整课音频：' + fmtSize(r.size) + ' · ' + r.durationSec + 's · ' + r.sampleRate + 'Hz · ' + r.segs + ' 段';
        if (r.skipped && r.skipped.length) msg += '（以下段无法解码已跳过：段 ' + r.skipped.map(function (s) { return s + 1; }).join('、') + '）';
        toast(msg, 6000);
        DB.logEvent({ type: 'listen', lessonId: lesson.id, payload: { action: 'merge-download', size: r.size, durationSec: r.durationSec, skipped: r.skipped } });
      }).catch(function (e) {
        toast('合并失败：' + (e && e.message || e), 6000);
      }).then(function () {
        btn.disabled = false; btn.textContent = '合并下载整课音频（MP3）';
      });
    });
  }

  /* 清洗 audioScript 段首“元标签”（时间戳/第X段/【X分钟】等），保证合成为连续课堂；只去段首，不触碰正文 */
  function cleanAudioSeg(text) {
    var t = String(text || '');
    var re = [
      /^\s*(?:\[)?\s*\d{1,2}[:：]\d{2}\s*(?:[-~至到]\s*\d{1,2}[:：]\d{2})?\s*(?:\])?\s*[:：]?\s*/,
      /^\s*第\s*\d+\s*(?:部分|章节|小节|段|节|章)\s*(?:[:：、,，.．\-])?\s*/,
      /^\s*[【\[]\s*[^】\]]{1,14}?[】\]]\s*(?:[:：])?\s*/,
      /^\s*[（(]\s*\d+\s*(?:分钟|秒|分|s)\s*[)）]\s*/,
      /^\s*\d{1,2}\s*[.．、]\s*/
    ];
    var changed = true, guard = 0;
    while (changed && guard < 8) {
      changed = false; guard++;
      for (var i = 0; i < re.length; i++) {
        var m = t.match(re[i]);
        if (m && m[0]) { t = t.slice(m[0].length); changed = true; break; }
      }
    }
    return t;
  }

  /* 兜底分段：若教案 audioScript 被 AI 写成一个超大单段（违反“每段 2~4 句”），
     按句子边界拆成每段 1~2 句的连续多段。只改分段粒度，绝不改动任何文字：
     逐段按序拼接必须与原文本逐字一致，不一致则原样保留（不把正确的改坏）。 */
  function splitAudioScript(script) {
    var arr = (script || []).filter(function (s) { return s && s.text; });
    if (arr.length !== 1) return script;          /* 0 段或多段：不动 */
    var text = arr[0].text;
    if (text.length <= 240) return script;        /* 短课：一段可听，不动 */
    var parts = [], buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      buf += ch;
      if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '；' || ch === ';') {
        parts.push(buf); buf = '';
      }
    }
    if (buf) parts.push(buf);
    if (parts.length < 3) return script;           /* 无/少句边界，拆不动，保持原样 */
    var segs = [];
    for (var k = 0; k < parts.length; k += 2) segs.push({ text: parts.slice(k, k + 2).join('') });
    if (segs.length < 2) return script;
    /* 拼接校验：各段按序拼接必须与原文本完全一致，否则原样返回 */
    if (segs.map(function (x) { return x.text; }).join('') !== text) return script;
    return segs;
  }
  /* 暴露给 tts.js（合并下载）共用：旧教案重生成音频后段数已变，合并需按同一规则核对预期段数 */
  window.SZSplitAudioScript = splitAudioScript;

  /* ============ 教案生成 ============ */
  function generateLesson(course, d, styleId) {
    var style = getStyle(styleId || getDefaultStyleId());
    if (!genBusyStart('正在按「' + style.name + '」风格生成第 ' + d.day + ' 天教案', 'btn-lesson-gen')) return;
    DB.getAll('sources').then(function (srcs) {
      /* 检索：主题+能力名，在案例全文找片段 */
      var q = d.theme + ' ' + (d.competencyNames || []).join(' ');
      var evidences = [];
      (d.sourceIds || []).forEach(function (sid) {
        var s = srcs.find(function (x) { return x.id === sid; });
        if (!s) return;
        var model = { pages: (s.pageTexts || []).map(function (t, i) { return { num: i + 1, blocks: [{ type: 'para', text: t, anchor: s.anchorType === 'slide' ? { slide: i + 1 } : s.anchorType === 'para' ? { para: 0 } : { page: i + 1 } }] }; }) };
        PARSE.searchBlocks(model, q, 6).forEach(function (h) {
          evidences.push({ sourceId: s.id, sourceName: s.name, anchor: h.anchor, text: h.text });
        });
      });

      var finish = function (ls, demo) {
        var rec = {
          id: DB.newId('ls'), courseId: course.id, day: d.day, title: d.theme,
          sections: ls.sections || [], recall: ls.recall || [], variants: ls.variants || [],
          deliverable: ls.deliverable || d.deliverable || '',
          audioScript: splitAudioScript((ls.audioScript || []).map(function (s) { return { text: cleanAudioSeg(s.text) }; })),
          pendingVerify: demo ? true : (ls.pendingVerify != null ? !!ls.pendingVerify : !!d.pendingVerify),
          demo: !!demo, version: 1, generatedAt: DB.nowIso(), adaptive: []
        };
        return DB.put('lessons', rec).then(function () {
          return DB.logEvent({ type: 'generate', lessonId: rec.id, payload: { action: 'lesson', day: d.day, demo: !!demo } });
        }).then(function () {
          toast('教案已生成');
          renderLesson();
          genBusyEnd();
        });
      };

      if (!aiReady()) {
        /* 演示教案：引用真实检索片段，讲解为模板 */
        var ev0 = evidences.slice(0, 2);
        var sections = [{
          heading: '一、原理（演示模板：配置 AI 后由真实内容生成）',
          evidence: 'sim', paragraphs: [
            '（演示模板）本节讲解：' + d.theme + '。先讲这个概念的原理：它解决什么问题、适用边界在哪里。配置 AI 服务后，这里会基于《附件1》与真实案例生成完整讲解，并对专业术语给出通俗解释。'
          ],
          terms: builtinTerms(q),
          cites: ev0.map(function (e) { return { sourceId: e.sourceId, sourceName: e.sourceName, anchor: e.anchor, quote: e.text }; })
        }];
        return finish({
          sections: sections,
          recall: ['（演示）用一句话说出 ' + d.theme + ' 解决什么问题'],
          variants: ['（演示）给 ' + d.theme + ' 举一个你身边的例子'],
          deliverable: d.deliverable || '（演示）一页分析记录',
          audioScript: sections.map(function (s2) { return { text: s2.heading + '。' + s2.paragraphs.join('') }; })
        }, true);
      }

      /* 2026-10-08 提示词整体重构（用户确认的优化版）：角色重定义 + 分节结构化要求 + 风格不降深度约束 +
       * 证据锚点原样回传（evidences 的 anchor 已含页/幻灯片/段落定位）+ 外部案例可核验来源约束 + pendingVerify 语义 */
      var prompt = '你是一名数字化与人工智能领域的课程教师、解决方案顾问和成人学习设计师。\n\n' +
        '请为学习者设计第 ' + d.day + ' 天的完整教案。教案要帮助学习者真正理解技术概念和设计取舍，并能将所学用于项目分析和客户交流。学习者会听音频，也会阅读和批注教案，因此正文与音频讲稿都必须完整、清楚、可独立学习。\n\n' +
        '【当天课程】\n' +
        '主题：' + d.theme + '\n' +
        '学习目标：' + (d.objectives || []).join('；') + '\n' +
        '认证能力映射：' + (d.competencyNames || []).join('；') + '\n' +
        '学习时间：每天约 ' + (course.goalsDailyMinutes || 45) + ' 分钟；学习者主要利用碎片时间听音频，也会阅读教案。\n\n' +
        '【学习者情况】\n' +
        '学习者有商务、市场、客户沟通和方案相关经验，但数字化、人工智能、数据技术和系统架构基础较弱。不得假设学习者已经理解技术术语。解释技术时要准确、通俗、逐步建立概念；不能因为学习者有工作经验就跳过技术基础。\n' +
        '可以使用简短类比帮助入门，但类比之后必须补充真实的技术解释，说明类比的边界。不得让类比替代机制说明。\n\n' +
        '【项目材料证据】\n' +
        '以下内容是从已导入项目资料中检索到的原文证据，每条含 sourceId、sourceName、anchor（页/幻灯片/段落定位）和 text（原文片段）。引用时必须忠实于提供的原文：cites 必须原样带回对应证据的 sourceId、sourceName 和 anchor，quote 照抄证据原文，不得改写成原文没有的事实。若证据不足，明确标注待核实。\n' +
        JSON.stringify(evidences.slice(0, 8)) + '\n\n' +
        '【授课风格】\n' +
        '风格名称：' + style.name + '\n' +
        '风格描述：' + style.desc + '\n' +
        '风格执行要求：' + style.audioHint + '\n\n' +
        '授课风格只影响表达方式、节奏、开场和收束，不得改变事实准确性、技术解释深度、学习目标和证据要求。不得为了风格简洁而省略必要的术语解释、工作机制、设计取舍或风险边界。\n\n' +
        '【教案正文要求】\n' +
        '1. 按“问题背景 → 核心术语 → 工作机制 → 架构位置与关系 → 设计理由 → 方案比较与取舍 → 项目材料分析 → 客户交流应用 → 练习与复盘”的逻辑组织课程。可按主题调整顺序，但不能只罗列名词。\n' +
        '2. 开头说明本课要解决什么问题，以及学完后学习者能做什么。不要长篇铺垫。\n' +
        '3. 每个核心技术概念都要尽量讲清：\n' +
        '   - 它是什么，解决什么问题；\n' +
        '   - 它在整体系统或业务流程中的位置；\n' +
        '   - 涉及哪些主要组件、角色、数据或调用关系；\n' +
        '   - 它如何工作，关键步骤是什么；\n' +
        '   - 为什么会采用这种设计；\n' +
        '   - 常见替代方案是什么，如何比较；\n' +
        '   - 方案的收益、成本、限制和适用条件；\n' +
        '   - 常见失败方式、治理要求和安全风险；\n' +
        '   - 与本课项目材料的关系，以及哪些内容仍待核实。\n' +
        '4. 不适用的维度可以说明“本主题不适用”或“现有材料不足，需核实”，不能为了填满结构而编造。\n' +
        '5. 每个新出现的专业术语，第一次出现时都要用准确、简明的中文解释；必要时说明它与已学术语的关系。terms 数组用于术语索引，正文仍要做到不查词表也能读懂。\n' +
        '6. 至少提供一个完整 worked example，按步骤展示如何分析问题、选择方案或解释技术，而不是只给结论。\n' +
        '7. 说明方案是否“先进”时，必须先给出比较对象和评价维度，例如性能、开放性、可靠性、成本、可维护性、安全性、生态成熟度。没有对比证据时，只能说“可能的优势”或“待验证”，不能直接宣称先进。\n' +
        '8. 对项目资料逐条区分：\n' +
        '   - fact：资料明确写出的事实或原文主张；\n' +
        '   - inference：基于材料作出的分析推断；\n' +
        '   - sim：用于教学的假设或虚构示例。\n' +
        '   项目计划、目标、建议、试点或评审中的内容，不得表述为已落地成果。\n' +
        '9. 客户交流部分要给出至少两个可直接使用的提问或解释示例，并说明这些问题分别用于澄清业务目标、技术边界、接口依赖、成本风险或验收方式中的哪一项。\n' +
        '10. 课程结尾提供一个简短复盘，检查学习者能否解释概念、描述机制、比较方案并提出恰当问题。\n\n' +
        '【音频讲稿要求】\n' +
        'audioScript 是一份可以独立收听的讲课稿，不是正文的缩写，也不是目录朗读。\n' +
        '1. 音频讲解要和教案正文讲同一组核心知识，但可以使用更自然的口语表达。\n' +
        '2. 根据学习时长安排内容量，不能用“至少 8 段”代替实质教学。每段聚焦一个要点，段落数量和长度应足以讲完主题，audioScript[] 按顺序拼接后应是一堂完整可听的课。\n' +
        '3. 关键术语首次出现时，在音频中顺口解释，不要只放在 terms 数组里。\n' +
        '4. 对核心技术概念，要讲到“是什么、怎么工作、为什么这样设计、有什么取舍、客户场景怎么问”。不可只在每段重复“是什么、为什么、怎么用”的口号。\n' +
        '5. 讲解架构或流程时，按真实顺序说清组件之间如何交互；若流程或边界未知，明确指出待核实。\n' +
        '6. 口语可以简洁，但不能省略重要前提、机制、限制或风险。过渡自然，不要每段都用固定套话。\n' +
        '7. 不得在讲稿中出现“第1段”“audioScript”“JSON字段”等制作标记、时间戳或给模型的指令。\n\n' +
        '【证据和外部知识规则】\n' +
        '1. 导入项目资料中的内容只有在证据片段支持时才能标 evidence="fact"，并必须提供 cites。\n' +
        '2. 推断标 evidence="inference"，不能伪装成客户事实。\n' +
        '3. 教学假设标 evidence="sim"，明确说明是假设。\n' +
        '4. 外部知识可以用于解释通用技术原理，但不能伪装成项目材料或客户事实。\n' +
        '5. 外部案例只有在确有可核验来源时才可作为外部案例引用。若没有来源链接、出版物信息或其他可核验出处，不得声称已核实，不得生成虚假的 quote、sourceId 或 anchor；改为写“外部案例待核实”，或使用明确标注的教学假设。\n' +
        '6. 对任何不确定的信息，明确写出不确定之处和需要补充的证据。\n' +
        '7. 当天主题涉及项目分析而材料证据整体不足，或存在未能核实的项目相关论断时，教案顶层 pendingVerify 设为 true；关键项目论断都有材料 fact 引用或明确标注的教学假设（sim）时，pendingVerify 设为 false。\n\n' +
        '【练习要求】\n' +
        '- recall：3 道回忆题，要求学习者合上材料后回答，至少覆盖术语、机制和取舍。\n' +
        '- variants：2 道迁移练习，要求把方法用到变化后的业务情境，不要只替换项目名称。\n' +
        '- deliverable：一个可评价的业务工作物，说明完成标准或关键组成。\n' +
        '- 练习难度要匹配当天目标；不要考查教案中没有讲授的知识。\n\n' +
        '【输出格式】\n' +
        '只输出严格 JSON，不要 Markdown 代码围栏或额外说明。\n\n' +
        '必须使用以下 JSON 结构，不得改字段名：\n' +
        '{\n' +
        '  "sections": [\n' +
        '    {\n' +
        '      "heading": "小节标题",\n' +
        '      "evidence": "fact|inference|sim",\n' +
        '      "paragraphs": ["教案正文段落"],\n' +
        '      "terms": [\n' +
        '        {\n' +
        '          "term": "术语",\n' +
        '          "explain": "准确、简明的中文解释"\n' +
        '        }\n' +
        '      ],\n' +
        '      "cites": [\n' +
        '        {\n' +
        '          "sourceId": "资料ID",\n' +
        '          "sourceName": "资料名称",\n' +
        '          "anchor": {},\n' +
        '          "quote": "来自已提供证据的原文"\n' +
        '        }\n' +
        '      ]\n' +
        '    }\n' +
        '  ],\n' +
        '  "recall": ["回忆题"],\n' +
        '  "variants": ["变式练习"],\n' +
        '  "deliverable": "可评价工作物",\n' +
        '  "audioScript": [\n' +
        '    {\n' +
        '      "text": "可直接用于语音合成的连续讲课稿"\n' +
        '    }\n' +
        '  ],\n' +
        '  "pendingVerify": false\n' +
        '}\n\n' +
        '只输出 JSON。不得在 JSON 前后添加说明。';
      AI.chat([{ role: 'user', content: prompt }], { temperature: 0.5, max_tokens: 40000, timeout: 600000 })
        .then(function (txt) {
          var j = extractJson(txt);
          return finish(j, false);
        }).catch(function (e) {
          toast('教案生成失败：' + (e && e.message || e), 6000);
          genBusyEnd();
        });
    }).catch(function (e) { genBusyEnd(); $('view-lesson').innerHTML = errHtml(e); });
  }

  /* ============ 自定义授课风格 ============ */
  /* 用户粘贴讲师讲稿/转录稿，AI 分析其语言风格特征，存为自定义风格 */
  function openCustomStyleDialog() {
    var m = modalOpen('自定义授课风格', '<div class="field"><label>风格名称</label><input type="text" id="cs-name" placeholder="如：张老师的物理课"></div>' +
      '<div class="field"><label>粘贴讲师讲稿或转录稿（500~5000 字，AI 会从中提炼语言风格）</label>' +
      '<textarea id="cs-text" rows="10" style="width:100%;font-family:inherit" placeholder="把你在网上看到的好的讲课视频字幕/转录稿粘贴到这里。AI 会分析其语言节奏、修辞、结构特征，提炼成可复用的授课风格。"></textarea></div>' +
      '<div class="hint" style="margin-top:6px;font-size:12px;color:var(--ink2)">提示：YouTube/B 站视频可开启字幕→复制字幕文字粘贴到这里。AI 不会执行讲稿内容，只分析其语言风格。</div>' +
      '<div style="margin-top:10px"><button class="btn btn-primary" id="cs-analyze">让 AI 提炼风格</button> <button class="btn btn-ghost" id="cs-cancel">取消</button></div>');
    $('cs-cancel').addEventListener('click', function () { modalClose(m); });
    $('cs-analyze').addEventListener('click', function () {
      var name = $('cs-name').value.trim();
      var text = $('cs-text').value.trim();
      if (!name) { toast('请填写风格名称'); return; }
      if (text.length < 200) { toast('讲稿太短，至少 200 字才能提炼风格'); return; }
      if (!aiReady()) { toast('AI 未配置，无法提炼风格；请先在设置中心配 AI'); return; }
      modalClose(m);
      if (!genBusyStart('AI 正在提炼授课风格', null)) return;
      var prompt = '你是教学风格分析专家。下面是一段讲师的讲稿/转录稿，请分析其语言风格特征，提炼成可复用的授课风格描述。\n\n' +
        '讲稿内容：\n' + text.slice(0, 4000) + '\n\n' +
        '请输出严格 JSON：{"name":"' + name + '","desc":"整体语言风格描述（80~150 字，包含开场方式、语气、节奏、修辞特点、结尾方式）","audioHint":"音频讲稿生成提示（80~150 字，告诉 AI 如何按这个风格写课堂讲稿：开场怎么钩人、段落怎么走、修辞怎么用、结尾怎么升华）"}\n' +
        '只输出 JSON。';
      AI.chat([{ role: 'user', content: prompt }], { temperature: 0.4, max_tokens: 2000, timeout: 180000 })
        .then(function (txt) {
          var j = extractJson(txt);
          if (!j || !j.desc) throw new Error('AI 返回格式异常');
          var arr = loadCustomStyles();
          var id = 'custom-' + Date.now();
          arr.push({ id: id, name: j.name || name, desc: j.desc, audioHint: j.audioHint || j.desc });
          saveCustomStyles(arr);
          genBusyEnd();
          toast('已添加自定义风格：' + (j.name || name) + '，可在下拉菜单选择');
        }).catch(function (e) {
          toast('风格提炼失败：' + (e && e.message || e), 6000);
          genBusyEnd();
        });
    });
  }

  function openManageStylesDialog() {
    var custom = loadCustomStyles();
    var m = modalOpen('管理自定义授课风格',
      (custom.length ? '<table class="tbl"><tr><th>名称</th><th>风格描述</th><th></th></tr>' +
        custom.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td style="font-size:12px">' + esc(s.desc.slice(0, 60)) + (s.desc.length > 60 ? '…' : '') + '</td><td><button class="btn btn-sm btn-danger" data-delstyle="' + s.id + '">删除</button></td></tr>'; }).join('') + '</table>' : '<p class="sub">还没有自定义风格。点「自定义风格」按钮，粘贴讲师讲稿让 AI 提炼。</p>') +
      '<div style="margin-top:12px"><button class="btn btn-ghost" id="ms-close">关闭</button></div>');
    $('ms-close').addEventListener('click', function () { modalClose(m); });
    m.querySelectorAll('[data-delstyle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-delstyle');
        var arr = loadCustomStyles().filter(function (s) { return s.id !== id; });
        saveCustomStyles(arr);
        if (getDefaultStyleId() === id) setDefaultStyleId('senior');
        modalClose(m);
        toast('已删除自定义风格');
      });
    });
  }

  function builtinTerms(q) {
    var dict = [
      ['数据要素', '指参与生产经营、能创造价值的数据资源，像劳动力、资本一样被当作生产要素来用。'],
      ['数据资产', '企业拥有或控制、能带来经济利益的、经过治理的数据资源。'],
      ['可信数据空间', '一套让数据"可用不可控（可控可计量）"流通的基础设施：谁用、用多少、干什么都有记录和授权。'],
      ['算力调度', '把分散的计算资源按需求统一分配，像电网调配电一样调度算力。'],
      ['具身智能', '有物理身体、能感知并行动的智能体，如机器人。'],
      ['行业模型', '在通用大模型基础上，用行业数据和知识继续训练出的领域专用模型。'],
      ['RAG', '检索增强生成：先从资料里检索证据，再让模型基于证据回答，减少胡编。'],
      ['智能体（Agent）', '能自主拆解任务、调用工具、多步执行的 AI 程序。']
    ];
    var hits = [];
    String(q || '').split('').length; /* no-op */
    dict.forEach(function (d) {
      if (String(q || '').indexOf(d[0]) >= 0) hits.push({ term: d[0], explain: d[1] });
    });
    if (!hits.length) hits.push({ term: '（演示）本课关键词', explain: '配置 AI 后，专业术语会在首次出现处给出一句话解释。' });
    return hits;
  }

  /* ============ 音频 ============ */
  function genLessonAudio(course, d, lesson) {
    var segs = splitAudioScript(lesson.audioScript || []).filter(function (s) { return s.text; });
    if (!segs.length) { toast('教案没有音频脚本'); return; }
    var c = TTS.loadCfg();
    if (!c.enabled || !c.baseUrl || !c.apiKey) {
      toast('TTS 未配置：请到「音频与数据」页配置 Provider', 5000);
      goto('settings');
      return;
    }
    var total = segs.length, n = 0;
    var chain = Promise.resolve();
    segs.forEach(function (seg, i) {
      chain = chain.then(function () {
        return TTS.enqueue(lesson.id, i, cleanAudioSeg(seg.text), lesson.version + '|' + lesson.generatedAt, true, function (t, files) {
          renderAudioTasks(lesson.id);
        }).then(function () { n++; });
      });
    });
    chain.then(function () {
      if (!genBusyStart('正在合成课程音频', 'btn-audio-gen', { mode: 'count', total: total })) return;
      toast('已排队 ' + n + ' 段，开始合成…');
      return TTS.runQueue(function (t, files) {
        renderAudioTasks(lesson.id);
        return DB.byIndex('audioTasks', 'lessonId', lesson.id).then(function (list) {
          var doneCnt = list.filter(function (x) { return x.status === 'done' || x.status === 'failed' || x.status === 'cancelled'; }).length;
          genBusyUpdate({ done: doneCnt });
        });
      });
    }).then(function (summary) {
      genBusyEnd();
      toast('音频完成：成功 ' + summary.done + '，失败 ' + summary.failed + '，取消 ' + summary.cancelled, 5000);
      renderAudioTasks(lesson.id);
    }).catch(function (e) { genBusyEnd(); toast('音频任务出错：' + (e && e.message || e), 6000); });
  }

  function renderAudioTasks(lessonId) {
    var box = $('audio-tasks');
    if (!box) return;
    Promise.all([DB.byIndex('audioTasks', 'lessonId', lessonId), DB.byIndex('audioFiles', 'lessonId', lessonId)]).then(function (r) {
      var tasks = r[0], files = r[1];
      tasks.sort(function (a, b) { return a.segIndex - b.segIndex; });
      if (!tasks.length) { box.innerHTML = '<p class="muted">还没有生成音频。</p>'; return; }
      var html = tasks.map(function (t) {
        var f = files.filter(function (x) { return x.taskId === t.id; });
        var fMp3 = f.find(function (x) { return x.format === 'mp3' });
        var fWav = f.find(function (x) { return x.format === 'wav' });
        var st = t.status === 'done' ? '<span class="tag green">完成</span>'
          : t.status === 'failed' ? '<span class="tag red">失败：' + esc(t.error) + '</span>'
            : t.status === 'running' ? '<span class="tag gold">合成中</span>'
              : t.status === 'cancelled' ? '<span class="tag">已取消</span>'
                : '<span class="tag gold">排队中</span>';
        var h = '<div class="audio-bar" style="margin-bottom:8px"><b style="min-width:52px">段 ' + (t.segIndex + 1) + '</b>' + st +
          '<span class="seg">' + esc((t.script || '').slice(0, 40)) + '…</span>';
        if (t.status === 'done' && fMp3) {
          h += '<span class="seg">' + fmtSize(fMp3.size) + (fMp3.durationSec ? ' · ' + Math.round(fMp3.durationSec) + 's' : '') + ' · MP3</span>';
        }
        if (fWav && fWav.status === 'ok' && fWav.size) {
          h += '<span class="seg">' + fmtSize(fWav.size) + ' · WAV</span>';
        }
        if (t.status === 'failed' || t.status === 'cancelled') {
          h += '<button class="btn btn-sm btn-outline" data-retry="' + t.id + '">重试</button>';
        }
        if (t.status === 'queued' || t.status === 'running') {
          h += '<button class="btn btn-sm btn-danger" data-cancel="' + t.id + '">取消</button>' +
            (t.status === 'running' ? '<span class="tag gold">取消对正在合成中的任务不保证立即生效</span>' : '');
        }
        h += '</div>';
        /* 播放器 + 下载（仅完成且校验通过的文件） */
        if (t.status === 'done' && fMp3) {
          var url = URL.createObjectURL(fMp3.blob);
          h += '<div class="audio-bar" style="margin-bottom:14px">' +
            '<audio controls preload="none" src="' + url + '" data-seg="' + t.segIndex + '" data-lesson="' + lessonId + '"></audio>' +
            '<button class="btn btn-sm btn-outline" data-dl="' + fMp3.id + '" data-fmt="mp3">下载 MP3</button>' +
            (fWav && fWav.status === 'ok' ? '<button class="btn btn-sm btn-outline" data-dl="' + fWav.id + '" data-fmt="wav">下载 WAV</button>' : (t.wantWav ? '<span class="tag red">WAV 转换失败：' + esc(t.wavError || '未知') + '</span>' : '')) +
            '</div>';
        }
        return h;
      }).join('');
      box.innerHTML = html;
      /* 绑定播放事件：完成率与行为信号 */
      box.querySelectorAll('audio').forEach(function (au) {
        var seg = +au.getAttribute('data-seg');
        var lsId = au.getAttribute('data-lesson');
        var playCount = 0, pauseAt = 0;
        au.addEventListener('play', function () {
          playCount++;
          DB.logEvent({ type: 'listen', lessonId: lsId, payload: { seg: seg, action: 'play' } });
          if (playCount >= 3) {
            /* 行为信号：同段反复播放 >=3 次 -> 低置信候选（不直接覆盖掌握状态） */
            DB.logEvent({
              type: 'behavior', lessonId: lsId, origin: 'inferred', confidence: 0.4,
              payload: { seg: seg, action: 'replay', count: playCount },
              note: '同段播放≥3次，可能没懂'
            }).then(function (ev) {
              return upsertProfile({
                lessonId: lsId, concept: '音频段 ' + (seg + 1),
                state: 'uncertain', origin: 'inferred', confidence: 0.4,
                evidence: [ev.id], note: '反复播放同一音频段（行为推测，低置信）'
              });
            });
          }
        });
        au.addEventListener('pause', function () { pauseAt = Date.now(); });
        au.addEventListener('ended', function () {
          DB.logEvent({ type: 'listen', lessonId: lsId, payload: { seg: seg, action: 'ended' } });
          markLessonProgress(lsId, seg);
        });
      });
      box.querySelectorAll('[data-dl]').forEach(function (b) {
        b.addEventListener('click', function () {
          DB.get('audioFiles', b.getAttribute('data-dl')).then(function (f) {
            if (!f) { toast('文件不存在'); return; }
            /* 下载前再验文件头（拒绝损坏/未完成文件） */
            f.blob.arrayBuffer().then(function (buf) {
              var v = TTS.validateAudio(buf, f.format);
              if (!v.ok) { toast('文件校验失败，已阻止下载：' + v.reason, 5000); return; }
              var nm = '第' + (state.day) + '天_段' + (f.segIndex + 1) + '.' + f.format;
              TTS.downloadBlob(f.blob, nm);
              DB.logEvent({ type: 'listen', lessonId: f.lessonId, payload: { action: 'download', file: nm, format: f.format } });
            });
          });
        });
      });
      box.querySelectorAll('[data-retry]').forEach(function (b) {
        b.addEventListener('click', function () {
          TTS.retry(b.getAttribute('data-retry'), function () { renderAudioTasks(lessonId); }).then(function () {
            TTS.runQueue(function () { renderAudioTasks(lessonId); }).then(function () { renderAudioTasks(lessonId); });
          });
        });
      });
      box.querySelectorAll('[data-cancel]').forEach(function (b) {
        b.addEventListener('click', function () {
          TTS.cancel(b.getAttribute('data-cancel')).then(function (ok) { toast(ok ? '已取消' : '任务已完成，无需取消'); renderAudioTasks(lessonId); });
        });
      });
    });
  }

  function markLessonProgress(lessonId, seg) {
    DB.activeCourse().then(function (course) {
      if (!course) return;
      if (!course.progress) course.progress = { day: state.day, listenedSegs: {} };
      if (!course.progress.listenedSegs) course.progress.listenedSegs = {};
      var key = lessonId + ':' + seg;
      course.progress.listenedSegs[key] = true;
      /* 完成第0段即记为今日听过；听完所有段推下一天 */
      DB.put('courses', course);
    });
  }

  function downloadAllAudio(lessonId, day) {
    Promise.all([DB.byIndex('audioFiles', 'lessonId', lessonId), DB.get('lessons', lessonId)]).then(function (r) {
      var files = r[0], lesson = r[1];
      var ok = files.filter(function (f) { return f.status === 'ok'; });
      if (!ok.length) { toast('没有可下载的音频（先成功生成）'); return; }
      if (!window.JSZip) { toast('JSZip 未加载（需联网加载一次）'); return; }
      var zip = new JSZip();
      var manifest = [];
      var chain = Promise.resolve();
      ok.forEach(function (f) {
        chain = chain.then(function () {
          return f.blob.arrayBuffer().then(function (buf) {
            var v = TTS.validateAudio(buf, f.format);
            if (!v.ok) { manifest.push({ file: '段' + (f.segIndex + 1) + '.' + f.format, skipped: v.reason }); return; }
            zip.file('seg' + (f.segIndex + 1) + '.' + f.format, buf);
            manifest.push({
              seg: f.segIndex + 1, format: f.format, size: f.size,
              durationSec: f.durationSec, scriptVersion: f.scriptVersion,
              script: (lesson && lesson.audioScript[f.segIndex]) ? lesson.audioScript[f.segIndex].text : '',
              header: v.header, provider: f.provider, generatedAt: f.createdAt,
              aiGenerated: true
            });
          });
        });
      });
      chain.then(function () {
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        return zip.generateAsync({ type: 'blob' });
      }).then(function (blob) {
        TTS.downloadBlob(blob, '第' + day + '天_课程音频包_' + new Date().toISOString().slice(0, 10) + '.zip');
        toast('已下载音频包（含 manifest：脚本/编码/时长/版本）');
      });
    });
  }

  /* ================================================================
   * 显式反馈与自适应
   * ================================================================ */
  /* 取消段标记：写一条 label='' 的反馈事件覆盖状态 + 删除画像条目；
     既有 events 与复习计划保留（学习历史不抹除，复习可在「复习计划」页自己处理） */
  function removeFeedback(course, d, lesson, label, secIdx) {
    var sec = lesson.sections[secIdx];
    var concept = sec ? sec.heading : d.theme;
    DB.logEvent({
      type: 'feedback', lessonId: lesson.id, concept: concept, origin: 'explicit',
      payload: { label: '', unmark: true, day: d.day }
    }).then(function () {
      return DB.getAll('profile').then(function (all) {
        var hit = all.find(function (x) { return x.lessonId + '|' + x.concept === lesson.id + '|' + concept; });
        return hit ? DB.del('profile', hit.id) : null;
      });
    }).then(function () {
      toast('已取消「' + label + '」标记（学习历史保留；已排的复习可在「复习计划」处理）');
      renderLesson();
    }).catch(function (e) { toast('取消失败：' + (e && e.message || e), 5000); });
  }

  function feedbackFlow(label, secIdx, course, d, lesson) {
    var sec = lesson.sections[secIdx];
    var concept = sec ? sec.heading : d.theme;
    if (label === '已掌握') {
      confirmFeedback(course, d, lesson, label, concept, '', '');
      return;
    }
    /* 没懂/不确定/需练习：先问原因，再问偏好，再给替代解释 */
    var modal = modalOpen(
      '「' + label + '」反馈',
      '<div class="field"><label>哪里卡住了？（帮助 Agent 给出对症的替代解释）</label>' +
      ['术语不懂', '机制/原理不清', '案例对不上', '步骤跟不上', '缺前置知识', '其他'].map(function (r, i) {
        return '<button class="btn btn-outline btn-sm" data-reason="' + r + '" style="margin:4px">' + r + '</button>';
      }).join('') + '</div>'
    );
    modal.el.querySelectorAll('[data-reason]').forEach(function (b) {
      b.addEventListener('click', function () {
        var reason = b.getAttribute('data-reason');
        modal.close();
        modal = modalOpen('你希望怎么讲更容易懂？',
          ['更简单的解释', '换个类比', '看流程图（文字版）', '再做一个案例', '先标记，稍后复习'].map(function (p) {
            return '<button class="btn btn-ghost btn-sm" data-pref="' + p + '" style="margin:4px">' + p + '</button>';
          }).join('') +
          '<p class="note" style="margin-top:10px">选择后 Agent 会基于原段内容生成替代解释与变式题，并把该概念加入复习计划。</p>');
        modal.el.querySelectorAll('[data-pref]').forEach(function (b2) {
          b2.addEventListener('click', function () {
            var pref = b2.getAttribute('data-pref');
            modal.close();
            confirmFeedback(course, d, lesson, label, concept, reason, pref, sec);
          });
        });
      });
    });
  }

  function confirmFeedback(course, d, lesson, label, concept, reason, pref, sec) {
    /* 1) 显式反馈事件 */
    DB.logEvent({
      type: 'feedback', lessonId: lesson.id, concept: concept, origin: 'explicit',
      payload: { label: label, reason: reason, pref: pref, day: d.day }
    }).then(function (ev) {
      /* 2) 画像（显式反馈 -> 可见状态） */
      return upsertProfile({
        lessonId: lesson.id, day: d.day, concept: concept,
        state: label === '已掌握' ? 'mastered' : label === '没懂' ? 'weak' : 'uncertain',
        origin: 'explicit', confidence: 1,
        evidence: [ev.id], note: reason ? ('原因：' + reason + (pref ? '；选择了' + pref : '')) : ''
      });
    }).then(function () {
      /* 3) 复习调度（规则可解释） */
      var interval = label === '没懂' ? 1 : label === '需练习' ? 3 : label === '已掌握' ? 7 : 2;
      return scheduleReview(course, d, concept, interval, label);
    }).then(function () {
      /* 4) 替代解释（仅需解释类反馈） */
      if (label !== '已掌握' && pref && pref !== '先标记，稍后复习') {
        return genAdaptive(course, d, lesson, concept, reason, pref, sec);
      }
      toast('已记录「' + label + '」，复习计划与画像已更新');
      renderLesson();
    });
  }

  function genAdaptive(course, d, lesson, concept, reason, pref, sec) {
    var secText = sec ? (sec.paragraphs || []).join('\n') : '';
    var citeText = sec && sec.cites && sec.cites.length ? sec.cites.map(function (c) { return c.quote; }).join('\n') : '';
    if (!genBusyStart('正在生成替代解释（' + pref + '）', null)) return Promise.resolve();

    var saveAdaptive = function (text, variant, demo) {
      lesson.adaptive = lesson.adaptive || [];
      lesson.adaptive.push({ concept: concept, reason: reason, pref: pref, text: text, variant: variant, at: DB.nowIso(), demo: !!demo });
      return DB.put('lessons', lesson).then(function () {
        toast('替代解释已生成，见教案下方');
        renderLesson();
        genBusyEnd();
      });
    };

    if (!aiReady()) {
      return saveAdaptive(
        '（演示模板）针对「' + concept + '」，你选择的解释方式是「' + pref + '」。\n' +
        '配置 AI 服务后，这里会基于原段落与案例片段生成：更简单的解释、一个生活化类比、文字版流程图或完整案例复盘。' +
        '原文片段供你先对照：\n' + citeText.slice(0, 300),
        '（演示）用你自己的话，把「' + concept + '」讲给一个完全不了解的同事听，写 5 句。', true);
    }

    var prompt = '学习者标记了「' + concept + '」没掌握。\n' +
      '困难原因：' + reason + '\n希望的解释方式：' + pref + '\n' +
      '原教案段落：\n' + secText.slice(0, 1500) + '\n案例原文片段：\n' + citeText.slice(0, 1200) + '\n\n' +
      '请输出严格 JSON：{"text":"替代解释正文","variant":"一道变式练习题"}\n' +
      '要求：按学习者选择的解释方式（更简单解释/换类比/文字流程图/再做一个案例）重讲该概念；' +
      '不得引入案例中不存在的事实；引用原文时保持原样；text 500 字内；variant 是可动手完成的练习。只输出 JSON。';
    AI.chat([{ role: 'user', content: prompt }], { temperature: 0.6, max_tokens: 20000, timeout: 480000 })
      .then(function (txt) {
        var j = extractJson(txt);
        saveAdaptive(j.text || '', j.variant || '', false);
      }).catch(function (e) {
        toast('替代解释生成失败：' + (e && e.message || e), 6000);
        renderLesson();
        genBusyEnd();
      });
  }

  /* 复习调度：0/1/3/7/14 天，规则可见 */
  function scheduleReview(course, d, concept, interval, reasonLabel) {
    var rec = {
      id: DB.newId('rv'), courseId: course.id, lessonId: '', day: d.day,
      concept: concept, dueDay: addDays(interval), state: 'pending',
      interval: interval, reason: reasonLabel,
      rule: (label2rule(reasonLabel)),
      createdAt: DB.nowIso(), history: []
    };
    return DB.put('reviews', rec);
  }
  function label2rule(l) {
    if (l === '没懂') return '规则：标记「没懂」→ 次日复习（间隔1天）';
    if (l === '需练习') return '规则：标记「需练习」→ 3 天后复习';
    if (l === '已掌握') return '规则：标记「已掌握」→ 7 天后巩固，再掌握延至 14 天';
    if (l === '不确定') return '规则：标记「不确定」→ 2 天后确认';
    return '规则：完成学习 → 次日复习';
  }

  /* 画像 upsert */
  function upsertProfile(p) {
    var key = p.lessonId + '|' + p.concept;
    return DB.getAll('profile').then(function (all) {
      var exist = all.find(function (x) { return x.lessonId + '|' + x.concept === key; });
      if (exist) {
        exist.state = p.state;
        exist.origin = p.origin;
        exist.confidence = p.confidence;
        exist.note = p.note || exist.note;
        exist.day = p.day || exist.day;
        exist.updatedAt = DB.nowIso();
        if (p.evidence && p.evidence[0] && exist.evidence.indexOf(p.evidence[0]) < 0) exist.evidence.push(p.evidence[0]);
        return DB.put('profile', exist);
      }
      var rec = Object.assign({
        id: DB.newId('pf'), evidence: [], createdAt: DB.nowIso(), updatedAt: DB.nowIso()
      }, p, { id: DB.newId('pf'), evidence: p.evidence || [] });
      return DB.put('profile', rec);
    });
  }

  function modalOpen(title, bodyHtml) {
    var root = $('modal-root') || document.body;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(28,26,23,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--card);border:1px solid var(--cinnabar);max-width:560px;width:100%;padding:22px 26px;max-height:80vh;overflow:auto';
    box.innerHTML = '<h3 style="margin-bottom:12px">' + esc(title) + '</h3>' + bodyHtml +
      '<div style="margin-top:12px;text-align:right"><button class="btn btn-sm btn-outline" data-close>关闭</button></div>';
    wrap.appendChild(box);
    root.appendChild(wrap);
    var close = function () { wrap.remove(); };
    box.querySelector('[data-close]').addEventListener('click', close);
    return { el: box, close: close };
  }

  /* ================================================================
   * 视图：复习计划
   * ================================================================ */
  function renderReviews() {
    DB.getAll('reviews').then(function (all) {
      var today = todayStr();
      all.sort(function (a, b) { return a.dueDay.localeCompare(b.dueDay); });
      var html = '<div class="card"><h2>复习规则（可解释）</h2><p class="sub">' +
        '完成学习 → 次日；标记「没懂」→ 次日；「不确定」→ 2 天后；「需练习」→ 3 天后；「已掌握」→ 7 天后巩固、再掌握延至 14 天。所有复习由你的显式反馈触发，行为信号（如反复播放）只会变成低置信候选，不会自动安排复习或改变掌握状态。</p></div>';
      var due = all.filter(function (r) { return r.state === 'pending' && r.dueDay <= today; });
      var future = all.filter(function (r) { return r.state === 'pending' && r.dueDay > today; });
      html += '<div class="card"><h2>今天到期（' + due.length + '）</h2>';
      if (!due.length) html += '<div class="empty">今天没有到期复习</div>';
      due.forEach(function (r) {
        html += reviewItem(r, true);
      });
      html += '</div><div class="card"><h2>待到期（' + future.length + '）</h2>';
      if (!future.length) html += '<div class="empty">暂无</div>';
      future.slice(0, 20).forEach(function (r) { html += reviewItem(r, false); });
      html += '</div>';
      $('view-reviews').innerHTML = html;
      $('view-reviews').querySelectorAll('[data-rdone]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-rdone');
          var r = all.find(function (x) { return x.id === id; });
          if (!r) return;
          r.state = 'done';
          r.history.push({ at: DB.nowIso(), action: 'done' });
          /* 完成本次复习 → 再排下一次巩固 */
          r.dueDay = addDays(7);
          r.state = 'pending';
          r.reason = '复习完成';
          DB.put('reviews', r).then(function () { toast('本次复习完成，已安排 7 天后巩固'); renderReviews(); });
        });
      });
      $('view-reviews').querySelectorAll('[data-rdel]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (confirm('删除这条复习安排？')) DB.del('reviews', b.getAttribute('data-rdel')).then(renderReviews);
        });
      });
    }).catch(function (e) { $('view-reviews').innerHTML = errHtml(e); });
  }

  function reviewItem(r, actionable) {
    return '<div class="list-item"><div class="li-title">第 ' + r.day + ' 天 · ' + esc(r.concept) + '</div>' +
      '<div class="li-meta">' + esc(r.rule) + ' · 到期 ' + esc(r.dueDay) + '</div>' +
      '<div style="margin-top:6px">' +
      '<button class="btn btn-sm btn-outline" onclick="location.hash=\'#/lesson?day=' + r.day + '\'">回到该课</button> ' +
      (actionable ? '<button class="btn btn-sm btn-success" data-rdone="' + r.id + '">完成本次复习</button> ' : '') +
      '<button class="btn btn-sm btn-danger" data-rdel="' + r.id + '">删除</button></div></div>';
  }

  /* ================================================================
   * 视图：学习画像
   * ================================================================ */
  function renderProfile() {
    Promise.all([DB.getAll('profile'), DB.getAll('events'), DB.getAll('lessons')]).then(function (r) {
      var items = r[0], events = r[1], lessons = r[2];
      items.sort(function (a, b) { return b.updatedAt.localeCompare(a.updatedAt); });
      var exp = items.filter(function (x) { return x.origin === 'explicit'; });
      var inf = items.filter(function (x) { return x.origin === 'inferred'; });
      var html = '<div class="card"><h2>画像说明</h2><p class="sub">' +
        '显式反馈（你点的「没懂/不确定/需练习/已掌握」与批注标签）构成确定状态；行为推测（反复播放、长暂停）只产生<b>低置信候选</b>，需你确认才会影响学习安排。履历型能力（项目金额、签约金额、部署数量、标杆案例数）永远显示"待真实项目证明"，本应用不会替你宣称达标。</p></div>';

      html += '<div class="card"><h2>掌握与薄弱（显式反馈 · ' + exp.length + ' 条）</h2>';
      if (!exp.length) html += '<div class="empty">还没有显式反馈记录。在学习中点「没懂/已掌握」等按钮后，这里会出现对应条目。</div>';
      exp.forEach(function (p) {
        var st = p.state === 'mastered' ? '<span class="tag green">已掌握</span>'
          : p.state === 'weak' ? '<span class="tag red">没懂</span>' : '<span class="tag gold">不确定</span>';
        var les = lessons.find(function (l) { return l.id === p.lessonId; });
        html += '<div class="list-item"><div class="li-title">' + st + ' ' + esc(p.concept) + '</div>' +
          '<div class="li-meta">' + (les ? '第 ' + les.day + ' 天教案 · ' : '') + esc(p.note || '') + '</div>' +
          '<div class="li-meta">证据：' + p.evidence.map(function (eid) {
            var ev = events.find(function (x) { return x.id === eid; });
            return ev ? (ev.at.slice(0, 16) + ' ' + ev.type + (ev.payload && ev.payload.label ? '「' + ev.payload.label + '」' : '')) : eid;
          }).join('；') + '</div>' +
          '<div style="margin-top:6px">' +
          '<button class="btn btn-sm btn-success" data-pm="' + p.id + '">改为已掌握</button> ' +
          '<button class="btn btn-sm btn-outline" data-pnote="' + p.id + '">改正备注</button> ' +
          '<button class="btn btn-sm btn-danger" data-pdel="' + p.id + '">删除</button></div></div>';
      });
      html += '</div>';

      html += '<div class="card"><h2>低置信推断（行为推测 · 需你确认 · ' + inf.length + ' 条）</h2>';
      if (!inf.length) html += '<div class="empty">暂无行为推测。它们只作为候选，不会自动影响复习或课程。</div>';
      inf.forEach(function (p) {
        html += '<div class="list-item"><div class="li-title"><span class="tag blue">低置信推断</span> ' + esc(p.concept) + '</div>' +
          '<div class="li-meta">' + esc(p.note || '') + ' · 置信度 ' + Math.round((p.confidence || 0) * 100) + '%</div>' +
          '<div style="margin-top:6px">' +
          '<button class="btn btn-sm btn-ghost" data-pconf="' + p.id + '">是我没懂，加入复习</button> ' +
          '<button class="btn btn-sm btn-outline" data-pclose="' + p.id + '">关闭推断（不影响学习）</button> ' +
          '<button class="btn btn-sm btn-danger" data-pdel="' + p.id + '">删除</button></div></div>';
      });
      html += '</div>';

      html += '<div class="card"><h2>画像数据控制</h2>' +
        '<button class="btn btn-outline btn-sm" id="btn-pf-export">导出画像 JSON</button> ' +
        '<button class="btn btn-danger btn-sm" id="btn-pf-clear-exp">清空显式画像</button> ' +
        '<button class="btn btn-danger btn-sm" id="btn-pf-clear-inf">清空行为推断</button> ' +
        '<div class="divider"></div>' +
        '<p class="sub warn">清空单门课程（含该课程教案、音频、批注、事件、复习、画像；资料库原件保留）：</p>' +
        '<button class="btn btn-danger btn-sm" id="btn-course-wipe">清空当前课程全部数据</button>' +
        '<p class="note">删除后：检索、推荐、复习与画像不再使用这些数据。导出的 JSON 包含画像与证据事件，请妥善保管（含你的学习内容，不要发到公开渠道）。</p></div>';

      $('view-profile').innerHTML = html;

      $('btn-pf-export').addEventListener('click', function () {
        TTS.downloadBlob(new Blob([JSON.stringify({ profile: items, events: events }, null, 2)], { type: 'application/json' }), '学习画像_' + todayStr() + '.json');
      });
      $('btn-pf-clear-exp').addEventListener('click', function () {
        if (!confirm('删除全部显式画像条目？（复习计划保留）')) return;
        delAllWhere('profile', items.filter(function (p) { return p.origin === 'explicit'; })).then(function () { toast('已清空'); renderProfile(); });
      });
      $('btn-pf-clear-inf').addEventListener('click', function () {
        if (!confirm('删除全部低置信行为推断？')) return;
        delAllWhere('profile', items.filter(function (p) { return p.origin === 'inferred'; })).then(function () { toast('已清空'); renderProfile(); });
      });
      $('btn-course-wipe').addEventListener('click', function () {
        if (!confirm('清空当前课程全部派生数据（教案/音频任务/音频文件/批注/事件/复习/画像/课程记录）？资料库原件与来源登记保留。此操作不可撤销。')) return;
        DB.activeCourse().then(function (course) {
          if (!course) { toast('没有课程'); return; }
          var cid = course.id;
          var lessonIds = [];
          Promise.all([
            DB.byIndex('lessons', 'courseId', cid),
            DB.byIndex('audioTasks', 'lessonId', ''),
            DB.getAll('audioTasks'), DB.getAll('audioFiles'),
            DB.getAll('annotations'), DB.getAll('events'),
            DB.getAll('reviews'), DB.getAll('profile')
          ]).then(function (r2) {
            var lsns = r2[0], tasks = r2[2], files = r2[3], anns = r2[4], evs = r2[5], rvs = r2[6], pfs = r2[7];
            lsns.forEach(function (l) { lessonIds.push(l.id); });
            var chain = Promise.resolve();
            lsns.forEach(function (l) { chain = chain.then(function () { return DB.del('lessons', l.id); }); });
            tasks.filter(function (t) { return lessonIds.indexOf(t.lessonId) >= 0; })
              .forEach(function (t) { chain = chain.then(function () { return DB.del('audioTasks', t.id); }); });
            files.filter(function (f) { return lessonIds.indexOf(f.lessonId) >= 0; })
              .forEach(function (f) { chain = chain.then(function () { return DB.del('audioFiles', f.id); }); });
            anns.filter(function (a) { return a.lessonId && lessonIds.indexOf(a.lessonId) >= 0; })
              .forEach(function (a) { chain = chain.then(function () { return DB.del('annotations', a.id); }); });
            evs.filter(function (e2) { return lessonIds.indexOf(e2.lessonId) >= 0; })
              .forEach(function (e2) { chain = chain.then(function () { return DB.del('events', e2.id); }); });
            rvs.filter(function (v) { return v.courseId === cid; })
              .forEach(function (v) { chain = chain.then(function () { return DB.del('reviews', v.id); }); });
            pfs.filter(function (p2) { return lessonIds.indexOf(p2.lessonId) >= 0; })
              .forEach(function (p2) { chain = chain.then(function () { return DB.del('profile', p2.id); }); });
            chain.then(function () { return DB.del('courses', cid); })
              .then(function () { toast('课程派生数据已清空（资料库保留）'); goto('home'); });
          });
        });
      });

      $('view-profile').querySelectorAll('[data-pm]').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = items.find(function (x) { return x.id === b.getAttribute('data-pm'); });
          p.state = 'mastered'; p.updatedAt = DB.nowIso();
          DB.put('profile', p).then(function () { toast('已标记掌握'); renderProfile(); });
        });
      });
      $('view-profile').querySelectorAll('[data-pnote]').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = items.find(function (x) { return x.id === b.getAttribute('data-pnote'); });
          var t = prompt('改正备注（人工纠正画像）：', p.note || '');
          if (t !== null) { p.note = t; p.updatedAt = DB.nowIso(); DB.put('profile', p).then(renderProfile); }
        });
      });
      $('view-profile').querySelectorAll('[data-pconf]').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = items.find(function (x) { return x.id === b.getAttribute('data-pconf'); });
          p.origin = 'explicit'; p.confidence = 1; p.state = 'weak'; p.note = (p.note || '') + '（已由学习者确认为没懂）';
          p.updatedAt = DB.nowIso();
          var rv = {
            id: DB.newId('rv'), courseId: '', lessonId: p.lessonId, day: p.day || 1,
            concept: p.concept, dueDay: addDays(1), state: 'pending', interval: 1,
            reason: '确认行为推断', rule: '规则：确认「没懂」→ 次日复习', createdAt: DB.nowIso(), history: []
          };
          DB.put('profile', p).then(function () { return DB.put('reviews', rv); })
            .then(function () { toast('已确认，安排明日复习'); renderProfile(); });
        });
      });
      $('view-profile').querySelectorAll('[data-pclose]').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = items.find(function (x) { return x.id === b.getAttribute('data-pclose'); });
          p.state = 'closed'; p.note = (p.note || '') + '（学习者已关闭该推断）'; p.updatedAt = DB.nowIso();
          DB.put('profile', p).then(function () { toast('已关闭推断，不影响学习安排'); renderProfile(); });
        });
      });
      $('view-profile').querySelectorAll('[data-pdel]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (confirm('删除该画像条目？')) DB.del('profile', b.getAttribute('data-pdel')).then(renderProfile);
        });
      });
    }).catch(function (e) { $('view-profile').innerHTML = errHtml(e); });
  }

  function delAllWhere(store, arr) {
    var chain = Promise.resolve();
    arr.forEach(function (x) { chain = chain.then(function () { return DB.del(store, x.id); }); });
    return chain.then(function () { return arr.length; });
  }

  /* ================================================================
   * 阅读器打开（教案来源 或 资料库）
   * ================================================================ */
  function openReader(sourceId, lessonId) {
    DB.get('sources', sourceId).then(function (s) {
      if (!s) { toast('来源不存在'); return; }
      if (s.status !== 'parsed') { toast('该资料未解析成功，无法阅读'); return; }
      var model = {
        kind: s.type,
        meta: { name: s.name, size: s.size },
        anchorType: s.anchorType,
        pageNote: s.pageNote,
        pages: (s.pageBlocks && s.pageBlocks.length)
          ? s.pageBlocks.map(function (blocks, i) {
            return {
              num: i + 1,
              blocks: blocks.map(function (b) { return Object.assign({}, b); })
            };
          })
          : (s.pageTexts || []).map(function (t, i) {
            return {
              num: i + 1,
              blocks: [{ type: 'para', text: t, anchor: s.anchorType === 'slide' ? { slide: i + 1 } : s.anchorType === 'para' ? { para: 0 } : { page: i + 1 } }]
            };
          })
      };
      DB.byIndex('annotations', 'sourceId', sourceId).then(function (anns) {
        /* 切到阅读视图 */
        state.view = 'reader';
        document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
        var sec = $('view-reader');
        sec.classList.remove('hidden');
        $('page-title').textContent = '阅读与批注';
        $('page-sub').textContent = s.name + '（原件只读 · 批注存独立图层）';
        sec.innerHTML = '<div id="reader-toolbar" style="position:sticky;top:0;z-index:60;background:var(--paper);padding:8px 0;margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line);box-shadow:0 2px 6px rgba(0,0,0,.05)"></div>' +
          '<div class="reader-stage" id="reader-stage"></div>' +
          '<div style="margin-top:10px"><button class="btn btn-sm btn-ghost" onclick="location.hash=\'#/lesson?day=' + state.day + '\'">返回课程</button> ' +
          '<button class="btn btn-sm btn-outline" onclick="location.hash=\'#/sources\'">返回资料库</button></div>';
        var reader = new SZReader.Reader();
        reader.mount($('reader-stage'), model, {
          annotations: anns,
          lessonId: lessonId || '',
          sourceId: sourceId,
          onChange: function (a, action) {
            if (action === 'add') DB.logEvent({
              type: 'annotate', sourceId: sourceId, lessonId: lessonId || '',
              payload: { kind: a.kind, label: a.label, action: action }
            });
          },
          onLabel: function (label, ann) {
            /* 批注上的显式标签进入反馈闭环 */
            DB.logEvent({
              type: 'feedback', sourceId: sourceId, lessonId: lessonId || '',
              concept: (ann.anchor && ann.anchor.refText ? ann.anchor.refText.slice(0, 30) : '资料批注'),
              origin: 'explicit', payload: { label: label, from: 'annotation' }
            }).then(function (ev) {
              return upsertProfile({
                lessonId: lessonId || '', day: state.day,
                concept: '资料批注：' + (ann.anchor && ann.anchor.refText ? ann.anchor.refText.slice(0, 24) + '…' : s.name),
                state: label === '已掌握' ? 'mastered' : label === '没懂' ? 'weak' : 'uncertain',
                origin: 'explicit', confidence: 1, evidence: [ev.id],
                note: '在《' + s.name + '》上标记「' + label + '」'
              });
            }).then(function () {
              if (label === '没懂') {
                var m = modalOpen('「没懂」已记录', '<p>已加入学习画像（显式反馈）。需要 Agent 现在给替代解释吗？</p>' +
                  '<button class="btn btn-ghost btn-sm" data-yes>给我替代解释（回到对应教案）</button> ' +
                  '<button class="btn btn-outline btn-sm" data-no>先继续阅读</button>');
                m.el.querySelector('[data-yes]').addEventListener('click', function () { m.close(); toast('请到教案该段点「这段没懂」选择原因与解释方式'); });
                m.el.querySelector('[data-no]').addEventListener('click', function () { m.close(); });
              } else {
                toast('「' + label + '」已记录到画像');
              }
            });
          }
        });
      });
    });
  }

  /* ================================================================
   * 视图：音频与数据设置
   * ================================================================ */
  function renderSettings() {
    var c = TTS.loadCfg();
    var ai = AI ? AI.config() : {};
    var html = '<div class="card"><h2>TTS Provider（真人感 AI 语音合成）</h2>' +
      '<p class="sub">生成<b>真人感 AI 语音</b>（MiniMax T2A 等，<b>不是 Windows/浏览器系统语音</b>），产出可下载的真实 MP3 与原生 WAV 文件。密钥只存本机浏览器（localStorage），不进源码、不进 Git 仓库、不发给该 Provider 以外的任何一方。<b>此配置与统一首页「设置中心 → AI 语音合成」共享同一份数据，改哪边都生效。</b>MiniMax 模式下 MP3 与 WAV 各请求一次真实合成（同一脚本两次，注意字符消耗）；OpenAI 兼容模式 WAV 由本机从 MP3 真实重编码（非改扩展名）。</p>' +
      '<div class="row">' +
      '<div class="field"><label>启用 TTS</label><select id="t-enabled"><option value="1"' + (c.enabled ? ' selected' : '') + '>启用</option><option value="0"' + (!c.enabled ? ' selected' : '') + '>停用</option></select></div>' +
      '<div class="field"><label>Provider</label><select id="t-provider"><option value="minimax"' + (c.provider === 'minimax' ? ' selected' : '') + '>MiniMax 真人感语音（推荐）</option><option value="openai"' + (c.provider === 'openai' ? ' selected' : '') + '>OpenAI 兼容 (/audio/speech)</option></select></div>' +
      '</div>' +
      '<div class="field"><label>接口地址（base URL）</label><input type="text" id="t-baseurl" value="' + esc(c.baseUrl) + '" placeholder="https://api.minimaxi.com（带不带 /v1 都会自动识别）"></div>' +
      '<div class="row">' +
      '<div class="field"><label>API 密钥（仅存本机）</label><input type="password" id="t-key" value="' + esc(c.apiKey) + '" placeholder="MiniMax / OpenAI 的 API Key"></div>' +
      '<div class="field"><label>模型</label><input type="text" id="t-model" value="' + esc(c.model) + '" list="t-model-list" placeholder="留空默认 speech-2.8-hd">' +
      '<datalist id="t-model-list"><option value="speech-2.8-hd">MiniMax 2.8 高清（推荐）</option><option value="speech-2.6-hd">MiniMax 2.6 高清</option><option value="speech-02-hd">MiniMax 02 高清</option><option value="speech-2.8-turbo">MiniMax 2.8 快速</option><option value="speech-2.6-turbo">MiniMax 2.6 快速</option><option value="tts-1">OpenAI tts-1</option></datalist></div>' +
      '</div>' +
      '<div class="row">' +
      '<div class="field"><label>音色</label>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<select id="t-voice-select" style="flex:1;min-width:180px"><option value="">— 选择常用音色 —</option></select>' +
      '<input type="text" id="t-voice" value="' + esc(c.voice) + '" placeholder="或手动输入音色 ID（如 male-qn-qingse）" style="flex:1;min-width:180px">' +
      '<button class="btn btn-sm btn-outline" id="btn-voice-preview" type="button">试听</button>' +
      '</div>' +
      '<div class="hint" id="voice-hint" style="margin-top:6px;font-size:12px;color:var(--ink2)">下拉选常用音色，或手动输入 MiniMax/OpenAI 音色 ID；点「试听」用当前配置合成一句真实样张并播放（消耗少量字符额度）。</div>' +
      '</div>' +
      '<div class="field"><label>语速</label><select id="t-speed">' +
      [[0.8, '0.8 慢'], [1.0, '1.0 正常'], [1.2, '1.2 稍快'], [1.5, '1.5 快']].map(function (o) {
        return '<option value="' + o[0] + '"' + (String(c.speed) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-sm" id="btn-tts-save">保存 TTS 配置</button> ' +
      '<button class="btn btn-outline btn-sm" id="btn-tts-test">测试合成（生成 2 秒音频并校验文件头）</button> ' +
      '<button class="btn btn-danger btn-sm" id="btn-tts-clear">删除密钥</button>' +
      '<div id="tts-status" style="margin-top:8px"></div>' +
      '<div class="divider"></div><p class="note">CORS 边界（诚实说明）：浏览器直连第三方 TTS 可能被对方跨域策略拦截。若测试报「网络错误/Failed to fetch」，说明该 Provider 不允许浏览器直连，需要改用允许跨域的网关或本地代理，应用不会伪造音频来冒充成功。</p></div>';

    html += '<div class="card"><h2>AI 服务（教案/课程生成）</h2>' +
      '<p class="sub">复用统一首页「设置中心」的 AI 配置（OpenAI 兼容）。当前状态：' +
      (ai.enabled ? '已启用 · 模型 ' + esc(ai.model || '') : '未启用') + '。</p>' +
      '<button class="btn btn-outline btn-sm" onclick="location.href=\'../index.html\'">去统一首页设置中心</button></div>';

    html += '<div class="card"><h2>数据管理与删除</h2>' +
      '<p class="sub">全部数据存本机浏览器（IndexedDB + localStorage）。导出/删除规则与隐私边界如下。</p>' +
      '<button class="btn btn-outline btn-sm" id="btn-data-export">导出全部学习数据（JSON）</button> ' +
      '<button class="btn btn-danger btn-sm" id="btn-data-clear">删除本应用全部数据</button>' +
      '<div class="divider"></div>' +
      '<p class="note">' +
      '· 导出内容：来源登记（含解析文本）、能力树、课程、教案、批注、事件、画像、复习计划；音频文件较大不进 JSON，可逐课下载 ZIP。<br>' +
      '· 删除范围：本页「删除全部」会清空上述所有数据（含批注与画像），不可恢复；资料库原件副本一并删除，你磁盘上的原文件不受影响。<br>' +
      '· 密钥：保存在 localStorage（szn_tts_config），点上方「删除密钥」即清除。<br>' +
      '· 外发边界：默认不把你的私有文件发给任何第三方模型；只有你在本页配置了 TTS、且点「生成音频」时，音频脚本文本才会发送给该 TTS Provider（这就是它合成语音的内容）。AI 教案生成使用统一设置中心的 AI 服务，发送内容为：能力树 JSON + 案例片段（最多 800 字/份）+ 当天主题。如不希望发送，可不配置 AI，使用演示模板流程。</p></div>';

    html += '<div class="card"><h2>云同步（多设备学习记录同步）</h2>' +
      '<p class="sub">复用<b>千手首页「设置中心 → 云同步」</b>的配置（GitHub 私有仓库，与英语/AI英语教练共用同一份配置）。学习记录打包到你的仓库独立文件 <b>szn-data.json</b>，手机/电脑两端通过 GitHub API 自动合并。<b>本地有改动 5 秒后自动上传，每 60 秒自动拉取一次云端</b>；也可点「立即同步」手动触发。密钥（TTS/AI）与音频文件永不入包。</p>' +
      '<div id="sync-status" class="sync-status off" style="margin:6px 0 10px"></div>' +
      '<button class="btn btn-outline btn-sm" onclick="location.href=\'../index.html\'">去千手首页设置中心配置</button> ' +
      '<button class="btn btn-primary btn-sm" id="btn-sync-now">立即同步</button>' +
      '<div class="divider"></div>' +
      '<p class="note">' +
      '· 启用方法：在千手首页「设置中心 → 云同步」填 GitHub 用户名/仓库/令牌并勾选启用，本栏目自动同步，无需在此再改配置。<br>' +
      '· 同步内容：来源登记与解析文本（<b>含国数案例内部资料，上传到你的 GitHub 私有仓库即等同外发到 GitHub</b>）、能力树、目标、课程、教案、批注、事件、画像、复习计划。超大来源（解析文本 &gt;200KB）只同步登记信息。<br>' +
      '· 不同步：音频文件、原件 Blob、TTS/AI 密钥、演示数据占位。<br>' +
      '· 合并规则：同一记录双端都改过时，以修改时间较新的一版为准；删除会通过“墓碑”传播到另一端（若那条记录在删除后又被修改过则保留）。<br>' +
      '· 需联网访问 api.github.com；千手设置中心未启用时不发起任何 GitHub 请求。</p></div>';

    html += '<div class="card"><h2>离线说明</h2><p class="note">' +
      '· 本地双击启动（file://）：应用直接可用，生成的课程/教案/已下载音频都在本机，断网仍可阅读与播放（音频以文件下载方式保存到你选择的目录，播放走本地文件）。Service Worker 不可用（浏览器限制）。<br>' +
      '· GitHub Pages（https）：自动注册 Service Worker，缓存应用壳与页面资源；已下载的课程文本/教案/音频可离线访问。新内容生成（AI/TTS）需要联网。<br>' +
      '· 同步冲突：本应用数据存本机 IndexedDB；已启用「云同步」时多设备自动合并（GitHub 私有仓库中转）；未启用时多设备间不自动同步，如需迁移用「导出全部学习数据」在另一台设备导入。</p></div>';

    $('view-settings').innerHTML = html;

    /* 音色下拉：按当前 Provider 填充；下拉选中→同步到输入框；输入框改动→下拉回"—选择—" */
    function fillVoiceSelect() {
      var sel = $('t-voice-select');
      if (!sel) return;
      var prov = $('t-provider').value;
      var cur = $('t-voice').value.trim();
      var list = voicesFor(prov);
      sel.innerHTML = '<option value="">— 选择常用音色 —</option>' + list.map(function (v) {
        return '<option value="' + esc(v.id) + '"' + (v.id === cur ? ' selected' : '') + '>' + esc(v.name) + ' · ' + esc(v.desc) + '</option>';
      }).join('');
      /* 当前输入框值不在列表里：保持"—选择—"，输入框照常显示 */
    }
    fillVoiceSelect();
    $('t-voice-select').addEventListener('change', function () {
      $('t-voice').value = this.value;
    });
    $('t-voice').addEventListener('input', function () {
      var sel = $('t-voice-select');
      if (sel.value !== this.value.trim()) sel.value = '';
    });
    $('t-provider').addEventListener('change', function () {
      /* 切换 Provider：清空音色输入框（避免 MiniMax 音色名误传给 OpenAI），重建下拉 */
      $('t-voice').value = '';
      fillVoiceSelect();
    });

    $('btn-tts-save').addEventListener('click', function () {
      c = {
        enabled: $('t-enabled').value === '1',
        provider: $('t-provider').value,
        baseUrl: $('t-baseurl').value.trim(),
        apiKey: $('t-key').value.trim(),
        model: $('t-model').value.trim(),
        voice: $('t-voice').value.trim(),
        speed: parseFloat($('t-speed').value) || 1.0
      };
      TTS.saveCfg(c);
      toast('TTS 配置已保存');
    });
    $('btn-tts-test').addEventListener('click', function () {
      var st = $('tts-status');
      st.innerHTML = '<span class="status warn">正在合成测试音频…</span>';
      TTS.saveCfg({
        enabled: $('t-enabled').value === '1', provider: $('t-provider').value,
        baseUrl: $('t-baseurl').value.trim(), apiKey: $('t-key').value.trim(),
        model: $('t-model').value.trim(), voice: $('t-voice').value.trim(),
        speed: parseFloat($('t-speed').value) || 1.0
      });
      TTS.testConnection().then(function (r) {
        st.innerHTML = '<span class="status ok">合成成功：' + r.type + ' · ' + fmtSize(r.size) + (r.durationSec ? ' · ' + Math.round(r.durationSec) + 's' : '') + '（文件头校验已通过，可正常生成 MP3/WAV 下载）</span>';
      }).catch(function (e) {
        st.innerHTML = '<span class="status fail">失败：' + esc(e.message) + '</span><br><span class="note">若是跨域(CORS)拦截，请更换允许浏览器直连的 TTS 网关或使用本地代理；应用不会伪造音频冒充成功。</span>';
      });
    });
    $('btn-tts-clear').addEventListener('click', function () {
      var cfg = TTS.loadCfg(); cfg.apiKey = ''; cfg.enabled = false; TTS.saveCfg(cfg);
      $('t-key').value = ''; $('t-enabled').value = '0';
      toast('密钥已删除');
    });
    /* 试听：用当前表单值（含下拉/手动输入的音色）真实合成一句样张并内联播放 */
    $('btn-voice-preview').addEventListener('click', function () {
      var btn = $('btn-voice-preview');
      var hint = $('voice-hint');
      var key = $('t-key').value.trim();
      var baseUrl = $('t-baseurl').value.trim();
      var voice = $('t-voice').value.trim();
      if (!key) { hint.innerHTML = '<span class="status fail">请先填 API 密钥再试听</span>'; return; }
      if (!baseUrl) { hint.innerHTML = '<span class="status fail">请先填接口地址再试听</span>'; return; }
      var cfg = {
        enabled: true, provider: $('t-provider').value,
        baseUrl: baseUrl, apiKey: key,
        model: $('t-model').value.trim(),
        voice: voice, speed: parseFloat($('t-speed').value) || 1.0
      };
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = '试听中…';
      hint.innerHTML = '<span class="status warn">正在用当前音色真实合成样张…</span>';
      TTS.previewVoice(cfg).then(function (r) {
        var url = URL.createObjectURL(r.blob);
        hint.innerHTML = '<span class="status ok">试听就绪：' + r.blob.type + ' · ' + fmtSize(r.blob.size) + (r.durationSec ? ' · ' + Math.round(r.durationSec) + 's' : '') + '</span><br><audio controls autoplay preload="auto" src="' + url + '" style="width:100%;max-width:520px;margin-top:6px"></audio><br><span class="note">听完觉得合适，点上方「保存 TTS 配置」即可。试听消耗少量字符额度。</span>';
      }).catch(function (e) {
        hint.innerHTML = '<span class="status fail">试听失败：' + esc(e.message) + '</span><br><span class="note">若是跨域(CORS)拦截，请更换允许浏览器直连的 TTS 网关或使用本地代理。</span>';
      }).then(function () {
        btn.disabled = false; btn.textContent = '试听';
      });
    });
    $('btn-data-export').addEventListener('click', exportAllData);
    $('btn-data-clear').addEventListener('click', clearAllData);

    /* 云同步：复用「千手首页设置中心 → 云同步」配置；本页只提供状态展示 + 立即同步 */
    if (window.SZSync) {
      window.SZSync.updateStatusUI();
      $('btn-sync-now').addEventListener('click', function () {
        if (!window.SZSync.isReady()) { toast('请先到千手首页「设置中心 → 云同步」启用', 4000); return; }
        var btn = $('btn-sync-now');
        btn.disabled = true; btn.textContent = '同步中…';
        window.SZSync.syncNow('manual').then(function () { btn.disabled = false; btn.textContent = '立即同步'; });
      });
    }
  }

  function exportAllData() {
    var names = ['sources', 'competency', 'goals', 'courses', 'lessons', 'audioTasks', 'annotations', 'events', 'profile', 'reviews'];
    var out = { app: '数智学习', exportedAt: DB.nowIso(), note: '音频文件不入此包，请逐课下载 ZIP' };
    var chain = Promise.resolve();
    names.forEach(function (n) {
      chain = chain.then(function () {
        return DB.getAll(n).then(function (rows) {
          out[n] = rows.map(function (r) {
            var copy = Object.assign({}, r);
            delete copy.fileBlob;
            if (copy.blob) { copy.blobNote = '（音频 Blob 未导出，' + fmtSize(copy.size) + '）'; delete copy.blob; }
            return copy;
          });
        });
      });
    });
    chain.then(function () {
      TTS.downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), '数智学习_数据导出_' + todayStr() + '.json');
    });
  }

  function clearAllData() {
    if (!confirm('确认删除本应用全部数据？（来源登记、能力树、课程、教案、音频、批注、事件、画像、复习计划全部清空；不可恢复）')) return;
    if (!confirm('再次确认：真的要全部删除吗？建议先导出备份。')) return;
    var names = ['sources', 'competency', 'goals', 'courses', 'lessons', 'audioTasks', 'audioFiles', 'annotations', 'events', 'profile', 'reviews', 'offline', 'deleted'];
    var chain = Promise.resolve();
    names.forEach(function (n) { chain = chain.then(function () { return DB.clear(n); }); });
    chain.then(function () {
      try { localStorage.removeItem(LAST_KEY); } catch (e) { }
      if (window.SZSync) window.SZSync.clearConfig();
      toast('已全部删除，页面将刷新');
      setTimeout(function () { location.hash = '#/home'; location.reload(); }, 900);
    });
  }

  /* ================================================================
   * 启动
   * ================================================================ */
  document.addEventListener('DOMContentLoaded', function () { init(); });
  window.SZNApp = { goto: goto, openReader: openReader, refresh: route, toast: toast,
    /* 测试钩子：与生产共用同一实现（供 .temp/progress-check.mjs 验证进度条组件） */
    _test: { genStart: genBusyStart, genUpdate: genBusyUpdate, genEnd: genBusyEnd } };
})();
