# 数据分层建模工作台

离线版数仓分层建模工具，覆盖贴源层、明细层、汇总层、应用层的表结构设计、分区策略配置、质量规则编排与血缘关系管理，数据持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 贴源层建模 | `ods` | 贴源表 | 表编号、源表名称、目标表名 |
| 明细层建模 | `dwd` | 明细表 | 表编号、业务域、明细表名 |
| 汇总层建模 | `dws` | 汇总表 | 表编号、汇总主题、聚合维度 |
| 应用层发布 | `ads` | 应用数据集 | 数据集编号、业务应用、输出表名 |
| 数据源管理 | `source` | 数据源连接 | 连接编号、连接类型、接入地址 |
| 分区策略 | `partition` | 分区方案 | 方案编号、目标表名、分区字段 |
| 清洗加工 | `cleanse` | 清洗规则 | 规则编号、输入表名、目标表名 |
| 转换编排 | `transform` | 转换节点 | 节点编号、输入表名、输出表名 |
| 质量校验 | `quality` | 质量规则 | 规则编号、校验表名、目标字段 |
| 血缘追踪 | `lineage` | 血缘关系 | 关系编号、上游表名、下游表名 |
| 历史补数 | `backfill` | 补数任务 | 任务编号、目标表名、开始日期 |
| 元数据管理 | `schema` | 字段定义 | 字段编号、所属表名、字段名称 |
| 数据同步 | `datasync` | 同步链路 | 链路编号、源端连接、目标端连接 |
| 快照管理 | `snapshot` | 快照策略 | 策略编号、目标表名、快照周期 |
| 存储治理 | `govern` | 治理策略 | 策略编号、目标表名、治理类型 |
| 任务监控 | `monitor` | 监控配置 | 配置编号、关联任务、监控指标 |
| 变更审计 | `audit` | 审计记录 | 记录编号、操作表名、变更类型 |
| 编目检索 | `catalog` | 编目条目 | 条目编号、数据集名称、所属分层 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `data-layer-studio:entries` 这一项，或调用 `resetModule(模块)`。

## 切换交接单（数据同步：全量快照 → 增量尾流）

「数据同步」页内置**切换交接单**能力，领域代码独立放在 `frontend/src/data/handover/`，
与通用条目存储分离，持久化在浏览器 `data-layer-studio:handover-manifests`：

| 文件 | 职责 |
| --- | --- |
| `handover/types.ts` | 交接单、范围段、封单回执、回放状态等领域类型与状态文案 |
| `handover/engine.ts` | 纯函数引擎：生成、同笔封单、续写、中断、竞争仲裁、重灌/倒退拦截、回放校验 |
| `handover/store.ts` | localStorage 持久化，`committed_watermark` 按原始字节存取 |
| `handover/service.ts` | 页面调用入口，组合引擎规则与持久化 |

落实的工程规则：

- 依据**同步表列表、两端连接、延迟阈值**生成交接单，标出**覆盖带、重叠去重窗、尚未读取的游标**；
  所有游标在同一根单调轴 `CUR#定长序号` 上，字典序即到达顺序。
- **同笔封单**：目标落盘与源端水位签收要么一起成功要么整体回滚，写入封单回执与 `cursor_digest`。
- **中断续写**：只按剩余游标向后推进，未读游标只增不减；**整表重灌请求一律拦截**并留痕。
- **链路竞争**：同链路并行交接单只认 `sealSeq` 更小的先封单者，落败单置为「已拒绝」；
  **旧回执不得倒退游标**，倒退申请被拒且水位不动。
- **持久快照回放**：从持久化字节重建后复算 source / target / ODS 三端 `cursor_digest`，
  必须三者一致；`committed_watermark` 与封单回执逐字节比对，确认原始字节跨进程保留。

ODS、质量校验（QUAL）、任务监控（MONI）三个页面通过共享组件
`views/components/HandoverRangeReader.vue` **读取同一份交接单**，分别从贴源读取、质量判定、
监控告警视角展示「等待 / 覆盖 / 断开」范围；增量水位回看仍集中在数据同步页，以数据同步为主对象。

引擎为不依赖 DOM 的纯函数，可用 Node 直接验证全部规则：

```bash
cd frontend
npm run check:handover   # 14 项规则：封单事务、续写不倒退、竞争仲裁、回放 digest/字节一致性
```

领域：数据工程
子方向：数仓与数据湖
