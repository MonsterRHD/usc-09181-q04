/**
 * 事件类型目录。事件一经 append 即不可修改——这是“模型重跑不得静默改写已提交意见”
 * 和“按申请重放”的根基。新增行为只能新增事件类型，不得改动既有事件的 payload 结构。
 */
export const EVENT_TYPES = Object.freeze({
  APPLICATION_OPENED: 'APPLICATION_OPENED',
  MATERIAL_SUBMITTED: 'MATERIAL_SUBMITTED',
  ANALYSIS_RECORDED: 'ANALYSIS_RECORDED',
  OPINION_SUBMITTED: 'OPINION_SUBMITTED',
  SUPPLEMENT_REQUESTED: 'SUPPLEMENT_REQUESTED',
  DECISION_CONFIRMED: 'DECISION_CONFIRMED',
  APPLICATION_WITHDRAWN: 'APPLICATION_WITHDRAWN',
  EXTERNAL_SIGNAL_IGNORED: 'EXTERNAL_SIGNAL_IGNORED',
});

export const APPLICATION_STATUS = Object.freeze({
  OPEN: 'OPEN', // 当前版本可补充证据 / 分析
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION', // 分析员已提交意见，待有权限角色确认
  CONFIRMED: 'CONFIRMED', // 终态：最终结论已确认
  WITHDRAWN: 'WITHDRAWN', // 终态：撤回，停止一切新计算
});

export const DECISIONS = Object.freeze({
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  NEED_SUPPLEMENT: 'NEED_SUPPLEMENT',
});

export const ROLES = Object.freeze({
  ANALYST: 'ANALYST', // 可补证据、提交意见
  APPROVER: 'APPROVER', // 额外可确认最终结论、撤回
  SYSTEM: 'SYSTEM', // 外部回调入口
});
