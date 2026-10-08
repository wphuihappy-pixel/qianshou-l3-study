/**
 * 数智学习 · 文档解析层
 * ============================================================
 * 职责：
 *  1. 安全校验：扩展名与真实文件头(magic bytes)双验证，拒绝伪装格式；
 *     压缩包内宏(vbaProject.bin)只隔离不解析；可疑可执行条目直接拒绝。
 *  2. 解析为统一文档模型：pages[].blocks[]（heading/para/table/image占位），
 *     每页/段/幻灯片带稳定锚点，供教案引用与批注回链。
 *  3. 输入内容一律当作数据：检测疑似"指令型文本"仅提示，绝不执行。
 * 依赖（CDN，需联网加载一次；离线后浏览器缓存仍可用）：
 *  - pdf.js   (window.pdfjsLib)   PDF
 *  - mammoth  (window.mammoth)     DOCX
 *  - JSZip    (window.JSZip)       PPTX（OOXML zip 解包）
 * ============================================================
 */
(function () {
  'use strict';
  if (window.SZParse) return;

  var MAX_SIZE = 150 * 1024 * 1024; /* 150MB 上限，超大文件拒绝并说明 */

  /* ---------- 疑似提示注入模式（只提示，不执行任何文件内指令） ---------- */
  var INJECTION_PATTERNS = [
    /ignore (all )?(previous|prior|above) (instructions?|prompts?)/i,
    /disregard (all )?(previous|prior|above)/i,
    /system prompt/i,
    /你(现在)?是(一个)?(新的|不同)?(角色|助手|系统)/,
    /忽略(之前|以上|上面|先前)(的)?(所有)?(指令|提示|要求|内容)/,
    /请?(执行|运行)(以下|下列)(命令|脚本|代码)/,
    /<\s*script\b/i,
    /javascript\s*:/i,
    /on(click|error|load)\s*=/i
  ];

  function scanInjection(text) {
    var hits = [];
    if (!text) return hits;
    INJECTION_PATTERNS.forEach(function (re) {
      var m = text.match(re);
      if (m) hits.push(String(m[0]).slice(0, 40));
    });
    return hits;
  }

  /* ---------- 头部字节读取 ---------- */
  function headBytes(arrayBuffer, n) {
    var u8 = new Uint8Array(arrayBuffer, 0, Math.min(n, arrayBuffer.byteLength));
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /* ---------- 安全校验 ---------- */
  /* 返回 {ok, kind, ext, reason} kind: pdf|docx|pptx|html */
  function checkFile(file) {
    var name = file.name || '';
    var ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    var kind = (ext === 'htm') ? 'html' : ext;
    if (['pdf', 'docx', 'pptx', 'html'].indexOf(kind) < 0) {
      return { ok: false, reason: '不支持的类型：' + (ext || '未知') + '（仅支持 PDF / DOCX / PPTX / HTML）' };
    }
    if (file.size > MAX_SIZE) {
      return { ok: false, reason: '文件过大（' + Math.round(file.size / 1024 / 1024) + 'MB，上限 150MB）' };
    }
    if (file.size === 0) {
      return { ok: false, reason: '文件为空' };
    }
    return { ok: true, kind: ext, ext: ext, needMagic: true };
  }

  function verifyMagic(kind, arrayBuffer) {
    if (kind === 'html') {
      /* HTML 无固定 magic 字节，软校验：首部应含 '<'（文本文件） */
      var h = headBytes(arrayBuffer, 256).trim();
      if (h.charAt(0) !== '<' && h.indexOf('<') < 0) return '内容不是 HTML 文本（未发现标签），已拒绝';
      return null;
    }
    var head = headBytes(arrayBuffer, 8);
    if (kind === 'pdf') {
      if (head.slice(0, 5) !== '%PDF-') return '文件头不是 PDF（%PDF-），疑似伪装格式，已拒绝';
      return null;
    }
    /* OOXML：docx/pptx 都是 zip，头两字节 PK\x03\x04 */
    if (!(head.charCodeAt(0) === 0x50 && head.charCodeAt(1) === 0x4B)) {
      return '文件头不是 OOXML 压缩包（PK），疑似伪装格式，已拒绝';
    }
    return null;
  }

  /* ---------- PDF 解析（pdf.js） ---------- */
  function parsePdf(arrayBuffer, onProgress) {
    if (!window.pdfjsLib) return Promise.reject(new Error('PDF 解析库未加载（vendor 目录缺失，请检查数智学习/vendor/）'));
    var data = new Uint8Array(arrayBuffer);
    var docP = window.pdfjsLib.getDocument({ data: data }).promise;
    return docP.then(function (pdf) {
      var pages = [];
      var total = pdf.numPages;
      var chain = Promise.resolve();
      for (var i = 1; i <= total; i++) {
        (function (num) {
          chain = chain.then(function () {
            return pdf.getPage(num).then(function (page) {
              return page.getTextContent().then(function (tc) {
                var blocks = pdfItemsToBlocks(tc.items);
                pages.push({ num: num, blocks: blocks });
                if (onProgress) onProgress('PDF 第 ' + num + '/' + total + ' 页', num / total);
              });
            });
          });
        })(i);
      }
      return chain.then(function () { return { pages: pages }; });
    });
  }

  /* items -> 行 -> 段落 */
  function pdfItemsToBlocks(items) {
    var lines = [];
    items.forEach(function (it) {
      if (!it.str) return;
      var y = Math.round(it.transform[5]);
      var line = null;
      for (var i = lines.length - 1; i >= 0; i--) {
        if (Math.abs(lines[i].y - y) <= 3) { line = lines[i]; break; }
      }
      if (!line) { line = { y: y, parts: [] }; lines.push(line); }
      line.parts.push({ x: it.transform[4], s: it.str });
    });
    lines.forEach(function (l) { l.parts.sort(function (a, b) { return a.x - b.x; }); l.text = l.parts.map(function (p) { return p.s; }).join(''); });
    /* 行间距判定：相邻行 y 差 > 22 视为段间空行 */
    var text = '';
    for (var j = 0; j < lines.length; j++) {
      text += lines[j].text;
      var gap = (j + 1 < lines.length) ? (lines[j].y - lines[j + 1].y) : 99;
      text += gap > 22 ? '\n\n' : '\n';
    }
    return splitToBlocks(text);
  }

  /* ---------- DOCX 解析（mammoth 优先；失败时自动切换内置 OOXML 兜底解析器） ---------- */
  function parseDocx(arrayBuffer, onProgress) {
    if (!window.mammoth) return parseDocxFallback(arrayBuffer, onProgress);
    return window.mammoth.convertToHtml({ arrayBuffer: arrayBuffer }).then(function (r) {
      var warnings = (r.messages || []).map(function (m) { return String(m.message || m); });
      if (onProgress) onProgress('解析 DOCX 内容', .6);
      var body = new DOMParser().parseFromString(r.value, 'text/html').body;
      var blocks = [];
      var paraIdx = 0;
      Array.prototype.forEach.call(body.childNodes, function (node) {
        var tag = String(node.nodeName || '').toLowerCase();
        var txt = (node.textContent || '').trim();
        if (!txt && tag !== 'table') return;
        if (/^h[1-6]$/.test(tag)) {
          blocks.push({ type: 'heading', level: +tag.slice(1), text: txt, anchor: { para: blocks.length } });
        } else if (tag === 'table') {
          var rows = [];
          Array.prototype.forEach.call(node.querySelectorAll('tr'), function (tr) {
            rows.push(Array.prototype.map.call(tr.querySelectorAll('td,th'), function (td) { return td.textContent.trim(); }));
          });
          /* 表格也要有扁平文本（能力标准等大量内容在表格里，否则全文检索为空） */
          var tableText = rows.map(function (r) { return r.filter(Boolean).join(' | '); }).filter(Boolean).join('\n');
          blocks.push({ type: 'table', rows: rows, text: tableText, anchor: { para: blocks.length } });
        } else {
          blocks.push({ type: 'para', text: txt, anchor: { para: blocks.length } });
        }
        paraIdx++;
      });
      if (onProgress) onProgress('DOCX 解析完成', 1);
      /* DOCX 无稳定分页：单 flow 页 + 段锚点（界面会明确标注锚点类型） */
      return {
        pages: [{ num: 1, blocks: blocks }],
        warnings: warnings,
        anchorType: 'para',
        pageNote: 'DOCX 无固定分页，锚点为段落序号'
      };
    }).catch(function (err) {
      /* mammoth 对超大/WPS 特殊结构文档可能内部崩溃（如 reading 'children'）；
         切内置兜底：JSZip 解 OOXML 直接提取段落/标题/表格，保证文本可用 */
      return parseDocxFallback(arrayBuffer, onProgress).then(function (r) {
        r.warnings.push('高级解析器不适用于该文档（' + ((err && err.message) || String(err)).slice(0, 80) + '），已用内置解析器完成提取');
        return r;
      });
    });
  }

  /* ---------- DOCX 内置兜底解析（不依赖第三方：JSZip + DOMParser 直读 word/document.xml） ---------- */
  function parseDocxFallback(arrayBuffer, onProgress) {
    if (!window.JSZip) return Promise.reject(new Error('DOCX 解析库未加载（vendor 目录缺失，请检查数智学习/vendor/）'));
    if (onProgress) onProgress('DOCX 兜底解析：解包 OOXML', .3);
    return JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var f = zip.file('word/document.xml');
      if (!f) throw new Error('DOCX 结构异常：未找到 word/document.xml');
      return f.async('string').then(function (xml) {
        if (onProgress) onProgress('DOCX 兜底解析：读取正文', .6);
        var doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('word/document.xml 不是合法 XML');
        var body = doc.getElementsByTagName('w:body')[0];
        if (!body) throw new Error('DOCX 缺少正文 body');
        var blocks = [];

        function paraTextOf(node) {
          /* 段落文本 = 其内所有 w:t 拼接（跳过制表符/换行细节，保底可用） */
          var ts = node.getElementsByTagName('w:t');
          var s = '';
          for (var i = 0; i < ts.length; i++) s += ts[i].textContent;
          return s.replace(/\s+/g, ' ').trim();
        }
        function headingLevelOf(pNode) {
          var styles = pNode.getElementsByTagName('w:pStyle');
          if (!styles.length) return 0;
          var v = styles[0].getAttribute('w:val') || styles[0].getAttribute('val') || '';
          var m = String(v).match(/^(?:heading)?\s*([1-6])$/i);
          if (m) return +m[1];
          if (/^title$/i.test(v)) return 1;
          return 0;
        }

        /* 顺序遍历 body 直接子节点：w:tbl → 表格；w:p / w:sdt 等 → 段落文本 */
        var skipTables = [];
        function inTable(el) {
          for (var i = 0; i < skipTables.length; i++) {
            if (skipTables[i] !== el && skipTables[i].contains(el)) return true;
          }
          return false;
        }
        Array.prototype.forEach.call(body.childNodes, function (node) {
          if (node.nodeType !== 1) return;
          if (inTable(node)) return;
          var tag = node.nodeName;
          if (tag === 'w:tbl') {
            var rows = [];
            Array.prototype.forEach.call(node.getElementsByTagName('w:tr'), function (tr) {
              if (inTable(tr) && tr.parentNode.nodeName === 'w:tbl') { /* 嵌套表行只归最内层 */ }
              var cells = [];
              Array.prototype.forEach.call(tr.getElementsByTagName('w:tc'), function (tc) {
                if (tc.parentNode.parentNode.nodeName === 'w:tc') return; /* 嵌套表格单元格跳过，避免重复 */
                cells.push(paraTextOf(tc));
              });
              rows.push(cells);
            });
            var tableText = rows.map(function (r) { return r.filter(Boolean).join(' | '); }).filter(Boolean).join('\n');
            if (tableText) {
              blocks.push({ type: 'table', rows: rows, text: tableText, anchor: { para: blocks.length } });
              skipTables.push(node);
            }
            return;
          }
          var txt = paraTextOf(node);
          if (!txt) return;
          var lv = (tag === 'w:p') ? headingLevelOf(node) : 0;
          blocks.push({
            type: lv ? 'heading' : 'para',
            level: lv,
            text: txt,
            anchor: { para: blocks.length }
          });
        });

        var totalLen = blocks.reduce(function (s, b) { return s + (b.text || '').length; }, 0);
        if (!totalLen) throw new Error('兜底解析未提取到文本（正文可能为空或全部为图片）');
        if (onProgress) onProgress('DOCX 兜底解析完成', 1);
        return {
          pages: [{ num: 1, blocks: blocks }],
          warnings: [],
          anchorType: 'para',
          pageNote: 'DOCX 无固定分页，锚点为段落序号'
        };
      });
    });
  }

  /* ---------- HTML 解析（DOMParser 惰性文档：script 不执行、资源不加载） ----------
   * 2026-10-06 更新：架构图类 HTML（如总装图.html）主体说明文字在 <script> 的 JS 数据对象里
   * （drillData 配置），原策略"脚本文本不提取"导致只提取到节点名、说明全丢。
   * 现改为：提取脚本字符串字面量中的中文文本用于检索（仍不执行脚本，安全不变）。 */
  function parseHtml(arrayBuffer, onProgress) {
    if (typeof DOMParser === 'undefined') return Promise.reject(new Error('当前环境不支持 DOMParser，无法解析 HTML'));
    /* 编码启发：utf-8 解码乱码多则按 gbk 重解（兼容中文旧页面） */
    var text = new TextDecoder('utf-8').decode(arrayBuffer);
    var bad = (text.match(/\uFFFD/g) || []).length;
    if (bad > 8 || (text.length && bad / text.length > 0.0005)) {
      try { text = new TextDecoder('gbk').decode(arrayBuffer); } catch (e) { /* 保 utf-8 结果 */ }
    }
    if (onProgress) onProgress('解析 HTML 结构', .5);
    var doc = new DOMParser().parseFromString(text, 'text/html');
    var warnings = [];

    /* 提取脚本里的字符串字面量中文文本（drillData 等配置内容；不执行脚本） */
    var scriptTexts = [];
    var scripts = doc.querySelectorAll('script');
    if (scripts.length) {
      var seen = {};
      var STR = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
      for (var si = 0; si < scripts.length && scriptTexts.length < 500; si++) {
        var js = scripts[si].textContent || '';
        /* 去掉注释后再提取字符串，减少噪音 */
        var jsClean = js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
        var m;
        while ((m = STR.exec(jsClean)) && scriptTexts.length < 500) {
          var raw = m[2].replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\u[\da-fA-F]{4}/g, ' ').replace(/\s+/g, ' ').trim();
          /* 只要含中文且足够长的字符串（键名/路径等噪音会被滤掉） */
          if (raw.length >= 8 && /[\u4e00-\u9fff]/.test(raw) && !seen[raw]) {
            seen[raw] = 1;
            scriptTexts.push(raw.length > 2000 ? raw.slice(0, 2000) : raw);
          }
        }
      }
      if (scriptTexts.length) {
        warnings.push('HTML 内含脚本，已隔离（未执行）；已提取脚本中说明文字 ' + scriptTexts.length + ' 段用于检索');
      } else {
        warnings.push('HTML 内含脚本，已隔离（未执行，脚本中无可提取的说明文字）');
      }
    }

    var blocks = [];
    var title = (doc.title || '').trim();
    if (title) blocks.push({ type: 'heading', level: 1, text: title, anchor: { para: 0 } });

    /* 移除不参与提取的节点（DOMParser 文档本身惰性，此处避免误取其文本） */
    Array.prototype.forEach.call(
      doc.querySelectorAll('script,style,noscript,iframe,template,head'),
      function (n) { n.parentNode && n.parentNode.removeChild(n); }
    );

    var skipTables = [];
    function inTable(el) {
      for (var i = 0; i < skipTables.length; i++) {
        if (skipTables[i] !== el && skipTables[i].contains(el)) return true;
      }
      return false;
    }
    var nodes = doc.body ? doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,div') : [];
    var BLOCK = /^(DIV|P|LI|BLOCKQUOTE|PRE|H1|H2|H3|H4|H5|H6|TABLE)$/;
    Array.prototype.forEach.call(nodes, function (el) {
      if (inTable(el)) return;
      var tag = el.tagName.toLowerCase();
      var txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (tag === 'table') {
        if (!txt) return;
        var rows = [];
        Array.prototype.forEach.call(el.querySelectorAll('tr'), function (tr) {
          rows.push(Array.prototype.map.call(tr.querySelectorAll('td,th'), function (td) {
            return (td.textContent || '').replace(/\s+/g, ' ').trim();
          }));
        });
        if (rows.length) {
          blocks.push({
            type: 'table', rows: rows,
            text: rows.map(function (r) { return r.filter(Boolean).join(' | '); }).filter(Boolean).join('\n'),
            anchor: { para: blocks.length }
          });
          skipTables.push(el);
        }
        return;
      }
      if (tag === 'div') {
        /* 只取叶子 div（无块级后代），避免父容器重复拼接子文本（架构图 div 布局） */
        if (el.querySelector('div,p,li,table,h1,h2,h3,h4,h5,h6,blockquote,pre')) return;
        if (!txt) return;
        blocks.push({ type: 'para', text: txt, anchor: { para: blocks.length } });
        return;
      }
      if (!txt) return;
      var m = tag.match(/^h(\d)$/);
      blocks.push({
        type: m ? 'heading' : 'para',
        level: m ? +m[1] : 0,
        text: txt, anchor: { para: blocks.length }
      });
    });

    /* 兜底：结构化提取太少时，用整页压缩文本 */
    var totalLen = blocks.reduce(function (s, b) { return s + (b.text || '').length; }, 0);
    if (totalLen < 80) {
      var all = ((doc.body && doc.body.textContent) || '').replace(/\s+/g, ' ').trim();
      if (all) blocks.push({ type: 'para', text: all.slice(0, 20000), anchor: { para: blocks.length } });
    }
    /* 追加脚本里提取的说明文字（drillData 等配置内容；不执行脚本，仅作检索文本） */
    scriptTexts.forEach(function (t) {
      blocks.push({ type: 'para', text: t, anchor: { para: blocks.length } });
    });
    if (onProgress) onProgress('HTML 解析完成', 1);
    return Promise.resolve({
      pages: [{ num: 1, blocks: blocks }],
      warnings: warnings,
      anchorType: 'para',
      pageNote: 'HTML 无分页，锚点为段落序号'
    });
  }

  /* ---------- PPTX 解析（JSZip + OOXML） ---------- */
  /* 页内相邻短块合并：汇报类/架构类 PPT 常有大量独立文本框（标签、要点词、图例字），
     每个只有几个字，阅读器里会呈现"几个字一行"。合并规则：同一页内文本 <=16 字的短块
     连续拼接为一行（空格分隔，累计上限 80 字），长块（标题/正文段）保持独立；
     文本顺序完全不变，批注/锚点不受影响。 */
  function mergeShortBlocks(blocks) {
    var SHORT_LIMIT = 16;
    var MERGE_CEIL = 80;
    var out = [];
    var buf = [];
    var bufLen = 0;
    function flush() {
      if (buf.length) {
        out.push({ type: 'para', level: 0, text: buf.join(' '), anchor: { slide: 0 } });
        buf = []; bufLen = 0;
      }
    }
    blocks.forEach(function (b) {
      var len = (b.text || '').length;
      var isShort = len <= SHORT_LIMIT;
      if (isShort) {
        if (bufLen === 0 || bufLen + len <= MERGE_CEIL) { buf.push(b.text); bufLen += len; return; }
        flush();
        buf.push(b.text); bufLen = len;
        return;
      }
      /* 长块：先收尾当前短块序列，再独立输出 */
      flush();
      out.push(b);
    });
    flush();
    return out;
  }

  function parsePptx(arrayBuffer, onProgress) {
    if (!window.JSZip) return Promise.reject(new Error('JSZip 未加载（首次使用需联网加载 CDN）'));
    return JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var warnings = [];
      /* 宏隔离：不解析，仅提示 */
      var macroEntry = Object.keys(zip.files).filter(function (n) { return /\.vbaProject\.bin$/i.test(n) || /vbaProject\.bin$/i.test(n); });
      if (macroEntry.length) warnings.push('文件包含宏（' + macroEntry.join('、') + '），已按安全策略隔离，不解析宏内容');
      /* 可疑条目直接拒绝 */
      var susp = Object.keys(zip.files).filter(function (n) { return /\.(exe|dll|bat|cmd|js|vbs|ps1)$/i.test(n); });
      if (susp.length) throw new Error('压缩包内含可疑可执行条目：' + susp.join('、') + '，已拒绝解析');

      var slideNames = Object.keys(zip.files).filter(function (n) {
        return /^ppt\/slides\/slide\d+\.xml$/.test(n);
      }).sort(function (a, b) {
        var na = +a.match(/slide(\d+)\.xml$/)[1], nb = +b.match(/slide(\d+)\.xml$/)[1];
        return na - nb;
      });
      if (!slideNames.length) throw new Error('PPTX 结构异常：未找到幻灯片（ppt/slides/slideN.xml）');

      var pages = [];
      var chain = Promise.resolve();
      slideNames.forEach(function (name, idx) {
        chain = chain.then(function () {
          return zip.file(name).async('string').then(function (xml) {
            var doc = new DOMParser().parseFromString(xml, 'application/xml');
            var blocks = [];
            /* 按本地名取元素（兼容不同 OOXML 命名空间前缀，如 p:sp / <sp>） */
            function byLocal(root, local) {
              var all = root.getElementsByTagName('*');
              var out = [];
              for (var i = 0; i < all.length; i++) {
                var n = all[i].localName || all[i].nodeName;
                if (n === local) out.push(all[i]);
              }
              return out;
            }
            /* 提取一个文本框（sp）内的所有段落行（a:p → 行，行内 a:t 拼接） */
            function shapeLines(sp) {
              var lines = [];
              var ps = byLocal(sp, 'p');
              for (var i = 0; i < ps.length; i++) {
                var parts = byLocal(ps[i], 't');
                var txt = '';
                for (var k = 0; k < parts.length; k++) txt += parts[k].textContent;
                if (txt.trim()) lines.push(txt.trim());
              }
              return lines;
            }
            /* 优先按文本框（sp）聚合：同框多行合并为一个内容块（行间保留换行），
               避免"每行一段"在阅读器里出现几个字一行的碎片排版。 */
            var shapes = byLocal(doc, 'sp').filter(function (sp) { return byLocal(sp, 'txBody').length; });
            if (shapes.length) {
              var isFirstShape = true;
              for (var si = 0; si < shapes.length; si++) {
                var lines = shapeLines(shapes[si]);
                if (!lines.length) continue;
                blocks.push({
                  type: (isFirstShape ? 'heading' : 'para'),
                  level: (isFirstShape ? 2 : 0),
                  text: lines.join('\n'),
                  anchor: { slide: idx + 1 }
                });
                isFirstShape = false;
              }
            } else {
              /* 无文本框结构的页面：按原逻辑逐段提取 */
              var paras = byLocal(doc, 'p');
              for (var i = 0; i < paras.length; i++) {
                var parts = byLocal(paras[i], 't');
                var txt = '';
                for (var k = 0; k < parts.length; k++) txt += parts[k].textContent;
                txt = txt.trim();
                if (txt) {
                  blocks.push({ type: (i === 0 ? 'heading' : 'para'), level: (i === 0 ? 2 : 0), text: txt, anchor: { slide: idx + 1 } });
                }
              }
            }
            /* 相邻短块合并（标签/要点词拼成一行），消除"几个字一行"碎片 */
            blocks = mergeShortBlocks(blocks);
            pages.push({ num: idx + 1, blocks: blocks });
            if (onProgress) onProgress('幻灯片 ' + (idx + 1) + '/' + slideNames.length, (idx + 1) / slideNames.length);
          });
        });
      });
      return chain.then(function () {
        return { pages: pages, warnings: warnings, anchorType: 'slide', pageNote: '锚点为幻灯片序号' };
      });
    });
  }

  /* ---------- 通用工具 ---------- */
  function splitToBlocks(text) {
    var out = [];
    String(text || '').split(/\n\s*\n/).forEach(function (seg) {
      seg = seg.replace(/\s*\n\s*/g, ' ').trim();
      if (seg) out.push({ type: 'para', text: seg });
    });
    return out;
  }

  function buildFullText(pages) {
    var full = '';
    var offsets = [];
    pages.forEach(function (p) {
      var start = full.length;
      p.blocks.forEach(function (b, i) {
        full += (b.text || '') + '\n';
      });
      offsets.push([start, full.length]);
    });
    return { fullText: full, textOffsets: offsets };
  }

  /* ---------- 对外主入口 ---------- */
  /**
   * parse(file, onProgress) -> Promise<model>
   * model = {
   *   kind, meta:{name,size,addedAt}, pages, fullText, textOffsets,
   *   warnings[], injections[], anchorType, pageNote
   * }
   */
  function parse(file, onProgress) {
    var chk = checkFile(file);
    if (!chk.ok) return Promise.reject(new Error(chk.reason));
    var kind = chk.kind;

    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      fr.onload = function (e) {
        var buf = e.target.result;
        var err = verifyMagic(kind, buf);
        if (err) { reject(new Error(err)); return; }
        var p = (kind === 'pdf' ? parsePdf(buf, onProgress)
          : kind === 'docx' ? parseDocx(buf, onProgress)
          : kind === 'html' ? parseHtml(buf, onProgress)
          : parsePptx(buf, onProgress));
        p.then(function (r) {
          var ft = buildFullText(r.pages);
          var injections = scanInjection(ft.fullText);
          var model = {
            kind: kind,
            meta: { name: file.name, size: file.size, mime: file.type || '', addedAt: new Date().toISOString() },
            pages: r.pages,
            fullText: ft.fullText,
            textOffsets: ft.textOffsets,
            warnings: r.warnings || [],
            injections: injections,
            anchorType: r.anchorType || 'page',
            pageNote: r.pageNote || '锚点为页序号',
            stripped: ['宏（vbaProject.bin）已隔离', '文档一律作为数据处理，任何文件内指令不会被执行']
          };
          resolve(model);
        }).catch(function (err2) { reject(err2 instanceof Error ? err2 : new Error(String(err2))); });
      };
      fr.readAsArrayBuffer(file);
    });
  }

  window.SZParse = {
    MAX_SIZE: MAX_SIZE,
    checkFile: checkFile,
    parse: parse,
    scanInjection: scanInjection,
    /* 供教案引用检索的关键词评分（无外部 Embedding 时的本地可解释检索） */
    searchBlocks: function (model, query, topK) {
      /* 中文主题/能力名整句无空格，旧逻辑整词 indexOf 必然 0 命中 → AI 误判"材料缺失"。
         现按整词 + 3~4 字中文 ngram 拆关键词（同 repairDays 已验证的思路） */
      var q = String(query || '').replace(/[，。；：、\s\-–—（）()《》「」…·,.:;\/]+/g, ' ').split(' ').filter(Boolean);
      var keys = [];
      q.forEach(function (p) {
        if (p.length >= 2) keys.push(p);
        if (/[\u4e00-\u9fff]/.test(p)) {          /* 仅对含中文的词做 ngram，纯英文词整词匹配 */
          for (var n = 3; n <= 4 && p.length >= n; n++) {
            for (var i = 0; i + n <= p.length; i++) keys.push(p.slice(i, i + n));
          }
        }
      });
      keys = keys.filter(function (k, idx) { return keys.indexOf(k) === idx; });
      var hits = [];
      if (!model || !keys.length) return hits;
      model.pages.forEach(function (p) {
        p.blocks.forEach(function (b, bi) {
          var t = String(b.text || '');
          if (!t) return;
          var score = 0;
          keys.forEach(function (k) {
            var idx = t.indexOf(k);
            if (idx >= 0) {
              score += k.length >= 4 ? k.length * 2 : (idx === 0 ? 3 : 1);
              if (idx < 300) score += 2; /* 标题/开头加权 */
            }
          });
          if (score > 0) {
            hits.push({
              page: p.num, blockIdx: bi, anchor: b.anchor || { page: p.num },
              text: t.length > 240 ? t.slice(0, 240) + '…' : t, score: score
            });
          }
        });
      });
      hits.sort(function (a, b) { return b.score - a.score; });
      return hits.slice(0, topK || 8);
    }
  };
})();
