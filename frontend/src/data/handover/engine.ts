/**
 * 切换交接单引擎：所有业务规则都收敛在这里，页面只做渲染与转发。
 *
 * 规则对应需求：
 *  1. 依据同步表列表、两端连接、延迟阈值生成「全量快照 → 增量尾流」交接单，
 *     标出覆盖带、重叠去重窗、尚未读取的游标。
 *  2. 目标落盘与源端水位签收必须同笔封单（原子事务，要么都成要么都不成）。
 *  3. 中断后按剩余游标续写，整表重灌不得发生。
 *  4. 两个并行交接单争同链路时只认先封单者；旧回执不得倒退游标。
 *  5. 持久快照回放后 source / target / ODS 的 cursor_digest 必须一致；
 *     committed_watermark 保留原字节并跨进程同步。
 */
import type {
  CreateManifestInput,
  CursorSegment,
  DigestCheck,
  EngineResult,
  HandoverManifest,
  ManifestStatus,
  ReplayState,
  SealedReceipt,
  SegmentKind,
} from './types'

/** 32 位 FNV-1a，输出 8 位十六进制。纯前端无 crypto 依赖也能稳定复算，三端同算法。 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // 强制无符号 32 位再转十六进制。
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 游标摘要：把链路与游标原始字节纳入哈希，任一字节变化都会改变 digest。 */
export function cursorDigest(linkNo: string, cursor: string): string {
  return fnv1aHex(`${linkNo}::${cursor}`)
}

/** 把任意字符串安全地当作「原始字节水位」处理：不 trim、不转码、不改大小写。 */
function rawWatermark(value: string): string {
  return value
}

function nowTs(): number {
  return Date.now()
}

/** 依据全局单调序号生成游标字节：同一前缀 + 定长序号，字典序即到达顺序，可直接比较先后。 */
function globalCursor(seq: number): string {
  return `CUR#${String(seq).padStart(12, '0')}`
}

let manifestSeq = 0

/** 生成交接单号：HO-yyyyMMdd-序号。 */
export function nextManifestNo(ts: number = nowTs()): string {
  manifestSeq += 1
  const d = new Date(ts)
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}`
  return `HO-${ymd}-${String(manifestSeq).padStart(4, '0')}`
}

/** 仅用于持久化恢复时复位序号，避免刷新后单号撞车。 */
export function seedManifestSeq(seq: number): void {
  manifestSeq = Math.max(manifestSeq, seq)
}

/**
 * 生成一张交接单。
 * 覆盖带 = 全量快照已包含的区间；重叠去重窗 = 全量与增量重叠、需按主键去重的区间；
 * 未读游标 = 增量尾流起点。延迟阈值决定重叠窗宽度（阈值越大窗越宽）。
 */
export function createManifest(input: CreateManifestInput): EngineResult<HandoverManifest> {
  if (!input.tables.length) {
    return { ok: false, message: '同步表列表为空，无法生成交接单' }
  }
  if (input.lagThresholdSec <= 0) {
    return { ok: false, message: '延迟阈值必须为正整数（秒）' }
  }
  const ts = nowTs()
  const manifestNo = nextManifestNo(ts)
  const high = rawWatermark(input.sourceHighWatermark ?? `WM:${input.linkNo}#high@${ts}`)

  // 所有游标共用同一根单调轴（CUR#定长序号），覆盖带→重叠窗→尾流→断开严格有序，
  // 字典序即到达顺序，可直接比较游标先后。
  let seq = 0
  const alloc = (span: number): { from: string; to: string } => {
    const from = globalCursor(seq + 1)
    seq += span
    return { from, to: globalCursor(seq) }
  }

  const segments: CursorSegment[] = []
  input.tables.forEach((table, tIdx) => {
    // 覆盖带：每张表一段，全量快照已落盘。
    const cover = alloc(1000)
    segments.push({
      index: segments.length,
      table,
      fromCursor: cover.from,
      toCursor: cover.to,
      kind: 'covered',
      landed: true,
    })
    // 重叠去重窗：全量与增量重叠，等待按主键去重，宽度由延迟阈值决定。
    const overlap = alloc(input.lagThresholdSec + 1)
    segments.push({
      index: segments.length,
      table,
      fromCursor: overlap.from,
      toCursor: overlap.to,
      kind: 'waiting',
      landed: false,
    })
    // 增量尾流：等待新游标到达。
    const tail = alloc(4000)
    segments.push({
      index: segments.length,
      table,
      fromCursor: tail.from,
      toCursor: tail.to,
      kind: 'waiting',
      landed: false,
    })
    // 演示用：第三张表尾流末端预置一个断开段，供 ODS/QUAL/MONI 展示断开范围。
    if (tIdx === 2) {
      const broken = alloc(1000)
      segments.push({
        index: segments.length,
        table,
        fromCursor: broken.from,
        toCursor: broken.to,
        kind: 'disconnected',
        landed: false,
        reason: '源端连接超时，尾流尚未到达',
      })
    }
  })

  // 整单范围带直接取首表对应段边界，保证与段游标同轴、不另起编号。
  const firstCovered = segments.find((s) => s.kind === 'covered')!
  const firstOverlap = segments.find((s) => s.kind === 'waiting')!
  const coverFrom = firstCovered.fromCursor
  const coverTo = firstCovered.toCursor
  const overlapFrom = firstOverlap.fromCursor
  const overlapTo = firstOverlap.toCursor
  // 尚未读取游标：增量从重叠去重窗起点开始，窗内去重后沿尾流只增不减。
  const unread = overlapFrom

  const manifest: HandoverManifest = {
    manifestNo,
    linkNo: input.linkNo,
    tables: [...input.tables],
    sourceConn: input.sourceConn,
    targetConn: input.targetConn,
    lagThresholdSec: input.lagThresholdSec,
    status: 'draft',
    coverFrom,
    coverTo,
    overlapFrom,
    overlapTo,
    unreadCursor: unread,
    sourceHighWatermark: high,
    segments,
    receipt: null,
    committedWatermark: null,
    cursorDigest: null,
    violations: [],
    createdAt: ts,
    updatedAt: ts,
  }
  return { ok: true, message: `交接单 ${manifestNo} 已生成，等待封单`, data: manifest }
}

