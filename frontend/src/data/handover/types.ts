/**
 * 切换交接单领域模型。
 *
 * 交接单负责把一条同步链路从「全量快照」平滑切换到「增量尾流」：
 * 记录覆盖带、重叠去重窗与尚未读取的游标，并约束封单、续写、竞争与回放。
 * 这里只放纯类型与常量，不依赖浏览器，引擎与持久化都可以在进程外复用。
 */

/** 范围段的三种状态：等待读取 / 已被覆盖去重 / 链路断开未达。 */
export type SegmentKind = 'waiting' | 'covered' | 'disconnected'

/** 交接单生命周期状态。 */
export type ManifestStatus =
  | 'draft' // 草稿：已生成，尚未封单
  | 'sealed' // 已封单：目标落盘与源端水位签收同笔完成
  | 'streaming' // 增量尾流进行中：按剩余游标续写
  | 'interrupted' // 中断：链路断开，等待按剩余游标续写
  | 'completed' // 尾流追平，交接完成
  | 'rejected' // 竞争落败或违规（整表重灌、回执倒退）被拒绝

/** 游标范围段：交接单上某一段数据所处的区间与状态。 */
export type CursorSegment = {
  /** 段序号，从 0 开始。 */
  index: number
  /** 关联的同步表名。 */
  table: string
  /** 区间下界游标（含），保留提交时的原始字节。 */
  fromCursor: string
  /** 区间上界游标（含），保留提交时的原始字节。 */
  toCursor: string
  kind: SegmentKind
  /** 该段是否已被目标端落盘确认。 */
  landed: boolean
  /** 断开原因，仅 kind=disconnected 时有值。 */
  reason?: string
}

/** 封单回执：封单是目标落盘与源端水位签收的同笔事务凭证。 */
export type SealedReceipt = {
  /** 回执所属交接单号。 */
  manifestNo: string
  /** 封单单调序号，先封单者序号更小，用于竞争仲裁。 */
  sealSeq: number
  /** 封单时刻的 epoch 毫秒。 */
  sealedAt: number
  /** 封单时确认的源端水位（原始字节）。 */
  sourceWatermark: string
  /** 封单时确认的目标落盘水位（原始字节）。 */
  targetWatermark: string
  /** 封单时计算出的游标摘要。 */
  cursorDigest: string
}

/**
 * 切换交接单。
 * 一张交接单对应一条同步链路的一次「全量 → 增量」切换。
 */
export type HandoverManifest = {
  /** 交接单号，全局唯一，如 HO-20261113-0001。 */
  manifestNo: string
  /** 所属同步链路编号（对应 datasync 的链路编号）。 */
  linkNo: string
  /** 同步表列表。 */
  tables: string[]
  /** 源端连接标识。 */
  sourceConn: string
  /** 目标端连接标识。 */
  targetConn: string
  /** 延迟阈值（秒），用于划定重叠去重窗。 */
  lagThresholdSec: number
  status: ManifestStatus
  /** 全量快照覆盖带：[coverFrom, coverTo]，含端点，原始字节。 */
  coverFrom: string
  coverTo: string
  /** 重叠去重窗：[overlapFrom, overlapTo]，全量与增量在此重叠，按主键去重。 */
  overlapFrom: string
  overlapTo: string
  /** 尚未读取的起始游标：增量尾流从这里开始读。 */
  unreadCursor: string
  /** 尾流最终要追平的源端当前水位。 */
  sourceHighWatermark: string
  /** 各表的游标范围段。 */
  segments: CursorSegment[]
  /** 封单回执，未封单时为 null。 */
  receipt: SealedReceipt | null
  /** 封单后提交水位，保留原始字节；跨进程同步靠它，不做任何编码转换。 */
  committedWatermark: string | null
  /** 三端（source/target/ODS）游标摘要，封单与回放时必须一致。 */
  cursorDigest: string | null
  /** 整表重灌一旦发生即在此留痕，并触发拒绝。 */
  violations: string[]
  createdAt: number
  updatedAt: number
}

/** 三端游标摘要核对结果。 */
export type DigestCheck = {
  manifestNo: string
  sourceDigest: string
  targetDigest: string
  odsDigest: string
  /** 三者完全一致才通过。 */
  consistent: boolean
}

/** 持久快照回放状态。 */
export type ReplayState = {
  manifestNo: string
  /** 回放后三端 digest 核对。 */
  digestCheck: DigestCheck
  /** 回放恢复出的提交水位（原始字节），应与封单时逐字节相同。 */
  restoredWatermark: string | null
  /** 提交水位是否与封单时逐字节一致。 */
  watermarkBytesPreserved: boolean
  replayedAt: number
}

/** 生成交接单的输入：同步表列表、两端连接、延迟阈值。 */
export type CreateManifestInput = {
  linkNo: string
  tables: string[]
  sourceConn: string
  targetConn: string
  lagThresholdSec: number
  /** 源端当前高水位，缺省时由引擎按链路生成确定性样例值。 */
  sourceHighWatermark?: string
}

/** 引擎动作返回的统一结果，便于页面直接展示。 */
export type EngineResult<T> = {
  ok: boolean
  message: string
  data?: T
}

export const SEGMENT_LABEL: Record<SegmentKind, string> = {
  waiting: '等待',
  covered: '覆盖',
  disconnected: '断开',
}

export const STATUS_LABEL: Record<ManifestStatus, string> = {
  draft: '草稿',
  sealed: '已封单',
  streaming: '尾流进行中',
  interrupted: '已中断',
  completed: '已完成',
  rejected: '已拒绝',
}
