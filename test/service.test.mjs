import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/main.mjs';
import { projectReplay, projectEvidencePackage } from '../src/application/projection.mjs';
import { DEFAULT_MODEL_VERSION } from '../src/domain/model.mjs';
import { MATERIAL_TYPES } from '../src/domain/rules.mjs';
import { ROLES } from '../src/domain/events.mjs';

const ANALYST = { userId: 'ana', roles: [ROLES.ANALYST] };
const APPROVER = { userId: 'app', roles: [ROLES.APPROVER] };

async function freshApp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'svc-'));
  const app = await createApp({ dataDir: dir });
  return { ...app, dir };
}

async function seedReadyApplication(service, id = 'A1') {
  await service.openApplication({
    applicationId: id,
    customerId: 'C1',
    modelVersion: DEFAULT_MODEL_VERSION,
    actor: ANALYST,
  });
  await service.submit(id, {
    type: 'submitMaterial',
    actor: ANALYST,
    materialType: MATERIAL_TYPES.FINANCIAL_REPORT,
    content: { debtToAssetRatio: 0.92, netProfit: -100 },
    contentHash: 'fin',
  });
  await service.submit(id, {
    type: 'submitMaterial',
    actor: ANALYST,
    materialType: MATERIAL_TYPES.MANUAL_VERIFICATION,
    content: { item: '贸易背景', result: 'FAIL', note: '缺单' },
    contentHash: 'man',
  });
}

test('模型与规则对同一快照确定：两次分析结果逐字节一致', async () => {
  const { service } = await freshApp();
  await seedReadyApplication(service);
  const r1 = await service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  const p1 = r1.events[0].payload;
  await seedReadyApplication(service, 'A2');
  const r2 = await service.submit('A2', { type: 'recordAnalysis', actor: ANALYST });
  const p2 = r2.events[0].payload;
  assert.equal(p1.snapshotHash, p2.snapshotHash);
  assert.equal(p1.score, p2.score);
  assert.equal(p1.bucket, p2.bucket);
  // 预警的业务内容逐字节一致；材料 ID 是各申请独立生成的随机标识，不参与可比性。
  const strip = (w) => ({ ...w, evidenceMaterialIds: w.evidenceMaterialIds.map(() => 'M') });
  assert.deepEqual(p1.warnings.map(strip), p2.warnings.map(strip));
});