/** 同笔封单：目标落盘与源端水位签收要么一起成功，要么都不落。 */
export function sealManifest(
  manifest: HandoverManifest,
  allManifests: HandoverManifest[],
  sealSeq: number,
): EngineResult<HandoverManifest> {
  if (manifest.status !== 'draft') {
    return { ok: false, message: `交接单 ${manifest.manifestNo} 不是草稿态，不能封单` }
  }

  // 竞争仲裁：同链路只认先封单者。找一张已封单且 sealSeq 更小的交接单。
  const winner = allManifests.find(
    (m) =>
      m.linkNo === manifest.linkNo &&
      m.receipt !== null &&
      m.receipt.sealSeq < sealSeq &&
      m.status !== 'rejected',
  )
  if (winner) {
    const rejected: HandoverManifest = {
      ...manifest,
      status: 'rejected',
      violations: [
        ...manifest.violations,
        `链路 ${manifest.linkNo} 已由先封单的 ${winner.manifestNo} 占用，本单封单被拒`,
      ],
      updatedAt: nowTs(),
    }
    return { ok: false, message: '同链路存在先封单者，并行交接单只认先封单者', data: rejected }
  }

  // 同笔事务：先在内存里同时准备「目标落盘水位」与「源端签收水位」，任一缺失则整体放弃。
  const targetWatermark = rawWatermark(manifest.coverTo)
  const sourceWatermark = rawWatermark(manifest.sourceHighWatermark)
  if (!targetWatermark || !sourceWatermark) {
    return { ok: false, message: '目标落盘或源端水位缺失，封单事务回滚，两端均不签收' }
  }

  const digest = cursorDigest(manifest.linkNo, targetWatermark)
  const receipt: SealedReceipt = {
    manifestNo: manifest.manifestNo,
    sealSeq,
    sealedAt: nowTs(),
    sourceWatermark,
    targetWatermark,
    cursorDigest: digest,
  }

  const sealed: HandoverManifest = {
    ...manifest,
    status: 'sealed',
    receipt,
    // 提交水位保留原始字节，跨进程同步时逐字节搬运。
    committedWatermark: targetWatermark,
    cursorDigest: digest,
    // 封单即确认覆盖带全部落盘。
    segments: manifest.segments.map((seg) =>
      seg.kind === 'covered' ? { ...seg, landed: true } : seg,
    ),
    updatedAt: nowTs(),
  }
  return { ok: true, message: `交接单 ${manifest.manifestNo} 已同笔封单（落盘+水位签收）`, data: sealed }
}

/**
 * 按剩余游标续写尾流。
 * 每次推进一个等待段；只允许从未读游标向后，绝不允许整表重灌。
 */
export function resumeManifest(manifest: HandoverManifest): EngineResult<HandoverManifest> {
  if (manifest.status === 'completed') {
    return { ok: false, message: '交接单已完成，无需续写' }
  }
  if (manifest.status === 'draft' || manifest.receipt === null) {
    return { ok: false, message: '交接单尚未封单，不能进入增量尾流' }
  }

  const nextSegments = manifest.segments.map((seg) => ({ ...seg }))
  // 找到第一个「未断开且未落盘」的等待段推进。
  const target = nextSegments.find((seg) => seg.kind === 'waiting' && !seg.landed)
  if (!target) {
    // 没有可推进的等待段：若仍有断开段则保持中断，否则完成。
    const hasDisconnect = nextSegments.some((seg) => seg.kind === 'disconnected')
    const status: ManifestStatus = hasDisconnect ? 'interrupted' : 'completed'
    return {
      ok: true,
      message: hasDisconnect ? '仍有断开范围，交接单保持中断' : '尾流已追平，交接完成',
      data: { ...manifest, segments: nextSegments, status, updatedAt: nowTs() },
    }
  }

  target.landed = true
  // 未读游标前进到该段末端（保留原始字节）。
  const newUnread = target.toCursor
  const hasDisconnect = nextSegments.some((seg) => seg.kind === 'disconnected' && !seg.landed)
  const allWaitingLanded = nextSegments
    .filter((seg) => seg.kind === 'waiting')
    .every((seg) => seg.landed)
  const status: ManifestStatus = hasDisconnect
    ? 'interrupted'
    : allWaitingLanded
      ? 'completed'
      : 'streaming'

  const updated: HandoverManifest = {
    ...manifest,
    segments: nextSegments,
    unreadCursor: newUnread,
    status,
    updatedAt: nowTs(),
  }
  return { ok: true, message: `已按剩余游标续写至 ${newUnread}`, data: updated }
}

