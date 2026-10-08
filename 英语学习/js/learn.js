/**
 * 千手-淘淘英语学习 · 学习能力补全模块
 * 依据实施指南补齐：
 *   1. 题型扩展：听辨、朗读跟读、语境理解
 *   2. 技能独立记账：listening 听辨 / speaking 朗读 / context 语境
 *   3. 视图栈 + 返回：任何页面跳转都能可靠返回原页面
 *   4. 词条详情页（返回时保留筛选/搜索/滚动）
 *   5. AI 解释（配置AI可用则在线，否则离线规则兜底）
 *   6. 基线测评
 *   7. 双周计划、离线巩固回填
 *   8. 家长报告周期筛选与趋势
 * 加载顺序：data.js → examples.js → app.js → shared.js → voice.js → learn.js
 */
(function () {
  'use strict';
  if (!window.App || !window.Quiz || !window.Skills || !window.Session) return;

  /* ================================================================
   * 1. 技能扩展
   * ================================================================ */
  ['listening', 'speaking', 'context'].forEach(function (sk) {
    if (Skills.list.indexOf(sk) < 0) Skills.list.push(sk);
  });
  Skills.labels.listening = '听辨';
  Skills.labels.speaking = '朗读';
  Skills.labels.context = '语境';

  /* 例句库安全读取（兼容不同加载方式） */
  function exBank() {
    return (typeof EXAMPLE_BANK !== 'undefined' ? EXAMPLE_BANK : (window.EXAMPLE_BANK || {})) || {};
  }

  /* 多词库合并词池（scope: 'all' | id | id[]；按词条 id 去重保留来源） */
  App.resolvePool = function (scope) {
    if (!Array.isArray(scope) || !scope.length) {
      return (scope === 'all' || !scope) ? Words.all() : Words.bySet(scope);
    }
    var pool = [];
    var seen = {};
    scope.forEach(function (id) {
      (id === 'all' ? Words.all() : Words.bySet(id)).forEach(function (w) {
        if (!seen[w.id]) { seen[w.id] = true; pool.push(w); }
      });
    });
    return pool;
  };

  /* ================================================================
   * 2. 题型生成扩展
   * ================================================================ */
  var origGenerate = Quiz.generate;
  Quiz.generate = function (word, skill, pool) {
    if (skill === 'listening') {
      var q = { wordId: word.id, skill: skill, word: word };
      if (Math.random() < 0.55) {
        /* 听音选词：干扰项取发音相近/同长度的词 */
        q.type = 'listening_select';
        q.prompt = '听发音，选择对应的单词';
        q.display = '🔊 点击下方按钮听发音';
        q.answer = word.lemma;
        var opts = makeListeningOptions(word, pool);
        q.options = opts;
      } else {
        /* 听音拼写 */
        q.type = 'listening_spell';
        q.prompt = '听发音，拼写出这个单词';
        q.display = word.lemma;
        q.answer = word.lemma;
      }
      return q;
    }
    if (skill === 'speaking') {
      return {
        wordId: word.id, skill: skill, word: word,
        type: 'speak',
        prompt: '听标准音，朗读这个词（或句子）',
        display: word.lemma,
        answer: word.lemma
      };
    }
    if (skill === 'context') {
      var ex = exBank()[String(word.lemma).toLowerCase()];
      if (ex) {
        return {
          wordId: word.id, skill: skill, word: word,
          type: 'context_select',
          prompt: '读句子，选择句中划线词的中文意思',
          sentence: ex.sentence,
          sentenceTrans: ex.translation,
          options: this.makeOptions(word, pool, 4).map(function (w) { return w.meanings.split('；')[0]; }),
          answer: word.meanings.split('；')[0]
        };
      }
      /* 无例句则退回识义 */
      return origGenerate.call(this, word, 'recognition', pool);
    }
    return origGenerate.call(this, word, skill, pool);
  };

  /* 近似音/同长度干扰项（听辨题合理干扰项） */
  function makeListeningOptions(word, pool) {
    var sameLen = pool.filter(function (w) {
      return w.id !== word.id && w.lemma.length === word.lemma.length;
    });
    var close = pool.filter(function (w) {
      return w.id !== word.id && Math.abs(w.lemma.length - word.lemma.length) <= 1 && w.lemma.length >= 3;
    });
    var picks = close.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 3);
    if (picks.length < 3) {
      picks = picks.concat(sameLen.slice(0, 3 - picks.length));
    }
    var seen = { '': true };
    seen[word.lemma.toLowerCase()] = true;
    var out = [word.lemma];
    picks.forEach(function (w) {
      var k = w.lemma.toLowerCase();
      if (!seen[k]) { seen[k] = true; out.push(w.lemma); }
    });
    while (out.length < 4 && pool.length > out.length) {
      var r = pool[Math.floor(Math.random() * pool.length)];
      var k2 = r.lemma.toLowerCase();
      if (!seen[k2]) { seen[k2] = true; out.push(r.lemma); }
    }
    /* 打乱 */
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /* ================================================================
   * 3. 判分扩展
   * ================================================================ */
  var origJudge = Quiz.judge;
  Quiz.judge = function (q, response) {
    if (q.type === 'listening_select') {
      var ok = String(response).trim().toLowerCase() === q.answer.toLowerCase();
      return { correct: ok, errorCode: ok ? null : 'listening_confusion' };
    }
    if (q.type === 'listening_spell') {
      var r = String(response).trim().toLowerCase();
      var a = q.answer.toLowerCase();
      if (r === a) return { correct: true, errorCode: null };
      return { correct: false, errorCode: r.length !== a.length ? 'spelling_omission' : 'spelling_order' };
    }
    if (q.type === 'context_select') {
      var ok2 = String(response).trim() === q.answer;
      return { correct: ok2, errorCode: ok2 ? null : 'context_error' };
    }
    if (q.type === 'speak') {
      /* 由语音判断结果传入 response 为 {ok:boolean, basis} */
      if (response && typeof response === 'object') {
        return { correct: !!response.ok, errorCode: response.ok ? null : 'pronunciation_issue', basis: response.basis || '' };
      }
      return { correct: false, errorCode: 'pronunciation_issue' };
    }
    return origJudge.call(this, q, response);
  };

  /* ================================================================
   * 4. 渲染扩展（听辨/朗读/语境题）
   * ================================================================ */
  var origRenderQ = App.renderQuestion;
  App.renderQuestion = function () {
    var q = Session.currentQ();
    if (!q) { this.showSummary(); return; }
    if (q.type === 'listening_select' || q.type === 'listening_spell' ||
        q.type === 'speak' || q.type === 'context_select') {
      this.renderExtendedQuestion(q);
      return;
    }
    origRenderQ.call(this);
  };

  App.renderExtendedQuestion = function (q) {
    var area = document.getElementById('question-area');
    var html = '';
    var skillLabel = Skills.labels[q.skill] || q.skill;

    if (q.type === 'listening_select') {
      html += '<div class="q-type-label">' + skillLabel + ' · 听辨 · 选词</div>';
      html += '<div class="q-prompt">' + App.esc(q.prompt) + '</div>';
      html += '<button class="q-audio-btn listen-play-big" data-listen-word="' + App.esc(q.answer) + '">🔊 播放发音（可重播）</button>';
      html += '<div class="q-options">';
      q.options.forEach(function (opt, i) {
        html += '<button class="q-option" onclick="App.answerSelect(' + i + ', this)">' + App.esc(opt) + '</button>';
      });
      html += '</div>';
    } else if (q.type === 'listening_spell') {
      html += '<div class="q-type-label">' + skillLabel + ' · 听辨 · 听写</div>';
      html += '<div class="q-prompt">' + App.esc(q.prompt) + '</div>';
      html += '<button class="q-audio-btn big-play" data-listen-word="' + App.esc(q.answer) + '">🔊 播放发音（可重播）</button>';
      html += '<div class="q-input-area">' +
        '<input type="text" class="q-input" id="q-input" placeholder="拼写英文单词…" autocomplete="off" autocapitalize="off" ' +
        'onkeydown="if(event.key===\'Enter\')App.answerInput()">' +
        '<button class="btn btn-primary q-submit" onclick="App.answerInput()">提交</button></div>';
    } else if (q.type === 'context_select') {
      html += '<div class="q-type-label">' + skillLabel + ' · 语境理解</div>';
      html += '<div class="q-prompt">' + App.esc(q.prompt) + '</div>';
      html += '<div class="context-sentence">' + App.esc(q.sentence).replace(new RegExp('(' + q.word.lemma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<u>$1</u>') + '</div>';
      html += '<div class="context-trans">' + App.esc(q.sentenceTrans) + '</div>';
      html += '<div class="q-options">';
      q.options.forEach(function (opt, i) {
        html += '<button class="q-option" onclick="App.answerSelect(' + i + ', this)">' + App.esc(opt) + '</button>';
      });
      html += '</div>';
    } else if (q.type === 'speak') {
      html += '<div class="q-type-label">' + skillLabel + ' · 跟读朗读</div>';
      html += '<div class="q-prompt">' + App.esc(q.prompt) + '</div>';
      html += '<div class="q-word">' + App.esc(q.word.lemma) + '</div>';
      if (q.word.pron) html += '<div class="q-pron">' + App.esc(q.word.pron) + '</div>';
      if (q.word.meanings) html += '<div class="q-pos">' + App.esc(q.word.meanings) + '</div>';
      html += '<div class="speak-controls" id="speak-controls">' +
        '<button class="btn btn-outline" id="speak-play" type="button">🔊 标准音</button>' +
        '<button class="btn btn-outline" id="speak-play-slow" type="button">🐢 慢速</button>' +
        '<button class="btn btn-outline" id="speak-record" type="button">🎙 开始录音</button>' +
        '<button class="btn btn-outline hidden" id="speak-play-mine" type="button">▶ 听我的录音</button>' +
        '<button class="btn btn-outline hidden" id="speak-rerecord" type="button">↻ 重录</button>' +
        '</div>' +
        '<div class="speak-status" id="speak-status"></div>' +
        '<div class="q-input-area hidden" id="speak-text-fallback">' +
        '<p class="sync-help">无法使用麦克风或语音识别时，可输入你读的内容（或直接填单词）后提交：</p>' +
        '<input type="text" class="q-input" id="q-input" placeholder="输入你朗读的内容…" autocomplete="off" autocapitalize="off">' +
        '</div>' +
        '<div class="footer-actions" style="margin-top:14px">' +
        '<button class="btn btn-primary hidden" id="speak-submit" type="button">提交并判断</button>' +
        '<button class="btn btn-ghost" id="speak-skip" type="button">不会读，看答案</button>' +
        '</div>';
    }

    area.innerHTML = html;
    if (q.type === 'speak') { App.initSpeak(q); }
    area.querySelectorAll('[data-listen-word]').forEach(function (el) {
      el.addEventListener('click', function () {
        var t = el.getAttribute('data-listen-word');
        App.speakWordWithOpt(t, { rate: 0.85 });
      });
    });

    document.getElementById('session-footer').classList.remove('hidden');
    document.getElementById('btn-next').classList.add('hidden');
    document.getElementById('feedback-area').innerHTML = '';
    App.hintLevel = 0;
    App.answered = false;
    App.questionStartAt = Date.now();
    var inp = document.getElementById('q-input');
    if (inp) inp.focus();
  };

  App.speakWord = function (text, opts) {
    if (window.AgentShared && window.AgentShared.Voice) {
      window.AgentShared.Voice.speak(text, opts || {});
      return;
    }
    TTS.speak(text);
  };

  App.speakWordWithOpt = function (text, opts) {
    App.speakWord(text, opts || {});
  };


  /* ---------- 朗读录音流程 ---------- */
  App._rec = null;
  App._recBlob = null;
  App._spokenText = '';

  App.initSpeak = function (q) {
    var self = this;
    var cap = window.AgentVoice ? window.AgentVoice.detect() : {};
    var st = document.getElementById('speak-status');
    var controls = document.getElementById('speak-controls');

    if (!cap.mediaRecorder || !cap.getUserMedia) {
      st.innerHTML = '<span class="speak-note">当前设备不支持录音，请使用文字输入完成本环节。</span>';
      document.getElementById('speak-text-fallback').classList.remove('hidden');
      document.getElementById('speak-submit').classList.remove('hidden');
      return;
    }
    if (st) st.innerHTML = '<span class="speak-note">步骤：听标准音 → 录音 → 试听/重录 → 提交判断。录音仅在本机处理。</span>';

    var play = document.getElementById('speak-play');
    play.onclick = function () { self.speakWordWithOpt(q.answer, { rate: 1.0 }); };
    var slow = document.getElementById('speak-play-slow');
    slow.onclick = function () { self.speakWordWithOpt(q.answer, { rate: 0.7 }); };

    var recBtn = document.getElementById('speak-record');
    var playMine = document.getElementById('speak-play-mine');
    var reBtn = document.getElementById('speak-rerecord');
    var submitBtn = document.getElementById('speak-submit');

    recBtn.onclick = function () {
      if (!window.AgentVoice) { st.innerHTML = '<span class="speak-hint">语音模块未加载，请使用文字输入。</span>'; return; }
      st.innerHTML = '<span class="speak-note">录音中…请朗读这个词，说完后点击「停止并识别」。</span>';
      recBtn.disabled = true;
      window.AgentVoice.startRecording().then(function (rec) {
        self._rec = rec;
        recBtn.textContent = '⏹ 停止并识别';
        recBtn.disabled = false;
        recBtn.onclick = function () {
          window.AgentVoice.stopRecording(self._rec);
          self._rec = null;
          self._recBlob = window.AgentVoice.blobFromRec(rec) || null;
          recBtn.classList.add('hidden');
          if (self._recBlob) {
            playMine.classList.remove('hidden');
            playMine.onclick = function () { window.AgentVoice.playBlob(self._recBlob); };
            reBtn.classList.remove('hidden');
            reBtn.onclick = function () { self.resetSpeakPanel(); };
            if (cap.recognition) {
              st.innerHTML = '<span class="speak-note">已录音。正在识别你的朗读…</span>';
              window.AgentVoice.transcribe().then(function (res) {
                self._spokenText = res.transcript || '';
                st.innerHTML = '<span class="speak-ok">已识别到：' + App.esc(self._spokenText) +
                  '（置信度 ' + Math.round((res.confidence || 0) * 100) + '%）</span>';
                submitBtn.classList.remove('hidden');
                submitBtn.textContent = '提交并判断';
              }).catch(function (err) {
                st.innerHTML = '<span class="speak-hint">' + App.esc(err.message) +
                  '。可试听录音后手动填写下方输入框提交。</span>';
                document.getElementById('speak-text-fallback').classList.remove('hidden');
                submitBtn.classList.remove('hidden');
                submitBtn.textContent = '提交文字内容';
              });
            } else {
              st.innerHTML = '<span class="speak-hint">当前浏览器不支持语音识别，可试听录音后，输入你读的内容提交。</span>';
              document.getElementById('speak-text-fallback').classList.remove('hidden');
              submitBtn.classList.remove('hidden');
              submitBtn.textContent = '提交文字内容';
            }
          } else {
            st.innerHTML = '<span class="speak-hint">未录到有效音频，请重录。</span>';
            self._resetSpeakPanel();
          }
        };
      }).catch(function (err) {
        st.innerHTML = '<span class="speak-hint">' + App.esc(err.message) +
          '。可改用文字输入继续练习。</span>';
        document.getElementById('speak-text-fallback').classList.remove('hidden');
        document.getElementById('speak-submit').classList.remove('hidden');
        recBtn.disabled = false;
        recBtn.textContent = '🎙 开始录音';
        recBtn.onclick = arguments.callee;
      });
    };

    submitBtn.onclick = function () {
      self.finishSpeak(q);
    };

    var skip = document.getElementById('speak-skip');
    if (skip) skip.onclick = function () {
      if (self.answered) return;
      self.answered = true;
      var latency = Date.now() - self.questionStartAt;
      Session.record('hint', latency);
      var fb = document.getElementById('feedback-area');
      fb.innerHTML = '<div class="feedback-card info"><span class="fb-word">已查看答案</span>' +
        '<span class="fb-meaning">' + App.esc(q.word.lemma) + (q.word.pron ? ' ' + App.esc(q.word.pron) : '') +
        ' — ' + App.esc(q.word.meanings) + '</span></div>';
      document.getElementById('btn-next').classList.remove('hidden');
      self.updateSessionProgress();
    };
  };

  App._resetSpeakPanel = function () {
    var rBtn = document.getElementById('speak-record');
    var pM = document.getElementById('speak-play-mine');
    var reBtn = document.getElementById('speak-rerecord');
    var sub = document.getElementById('speak-submit');
    var st = document.getElementById('speak-status');
    if (rBtn) { rBtn.disabled = false; rBtn.textContent = '🎙 开始录音'; rBtn.classList.remove('on'); }
    if (pM) pM.classList.add('hidden');
    if (reBtn) reBtn.classList.add('hidden');
    if (sub) sub.classList.add('hidden');
    if (st) st.innerHTML = '<span class="speak-note">重新录音。</span>';
  };

  App.finishSpeak = function (q) {
    if (this.answered) return;
    var latency = Date.now() - this.questionStartAt;
    var inp = document.getElementById('q-input');
    var typed = inp && inp.value.trim();

    var judgment;
    if (this._spokenText || typed) {
      judgment = window.AgentVoice.judgeTranscript(this._spokenText || typed, q.answer);
    } else {
      judgment = { ok: false, score: 0, basis: '没有提供朗读内容', feedback: '请重录一次，或输入文字回答。' };
    }

    this.answered = true;
    Session.record(judgment.ok ? 'correct' : 'wrong', latency);
    /* 附加上转写依据 */
    var attempts = Store.getAttempts();
    if (attempts.length) {
      attempts[attempts.length - 1].spoken = this._spokenText || typed || '';
      attempts[attempts.length - 1].basis = judgment.basis;
      Store.saveAttempts(attempts);
    }

    var fb = document.getElementById('feedback-area');
    var cls = judgment.ok ? 'ok' : 'err';
    fb.innerHTML = '<div class="feedback-card ' + cls + '">' +
      '<span class="fb-word">' + (judgment.ok ? '✓ 已读出目标词' : '✗ 未读出目标词') + '</span>' +
      '<span class="fb-meaning">依据：' + App.esc(judgment.basis) + '</span>' +
      '<span class="fb-meaning">建议：' + App.esc(judgment.feedback) + '</span>' +
      '<span class="fb-meaning" style="font-size:0.78rem;color:var(--ink-lighter)">说明：这是"识别判断"，不是专业发音评分。可重听标准音并对照重读。</span>' +
      '</div>';

    /* AI 补充（可选） */
    if (window.AgentShared && window.AgentShared.AI && window.AgentShared.AI.isReady()) {
      window.AgentVoice.aiComment(this._spokenText || typed || '', q.answer, function (txt) {
        var extra = document.createElement('div');
        extra.className = 'feedback-card info';
        extra.style.marginTop = '10px';
        extra.innerHTML = '<span class="fb-word">AI 参考</span><span class="fb-meaning">' + App.esc(txt) + '</span>' +
          '<span class="fb-meaning" style="font-size:0.78rem;color:var(--ink-lighter)">AI 生成内容，仅供参考，不作为评分。</span>';
        fb.appendChild(extra);
      }, function () {});
    }
    document.getElementById('btn-next').classList.remove('hidden');
    this.updateSessionProgress();
  };

  /* ================================================================
   * 5. 视图栈：可靠返回机制
   * ================================================================ */
  var origShowView = App.showView;
  App._stack = ['home'];
  App._scrollSave = {};

  App.showView = function (name, opts) {
    opts = opts || {};
    if (!this._stack || !this._stack.length) this._stack = ['home'];
    /* 保存当前页滚动 */
    var cur = this._stack[this._stack.length - 1];
    var scroller = document.scrollingElement || document.documentElement;
    this._scrollSave[cur] = scroller.scrollTop;

    var top = this._stack[this._stack.length - 1];
    if (opts.replace) {
      if (top !== name) { this._stack[this._stack.length - 1] = name; }
      try { history.replaceState({ v: name }, ''); } catch (e) {}
    } else {
      if (top !== name) {
        this._stack.push(name);
        try { history.pushState({ v: name }, ''); } catch (e) {}
      }
    }
    this._applyView(name);
  };

  App._applyView = function (name) {
    origShowView.call(this, name);
    var self = this;
    setTimeout(function () {
      if (self._scrollSave[name] != null) {
        (document.scrollingElement || document.documentElement).scrollTop = self._scrollSave[name];
      }
    }, 0);
    /* 训练会话恢复：进入学习页时若会话未结束则直接继续 */
    if (name === 'study' && Session.current &&
        Session.current.index < Session.current.questions.length &&
        !document.getElementById('study-session').classList.contains('hidden')) {
      /* 已在会话中，无需处理 */
    } else if (name === 'study' && Session.current && Session.current.questions &&
        Session.current.index < Session.current.questions.length) {
      var setup = document.getElementById('study-setup');
      var sess = document.getElementById('study-session');
      var sum = document.getElementById('session-summary');
      if (setup && sess && sum) {
        setup.classList.add('hidden');
        sess.classList.remove('hidden');
        sum.classList.add('hidden');
        this.answered = false;
        this.questionStartAt = Date.now();
        this.renderQuestion();
        this.updateSessionProgress();
      }
    }
  };

  App.goBack = function () {
    if (this._stack.length <= 1) {
      if (window.AgentNav && AgentNav.home) location.href = AgentNav.home;
      else history.back();
      return;
    }
    this._stack.pop();
    var prev = this._stack[this._stack.length - 1];
    this._applyView(prev);
  };

  /* 浏览器后退：与应用内返回行为一致 */
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.v) {
      /* 找到栈中该视图，截断栈 */
      var idx = App._stack.lastIndexOf(e.state.v);
      if (idx > 0) App._stack.length = idx + 1;
      App._applyView(e.state.v);
    } else {
      App.goBack();
    }
  });

  /* ================================================================
   * 6. 词条详情弹层（返回保留列表状态）
   * ================================================================ */
  App.openWordDetail = function (wordId, from) {
    var w = Words.byId(wordId);
    if (!w) return;
    var states = Store.getStates();
    var ws = states[wordId] || {};
    var st = Skills.overallState(states, wordId);

    var html = '<div class="wd-backbar"><button class="btn btn-ghost" onclick="App.closeWordDetail()">‹ 返回' +
      (from ? '（' + App.esc(from) + '）' : '') + '</button>' +
      '<span class="an-title">词条详情</span></div>';

    html += '<div class="wd-head">' +
      '<h2>' + App.esc(w.lemma) + '</h2>' +
      (w.pron ? '<span class="q-pron">' + App.esc(w.pron) + '</span>' : '') +
      '<span class="q-pos">' + App.esc(w.pos) + ' · ' + App.esc(w.setName) + '</span>' +
      '<div class="wd-status">当前状态：<b>' + App.esc(st) + '</b></div>' +
      '</div>';

    html += '<div class="wd-meaning"><b>释义：</b>' + App.esc(w.meanings) + '</div>';

    /* 各技能状态 */
    html += '<div class="wd-skills"><b>各技能记录</b>';
    Skills.list.forEach(function (sk) {
      var s = ws[sk];
      if (!s || s.state === '未开始' && s.evidence === 0) return;
      html += '<div class="wd-skill-row">' +
        '<span>' + App.esc(Skills.labels[sk] || sk) + '</span>' +
        '<span class="wd-state">' + App.esc(s.state) + '</span>' +
        '<span class="wd-count">独立正确 ' + s.correct + ' · 提示后 ' + s.hintCorrect + ' · 错误 ' + s.wrong + '</span>' +
        '</div>';
    });
    if (html.indexOf('wd-skill-row') === -1) html += '<div class="wd-skill-row">尚无训练记录</div>';
    html += '</div>';

    var ex = exBank()[w.lemma.toLowerCase()];
    if (ex) {
      html += '<div class="wd-example"><b>例句：</b>' + App.esc(ex.sentence) +
        '<br><span class="wd-trans">' + App.esc(ex.translation) + '</span></div>';
    }

    html += '<div class="wd-actions">' +
      '<button class="btn btn-primary" onclick="App.trainOneWord(\'' + App.esc(w.id) + '\')">练习这个词</button>' +
      '<button class="btn btn-outline" onclick="App.speakWordWithOpt(\'' + App.esc(w.lemma) + '\',{})">🔊 听发音</button>' +
      '</div>';

    var wrap = document.getElementById('word-detail-modal');
    wrap.innerHTML = '<div class="wd-card">' + html + '</div>';
    wrap.classList.remove('hidden');
  };

  App.closeWordDetail = function () {
    document.getElementById('word-detail-modal').classList.add('hidden');
  };

  App.startOneWord = function (wordId) {
    App.closeWordDetail();
    var w = Words.byId(wordId);
    if (!w) return;
    var pool = Words.all();
    var skill = App.pickSkill(w, 'mixed');
    var q = Quiz.generate(w, skill, pool);
    Session.current = { questions: [q], index: 0, correct: 0, wrong: 0, guessed: 0, idk: 0,
      mode: 'single', scope: 'all', startedAt: Date.now() };
    Store.saveSession(Session.current);
    App.showView('study');
  };

  /* ================================================================
   * 7. AI 解释（本地兜底 + 在线AI）
   * ================================================================ */
  App.openAIExplain = function () {
    var q = Session.currentQ();
    if (!q) return;
    var w = q.word || q;
    var modal = document.getElementById('ai-explain');
    var body = document.getElementById('ai-explain-body');
    modal.classList.remove('hidden');
    body.innerHTML = '<div class="ai-loading">正在准备解释…</div>';

    var errorText = '';
    var lastAttempt = Store.getAttempts();
    if (lastAttempt.length) {
      var la = lastAttempt[lastAttempt.length - 1];
      if (la.wordId === w.id && la.outcome === 'wrong') errorText = '上次答错，需要解释';
    }

    var ctx = { lemma: w.lemma, pron: w.pron, pos: w.pos, meanings: w.meanings, errorText: errorText };

    var finish = function (html, fromAi) {
      body.innerHTML = html + (fromAi ? '' : '<p class="sync-help" style="margin-top:8px">当前未配置 AI 服务，展示的是词库中的信息。</p>');
      var btn = document.getElementById('ai-explain-close');
      btn.addEventListener('click', function () { App.closeAIExplain(); });
    };

    if (window.AgentShared && window.AgentShared.AI && window.AgentShared.AI.isReady()) {
      window.AgentShared.AI.explainWord(ctx).then(function (txt) {
        finish('<div class="ai-text">' + App.esc(txt).replace(/\n/g, '<br>') + '</div>' +
          '<p class="sync-help" style="margin-top:10px">AI 生成内容，请以课本和教师讲解为准；不确定处可向老师核实。</p>', true);
      }).catch(function (err) {
        var html = buildLocalExplain(w);
        finish(html + '<p class="sync-help" style="margin-top:6px">AI 服务不可用：' + App.esc(err.message) + '</p>', false);
      });
    } else {
      finish(buildLocalExplain(w), false);
    }
  };

  function buildLocalExplain(w) {
    var html = '<div class="ai-text">';
    html += '<div class="ai-line"><b>' + App.esc(w.lemma) + '</b>' +
      (w.pron ? ' ' + App.esc(w.pron) : '') + (w.pos ? '  ' + App.esc(w.pos) : '') + '</div>';
    html += '<div class="ai-line">释义：' + App.esc(w.meanings) + '</div>';
    var ex = exBank()[String(w.lemma).toLowerCase()];
    if (ex) html += '<div class="ai-line">例句：' + App.esc(ex.sentence) + '<br><span style="color:var(--ink-lighter)">' + App.esc(ex.translation) + '</span></div>';
    html += '<div class="ai-line">学习提示：多读例句、尝试用这个词口头造句，比单纯背释义更牢固。</div>';
    html += '</div>';
    return html;
  }

  App.closeAIExplain = function () {
    document.getElementById('ai-explain').classList.add('hidden');
  };

  /* 训练题面追加"AI 解释"入口 */
  var origRecordAnswer = App.recordAnswer;
  App.recordAnswer = function (outcome, latency, errorCode, q) {
    origRecordAnswer.call(this, outcome, latency, errorCode, q);
    var fb = document.getElementById('feedback-area');
    if (fb) {
      var aiBtn = document.createElement('button');
      aiBtn.className = 'btn btn-ghost ai-explain-btn';
      aiBtn.textContent = '💡 AI 解释这个词';
      aiBtn.style.marginTop = '10px';
      aiBtn.onclick = function () { App.openAIExplain(); };
      fb.appendChild(aiBtn);
    }
  };

  /* ================================================================
   * 8. 新训练模式：听辨 / 朗读 / 语境 / 基线测评
   * ================================================================ */
  App.startSkillTraining = function (skill, size, scope) {
    var states = Store.getStates();
    var pool = App.resolvePool(scope);
    if (!pool.length) { this.toast('所选词库为空'); return false; }

    var questions = [];
    var unlearned = pool.filter(function (w) { return Skills.overallState(states, w.id) === '未学习'; });
    var others = pool.filter(function (w) { return Skills.overallState(states, w.id) !== '未学习'; });

    if (skill === 'context') {
      /* 语境题只出有例句的词 */
      var withEx = pool.filter(function (w) { return exBank()[String(w.lemma).toLowerCase()]; });
      questions = shuffle(withEx).slice(0, size).map(function (w) { return Quiz.generate(w, 'context', pool); });
    } else if (skill === 'listening') {
      var mix = shuffle(unlearned).concat(shuffle(others));
      questions = mix.slice(0, size).map(function (w) { return Quiz.generate(w, 'listening', pool); });
    } else {
      questions = shuffle(pool).slice(0, size).map(function (w) { return Quiz.generate(w, 'speaking', pool); });
    }

    if (!questions.length) { App.toast('没有可练习的词'); return false; }

    Session.current = {
      questions: questions, index: 0, correct: 0, wrong: 0, guessed: 0, idk: 0,
      mode: skill, scope: scope || 'all', startedAt: Date.now()
    };
    Store.saveSession(Session.current);
    App.showView('study');
    document.getElementById('study-setup').classList.add('hidden');
    document.getElementById('study-session').classList.remove('hidden');
    document.getElementById('session-summary').classList.add('hidden');
    App.answered = false;
    App.questionStartAt = Date.now();
    App.renderQuestion();
    App.updateSessionProgress();
    return true;
  };

  /* 基线测评：短测评判断已掌握情况 */
  App.baselineTest = function (scope) {
    var states = Store.getStates();
    var pool = App.resolvePool(scope);
    var unlearned = pool.filter(function (w) { return Skills.overallState(states, w.id) === '未学习'; });
    if (!unlearned.length) { App.toast('词库中的词都已有训练记录，可直接开始学习'); return; }
    var sample = shuffle(unlearned).slice(0, Math.min(12, unlearned.length));
    var questions = sample.map(function (w) { return Quiz.generate(w, 'recognition', pool); });
    /* 半数为无选项回忆，检验真实掌握 */
    var idx = 0;
    questions = questions.map(function (q) {
      idx++;
      if (idx % 2 === 0) { var q2 = Quiz.generate(q.word, 'recall', pool); return q2; }
      return q;
    });
    Session.current = {
      questions: questions, index: 0, correct: 0, wrong: 0, guessed: 0, idk: 0,
      mode: 'baseline', scope: scope || 'all', startedAt: Date.now()
    };
    Store.saveSession(Session.current);
    App.showView('study');
    document.getElementById('study-setup').classList.add('hidden');
    document.getElementById('study-session').classList.remove('hidden');
    document.getElementById('session-summary').classList.add('hidden');
    App.answered = false;
    App.questionStartAt = Date.now();
    App.renderQuestion();
    App.updateSessionProgress();
  };

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ================================================================
   * 9. 双周计划与离线巩固回填
   * ================================================================ */
  App.getCycle = function () {
    var s = Store.getSettings();
    if (!s.cycleStart) {
      /* 默认：以最近一个周一为周期起点（双周） */
      var d = new Date();
      var day = (d.getDay() + 6) % 7;
      s.cycleStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime();
      s.cycleDays = 14;
      Store.saveSettings(s);
    }
    return { start: s.cycleStart, days: s.cycleDays || 14, end: s.cycleStart + (s.cycleDays || 14) * 86400000 };
  };

  App.renderCycleInfo = function (containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var c = this.getCycle();
    var start = new Date(c.start);
    var end = new Date(c.end);
    var attempts = Store.getAttempts();
    var inCycle = attempts.filter(function (a) { return a.ts >= c.start && a.ts < c.end; });
    var correct = inCycle.filter(function (a) { return a.outcome === 'correct' && !a.isGuess; }).length;
    var wrong = inCycle.filter(function (a) { return a.outcome === 'wrong'; }).length;

    var offline = Store.getSettings().offline || [];
    el.innerHTML =
      '<div class="report-section">' +
      '<h3>双周周期</h3>' +
      '<p>' + start.toLocaleDateString('zh-CN') + ' — ' + end.toLocaleDateString('zh-CN') + '</p>' +
      '<p>本周期答题：' + inCycle.length + ' 次（独立正确 ' + correct + '，错误 ' + wrong + '）</p>' +
      '<p style="font-size:0.85rem;color:var(--ink-lighter)">系统按间隔复习自动安排复习；住校期间可用打印的巩固包线下完成。</p>' +
      '</div>' +
      '<div class="report-section">' +
      '<h3>线下巩固回填</h3>' +
      '<p>住校期间完成的纸质练习可在此标记（自报数据，与系统自动作答分开记录）：</p>' +
      '<div class="report-actions" style="margin-top:10px">' +
      '<button class="btn btn-outline" onclick="App.markOfflineDone()">标记完成一次线下巩固</button>' +
      '<button class="btn btn-outline" onclick="App.exportPaperPack()">下载/打印纸质巩固包</button>' +
      '</div>' +
      '<p class="sync-help" style="margin-top:8px">线下自报：' + (offline.length || 0) + ' 次（' +
      (offline.length ? offline.map(function (x) { return new Date(x.ts).toLocaleDateString(); }).join('、') : '暂无') + '）</p>' +
      '</div>';
  };

  App.markOfflineDone = function () {
    var s = Store.getSettings();
    s.offline = s.offline || [];
    s.offline.push({ ts: Date.now() });
    if (Store.saveSettings(s)) App.toast('已记录线下巩固完成');
    App.renderCycleInfo('cycle-info');
  };

  /* ================================================================
   * 10. 家长报告：周期筛选与趋势
   * ================================================================ */
  var origParent = App.renderParentReport;
  App.period = 'all';

  function fmtSeg(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  App.renderParentReport = function () {
    var old = document.getElementById('parent-extra');
    if (old) old.parentNode.removeChild(old);
    origParent.call(this);
    this.renderCycleInfo('cycle-info');
    /* 周期筛选 */
    var attempts = Store.getAttempts();
    var now = Date.now();
    var dayMs = 86400000;
    var filter = this.periodFilter;
    var range = null;
    if (filter === 'week') range = [now - 7 * dayMs, now];
    else if (filter === 'biweek') range = [now - 14 * dayMs, now];
    else if (filter === 'month') range = [now - 30 * dayMs, now];
    var filtered = range ? attempts.filter(function (a) { return a.ts >= range[0] && a.ts <= range[1]; }) : attempts;

    /* 技能趋势（每 7 天一段，最近 4 段） */
    var trend = [];
    var seg = range || [now - 30 * dayMs, now];
    for (var k = 0; k < 4; k++) {
      var end = seg[1] - k * 7 * dayMs;
      var start = end - 7 * dayMs;
      var items = filtered.filter(function (a) { return a.ts >= start && a.ts < end; });
      var corr = items.filter(function (a) { return a.outcome === 'correct' && !a.isGuess; }).length;
      var wro = items.filter(function (a) { return a.outcome === 'wrong'; }).length;
      trend.unshift({ label: fmtSeg(start), total: items.length, correct: corr, wrong: wro });
    }

    var html = '<div id="parent-extra">';
    html += '<div class="report-section"><h3>周期趋势（按 7 天分段）</h3>';
    if (trend.every(function (t) { return t.total === 0; })) {
      html += '<p style="color:var(--ink-lighter)">该周期内暂无答题记录。</p>';
    } else {
      html += '<table class="report-table"><tr><th>时间段</th><th>答题</th><th>独立正确</th><th>错误</th><th>独立正确率</th></tr>';
      trend.forEach(function (t) {
        var rate = t.total ? Math.round(t.correct / (t.correct + t.wrong || 1) * 100) : 0;
        html += '<tr><td>' + t.label + '</td><td>' + t.total + '</td><td>' + t.correct + '</td><td>' + t.wrong +
          '</td><td>' + (t.total ? rate + '%' : '—') + '</td></tr>';
      });
      html += '</table>';
    }
    html += '<p style="font-size:0.8rem;color:var(--ink-lighter);margin-top:8px">仅统计该周期内的系统自动作答记录。</p></div>';
    html += '<div class="report-section"><h3>按周期筛选</h3><div class="report-actions">' +
      '<button class="btn ' + (filter === 'all' ? 'btn-primary' : 'btn-outline') + '" onclick="App.setPeriod(\'all\')">全部</button>' +
      '<button class="btn ' + (filter === 'week' ? 'btn-primary' : 'btn-outline') + '" onclick="App.setPeriod(\'week\')">近 7 天</button>' +
      '<button class="btn ' + (filter === 'biweek' ? 'btn-primary' : 'btn-outline') + '" onclick="App.setPeriod(\'biweek\')">近 14 天</button>' +
      '<button class="btn ' + (filter === 'month' ? 'btn-primary' : 'btn-outline') + '" onclick="App.setPeriod(\'month\')">近 30 天</button>' +
      '</div></div></div>';
    document.getElementById('parent-report').insertAdjacentHTML('afterend', html);
  };

  App.setPeriod = function (p) {
    this.periodFilter = p;
    this.renderParentReport();
  };

  /* 薄弱词点击 → 词条详情 */
  (function () {
    var orig = App.renderParentReport;
    App.renderParentReport = function () {
      orig.call(this);
      /* 给薄弱词表格行加点击 */
      var rows = document.querySelectorAll('#parent-report tr');
      rows.forEach(function (r) {
        var b = r.querySelector('b');
        if (b) r.style.cursor = 'pointer';
        r.addEventListener('click', function () {
          var lemma = b ? b.textContent : '';
          var w = Words.all().find(function (x) { return x.lemma === lemma; });
          if (w) App.openWordDetail(w.id, '家长报告');
        });
      });
    };
  })();

  /* ================================================================
   * 11. 词库管理增强：词库元信息与新建词库
   * ================================================================ */
  App.newSet = function () {
    var name = prompt('新词库名称：');
    if (!name || !name.trim()) return;
    var id = 'set_' + Date.now().toString(36);
    Words.data.sets.push({ id: id, name: name.trim(), source: '用户自建', description: '',
      license: '用户自建', level: '', theme: '', words: [] });
    if (Store.saveWords(Words.data)) {
      Words.rebuildFlat();
      App.renderManageList();
      App.refreshSetTabs();
      App.toast('词库已创建，可开始添加或导入词条');
    }
  };

  App.deleteSet = function (setId) {
    var set = Words.data.sets.find(function (s) { return s.id === setId; });
    if (!set) return;
    App.showConfirm('确认删除词库「' + set.name + '」（含 ' + set.words.length + ' 个词）？学习记录不会自动清除，但该词库的词条将不可再训练。', function () {
      Words.data.sets = Words.data.sets.filter(function (s) { return s.id !== setId; });
      Store.saveWords(Words.data);
      Words.rebuildFlat();
      App.renderManageList();
      App.refreshSetTabs();
      App.toast('词库已删除');
    });
  };

  App.refreshSetTabs = function () {
    var container = document.getElementById('set-tabs');
    if (!container) return;
    var html = '';
    Words.data.sets.forEach(function (s) {
      html += '<button class="set-tab' + (s.id === App.currentSet ? ' active' : '') + '" data-set="' + App.esc(s.id) + '" onclick="App.filterSet(\'' + App.esc(s.id) + '\')">' +
        App.esc(s.name) + '（' + s.words.length + '词）</button>';
    });
    container.innerHTML = html;
  };

  /* 设置里的词库范围下拉 → 动态列出所有词库 */
  App.refreshScopeSelect = function () {
    var sel = document.getElementById('round-scope');
    if (!sel) return;
    var html = '<option value="all">全部词库</option>';
    Words.data.sets.forEach(function (s) {
      html += '<option value="' + App.esc(s.id) + '"' + (sel.value === s.id ? ' selected' : '') + '>' + App.esc(s.name) + '</option>';
    });
    sel.innerHTML = html;
  };

  /* ================================================================
   * 12. 训练模式入口包装（听说/语境/测评）
   * ================================================================ */
  App.startListeningTraining = function () {
    var size = parseInt(document.getElementById('round-size').value) || 15;
    var scope = App.resolveScope();
    this.startSkillTraining('listening', size, scope);
  };
  App.startSpeakingTraining = function () {
    var size = parseInt(document.getElementById('round-size').value) || 10;
    var scope = App.resolveScope();
    this.startSkillTraining('speaking', size, scope);
  };
  App.startContextTraining = function () {
    var size = parseInt(document.getElementById('round-size').value) || 10;
    var scope = App.resolveScope();
    this.startSkillTraining('context', size, scope);
  };

  /* 续上次训练（首页入口） */
  App.resumeSession = function () {
    if (Session.tryResume()) {
      App.showView('study');
      document.getElementById('study-setup').classList.add('hidden');
      document.getElementById('study-session').classList.remove('hidden');
      document.getElementById('session-summary').classList.add('hidden');
      App.answered = false;
      App.questionStartAt = Date.now();
      App.renderQuestion();
      App.updateSessionProgress();
    } else {
      App.toast('没有可继续的训练');
    }
  };

  /* 共享语音设置读取（供设置页显示） */
  App.voiceStatus = function () {
    if (window.AgentShared) return window.AgentShared.Voice.detect();
    return {};
  };

  /* 语速设置同步到共享语音配置 */
  var origSaveSetting = App.saveSetting;
  App.saveSetting = function (key, value) {
    origSaveSetting.call(this, key, value);
    if (key === 'speechRate' && window.AgentShared) {
      var s = AgentShared.load();
      s.voice.rate = parseFloat(value) || 1.0;
      AgentShared.save(s);
    }
  };

  /* ---------- 补充体验细节 ---------- */
  /* CSV 导入模板（含来源/等级/主题字段说明） */
  App.downloadImportTemplate = function () {
    var csv = 'lemma,pron,pos,meanings,set,level,theme,source\n' +
      'example,/ɪɡˈzɑːmpl/,n.,例子；示例,商务英语基础,高中基础,商务沟通,教师词单\n' +
      'conference,/ˈkɒnfərəns/,n.,会议；讨论会,商务英语基础,高中基础,商务沟通,自编\n' +
      'devote,/dɪˈvəʊt/,vt.,把……专用于；献身,day3,高中必修,农业科技,人教版\n';
    App.downloadFile('\ufeff' + csv, '词库导入模板.csv', 'text/csv');
    App.toast('模板已导出：填好英文、释义即可；set 填词库名称或 id，可留空');
  };

  /* 离开训练时若有未提交录音/输入，先确认（避免误丢） */
  var origGoBack = App.goBack;
  App.goBack = function () {
    var busy = App._rec || (Session.current && !App.answered &&
      Session.currentQ() && Session.currentQ().type === 'speak');
    if (busy) {
      App.showConfirm('当前题尚未完成（可能包含未提交的录音），返回会保留训练进度，下次可继续。确定返回？', function () {
        if (App._rec) { try { window.AgentVoice.stopRecording(App._rec); } catch (e) {} App._rec = null; }
        origGoBack();
      });
      return;
    }
    origGoBack();
  };

  /* 复习列表：显示每个到期词的到期原因与上次表现 */
  var origReview = App.renderReview;
  App.renderReview = function () {
    origReview.call(this);
    var states = Store.getStates();
    var dueWords = Words.all().filter(function (w) { return Skills.isDue(states, w.id); });
    var html = '';
    dueWords.slice(0, 50).forEach(function (w) {
      var ws = states[w.id] || {};
      var reasons = [];
      Skills.list.forEach(function (sk) {
        var s = ws[sk];
        if (!s || !s.dueAt || s.dueAt > Date.now()) return;
        var why = Skills.labels[sk] || sk;
        if (s.wrong > 0) why += '（上次错误）';
        else if (s.hintCorrect > 0) why += '（上次提示）';
        else if (s.guessed > 0) why += '（上次快速猜测）';
        else why += '（间隔到期）';
        reasons.push(why);
      });
      html += '<div class="word-card" onclick="App.openWordDetail(\'' + App.esc(w.id) + '\',\'复习计划\')">' +
        '<div class="word-card-head">' +
        '<span class="word-index">' + App.esc(w.setName) + '</span>' +
        '<span class="word-lemma">' + App.esc(w.lemma) + '</span>' +
        '<span class="word-pos">' + App.esc(w.pos) + '</span>' +
        '</div>' +
        '<div class="word-meaning">' + App.esc(w.meanings) + '</div>' +
        '<div class="word-why" style="font-size:0.78rem;color:var(--vermilion);margin-top:4px">到期：' + reasons.join(' · ') + '</div>' +
        '</div>';
    });
    if (html) document.getElementById('due-list').innerHTML = html;
  };

  /* ---------- 浏览等级筛选 ---------- */
  App.refreshLevelSelect = function () {
    var sel = document.getElementById('browse-level');
    if (!sel) return;
    var levels = {};
    Words.data.sets.forEach(function (s) { if (s.level) levels[s.level] = true; });
    var html = '<option value="all">全部等级</option>';
    Object.keys(levels).forEach(function (lv) {
      html += '<option value="' + App.esc(lv) + '">' + App.esc(lv) + '</option>';
    });
    sel.innerHTML = html;
  };

  var origBrowse = App.renderBrowseList;
  App.renderBrowseList = function () {
    var levelSel = document.getElementById('browse-level');
    var level = levelSel ? levelSel.value : 'all';
    var set = Words.data.sets.find(function (s) { return s.id === App.currentSet; });
    if (lv) {
      if (set && set.level && level !== 'all' && set.level !== level) {
        /* 词库等级不匹配 → 显示空 */
        document.getElementById('word-list').innerHTML =
          '<div style="text-align:center;color:var(--ink-lighter);padding:40px">当前词库等级与所选筛选不符</div>';
        return;
      }
    }
    origBrowse.call(this);
  };

  /* ================================================================
   * 13. 初始化增强
   * ================================================================ */
  var origInit = App.init;
  App.init = function () {
    origInit.call(this);
    /* 词库选择下拉与标签页动态化 */
    this.refreshScopeSelect();
    this.refreshSetTabs();
    this.refreshLevelSelect();
    /* 家长报告周期 */
    this.periodFilter = 'all';
    this.renderCycleInfo('cycle-info');
    /* 顶栏返回按钮 */
    var backBtn = document.getElementById('nav-back');
    if (backBtn) backBtn.addEventListener('click', function () { App.goBack(); });
    /* 设置页共享状态显示 */
    this.renderSharedStatus();
    /* 刷新后尽量恢复上次视图（安全回退：home） */
    try {
      var last = sessionStorage.getItem('qs_lastview');
      if (last && last !== 'home' && document.getElementById('view-' + last)) {
        this.showView(last, { replace: true });
      }
    } catch (e) {}
  };

  /* 记录当前视图（供刷新恢复） */
  var origApply = App._applyView;
  App._applyView = function (name) {
    origApply.call(this, name);
    try { sessionStorage.setItem('qs_lastview', name); } catch (e) {}
  };

  App.renderSharedStatus = function () {
    var aiEl = document.getElementById('ai-shared-status');
    var voiceEl = document.getElementById('voice-shared-status');
    if (!aiEl && !voiceEl) return;
    if (window.AgentShared) {
      if (aiEl) {
        var c = AgentShared.AI.config();
        aiEl.textContent = (c.enabled && c.endpoint) ? ('已配置：' + (c.model || '未填模型')) : '未配置（在首页设置中心配置）';
      }
      if (voiceEl) {
        var v = AgentShared.Voice.detect();
        var parts = [];
        if (v.speechSynthesis) parts.push('朗读可用');
        if (v.mediaRecorder) parts.push('录音可用');
        if (v.speechRecognition) parts.push('语音识别可用');
        voiceEl.textContent = parts.length ? parts.join(' · ') : '设备能力有限（可文字学习）';
      }
    } else {
      if (aiEl) aiEl.textContent = '共享模块未加载';
      if (voiceEl) voiceEl.textContent = '共享模块未加载';
    }
  };
})();