test('每条预警都锚定输入快照、规则版本与触发材料', async () => {
  const { service, snapshotStore } = await freshApp();
  await seedReadyApplication(service);
  const { events } = await service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  const warnings = events[0].payload.warnings;
  assert.ok(warnings.length >= 3);
  for (const w of warnings) {
    assert.match(w.ruleId, /^[A-Z_]+_\d+$/);
    assert.match(w.ruleVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(w.snapshotHash.length === 64);
    assert.ok(w.evidenceMaterialIds.length >= 1 || w.ruleId === 'MODEL_POLICY_001');
  }
  const snap = await snapshotStore.get(events[0].payload.snapshotHash);
  assert.ok(snap);
  assert.equal(snap.modelVersion, DEFAULT_MODEL_VERSION);
  assert.deepEqual(snap.input.financialSummary, { debtToAssetRatio: 0.92, netProfit: -100 });
});

test('重放给出当时结论依据：快照输入+模型版本+规则版本+意见', async () => {
  const { service, snapshotStore } = await freshApp();
  await seedReadyApplication(service);
  await service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  await service.submit('A1', {
    type: 'submitOpinion',
    actor: ANALYST,
    decision: 'REJECT',
    rationale: '负债率与核验双红灯',
  });
  await service.submit('A1', { type: 'confirmDecision', actor: APPROVER });
  const { state } = await service.loadState('A1');
  const replay = await projectReplay(state, { snapshotLookup: (h) => snapshotStore.get(h) });
  assert.equal(replay.finalStatus, 'CONFIRMED');
  assert.equal(replay.decisionExplanation.decision, 'REJECT');
  assert.ok(replay.decisionExplanation.basedOn.snapshotInput);
  assert.equal(replay.decisionExplanation.basedOn.modelVersion, DEFAULT_MODEL_VERSION);
  assert.ok(replay.decisionExplanation.opinion.rationale, '负债率与核验双红灯');
});

test('服务重启后重放事件完整恢复，且哈希链校验通过', async () => {
  const app1 = await freshApp();
  await seedReadyApplication(app1.service);
  await app1.service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  await app1.service.submit('A1', { type: 'submitOpinion', actor: ANALYST, decision: 'REJECT' });
  await app1.service.submit('A1', { type: 'confirmDecision', actor: APPROVER });
  const dir = app1.dir;
  const revBefore = (await app1.service.loadState('A1')).state.revision;

  // 全新进程对象
  const app2 = await createApp({ dataDir: dir });
  const { state } = await app2.service.loadState('A1');
  assert.equal(state.status, 'CONFIRMED');
  assert.equal(state.revision, revBefore);
  assert.equal(state.versions.size, 1);
});

test('快照文件丢失后按分析时刻材料确定性重建', async () => {
  const app = await freshApp();
  await seedReadyApplication(app.service);
  const r = await app.service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  const hash = r.events[0].payload.snapshotHash;
  assert.ok(await app.snapshotStore.get(hash));
  await rm(path.join(app.dir, 'snapshots', `${hash}.json`));
  assert.equal(await app.snapshotStore.get(hash), null);

  // 再次提交幂等分析：无新事件，但服务层会触发快照补存
  await app.service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  const restored = await app.snapshotStore.get(hash);
  assert.ok(restored);
  assert.equal(restored.snapshotHash, hash);
});

test('补件与撤回并发：撤回先到时信号不产生计算，事件次序确定', async () => {
  const app = await freshApp();
  await seedReadyApplication(app.service);

  // 两路并发：审批岗撤回 vs 外部高风险信号回调。无论谁先拿到锁，
  // 结果必须自洽：若撤回先 -> 信号被忽略；若信号先 -> 信号生效后撤回，无自动分析越界。
  const [withdrawRes, signalRes] = await Promise.all([
    app.service.submit('A1', { type: 'withdraw', actor: APPROVER, reason: '并发撤回' }),
    app.service.submit('A1', {
      type: 'ingestExternalSignal',
      dedupeKey: 'SRC|CONC|1',
      content: { source: 'SRC', signalType: 'HIT', severity: 'CRITICAL' },
    }),
  ]);

  const { state } = await app.service.loadState('A1');
  assert.equal(state.status, 'WITHDRAWN');
  const version = [...state.versions.values()][0];
  const analysesCount = version.analyses.length;

  if (signalRes.meta.ignored) {
    // 撤回先到
    assert.equal(state.ignoredSignals.size, 1);
    assert.equal(analysesCount, 0, '撤回后绝不能触发新计算');
  } else {
    // 信号先到（自动分析已落库），随后撤回；此后不得再有计算
    assert.equal(analysesCount, 1);
    assert.ok(version.materials.size >= 3);
    // 再来一个迟到信号：必须被忽略
    const late = await app.service.submit('A1', {
      type: 'ingestExternalSignal',
      dedupeKey: 'SRC|CONC|2',
      content: { source: 'SRC', signalType: 'HIT2', severity: 'HIGH' },
    });
    assert.equal(late.meta.ignored, true);
  }
  assert.ok(withdrawRes);
});

test('两个审批人并行补充证据都不丢失', async () => {
  const app = await freshApp();
  await seedReadyApplication(app.service);
  await Promise.all([
    app.service.submit('A1', {
      type: 'submitMaterial',
      actor: APPROVER,
      materialType: MATERIAL_TYPES.MANUAL_VERIFICATION,
      content: { item: '现场核查A', result: 'PASS' },
      contentHash: 'a',
    }),
    app.service.submit('A1', {
      type: 'submitMaterial',
      actor: { userId: 'app2', roles: [ROLES.APPROVER] },
      materialType: MATERIAL_TYPES.MANUAL_VERIFICATION,
      content: { item: '现场核查B', result: 'FAIL' },
      contentHash: 'b',
    }),
  ]);
  const { state } = await app.service.loadState('A1');
  const version = [...state.versions.values()][0];
  const items = [...version.materials.values()].map((m) => m.content.item);
  assert.ok(items.includes('现场核查A'));
  assert.ok(items.includes('现场核查B'));
});

test('外部信号是申请级事实：补件后的新版本分析仍纳入旧版本到达的信号', async () => {
  const { service, snapshotStore } = await freshApp();
  await seedReadyApplication(service, 'A1');
  // v1 期间信号到达（关键材料齐全，自动分析一版）
  await service.submit('A1', {
    type: 'ingestExternalSignal',
    dedupeKey: 'SRC|V1|1',
    content: { source: 'SRC', signalType: 'SANCTION_HIT', severity: 'CRITICAL' },
  });
  // 补件 -> v2（外部信号不结转材料实体）
  await service.submit('A1', {
    type: 'requestSupplement',
    actor: ANALYST,
    requiredItems: ['最新审计报告'],
  });
  const { state: before } = await service.loadState('A1');
  const v2Id = before.currentVersionId;
  const v2Before = before.versions.get(v2Id);
  assert.equal(
    [...v2Before.materials.values()].filter((m) => m.type === MATERIAL_TYPES.EXTERNAL_SIGNAL).length,
    0,
    '信号材料不结转'
  );

  const r = await service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  const warnings = r.events[0].payload.warnings.map((w) => w.ruleId);
  assert.ok(warnings.includes('EXTERNAL_RISK_001'), 'v2 分析仍触发外部风险规则');

  const snap = await snapshotStore.get(r.events[0].payload.snapshotHash);
  assert.equal(snap.input.externalSignals.length, 1);
  assert.equal(snap.input.externalSignals[0].signalType, 'SANCTION_HIT');

  const { state } = await service.loadState('A1');
  const pkg = projectEvidencePackage(state);
  assert.equal(pkg.applicationExternalSignals.length, 1);
  assert.equal(pkg.applicationExternalSignals[0].versionId !== v2Id, true);
});

test('证据包按版本排列且标注结转来源与旧意见 superseded', async () => {
  const { service } = await freshApp();
  await seedReadyApplication(service);
  await service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  await service.submit('A1', { type: 'submitOpinion', actor: ANALYST, decision: 'REJECT' });
  // 新证据 -> 旧意见失效
  await service.submit('A1', {
    type: 'submitMaterial',
    actor: APPROVER,
    materialType: MATERIAL_TYPES.MANUAL_VERIFICATION,
    content: { item: '追加', result: 'PASS' },
    contentHash: 'x',
  });
  await service.submit('A1', { type: 'recordAnalysis', actor: ANALYST });
  await service.submit('A1', { type: 'requestSupplement', actor: ANALYST, requiredItems: ['审计报告'] });

  const { state } = await service.loadState('A1');
  const pkg = projectEvidencePackage(state);
  assert.deepEqual(pkg.versions.map((v) => v.seq), [1, 2]);
  assert.equal(pkg.versions[0].status, 'SUPPLEMENTED');
  // 财报 + 初始核验 + 审批人追加核验，共 3 份非外部材料结转入 v2。
  assert.equal(pkg.versions[1].materials.filter((m) => m.carriedFromVersionId).length, 3);
  assert.equal(pkg.versions[0].opinions[0].supersededByNewEvidence, true);
});
