# 智能授信证据台

跨境授信辅助审查的可回溯证据服务。审批人拿到的不再是一段无法回溯的分数，而是
**按申请版本排列的证据包**：每条风险预警都指向「模型当时看到的输入快照 + 规则版本 +
触发材料」，审查意见与最终结论锚定快照、不可静默改写。

## 解决什么

| 审批关注点 | 本服务的保证 |
| --- | --- |
| 风险预警来源 | 每条预警带 `ruleId@ruleVersion`、触发指标、触发材料 ID、`snapshotHash` |
| 证据按版本排列 | 补件即开立新版本（`SUPPLEMENT_REQUESTED`），旧版本完整封存，材料结转标注来源 |
| 缺关键材料 | 财报 + 人工核验缺失时分析被拒（422），只能发起补件 |
| 模型重跑不改写意见 | 待确认期间禁止重算；新证据到达自动退回分析态，旧意见标 `superseded` 不删除 |
| 并发补件/回调 | 每流串行提交锁 + 乐观并发（`expectedRevision`）；外部信号申请级 `dedupeKey` 幂等 |
| 撤回 | 撤回后材料/分析/意见全拒，迟到信号只存 `EXTERNAL_SIGNAL_IGNORED` 最小审计事实 |
| 重启与重放 | 仅追加事件流（哈希链）+ 内容寻址快照库；重启即折叠恢复，`GET /replay` 还原决策依据 |

## 架构

```
src/
├── lib/canonical.mjs          # 稳定序列化 + SHA-256（快照/事件链哈希的基石）
│
├── domain/                    # 纯函数核心，无 I/O
│   ├── events.mjs             # 事件类型 / 状态 / 决策 / 角色常量
│   ├── errors.mjs             # 领域错误（含 HTTP 映射）
│   ├── model.mjs              # 版本化、确定性的模型注册表（冻结，只能发新版本）
│   ├── rules.mjs              # 版本化规则注册表（发布即冻结）
│   └── aggregate.mjs          # decide() 命令决策 + fold() 事件折叠（状态机）
│
├── application/               # 用例编排与读模型
│   ├── service.mjs            # 读-判-写临界区；外部信号到达后自动分析级联

│   ├── projection.mjs         # 证据包投影 / 决策重放投影
│   ├── http-app.mjs           # 路由适配层（角色走 x-user-roles 头）
│
├── infra/
│   ├── event-store.mjs        # 仅追加 JSONL 事件流 + prevHash 哈希链 + per-stream 锁
│   └── snapshot-store.mjs     # 内容寻址的输入快照（模型当时看到什么）
│
├── main.mjs                   # 组合根 / 起服
└── server.mjs                 # npm start 入口
```

**为什么是事件溯源**：意见不可篡改、撤回后保留最小事实、按版本重放当时结论，这三个
要求都指向同一手段——状态只能从不可变事件折叠得到，永不就地更新。事件有完整的
`prevHash` 哈希链，字节级篡改在下次加载时立即暴露。

**为什么要内容寻址快照**：事件里只存快照的哈希，完整输入单独以 `<snapshotHash>.json`
保存。同一份输入天然只存一份；即使快照文件丢失，也可按分析事件发生时刻的材料
确定性重算补存（哈希能对上才落库，对不上不伪造）。

## 快速开始

```bash
npm start                 # 默认端口 3000，数据写入 ./.data
DATA_DIR=/data PORT=8080 npm start
npm test                  # 38 项单元 + 集成测试
```

鉴权（演示用请求头，生产应接 SSO/网关）：

- `x-user-id: zhang.san`
- `x-user-roles: ANALYST`（审查岗：补证据、分析、提交意见、发起补件）
- `x-user-roles: APPROVER`（审批岗：补证据、确认最终结论、撤回）
- 外部系统回调 `POST .../external-signals` 固定为 SYSTEM，可用 `CALLBACK_TOKEN` 校验

