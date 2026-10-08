/**
 * 千手-淘淘英语学习 · 语音能力模块
 * 实现《AI 英语教练 V1.0》第 14 节与实施指南 8.1 的语音闭环：
 *   标准朗读 → 录音/试听/重录 → 语音识别 → 有依据的判断 → 文字回退
 *
 * 边界（诚实声明）：
 *   - 本模块提供"识别判断"（是否读出目标词、转写是否匹配），
 *     不提供音素级"专业发音评分"；
 *   - 低置信转写只提示"识别不确定"，允许重录或改用文字回答；
 *   - 音频默认仅在本机处理，不上传；云端 AI 判断需用户显式开启。
 */
(function () {
  'use strict';
  if (window.AgentVoice) return;

  var micStream = null;

  /* 设备能力 */
  function detect() {
    return {
      synthesis: !!(window.speechSynthesis && typeof window.speechSynthesis.speak === 'function'),
      getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      mediaRecorder: !!window.MediaRecorder,
      recognition: !!((window.SpeechRecognition || window.webkitSpeechRecognition))
    };
  }

  function getRecognition() {
    var C = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!C) return null;
    var r = new C();
    r.lang = 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.continuous = false;
    return r;
  }

  /* 请求麦克风并开始录音；返回 Promise<MediaRecorder> */
  function startRecording() {
    var cap = detect();
    if (!cap.getUserMedia) return Promise.reject(new Error('当前浏览器不支持麦克风录音'));
    return navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        micStream = stream;
        if (!cap.mediaRecorder) {
          stopTracks(stream);
          return Promise.reject(new Error('当前浏览器不支持录音功能'));
        }
        var rec = new MediaRecorder(stream);
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
        rec.start();
        rec._chunks = chunks;
        return rec;
      });
  }

  function stopRecording(rec) {
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) {} }
    stopMicStream(micStream);
    micStream = null;
  }

  function stopMicStream(stream) {
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
  }

  function blobFromRec(rec) {
    var chunks = rec._chunks || [];
    if (!chunks.length) return null;
    return new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  }

  /* 播放录音（Blob → object URL → <audio>） */
  function playBlob(blob, onEnded) {
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    audio.onended = function () {
      URL.revokeObjectURL(url);
      if (onEnded) onEnded();
    };
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
    return audio;
  }

  /**
   * 语音识别（实时麦克风）：把学生所说转成文本。
   * 返回 Promise<{ transcript, confidence, raw }>；
   * 不支持或出错时 reject。
   */
  function transcribe() {
    var r = getRecognition();
    if (!r) return Promise.reject(new Error('当前浏览器不支持语音识别'));
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; try { r.abort(); } catch (e) {} reject(new Error('识别超时')); }
      }, 15000);
      r.onresult = function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var res = e.results && e.results[0];
        var transcript = res && res[0] ? res[0].transcript : '';
        var confidence = res && res[0] && typeof res[0].confidence === 'number' ? res[0].confidence : null;
        resolve({ transcript: transcript, confidence: confidence });
      };
      r.onerror = function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var msg = e.error === 'not-allowed' ? '麦克风权限被拒绝' :
                  e.error === 'no-speech' ? '未检测到语音' : ('语音识别错误：' + (e.error || '未知'));
        reject(new Error(msg));
      };
      r.onend = function () {
        if (!done) { done = true; clearTimeout(timer); reject(new Error('识别提前结束，未得到结果')); }
      };
      try { r.start(); } catch (e) { reject(new Error('无法启动语音识别')); }
    });
  }

  /* ---------- 归一化比较（依据判断） ---------- */
  function normalize(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z' -]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Levenshtein 距离 */
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var m = [], i, j;
    for (i = 0; i <= b.length; i++) m[i] = [i];
    for (j = 0; j <= a.length; j++) m[0][j] = j;
    for (i = 1; i <= b.length; i++) {
      for (j = 1; j <= a.length; j++) {
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1,
          m[i - 1][j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1));
      }
    }
    return m[b.length][a.length];
  }

  /**
   * 对语音识别结果作出"识别判断"（有依据，非发音评分）。
   * 返回 { ok, score, detail, basis }：
   *   ok: 是否识别出目标词
   *   score: 0-1 相似度（依据：转写与目标词编辑距离）
   *   basis: 给用户看的判断依据（转写原文 + 说明）
   *   feedback: 简短可执行建议
   */
  function judgeTranscript(transcript, target) {
    var t = normalize(transcript);
    var targetNorm = normalize(target);
    if (!t) return {
      ok: false, score: 0,
      basis: '未识别到清晰的语音（转写为空）',
      feedback: '请重录一次，或改用文字回答。'
    };
    var contains = t.indexOf(targetNorm) >= 0;
    var dist = levenshtein(t, targetNorm);
    var maxLen = Math.max(t.length, targetNorm.length) || 1;
    var sim = Math.max(0, 1 - dist / maxLen);
    /* 识别判断：命中目标词、或仅一字之差（≥4字母词）、或相似度达阈值 */
    var ok = contains || (targetNorm.length >= 4 && dist <= 1) || sim >= 0.72;
    var basis = '识别结果为「' + transcript + '」' +
      (contains ? '，包含目标词。' : '，与目标词相似度 ' + Math.round(sim * 100) + '%。');
    var feedback;
    if (contains) {
      feedback = '已读出目标词。可以重听标准音，注意重音和词尾的清楚程度，再读一次对比。';
    } else if (sim >= 0.5) {
      feedback = '接近目标词，但存在差别。重听标准音，注意整体读音，再试一次。';
    } else {
      feedback = '未能识别为目标词。先跟读标准音，再慢慢读一遍。';
    }
    return { ok: ok, score: sim, basis: basis, feedback: feedback, transcript: t };
  }

  /* 用配置的 AI 补充一段基于文字转写的反馈（明确为辅助参考，不做评分） */
  function aiComment(transcript, target, onDone, onFail) {
    if (!window.AgentShared || !window.AgentShared.AI) { onFail(new Error('共享设置不可用')); return; }
    var AI = window.AgentShared.AI;
    if (!AI.isReady()) { onFail(new Error('未配置 AI 服务')); return; }
    var prompt =
      '学生朗读英语单词 "' + target + '"，浏览器语音识别到的文字是："' + transcript + '"。' +
      '请用简短中文给出一条可执行的朗读改进建议（针对发音、重音或节奏），' +
      '不要给分数，不要评价学生。如果识别文字无法反映发音细节，请说明"本次识别有限，建议对照原音重读"。';
    AI.chat([{ role: 'user', content: prompt }], { max_tokens: 200, temperature: 0.4 })
      .then(onDone)
      .catch(onFail);
  }

  window.AgentVoice = {
    detect: detect,
    startRecording: startRecording,
    stopRecording: stopRecording,
    stopMicStream: stopMicStream,
    blobFromRec: blobFromRec,
    playBlob: playBlob,
    transcribe: transcribe,
    judgeTranscript: judgeTranscript,
    aiComment: aiComment,
    levenshtein: levenshtein,
    normalize: normalize
  };
})();