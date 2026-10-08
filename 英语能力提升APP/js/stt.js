/**
 * ECSTT · 语音识别适配层
 * 主通道：MiniMax ASR（用户确认选型）——录音采集 → 16kHz WAV 编码 → multipart 上传
 *         默认按 OpenAI 兼容惯例 POST {base}/v1/audio/transcriptions（端点路径可配置）。
 *         诚实边界：MiniMax 官方 ASR 端点格式未拿到权威文档，首次使用请点"测试识别"
 *         真实验证；若路径不同，在设置中修改"端点路径"即可，绝不伪造成功。
 * 回退：Web Speech API（浏览器原生，英语栏目已验证可用），设置中可切换。
 *
 * 密钥策略：优先用本栏目 STT 配置；未配置时自动沿用千手统一设置中心的
 * AI 服务地址与密钥（同一 MiniMax key 通吃 chat/T2A/ASR，零额外配置）。
 * 隐私策略：上传音频前检查统一设置"允许云端语音判断"（privacy.audioUpload），
 *          未开启则拒绝上传并提示，不静默外发。
 */
(function () {
  'use strict';
  if (window.ECSTT) return;

  var CFG_KEY = 'coach_stt_config';
  var DEFAULT = {
    provider: 'minimax',            /* 'minimax' | 'webspeech' */
    baseUrl: '',                     /* 留空自动沿用统一设置中心 AI 地址 */
    apiKey: '',                      /* 留空自动沿用统一设置中心密钥 */
    path: '/v1/audio/transcriptions',/* OpenAI 兼容默认；官方路径不同在此改 */
    model: '',
    language: 'en-US'
  };

  function cfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT));
      return Object.assign({}, DEFAULT, JSON.parse(raw));
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULT)); }
  }
  function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); return true; } catch (e) { return false; }
  }

  function detect() {
    return {
      speechRecognition: !!((window.SpeechRecognition || window.webkitSpeechRecognition)),
      getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      audioContext: !!(window.AudioContext || window.webkitAudioContext)
    };
  }

  /* ---------- 录音采集器：AudioContext + ScriptProcessor（兼容性最好） ---------- */
  function Recorder() {
    var self = this;
    this.chunks = [];         /* Float32 采样块（源采样率） */
    this.sampleRate = 0;
    this.ctx = null; this.stream = null; this.node = null; this.src = null;

    this.start = function () {
      return new Promise(function (resolve, reject) {
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
          reject(new Error('此浏览器不支持麦克风（需要 Edge/Chrome）')); return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
          var AC = window.AudioContext || window.webkitAudioContext;
          self.stream = stream;
          self.ctx = new AC();
          self.sampleRate = self.ctx.sampleRate;
          self.src = self.ctx.createMediaStreamSource(stream);
          self.node = self.ctx.createScriptProcessor(4096, 1, 1);
          self.node.onaudioprocess = function (e) {
            var inp = e.inputBuffer.getChannelData(0);
            self.chunks.push(new Float32Array(inp));
          };
          self.src.connect(self.node);
          self.node.connect(self.ctx.destination);
          resolve();
        }).catch(function (err) {
          reject(new Error('麦克风权限被拒或不可用：' + (err && err.message ? err.message : err)));
        });
      });
    };

    this.stop = function () {
      return new Promise(function (resolve) {
        try {
          if (self.node) { self.node.disconnect(); self.src.disconnect(); }
          if (self.stream) self.stream.getTracks().forEach(function (t) { t.stop(); });
          if (self.ctx) { self.ctx.close().then(function () { resolve(); }); } else resolve();
        } catch (e) { resolve(); }
      });
    };

    /* 合并为 16kHz 16bit 单声道 WAV（ASR 通用格式） */
    this.toWav16k = function () {
      var total = 0, i;
      for (i = 0; i < self.chunks.length; i++) total += self.chunks[i].length;
      if (!total) return null;
      var merged = new Float32Array(total), off = 0;
      for (i = 0; i < self.chunks.length; i++) { merged.set(self.chunks[i], off); off += self.chunks[i].length; }
      /* 线性降采样到 16000 */
      var ratio = self.sampleRate / 16000;
      var outLen = Math.floor(total / ratio);
      var pcm = new Int16Array(outLen);
      for (i = 0; i < outLen; i++) {
        var idx = i * ratio;
        var i0 = Math.floor(idx), i1 = Math.min(i0 + 1, total - 1);
        var frac = idx - i0;
        var v = merged[i0] * (1 - frac) + merged[i1] * frac;
        var s = Math.max(-1, Math.min(1, v));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      /* 44 字节 WAV 头 */
      var buf = new ArrayBuffer(44 + pcm.length * 2);
      var v = new DataView(buf);
      function str(off, s) { for (var k = 0; k < s.length; k++) v.setUint8(off + k, s.charCodeAt(k)); }
      str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
      for (i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
      return new Blob([buf], { type: 'audio/wav' });
    };
  }

  /* ---------- MiniMax ASR：multipart 上传 WAV ---------- */
  function resolveNet() {
    var c = cfg();
    var ai = window.AgentShared ? AgentShared.AI.config() : {};
    var base = String(c.baseUrl || ai.endpoint || '').trim().replace(/\/+$/, '');
    /* 统一设置中心的 AI 地址按 OpenAI 兼容惯例以 /v1 结尾；ASR 端点含自身路径，去掉尾部 /v1 再拼 */
    base = base.replace(/\/v1$/, '');
    var key = c.apiKey || ai.key || '';
    return { base: base, key: key, path: c.path || DEFAULT.path, model: c.model || '', language: c.language || 'en-US' };
  }

  function transcribe(blob) {
    var net = resolveNet();
    if (!net.base || !net.key) {
      return Promise.reject(new Error('STT 未配置：请先在千手首页「设置中心」配置 AI 服务（地址与密钥），或在下方 STT 设置中单独填写'));
    }
    if (window.AgentShared && !AgentShared.isAudioUploadAllowed()) {
      return Promise.reject(new Error('音频上传未授权：请在千手首页「设置中心 → 语音」勾选「允许云端语音判断」（音频会发给 MiniMax 做识别）'));
    }
    var fd = new FormData();
    fd.append('file', blob, 'speech.wav');
    if (net.model) fd.append('model', net.model);
    fd.append('language', net.language);
    return fetch(net.base + net.path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + net.key },
      body: fd
    }).then(function (res) {
      return res.text().then(function (txt) {
        if (!res.ok) {
          throw new Error('ASR HTTP ' + res.status + '：' + txt.replace(/\s+/g, ' ').slice(0, 140));
        }
        var j;
        try { j = JSON.parse(txt); } catch (e) {
          throw new Error('ASR 返回的不是 JSON（开头：' + String(txt).slice(0, 60) + '）——请检查 STT 端点路径是否正确');
        }
        /* 兼容 OpenAI {text} / MiniMax {data:{text}} / {result:{text}} 三种形态 */
        var text = j.text || (j.data && j.data.text) || (j.result && j.result.text) || '';
        if (!text) throw new Error('ASR 返回中未找到识别文本：' + String(txt).slice(0, 140));
        return { text: String(text).trim(), raw: j };
      });
    });
  }

  /* ---------- Web Speech API 回退 ---------- */
  function webListen(onPartial) {
    return new Promise(function (resolve, reject) {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { reject(new Error('此浏览器不支持语音识别，请用文字输入')); return; }
      var rec = new SR();
      var lang = cfg().language || 'en-US';
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      var finalText = '';
      rec.onresult = function (e) {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        if (onPartial && interim) onPartial(interim);
      };
      rec.onerror = function (e) {
        var m = 'no-speech' === e.error ? '没听到声音，请再试一次' :
                'not-allowed' === e.error ? '麦克风权限被拒绝（浏览器地址栏允许麦克风）' :
                'network' === e.error ? '语音服务网络错误' : ('识别失败：' + e.error);
        reject(new Error(m));
      };
      rec.onend = function () {
        if (finalText.trim()) resolve({ text: finalText.trim(), provider: 'webspeech' });
        else reject(new Error('没有识别到内容，请靠近麦克风重试，或改用文字输入'));
      };
      try { rec.start(); } catch (e) { reject(new Error('语音识别启动失败：' + e.message)); }
    });
  }

  /* ---------- 对外：一次性听写 ---------- */
  function listen(opts) {
    opts = opts || {};
    var c = cfg();
    if (c.provider === 'webspeech') return webListen(opts.onPartial);
    /* minimax 主通道 */
    var rec = new Recorder();
    var t0 = Date.now();
    return rec.start().then(function () {
      return new Promise(function (resolve, reject) {
        /* 自动断句：检测到 1.6 秒静音自动停（降低"何时停"的摩擦） */
        var silenceTimer = null;
        rec.node.onaudioprocess = function (e) {
          var inp = e.inputBuffer.getChannelData(0);
          rec.chunks.push(new Float32Array(inp));
          var energy = 0;
          for (var i = 0; i < inp.length; i += 8) energy += inp[i] * inp[i];
          energy = Math.sqrt(energy / (inp.length / 8));
          var spoken = energy > 0.012;
          if (spoken) {
            if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
            if (opts.onState) opts.onState('listening');
          } else if (rec.chunks.length > 4 && !silenceTimer) {
            if (opts.onState) opts.onState('waiting');
            silenceTimer = setTimeout(function () { finish(); }, 1600);
          }
        };
        var finished = false;
        function finish() {
          if (finished) return;
          finished = true;
          rec.node.onaudioprocess = null;
          if (opts.onState) opts.onState('uploading');
          rec.stop().then(function () {
            var dur = Date.now() - t0;
            var wav = rec.toWav16k();
            if (!wav) { reject(new Error('录音为空，请按住说话')); return; }
            transcribe(wav).then(function (r) {
              resolve({ text: r.text, provider: 'minimax', durationMs: dur });
            }).catch(reject);
          });
        }
        /* 手动停止（松开按钮） */
        if (opts.manualStop) {
          opts.manualStop(function () { finish(); });
        }
        /* 最长 25 秒自动停 */
        setTimeout(function () { if (!finished) finish(); }, 25000);
      });
    });
  }

  /* ---------- 测试识别（真实调用，绝不伪造） ---------- */
  function testASR(onState) {
    return listen({ manualStop: function (done) {
      /* 测试用 3.5 秒自动停 */
      setTimeout(done, 3500);
    }, onState: onState });
  }

  window.ECSTT = {
    cfg: cfg, saveCfg: saveCfg, detect: detect,
    listen: listen, testASR: testASR,
    resolveNet: resolveNet,
    isWebSpeechAvailable: function () { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  };
})();