## HTTP 接口

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /applications` | 任意 | 开立申请（body: `applicationId/customerId/modelVersion?`） |
| `POST /applications/:id/materials` | ANALYST/APPROVER | 补证据：`FINANCIAL_REPORT` / `MANUAL_VERIFICATION` / `EXTERNAL_SIGNAL` |
| `POST /applications/:id/analyses` | ANALYST | 封存当前快照并跑模型+规则；缺关键材料返回 422 |
| `POST /applications/:id/opinions` | ANALYST | 提交 `APPROVE`/`REJECT` 意见，锚定最新分析快照 |
| `POST /applications/:id/supplement-requests` | ANALYST | 旧版本封存，开立新版本并结转非外部材料 |
| `POST /applications/:id/confirmation` | **APPROVER** | 确认最终结论（终态） |
| `POST /applications/:id/withdrawal` | **APPROVER** | 撤回（终态），停止一切新计算 |
| `POST /applications/:id/external-signals` | SYSTEM | 外部风险信号回调（幂等、迟到安全） |
| `GET /applications/:id` | 任意 | 按版本排列的证据包 |
| `GET /applications/:id/replay` | 任意 | 还原「当时为什么通过/拒绝」 |
| `GET /applications/:id/events` | 任意 | 原始审计事件流（含哈希链） |

## 典型流程

```bash
H='-H content-type:application/json -H x-user-id:ana -H x-user-roles:ANALYST'
P='-H content-type:application/json -H x-user-id:app -H x-user-roles:APPROVER'

# 1. 开案 + 两份关键材料
curl $H -X POST localhost:3000/applications \
  -d '{"applicationId":"A1","customerId":"OVERSEAS-77"}'
curl $H -X POST localhost:3000/applications/A1/materials \
  -d '{"materialType":"FINANCIAL_REPORT","content":{"debtToAssetRatio":0.91,"netProfit":-5}}'
curl $H -X POST localhost:3000/applications/A1/materials \
  -d '{"materialType":"MANUAL_VERIFICATION","content":{"item":"贸易背景","result":"FAIL"}}'

# 2. 分析：每条预警都能回溯到快照与规则版本
curl $H -X POST localhost:3000/applications/A1/analyses -d '{}'

# 3. 审查意见 -> 审批确认（分析员确认会 403）
curl $H -X POST localhost:3000/applications/A1/opinions \
  -d '{"decision":"REJECT","rationale":"高杠杆+核验失败"}'
curl $P -X POST localhost:3000/applications/A1/confirmation -d '{}'

# 4. 多年后重放当时依据
curl localhost:3000/applications/A1/replay
```

外部信号回调（重复/迟到/撤回后到达都安全）：

```bash
curl -X POST localhost:3000/applications/A1/external-signals \
  -H 'content-type: application/json' \
  -d '{"dedupeKey":"OFAC|20260918|88",
       "content":{"source":"OFAC","signalType":"SANCTION_HIT","severity":"CRITICAL"}}'
# 关键材料齐全时自动触发一版分析；同一 dedupeKey 重复回调返回 deduped=true；
# 撤回/终结后到达返回 ignored=true，只留最小审计事实，绝不计算。
```

## 关键不变量（测试覆盖）

- 事件仅追加 + 哈希链：篡改任一事件字节或删除中间事件，加载即失败
- 同流并发：串行锁 + `expectedRevision`，补件/撤回/回调竞争结果确定、事件不丢
- 意见不可变：模型重跑产生新分析、新意见；旧意见只标记 `superseded`，永不覆盖
- 终态封闭：`CONFIRMED` / `WITHDRAWN` 后拒绝一切变更命令
- 确定性：同模型版本 + 同输入快照，任何进程、任何时间重算得到同一组预警与分数

## 边界与取舍

- 存储为本地 JSONL 文件（无外部依赖，便于审计与演示）；事件文件本身只追加，
  生产可平移到带条件追加的 Kafka/事件库，应用层并发协议不变。
- 模型与规则为确定性内置实现，版本号一旦使用即冻结；接入真实模型时应同样保证
  「版本 + 输入 → 确定输出」（如固定模型制品哈希），否则重放保证不成立。
