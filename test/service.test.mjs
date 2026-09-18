import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/domain/eventStore.mjs';
import { CreditEvidenceService } from '../src/domain/service.mjs';
import { replayApplication, toView } from '../src/domain/aggregate.mjs';

/** 断言抛错并返回错误对象，便于继续检查 code/details。 */
function throws(fn, match) {
  try {
    fn();
  } catch (e) {
    if (match instanceof RegExp && !match.test(e.message)) {
      throw new assert.AssertionError({ message: `错误信息不匹配 ${match}：${e.message}` });
    }
    return e;
  }
  throw new assert.AssertionError({ message: '预期函数抛错，但未抛出' });
}

function harness() {
  const store = new EventStore(null);
  const service = new CreditEvidenceService(store);
  const APPROVER = { id: 'a1', role: 'APPROVER' };
  const REVIEWER = { id: 'r1', role: 'REVIEWER' };
  const REVIEWER2 = { id: 'r2', role: 'REVIEWER' };
  const APPLICANT = { id: 'cust', role: 'APPLICANT' };

  function openApp() {
    return service.openApplication({ customerId: 'CUST-1', actor: APPLICANT }).applicationId;
  }

  function goodFinancials(app, overrides = {}, version) {
    return service.addEvidence(app, {
      kind: 'FINANCIAL_SUMMARY',
      source: 'Bloomberg filing 2025FY',
      fiscalPeriod: '2025FY',
      currency: 'USD',
      fields: { currentRatio: 1.2, debtToEquity: 1.1, netProfitMargin: 0.08, ...overrides },
      actor: REVIEWER,
      version,
    });
  }

  function verifyAll(app, finId, { result = 'PASS' } = {}, version) {
    for (const item of ['currentRatio', 'debtToEquity', 'netProfitMargin']) {
      service.addEvidence(app, {
        kind: 'MANUAL_VERIFICATION',
        item,
        result,
        verifier: 'r1',
        financialEvidenceId: finId,
        actor: REVIEWER,
        version,
      });
    }
  }

  return { store, service, APPROVER, REVIEWER, REVIEWER2, APPLICANT, openApp, goodFinancials, verifyAll };
}

test('完整通过流程：每条预警都指向输入快照与规则版本', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER } = harness();
  const app = openApp();

  const fin = goodFinancials(app, { currentRatio: 0.7 }); // 触发低流动比率
  verifyAll(app, fin.evidenceId);

  // 一个迟到的制裁信号在跑批之前到达，应被纳入快照
  service.recordSignal(app, {
    signalId: 'sig-1', type: 'SANCTION', source: 'OFAC feed',
    observedAt: '2026-09-17T00:00:00Z', detail: '名字相似命中',
  });

  const { batchId } = service.requestRun(app, { actor: APPROVER });
  const cb = service.recordModelResult(app, {
    batchId, score: 610, callbackId: 'cb-1', actor: { role: 'SYSTEM', id: 'model' },
  });

  const ruleIds = cb.warnings.map((w) => w.ruleId).sort();
  assert.deepEqual(ruleIds, ['R_CURRENT_RATIO_LOW', 'R_SANCTION_MATCH']);
  for (const w of cb.warnings) {
    assert.equal(w.rulePackVersion, 'risk-rules-2026.01');
    assert.match(w.warningId, new RegExp(`^${batchId}:`));
    assert.ok(w.evidenceRefs.length > 0);
  }
  const sanction = cb.warnings.find((w) => w.ruleId === 'R_SANCTION_MATCH');
  assert.deepEqual(sanction.evidenceRefs, ['signal:sig-1']);

  const view = toView(service.state(app));
  const v1 = view.versions[0];
  assert.equal(v1.status, 'READY_TO_REVIEW');
  assert.equal(v1.batches[0].evidenceStateHash.length, 64);
});

test('缺少关键材料只能进入补件：补件开新版本并沿用旧材料', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER, REVIEWER } = harness();
  const app = openApp();

  // 只有财报，没有人工核验
  const fin = goodFinancials(app);
  let err = throws(() => service.requestRun(app, { actor: APPROVER }));
  assert.equal(err.code, 'MISSING_MATERIALS');
  assert.ok(err.details.completeness.missing.some((m) => m.startsWith('MANUAL_VERIFICATION')));

  const sup = service.requestSupplement(app, { reason: '缺少三表人工核验', actor: APPROVER, idempotencyKey: 'sup-1' });
  assert.equal(sup.version, 'v2');
  assert.equal(sup.parentVersion, 'v1');

  // 旧版本不能再补证据/重跑
  err = throws(() => goodFinancials(app, {}, 'v1'));
  assert.equal(err.code, 'VERSION_SUPERSEDED');

  // 新版本继承 v1 财报，只需补核验
  verifyAll(app, fin.evidenceId, {}, 'v2');
  const state = service.state(app);
  assert.equal(state.currentVersion, 'v2');
  const { batchId } = service.requestRun(app, { actor: APPROVER });
  assert.match(batchId, /:v2:run-1$/);

  // 补件请求重试幂等：不会再开 v3
  const retry = service.requestSupplement(app, { reason: '缺少三表人工核验', actor: APPROVER, idempotencyKey: 'sup-1' });
  assert.equal(retry.version, 'v2');
  assert.equal(retry.duplicate, true);
  assert.equal(service.state(app).currentVersion, 'v2');
});

