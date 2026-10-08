/**
 * ECR · 间隔复习调度（可解释、确定性，AI 不参与判分）
 * 沿用千手数智学习已验证的 0/1/2/3/7/14 天规则：
 *   新学 → 当日再测 → 次日 → 3天 → 7天 → 14天
 *   good：沿阶梯上行；hard：原地再来；again：回 1 天 + streak 清零
 *   连续 2 次 good 且跨天 → 阶梯加速（间隔翻倍上限 14）
 * 每条 review 的 rule 字段记录"为什么是这一天"，UI 可解释展示。
 * 复习对象 6 类：vocabulary / expression / mistake / listening / pronunciation / grammar
 */
(function () {
  'use strict';
  if (window.ECR) return;

  var INTERVALS = [0, 1, 2, 3, 7, 14];
  var TYPES = ['vocabulary', 'expression', 'mistake', 'listening', 'pronunciation', 'grammar'];
  var TYPE_CN = {
    vocabulary: '词汇', expression: '表达', mistake: '我的错误',
    listening: '听力难点', pronunciation: '发音', grammar: '语法句型'
  };

  function addDays(dayKey, n) {
    var d = new Date(dayKey + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return EDB.dayKey(d);
  }

  /* 新条目入队：当天先见一次 */
  function create(itemId, itemType, label) {
    var today = EDB.dayKey();
    var rev = {
      id: EDB.uid(),
      itemId: itemId, itemType: itemType, label: label || '',
      step: 0, streak: 0,
      dueDay: today, state: 'active',
      rule: '新学：当日首次复习',
      lastGrade: null, lastAt: null,
      created_at: EDB.nowIso(), updated_at: EDB.nowIso()
    };
    return EDB.put('reviews', rev).then(function () { return rev; });
  }

  function dueToday() {
    var today = EDB.dayKey();
    return EDB.getAll('reviews').then(function (rows) {
      return rows.filter(function (r) { return r.state === 'active' && r.dueDay <= today; })
        .sort(function (a, b) {
          /* 错误与到期早的优先 */
          var pri = { mistake: 0, pronunciation: 1, listening: 1, expression: 2, vocabulary: 3, grammar: 4 };
          return (pri[a.itemType] - pri[b.itemType]) || (a.dueDay < b.dueDay ? -1 : 1);
        });
    });
  }

  function countDue() {
    return dueToday().then(function (r) { return r.length; });
  }

  /**
   * grade · 判定（确定性规则）
   * outcome: 'again'（没想起来/用错）| 'hard'（想起来了但很费劲/提示后正确）| 'good'（独立正确）
   * 返回更新后的 review；mastery 的升降由调用方按证据规则处理（这里只管排期）
   */
  function grade(review, outcome) {
    var today = EDB.dayKey();
    var r = Object.assign({}, review);
    r.lastGrade = outcome;
    r.lastAt = EDB.nowIso();

    if (outcome === 'again') {
      r.step = 1;                       /* 回到 1 天后 */
      r.streak = 0;
      r.dueDay = addDays(today, INTERVALS[1]);
      r.rule = '没想起来：回到 1 天后复习';
    } else if (outcome === 'hard') {
      r.streak = 0;
      r.dueDay = addDays(today, Math.max(1, INTERVALS[Math.min(r.step, INTERVALS.length - 1)] || 1));
      r.rule = '提示后正确：同间隔再练一次';
    } else { /* good */
      r.streak = (r.streak || 0) + 1;
      var crossDay = r.lastDue && r.lastDue < today;
      if (r.step >= INTERVALS.length - 1) {
        /* 已在 14 天档：跨天连续正确则保持 14 天滚动，否则原地 */
        r.dueDay = addDays(today, crossDay && r.streak >= 2 ? 14 : 14);
        r.rule = crossDay ? '跨天连续正确：保持 14 天间隔' : '正确：14 天后再巩固';
      } else {
        r.step = r.step + 1;
        r.dueDay = addDays(today, INTERVALS[r.step]);
        r.rule = '独立正确：进入 ' + INTERVALS[r.step] + ' 天间隔';
      }
    }
    r.lastDue = today;
    r.updated_at = EDB.nowIso();
    return EDB.put('reviews', r).then(function () { return r; });
  }

  /* 完结（错误已解决 / 词条 mastery=5 后长期巩固仍保留但降频） */
  function resolve(review) {
    var r = Object.assign({}, review, { state: 'resolved', rule: '已解决：退出复习队列', updated_at: EDB.nowIso() });
    return EDB.put('reviews', r).then(function () { return r; });
  }

  /* 同一对象的现有复习（避免重复建） */
  function byItem(itemId) {
    return EDB.byIndex('reviews', 'byItem', itemId).then(function (rows) {
      return (rows || []).filter(function (r) { return r.state === 'active'; })[0] || null;
    });
  }

  /* mastery 证据升降（0-5，规则见数据模型文档第三节）
   * evidence: 'reading_recognize' | 'listening_recognize' | 'produce' | 'use_in_conversation' | 'error'
   */
  var EVIDENCE_LEVEL = {
    reading_recognize: 2,
    listening_recognize: 3,
    produce: 4,
    use_in_conversation: 5
  };
  function applyMastery(item, evidence) {
    var it = Object.assign({}, item);
    if (evidence === 'error') {
      if (it.mastery > 1) it.mastery = it.mastery - 1;
      it.mastery_evidence = (it.mastery_evidence || []).concat([{ level: it.mastery, evidence: 'error_downgrade', when: EDB.nowIso() }]);
      it.rule_note = '用错：掌握度降 1 级并重新入队';
    } else {
      var target = EVIDENCE_LEVEL[evidence] || 1;
      /* 只升不跳：新证据等级比当前高才升 1 级（不直接跳到证据等级，防单次侥幸） */
      if (target > it.mastery) {
        it.mastery = Math.min(target, it.mastery + 1);
        it.mastery_evidence = (it.mastery_evidence || []).concat([{ level: it.mastery, evidence: evidence, when: EDB.nowIso() }]);
        it.rule_note = '新证据：掌握度升 1 级（' + evidence + '）';
      }
    }
    it.last_seen = EDB.nowIso();
    it.updated_at = EDB.nowIso();
    return it;
  }

  window.ECR = {
    INTERVALS: INTERVALS, TYPES: TYPES, TYPE_CN: TYPE_CN,
    create: create, dueToday: dueToday, countDue: countDue,
    grade: grade, resolve: resolve, byItem: byItem,
    applyMastery: applyMastery
  };
})();
