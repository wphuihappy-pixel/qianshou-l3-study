/**
 * 千手学习Agent · 共享返回导航栏
 * 注入到各栏目页面，提供稳定可见的"返回"中心。
 * 核心体验要求：任何页面跳转后都能可靠返回原页面。
 *
 * 用法（在栏目页面引入）：
 *   <link rel="stylesheet" href="../shared/agent-nav.css">
 *   <script src="../shared/agent-nav.js" data-agent-app="english" data-agent-page="英语学习"></script>
 *   - data-agent-app: english 或 chan（用于调整各应用自身粘性顶栏的偏移）
 *   - data-agent-page: 当前栏目名称，显示在导航栏
 */
(function () {
  'use strict';
  if (window.AgentNav) return;

  function getScriptSrc() {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].src;
      if (s && s.indexOf('agent-nav.js') >= 0) return s;
    }
    return '';
  }

  /* 依据本脚本位置推断统一首页地址（<根目录>/index.html） */
  function resolveHome() {
    var src = getScriptSrc();
    if (src) {
      var parts = src.split('/');
      parts.pop();   /* 去掉 agent-nav.js */
      parts.pop();   /* 去掉 shared */
      parts.push('index.html');
      return parts.join('/');
    }
    var p = location.href.split('/');
    p.pop();
    p.pop();
    p.push('index.html');
    return p.join('/');
  }

  function readMeta() {
    var meta = { app: 'english', page: '' };
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      if ((scripts[i].src || '').indexOf('agent-nav.js') >= 0) {
        meta.app = scripts[i].getAttribute('data-agent-app') || 'english';
        meta.page = scripts[i].getAttribute('data-agent-page') || '';
        break;
      }
    }
    return meta;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function goHome() {
    try { localStorage.setItem('agent_last_column', document.title || ''); } catch (e) {}
    location.href = window.AgentNav ? window.AgentNav.home : resolveHome();
  }

  function buildBar() {
    var meta = readMeta();
    var home = resolveHome();

    var bar = document.createElement('div');
    bar.id = 'agent-navbar';
    bar.innerHTML =
      '<button type="button" class="an-back" id="agent-back-btn" aria-label="返回千手学习Agent首页">' +
      '<span class="an-arrow">‹</span><span>返回</span></button>' +
      '<div class="an-title">' +
      '<span class="an-brand">千手学习Agent</span>' +
      '<span class="an-sep">/</span>' +
      '<span class="an-page">' + escapeHtml(meta.page || '栏目') + '</span>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);

    document.documentElement.classList.add('agent-nav-on');
    document.body.classList.add('an-app-' + (meta.app === 'chan' ? 'chan' : 'english'));

    var backBtn = document.getElementById('agent-back-btn');
    if (backBtn) backBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      goHome();
    });

    window.AgentNav = {
      home: home,
      goHome: goHome,
      setPage: function (t) {
        var el = document.querySelector('#agent-navbar .an-page');
        if (el) el.textContent = t;
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildBar);
  } else {
    buildBar();
  }
})();