test('补件后换了财报：旧核验不再算作新财报的证据', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER } = harness();
  const app = openApp();
  const fin1 = goodFinancials(app);
  verifyAll(app, fin1.evidenceId);
  service.requestSupplement(app, { reason: '客户提交了更新年报', actor: APPROVER, idempotencyKey: 's' });
  goodFinancials(app, {}, 'v2');
  const err = throws(() => service.requestRun(app, { actor: APPROVER }));
  assert.equal(err.code, 'MISSING_MATERIALS');
  assert.ok(err.details.completeness.missing.every((m) => m.startsWith('MANUAL_VERIFICATION')));
});

test('重复回调幂等：不二次落账，结果完全一致', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER } = harness();
  const app = openApp();
  const fin = goodFinancials(app, { currentRatio: 0.5 });
  verifyAll(app, fin.evidenceId);
  const { batchId } = service.requestRun(app, { actor: APPROVER });

  const cb1 = service.recordModelResult(app, { batchId, score: 500, callbackId: 'cb-x' });
  const cb2 = service.recordModelResult(app, { batchId, score: 999, callbackId: 'cb-x' });
  const cb3 = service.recordModelResult(app, { batchId, score: 999, callbackId: 'cb-x' });
  assert.equal(cb1.duplicate, false);
  assert.equal(cb2.duplicate, true);
  assert.equal(cb2.score, 500); // 篡改 score 的重发不生效
  assert.deepEqual(cb2.warnings, cb1.warnings);

  const events = service.store.stream(app).filter((e) => e.type === 'MODEL_RESULT_RECORDED');
  assert.equal(events.length, 1);
});

test('迟到外部信号：不改写历史批次，但使旧批次失效，结论必须基于新批次', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER } = harness();
  const app = openApp();
  const fin = goodFinancials(app);
  verifyAll(app, fin.evidenceId);

  const r1 = service.requestRun(app, { actor: APPROVER, idempotencyKey: 'run-1' });
  service.recordModelResult(app, { batchId: r1.batchId, score: 720, callbackId: 'cb-1' });

  // 此时可以决定
  const dec1 = service.confirmDecision(app, {
    outcome: 'APPROVE', rationale: '指标正常无预警', actor: APPROVER, idempotencyKey: 'dec-1',
  });
  assert.equal(dec1.duplicate, false);
  assert.equal(dec1.decision.batchId, r1.batchId);

  // 决定后的迟到信号：照样留痕，但不改变已确认结论
  const sig = service.recordSignal(app, { signalId: 'sig-late', type: 'WATCHLIST', source: 'dnb' });
  assert.equal(sig.afterDecision, true);
  assert.equal(service.state(app).decision.batchId, r1.batchId);

  // 已决定后不允许再改
  throws(() => service.requestRun(app, { actor: APPROVER }), /不可篡改/);
});

test('信号在决定前迟到：证据哈希变化，必须重跑，禁止用旧批次出结论', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER } = harness();
  const app = openApp();
  const fin = goodFinancials(app);
  verifyAll(app, fin.evidenceId);
  const r1 = service.requestRun(app, { actor: APPROVER, idempotencyKey: 'run-1' });
  service.recordModelResult(app, { batchId: r1.batchId, score: 720, callbackId: 'cb-1' });

  service.recordSignal(app, { signalId: 'sig-2', type: 'SANCTION', source: 'OFAC' });
  const err = throws(() => service.confirmDecision(app, {
    outcome: 'REJECT', rationale: '制裁命中', actor: APPROVER,
  }));
  assert.equal(err.code, 'STALE_BATCH');

  // 重跑后新批次纳入信号
  const r2 = service.requestRun(app, { actor: APPROVER, idempotencyKey: 'run-2' });
  const cb2 = service.recordModelResult(app, { batchId: r2.batchId, score: 400, callbackId: 'cb-2' });
  assert.ok(cb2.warnings.some((w) => w.ruleId === 'R_SANCTION_MATCH'));

  const dec = service.confirmDecision(app, {
    outcome: 'REJECT', rationale: '制裁名单命中，拒绝授信', actor: APPROVER, idempotencyKey: 'dec-2',
  });
  assert.equal(dec.decision.batchId, r2.batchId);
  assert.deepEqual(dec.decision.warningIds, cb2.warnings.map((w) => w.warningId));

  // 决定重试幂等
  const retry = service.confirmDecision(app, {
    outcome: 'APPROVE', rationale: '试图翻案', actor: APPROVER, idempotencyKey: 'dec-2',
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.decision.outcome, 'REJECT');
});

