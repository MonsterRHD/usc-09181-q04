import { fold, decide, buildAnalysisInput, snapshotInput } from '../domain/aggregate.mjs';
import { ROLES } from '../domain/events.mjs';
import { runModel, hashModelInput } from '../domain/model.mjs';
import { evaluateRules } from '../domain/rules.mjs';
import { ConcurrentModificationError } from '../domain/errors.mjs';

const SYSTEM_ACTOR = Object.freeze({ userId: 'SYSTEM', roles: [ROLES.SYSTEM] });

/**
 * 组装一次确定性分析：同一 (模型版本, 输入快照) 永远得到同一分数与同一组预警。
 * 规则求值使用带内部字段的输入（反查证据材料），快照只封存干净输入。
 */
export function createAnalysisRunner({ snapshotStore }) {
  return function runAnalysis({ modelVersion, input, markedInput }) {
    const snapshotHash = hashModelInput(modelVersion, input);
    const model = runModel(modelVersion, input);
    const warnings = evaluateRules({ input: markedInput, model });
    return {
      modelVersion,
      snapshotHash,
      score: model.score,
      bucket: model.bucket,
      warnings,
      snapshotRecord: {
        snapshotHash,
        modelVersion,
        ruleVersions: [...new Set(warnings.map((w) => w.ruleVersion))],
        input,
      },
    };
  };
}

function toEventList(decision) {
  return Array.isArray(decision) ? decision : decision.events ?? [];
}

export class CreditApplicationService {
  constructor({ eventStore, snapshotStore, analysisRunner }) {
    this.eventStore = eventStore;
    this.snapshotStore = snapshotStore;
    this.runAnalysis = analysisRunner;
  }

  async loadState(applicationId) {
    const events = await this.eventStore.load(applicationId);
    return { events, state: fold(events) };
  }

  async openApplication({ applicationId, customerId, modelVersion, actor }) {
    await this.eventStore.createStream(applicationId);
    const decision = decide(
      { applicationId: null },
      { type: 'openApplication', applicationId, customerId, modelVersion, actor },
      {}
    );
    const stored = await this.eventStore.append(applicationId, toEventList(decision), {
      expectedRevision: 0,
    });
    return { events: stored, state: fold(stored) };
  }

  /**
   * 命令提交的唯一入口：同流串行，读-判-写在一把锁内完成。
   * 外部信号触发的自动分析也在同一把锁内级联完成，
   * 保证“信号到达→分析落库”之间不会插入撤回。
   */
  async submit(applicationId, command) {
    return this.eventStore.withLock(applicationId, () =>
      this.#commitLocked(applicationId, command)
    );
  }

  async #commitLocked(applicationId, command) {
    let committed = [];
    let meta = {};

    const persisted = await this.eventStore.load(applicationId);
    let state = fold(persisted);

    const decision = decide(state, command, { runAnalysis: this.runAnalysis });
    const candidates = toEventList(decision);
    meta = Array.isArray(decision) ? {} : decision;

    if (candidates.length > 0) {
      const stored = await this.eventStore.append(applicationId, candidates, {
        expectedRevision: persisted.length,
      });
      committed.push(...stored);
      await this.#persistSnapshots(stored, decision.snapshotRecord);
    } else if (decision.snapshotRecord) {
      // 幂等分析无新事件，但若快照文件缺失（如磁盘恢复）仍需补存。
      await this.snapshotStore.put(
        decision.snapshotRecord.snapshotHash,
        decision.snapshotRecord
      );
    }

    // 外部信号在关键材料齐全时自动重算（撤回已在 decide 内拦截，不会走到这里）。
    if (decision.autoAnalyze) {
      state = fold([...persisted, ...committed]);
      const analysisDecision = decide(
        state,
        {
          type: 'recordAnalysis',
          actor: SYSTEM_ACTOR,
          modelVersion: state.defaultModelVersion,
        },
        { runAnalysis: this.runAnalysis }
      );
      const autoCandidates = toEventList(analysisDecision);
      if (autoCandidates.length > 0) {
        const stored = await this.eventStore.append(applicationId, autoCandidates, {
          expectedRevision: persisted.length + committed.length,
        });
        committed.push(...stored);
        await this.#persistSnapshots(stored, analysisDecision.snapshotRecord);
        meta.autoAnalysisId = analysisDecision?.events?.[0]?.payload.analysisId ?? null;
      }
    }

    return {
      events: committed,
      state: fold([...persisted, ...committed]),
      meta,
    };
  }

  /**
   * 快照优先用本次计算产生的 snapshotRecord（与事件同一临界区生成，
   * 天然对应分析发生时刻）。缺失时（如老数据）再按事件时刻重建。
   */
  async #persistSnapshots(storedEvents, snapshotRecord) {
    if (snapshotRecord) {
      await this.snapshotStore.put(snapshotRecord.snapshotHash, snapshotRecord);
      return;
    }
    for (const event of storedEvents) {
      if (event.type !== 'ANALYSIS_RECORDED') continue;
      const existing = await this.snapshotStore.get(event.payload.snapshotHash);
      if (!existing) await this.#rebuildSnapshot(event);
    }
  }

  /**
   * 历史补录：只取分析事件发生时刻之前（同序）已提交的材料重算，
   * 哈希能对上才落库；对不上说明材料本身已变更（理论上不可能，事件不可变），
   * 此时保留事件与分数，快照标记为无法还原而不是伪造。
   */
  async #rebuildSnapshot(analysisEvent) {
    const { applicationId } = analysisEvent;
    const allEvents = await this.eventStore.load(applicationId);
    const cutoff = allEvents.findIndex((e) => e.eventId === analysisEvent.eventId);
    const stateAtPoint = fold(allEvents.slice(0, cutoff));
    const version = stateAtPoint.versions.get(analysisEvent.payload.versionId);
    if (!version) return;
    const marked = buildAnalysisInput(version, stateAtPoint.applicationSignals);
    const input = snapshotInput(marked);
    const result = this.runAnalysis({
      modelVersion: analysisEvent.payload.modelVersion,
      input,
      markedInput: marked,
    });
    if (result.snapshotHash === analysisEvent.payload.snapshotHash) {
      await this.snapshotStore.put(result.snapshotHash, result.snapshotRecord);
    }
  }

  async retryOnConflict(fn, { attempts = 3 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ConcurrentModificationError) || i === attempts - 1) throw err;
      }
    }
  }
}
