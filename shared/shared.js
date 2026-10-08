/**
 * 千手学习Agent · 共享设置与服务
 * 供统一首页"设置中心"与各栏目共用：
 *   - 共享设置存储（AI、语音、同步、隐私）——各栏目数据命名空间隔离
 *   - AI 服务（统一调用接口，按栏目传不同提示词）
 *   - 语音服务（文本朗读 / 录音 / 语音识别 / 设备检测）
 *   - 数据备份与恢复
 *
 * 密钥说明：AI 密钥 / GitHub 令牌仅保存在本机浏览器 localStorage，
 * 不写入源码、HTML 或 Git 仓库；此方案适合个人本机使用，
 * 如需更高的保管要求，应使用本地代理服务。
 */
(function () {
  'use strict';
  if (window.AgentShared) return;

  var NS_KEY = 'qsAgent_shared';
  var DEFAULT = {
    version: 1,
    ai: { enabled: false, endpoint: '', model: '', key: '', system: '' },
    voice: { rate: 1.0, voiceURI: '', lang: 'en-US' },
    sync: { enabled: false, user: '', repo: '', token: '', lastSyncAt: 0, lastStatus: '' },
    privacy: { audioUpload: false, keepAudio: false },
    lastSavedAt: 0
  };

  function load() {
    try {
      var v = localStorage.getItem(NS_KEY);
      if (!v) return deepCopy(DEFAULT);
      var d = JSON.parse(v);
      var out = deepCopy(DEFAULT);
      /* 逐层合并，兼容旧结构 */
      Object.keys(DEFAULT).forEach(function (k) {
        if (d && typeof d[k] === 'object' && d[k] !== null && !Array.isArray(d[k])) {
          out[k] = Object.assign({}, DEFAULT[k], d[k]);
        }
      });
      return out;
    } catch (e) { return deepCopy(DEFAULT); }
  }

  function save(s) {
    try {
      s.version = DEFAULT.version;
      s.lastSavedAt = Date.now();
      localStorage.setItem(NS_KEY, JSON.stringify(s));
      return true;
    } catch (e) { return false; }
  }

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- AI 服务（OpenAI 兼容接口） ---------- */
  var AI = {
    config: function () { return load().ai; },

    saveConfig: function (cfg) {
      var s = load();
      s.ai = Object.assign({}, DEFAULT.ai, cfg);
      return save(s);
    },

    isReady: function () {
      var c = this.config();
      return !!(c.enabled && c.endpoint && c.model && c.key);
    },

    /* 向配置的 AI 服务发送聊天请求，返回文本；失败抛错 */
    chat: function (messages, opts) {
      var c = this.config();
      if (!this.isReady()) {
        return Promise.reject(new Error('未配置可用的 AI 服务，请在设置中心填写'));
      }
      var endpoint = String(c.endpoint || '').replace(/\/+$/, '');
      var url = endpoint + '/chat/completions';
      var body = {
        model: c.model,
        messages: messages,
        temperature: typeof opts !== 'undefined' && opts.temperature != null ? opts.temperature : 0.5,
        max_tokens: opts && opts.max_tokens ? opts.max_tokens : 600,
        stream: false
      };
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('Authorization', 'Bearer ' + c.key);
        /* 超时按调用场景传入：生成类（30天课程/教案/能力树）需 1~5 分钟；默认 120 秒 */
        xhr.timeout = (opts && typeof opts.timeout === 'number' && opts.timeout > 0) ? opts.timeout : 120000;
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              var j = JSON.parse(xhr.responseText);
              var msg = j.choices && j.choices[0] && j.choices[0].message;
              /* 只取 content（这是模型输出的正文）。不要取 reasoning_content——
               * 它是纯思考文本不是 JSON，交给解析器必然报 "not valid JSON" */
              var txt = msg && msg.content;
              if (txt) resolve(String(txt).trim());
              else {
                /* content 为空：M3.1-Flash 等推理型模型可能思考写满 max_tokens，
                 * 正文没输出。此时不取 reasoning_content（不是 JSON）。 */
                var finishReason = (j.choices && j.choices[0] && j.choices[0].finish_reason) || '';
                var raw = String(xhr.responseText || '').slice(0, 300);
                reject(new Error('AI 返回 content 为空（finish=' + finishReason + '）。' +
                  (finishReason === 'length' ? 'max_tokens 不够，模型思考太长把输出占满了。' : '') +
                  '已把 max_tokens 调大，请 Ctrl+F5 强刷后再试。'));
              }
            } catch (e) { reject(new Error('AI 返回不是有效 JSON：' + String(xhr.responseText || '').slice(0, 200))); }
          } else {
            var msg = 'HTTP ' + xhr.status;
            try { var j = JSON.parse(xhr.responseText); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
            reject(new Error(msg));
          }
        };
        xhr.onerror = function () { reject(new Error('网络错误，无法连接 AI 服务')); };
        xhr.ontimeout = function () { reject(new Error('AI 服务响应超时')); };
        xhr.send(JSON.stringify(body));
      });
    },

    /* 连接测试：问一句最短问题（max_tokens 给足：推理型模型思考也计入，太小会被截断成奇怪回复） */
    testConnection: function () {
      return this.chat([{ role: 'user', content: '请只回复两个字：正常' }], { max_tokens: 200, temperature: 0 });
    },

    /* 英语词条解释（统一提示词，结果标注 AI 生成） */
    explainWord: function (ctx) {
      var prompt =
        '你是高中英语词汇教练。请用简洁中文解释以下单词，面向高二学生，输出格式：\n' +
        '【释义】词性与中文释义\n' +
        '【例句】一个简单英文例句及中文翻译\n' +
        '【提示】一个记忆或用法要点\n' +
        '如果信息不足，请明确说明"无法确定"。\n\n' +
        '单词：' + (ctx.lemma || '') + (ctx.pron ? '  音标：' + ctx.pron : '') + '\n' +
        '已知释义：' + (ctx.meanings || '未知') + '\n' +
        (ctx.pos ? '词性：' + ctx.pos + '\n' : '') +
        (ctx.errorText ? '当前问题：' + ctx.errorText + '\n' : '');
      return this.chat([{ role: 'user', content: prompt }], { temperature: 0.4, max_tokens: 300 });
    },

    /* 生成变式练习/例句（辅助，非评分） */
    example: function (ctx) {
      var prompt = '请为一个高二学生生成一个包含单词 "' + ctx.lemma + '" 的简单英文例句并附中文翻译。只给一句，不解释。';
      return this.chat([{ role: 'user', content: prompt }], { temperature: 0.7, max_tokens: 120 });
    }
  };

  /* ---------- 语音服务 ---------- */
  var Voice = {
    settings: function () { return load().voice; },
    saveSettings: function (v) {
      var s = load();
      s.voice = Object.assign({}, DEFAULT.voice, v);
      return save(s);
    },

    /* 设备能力检测（只检测，不申请权限） */
    detect: function () {
      return {
        speechSynthesis: !!(window.speechSynthesis && typeof window.speechSynthesis.speak === 'function'),
        getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        mediaRecorder: !!(window.MediaRecorder),
        speechRecognition: !!((window.SpeechRecognition || window.webkitSpeechRecognition))
      };
    },

    voices: function () {
      if (!window.speechSynthesis) return [];
      var v = speechSynthesis.getVoices();
      return v || [];
    },

    /* 文本朗读（离线可用） */
    speak: function (text, opts) {
      if (!('speechSynthesis' in window)) return false;
      try {
        speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(String(text));
        u.lang = (opts && opts.lang) || this.settings().lang || 'en-US';
        u.rate = (opts && opts.rate) || this.settings().rate || 1.0;
        if (opts && opts.voiceURI) {
          var v = this.voices().find(function (x) { return x.voiceURI === opts.voiceURI; });
          if (v) u.voice = v;
        }
        speechSynthesis.speak(u);
        return true;
      } catch (e) { return false; }
    },

    stop: function () {
      if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
    }
  };

  /* ---------- 数据管理 ---------- */
  var Data = {
    exportAll: function (appKey, label) {
      var payload = { app: appKey, exportedAt: new Date().toISOString(), store: {} };
      var prefixes = appKey === 'english' ? ['qs_'] : ['qianshou_'];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        var ok = prefixes.some(function (p) { return k.indexOf(p) === 0; });
        if (ok) payload.store[k] = localStorage.getItem(k);
      }
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (label || '千手学习Agent') + '_备份_' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return Object.keys(payload.store).length;
    },

    importAll: function (file, onProgress) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function (e) {
          try {
            var d = JSON.parse(e.target.result);
            if (!d || typeof d.store !== 'object' || Array.isArray(d.store)) {
              reject(new Error('备份文件结构不受支持'));
              return;
            }
            var keys = Object.keys(d.store);
            if (!keys.length) { reject(new Error('备份中没有可恢复的数据')); return; }
            var applied = 0;
            keys.forEach(function (k) {
              try { localStorage.setItem(k, d.store[k]); applied++; } catch (err) {}
            });
            resolve({ applied: applied, total: keys.length });
          } catch (err) { reject(new Error('文件不是合法 JSON')); }
        };
        reader.onerror = function () { reject(new Error('读取文件失败')); };
        reader.readAsText(file);
      });
    }
  };

  /* ---------- 真人感 TTS 配置（数智学习共享；与栏目 js/tts.js 使用同一存储键 szn_tts_config） ---------- */
  var TTS_KEY = 'szn_tts_config';
  var TTS_DEFAULT = { enabled: false, provider: 'minimax', baseUrl: '', apiKey: '', model: '', voice: '', speed: 1.0 };

  var TTS = {
    loadCfg: function () {
      try {
        var raw = localStorage.getItem(TTS_KEY);
        if (!raw) return deepCopy(TTS_DEFAULT);
        return Object.assign({}, TTS_DEFAULT, JSON.parse(raw));
      } catch (e) { return deepCopy(TTS_DEFAULT); }
    },
    saveCfg: function (c) {
      try { localStorage.setItem(TTS_KEY, JSON.stringify(c)); return true; } catch (e) { return false; }
    },
    /* 音频文件头校验：拒绝损坏/伪装文件（MP3 须 ID3 或 MPEG 同步；WAV 须 RIFF/WAVE） */
    validateAudio: function (arrayBuffer, format) {
      var u8 = new Uint8Array(arrayBuffer.slice(0, 16));
      var ascii = '';
      for (var i = 0; i < u8.length; i++) ascii += String.fromCharCode(u8[i]);
      if (format === 'mp3') {
        if (ascii.slice(0, 3) === 'ID3' || (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0)) return { ok: true };
        return { ok: false, reason: 'MP3 文件头缺失（应为 ID3 或 MPEG 帧同步）' };
      }
      if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WAVE') return { ok: true };
      return { ok: false, reason: 'WAV 文件头缺失（应为 RIFF/WAVE）' };
    },
    /* 地址智能归一化：MiniMax 需要根域名（自动去掉误填的 /v1）；OpenAI 兼容需要以 /v1 结尾（自动补上） */
    normalizeBase: function (provider, url) {
      var u = String(url || '').trim().replace(/\/+$/, '');
      if (provider === 'minimax') return u.replace(/\/v1$/, '');
      if (!/\/v\d+$/.test(u)) u += '/v1';
      return u;
    },
    /* 解析 JSON 响应；非 JSON（如 404 page not found）时给说人话的错误 */
    _readJson: function (res) {
      return res.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); }
        catch (e) {
          var head = String(t).replace(/\s+/g, ' ').slice(0, 48);
          throw new Error('接口返回的不是 JSON（HTTP ' + res.status + '，响应开头：' + head + '…）。'
            + '请检查「接口地址」：MiniMax 填 https://api.minimaxi.com（带不带 /v1 都会自动识别）');
        }
        return j;
      });
    },
    /* 测试合成：真实调用一次 TTS 并校验文件头，绝不伪造成功 */
    testSynth: function () {
      var c = this.loadCfg();
      if (!c.enabled || !c.baseUrl || !c.apiKey) {
        return Promise.reject(new Error('TTS 未配置：请填写 Provider 地址与密钥并启用'));
      }
      var base = this.normalizeBase(c.provider, c.baseUrl);
      var self = this;
      if (c.provider === 'minimax') {
        return fetch(base + '/v1/t2a_v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
          body: JSON.stringify({
            model: c.model || 'speech-2.8-hd',
            text: '测试音频合成。',
            stream: false,
            voice_setting: { voice_id: c.voice || 'male-qn-qingse', speed: c.speed || 1.0, vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
            subtitle_enable: false
          })
        }).then(function (res) {
          if (!res.ok && res.status !== 200) {
            return self._readJson(res).then(function (j) {
              if (j.base_resp && j.base_resp.status_code !== 0) {
                throw new Error('MiniMax T2A 状态码 ' + j.base_resp.status_code + '：' + (j.base_resp.status_msg || '未知错误'));
              }
              throw new Error('MiniMax TTS HTTP ' + res.status);
            }).catch(function (err) {
              if (/接口返回的不是 JSON/.test(err.message)) throw err;
              throw err;
            });
          }
          return self._readJson(res);
        }).then(function (j) {
          if (j.base_resp && j.base_resp.status_code !== 0) {
            throw new Error('MiniMax T2A 状态码 ' + j.base_resp.status_code + '：' + (j.base_resp.status_msg || '未知错误'));
          }
          var audio = j && j.data && (j.data.audio || j.audio);
          if (!audio) throw new Error('返回缺少 audio 字段');
          var bytes = self._decodeHexOrBase64(audio);
          if (!bytes) throw new Error('音频解码失败（hex/base64 均无效）');
          var v = self.validateAudio(bytes.buffer, 'mp3');
          if (!v.ok) throw new Error('MP3 校验失败：' + v.reason);
          var durMs = (j.extra_info && j.extra_info.audio_length) ? j.extra_info.audio_length : null;
          return { size: bytes.length, type: 'audio/mpeg', durationSec: durMs ? durMs / 1000 : null };
        });
      }
      /* OpenAI 兼容 /audio/speech */
      return fetch(base + '/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
        body: JSON.stringify({ model: c.model || 'tts-1', input: '测试音频合成。', voice: c.voice || 'alloy', response_format: 'mp3', speed: c.speed || 1.0 })
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error('TTS HTTP ' + res.status + '：' + t.replace(/\s+/g, ' ').slice(0, 160)); });
        return res.arrayBuffer();
      }).then(function (buf) {
        var v = self.validateAudio(buf, 'mp3');
        if (!v.ok) throw new Error('MP3 校验失败：' + v.reason);
        return { size: buf.byteLength, type: 'audio/mpeg', durationSec: null };
      });
    },
    _decodeHexOrBase64: function (str) {
      var s = String(str).trim();
      try {
        if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length > 200) {
          var u2 = new Uint8Array(s.length / 2);
          for (var k = 0; k < u2.length; k++) u2[k] = parseInt(s.substr(k * 2, 2), 16);
          var a2 = String.fromCharCode(u2[0], u2[1], u2[2] || 0);
          if (a2.slice(0, 3) === 'ID3' || (u2[0] === 0xFF && (u2[1] & 0xE0) === 0xE0)) return u2;
        }
      } catch (e) { }
      try {
        var bin = atob(s);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        var ascii = String.fromCharCode(u8[0], u8[1], u8[2] || 0);
        if (ascii.slice(0, 3) === 'ID3' || (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0)) return u8;
      } catch (e) { }
      return null;
    }
  };

  window.AgentShared = {
    NS_KEY: NS_KEY,
    load: load,
    save: save,
    AI: AI,
    Voice: Voice,
    TTS: TTS,
    Data: Data,
    isAudioUploadAllowed: function () { return !!load().privacy.audioUpload; }
  };
})();