test('撤回：停止新计算，在途批次回调只保留最小审计事实', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER, APPLICANT } = harness();
  const app = openApp();
  const fin = goodFinancials(app);
  verifyAll(app, fin.evidenceId);
  const r1 = service.requestRun(app, { actor: APPROVER });

  service.withdraw(app, { reason: '客户主动撤销', actor: APPLICANT, idempotencyKey: 'w-1' });

  // 一切新计算被拒绝
  throws(() => service.requestRun(app, { actor: APPROVER }), /已撤回/);
  // 撤回后到达的证据不再进入业务流，只作为最小审计事实留存
  const lateEvidence = goodFinancials(app);
  assert.equal(lateEvidence.accepted, 'LATE_FACT');
  assert.equal(lateEvidence.kind, 'EVIDENCE');

  // 在途批次的回调到达：不落业务结果，只留 LATE_FACT
  const late = service.recordModelResult(app, { batchId: r1.batchId, score: 720, callbackId: 'cb-late' });
  assert.equal(late.accepted, 'LATE_FACT');
  assert.equal(late.kind, 'MODEL_RESULT');
  assert.equal(late.reason.includes('撤回'), true);
  assert.equal(late.duplicate, false);

  // 迟到信号同样只留最小事实（只存哈希，不进证据包）
  const lateSig = service.recordSignal(app, { signalId: 'sig-x', type: 'ADVERSE_MEDIA', source: 'news' });
  assert.equal(lateSig.accepted, 'LATE_FACT');

  const state = service.state(app);
  assert.equal(state.status, 'WITHDRAWN');
  assert.equal(state.batches[r1.batchId].status, 'ABANDONED');
  assert.equal(state.signals.length, 0); // 原始信号未入业务流
  assert.equal(state.lateFacts.length, 3); // 迟到证据 + 迟到回调 + 迟到信号
  for (const f of state.lateFacts) assert.equal(f.payloadHash.length, 64);

  // 撤回重试幂等
  const w2 = service.withdraw(app, { reason: '再撤一次', actor: APPLICANT, idempotencyKey: 'w-1' });
  assert.equal(w2.duplicate, true);
});

test('权限：REVIEWER 可并行补证据，但只有 APPROVER 能确认结论', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER, REVIEWER, REVIEWER2 } = harness();
  const app = openApp();

  // 两名审批人并行补充不同材料（交错提交）
  const fin = goodFinancials(app, { currentRatio: 1.2 }, );
  service.addEvidence(app, {
    kind: 'MANUAL_VERIFICATION', item: 'currentRatio', result: 'PASS',
    financialEvidenceId: fin.evidenceId, actor: REVIEWER, idempotencyKey: 'k1',
  });
  service.addEvidence(app, {
    kind: 'MANUAL_VERIFICATION', item: 'debtToEquity', result: 'PASS',
    financialEvidenceId: fin.evidenceId, actor: REVIEWER2, idempotencyKey: 'k2',
  });
  service.addEvidence(app, {
    kind: 'MANUAL_VERIFICATION', item: 'netProfitMargin', result: 'PASS',
    financialEvidenceId: fin.evidenceId, actor: REVIEWER, idempotencyKey: 'k3',
  });

  const r = service.requestRun(app, { actor: REVIEWER });
  service.recordModelResult(app, { batchId: r.batchId, score: 700, callbackId: 'cb' });

  const err = throws(() => service.confirmDecision(app, {
    outcome: 'APPROVE', rationale: '我觉得行', actor: REVIEWER,
  }));
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.status, 403);

  // APPLICANT 也不能
  const errApplicant = throws(() => service.confirmDecision(app, {
    outcome: 'APPROVE', rationale: '自批', actor: { id: 'cust', role: 'APPLICANT' },
  }));
  assert.equal(errApplicant.code, 'FORBIDDEN');

  const dec = service.confirmDecision(app, { outcome: 'APPROVE', rationale: '审批人确认', actor: APPROVER });
  assert.equal(dec.decision.outcome, 'APPROVE');
});

