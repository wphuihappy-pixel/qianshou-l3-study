/**
 * ECTTS · 语音合成适配层
 * 双通道：
 *   1) 系统语音 speechSynthesis（默认）——快、免费、离线；对话教练回复用它（低延迟）
 *   2) MiniMax T2A 真人感（premium=true 时）——听力训练、跟读示范用；
 *      复用千手统一设置中心 TTS 配置（szn_tts_config，与数智学习共用）。
 * 合成结果做内存缓存，同一句不重复消耗字符额度。
 * 文件头校验：MP3 须 ID3/MPEG 同步头，校验不过不播放，绝不伪造成功。
 */
(function () {
  'use strict';
  if (window.ECTTS) return;

  var cache = new Map();       /* text -> {blob, url} */
  var CACHE_MAX = 24;
  var audioEl = null;

  function sysSpeak(text, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (!('speechSynthesis' in window)) { reject(new Error('浏览器不支持语音朗读')); return; }
      try {
        speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(String(text));
        u.lang = (opts && opts.lang) || 'en-US';
        u.rate = (opts && opts.rate) || 1.0;
        var voices = speechSynthesis.getVoices() || [];
        var pick = null;
        for (var i = 0; i < voices.length; i++) {
          if (voices[i].lang && voices[i].lang.indexOf('en-US') === 0) { pick = voices[i]; break; }
        }
        if (pick) u.voice = pick;
        u.onend = function () { resolve(); };
        u.onerror = function (e) { reject(new Error('朗读失败：' + (e.error || '未知'))); };
        speechSynthesis.speak(u);
        /* 某些浏览器 getVoices 异步加载：首次可能空，不阻塞 */
      } catch (e) { reject(e); }
    });
  }

  function validateMp3(bytes) {
    var a = String.fromCharCode(bytes[0], bytes[1], bytes[2] || 0);
    if (a.slice(0, 3) === 'ID3') return true;
    return (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0);
  }

  function decodeHex(str) {
    var s = String(str || '').trim();
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0 || s.length < 200) return null;
    var u8 = new Uint8Array(s.length / 2);
    for (var k = 0; k < u8.length; k++) u8[k] = parseInt(s.substr(k * 2, 2), 16);
    return validateMp3(u8) ? u8 : null;
  }

  function ttsConfig() {
    return window.AgentShared ? AgentShared.TTS.loadCfg() : { enabled: false, provider: 'minimax', baseUrl: '', apiKey: '', model: '', voice: '', speed: 1.0 };
  }

  function ttsReady() {
    var c = ttsConfig();
    return !!(c.enabled && c.baseUrl && c.apiKey);
  }

  /* MiniMax T2A 同步合成（英语文本），返回可播放 URL */
  function synthUrl(text, rate) {
    if (cache.has(text)) return Promise.resolve(cache.get(text).url);
    var c = ttsConfig();
    var base = String(c.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    if (!base || !c.apiKey) return Promise.reject(new Error('TTS 未配置：请在千手首页「设置中心 → AI语音合成」填写 MiniMax 地址与密钥'));
    var body = {
      model: c.model || 'speech-2.8-hd',
      text: String(text),
      stream: false,
      output_format: 'hex',
      voice_setting: {
        voice_id: c.voice || 'English_Translator_Female',
        speed: rate || c.speed || 1.0,
        vol: 1.0,
        pitch: 0
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      subtitle_enable: false,
      language_boost: 'English'
    };
    return fetch(base + '/v1/t2a_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) {
          throw new Error('TTS 返回的不是 JSON（HTTP ' + res.status + '）：请检查地址是否为 https://api.minimax.cn');
        }
        if (j.base_resp && j.base_resp.status_code !== 0) {
          throw new Error('MiniMax T2A 状态码 ' + j.base_resp.status_code + '：' + (j.base_resp.status_msg || '未知错误'));
        }
        var hex = j.data && j.data.audio;
        if (!hex) throw new Error('返回缺少 audio 字段');
        var u8 = decodeHex(hex);
        if (!u8) throw new Error('MP3 文件头校验失败，拒绝播放（不为失败伪造音频）');
        var url = URL.createObjectURL(new Blob([u8], { type: 'audio/mpeg' }));
        if (cache.size >= CACHE_MAX) {
          var oldest = cache.keys().next().value;
          try { URL.revokeObjectURL(cache.get(oldest).url); } catch (e) {}
          cache.delete(oldest);
        }
        cache.set(text, { url: url });
        return url;
      });
    });
  }

  function playUrl(url) {
    return new Promise(function (resolve, reject) {
      if (!audioEl) audioEl = new Audio();
      audioEl.src = url;
      audioEl.onended = function () { resolve(); };
      audioEl.onerror = function () { reject(new Error('音频播放失败')); };
      audioEl.play().catch(function (e) { reject(new Error('播放被浏览器拦截：' + (e.message || e))); });
    });
  }

  /**
   * 统一朗读入口
   * opts: { premium:boolean 是否用 MiniMax 真人感（默认 false 用系统语音）,
   *         rate:number 语速(0.6–1.4), lang:'en-US' }
   * 返回 Promise（播完 resolve）；premium 失败自动回退系统语音并提示 note。
   */
  function say(text, opts) {
    opts = opts || {};
    var t = String(text || '').trim();
    if (!t) return Promise.resolve();
    if (opts.premium && ttsReady()) {
      return synthUrl(t, opts.rate).then(function (url) { return playUrl(url); })
        .catch(function (err) {
          if (window.console) console.warn('[ECTTS] T2A 失败，回退系统语音：', err.message);
          return sysSpeak(t, opts).catch(function () { /* 静默：朗读失败不阻断学习流 */ });
        });
    }
    return sysSpeak(t, opts).catch(function () {});
  }

  function stop() {
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {}
    try { if (audioEl) { audioEl.pause(); audioEl.src = ''; } } catch (e) {}
  }

  window.ECTTS = {
    say: say, stop: stop,
    ttsReady: ttsReady,
    ttsConfig: ttsConfig
  };
})();
