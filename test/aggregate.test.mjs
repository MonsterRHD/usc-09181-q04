import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  decide,
  fold,
  REQUIRED_MATERIAL_TYPES,
} from '../src/domain/aggregate.mjs';
import { APPLICATION_STATUS, ROLES } from '../src/domain/events.mjs';
import { MATERIAL_TYPES } from '../src/domain/rules.mjs';
import { DomainError } from '../src/domain/errors.mjs';

const ANALYST = { userId: 'ana', roles: [ROLES.ANALYST] };
const APPROVER = { userId: 'app', roles: [ROLES.APPROVER] };
const SYSTEM = { userId: 'sys', roles: [ROLES.SYSTEM] };

/** 确定性假分析器：复刻 createAnalysisRunner 的契约，规则可预测。 */
function fakeRunner() {
  return ({ modelVersion, input }) => ({
    modelVersion,
    snapshotHash: `snap-${modelVersion}-${JSON.stringify(input).length}`,
    score: 0,
    bucket: 'REJECT',
    warnings: [],
    snapshotRecord: { snapshotHash: 'x', modelVersion, input },
  });
}

function openSut() {
  let state = initialState();
  const run = (command, deps = { runAnalysis: fakeRunner() }) => {
    const decision = decide(state, command, deps);
    const events = Array.isArray(decision) ? decision : decision.events ?? [];
    state = fold(events, state);
    return { events, state, meta: Array.isArray(decision) ? {} : decision };
  };
  const open = () =>
    run({
      type: 'openApplication',
      applicationId: 'A1',
      customerId: 'C1',
      modelVersion: 'm-1',
      actor: ANALYST,
    });
  return { run, open, get state() { return state; } };
}

function fin(content = { debtToAssetRatio: 0.9 }) {
  return {
    type: 'submitMaterial',
    actor: ANALYST,
    materialType: MATERIAL_TYPES.FINANCIAL_REPORT,
    content,
    contentHash: 'h',
  };
}
function man(content = { item: '核验', result: 'FAIL' }) {
  return {
    type: 'submitMaterial',
    actor: ANALYST,
    materialType: MATERIAL_TYPES.MANUAL_VERIFICATION,
    content,
    contentHash: 'h',
  };
}

test('未开立的申请拒绝一切命令', () => {
  assert.throws(() => decide(initialState(), { type: 'withdraw', actor: APPROVER }), /不存在/);
});

test('缺少关键材料时分析被拒，只能走补件', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin()); // 只有财报，缺人工核验
  assert.throws(
    () => sut.run({ type: 'recordAnalysis', actor: ANALYST }),
    (err) => err instanceof DomainError && err.code === 'MISSING_REQUIRED_MATERIALS'
  );
  const { events } = sut.run({
    type: 'requestSupplement',
    actor: ANALYST,
    requiredItems: ['人工核验结果'],
  });
  assert.equal(events[0].type, 'SUPPLEMENT_REQUESTED');
  assert.equal(sut.state.status, APPLICATION_STATUS.OPEN);
  assert.equal(sut.state.versions.size, 2);
});

test('补件开立新版本并结转既有材料，外部信号不重复结转', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  sut.run({
    type: 'ingestExternalSignal',
    actor: SYSTEM,
    dedupeKey: 'S|1',
    content: { source: 'S', signalType: 'X', severity: 'HIGH' },
  });
  const { events, state } = sut.run({
    type: 'requestSupplement',
    actor: ANALYST,
    requiredItems: ['补充说明'],
  });
  const carried = events.filter(
    (e) => e.type === 'MATERIAL_SUBMITTED' && e.payload.carriedFromVersionId
  );
  assert.equal(carried.length, 2, '财报+核验结转，外部信号不结转');
  const v2 = [...state.versions.values()].at(-1);
  assert.equal(v2.materials.size, 2);
  assert.ok([...v2.materials.values()].every((m) => m.carriedFromVersionId));
});

test('待确认期间补充新证据会退回 OPEN，旧意见保留不删改', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  sut.run({ type: 'recordAnalysis', actor: ANALYST });
  sut.run({ type: 'submitOpinion', actor: ANALYST, decision: 'APPROVE' });
  assert.equal(sut.state.status, APPLICATION_STATUS.AWAITING_CONFIRMATION);
  const v1 = [...sut.state.versions.values()][0];
  assert.equal(v1.opinions.length, 1);

  sut.run({
    type: 'submitMaterial',
    actor: APPROVER,
    materialType: MATERIAL_TYPES.MANUAL_VERIFICATION,
    content: { item: '新核查', result: 'FAIL' },
    contentHash: 'h2',
  });
  assert.equal(sut.state.status, APPLICATION_STATUS.OPEN);
  const v1after = [...sut.state.versions.values()][0];
  assert.equal(v1after.opinions.length, 1, '旧意见仍在');
  assert.deepEqual(v1after.opinions[0].decision, 'APPROVE', '内容未被改写');
});

test('待确认期间禁止重新分析（模型重跑不得静默扰动意见）', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  sut.run({ type: 'recordAnalysis', actor: ANALYST });
  sut.run({ type: 'submitOpinion', actor: ANALYST, decision: 'APPROVE' });
  assert.throws(
    () => sut.run({ type: 'recordAnalysis', actor: ANALYST }),
    /待确认意见/
  );
});