test('模型重跑不得静默改写已提交意见：意见挂在具体预警上', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER, REVIEWER } = harness();
  const app = openApp();
  const fin = goodFinancials(app, { currentRatio: 0.6 });
  verifyAll(app, fin.evidenceId);

  const r1 = service.requestRun(app, { actor: APPROVER, idempotencyKey: 'run-1' });
  const cb1 = service.recordModelResult(app, { batchId: r1.batchId, score: 500, callbackId: 'cb-1' });
  const w1 = cb1.warnings.find((w) => w.ruleId === 'R_CURRENT_RATIO_LOW');

  service.addWarningNote(app, {
    warningId: w1.warningId, content: '已核实：客户提供了授信余额补救说明，可接受',
    actor: REVIEWER, idempotencyKey: 'note-1',
  });

  // 新增证据触发重跑（新版本）
  service.requestSupplement(app, { reason: '补充说明材料', actor: APPROVER, idempotencyKey: 'sup' });
  goodFinancials(app, { currentRatio: 1.5 }, 'v2');
  verifyAll(app, fin.evidenceId, {}, 'v2'); // 注意：核验指向旧财报，新财报仍需核验
  const fin2 = service.state(app).versions.v2.evidence.find((e) => e.kind === 'FINANCIAL_SUMMARY');
  for (const item of ['currentRatio', 'debtToEquity', 'netProfitMargin']) {
    service.addEvidence(app, {
      kind: 'MANUAL_VERIFICATION', item, result: 'PASS',
      financialEvidenceId: fin2.evidenceId, actor: REVIEWER,
    });
  }
  const r2 = service.requestRun(app, { actor: APPROVER, idempotencyKey: 'run-2' });
  const cb2 = service.recordModelResult(app, { batchId: r2.batchId, score: 760, callbackId: 'cb-2' });

  // 新批次不再有低流动比率预警；旧预警和旧意见在 v1 批次上原样可查
  assert.ok(!cb2.warnings.some((w) => w.ruleId === 'R_CURRENT_RATIO_LOW'));
  const state = service.state(app);
  assert.equal(state.notes[w1.warningId].length, 1);
  assert.match(state.notes[w1.warningId][0].content, /授信余额补救说明/);
});

test('FAIL 的人工核验属于关键核对失败，不能进入计算', () => {
  const { service, openApp, goodFinancials, APPROVER, REVIEWER } = harness();
  const app = openApp();
  const fin = goodFinancials(app);
  service.addEvidence(app, {
    kind: 'MANUAL_VERIFICATION', item: 'currentRatio', result: 'FAIL',
    financialEvidenceId: fin.evidenceId, actor: REVIEWER,
  });
  for (const item of ['debtToEquity', 'netProfitMargin']) {
    service.addEvidence(app, {
      kind: 'MANUAL_VERIFICATION', item, result: 'PASS',
      financialEvidenceId: fin.evidenceId, actor: REVIEWER,
    });
  }
  const err = throws(() => service.requestRun(app, { actor: APPROVER }));
  assert.equal(err.code, 'MISSING_MATERIALS');
  assert.deepEqual(err.details.completeness.failedChecks.map((f) => f.field), ['currentRatio']);
});

test('未知模型版本/规则版本被拒绝', () => {
  const { service, openApp, goodFinancials, verifyAll, APPROVER } = harness();
  const app = openApp();
  const fin = goodFinancials(app);
  verifyAll(app, fin.evidenceId);
  const e1 = throws(
    () => service.requestRun(app, { actor: APPROVER, modelVersion: 'credit-model-9.9' }),
  );
  assert.equal(e1.code, 'UNKNOWN_MODEL_VERSION');
  const e2 = throws(
    () => service.requestRun(app, { actor: APPROVER, rulePackVersion: 'risk-rules-2099.99' }),
  );
  assert.equal(e2.code, 'UNKNOWN_RULE_PACK');
});

test('事件流纯函数重放：删掉内存状态重放结果一致', () => {
  const { service, store, openApp, goodFinancials, verifyAll, APPROVER } = harness();
  const app = openApp();
  const fin = goodFinancials(app);
  verifyAll(app, fin.evidenceId);
  service.recordSignal(app, { signalId: 's1', type: 'WATCHLIST', source: 'x' });
  const r = service.requestRun(app, { actor: APPROVER });
  service.recordModelResult(app, { batchId: r.batchId, score: 650, callbackId: 'cb' });

  const live = JSON.stringify(toView(service.state(app)));
  const replayed = JSON.stringify(toView(replayApplication(store.stream(app))));
  assert.equal(replayed, live);
});
