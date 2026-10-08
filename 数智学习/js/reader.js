/**
 * 数智学习 · 阅读器 + 手动批注层
 * ============================================================
 * 原则：
 *  1. 原件永远只读：阅读器渲染的是解析出的文本模型副本，
 *     原始 Blob 不被修改；批注存独立图层（annotations 表）。
 *  2. 锚点抗版面微调：文本批注保存 引用文本 + 起止偏移，
 *     重渲染时先按偏移校验（引用文本一致），不一致退回全文检索，
 *     再失败标记「待重定位」，绝不静默迁移。
 *  3. 绘图批注保存归一化坐标（0~1），按容器尺寸缩放重绘。
 *  4. 支持标签：没懂 / 不确定 / 需练习 / 已掌握（显式反馈入口）。
 * ============================================================
 */
(function () {
  'use strict';
  if (window.SZReader) return;

  var LABELS = ['没懂', '不确定', '需练习', '已掌握'];

  function Reader() {
    this.stage = null;
    this.model = null;
    this.annotations = [];
    this.mode = 'select'; /* select | draw */
    this.onChange = null;
    this.onLabel = null;   /* (label, annotation) => void 显式反馈回调 */
    this.onLink = null;    /* (annotation) => void 关联课程/音频 */
    this._drawing = null;
    this._undoStack = [];
    this._penColor = '#A63A2B';
  }

  /* ============ 挂载 ============ */
  Reader.prototype.mount = function (stage, model, opts) {
    var self = this;
    this.stage = stage;
    this.model = model;
    this.annotations = (opts && opts.annotations) ? opts.annotations.slice() : [];
    this.onChange = (opts && opts.onChange) || null;
    this.onLabel = (opts && opts.onLabel) || null;
    this.lessonId = (opts && opts.lessonId) || '';
    this.sourceId = (opts && opts.sourceId) || '';
    this._bindToolbar(opts);
    this.render();
    /* 选择监听（高亮/下划线/便签/标签）；重复挂载先解旧，避免叠加 */
    if (this._selHandler) document.removeEventListener('mouseup', this._selHandler);
    this._selHandler = function (e) {
      if (self.mode !== 'select') return;
      if (self.stage && self.stage.contains(e.target)) self._onSelect();
    };
    document.addEventListener('mouseup', this._selHandler);
    return this;
  };

  /* 选择松开钩子：选中文字后自动弹出浮动标注条（高亮/下划线/批注/标签），无需回顶部工具条 */
  Reader.prototype._onSelect = function () {
    this._showFloatBar();
  };

  /* 统一标注动作（顶部工具条与选区浮动条共用） */
  Reader.prototype._doAction = function (act, label) {
    if (act === 'label') {
      var selInfo = this._selectionInfo();
      if (!selInfo) { this._toast('请先选中要标记的文字'); return; }
      this._addAnnotation({
        kind: 'highlight', label: label, color: '#F6C9C2',
        anchor: selInfo.anchor, text: ''
      }, label);
    } else {
      var si = this._selectionInfo();
      if (!si) { this._toast('请先选中文字'); return; }
      if (act === 'note') {
        var input = prompt('批注内容（可选，留空仅保留位置标记）：');
        if (input === null) return; /* 取消 */
        this._addAnnotation({
          kind: 'note', label: '', color: '#B98A2F',
          anchor: si.anchor, text: input
        });
      } else {
        this._addAnnotation({
          kind: act, label: '', color: act === 'underline' ? '' : '#ffe89a',
          anchor: si.anchor, text: ''
        });
      }
    }
    this._hideFloatBar();
    try { window.getSelection().removeAllRanges(); } catch (err) { }
  };

  /* 选区浮动标注条：出现在选区上方，鼠标划选即用 */
  Reader.prototype._showFloatBar = function () {
    var self = this;
    if (this.mode !== 'select') { this._hideFloatBar(); return; }
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { this._hideFloatBar(); return; }
    var range = sel.getRangeAt(0);
    var startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    var pageEl = startEl && startEl.closest ? startEl.closest('.page') : null;
    if (!pageEl || !this.stage.contains(pageEl)) { this._hideFloatBar(); return; }
    if (!this._selectionInfo()) { this._hideFloatBar(); return; }

    var old = document.getElementById('reader-float-tool');
    if (old) old.remove();
    var rect = range.getBoundingClientRect();
    var bar = document.createElement('div');
    bar.id = 'reader-float-tool';
    bar.innerHTML =
      '<button type="button" data-act="highlight" title="高亮选中文字">高亮</button>' +
      '<button type="button" data-act="underline" title="加下划线">下划线</button>' +
      '<button type="button" data-act="note" title="加文字批注">批注</button>' +
      '<span class="fsep"></span>' +
      LABELS.map(function (lb) { return '<button type="button" data-act="label" data-label="' + lb + '">' + lb + '</button>'; }).join('');
    document.body.appendChild(bar);
    var bw = bar.offsetWidth || 180;
    var left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    var top = rect.top - bar.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    bar.querySelectorAll('button').forEach(function (btn) {
      /* mousedown 阻止默认，避免点击按钮时丢失选区 */
      btn.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        self._doAction(act, btn.getAttribute('data-label') || '');
      });
    });
    setTimeout(function () {
      document.addEventListener('mousedown', function closer(e) {
        if (!bar.contains(e.target)) { self._hideFloatBar(); document.removeEventListener('mousedown', closer); }
      });
    }, 10);
  };

  Reader.prototype._hideFloatBar = function () {
    var el = document.getElementById('reader-float-tool');
    if (el) el.remove();
  };

  /* ============ 工具栏 ============ */
  Reader.prototype._bindToolbar = function (opts) {
    var self = this;
    var tb = document.getElementById('reader-toolbar');
    if (!tb) return;
    tb.innerHTML =
      '<button class="btn btn-sm btn-ghost" data-act="highlight">高亮</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="underline">下划线</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="note">文字批注</button>' +
      '<span style="border-left:1px solid var(--line);height:18px"></span>' +
      '<button class="btn btn-sm ' + (this.mode === 'draw' ? 'btn-success' : 'btn-outline') + '" data-act="draw">画笔</button>' +
      '<input type="color" id="pen-color" value="' + this._penColor + '" title="画笔颜色" style="width:34px;height:28px;padding:0;border:1px solid var(--line)">' +
      '<span style="border-left:1px solid var(--line);height:18px"></span>' +
      LABELS.map(function (lb) {
        return '<button class="btn btn-sm btn-outline" data-act="label" data-label="' + lb + '" style="border-color:var(--cinnabar);color:var(--cinnabar)">' + lb + '</button>';
      }).join('') +
      '<span style="border-left:1px solid var(--line);height:18px"></span>' +
      '<button class="btn btn-sm btn-outline" data-act="undo">撤销</button>' +
      '<button class="btn btn-sm btn-outline" data-act="export">导出带批注副本</button>' +
      '<span class="muted" style="font-size:12px;margin-left:auto">选中文字后点高亮/下划线/批注或"没懂"标签；画笔模式可直接在页面绘制</span>';

    tb.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        if (act === 'draw') {
          self.mode = self.mode === 'draw' ? 'select' : 'draw';
          btn.className = 'btn btn-sm ' + (self.mode === 'draw' ? 'btn-success' : 'btn-outline');
          self._setDrawMode(self.mode === 'draw');
          return;
        }
        if (act === 'undo') { self.undo(); return; }
        if (act === 'export') { self.exportAnnotated(); return; }
        /* 高亮 / 下划线 / 批注 / 标签：统一走 _doAction（与选区浮动条共用同一实现） */
        self._doAction(act, btn.getAttribute('data-label') || '');
      });
    });
    var pc = tb.querySelector('#pen-color');
    if (pc) pc.addEventListener('input', function () { self._penColor = pc.value; });
  };

  /* ============ 渲染 ============ */
  Reader.prototype.render = function () {
    var self = this;
    var m = this.model;
    var stage = this.stage;
    stage.innerHTML = '';
    if (!m) { stage.innerHTML = '<div class="empty">未加载文档</div>'; return; }

    this._pageTexts = [];
    var html = '';
    m.pages.forEach(function (page) {
      var pageText = '';
      var blocksHtml = '';
      page.blocks.forEach(function (b) {
        var off = pageText.length;
        b._off = off;
        if (b.type === 'heading') {
          blocksHtml += '<h4 data-off="' + off + '" style="white-space:pre-line">' + esc(b.text) + '</h4>';
        } else if (b.type === 'table') {
          var rows = (b.rows || []).map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
          }).join('');
          blocksHtml += '<table class="tbl" data-off="' + off + '"><tbody>' + rows + '</tbody></table>';
        } else {
          blocksHtml += '<p data-off="' + off + '" style="white-space:pre-line">' + esc(b.text) + '</p>';
        }
        pageText += (b.text || '') + '\n';
      });
      self._pageTexts[page.num] = pageText;
      html += '<div class="page" data-page="' + page.num + '" style="padding:22px 26px;border-bottom:1px dashed var(--line);position:relative">' +
        '<div style="font-size:11px;color:var(--ink3);letter-spacing:.2em;margin-bottom:8px">' +
        (m.anchorType === 'slide' ? 'SLIDE ' : 'PART ') + page.num + ' / ' + m.pages.length +
        (m.anchorType === 'para' ? ' · ' + esc(m.pageNote || '') : '') + '</div>' +
        '<div class="page-text">' + blocksHtml + '</div>' +
        '<canvas class="annot-canvas"></canvas>' +
        '</div>';
    });
    stage.innerHTML = html;
    this._hideFloatBar();
    this._applyAnnotations();
    this._bindDraw();
  };

  /* ============ 批注应用（文本重定位） ============ */
  Reader.prototype._applyAnnotations = function () {
    var self = this;
    var stage = this.stage;
    /* 清旧标记 */
    stage.querySelectorAll('.hl, .hl-underline').forEach(function (el) {
      var parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
    stage.querySelectorAll('.ann-mark').forEach(function (el) { el.remove(); });

    /* 收集每页文本批注，按偏移排序，重定位 */
    var textAnns = this.annotations.filter(function (a) {
      return a.anchor && (a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'note' || a.kind === 'question' || a.kind === 'bookmark');
    });
    /* 重定位校验 */
    textAnns.forEach(function (a) {
      a._loc = self._locate(a);
    });
    /* 有效批注渲染 */
    var valid = textAnns.filter(function (a) { return a._loc; });
    var pending = textAnns.filter(function (a) { return !a._loc; });

    /* 按页分组渲染高亮 */
    var byPage = {};
    valid.forEach(function (a) {
      var p = a._loc.page;
      (byPage[p] = byPage[p] || []).push(a);
    });
    Object.keys(byPage).forEach(function (p) {
      var anns = byPage[p].sort(function (x, y) { return x._loc.start - y._loc.start; });
      self._highlightPage(p, anns);
    });

    /* 待重定位提示（不静默迁移） */
    if (pending.length) {
      var banner = document.createElement('div');
      banner.className = 'alert warn';
      banner.innerHTML = '<b>' + pending.length + ' 条批注无法在当前版本上定位</b>（引用文本在文档中已变化）。请人工确认：' +
        pending.map(function (a, i) {
          return '<a href="#" data-reloc="' + a.id + '">批注' + (i + 1) + '「' + esc((a.anchor.refText || '').slice(0, 16)) + '…」</a>';
        }).join(' ');
      stage.insertBefore(banner, stage.firstChild);
      banner.querySelectorAll('[data-reloc]').forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var a = self.annotations.find(function (x) { return x.id === link.getAttribute('data-reloc'); });
          if (a) {
            var txt = (a.anchor.refText || '').slice(0, 40);
            self._toast('该批注引用原文「' + txt + '…」，在新版本中未找到；可在原位置重新标注后删除旧批注');
          }
        });
      });
    }
  };

  /* 高亮一页：把区间转 span */
  Reader.prototype._highlightPage = function (pageNum, anns) {
    var self = this;
    var pageEl = this.stage.querySelector('.page[data-page="' + pageNum + '"] .page-text');
    if (!pageEl) return;
    var blocks = Array.prototype.slice.call(pageEl.children);
    blocks.forEach(function (block) {
      var bOff = +block.getAttribute('data-off');
      var len = block.textContent.length;
      var rels = [];
      anns.forEach(function (a) {
        var s = a._loc.start - bOff, e = a._loc.end - bOff;
        if (e <= 0 || s >= len) return;
        rels.push({ s: Math.max(0, s), e: Math.min(len, e), a: a });
      });
      if (!rels.length) return;
      rels.sort(function (x, y) { return x.s - y.s; });
      var html = '';
      var cur = 0;
      rels.forEach(function (r) {
        if (r.s < cur) { cur = Math.max(cur, r.e); return; } /* 重叠忽略 */
        html += esc(block.textContent.slice(cur, r.s));
        var cls = r.a.kind === 'underline' ? 'hl hl-underline' : 'hl';
        var style = (r.a.kind !== 'underline' && r.a.color) ? ' style="background:' + r.a.color + '"' : '';
        var labelTag = r.a.label ? '<sup class="ann-mark" style="color:var(--cinnabar);font-weight:700">[' + r.a.label + ']</sup>' : '';
        var noteTag = (r.a.kind === 'note' && r.a.text) ? '<sup class="ann-mark" data-note="' + r.a.id + '" style="color:var(--gold);font-weight:700;cursor:pointer">[批注]</sup>' : '';
        html += '<span class="' + cls + '"' + style + ' data-ann="' + r.a.id + '">' +
          esc(block.textContent.slice(r.s, r.e)) + labelTag + noteTag + '</span>';
        cur = r.e;
      });
      html += esc(block.textContent.slice(cur));
      block.innerHTML = html;
      block.querySelectorAll('[data-ann]').forEach(function (span) {
        span.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = span.getAttribute('data-ann');
          var a = self.annotations.find(function (x) { return x.id === id; });
          if (a) self._annPopup(a, e.target);
        });
      });
      block.querySelectorAll('[data-note]').forEach(function (sup) {
        sup.addEventListener('click', function (e) {
          e.stopPropagation();
          var a = self.annotations.find(function (x) { return x.id === sup.getAttribute('data-note'); });
          if (a) self._annPopup(a, e.target);
        });
      });
    });
  };

  /* 定位：先偏移+引用校验，退回引用检索 */
  Reader.prototype._locate = function (a) {
    var pt = this._pageTexts || [];
    for (var p = 1; p <= pt.length; p++) {
      var t = pt[p];
      if (typeof t !== 'string') continue;
      var off = a.anchor.startOffset;
      if (typeof off === 'number' && a.anchor.page === p) {
        var seg = t.substr(off, (a.anchor.endOffset - a.anchor.startOffset));
        if (seg && a.anchor.refText && seg.trim() === a.anchor.refText.trim()) {
          return { page: p, start: off, end: a.anchor.endOffset };
        }
      }
    }
    /* 退回：全文检索引用文本 */
    if (a.anchor.refText) {
      for (var p2 = 1; p2 <= pt.length; p2++) {
        var t2 = pt[p2];
        if (typeof t2 !== 'string') continue;
        var i = t2.indexOf(a.anchor.refText);
        if (i >= 0) return { page: p2, start: i, end: i + a.anchor.refText.length };
      }
    }
    return null;
  };

  /* ============ 画笔 ============ */
  Reader.prototype._setDrawMode = function (on) {
    var self = this;
    this.stage.querySelectorAll('.annot-canvas').forEach(function (cv) {
      cv.classList.toggle('active', on);
      var page = cv.closest('.page');
      if (on) {
        cv.width = page.clientWidth;
        cv.height = page.clientHeight;
        cv.style.width = page.clientWidth + 'px';
        cv.style.height = page.clientHeight + 'px';
        self._redrawDrawPage(cv);
      } else {
        self._redrawDrawPage(cv);
      }
    });
  };

  Reader.prototype._bindDraw = function () {
    var self = this;
    this.stage.querySelectorAll('.annot-canvas').forEach(function (cv) {
      var page = cv.closest('.page');
      var pageNum = +page.getAttribute('data-page');
      var started = false;
      function pt(e) {
        var r = cv.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      }
      cv.addEventListener('pointerdown', function (e) {
        if (self.mode !== 'draw') return;
        e.preventDefault();
        started = true;
        self._drawing = { page: pageNum, points: [pt(e)] };
        cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener('pointermove', function (e) {
        if (!started) return;
        self._drawing.points.push(pt(e));
        self._previewDraw(cv, self._drawing);
      });
      function finish() {
        if (!started) return;
        started = false;
        if (self._drawing && self._drawing.points.length > 1) {
          self._addAnnotation({
            kind: 'draw', label: '', color: self._penColor,
            anchor: { page: pageNum, points: self._drawing.points },
            text: ''
          });
        }
        self._drawing = null;
      }
      cv.addEventListener('pointerup', finish);
      cv.addEventListener('pointerleave', finish);
    });
  };

  Reader.prototype._previewDraw = function (cv, drawing) {
    var ctx = cv.getContext('2d');
    this._redrawDrawPage(cv);
    ctx.strokeStyle = this._penColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    drawing.points.forEach(function (p, i) {
      var x = p[0] * cv.width, y = p[1] * cv.height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  Reader.prototype._redrawDrawPage = function (cv) {
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    var pageNum = +cv.closest('.page').getAttribute('data-page');
    var self = this;
    this.annotations.forEach(function (a) {
      if (a.kind !== 'draw' || !a.anchor || a.anchor.page !== pageNum) return;
      ctx.strokeStyle = a.color || '#A63A2B';
      ctx.lineWidth = 2;
      ctx.beginPath();
      (a.anchor.points || []).forEach(function (p, i) {
        var x = p[0] * cv.width, y = p[1] * cv.height;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  };

  /* ============ 选择信息 ============ */
  Reader.prototype._selectionInfo = function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    var startNode = range.startContainer;
    var endNode = range.endContainer;
    var pageEl = (startNode.nodeType === 3 ? startNode.parentElement : startNode);
    pageEl = pageEl && pageEl.closest ? pageEl.closest('.page') : null;
    if (!pageEl || !this.stage.contains(pageEl)) return null;
    var pageNum = +pageEl.getAttribute('data-page');
    var pageText = this._pageTexts[pageNum];
    if (typeof pageText !== 'string') return null;

    /* 偏移以块为单位计算：块 data-off（pageText 中该块的起始，含块间 \n）+ 块内字符偏移。
       旧实现按全页文本节点累加，DOM 块与块之间没有 \n 文本节点，而 pageText 每块后拼接了 '\n'，
       导致第 N 块（N≥2）的偏移少算 N-1，批注位置越靠后漂移越大。 */
    function blockOf(node) {
      var el = node.nodeType === 3 ? node.parentElement : node;
      return el && el.closest ? el.closest('[data-off]') : null;
    }
    function innerOffset(block, targetNode, targetOffset) {
      if (!block) return 0;
      if (targetNode.nodeType === 3) {
        var w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
        var n, acc = 0;
        while ((n = w.nextNode())) {
          if (n === targetNode) return acc + targetOffset;
          acc += n.nodeValue.length;
        }
        return acc + targetOffset;
      }
      /* 元素容器（整块或块内 span）：目标之前文本 + 目标内前 targetOffset 个子节点文本 */
      var w2 = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
      var n2, acc2 = 0, hit = false;
      while ((n2 = w2.nextNode())) {
        if (n2.parentNode === targetNode || targetNode.contains(n2)) { hit = true; break; }
        acc2 += n2.nodeValue.length;
      }
      var inner = 0;
      if (hit) {
        for (var i = 0; i < targetOffset && i < targetNode.childNodes.length; i++) {
          var ch = targetNode.childNodes[i];
          if (ch && ch.textContent) inner += ch.textContent.length;
        }
      }
      return acc2 + inner;
    }

    var sBlock = blockOf(startNode);
    var eBlock = blockOf(endNode);
    if (!sBlock || !eBlock || !pageEl.contains(eBlock)) return null;
    var startOff = (+sBlock.getAttribute('data-off') || 0) + innerOffset(sBlock, startNode, range.startOffset);
    var endOff = (+eBlock.getAttribute('data-off') || 0) + innerOffset(eBlock, endNode, range.endOffset);
    if (endOff <= startOff) return null;
    var refText = pageText.substring(startOff, endOff);
    if (!refText.trim()) return null;
    return {
      anchor: { page: pageNum, startOffset: startOff, endOffset: endOff, refText: refText },
      refText: refText
    };
  };

  /* ============ 增删改 ============ */
  Reader.prototype._addAnnotation = function (partial, labelForFeedback) {
    var DB = window.SZDB;
    var a = {
      id: DB.newId('an'),
      sourceId: this.sourceId,
      sourceName: this.model && this.model.meta ? this.model.meta.name : '',
      sourceVersion: 1,
      lessonId: this.lessonId || '',
      kind: partial.kind,
      label: partial.label || '',
      color: partial.color || '',
      anchor: partial.anchor,
      text: partial.text || '',
      audioTs: null,
      userId: 'local',
      createdAt: DB.nowIso(),
      updatedAt: DB.nowIso()
    };
    this.annotations.push(a);
    this._undoStack.push(a.id);
    this.render();
    this._persist(a, 'add');
    if (labelForFeedback && this.onLabel) this.onLabel(labelForFeedback, a);
  };

  Reader.prototype.removeAnnotation = function (id) {
    var i = this.annotations.findIndex(function (a) { return a.id === id; });
    if (i < 0) return;
    var a = this.annotations[i];
    this.annotations.splice(i, 1);
    this.render();
    this._persist(a, 'del');
  };

  Reader.prototype.updateAnnotation = function (a) {
    a.updatedAt = (window.SZDB && window.SZDB.nowIso) ? window.SZDB.nowIso() : new Date().toISOString();
    var i = this.annotations.findIndex(function (x) { return x.id === a.id; });
    if (i >= 0) this.annotations[i] = a;
    this.render();
    this._persist(a, 'upd');
  };

  Reader.prototype.undo = function () {
    var last = this._undoStack.pop();
    if (!last) { this._toast('没有可撤销的操作'); return; }
    this.removeAnnotation(last);
  };

  Reader.prototype._persist = function (a, action) {
    var DB = window.SZDB;
    var self = this;
    if (!DB) return;
    var p = action === 'del' ? DB.del('annotations', a.id) : DB.put('annotations', a);
    p.then(function () {
      if (self.onChange) self.onChange(a, action, self.annotations.slice());
    }).catch(function (e) { self._toast('批注保存失败：' + e.message); });
  };

  /* ============ 批注详情弹层 ============ */
  Reader.prototype._annPopup = function (a, target) {
    var self = this;
    var old = document.getElementById('ann-pop');
    if (old) old.remove();
    var pop = document.createElement('div');
    pop.id = 'ann-pop';
    pop.style.cssText = 'position:absolute;z-index:99;background:#fff;border:1px solid var(--cinnabar);box-shadow:0 4px 16px rgba(0,0,0,.15);padding:12px 14px;min-width:240px;font-size:13px';
    var rect = target.getBoundingClientRect();
    var stRect = this.stage.getBoundingClientRect();
    pop.style.left = (rect.left - stRect.left) + 'px';
    pop.style.top = (rect.bottom - stRect.top + 6) + 'px';
    pop.innerHTML =
      '<div style="margin-bottom:6px;color:var(--ink2)">' + esc(a.kind) + (a.label ? ' · 标签：' + a.label : '') + '</div>' +
      (a.text ? '<div style="margin-bottom:8px">批注：' + esc(a.text) + '</div>' : '') +
      '<div style="margin-bottom:8px;color:var(--ink3);font-size:12px">引用：' + esc((a.anchor.refText || '').slice(0, 60)) + '…</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      LABELS.map(function (lb) {
        var on = a.label === lb;
        return '<button class="btn btn-sm ' + (on ? 'btn-success' : 'btn-outline') + '" data-lb="' + lb + '">' + lb + '</button>';
      }).join('') +
      '<button class="btn btn-sm btn-outline" data-edit>改文字</button>' +
      '<button class="btn btn-sm btn-outline" data-audio>关联音频时间</button>' +
      '<button class="btn btn-sm btn-danger" data-del>删除</button>' +
      '</div>';
    this.stage.appendChild(pop);
    pop.querySelectorAll('[data-lb]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var lb = btn.getAttribute('data-lb');
        a.label = (a.label === lb) ? '' : lb;
        self.updateAnnotation(a);
        if (a.label && self.onLabel) self.onLabel(a.label, a);
        pop.remove();
      });
    });
    pop.querySelector('[data-edit]').addEventListener('click', function () {
      var t = prompt('批注文字：', a.text || '');
      if (t !== null) { a.text = t; self.updateAnnotation(a); pop.remove(); }
    });
    pop.querySelector('[data-audio]').addEventListener('click', function () {
      var t = prompt('关联到当前音频的第几秒？（数字秒）', a.audioTs != null ? String(Math.round(a.audioTs)) : '');
      if (t !== null && !isNaN(+t)) { a.audioTs = +t; self.updateAnnotation(a); pop.remove(); }
    });
    pop.querySelector('[data-del]').addEventListener('click', function () {
      self.removeAnnotation(a.id);
      pop.remove();
    });
    setTimeout(function () {
      document.addEventListener('mousedown', function close(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', close); }
      });
    }, 10);
  };

  /* ============ 导出带批注副本（HTML，可用浏览器打印成 PDF；原件不动） ============ */
  Reader.prototype.exportAnnotated = function () {
    var self = this;
    var m = this.model;
    if (!m) return;
    var DB = window.SZDB;
    var used = this.annotations.filter(function (a) { return a.anchor && a.anchor.refText; });
    var notes = this.annotations.filter(function (a) { return a.text; });
    var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>' +
      esc(m.meta.name) + ' · 批注副本</title><style>' +
      'body{font-family:"Songti SC","SimSun",serif;max-width:860px;margin:0 auto;padding:40px 30px;color:#1c1a17;line-height:1.8;background:#fff}' +
      '.warn{background:#F6E9E6;border:1px solid #A63A2B;padding:10px 14px;font-size:13px;margin-bottom:20px}' +
      '.hl{background:#ffe89a}.hl-u{border-bottom:2px solid #A63A2B}' +
      'h4{margin:14px 0 6px}p{margin:6px 0}table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:4px 8px;font-size:13px}' +
      '.ann{font-size:13px;border-top:2px solid #1c1a17;margin-top:24px;padding-top:10px}' +
      '</style></head><body>';
    html += '<div class="warn">这是<b>批注副本</b>（生成时间 ' + new Date().toLocaleString() +
      '）：内容 = 原文档解析文本 + 你的批注。原件文件未被修改。可用浏览器「打印 → 另存为 PDF」。</div>';
    /* 正文：文本 + 高亮标记 */
    var pageTexts = this._pageTexts || [];
    m.pages.forEach(function (page) {
      var t = pageTexts[page.num] || '';
      var anns = self.annotations.filter(function (a) {
        return a.anchor && a.anchor.refText && a.anchor.page === page.num;
      }).sort(function (x, y) { return (x.anchor.startOffset || 0) - (y.anchor.startOffset || 0); });
      var out = '', cur = 0;
      anns.forEach(function (a) {
        var i = t.indexOf(a.anchor.refText, cur >= t.length ? 0 : cur);
        if (i < 0) return;
        if (i > cur) out += esc(t.substring(cur, i));
        var cls = a.kind === 'underline' ? 'hl-u' : 'hl';
        out += '<span class="' + cls + '">' + esc(a.anchor.refText) + '</span>' +
          (a.label ? '<sup style="color:#A63A2B">[' + esc(a.label) + ']</sup>' : '');
        cur = i + a.anchor.refText.length;
      });
      out += esc(t.substring(cur));
      html += '<h3 style="font-size:16px;border-left:4px solid #A63A2B;padding-left:10px">' +
        (m.anchorType === 'slide' ? '幻灯片 ' : '部分 ') + page.num + '</h3><div style="white-space:pre-wrap">' + out + '</div>';
    });
    if (notes.length) {
      html += '<div class="ann"><b>批注列表</b>';
      this.annotations.forEach(function (a) {
        if (!a.text && !a.label) return;
        html += '<div style="margin:8px 0">· [' + (a.label || '批注') + '] ' + esc(a.text || '') +
          (a.anchor && a.anchor.refText ? ' <span style="color:#a09a90">（引用：' + esc(a.anchor.refText.slice(0, 50)) + '…）</span>' : '') +
          (a.audioTs != null ? ' <span style="color:#2E5A88">（音频 ' + Math.round(a.audioTs) + ' 秒）</span>' : '') + '</div>';
      });
      html += '</div>';
    }
    html += '</body></html>';
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    window.SZTTS.downloadBlob(blob, (m.meta.name || '文档').replace(/\.\w+$/, '') + '_批注副本.html');
    this._toast('已导出带批注副本（HTML，可打印为 PDF）；原件未修改');
  };

  Reader.prototype._toast = function (msg) {
    var t = document.getElementById('toast');
    if (t) { t.textContent = msg; t.style.display = 'block'; setTimeout(function () { t.style.display = 'none'; }, 2600); }
    else alert(msg);
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.SZReader = { Reader: Reader, LABELS: LABELS, esc: esc };
})();
