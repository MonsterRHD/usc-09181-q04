# 智能授信证据台

面向海外客户授信审查的**可回溯证据服务**。审批人拿到的不是一个无法解释的分数，
而是按申请版本排列的证据包：每条风险预警都能点回它所依据的**输入快照、规则版本
与模型版本**，最终结论可按申请逐事件重放。

## 设计原则

1. **事件溯源 + 哈希链（决定不可篡改）**
   所有事实只追加到 `data/events.jsonl`（可用 `EVENT_LOG` 覆盖路径）。
   每条事件 `hash = H(规范化负载 || 上一条 hash)`，改写任何历史事件都会让链断裂，
   服务重启重放时直接拒绝启动；`GET /audit/verify` 可随时全量校验。
2. **按申请版本组织证据包**
   开申请即有 `v1`；缺关键材料或需要补充期后事项时开出 `v2`（`parentVersion` 指向
   `v1`）。新版本沿父链沿用旧材料，旧版本冻结为 `SUPERSEDED`，不得再写入或重跑。
3. **缺关键材料只能补件**
   财报三项指标（流动比率、产权比率、净利率）必须有**指向该版财报**的人工核验且
   `PASS`；核验不通过或材料缺失时，模型计算与最终结论一律被拒（`MISSING_MATERIALS`）。
   换了财报后旧核验不会被错误继承（核验显式绑定 `financialEvidenceId`）。
4. **预警 = 规则版本 × 模型版本 × 冻结输入快照**
   发起模型批次时把当时的证据与外部信号完整快照入库并计算 `evidenceStateHash`；
   模型只回分数，预警由服务端用版本化规则包确定性算出。之后迟到的证据/信号不会
   静默改动这批结果——它们只让证据哈希变化，出结论前必须重跑成新批次。
5. **模型重跑不静默改写意见**
   人工意见挂在具体 `warningId`（内含批次号）上；重跑产生新批次新预警，旧批次、
   旧预警、旧意见原样保留。
6. **撤回后停止新计算，保留最小审计事实**
   撤回后一切新变更被拒，在途批次标记 `ABANDONED`；迟到的回调、信号、证据只记录
   一条 `LATE_FACT_RECORDED`（类型、引用、原因、负载哈希），不进入证据包。
7. **幂等**
   每个写操作接受 `idempotencyKey`；模型回调用 `callbackId`、外部信号用 `signalId`
   去重。重复回调即使携带被篡改的分数，也只返回首次落账的结果。
8. **角色**
   `REVIEWER`/`APPROVER` 可并行补充证据与意见；`APPROVER` 是唯一能确认最终结论的
   角色；`APPLICANT` 可撤回；`SYSTEM` 用于模型回调与外部信号接入。

## 启动与测试

```bash
npm start          # 默认 http://localhost:3000，事件日志 data/events.jsonl
npm test           # 18 项测试：领域不变量、HTTP 端到端、重启恢复、防篡改
node scripts/smoke.mjs   # 命令行全链路演练（并发重复回调、撤回竞争、重启重放）
```

## 接口

身份通过请求体 `actor: {id, role}` 或请求头 `X-Actor-Id` / `X-Actor-Role` 传递。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/applications` | 开申请（同时建立 v1） |
| GET | `/applications/:id` | 当前派生状态（版本、证据、批次、信号） |
| GET | `/applications/:id/evidence-pack?version=v2` | **证据包**：版本/批次/预警树，批次层带冻结输入快照 |
| GET | `/applications/:id/replay` | **重放**：当时结论绑定的批次、快照、预警、意见 |
| GET | `/applications/:id/events` | 原始事件流与链校验和 |
| POST | `/applications/:id/evidence` | 提交 `FINANCIAL_SUMMARY` / `MANUAL_VERIFICATION` |
| POST | `/applications/:id/supplement-requests` | 缺材料 → 开新版本 |
| POST | `/applications/:id/signals` | 外部风险信号（制裁/观察名单/负面舆情/国别风险） |
| POST | `/applications/:id/runs` | 请求模型批次（冻结快照；材料不齐返回 422） |
| POST | `/applications/:id/model-results` | 模型回调（`callbackId` 幂等；服务端确定性算预警） |
| POST | `/applications/:id/warning-notes` | 对具体预警写人工意见 |
| POST | `/applications/:id/decisions` | APPROVER 确认 APPROVE/REJECT（仅当前证据哈希有匹配批次时） |
| POST | `/applications/:id/withdraw` | 撤回：停止计算，迟到输入只留最小事实 |
| GET | `/rule-packs` | 已登记规则包版本与规则清单 |
| GET | `/audit/verify` | 全量哈希链校验 |

## 典型时序

```
开申请 v1 → 财报 → (缺核验, 计算被拒) → 核验补齐 → run-1 → 回调(预警+分数)
        → 审批意见 → 补件开 v2 → 更新财报+核验 → run-2
        → 撤回 ⚡ 与 run-2 回调并发：回调仅留 LATE_FACT
        → 迟到制裁信号：仅留 LATE_FACT（哈希）
重启进程 → 重放事件流 → 状态逐字节恢复，哈希链校验通过
```

## 代码结构

```
src/domain/
  canonical.mjs   规范化 JSON / SHA-256（哈希与快照的字节级确定性）
  eventStore.mjs  只追加 JSONL 事件存储 + 哈希链 + eventId 幂等
  rules.mjs       版本化规则包（纯函数，输入快照 → 预警）
  aggregate.mjs   申请聚合：纯事件重放、版本链、材料完整性、快照/证据哈希
  service.mjs     应用服务：角色、状态机、幂等、迟到事实、结论锚定
src/server.mjs    HTTP 路由、证据包与重放视图
scripts/smoke.mjs 端到端演练
```