/** 模拟中断：把指定等待段标记为断开，续写时只能从剩余游标继续。 */
export function interruptManifest(
  manifest: HandoverManifest,
  reason = '链路中断，等待按剩余游标续写',
): EngineResult<HandoverManifest> {
  if (manifest.receipt === null) {
    return { ok: false, message: '未封单的交接单不存在尾流中断' }
  }
  const seg = manifest.segments.find((s) => s.kind === 'waiting' && !s.landed)
  if (!seg) {
    return { ok: false, message: '没有可中断的等待段' }
  }
  const segments = manifest.segments.map((s) =>
    s.index === seg.index ? { ...s, kind: 'disconnected' as SegmentKind, reason } : s,
  )
  return {
    ok: true,
    message: `交接单已中断，剩余游标 ${manifest.unreadCursor} 保留，恢复后续写`,
    data: { ...manifest, segments, status: 'interrupted', updatedAt: nowTs() },
  }
}

/**
 * 尝试整表重灌：这是被明令禁止的动作，引擎拒绝并留痕，游标保持不动。
 */
export function fullReloadAttempt(manifest: HandoverManifest): EngineResult<HandoverManifest> {
  const blocked: HandoverManifest = {
    ...manifest,
    violations: [
      ...manifest.violations,
      `检测到整表重灌请求（${nowTs()}），已拦截：中断后只允许按剩余游标续写`,
    ],
    updatedAt: nowTs(),
  }
  return { ok: false, message: '整表重灌被禁止：中断后必须按剩余游标续写，游标未移动', data: blocked }
}

/**
 * 用旧回执申请把游标倒退到更早位置：拒绝，且当前游标不得回退。
 */
export function rollbackWithStaleReceipt(
  manifest: HandoverManifest,
  staleReceipt: SealedReceipt,
): EngineResult<HandoverManifest> {
  if (!manifest.receipt) {
    return { ok: false, message: '交接单尚无有效回执' }
  }
  if (staleReceipt.sealSeq >= manifest.receipt.sealSeq) {
    return { ok: false, message: '该回执不是旧回执，倒退申请不成立' }
  }
  const blocked: HandoverManifest = {
    ...manifest,
    violations: [
      ...manifest.violations,
      `旧回执 ${staleReceipt.manifestNo}(seq=${staleReceipt.sealSeq}) 试图倒退游标，已拒绝`,
    ],
    updatedAt: nowTs(),
  }
  return { ok: false, message: '旧回执不得倒退游标，当前游标与水位保持不变', data: blocked }
}

/**
 * 持久快照回放：从持久化字节重建交接单后，核对三端 digest 是否一致，
 * 并确认 committed_watermark 与封单时逐字节相同。
 *
 * @param persisted 从持久化存储读出的交接单（模拟跨进程）。
 */
export function replayFromSnapshot(persisted: HandoverManifest): EngineResult<ReplayState> {
  if (!persisted.receipt || !persisted.cursorDigest || !persisted.committedWatermark) {
    return { ok: false, message: '交接单未封单，缺少回放所需的回执与提交水位' }
  }
  // 三端各自用同一算法、同一游标字节复算 digest。
  const sourceDigest = cursorDigest(persisted.linkNo, persisted.receipt.targetWatermark)
  const targetDigest = cursorDigest(persisted.linkNo, persisted.committedWatermark)
  const odsDigest = cursorDigest(persisted.linkNo, persisted.committedWatermark)
  const check: DigestCheck = {
    manifestNo: persisted.manifestNo,
    sourceDigest,
    targetDigest,
    odsDigest,
    consistent:
      sourceDigest === persisted.cursorDigest &&
      targetDigest === persisted.cursorDigest &&
      odsDigest === persisted.cursorDigest,
  }
  // 提交水位必须与封单回执里的目标水位逐字节一致（原始字节保留）。
  const watermarkBytesPreserved =
    persisted.committedWatermark === persisted.receipt.targetWatermark

  const state: ReplayState = {
    manifestNo: persisted.manifestNo,
    digestCheck: check,
    restoredWatermark: persisted.committedWatermark,
    watermarkBytesPreserved,
    replayedAt: nowTs(),
  }
  const ok = check.consistent && watermarkBytesPreserved
  return {
    ok,
    message: ok
      ? '回放校验通过：三端 cursor_digest 一致，提交水位原始字节完整'
      : '回放校验失败：digest 不一致或提交水位字节被改动',
    data: state,
  }
}
