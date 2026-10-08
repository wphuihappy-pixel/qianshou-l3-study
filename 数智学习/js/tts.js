/**
 * 数智学习 · TTS Provider Adapter + 异步音频任务
 * ============================================================
 * 原则：
 *  1. 可替换 Provider：OpenAI 兼容 /audio/speech、MiniMax /v1/t2a_v2，
 *     均由用户在设置中配置 base_url + key（密钥只存本机浏览器）。
 *  2. 真实编码文件：MP3 必须通过云端合成返回真实音频流并校验文件头；
 *     WAV 由本机解码 MP3 重编码（44 字节头 + PCM16），绝不"只改扩展名"。
 *  3. 异步任务：排队/运行/完成/失败/取消，失败记录原因，可重试；
 *     幂等：相同(课+段+脚本版本+音色+语速+格式)不重复调用。
 *  4. CORS 边界（诚实声明）：浏览器直连第三方 TTS 可能被跨域拦截，
 *     失败时给出明确原因与"本地代理"建议，绝不降级伪造音频文件。
 * ============================================================
 */
(function () {
  'use strict';
  if (window.SZTTS) return;

  var CFG_KEY = 'szn_tts_config';
  var DEFAULT = {
    enabled: false,
    provider: 'minimax',       /* minimax（真人感 AI 语音，默认）| openai 兼容 */
    baseUrl: '',                /* MiniMax 官方：https://api.minimaxi.com */
    apiKey: '',
    model: '',                 /* minimax: speech-2.8-hd / speech-2.6-hd / speech-02-hd / *-turbo */
    voice: '',                 /* minimax: 如 male-qn-qingse；openai: alloy 等 */
    speed: 1.0,
    minimaxGroupId: ''
  };

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT));
      return Object.assign({}, DEFAULT, JSON.parse(raw));
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULT)); }
  }
  function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); return true; } catch (e) { return false; }
  }

  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /* 地址智能归一化：MiniMax 需要根域名（自动去掉误填的 /v1）；OpenAI 兼容需要以 /v1 结尾（自动补上） */
  function normalizeBase(provider, url) {
    var u = String(url || '').trim().replace(/\/+$/, '');
    if (provider === 'minimax') return u.replace(/\/v1$/, '');
    if (!/\/v\d+$/.test(u)) u += '/v1';
    return u;
  }

  /* 解析 JSON 响应；非 JSON（如 404 page not found）时给说人话的错误 */
  function readJsonResp(res) {
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
  }

  /* ---------- 文件头校验（真实编码，拒绝伪造/损坏文件） ---------- */
  function validateAudio(arrayBuffer, format) {
    var u8 = new Uint8Array(arrayBuffer.slice(0, 16));
    var ascii = '';
    for (var i = 0; i < u8.length; i++) ascii += String.fromCharCode(u8[i]);
    if (format === 'mp3') {
      var hasId3 = ascii.slice(0, 3) === 'ID3';
      var hasSync = (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0);
      if (hasId3 || hasSync) return { ok: true, header: hasId3 ? 'ID3' : 'MPEG-sync' };
      return { ok: false, header: ascii.slice(0, 8), reason: 'MP3 文件头缺失（应为 ID3 或 MPEG 帧同步），文件可能损坏或非真实音频' };
    }
    if (format === 'wav') {
      if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WAVE') return { ok: true, header: 'RIFF/WAVE' };
      return { ok: false, header: ascii.slice(0, 8), reason: 'WAV 文件头缺失（应为 RIFF/WAVE）' };
    }
    return { ok: false, reason: '未知格式' };
  }

  /* ---------- Provider 调用（返回 {blob, durationSec, origin}） ---------- */
  function synthesizeOnce(text, opts) {
    var c = loadCfg();
    if (!c.enabled || !c.baseUrl || !c.apiKey) {
      return Promise.reject(new Error('TTS 未配置：请在「音频与数据」中填写 Provider 地址与密钥'));
    }
    var base = normalizeBase(c.provider, c.baseUrl);
    var ctrl = (opts && opts.abort) || null;
    var wantFormat = (opts && opts.format) === 'wav' ? 'wav' : 'mp3';

    if (c.provider === 'minimax') {
      /* MiniMax T2A v2（官方文档：hex 编码返回、base_resp 状态码、可直出原生 wav） */
      var url2 = base + '/v1/t2a_v2';
      var body2 = {
        model: c.model || 'speech-2.8-hd',
        text: String(text).slice(0, 9900),
        stream: false,
        voice_setting: {
          voice_id: c.voice || 'male-qn-qingse',
          speed: c.speed || 1.0, vol: 1, pitch: 0
        },
        audio_setting: {
          sample_rate: 32000, bitrate: 128000,
          format: wantFormat, channel: 1
        },
        subtitle_enable: false
      };
      return fetch(url2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
        body: JSON.stringify(body2),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (!res.ok && res.status !== 200) {
          /* 非 2xx：先尝试读 base_resp 状态码，读不出 JSON 则报“说人话”错误 */
          return readJsonResp(res).then(function (j) {
            if (j.base_resp && j.base_resp.status_code !== 0) {
              throw new Error('MiniMax T2A 状态码 ' + j.base_resp.status_code + '：' + (j.base_resp.status_msg || '未知错误'));
            }
            throw new Error('MiniMax TTS HTTP ' + res.status);
          });
        }
        return readJsonResp(res);
      }).then(function (j) {
        if (j.base_resp && j.base_resp.status_code !== 0) {
          throw new Error('MiniMax T2A 状态码 ' + j.base_resp.status_code + '：' + (j.base_resp.status_msg || '未知错误'));
        }
        var audio = j && j.data && (j.data.audio || j.audio);
        if (!audio) throw new Error('MiniMax TTS 返回缺少 audio 字段');
        var bytes = tryDecodeHexOrBase64(audio);
        if (!bytes) throw new Error('MiniMax TTS 音频解码失败（hex/base64 均无效）');
        var v = validateAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), wantFormat);
        if (!v.ok) throw new Error('MiniMax TTS ' + wantFormat.toUpperCase() + ' 校验失败：' + v.reason);
        var durMs = (j.extra_info && j.extra_info.audio_length) ? j.extra_info.audio_length : null;
        return {
          blob: new Blob([bytes], { type: wantFormat === 'wav' ? 'audio/wav' : 'audio/mpeg' }),
          durationSec: durMs ? durMs / 1000 : null,
          origin: 'cloud-native',
          extra: j.extra_info || {}
        };
      });
    }

    /* OpenAI 兼容 POST /audio/speech -> 真实 mp3 流（wav 由本机重编码） */
    var url = base + '/audio/speech';
    var body = {
      model: c.model || 'tts-1',
      input: text,
      voice: c.voice || 'alloy',
      response_format: 'mp3',
      speed: c.speed || 1.0
    };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = 'HTTP ' + res.status;
          try { var j = JSON.parse(t); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) { msg += '：' + t.slice(0, 180); }
          throw new Error('TTS ' + msg);
        });
      }
      return res.arrayBuffer().then(function (buf) {
        var v = validateAudio(buf, 'mp3');
        if (!v.ok) throw new Error('TTS 返回的 MP3 校验失败：' + v.reason);
        return { blob: new Blob([buf], { type: 'audio/mpeg' }), durationSec: null, origin: 'cloud-native' };
      });
    });
  }
  /* 官方文档：data.audio 为 hex 编码；先 hex，失败再兼容 base64（部分网关） */
  function tryDecodeHexOrBase64(str) {
    var s = String(str).trim();
    try {
      if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length > 200) {
        var u2 = new Uint8Array(s.length / 2);
        for (var k = 0; k < u2.length; k++) u2[k] = parseInt(s.substr(k * 2, 2), 16);
        var a2 = String.fromCharCode(u2[0], u2[1], u2[2] || 0);
        var isMp3 = (a2.slice(0, 3) === 'ID3' || (u2[0] === 0xFF && (u2[1] & 0xE0) === 0xE0));
        var isWav = (u2.length > 12 && String.fromCharCode(u2[0], u2[1], u2[2], u2[3]) === 'RIFF' && String.fromCharCode(u2[8], u2[9], u2[10], u2[11]) === 'WAVE');
        if (isMp3 || isWav) return u2;
      }
    } catch (e) { /* 继续尝试 base64 */ }
    try {
      var bin = atob(s);
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      var ascii = String.fromCharCode(u8[0], u8[1], u8[2] || 0);
      if (ascii.slice(0, 3) === 'ID3' || (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0) || ascii.slice(0, 4) === 'RIFF') return u8;
    } catch (e) { /* 两种都失败 */ }
    return null;
  }

  /* ---------- MP3 -> WAV（真实重编码：解码为 PCM 再写 44 字节头） ---------- */
  function mp3ToWav(mp3Blob) {
    return mp3Blob.arrayBuffer().then(function (buf) {
      return new Promise(function (resolve, reject) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { reject(new Error('本浏览器不支持 WebAudio，无法转换 WAV')); return; }
        var ctx = new AC();
        ctx.decodeAudioData(buf.slice(0), function (audio) {
          try {
            var wav = encodeWav(audio);
            ctx.close();
            resolve(wav);
          } catch (e) { ctx.close(); reject(e); }
        }, function (err) { ctx.close(); reject(new Error('MP3 解码失败，无法转换 WAV（' + (err && err.message || '解码错误') + '）')); });
      });
    });
  }

  function encodeWav(audio) {
    var nCh = audio.numberOfChannels, sr = audio.sampleRate, len = audio.length;
    var bytesPerSample = 2, blockAlign = nCh * bytesPerSample;
    var dataSize = len * blockAlign;
    var ab = new ArrayBuffer(44 + dataSize);
    var dv = new DataView(ab);
    function wstr(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, nCh, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, dataSize, true);
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(audio.getChannelData(c));
    var off = 44;
    for (var i2 = 0; i2 < len; i2++) {
      for (var c2 = 0; c2 < nCh; c2++) {
        var s = Math.max(-1, Math.min(1, chs[c2][i2]));
        dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  function audioDuration(blob) {
    return blob.arrayBuffer().then(function (buf) {
      return new Promise(function (resolve) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { resolve(null); return; }
        var ctx = new AC();
        ctx.decodeAudioData(buf.slice(0), function (a) { ctx.close(); resolve(a.duration); },
          function () { ctx.close(); resolve(null); });
      });
    });
  }

  /* ---------- 合并整课分段音频为单个 MP3（本机解码+lamejs 编码，无新增出网） ---------- */
  function decodeAudioBlob(blob) {
    return blob.arrayBuffer().then(function (buf) {
      return new Promise(function (resolve, reject) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { reject(new Error('本浏览器不支持 WebAudio，无法合并')); return; }
        var ctx = new AC();
        ctx.decodeAudioData(buf.slice(0), function (audio) { ctx.close(); resolve(audio); },
          function () { ctx.close(); reject(new Error('音频解码失败，无法合并')); });
      });
    });
  }

  function resampleBuffer(audio, targetRate) {
    if (audio.sampleRate === targetRate) return Promise.resolve(audio);
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error('本浏览器不支持重采样（各段采样率不一致）'));
    var len = Math.max(1, Math.round(audio.length * targetRate / audio.sampleRate));
    var off = new OAC(audio.numberOfChannels, len, targetRate);
    var src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering().then(function (rendered) { return rendered; });
  }

  function floatToPcm16(f32) {
    var n = f32.length, i16 = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return i16;
  }

  /* 合并整课已完成的分段音频为单个 MP3；段优先用云端 MP3，缺失时回退 WAV；返回 {blob, durationSec, segs, skipped} */
  function mergeLessonAudio(lessonId) {
    DB = window.SZDB;
    if (!window.lamejs || !window.lamejs.Mp3Encoder) {
      return Promise.reject(new Error('MP3 编码引擎（vendor/lame.min.js）未加载，请刷新页面后重试'));
    }
    return Promise.all([DB.byIndex('audioFiles', 'lessonId', lessonId), DB.get('lessons', lessonId)]).then(function (r) {
      var files = r[0], lesson = r[1];
      var ok = files.filter(function (f) { return f.status === 'ok'; });
      if (!ok.length) return Promise.reject(new Error('没有可合并的音频（先成功生成）'));
      /* 按段收集 mp3/wav；段优先 MP3，无 MP3 回退 WAV */
      var bySeg = {};
      ok.forEach(function (f) {
        if (!bySeg[f.segIndex]) bySeg[f.segIndex] = {};
        bySeg[f.segIndex][f.format] = f;
      });
      var segs = Object.keys(bySeg).map(Number).sort(function (a, b) { return a - b; });
      /* 预期段数：以教案 audioScript 段数为准（缺段才可判定）。
         教案若为旧版"整课单大段"，先按 app.js 暴露的 splitAudioScript 拆成实际段数，
         否则合并会漏掉已生成的后续段（只输出第 1 段）。教案异常时按已存在段的最大下标兜底 */
      var splitFn = window.SZSplitAudioScript || function (s) { return s; };
      var audioScript = lesson && lesson.audioScript ? splitFn(lesson.audioScript) : null;
      var nSeg = (audioScript && audioScript.length) || (segs.length ? segs[segs.length - 1] + 1 : 0);
      var expected = [];
      for (var k = 0; k < nSeg; k++) expected.push(k);
      var decoded = [], skipped = [];
      var chain = Promise.resolve();
      expected.forEach(function (idx) {
        chain = chain.then(function () {
          var f = bySeg[idx] && (bySeg[idx].mp3 || bySeg[idx].wav);
          if (!f) { skipped.push(idx); return; }
          /* 合并前先做文件头校验（与单文件下载同一把关），校验不过视为缺段 */
          return f.blob.arrayBuffer().then(function (buf) {
            var v = validateAudio(buf, f.format);
            if (!v.ok) { skipped.push(idx); return; }
            return decodeAudioBlob(f.blob).then(function (audio) {
              decoded.push({ idx: idx, audio: audio });
            }).catch(function () { skipped.push(idx); });
          });
        });
      });
      return chain.then(function () {
        if (!decoded.length) return Promise.reject(new Error('所有分段音频都无法解码，无法合并'));
        /* 统一采样率（以第 1 段为准），并取第 1 声道（合成配置 channel:1） */
        var targetRate = decoded[0].audio.sampleRate;
        var rchain = Promise.resolve();
        decoded.forEach(function (d) {
          if (d.audio.sampleRate !== targetRate) {
            rchain = rchain.then(function () { return resampleBuffer(d.audio, targetRate); })
              .then(function (a) { d.audio = a; });
          }
        });
        return rchain.then(function () {
          var totalLen = 0;
          decoded.forEach(function (d) { totalLen += d.audio.length; });
          var merged = new Float32Array(totalLen);
          var off = 0;
          decoded.forEach(function (d) {
            var ch = d.audio.getChannelData(0);
            merged.set(ch, off);
            off += ch.length;
          });
          /* lamejs 编码 MP3（单声道、128kbps、目标采样率） */
          var enc = new lamejs.Mp3Encoder(1, targetRate, 128);
          var pcm = floatToPcm16(merged);
          var mp3Data = [];
          var BLOCK = 1152, pos = 0;
          while (pos < pcm.length) {
            var take = Math.min(BLOCK, pcm.length - pos);
            var block;
            if (take === BLOCK) {
              block = pcm.subarray(pos, pos + BLOCK);
            } else {
              /* 末块不足 1152：零填充到整块（lame 内部按整块处理，缺帧会触发异常） */
              block = new Int16Array(BLOCK);
              block.set(pcm.subarray(pos, pcm.length));
            }
            var buf = enc.encodeBuffer(block);
            if (buf && buf.length) mp3Data.push(new Uint8Array(buf));
            pos += BLOCK;
          }
          var end = enc.flush();
          if (end && end.length) mp3Data.push(new Uint8Array(end));
          var blob = new Blob(mp3Data, { type: 'audio/mpeg' });
          return {
            blob: blob,
            size: blob.size,
            durationSec: Math.round(totalLen / targetRate),
            sampleRate: targetRate,
            segs: segs.length,
            skipped: skipped
          };
        });
      });
    });
  }

  /* ---------- 异步任务队列（幂等/重试/取消/失败原因） ---------- */
  var DB = null; /* window.SZDB，由 app.js 保证先加载 db.js */

  function makeIdempotencyKey(lessonId, segIndex, scriptVersion, voice, speed, format, provider) {
    return djb2([lessonId, segIndex, scriptVersion, voice, speed, format, provider].join('|'));
  }

  /* 入队；若相同 key 任务已 done 且产物存在 -> 复用（幂等，不重复调用云） */
  function enqueue(lessonId, segIndex, script, scriptVersion, wantWav, onUpdate) {
    DB = window.SZDB;
    var c = loadCfg();
    var key = makeIdempotencyKey(lessonId, segIndex, scriptVersion, c.voice, c.speed, 'mp3', c.provider);
    return DB.byIndex('audioTasks', 'idempotencyKey', key).then(function (exist) {
      var doneTask = exist.find(function (t) { return t.status === 'done'; });
      if (doneTask) {
        return DB.byIndex('audioFiles', 'taskId', doneTask.id).then(function (files) {
          if (files.length && onUpdate) onUpdate(doneTask, files);
          return doneTask;
        });
      }
      var task = {
        id: DB.newId('at'),
        lessonId: lessonId,
        segIndex: segIndex,
        script: script,
        scriptVersion: scriptVersion,
        wantWav: !!wantWav,
        status: 'queued',
        attempts: 0,
        error: '',
        idempotencyKey: key,
        provider: c.provider,
        voice: c.voice,
        speed: c.speed,
        createdAt: DB.nowIso(),
        updatedAt: DB.nowIso()
      };
      return DB.put('audioTasks', task).then(function () {
        if (onUpdate) onUpdate(task, []);
        return task;
      });
    });
  }

  /* 顺序执行队列内所有 queued 任务；每步重读以支持取消；返回执行摘要 */
  function runQueue(onUpdate, isCancelled) {
    DB = window.SZDB;
    var summary = { done: 0, failed: 0, cancelled: 0 };
    function next() {
      if (isCancelled && isCancelled()) return Promise.resolve(summary);
      return DB.getAll('audioTasks').then(function (all) {
        var queued = all.filter(function (t) { return t.status === 'queued'; })
          .sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt); });
        if (!queued.length) return summary;
        var t = queued[0];
        return execOne(t, onUpdate).then(function (st) {
          summary[st]++;
          return next();
        });
      });
    }
    return next();
  }

  function execOne(task, onUpdate) {
    var c = loadCfg();
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    task.status = 'running'; task.updatedAt = DB.nowIso();
    return DB.put('audioTasks', task).then(function () {
      if (onUpdate) onUpdate(task, []);
      return synthesizeOnce(task.script, { abort: ctrl, format: 'mp3' });
    }).then(function (mp3Res) {
      /* mp3Res = {blob, durationSec, origin}，MP3 已过文件头校验 */
      var mp3 = mp3Res.blob;
      var durP = mp3Res.durationSec
        ? Promise.resolve(mp3Res.durationSec)
        : audioDuration(mp3);
      return durP.then(function (dur) {
        var fMp3 = {
          id: DB.newId('af'), taskId: task.id, lessonId: task.lessonId, segIndex: task.segIndex,
          format: 'mp3', mime: 'audio/mpeg', blob: mp3, size: mp3.size,
          durationSec: dur, scriptVersion: task.scriptVersion,
          provider: task.provider, voice: task.voice, speed: task.speed,
          audioVersion: 1, createdAt: DB.nowIso(), status: 'ok', wavSource: 'cloud-native'
        };
        var saves = [DB.put('audioFiles', fMp3)];
        /* WAV：MiniMax 云端直出原生 WAV（第二次真实合成）；失败回退本机从 MP3 重编码 */
        var wavP = task.wantWav
          ? synthesizeOnce(task.script, { abort: ctrl, format: 'wav' }).then(function (wavRes) {
              var fWav = {
                id: DB.newId('af'), taskId: task.id, lessonId: task.lessonId, segIndex: task.segIndex,
                format: 'wav', mime: 'audio/wav', blob: wavRes.blob, size: wavRes.blob.size,
                durationSec: wavRes.durationSec || dur, scriptVersion: task.scriptVersion,
                provider: task.provider, voice: task.voice, speed: task.speed,
                audioVersion: 1, createdAt: DB.nowIso(), status: 'ok', wavSource: 'cloud-native'
              };
              return DB.put('audioFiles', fWav);
            }).catch(function (cloudErr) {
              /* 云端 WAV 不可用（如 OpenAI 兼容分支不支持 wav）→ 本机真实重编码（非改扩展名） */
              task.wavFallback = '云端未直出 WAV（' + (cloudErr && cloudErr.message || '原因未知') + '），已由本机从 MP3 重编码';
              return mp3ToWav(mp3).then(function (wav) {
                var fWav2 = {
                  id: DB.newId('af'), taskId: task.id, lessonId: task.lessonId, segIndex: task.segIndex,
                  format: 'wav', mime: 'audio/wav', blob: wav, size: wav.size,
                  durationSec: dur, scriptVersion: task.scriptVersion,
                  provider: task.provider, voice: task.voice, speed: task.speed,
                  audioVersion: 1, createdAt: DB.nowIso(), status: 'ok', wavSource: 'local-reencode'
                };
                return DB.put('audioFiles', fWav2);
              });
            }).catch(function (e) {
              /* WAV 全部失败不毁掉 MP3 成果，单独记录在任务上 */
              task.wavError = e.message;
              return null;
            })
          : Promise.resolve(null);
        return Promise.all([Promise.all(saves), wavP]).then(function () {
          task.status = 'done'; task.updatedAt = DB.nowIso(); task.error = '';
          return DB.put('audioTasks', task).then(function () {
            return DB.byIndex('audioFiles', 'taskId', task.id).then(function (files) {
              if (onUpdate) onUpdate(task, files);
              return 'done';
            });
          });
        });
      });
    }).catch(function (err) {
      task.attempts = (task.attempts || 0) + 1;
      task.error = (err && err.message) ? err.message : String(err);
      /* 取消 vs 失败 */
      if (task.status === 'cancelled') {
        return DB.put('audioTasks', task).then(function () { return 'cancelled'; });
      }
      if (task.attempts >= 3) {
        task.status = 'failed';
      } else {
        task.status = 'queued'; /* 仍会重试 */
      }
      task.updatedAt = DB.nowIso();
      return DB.put('audioTasks', task).then(function () {
        if (onUpdate) onUpdate(task, []);
        return 'failed';
      });
    });
  }

  function cancel(taskId) {
    return DB.get('audioTasks', taskId).then(function (t) {
      if (!t) return false;
      if (t.status === 'done') return false;
      t.status = 'cancelled'; t.updatedAt = DB.nowIso();
      return DB.put('audioTasks', t).then(function () { return true; });
    });
  }

  function retry(taskId, onUpdate) {
    return DB.get('audioTasks', taskId).then(function (t) {
      if (!t) return null;
      t.status = 'queued'; t.attempts = 0; t.error = ''; t.updatedAt = DB.nowIso();
      return DB.put('audioTasks', t).then(function () {
        if (onUpdate) onUpdate(t, []);
        return t;
      });
    });
  }

  /* ---------- 下载 ---------- */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  window.SZTTS = {
    loadCfg: loadCfg,
    saveCfg: saveCfg,
    synthesizeOnce: synthesizeOnce,
    validateAudio: validateAudio,
    mp3ToWav: mp3ToWav,
    audioDuration: audioDuration,
    enqueue: enqueue,
    runQueue: runQueue,
    cancel: cancel,
    retry: retry,
    mergeLessonAudio: mergeLessonAudio,
    downloadBlob: downloadBlob,
    testConnection: function () {
      return synthesizeOnce('测试音频合成。', {}).then(function (r) {
        return { size: r.blob.size, type: r.blob.type, durationSec: r.durationSec, origin: r.origin };
      });
    },
    /* 试听：用传入的临时配置合成一句样张，不修改 localStorage；复用全部校验/解码逻辑 */
    previewVoice: function (cfg, text) {
      var saved = loadCfg();
      saveCfg(cfg);
      return synthesizeOnce(text || '你好，这是当前音色的试听样张，听起来合适就可以保存了。', {}).then(function (r) {
        saveCfg(saved); /* 还原 */
        return r;
      }).catch(function (e) {
        saveCfg(saved); /* 失败也还原 */
        throw e;
      });
    }
  };
})();
