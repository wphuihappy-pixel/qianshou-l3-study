/**
 * EApp · AI英语教练主应用（千手学习Agent 第4栏目）
 * 视图：今日 / 阅读 / 对话 / 复习 / 资产库 / 报告 / 设置
 * 流程：首次测评 → 画像 → 每日计划 → 逐块执行（可中断续学）→ 每日反馈 / 周报
 * 铁律：掌握度与复习日期只由规则更新；AI 输出展示时标注；音频/密钥默认不外传
 */
(function () {
  'use strict';

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function $(id) { return document.getElementById(id); }
  var viewRoot, tabRoot;

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(EApp._toastT);
    EApp._toastT = setTimeout(function () { t.hidden = true; }, 3000);
  }
  var busyCount = 0;
  function busy(show, text) {
    busyCount += show ? 1 : -1;
    if (busyCount < 0) busyCount = 0;
    var bar = $('busy-bar');
    bar.hidden = busyCount === 0;
    if (show && text) $('busy-text').textContent = text;
  }
  function modal(html) {
    var root = $('modal-root');
    root.innerHTML = '<div class="modal-mask" id="modal-mask"><div class="modal">' + html + '</div></div>';
    $('modal-mask').addEventListener('click', function (e) {
      if (e.target.id === 'modal-mask') { root.innerHTML = ''; }
    });
  }
  function closeModal() { $('modal-root').innerHTML = ''; }
  function aiReady() { return !!(window.AgentShared && AgentShared.AI.isReady()); }
  function requireAI() {
    if (aiReady()) return true;
    modal('<h3>需要先配置 AI</h3><p class="kv">AI 英语教练的核心能力（计划生成、内容加工、对话教练）需要 AI 服务。</p>' +
      '<p class="kv">请到 <b>千手学习Agent 首页 → 设置中心 → AI 服务</b> 填写 OpenAI 兼容地址与密钥（MiniMax 填 <span class="en">https://api.minimax.cn</span>、模型 <span class="en">MiniMax-M2.5</span> 或 <span class="en">MiniMax-M3.1-Flash-Preview</span>），保存后返回本页。</p>' +
      '<p class="hint">未配置时仍可浏览与复习已学内容，但新内容加工与对话将以规则模板兜底。</p>' +
      '<div style="margin-top:14px;text-align:right"><button class="btn btn-ink btn-sm" onclick="document.getElementById(\'modal-root\').innerHTML=\'\'">知道了</button></div>');
    return false;
  }

  function logEvent(type, data) {
    return EDB.put('events', { id: EDB.uid(), type: type, date: EDB.dayKey(), data: data || {}, created_at: EDB.nowIso() });
  }

  /* ================================================================
   * 路由与顶栏
   * ================================================================ */
  var TABS = [
    { id: 'today',  label: '今日' },
    { id: 'reading', label: '阅读' },
    { id: 'speak',  label: '对话' },
    { id: 'review', label: '复习' },
    { id: 'library', label: '资产库' },
    { id: 'report', label: '报告' },
    { id: 'settings', label: '设置' }
  ];
  var EApp = window.EApp = { view: 'today' };

  function renderTabs() {
    tabRoot.innerHTML = TABS.map(function (t) {
      return '<button class="tab' + (EApp.view === t.id ? ' cur' : '') + '" data-v="' + t.id + '">' + t.label + '</button>';
    }).join('');
    tabRoot.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-v')); });
    });
  }

  function go(view) {
    EApp.view = view;
    renderTabs();
    try { window.scrollTo(0, 0); } catch (e) {}
    if (view === 'today') renderToday();
    else if (view === 'reading') renderReading();
    else if (view === 'speak') renderSpeak();
    else if (view === 'review') renderReview();
    else if (view === 'library') renderLibrary();
    else if (view === 'report') renderReport();
    else if (view === 'settings') renderSettings();
  }
  EApp.go = go;

  function render(viewHtml) {
    viewRoot.innerHTML = '<div class="view">' + viewHtml + '</div>';
  }

  /* ================================================================
   * 首次进入：Onboarding + 基线测评
   * ================================================================ */
  function renderOnboarding() {
    tabRoot.innerHTML = '';
    render(
      '<div class="hero"><div class="daytag">AI ENGLISH COACH</div>' +
      '<h1>让英语成为你的工具，而不是一门学科</h1>' +
      '<p>90 天计划：真实内容 → 理解 → 输出 → 反馈 → 复习。先用 10–15 分钟做一个基线测评，看清现在的位置和 90 天方向。</p></div>' +
      '<div class="panel"><h2>先花 10–15 分钟认识你的英语</h2>' +
      '<p class="kv">五段式测评：<b>简单阅读 → 听力 → 词汇 → 口语 → 写作</b>。不需要准备，怎么真实怎么来。听不懂、说不出都没关系——这正是教练要帮你补的。</p>' +
      '<div class="divider"></div>' +
      '<button class="btn btn-cinnabar btn-lg" id="btn-start-assess">开始测评（Start Assessment）</button>' +
      ' <button class="btn btn-outline" id="btn-skip-assess">跳过（先用演示模式看看）</button>' +
      '<p class="hint" style="margin-top:12px">跳过会使用保守的默认基线（A1，词汇量约1000），之后学习过程中会持续隐式重估，不会被第一次测试永久定义。</p></div>'
    );
    $('btn-start-assess').addEventListener('click', function () { startAssessment(); });
    $('btn-skip-assess').addEventListener('click', function () {
      var p = ECA.defaultProfile();
      p.baseline = { date: EDB.nowIso(), level: 'A1（跳过测评的默认估计）', vocabEst: 1000, summary: '未测评，使用保守默认值。' };
      SKILL_INIT(p);
      ECA.saveProfile(p).then(function () { renderToday(); renderTabs(); });
    });
  }

  function SKILL_INIT(p) {
    var init = { vocabulary: 1.8, listening: 1.5, reading: 2.0, speaking: 1.0, pronunciation: 1.0, writing: 1.0, fluency: 1.0, grammar: 1.2, naturalness: 1.0 };
    ECA.SKILLS.forEach(function (k) { if (!p.skills[k]) p.skills[k] = init[k] || 1.0; });
  }

  /* ---------- 测评题库（内置，规则判分） ---------- */
  var ASSESS = {
    reading: {
      text: 'AI agents are programs that do tasks for you. They can plan steps, use tools, and check their own work. A chatbot only talks, but an agent acts. Small teams use agents to save time every day.',
      qs: [
        { q: 'According to the text, what is the big difference between a chatbot and an agent?',
          opts: ['A chatbot only talks, but an agent acts.', 'Agents are faster than chatbots.', 'Chatbots are free, agents cost money.'], a: 0 },
        { q: 'Why do small teams use agents?',
          opts: ['To make websites.', 'To save time every day.', 'To play games.'], a: 1 }
      ]
    },
    listening: [
      { say: 'AI helps small teams build products faster.', opts: ['AI helps small teams build products faster.', 'AI makes small teams build slower.', 'AI sells products to teams.'], a: 0 },
      { say: 'You should check the results, because agents still make mistakes.', opts: ['You should check the results, because agents still make mistakes.', 'You should never check the results.', 'Agents never make any mistakes.'], a: 0 }
    ],
    vocab: ['agent', 'task', 'plan', 'tool', 'check', 'team', 'build', 'product', 'faster', 'mistake', 'deploy', 'improve', 'manage', 'design', 'understand']
  };

  var assessState;
  function startAssessment() {
    assessState = {
      step: 0,
      reading: { right: 0, total: ASSESS.reading.qs.length, qi: 0, answers: [] },
      listening: { right: 0, total: ASSESS.listening.length, li: 0 },
      vocab: { known: 0, total: ASSESS.vocab.length, marks: [] },
      speaking: { transcript: '' },
      writing: { text: '' }
    };
    renderStep();
  }

  function renderStep() {
    var s = assessState;
    var stepNames = ['阅读', '听力', '词汇', '口语', '写作'];
    var head = '<div class="panel"><h2>基线测评 · 第 ' + (s.step + 1) + '/5 步：' + stepNames[s.step] + '</h2><p class="sub">真实作答即可，测评只是起点，不是考试。</p>';

    if (s.step === 0) {
      var q = ASSESS.reading.qs[s.reading.qi];
      var body = s.reading.qi === 0
        ? '<div class="reader-text" style="font-size:15px">' + esc(ASSESS.reading.text) + '</div>'
        : '';
      render(head + body +
        '<div class="quiz-q">' + (s.reading.qi + 1) + '. ' + esc(q.q) + '</div>' +
        q.opts.map(function (o, i) {
          return '<button class="quiz-opt" data-i="' + i + '">' + esc(o) + '</button>';
        }).join('') + '</div>');
      viewRoot.querySelectorAll('.quiz-opt').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = +b.getAttribute('data-i');
          var ok = i === q.a;
          if (ok) s.reading.right++;
          viewRoot.querySelectorAll('.quiz-opt').forEach(function (x, xi) {
            x.disabled = true;
            if (xi === q.a) x.classList.add('right');
            else if (xi === i) x.classList.add('wrong');
          });
          setTimeout(function () {
            s.reading.qi++;
            if (s.reading.qi < ASSESS.reading.qs.length) renderStep();
            else { s.step = 1; renderStep(); }
          }, 700);
        });
      });
    }

    if (s.step === 1) {
      var l = ASSESS.listening[s.listening.li];
      render(head +
        '<div class="quiz-voice"><button class="btn btn-cinnabar" id="btn-play-listen">播放句子（可重听）</button></div>' +
        '<div class="quiz-q">你听到了什么？</div>' +
        l.opts.map(function (o, i) {
          return '<button class="quiz-opt" data-i="' + i + '">' + esc(o) + '</button>';
        }).join('') + '</div>');
      $('btn-play-listen').addEventListener('click', function () {
        ECTTS.say(l.say, { rate: 0.9 });
      });
      /* 自动播一次 */
      ECTTS.say(l.say, { rate: 0.9 });
      viewRoot.querySelectorAll('.quiz-opt').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = +b.getAttribute('data-i');
          if (i === l.a) s.listening.right++;
          viewRoot.querySelectorAll('.quiz-opt').forEach(function (x, xi) {
            x.disabled = true;
            if (xi === l.a) x.classList.add('right');
            else if (xi === i) x.classList.add('wrong');
          });
          setTimeout(function () {
            s.listening.li++;
            if (s.listening.li < ASSESS.listening.length) renderStep();
            else { s.step = 2; renderStep(); }
          }, 700);
        });
      });
    }

    if (s.step === 2) {
      render(head + '<p class="kv">下面这些词，<b>认识（看见能想起意思）</b>就勾选。不认识的不要勾——诚实最重要。</p>' +
        '<div style="margin:12px 0">' + ASSESS.vocab.map(function (w, i) {
          return '<label style="display:inline-flex;align-items:center;gap:5px;margin:4px 10px 4px 0;padding:5px 12px;border:1px solid var(--line);background:var(--card);font-size:14px;cursor:pointer">' +
            '<input type="checkbox" data-v="' + i + '"> <span class="en">' + esc(w) + '</span></label>';
        }).join('') + '</div>' +
        '<button class="btn btn-cinnabar btn-lg" id="btn-vocab-done">下一步：口语</button></div>');
      $('btn-vocab-done').addEventListener('click', function () {
        viewRoot.querySelectorAll('input[type=checkbox]').forEach(function (c) {
          if (c.checked) s.vocab.known++;
        });
        s.step = 3; renderStep();
      });
    }

    if (s.step === 3) {
      render(head + '<p class="kv">用英语做个简单自我介绍（30 秒左右）：你是谁、做什么工作。按下麦克风开始，说完自动停。<b>说不出完整句子也没关系，蹦单词也算真实水平。</b></p>' +
        '<div class="quiz-voice">' +
        '<button class="mic-btn" id="btn-mic-assess"><span>开始</span><span>说话</span></button>' +
        '<div class="mic-state" id="assess-mic-state">点击麦克风开始</div></div>' +
        '<div id="assess-transcript" class="panel alt" style="display:none;margin-top:12px"><b>识别结果：</b><span id="assess-transcript-txt"></span></div>' +
        '<div style="margin-top:12px"><button class="btn btn-outline" id="btn-speak-skip">跳过口语（识别不可用时）</button> ' +
        '<button class="btn btn-cinnabar" id="btn-speak-next" style="display:none">下一步：写作</button></div></div>');
      var mb = $('btn-mic-assess');
      mb.addEventListener('click', function () {
        mb.disabled = true;
        $('assess-mic-state').textContent = '正在听…（说完停顿1.5秒自动结束）';
        ECSTT.listen({ onState: function (st) { $('assess-mic-state').textContent = st === 'listening' ? '正在听…' : '检测到停顿，正在识别…'; } })
          .then(function (r) {
            s.speaking.transcript = r.text;
            $('assess-transcript').style.display = '';
            $('assess-transcript-txt').textContent = r.text + '（识别来源：' + r.provider + '）';
            $('assess-mic-state').textContent = '已识别。可重录或下一步。';
            mb.disabled = false;
            $('btn-speak-next').style.display = '';
          })
          .catch(function (err) {
            $('assess-mic-state').textContent = '识别失败：' + err.message;
            mb.disabled = false;
            toast('语音识别不可用，可跳过口语或改用文字：' + err.message);
          });
      });
      $('btn-speak-skip').addEventListener('click', function () { s.step = 4; renderStep(); });
      $('btn-speak-next').addEventListener('click', function () { s.step = 4; renderStep(); });
    }

    if (s.step === 4) {
      render(head + '<p class="kv">写 2–3 句英文，简单介绍你的工作（做什么、和 AI 有什么关系）。写不出来就写单句，真实水平最重要。</p>' +
        '<textarea class="field" id="assess-writing" rows="4" placeholder="I work on ..."></textarea>' +
        '<div style="margin-top:12px"><button class="btn btn-cinnabar btn-lg" id="btn-finish-assess">完成测评，生成我的画像</button></div></div>');
      $('btn-finish-assess').addEventListener('click', function () {
        s.writing.text = $('assess-writing').value.trim();
        finishAssessment();
      });
    }
  }

  function finishAssessment() {
    var s = assessState;
    if (!aiReady()) { toast('AI 未配置：画像将用规则估计生成（之后可重新测评）'); }
    busy(true, '正在分析你的测评，生成画像…');
    var evidence = {
      readingRate: s.reading.right / s.reading.total,
      listeningRate: s.listening.right / s.listening.total,
      vocabRate: s.vocab.known / s.vocab.total,
      speakingText: s.speaking.transcript || '',
      writingText: s.writing.text || '',
      skipped: { speaking: !s.speaking.transcript, writing: !s.writing.text }
    };
    ECA.assessBaseline(evidence).then(function (r) {
      busy(false);
      return ECA.getProfile().then(function (p) {
        p = p || ECA.defaultProfile();
        p.baseline = {
          date: EDB.nowIso(),
          level: r.level || 'A1-A2',
          vocabEst: r.vocabEst || Math.round(evidence.vocabRate * 1000),
          summary: r.summary || ''
        };
        ECA.SKILLS.forEach(function (k) { p.skills[k] = r.skills && typeof r.skills[k] === 'number' ? r.skills[k] : p.skills[k]; });
        p.focusAreas = r.focusAreas || [];
        p.phaseStart = EDB.nowIso();
        return ECA.saveProfile(p).then(function () {
          return EDB.put('assessments', {
            id: EDB.uid(), type: 'baseline', date: EDB.dayKey(),
            evidence: evidence, result: r, created_at: EDB.nowIso()
          });
        });
      });
    }).then(function () {
      renderTabs();
      renderToday(true);
      toast('画像已生成。每天学习会持续隐式重估，你不会被第一次测试永久定义。');
    }).catch(function (err) {
      busy(false);
      toast('生成画像失败：' + err.message);
    });
  }

  /* ================================================================
   * 今日 · Dashboard + 每日计划
   * ================================================================ */
  var PHASE_WEIGHTS = {
    1: { reading: 0.34, listening: 0.26, conversation: 0.25, writing: 0.15 },
    2: { reading: 0.42, listening: 0.24, conversation: 0.22, writing: 0.12 },
    3: { reading: 0.50, listening: 0.22, conversation: 0.18, writing: 0.10 }
  };

  function buildDraft(minutes, digest) {
    var w = PHASE_WEIGHTS[digest.profile.phase || 1];
    var blocks = [];
    var reviewMin = Math.min(8, Math.max(5, Math.round((digest.dueReviews || 0) * 1.2)));
    var contentPromise = ECContent.pickUnread();
    return contentPromise.then(function (content) {
      blocks.push({ type: 'review', minutes: Math.min(reviewMin, minutes), label: '间隔复习', why: (digest.dueReviews || 0) + ' 项到期（词/错/表达）', contentId: null });
      var remain = minutes - blocks[0].minutes;
      var scale = remain / minutes;
      function add(type) {
        var m = Math.round(minutes * w[type] * scale);
        if (m >= 5) blocks.push({ type: type, minutes: m, label: '', why: '', contentId: type === 'reading' ? (content ? content.id : null) : null });
      }
      add('reading'); add('listening'); add('conversation'); add('writing');
      if (!blocks.some(function (b) { return b.type === 'reading'; }) && content) {
        blocks.push({ type: 'reading', minutes: 5, label: '', why: '', contentId: content.id });
      }
      return { blocks: blocks, focus: '口语 + 听力', note: '' };
    });
  }

  function todayPlan(force) {
    var today = EDB.dayKey();
    return EDB.byIndex('dailyPlans', 'byDate', today).then(function (rows) {
      var existing = (rows || []).filter(function (p) { return p.status !== 'archived'; })[0];
      if (existing && !force) return existing;
      if (!aiReady()) {
        /* 未配置 AI：纯规则计划 */
        return ECA.buildDigest().then(function (d) {
          return buildDraft(minutesToday(d.profile), d).then(function (draft) {
            draft.fallback = true;
            return savePlan(draft, today);
          });
        });
      }
      return ECA.buildDigest().then(function (d) {
        return buildDraft(minutesToday(d.profile), d).then(function (draft) {
          busy(true, 'AI 教练正在为今天排计划…');
          return ECA.dailyPlan(minutesToday(d.profile), draft).then(function (mission) {
            busy(false);
            return savePlan(mission, today);
          }).catch(function (e) { busy(false); draft.fallback = true; return savePlan(draft, today); });
        });
      });
    });
  }
  function minutesToday(profile) {
    var d = new Date().getDay();
    var weekend = (d === 0 || d === 6);
    return weekend ? (profile.dailyMinutesWeekend || 60) : (profile.dailyMinutesWeekday || 30);
  }
  function savePlan(mission, today) {
    var plan = {
      id: EDB.uid(), date: today, status: 'active',
      blocks: (mission.blocks || []).map(function (b) {
        return {
          type: b.type, minutes: b.minutes || 5,
          label: b.label || TYPE_LABEL(b.type), why: b.why || '', contentId: b.contentId || null,
          done: false
        };
      }),
      focus: mission.focus || '', note: mission.note || '',
      fallback: !!mission.fallback,
      created_at: EDB.nowIso()
    };
    return EDB.put('dailyPlans', plan).then(function () { return plan; });
  }
  function TYPE_LABEL(t) {
    return { review: '间隔复习', reading: '真实阅读', listening: '听力训练', conversation: '口语对话', writing: '写作练习' }[t] || t;
  }

  function getActiveSession(today) {
    return EDB.byIndex('sessions', 'byDate', today).then(function (rows) {
      return (rows || []).filter(function (s) { return s.status === 'active'; })[0] || null;
    });
  }

  function renderToday(justBaseline) {
    ECA.getProfile().then(function (p) {
      if (!p || !p.baseline) { renderOnboarding(); return; }
      var today = EDB.dayKey();
      Promise.all([
        todayPlan(),
        ECR.countDue(),
        getActiveSession(today),
        EDB.getAll('dailyPlans'),
        EDB.byIndex('reading', 'byDate', today),
        EDB.getAll('events')
      ]).then(function (r) {
        var plan = r[0], due = r[1], session = r[2], allPlans = r[3], todayReadings = r[4];
        var todayEvents = (r[5] || []).filter(function (e) { return e.date === today; });
        var doneCount = plan.blocks.filter(function (b) { return b.done; }).length;
        var allDone = doneCount === plan.blocks.length && plan.blocks.length > 0;

        var hour = new Date().getHours();
        var greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        var streak = calcStreak(allPlans);

        var html = '<div class="hero"><div class="daytag">DAY ' + dayIndex(p) + ' · PHASE ' + (p.phase || 1) + '</div>' +
          '<h1>' + greet + ', ' + esc(p.name || 'friend') + '</h1>' +
          '<p>今日重点：' + esc(plan.focus || '口语 + 听力') + (streak > 1 ? ' · 已连续学习 ' + streak + ' 天' : '') + '</p></div>';

        /* 今日任务 */
        html += '<div class="panel"><h2>Today\'s Mission · ' + plan.blocks.reduce(function (a, b) { return a + b.minutes; }, 0) + ' 分钟' + (plan.fallback ? '（规则模板，AI 未配置）' : '') + '</h2>';
        if (plan.note) html += '<p class="kv" style="margin-bottom:10px">教练：' + esc(plan.note) + '</p>';
        html += plan.blocks.map(function (b, i) {
          return '<div class="mblock' + (b.done ? ' done' : '') + '" data-b="' + i + '">' +
            '<div class="mico">' + esc((b.label || TYPE_LABEL(b.type)).slice(0, 2)) + '</div>' +
            '<div><div class="mname">' + esc(b.label || TYPE_LABEL(b.type)) + (b.contentId ? '（含 1 篇内容）' : '') + '</div>' +
            '<div class="mwhy">' + esc(b.why || '') + '</div></div>' +
            '<div class="mmin">' + b.minutes + ' min</div></div>';
        }).join('');
        var resume = session && session.progress && session.progress.some(function (b) { return !b.done; });
        html += '<button class="start-huge" id="btn-start-mission">' +
          (allDone ? '已完成 · 再来一轮 5 分钟速练' : resume ? 'Continue · 从上次继续' : 'Start Learning') + '</button>';
        html += '<div style="margin-top:10px;text-align:center">' +
          '<button class="btn btn-ghost btn-sm" id="btn-replan">重新生成今日计划</button></div></div>';

        /* 9 维 */
        html += '<div class="panel"><h2>Your Progress · 9 维能力</h2>' +
          ECA.SKILLS.map(function (k) {
            var v = p.skills[k] || 0;
            var trend = trendOf(p, k);
            return '<div class="skill-row"><span class="sn">' + ECA.SKILL_CN[k] + '</span>' +
              '<div class="sbar"><i style="width:' + Math.min(100, v / 5 * 100) + '%"></i></div>' +
              '<span class="sval">' + v.toFixed(1) + '</span>' +
              '<span class="strend ' + (trend > 0 ? 'up' : trend < 0 ? 'down' : '') + '">' + (trend > 0 ? '↑' : trend < 0 ? '↓' : '→') + '</span></div>';
          }).join('') +
          '<p class="hint" style="margin-top:10px">0–5 为训练证据的内部估计，不等于考试分数；趋势对比的是上周均值。看得出来：你弱在哪，教练就补哪。</p></div>';

        /* 推荐内容 */
        html += '<div class="panel"><h2>Today\'s Recommended</h2><div id="rec-list">读取中…</div></div>';

        /* 昨日反馈（若有） */
        var lastDigest = todayEvents.filter(function (e) { return e.type === 'daily_digest'; })[0];
        if (lastDigest && lastDigest.data && lastDigest.data.improved) {
          html += '<div class="panel alt"><h2>上次反馈</h2><p class="kv"><b>进步：</b>' + esc(lastDigest.data.improved) + '</p>' +
            '<p class="kv"><b>明天重点：</b>' + esc(lastDigest.data.tomorrowFocus || '') + '</p></div>';
        }

        render(html);
        $('btn-start-mission').addEventListener('click', function () { startMission(plan); });
        $('btn-replan').addEventListener('click', function () {
          EDB.byIndex('dailyPlans', 'byDate', today).then(function (rows) {
            (rows || []).forEach(function (p2) { p2.status = 'archived'; EDB.put('dailyPlans', p2); });
            renderToday();
          });
        });
        ECContent.listContent('processed').then(function (rows) {
          var el = $('rec-list');
          if (!el) return;
          var readToday = {};
          todayReadings.forEach(function (rr) { readToday[rr.contentId] = true; });
          var recs = rows.slice(0, 3);
          el.innerHTML = recs.length ? recs.map(function (c, i) {
            return '<div class="kv" style="padding:6px 0;border-bottom:1px dashed var(--line)">' +
              (i + 1) + '. <b class="en">' + esc(c.title) + '</b> ' +
              '<span class="tag">' + esc((c.difficulty && c.difficulty.label) || '') + '</span>' +
              (readToday[c.id] ? ' <span class="tag tag-ok">今日已读</span>' : '') +
              '<span style="color:var(--ink3);font-size:12px"> · ' + esc(c.source) + '</span></div>';
          }).join('') + '<p class="hint">AI 采集或粘贴的真实内容会出现在这里（见「阅读」页导入）。</p>'
            : '<div class="empty">还没有加工好的内容。去「阅读」页导入并加工第一篇。</div>';
        });
      });
    });
  }

  function dayIndex(p) {
    if (!p.phaseStart) return 1;
    var d = Math.floor((Date.now() - new Date(p.phaseStart).getTime()) / 86400000) + 1;
    return Math.max(1, Math.min(90, d));
  }
  function calcStreak(plans) {
    var days = {};
    (plans || []).forEach(function (p) {
      if (p.blocks && p.blocks.some(function (b) { return b.done; })) days[p.date] = true;
    });
    var streak = 0, d = new Date();
    for (var i = 0; i < 90; i++) {
      var key = EDB.dayKey(d);
      if (days[key]) { streak++; d.setDate(d.getDate() - 1); }
      else if (i === 0) { d.setDate(d.getDate() - 1); }  /* 今天没学不断签 */
      else break;
    }
    return streak;
  }
  function trendOf(p, skill) {
    return (p.skillTrends && typeof p.skillTrends[skill] === 'number') ? p.skillTrends[skill] : 0;
  }

  /* ================================================================
   * Mission 执行（可中断续学）
   * ================================================================ */
  function startMission(plan) {
    var today = EDB.dayKey();
    getActiveSession(today).then(function (session) {
      if (!session) {
        session = { id: EDB.uid(), date: today, mode: 'daily', status: 'active', progress: plan.blocks.map(function (b) { return { type: b.type, done: b.done, minutes: b.minutes }; }), started_at: EDB.nowIso() };
        EDB.put('sessions', session);
      }
      EApp.session = session;
      EApp.plan = plan;
      runNextBlock();
    });
  }

  function runNextBlock() {
    var plan = EApp.plan, session = EApp.session;
    var idx = -1;
    for (var i = 0; i < plan.blocks.length; i++) {
      if (!session.progress[i] || !session.progress[i].done) { idx = i; break; }
    }
    if (idx < 0) { finishMission(); return; }
    var b = plan.blocks[idx];
    EApp.blockIndex = idx;
    renderMissionView(idx);
    if (b.type === 'review') runReviewBlock(b, idx);
    else if (b.type === 'reading') runReadingBlock(b, idx);
    else if (b.type === 'listening') runListeningBlock(b, idx);
    else if (b.type === 'conversation') runConversationBlock(b, idx);
    else if (b.type === 'writing') runWritingBlock(b, idx);
  }

  function renderMissionView(idx) {
    var plan = EApp.plan;
    render('<div class="panel"><h2>Mission · ' + (idx + 1) + '/' + plan.blocks.length + '</h2>' +
      plan.blocks.map(function (b, i) {
        var done = EApp.session.progress[i] && EApp.session.progress[i].done;
        return '<span class="tag' + (done ? ' tag-ok' : '') + '" style="margin:0 6px 6px 0">' + (done ? '✓ ' : '') + esc(b.label || TYPE_LABEL(b.type)) + '</span>';
      }).join('') + '</div><div id="block-root"></div>' +
      '<div style="text-align:center;margin:10px 0"><button class="btn btn-outline btn-sm" id="btn-exit-mission">先到这里（下次继续）</button></div>');
    $('btn-exit-mission').addEventListener('click', function () {
      saveProgress();
      toast('进度已保存，下次打开继续。');
      go('today');
    });
  }
  var blockRoot = function () { return $('block-root'); };

  function saveProgress() {
    var s = EApp.session;
    if (!s) return;
    s.updated_at = EDB.nowIso();
    EDB.put('sessions', s);
  }

  function completeBlock(idx, extra) {
    var plan = EApp.plan, s = EApp.session;
    s.progress[idx].done = true;
    plan.blocks[idx].done = true;
    EDB.put('dailyPlans', plan);
    EDB.put('activities', Object.assign({
      id: EDB.uid(), sessionId: s.id, date: EDB.dayKey(),
      type: plan.blocks[idx].type, minutes: plan.blocks[idx].minutes,
      created_at: EDB.nowIso()
    }, extra || {}));
    saveProgress();
    toast('这一块完成。');
    runNextBlock();
  }

  function finishMission() {
    var s = EApp.session;
    s.status = 'done'; s.ended_at = EDB.nowIso();
    EDB.put('sessions', s);
    /* 生成每日结束反馈（不是"恭喜完成"） */
    var today = EDB.dayKey();
    EDB.byIndex('activities', 'bySession', s.id).then(function (acts) {
      var stats = {
        totalMinutes: acts.reduce(function (a, x) { return a + (x.minutes || 0); }, 0),
        byType: {}, newExpressions: 0, repeatedMistakes: 0
      };
      acts.forEach(function (a) { stats.byType[a.type] = (stats.byType[a.type] || 0) + (a.minutes || 0); });
      return EDB.byIndex('events', 'byDate', today).then(function (evts) {
        (evts || []).forEach(function (e) {
          if (e.type === 'vocab_added') stats.newExpressions++;
          if (e.type === 'mistake_logged') stats.repeatedMistakes++;
        });
        stats.activities = acts.map(function (a) { return { type: a.type, minutes: a.minutes }; });
        return ECA.dailyDigest(stats).then(function (d) {
          d.type = 'daily';
          d.stats = stats;
          EDB.put('events', { id: EDB.uid(), type: 'daily_digest', date: today, data: d, created_at: EDB.nowIso() });
          showDailyDigest(d, stats);
          /* 9 维微调（规则、可解释） */
          return ECA.getProfile().then(function (p) {
            var adj = { reading: 0.05, listening: 0.05, conversation: 0.1, writing: 0.06, review: 0.03 };
            acts.forEach(function (a) {
              var k = { reading: 'reading', listening: 'listening', conversation: 'speaking', writing: 'writing', review: 'vocabulary' }[a.type];
              if (k) p.skills[k] = Math.min(5, +(p.skills[k] + (adj[a.type] || 0.05)).toFixed(2));
            });
            ECA.saveProfile(p);
          });
        });
      });
    }).catch(function (err) { toast('反馈生成失败：' + err.message); go('today'); });
  }

  function showDailyDigest(d, stats) {
    var byTypeCn = { reading: '阅读', listening: '听力', conversation: '口语', writing: '写作', review: '复习' };
    render('<div class="hero"><div class="daytag">TODAY · DONE</div><h1>Today</h1>' +
      '<p>练了什么、进步了什么、明天看哪里——不是"恭喜完成"。</p></div>' +
      '<div class="panel"><h2>You practiced</h2>' +
      Object.keys(stats.byType || {}).map(function (k) {
        return '<div class="kv"><b>' + (byTypeCn[k] || k) + '</b> ' + stats.byType[k] + ' 分钟</div>';
      }).join('') +
      '<div class="kv"><b>新表达</b> ' + (stats.newExpressions || 0) + ' · <b>重复错误</b> ' + (stats.repeatedMistakes || 0) + '</div></div>' +
      '<div class="panel"><h2>Improved</h2><p class="kv">' + esc(d.improved || '—') + '</p>' +
      '<h2 style="margin-top:14px">Needs attention</h2><p class="kv">' + esc(d.needsAttention || '—') + '</p>' +
      '<h2 style="margin-top:14px">Tomorrow</h2><p class="kv">' + esc(d.tomorrowFocus || '—') + '</p>' +
      '<div class="divider"></div><p class="kv"><b>教练：</b><span class="en">' + esc(d.coachWord || 'Keep going.') + '</span></p>' +
      (d.fallback ? '<p class="hint">（AI 未配置，此为规则模板反馈）</p>' : '') + '</div>' +
      '<div style="text-align:center"><button class="btn btn-ink btn-lg" onclick="EApp.go(\'today\')">回到首页</button></div>');
  }

  /* ---------- 各块执行 ---------- */

  /* 复习块：把到期项过一遍 */
  function runReviewBlock(b, idx) {
    blockRoot().innerHTML = '<p class="kv">读取到期复习项…</p>';
    ECR.dueToday().then(function (items) {
      if (!items.length) {
        blockRoot().innerHTML = '<div class="empty">今天没有到期复习。直接进入下一块。</div>' +
          '<button class="btn btn-cinnabar" id="btn-skip-rev" style="margin-top:10px">下一块</button>';
        $('btn-skip-rev').addEventListener('click', function () { completeBlock(idx, { note: '无到期项' }); });
        return;
      }
      EApp.revQueue = items;
      EApp.revIndex = 0;
      renderReviewCard(idx, true);
    });
  }

  function renderReviewCard(blockIdx, inMission) {
    var q = EApp.revQueue[EApp.revIndex];
    if (!q) {
      if (inMission) { completeBlock(blockIdx, { note: '复习完成' }); }
      else { renderReview(); toast('今日复习已清空。'); }
      return;
    }
    var root = inMission ? blockRoot() : ($('review-root') || viewRoot);
    var typeCn = ECR.TYPE_CN[q.itemType] || q.itemType;
    root.innerHTML = '<div class="rev-card">' +
      '<div class="rc-type">' + typeCn + ' · ' + (EApp.revIndex + 1) + '/' + EApp.revQueue.length + '</div>' +
      '<div class="rc-main"><span class="en">' + esc(q.label || '') + '</span></div>' +
      '<div class="rc-sub">先在脑子里回想，再点"看答案"。</div>' +
      '<div id="rev-answer" style="display:none">' +
      '<div class="divider"></div><div class="kv" id="rev-answer-body">读取中…</div></div>' +
      '<div class="rev-actions" style="margin-top:14px">' +
      '<button class="btn btn-outline" id="btn-rev-show">看答案</button></div>' +
      '<div class="rev-actions" id="rev-grades" style="display:none;margin-top:10px">' +
      '<button class="btn btn-danger" data-g="again">没想起（1天后再见）</button>' +
      '<button class="btn btn-outline" data-g="hard">想起来了（较费劲）</button>' +
      '<button class="btn btn-cinnabar" data-g="good">简单（进入下个间隔）</button></div></div>' +
      (inMission ? '' : '<div style="text-align:center;margin:8px 0"><button class="btn btn-ghost btn-sm" id="btn-rev-exit">先到这里</button></div>');

    $('btn-rev-show').addEventListener('click', function () {
      $('rev-answer').style.display = '';
      $('rev-grades').style.display = 'flex';
      $('btn-rev-show').style.display = 'none';
      loadAnswer(q, $('rev-answer-body'));
    });
    viewRoot.querySelectorAll('#rev-grades [data-g]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var g = btn.getAttribute('data-g');
        busy(true, '记录复习结果…');
        ECR.grade(q, g).then(function () {
          /* good 且跨天 → 对应资产 mastery 证据 +0.05（规则微调） */
          return onReviewGraded(q, g);
        }).then(function () {
          busy(false);
          EApp.revIndex++;
          renderReviewCard(blockIdx, inMission);
        }).catch(function (e) { busy(false); toast(e.message); });
      });
    });
    if ($('btn-rev-exit')) $('btn-rev-exit').addEventListener('click', function () { go('today'); });
  }

  function loadAnswer(q, el) {
    var storeMap = { vocabulary: 'vocabulary', expression: 'expressions', mistake: 'mistakes', listening: 'listeningIssues', pronunciation: 'pronunciationIssues', grammar: 'grammarPatterns' };
    var st = storeMap[q.itemType];
    if (!st) { el.innerHTML = '<b>' + esc(q.label) + '</b>'; return; }
    EDB.get(st, q.itemId).then(function (it) {
      if (!it) { el.innerHTML = '<b>' + esc(q.label) + '</b>'; return; }
      if (q.itemType === 'mistake') {
        el.innerHTML = '<b>纠正后：</b><span class="en">' + esc(it.corrected || '') + '</span><br>' +
          '<b>你的原句：</b><span class="en" style="color:var(--ink3)">' + esc(it.original || '') + '</span>' +
          '<div class="hint" style="margin-top:6px">试着用新场景再表达一次（不是背原句）。</div>';
      } else {
        el.innerHTML = '<b>' + esc(it.meaning || it.example || '') + '</b>' +
          (it.example ? '<div class="hint en" style="margin-top:5px">' + esc(it.example) + '</div>' : '') +
          (q.itemType === 'pronunciation' ? '<div class="hint" style="margin-top:6px">跟读一遍，用"测试识别"验证 ASR 能听懂（可懂度代理，非音素评分）。</div>' : '');
      }
    });
  }

  function onReviewGraded(q, grade) {
    return ECA.getProfile().then(function (p) {
      if (grade === 'good') p.skills.vocabulary = Math.min(5, +(p.skills.vocabulary + 0.02).toFixed(2));
      ECA.saveProfile(p);
    }).then(function () {
      logEvent('review_graded', { itemType: q.itemType, grade: grade, label: q.label });
    });
  }

  /* 阅读块 */
  function runReadingBlock(b, idx) {
    ECContent.pickUnread().then(function (content) {
      if (!content) {
        blockRoot().innerHTML = '<div class="empty">没有可用内容。去「阅读」页导入并加工一篇，或先用内置种子内容。</div>' +
          '<button class="btn btn-cinnabar" id="btn-goto-read" style="margin-top:10px">去导入内容</button>';
        $('btn-goto-read').addEventListener('click', function () { go('reading'); });
        return;
      }
      openReader(content, idx, b.minutes);
    });
  }

  /* 阅读器（阅读块与阅读页共用） */
  var readerState = null;
  function openReader(content, blockIdx, minutes) {
    readerState = { content: content, blockIdx: blockIdx, level: 1, lookups: 0, t0: Date.now() };
    var m = content.material || {};
    var root = (blockIdx != null) ? blockRoot() : viewRoot;
    root.innerHTML =
      '<div class="rlvl-switch">' +
      [1, 2, 3].map(function (l) {
        return '<button class="rlvl' + (l === 1 ? ' cur' : '') + '" data-l="' + l + '">' + ['Level 1 简化版', 'Level 2 要点', 'Level 3 原文节选'][l - 1] + '</button>';
      }).join('') +
      (content.url ? '<a class="tag" style="margin-left:auto" href="' + esc(content.url) + '" target="_blank">打开原文 ↗</a>' : '') + '</div>' +
      '<div class="reader-text" id="reader-body"></div>' +
      '<div id="reader-extra"></div>' +
      '<div style="margin-top:14px;display:flex;gap:9px;flex-wrap:wrap">' +
      '<button class="btn btn-cinnabar" id="btn-read-done">读完这块（完成）</button>' +
      '<button class="btn btn-outline" id="btn-read-listen">听一遍（练听力）</button></div>';
    if (blockIdx == null) root.innerHTML = '<div class="view">' + root.innerHTML + '</div>';

    function renderLevel(l) {
      readerState.level = l;
      root.querySelectorAll('.rlvl').forEach(function (x) { x.classList.toggle('cur', +x.getAttribute('data-l') === l); });
      var body = $('reader-body');
      var text = l === 1 ? (m.level1 || '') : l === 2 ? (m.keyPoints || []).map(function (k) { return '· ' + k; }).join('\n') : (content.excerpt || '');
      /* Level 1/3 支持点词查询 */
      if (l === 1 || l === 3) {
        body.innerHTML = text.split(/(\s+)/).map(function (tok) {
          var w = tok.replace(/[^A-Za-z'-]/g, '');
          if (w.length >= 2) return '<span class="w" data-w="' + esc(w.toLowerCase()) + '">' + esc(tok) + '</span>';
          return esc(tok);
        }).join('');
        body.querySelectorAll('.w').forEach(function (sp) {
          sp.addEventListener('click', function (e) { wordPopup(sp.getAttribute('data-w'), sp, text); });
        });
      } else {
        body.textContent = text;
      }
      /* 词汇行 */
      var ext = $('reader-extra');
      var vocab = (m.vocab || []).slice(0, 10);
      ext.innerHTML = vocab.length ? '<div class="panel alt"><h3>本篇词汇（AI 分类标注）</h3>' +
        vocab.map(function (v) {
          var cls = v.cls === 'A' ? 'tag-a' : v.cls === 'B' ? 'tag-b' : 'tag-c';
          return '<div class="vitem"><span class="vw en">' + esc(v.word) + '</span>' +
            '<span class="vm">' + esc(v.meaning || '') + (v.example ? ' · <i class="en">' + esc(v.example) + '</i>' : '') + '</span>' +
            '<span class="vstat"><span class="tag ' + cls + '">' + esc(v.cls) + ' 类</span></span></div>';
        }).join('') + '<p class="hint" style="margin-top:8px">A 类=高频工作词（建议学习）· B 类=有帮助 · C 类=不打断阅读。点文中的生词可即查即学。</p></div>' +
        (m.questions && m.questions.length ? '<div class="panel alt"><h3>读完想一想（等会儿对话会聊）</h3>' +
          m.questions.map(function (qq) { return '<p class="kv en">' + esc(qq) + '</p>'; }).join('') + '</div>' : '')
        : '';
    }
    renderLevel(1);
    root.querySelectorAll('.rlvl').forEach(function (btn) {
      btn.addEventListener('click', function () { renderLevel(+btn.getAttribute('data-l')); });
    });
    $('btn-read-listen').addEventListener('click', function () {
      var t = readerState.level === 1 ? (m.level1 || content.excerpt) : (content.excerpt || '');
      ECTTS.say(String(t).slice(0, 1500), { rate: 0.85 });
      toast('正在朗读（系统语音，语速 0.85）');
    });
    $('btn-read-done').addEventListener('click', function () {
      var dur = Math.round((Date.now() - readerState.t0) / 60000);
      ECContent.logReading(content.id, readerState.level, readerState.lookups, Math.max(1, dur)).then(function () {
        logEvent('reading_done', { contentId: content.id, title: content.title, lookups: readerState.lookups, minutes: dur });
        if (blockIdx != null) {
          completeBlock(blockIdx, { contentId: content.id, lookups: readerState.lookups });
        } else {
          toast('已记录本次阅读（' + dur + ' 分钟，查词 ' + readerState.lookups + ' 次）');
          renderReading();
        }
      });
    });
  }

  /* 点词弹层：A/B/C 分类 + 一键入库 */
  function wordPopup(word, anchorEl, fullText) {
    var exist = document.querySelector('.word-pop');
    if (exist) exist.remove();
    var rect = anchorEl.getBoundingClientRect();
    var pop = document.createElement('div');
    pop.className = 'word-pop';
    pop.innerHTML = '<div class="wp-head"><span class="en">' + esc(word) + '</span></div><div class="wp-meta">查询中…</div>';
    document.body.appendChild(pop);
    pop.style.left = Math.max(8, Math.min(window.innerWidth - 320, rect.left)) + 'px';
    pop.style.top = Math.min(window.innerHeight - 200, rect.bottom + 8) + 'px';

    function fill(v, note) {
      var cls = v.cls === 'A' ? 'tag-a' : v.cls === 'B' ? 'tag-b' : 'tag-c';
      pop.innerHTML = '<div class="wp-head"><span class="en">' + esc(word) + '</span> <span class="tag ' + cls + '">' + esc(v.cls) + ' 类</span></div>' +
        '<div class="wp-meta">' + esc(v.pos || '') + ' ' + esc(v.pron || '') + '</div>' +
        '<div class="wp-mean"><b>' + esc(v.meaning || '—') + '</b></div>' +
        (v.example ? '<div class="hint en" style="margin-bottom:7px">' + esc(v.example) + '</div>' : '') +
        (v.related && v.related.length ? '<div class="hint">搭配：' + esc(v.related.join(' · ')) + '</div>' : '') +
        (note ? '<div class="hint" style="margin-top:5px;color:var(--cinnabar)">' + esc(note) + '</div>' : '') +
        '<div class="wp-act">' +
        (v.cls === 'A' ? '<button class="btn btn-cinnabar btn-sm" id="wp-add">加入语言资产库</button>' : '') +
        '<button class="btn btn-outline btn-sm" id="wp-close">关闭</button></div>';
      pop.querySelector('#wp-close').addEventListener('click', function () { pop.remove(); });
      var addBtn = pop.querySelector('#wp-add');
      if (addBtn) addBtn.addEventListener('click', function () {
        readerState.lookups++;
        var sentCtx = sentenceOf(fullText, word);
        ECContent.addVocab({
          word: word, meaning: v.meaning, pos: v.pos, pron: v.pron,
          example: v.example, related: v.related || []
        }, { contentId: readerState.content.id, url: readerState.content.url, context: sentCtx })
          .then(function () {
            logEvent('vocab_added', { word: word, cls: 'A' });
            pop.remove();
            toast('已入库并进入今日复习队列：' + word);
          }).catch(function (e) { toast('入库失败：' + e.message); });
      });
      if (readerState) readerState.lookups++;
    }
    if (!aiReady()) {
      fill({ cls: 'B', meaning: '（AI 未配置，无法释义——配置后可查词）', pos: '', pron: '', example: '', related: [] }, 'AI 未配置');
      return;
    }
    var sentCtx = sentenceOf(fullText, word);
    ECA.wordLookup(word, sentCtx).then(function (v) { fill(v); })
      .catch(function () { fill({ cls: 'B', meaning: '查询失败（网络或 AI 配置问题）', pos: '', pron: '', example: '', related: [] }, ''); });
  }
  function sentenceOf(text, word) {
    var sents = String(text || '').split(/(?<=[.!?])\s+|\n+/);
    for (var i = 0; i < sents.length; i++) {
      if (sents[i].toLowerCase().indexOf(String(word).toLowerCase()) >= 0) return sents[i].slice(0, 200);
    }
    return '';
  }

  /* 听力块：5 遍法（MVP：盲听→字幕→讲解→重听→复述） */
  function runListeningBlock(b, idx) {
    ECContent.pickUnread().then(function (content) {
      if (!content) { blockRoot().innerHTML = '<div class="empty">暂无内容可用于听力。先在「阅读」页导入。</div>'; return; }
      var script = (content.material && content.material.listeningScript) || content.material.level1 || content.excerpt;
      var stage = 0;
      var stageNames = ['第1遍：不看字幕盲听', '第2遍：看英文字幕', '第3遍：AI 讲解关键句', '第4遍：再听一遍', '第5遍：复述（说出来）'];
      blockRoot().innerHTML = '<div class="rev-card"><div class="rc-type">LISTENING · 5 遍法</div>' +
        '<div class="rc-main" id="ls-stage"></div><div class="rc-sub" id="ls-sub"></div>' +
        '<div id="ls-body" style="margin:8px 0"></div>' +
        '<div class="rev-actions">' +
        '<button class="btn btn-cinnabar" id="ls-play">播放</button>' +
        '<button class="btn btn-outline" id="ls-next">下一遍</button>' +
        '<button class="btn btn-ink" id="ls-done">完成听力块</button></div></div>';
      function drawStage() {
        $('ls-stage').textContent = stageNames[stage];
        $('ls-sub').textContent = '内容：' + content.title;
        var body = $('ls-body');
        if (stage === 1 || stage === 3) body.innerHTML = '<div class="reader-text" style="font-size:14.5px">' + esc(String(script).slice(0, 900)) + '</div>';
        else if (stage === 2) body.innerHTML = '<div class="hint">播放时留意连读与弱读：want to→wanna、going to→gonna、kind of→kinda。听不清的地方重放。</div>';
        else if (stage === 4) body.innerHTML = '<div class="quiz-voice"><button class="mic-btn" id="ls-mic"><span>复述</span></button><div class="mic-state" id="ls-micstate">用你自己的话说出大意</div></div>' +
          '<div id="ls-retell" class="hint" style="margin-top:8px"></div>';
        if (stage === 4) {
          $('ls-mic').addEventListener('click', function () {
            $('ls-micstate').textContent = '正在听你的复述…';
            ECSTT.listen({}).then(function (r) {
              $('ls-retell').innerHTML = '<b>你的复述（' + r.provider + ' 识别）：</b>' + esc(r.text);
              logEvent('listening_retell', { contentId: content.id, transcript: r.text.slice(0, 300) });
            }).catch(function (e) { $('ls-retell').textContent = '识别失败（可跳过）：' + e.message; });
          });
        }
      }
      drawStage();
      $('ls-play').addEventListener('click', function () {
        ECTTS.say(String(script).slice(0, 1500), { rate: stage === 0 ? 0.9 : 1.0 });
      });
      $('ls-next').addEventListener('click', function () {
        if (stage < 4) { stage++; drawStage(); }
      });
      $('ls-done').addEventListener('click', function () {
        logEvent('listening_done', { contentId: content.id, passes: stage + 1 });
        completeBlock(idx, { contentId: content.id, passes: stage + 1 });
      });
    });
  }

  /* 对话块：口语训练（真实情境 + 分层纠错） */
  var SCENARIOS = [
    'First time meeting an American AI practitioner（第一次认识一位美国 AI 从业者）',
    'Introduce your work to a foreign colleague（向外国同事介绍你的工作）',
    'Introduce an AI product（介绍一个 AI 产品）',
    'Discuss AI agents（讨论 Agent 技术）',
    'Explain a digital transformation project（解释一个数字化项目）',
    'Chat with an overseas customer（和海外客户闲聊）'
  ];

  function runConversationBlock(b, idx) {
    blockRoot().innerHTML = '<div class="panel"><h2>口语训练 · 选一个情境开麦即说</h2>' +
      SCENARIOS.map(function (s, i) {
        return '<button class="mblock" data-s="' + i + '"><div class="mico">说</div><div><div class="mname">' + esc(s.split('（')[0]) + '</div><div class="mwhy">' + esc(s.split('（')[1] || '').replace('）', '') + '</div></div></button>';
      }).join('') + '</div>';
    blockRoot().querySelectorAll('[data-s]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openConversation(SCENARIOS[+btn.getAttribute('data-s')], idx);
      });
    });
  }

  function openConversation(scenario, blockIdx) {
    var root = (blockIdx != null) ? blockRoot() : viewRoot;
    root.innerHTML = '<div class="panel"><h2>Conversation · ' + esc(scenario.split('（')[0]) + '</h2>' +
      '<div class="chat-log" id="chat-log"></div>' +
      '<div class="mic-zone"><button class="mic-btn" id="cv-mic"><span>按住</span><span>说话</span></button>' +
      '<div style="flex:1"><div class="mic-state" id="cv-micstate">点麦克风开说（说完停顿自动结束）；也可打字</div>' +
      '<textarea class="field" id="cv-text" rows="2" placeholder="或在这里打字（识别不可用时的回退）" style="margin-top:6px"></textarea>' +
      '<div style="margin-top:8px;display:flex;gap:8px"><button class="btn btn-outline btn-sm" id="cv-send">发送文字</button>' +
      '<button class="btn btn-ghost btn-sm" id="cv-end">结束并评估</button></div></div></div></div>';
    if (blockIdx == null) root.innerHTML = '<div class="view">' + root.innerHTML + '</div>';

    EApp.conv = { scenario: scenario, blockIdx: blockIdx, turns: [], correctionsShown: 0, t0: Date.now() };
    busy(true, '教练正在想开场…');
    ECA.buildDigest().then(function (d) {
      var recent = (d.text.split('【最近学习内容】')[1] || '').slice(0, 200);
      return ECA.convStart(scenario, d.text, recent);
    }).then(function (r) {
      busy(false);
      pushTurn('coach', r.reply, { corrections: r.corrections || [] });
      ECTTS.say(stripZh(r.reply), {});
    }).catch(function (e) { busy(false); toast('对话开启失败：' + e.message); });

    var speaking = false;
    $('cv-mic').addEventListener('click', function () {
      if (speaking) return;
      speaking = true;
      $('cv-mic').classList.add('listening');
      $('cv-micstate').textContent = '正在听…（说完停顿 1.5 秒自动结束）';
      ECSTT.listen({
        onState: function (st) { $('cv-micstate').textContent = st === 'listening' ? '正在听…' : '停顿检测中…'; }
      }).then(function (r) {
        speaking = false;
        $('cv-mic').classList.remove('listening');
        $('cv-micstate').textContent = '识别完成（' + r.provider + '）';
        userSaid(r.text, r.provider);
      }).catch(function (e) {
        speaking = false;
        $('cv-mic').classList.remove('listening');
        $('cv-micstate').textContent = '识别失败：' + e.message + '（可打字继续）';
        toast(e.message);
      });
    });
    $('cv-send').addEventListener('click', function () {
      var t = $('cv-text').value.trim();
      if (!t) return;
      $('cv-text').value = '';
      userSaid(t, 'typed');
    });
    $('cv-end').addEventListener('click', function () { endConversation(); });
  }

  function stripZh(s) { /* 播放时去掉中文注解部分（括号内） */ return String(s || '').replace(/（[^）]*）|\([^)]*\)/g, '').trim(); }

  function pushTurn(role, text, meta) {
    var c = EApp.conv;
    var turn = { id: EDB.uid(), conversationId: null, role: role, text: text, meta: meta || {}, at: EDB.nowIso() };
    c.turns.push(turn);
    var log = $('chat-log');
    if (!log) return;
    var div = document.createElement('div');
    div.className = 'bubble ' + (role === 'user' ? 'b-user' : role === 'sys' ? 'b-sys' : 'b-coach');
    div.innerHTML = '<p>' + esc(text) + '</p>' +
      (meta && meta.provider ? '<div class="asr-note">识别来源：' + esc(meta.provider) + '（可懂度参考，非发音评分）</div>' : '');
    if (meta && meta.corrections && meta.corrections.length) {
      meta.corrections.forEach(function (corr) {
        EApp.conv.correctionsShown++;
        var card = document.createElement('div');
        card.className = 'corr-card';
        card.innerHTML = '<span class="c-lv">L' + corr.level + ' · ' + esc(corr.type || '') + '</span><br>' +
          '你的表达：<span class="en">' + esc(corr.original || '') + '</span><br>' +
          (corr.level === 2
            ? '<span id="corr-hint-' + EApp.conv.correctionsShown + '">想一想：' + esc(corr.hintQ || '') + '</span><br>' +
              '<button class="btn btn-ghost btn-sm" style="margin-top:5px" data-corr="' + EApp.conv.correctionsShown + '">想不出来，看自然表达</button>'
            : '更自然：<span class="en">' + esc(corr.finalCorrected || '') + '</span>');
        div.appendChild(card);
        var btn = card.querySelector('[data-corr]');
        if (btn) {
          btn.addEventListener('click', function () {
            var n = btn.getAttribute('data-corr');
            $('corr-hint-' + n).innerHTML = '自然表达：<b class="en">' + esc(corr.finalCorrected || '') + '</b>（跟读一遍）';
            btn.remove();
            logMistake(corr);
            ECTTS.say(corr.finalCorrected || '', {});
          });
        } else if (corr.level === 1 && corr.finalCorrected) {
          logMistake(corr);
        }
      });
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function logMistake(corr) {
    /* 错误结构化入库 + 进复习队列 */
    var row = {
      id: EDB.uid(),
      mistake_type: corr.type || 'other',
      original: corr.original || '',
      corrected: corr.finalCorrected || '',
      severity: corr.level === 1 ? 'high' : 'medium',
      context: 'conversation',
      source: 'conversation',
      conversationId: EApp.conv && EApp.conv.turns[0] ? EApp.conv.turns[0].id : null,
      mastery: 1, attempts: [], review_count: 0, resolved: false,
      next_review: EDB.dayKey(), created_at: EDB.nowIso()
    };
    EDB.put('mistakes', row).then(function () {
      ECR.byItem(row.id).then(function (rev) {
        if (!rev) ECR.create(row.id, 'mistake', (corr.original || '').slice(0, 60));
      });
      logEvent('mistake_logged', { type: row.mistake_type, original: row.original.slice(0, 80) });
    });
  }

  function userSaid(text, provider) {
    var c = EApp.conv;
    pushTurn('user', text, { provider: provider });
    busy(true, '教练在听你说，组织回应…');
    var digestP = ECA.buildDigest().then(function (d) { return d.text; });
    digestP.then(function (dt) {
      return ECA.convTurn(text, c.turns.map(function (t) { return { role: t.role, text: t.text }; }), dt);
    }).then(function (r) {
      busy(false);
      pushTurn('coach', r.reply, { corrections: r.corrections || [] });
      ECTTS.say(stripZh(r.reply), {});
      if (r.flow === 'end') toast('教练觉得这段可以收了——点"结束并评估"看今天的进步。');
    }).catch(function (e) {
      busy(false);
      toast('回应失败：' + e.message);
    });
  }

  function endConversation() {
    var c = EApp.conv;
    if (!c || !c.turns.length) { if (c && c.blockIdx != null) completeBlock(c.blockIdx); return; }
    busy(true, '正在保存这段对话…');
    var userTurns = c.turns.filter(function (t) { return t.role === 'user'; });
    var convRow = {
      id: EDB.uid(), date: EDB.dayKey(), scenario: c.scenario,
      turnCount: c.turns.length, userTurnCount: userTurns.length,
      durationMin: Math.max(1, Math.round((Date.now() - c.t0) / 60000)),
      created_at: EDB.nowIso()
    };
    /* 先落库（对话与轮次），评估失败也不丢数据 */
    EDB.put('conversations', convRow).then(function () {
      return EDB.putAll('turns', c.turns.map(function (t) {
        t.conversationId = convRow.id; return t;
      }));
    }).then(function () {
      logEvent('conversation_done', { scenario: c.scenario, turns: c.turns.length });
      if (!aiReady()) {
        busy(false);
        toast('AI 未配置：对话已保存，评估在配置 AI 后可用（不伪造评估）');
        if (c.blockIdx != null) completeBlock(c.blockIdx, { conversationId: convRow.id });
        else showConvAssess(null, convRow);
        return;
      }
      busy(true, '教练正在评估这段对话…');
      return ECA.convAssess(c.turns).then(function (a) {
        convRow.assessment = a;
        return EDB.put('conversations', convRow);
      }).then(function () {
        busy(false);
        showConvAssess(a, convRow);
      });
    }).catch(function (e) {
      busy(false);
      toast('对话已保存，但评估失败：' + e.message);
      if (c.blockIdx != null) completeBlock(c.blockIdx, { conversationId: convRow.id });
      else showConvAssess(null, convRow);
    });
  }

  function showConvAssess(assess, convRow) {
    var a = assess || {};
    var c = EApp.conv;
    var html = '<div class="hero"><div class="daytag">CONVERSATION · DONE</div><h1>今天最值得改进的一件事</h1>' +
      '<p>一次只强调一两个重点——改掉一个，比知道十个有用。</p></div>' +
      '<div class="panel"><h2>Assessment（基于转写的诚实评估）</h2>' +
      '<div class="kv"><b>流利度：</b>' + esc(a.fluency || '—') + '</div>' +
      '<div class="kv"><b>词汇：</b>' + esc(a.vocabulary || '—') + '</div>' +
      '<div class="kv"><b>语法：</b>' + esc(a.grammar || '—') + '</div>' +
      '<div class="kv"><b>自然度：</b>' + esc(a.naturalness || '—') + '</div>' +
      '<div class="kv"><b>发音：</b>' + esc(a.pronunciationNote || '只有转写证据时不做发音诊断（可懂度代理，非音素评分）') + '</div>' +
      (assess ? '' : '<p class="hint" style="margin-top:8px;color:var(--cinnabar)">AI 未配置或评估失败：对话已真实保存，不伪造评估结论。配置 AI 后再对话即可获得评估。</p>') +
      '<div class="divider"></div>' +
      '<div class="kv"><b>Focus today：</b><span style="color:var(--cinnabar);font-weight:800">' + esc(a.focusToday || '—') + '</span></div>' +
      '<div class="kv"><b>Highlight：</b><span class="en">' + esc(a.highlight || 'Keep going.') + '</span></div></div>' +
      '<div style="text-align:center"><button class="btn btn-ink btn-lg" id="btn-conv-close">回到任务</button></div>';
    if (c && c.blockIdx != null) {
      blockRoot().innerHTML = html;
      $('btn-conv-close').addEventListener('click', function () {
        completeBlock(c.blockIdx, { conversationId: convRow.id });
      });
    } else {
      render(html);
      $('btn-conv-close').addEventListener('click', function () { go('today'); });
    }
    /* 口语 9 维微调（规则：评估完成即记录小额进步，封顶5） */
    ECA.getProfile().then(function (p) {
      p.skills.speaking = Math.min(5, +(p.skills.speaking + 0.08).toFixed(2));
      p.skills.fluency = Math.min(5, +(p.skills.fluency + 0.05).toFixed(2));
      p.skills.naturalness = Math.min(5, +(p.skills.naturalness + 0.04).toFixed(2));
      ECA.saveProfile(p);
    });
  }

  /* 写作块 */
  var WRITE_TASKS = [
    '写 2-3 句英文：介绍你最近在做的 AI 工作。',
    '写一封 3 句的英文邮件：请同事review你的方案。',
    '写 2 句 Slack 风格的英文消息：告诉团队 build 好了。'
  ];
  function runWritingBlock(b, idx) {
    var task = WRITE_TASKS[Math.floor(Math.random() * WRITE_TASKS.length)];
    blockRoot().innerHTML = '<div class="rev-card"><div class="rc-type">WRITING</div>' +
      '<div class="rc-main">' + esc(task) + '</div>' +
      '<textarea class="field" id="wt-input" rows="4" placeholder="用自己的话写，写错没关系——教练会保留你的水平，只指出差距"></textarea>' +
      '<div class="rev-actions" style="margin-top:12px">' +
      '<button class="btn btn-cinnabar" id="wt-submit">提交给教练</button>' +
      '<button class="btn btn-outline" id="wt-done">跳过并完成</button></div>' +
      '<div id="wt-result"></div></div>';
    $('wt-submit').addEventListener('click', function () {
      var t = $('wt-input').value.trim();
      if (!t) { toast('先写两句再提交'); return; }
      if (!aiReady()) { toast('AI 未配置，无法评估写作'); return; }
      busy(true, '教练正在读你的句子…');
      ECA.assessWriting(t, task).then(function (r) {
        busy(false);
        $('wt-result').innerHTML = '<div class="divider"></div>' +
          '<div class="kv"><b>意思：</b>' + esc(r.meaning || '') + '</div>' +
          '<div class="kv"><b>你的版本（轻度整理）：</b><span class="en">' + esc(r.myVersion || '') + '</span></div>' +
          '<div class="kv"><b>更自然的版本：</b><span class="en" style="color:var(--cinnabar)">' + esc(r.naturalVersion || '') + '</span></div>' +
          '<div class="kv"><b>最值得改的：</b>' + (r.notes || []).map(esc).join('；') + '</div>';
        logEvent('writing_done', { task: task, text: t.slice(0, 300) });
        ECA.getProfile().then(function (p) {
          p.skills.writing = Math.min(5, +(p.skills.writing + 0.06).toFixed(2));
          ECA.saveProfile(p);
        });
        $('wt-done').textContent = '完成写作块';
      }).catch(function (e) { busy(false); toast('评估失败：' + e.message); });
    });
    $('wt-done').addEventListener('click', function () { completeBlock(idx); });
  }

  /* ================================================================
   * 阅读页（内容库：导入 + 加工 + 列表）
   * ================================================================ */
  function renderReading() {
    render('<div class="panel"><h2>真实内容库</h2>' +
      '<p class="sub">两条通道：① 拖入 curator.py 输出的 content-pack JSON；② 直接粘贴文章。</p>' +
      '<div class="grid2"><div>' +
      '<input type="file" id="pack-file" accept=".json" style="display:none">' +
      '<button class="btn btn-ink" id="btn-import-pack">导入内容包 JSON</button></div>' +
      '<div><button class="btn btn-outline" id="btn-paste">手动粘贴一篇文章</button></div></div>' +
      '<p class="hint" style="margin-top:10px">采集脚本：docs/curator.py（本地运行，经代理抓 HN/GitHub/官方博客 → 输出 content-pack.json）。版权原则：只存标题/来源/URL/摘录，学习材料由 AI 生成。</p></div>' +
      '<div class="panel"><h2>内容列表</h2><div id="content-list">读取中…</div></div>');
    $('btn-import-pack').addEventListener('click', function () { $('pack-file').click(); });
    $('pack-file').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        ECContent.importPack(ev.target.result).then(function (r) {
          toast('已导入 ' + r.imported + ' 条内容，点"加工"生成学习材料。');
          renderReading();
        }).catch(function (err) { toast('导入失败：' + err.message); });
      };
      reader.readAsText(f);
      e.target.value = '';
    });
    $('btn-paste').addEventListener('click', function () {
      modal('<h3>粘贴一篇英文文章</h3>' +
        '<input class="field" id="pt-title" placeholder="标题（可留空）" style="margin-bottom:8px">' +
        '<input class="field" id="pt-url" placeholder="原文链接（可留空）" style="margin-bottom:8px">' +
        '<textarea class="field" id="pt-text" rows="8" placeholder="粘贴正文（英文）"></textarea>' +
        '<div style="margin-top:12px;text-align:right">' +
        '<button class="btn btn-outline btn-sm" onclick="document.getElementById(\'modal-root\').innerHTML=\'\'">取消</button> ' +
        '<button class="btn btn-cinnabar btn-sm" id="pt-save">导入</button></div>');
      $('pt-save').addEventListener('click', function () {
        ECContent.importPaste($('pt-title').value.trim(), $('pt-url').value.trim(), $('pt-text').value)
          .then(function (item) {
            closeModal();
            toast('已导入，正在加工学习材料…');
            processContentById(item.id);
          }).catch(function (e) { toast(e.message); });
      });
    });
    drawContentList();
  }

  function drawContentList() {
    ECContent.listContent().then(function (rows) {
      var el = $('content-list');
      if (!el) return;
      if (!rows.length) {
        el.innerHTML = '<div class="empty">还没有内容。导入内容包 JSON，或粘贴一篇文章，或等内置种子内容（首次自动加载）。</div>';
        return;
      }
      el.innerHTML = rows.map(function (c) {
        return '<div class="mblock" style="cursor:default"><div class="mico">' + (c.seed ? '种' : '文') + '</div>' +
          '<div><div class="mname en">' + esc(c.title) + '</div>' +
          '<div class="mwhy">' + esc(c.source) + ' · ' + esc((c.difficulty && c.difficulty.label) || '') +
          ' [' + (c.tags || []).join(', ') + ']</div></div>' +
          '<div class="mmin" style="display:flex;gap:6px">' +
          (c.status === 'processed'
            ? '<button class="btn btn-ghost btn-sm" data-read="' + c.id + '">阅读</button>'
            : '<button class="btn btn-cinnabar btn-sm" data-proc="' + c.id + '">AI 加工</button>') +
          '</div></div>';
      }).join('');
      el.querySelectorAll('[data-proc]').forEach(function (b) {
        b.addEventListener('click', function () { processContentById(b.getAttribute('data-proc')); });
      });
      el.querySelectorAll('[data-read]').forEach(function (b) {
        b.addEventListener('click', function () {
          EDB.get('content', b.getAttribute('data-read')).then(function (c) { openReader(c, null, 0); });
        });
      });
    });
  }

  function processContentById(id) {
    if (!requireAI()) return;
    busy(true, 'English Tutor 正在加工：简化版 / 词汇分类 / 讨论问题…（约 1-3 分钟）');
    ECA.buildDigest().then(function (d) {
      return ECContent.process(id, d.text);
    }).then(function (item) {
      busy(false);
      toast('加工完成：' + item.title);
      renderReading();
    }).catch(function (e) {
      busy(false);
      toast('加工失败：' + e.message + '（稍后重试）');
    });
  }

  /* ================================================================
   * 对话页（独立入口，不限于任务块）
   * ================================================================ */
  function renderSpeak() {
    render('<div class="hero"><div class="daytag">VOICE CONVERSATION</div>' +
      '<h1>开麦即说</h1><p>AI 教练围绕真实工作情境陪你练口语；分层纠错，不打断，让你先自己想。</p></div>' +
      '<div class="panel"><h2>选一个情境</h2>' +
      SCENARIOS.map(function (s, i) {
        return '<button class="mblock" data-s="' + i + '"><div class="mico">说</div>' +
          '<div><div class="mname">' + esc(s.split('（')[0]) + '</div><div class="mwhy">' + esc(String(s.split('（')[1] || '').replace('）', '')) + '</div></div></button>';
      }).join('') + '</div>' +
      '<div class="panel alt"><p class="hint">语音主通道：MiniMax ASR（上传音频文件模式）。首次使用请先到「设置」页点"测试识别"验证端点；浏览器原生识别（Web Speech）作为回退，可在设置切换。音频上传需在千手设置中心开启"允许云端语音判断"。</p></div>');
    viewRoot.querySelectorAll('[data-s]').forEach(function (b) {
      b.addEventListener('click', function () { openConversation(SCENARIOS[+b.getAttribute('data-s')], null); });
    });
  }

  /* ================================================================
   * 复习页
   * ================================================================ */
  function renderReview() {
    ECR.dueToday().then(function (items) {
      if (!items.length) {
        render('<div class="hero"><div class="daytag">REVIEW</div><h1>今日复习已清空</h1>' +
          '<p>间隔调度：0/1/2/3/7/14 天。新词、错误、表达、听力、发音难点都会在正确的时间回来找你。</p></div>' +
          '<div class="empty">没有到期复习项。去学新内容，给复习队列添点货。</div>');
        return;
      }
      EApp.revQueue = items;
      EApp.revIndex = 0;
      render('<div class="hero"><div class="daytag">REVIEW</div><h1>' + items.length + ' 项到期</h1>' +
        '<p>复习不是重背：词汇过证据阶梯，错误换新场景重测，发音用 ASR 可懂度验证。</p></div><div id="review-root"></div>');
      var tmp = $('review-root');
      tmp.innerHTML = '<div id="rev-holder"></div>';
      /* 渲染到 rev-holder */
      renderReviewCard(null, false);
    });
  }

  /* ================================================================
   * 资产库页
   * ================================================================ */
  function renderLibrary() {
    Promise.all([EDB.getAll('vocabulary'), EDB.getAll('expressions'), EDB.getAll('mistakes')]).then(function (r) {
      var vocab = r[0].sort(function (a, b) { return (a.mastery - b.mastery) || (a.word > b.word ? 1 : -1); });
      var mistakes = r[2].filter(function (m) { return !m.resolved; });
      var total = vocab.reduce(function (a, v) { return a + v.mastery; }, 0);
      var avg = vocab.length ? (total / vocab.length / 5 * 100).toFixed(0) : 0;
      render('<div class="hero"><div class="daytag">LANGUAGE ASSETS</div><h1>个人语言资产库</h1>' +
        '<p>认识 ≠ 掌握。0–5 证据阶梯：看过 → 看懂 → 听懂 → 会用 → 对话中自然使用。' + vocab.length + ' 个词条，平均掌握度 ' + avg + '%。</p></div>' +
        '<div class="panel"><h2>词汇与表达（按掌握度升序：弱的在前）</h2>' +
        (vocab.length ? vocab.map(function (v) {
          return '<div class="vitem"><span class="vw"><span class="en">' + esc(v.word) + '</span></span>' +
            '<span class="vm">' + esc(v.meaning || '') + (v.example ? ' · <i class="en">' + esc(v.example.slice(0, 90)) + '</i>' : '') + '</span>' +
            '<span class="vstat"><span class="mast">' + [1, 2, 3, 4, 5].map(function (i) {
              return '<i class="' + (v.mastery >= i ? 'on' : '') + '"></i>';
            }).join('') + '</span><br><span style="color:var(--ink3)">' + (v.mastery) + '/5</span></span></div>';
        }).join('') : '<div class="empty">还没入库。阅读时点 A 类词即可加入。</div>') + '</div>' +
        '<div class="panel"><h2>我的错误库（未解决 ' + mistakes.length + ' 条）</h2>' +
        (mistakes.length ? mistakes.map(function (m) {
          return '<div class="vitem"><span class="vw"><span class="tag tag-a">' + esc(m.mistake_type) + '</span></span>' +
            '<span class="vm"><span class="en" style="color:var(--ink3)text-decoration:line-through">' + esc(m.original.slice(0, 70)) + '</span><br>' +
            '<span class="en" style="color:var(--green)">' + esc(m.corrected.slice(0, 70)) + '</span></span>' +
            '<span class="vstat">' + esc(m.next_review || '') + '</span></div>';
        }).join('') : '<div class="empty">暂无未解决错误。对话中教练会自动记录。</div>') + '</div>');
    });
  }

  /* ================================================================
   * 报告页
   * ================================================================ */
  function renderReport() {
    var week = EDB.weekStart();
    EDB.byIndex('weeklyReports', 'byWeek', week).then(function (rows) {
      var existing = rows[0];
      Promise.all([EDB.getAll('activities'), EDB.getAll('events'), EDB.getAll('mistakes'), ECA.getProfile()]).then(function (rr) {
        /* 本周数据（简化：按日期 >= 本周一过滤） */
        var acts = (rr[0] || []).filter(function (a) { return a.date >= week; });
        var evts = (rr[1] || []).filter(function (e) { return e.date >= week; });
        var mistakes = rr[2] || [];
        var p = rr[3] || {};
        var html = '<div class="hero"><div class="daytag">THIS WEEK</div><h1>My English This Week</h1>' +
          '<p>与上周相比到底进步了什么 + Why——不是"恭喜完成"。</p></div>';
        if (existing) {
          html += renderWeeklyReport(existing);
        } else {
          var canGen = aiReady() && acts.length;
          html += '<div class="panel"><h2>本周数据</h2>' +
            '<div class="kv"><b>学习活动：</b>' + acts.length + ' 次 · <b>总时长：</b>' + acts.reduce(function (a, x) { return a + (x.minutes || 0); }, 0) + ' 分钟</div>' +
            '<div class="kv"><b>新入库：</b>' + evts.filter(function (e) { return e.type === 'vocab_added'; }).length + ' 词 · <b>对话：</b>' + evts.filter(function (e) { return e.type === 'conversation_done'; }).length + ' 次</div></div>' +
            '<div class="panel"><button class="btn btn-cinnabar btn-lg" id="btn-gen-week" ' + (canGen ? '' : 'disabled') + '>生成周报</button>' +
            (canGen ? '' : '<p class="hint" style="margin-top:8px">需要：AI 已配置 + 本周至少 1 次学习活动。</p>') + '</div>';
        }
        render(html);
        if ($('btn-gen-week')) {
          $('btn-gen-week').addEventListener('click', function () {
            busy(true, 'Progress Analyst 正在对比本周与上周…');
            var weekStats = {
              weekStart: week,
              activities: acts.map(function (a) { return { type: a.type, minutes: a.minutes, date: a.date }; }),
              newWords: evts.filter(function (e) { return e.type === 'vocab_added'; }).length,
              conversations: evts.filter(function (e) { return e.type === 'conversation_done'; }).length,
              mistakesThisWeek: mistakes.filter(function (m) { return (m.created_at || '') >= week; }).map(function (m) { return m.mistake_type; }),
              skillsNow: p.skills,
              dailyDigests: evts.filter(function (e) { return e.type === 'daily_digest'; }).map(function (e) { return e.data; })
            };
            ECA.weeklyReport(weekStats).then(function (rep) {
              rep.weekStart = week;
              rep.created_at = EDB.nowIso();
              return EDB.put('weeklyReports', { id: EDB.uid(), weekStart: week, report: rep, created_at: EDB.nowIso() }).then(function () {
                busy(false);
                /* 趋势更新：周报后 skillTrends = 本周微调累计（简化：由 skills 与 baseline 差值） */
                renderReport();
                toast('周报已生成。');
              });
            }).catch(function (e) { busy(false); toast('周报生成失败：' + e.message); });
          });
        }
      });
    });
  }
  function renderWeeklyReport(row) {
    var rep = row.report || {};
    return '<div class="panel"><h2>' + (rep.summary || '本周总结') + '</h2>' +
      ((rep.deltas || []).map(function (d) {
        return '<div class="kv"><b>' + esc(d.skill) + '：</b>' + d.from + ' → ' + d.to +
          ' <span style="color:var(--green)">↑</span> — ' + esc(d.why || '') + '</div>';
      }).join('') || '<p class="kv">（无维度变化数据）</p>') +
      (rep.trulyMastered && rep.trulyMastered.length ? '<div class="divider"></div><div class="kv"><b>真正掌握：</b>' + rep.trulyMastered.map(esc).join('、') + '</div>' : '') +
      (rep.mistakesTop && rep.mistakesTop.length ? '<div class="kv"><b>高频错误：</b>' + rep.mistakesTop.map(esc).join('、') + '</div>' : '') +
      '<div class="divider"></div><div class="kv"><b>下周自动调整：</b>' + esc(rep.nextWeekAdjust || '—') + '</div></div>';
  }

  /* ================================================================
   * 设置页（统一设置的补充，不另起炉灶）
   * ================================================================ */
  function renderSettings() {
    var c = ECSTT.cfg();
    var det = ECSTT.detect();
    var aiCfg = window.AgentShared ? AgentShared.AI.config() : {};
    var ttsOk = ECTTS.ttsReady();
    render('<div class="panel"><h2>统一设置（千手首页 · 设置中心）</h2>' +
      '<p class="kv">AI 服务：<b>' + (aiReady() ? '已配置 · ' + esc(aiCfg.model || '') : '未配置') + '</b> · ' +
      'TTS 真人感：<b>' + (ttsOk ? '已配置' : '未配置') + '</b> · ' +
      '云端语音判断：<b>' + (window.AgentShared && AgentShared.isAudioUploadAllowed() ? '已开启' : '未开启（ASR 上传需要）') + '</b></p>' +
      '<p class="hint">本栏目与数智学习共用千手设置中心的 AI / 语音 / TTS / 云同步配置（统一登录统一设置）。修改请回千手首页右上角"设置中心"。</p></div>' +

      '<div class="panel"><h2>多端同步（GitHub 私有仓库）</h2>' +
      '<p class="sub">与英语栏目同机制：学习数据变化后约 25 秒自动上传，打开应用自动拉取；覆盖前自动留档，不静默丢数据。</p>' +
      '<div class="set-row"><span class="status off" id="coach-sync-status">检测中…</span></div>' +
      '<div class="set-row"><button class="btn btn-ink btn-sm" id="btn-sync-now">立即同步（先推后拉）</button>' +
      '<button class="btn btn-outline btn-sm" id="btn-sync-pull">仅从云端拉取</button></div>' +
      '<p class="hint">数据文件 coach-data.json（本栏目独占，与英语栏目互不干扰）。仓库/令牌在千手首页「设置中心 → 云同步」配置，配好即自动生效。"实时"的诚实含义：静态仓库无服务端推送，能做到的是变更后≈25秒自动上传+打开应用自动拉取。</p></div>' +

      '<div class="panel"><h2>语音识别（STT）· 本栏目微调</h2>' +
      '<p class="sub">主通道 MiniMax ASR（用户确认选型）。官方端点公开文档未能确认，默认按 OpenAI 兼容惯例实现，可用下方"测试识别"真实验证；路径不同就改"端点路径"。</p>' +
      '<div class="set-row"><label>识别 Provider</label><select id="stt-provider">' +
      '<option value="minimax"' + (c.provider === 'minimax' ? ' selected' : '') + '>MiniMax ASR（主通道）</option>' +
      '<option value="webspeech"' + (c.provider === 'webspeech' ? ' selected' : '') + '>Web Speech 浏览器原生（回退）</option></select></div>' +
      '<div class="set-row"><label>端点路径</label><input type="text" id="stt-path" value="' + esc(c.path) + '"></div>' +
      '<div class="set-row"><label>模型（可空）</label><input type="text" id="stt-model" value="' + esc(c.model) + '" placeholder="留空用服务默认"></div>' +
      '<div class="set-row"><label>独立地址（可空）</label><input type="text" id="stt-base" value="' + esc(c.baseUrl) + '" placeholder="留空沿用统一设置中心 AI 地址"></div>' +
      '<div class="set-row"><label>独立密钥（可空）</label><input type="password" id="stt-key" value="' + esc(c.apiKey) + '" placeholder="留空沿用统一设置中心密钥"></div>' +
      '<div class="set-row"><button class="btn btn-ink btn-sm" id="btn-stt-save">保存 STT 设置</button>' +
      '<button class="btn btn-cinnabar btn-sm" id="btn-stt-test">测试识别（说 3 秒话，真实验证）</button></div>' +
      '<div class="set-row"><span class="status off" id="stt-status">浏览器能力：' +
      (det.speechRecognition ? '语音识别可用' : '无原生识别') + ' · ' + (det.getUserMedia ? '麦克风可用' : '无麦克风') + '</span></div>' +
      '<p class="hint">隐私：MiniMax ASR 会把录音发给 MiniMax（需先在千手设置中心开启"允许云端语音判断"）；Web Speech 走浏览器厂商云服务（Edge 为 Azure）。两条路都是云端识别，本应用不做本地识别。</p></div>' +

      '<div class="panel"><h2>数据（本栏目独立命名空间 coach_）</h2>' +
      '<div class="set-row"><button class="btn btn-outline btn-sm" id="btn-export">导出本栏目全部数据（JSON）</button>' +
      '<input type="file" id="import-file" accept=".json" style="display:none">' +
      '<button class="btn btn-outline btn-sm" id="btn-import">导入恢复</button></div>' +
      '<div class="set-row"><button class="btn btn-danger btn-sm" id="btn-wipe">删除本栏目全部数据</button></div>' +
      '<p class="hint">导出的 JSON 可通过 GitHub 私有仓库在多台设备间迁移（与千手其他栏目同策略）。删除操作不可恢复，会先二次确认。</p></div>');

    $('btn-stt-save').addEventListener('click', function () {
      ECSTT.saveCfg({
        provider: $('stt-provider').value,
        path: $('stt-path').value.trim() || '/v1/audio/transcriptions',
        model: $('stt-model').value.trim(),
        baseUrl: $('stt-base').value.trim(),
        apiKey: $('stt-key').value.trim(),
        language: 'en-US'
      });
      toast('STT 设置已保存');
    });
    /* 同步区 */
    ECSync.updateStatusUI();
    $('btn-sync-now').addEventListener('click', function () {
      if (!ECSync.isReady()) { toast('请先在千手首页「设置中心 → 云同步」配置仓库与令牌'); return; }
      ECSync.pushNow('manual').then(function () {
        return ECSync.pullNow('manual');
      }).then(function () {
        toast('同步完成'); ECSync.updateStatusUI();
      }).catch(function (e) {
        toast('同步失败：' + e.message); ECSync.updateStatusUI();
      });
    });
    $('btn-sync-pull').addEventListener('click', function () {
      if (!ECSync.isReady()) { toast('请先在千手首页「设置中心 → 云同步」配置仓库与令牌'); return; }
      ECSync.pullNow('manual').then(function (r) {
        toast(r === 'imported' ? '已从云端拉取并导入（页面即将刷新）' : '云端无新增数据');
        if (r === 'imported') setTimeout(function () { location.reload(); }, 1200);
      }).catch(function (e) {
        toast('拉取失败：' + e.message);
      });
    });
    $('btn-stt-test').addEventListener('click', function () {
      var el = $('stt-status');
      el.textContent = '请说一句英文（3.5 秒后自动停止）…';
      ECSTT.testASR(function (st) { el.textContent = '正在听…'; }).then(function (r) {
        el.className = 'status ok';
        el.textContent = '识别成功："' + r.text.slice(0, 50) + '"（' + r.provider + '）';
      }).catch(function (e) {
        el.className = 'status fail';
        el.textContent = '失败：' + e.message;
      });
    });
    $('btn-export').addEventListener('click', function () {
      busy(true, '正在导出…');
      EDB.exportAll().then(function (data) {
        busy(false);
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'AI英语教练_备份_' + EDB.dayKey() + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
    });
    $('btn-import').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          EDB.importAll(JSON.parse(ev.target.result)).then(function (r) {
            toast('已恢复 ' + r.applied + ' 条记录，刷新页面生效。');
          }).catch(function (err) { toast('导入失败：' + err.message); });
        } catch (err) { toast('文件不是合法 JSON'); }
      };
      reader.readAsText(f);
      e.target.value = '';
    });
    $('btn-wipe').addEventListener('click', function () {
      modal('<h3>删除本栏目全部数据？</h3><p class="kv">将清空 IndexedDB（coach_agent_db）全部 19 张表：画像、计划、内容、词汇、错误、对话记录。此操作不可恢复。</p>' +
        '<div style="margin-top:14px;text-align:right">' +
        '<button class="btn btn-outline btn-sm" onclick="document.getElementById(\'modal-root\').innerHTML=\'\'">取消</button> ' +
        '<button class="btn btn-danger btn-sm" id="btn-wipe-yes">确认删除</button></div>');
      $('btn-wipe-yes').addEventListener('click', function () {
        Promise.all(EDB.STORES.map(function (s) { return EDB.clear(s); })).then(function () {
          closeModal();
          toast('已清空。页面即将重新初始化。');
          setTimeout(function () { location.reload(); }, 900);
        });
      });
    });
  }

  /* ================================================================
   * 启动
   * ================================================================ */
  function init() {
    viewRoot = $('view-root');
    tabRoot = $('app-tabs');
    EDB.open().then(function () {
      return ECContent.seedIfNeeded();
    }).then(function () {
      return ECA.getProfile();
    }).then(function (p) {
      renderTabs();
      if (!p || !p.baseline) {
        renderOnboarding();
      } else {
        go('today');
      }
      /* 多端同步：启动自动拉取 + 写库防抖上传（未配置则静默跳过） */
      if (window.ECSync) ECSync.start();
    }).catch(function (e) {
      viewRoot.innerHTML = '<div class="empty">初始化失败：' + esc(e.message) + '<br>请用 Edge/Chrome 打开本页面。</div>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