test('只有 APPROVER 能确认最终结论；分析员无权', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  sut.run({ type: 'recordAnalysis', actor: ANALYST });
  sut.run({ type: 'submitOpinion', actor: ANALYST, decision: 'REJECT' });
  assert.throws(
    () => sut.run({ type: 'confirmDecision', actor: ANALYST }),
    /审批权限/
  );
  const { state } = sut.run({ type: 'confirmDecision', actor: APPROVER });
  assert.equal(state.status, APPLICATION_STATUS.CONFIRMED);
});

test('撤回后：材料/分析/意见全部拒绝；外部信号只留最小审计事实且不重算', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run({ type: 'withdraw', actor: APPROVER, reason: '客户撤销' });
  assert.equal(sut.state.status, APPLICATION_STATUS.WITHDRAWN);

  assert.throws(() => sut.run(man()), /已撤回/);
  assert.throws(() => sut.run({ type: 'recordAnalysis', actor: ANALYST }), /已撤回/);
  assert.throws(() => sut.run({ type: 'submitOpinion', actor: ANALYST, decision: 'APPROVE' }), /已撤回/);

  const { events, meta } = sut.run({
    type: 'ingestExternalSignal',
    actor: SYSTEM,
    dedupeKey: 'S|LATE',
    content: { source: 'S', signalType: 'X', severity: 'HIGH' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'EXTERNAL_SIGNAL_IGNORED');
  assert.equal(meta.ignored, true);
  assert.equal(meta.autoAnalyze, undefined);
  assert.equal(sut.state.versions.size, 1, '未产生任何版本/材料变化');
  assert.equal([...sut.state.versions.values()][0].materials.size, 1);
});

test('重复外部信号回调幂等：不产生事件', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  const first = sut.run({
    type: 'ingestExternalSignal',
    actor: SYSTEM,
    dedupeKey: 'S|1',
    content: { source: 'S', signalType: 'X', severity: 'LOW' },
  });
  assert.ok(first.meta.autoAnalyze);
  const revBefore = sut.state.revision;
  const second = sut.run({
    type: 'ingestExternalSignal',
    actor: SYSTEM,
    dedupeKey: 'S|1',
    content: { source: 'S', signalType: 'X', severity: 'LOW' },
  });
  assert.equal(second.events.length, 0);
  assert.equal(second.meta.deduped, true);
  assert.equal(sut.state.revision, revBefore);
});

test('外部信号在申请级跨版本去重', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  sut.run({
    type: 'ingestExternalSignal',
    actor: SYSTEM,
    dedupeKey: 'S|1',
    content: { source: 'S', signalType: 'X', severity: 'LOW' },
  });
  sut.run({ type: 'requestSupplement', actor: ANALYST, requiredItems: ['x'] });
  const second = sut.run({
    type: 'ingestExternalSignal',
    actor: SYSTEM,
    dedupeKey: 'S|1',
    content: { source: 'S', signalType: 'X', severity: 'LOW' },
  });
  assert.equal(second.meta.deduped, true);
  assert.equal(second.events.length, 0);
});

test('已终结（CONFIRMED）后到达的信号只记审计事实', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  sut.run({ type: 'recordAnalysis', actor: ANALYST });
  sut.run({ type: 'submitOpinion', actor: ANALYST, decision: 'APPROVE' });
  sut.run({ type: 'confirmDecision', actor: APPROVER });
  const { events, meta } = sut.run({
    type: 'ingestExternalSignal',
    actor: SYSTEM,
    dedupeKey: 'S|2',
    content: { source: 'S', signalType: 'X', severity: 'HIGH' },
  });
  assert.equal(meta.ignored, true);
  assert.equal(events[0].payload.reason, 'CONFIRMED');
});

test('同一快照+模型版本的重复分析幂等', () => {
  const sut = openSut();
  sut.open();
  sut.run(fin());
  sut.run(man());
  const a1 = sut.run({ type: 'recordAnalysis', actor: ANALYST });
  assert.equal(a1.events.length, 1);
  const a2 = sut.run({ type: 'recordAnalysis', actor: ANALYST });
  assert.equal(a2.events.length, 0);
  assert.equal(a2.meta.idempotent, true);
});

test('无角色者不能补证据', () => {
  const sut = openSut();
  sut.open();
  assert.throws(
    () =>
      sut.run({
        type: 'submitMaterial',
        actor: { userId: 'x', roles: [] },
        materialType: MATERIAL_TYPES.FINANCIAL_REPORT,
        content: { debtToAssetRatio: 0.5 },
        contentHash: 'h',
      }),
    /审查岗/
  );
});

test('非法材料被校验拒绝', () => {
  const sut = openSut();
  sut.open();
  assert.throws(
    () =>
      sut.run({
        type: 'submitMaterial',
        actor: ANALYST,
        materialType: MATERIAL_TYPES.FINANCIAL_REPORT,
        content: { debtToAssetRatio: 2 },
        contentHash: 'h',
      }),
    /0~1/
  );
  assert.throws(
    () =>
      sut.run({
        type: 'ingestExternalSignal',
        actor: SYSTEM,
        dedupeKey: '',
        content: { source: 'S', signalType: 'X', severity: 'HIGH' },
      }),
    /dedupeKey/
  );
});

test('必需材料类型集合稳定', () => {
  assert.deepEqual([...REQUIRED_MATERIAL_TYPES].sort(), ['FINANCIAL_REPORT', 'MANUAL_VERIFICATION']);
});
