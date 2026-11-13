/**
 * 交接单服务层：页面只调用这里，内部组合引擎规则与本地持久化。
 * 保持与 local-service 相同的「动作返回 { ok, message }」风格。
 */
import {
  createManifest,
  fullReloadAttempt,
  interruptManifest,
  replayFromSnapshot,
  resumeManifest,
  rollbackWithStaleReceipt,
  sealManifest,
  seedManifestSeq,
} from './engine'
import {
  getManifest,
  listManifests,
  nextSealSeq,
  resetManifests,
  upsertManifest,
} from './store'
import type {
  CreateManifestInput,
  EngineResult,
  HandoverManifest,
  ReplayState,
} from './types'

/** 从持久化恢复单号序号，避免刷新后新单号与历史单号冲突。 */
function ensureSeqSeeded(): void {
  const maxSuffix = listManifests().reduce((max, m) => {
    const suffix = Number(m.manifestNo.split('-').pop() ?? '0')
    return Number.isFinite(suffix) ? Math.max(max, suffix) : max
  }, 0)
  seedManifestSeq(maxSuffix)
}

export function loadManifests(): HandoverManifest[] {
  ensureSeqSeeded()
  return listManifests()
}

export function findManifest(manifestNo: string): HandoverManifest | undefined {
  return getManifest(manifestNo)
}

export function generateHandover(input: CreateManifestInput): EngineResult<HandoverManifest> {
  ensureSeqSeeded()
  const result = createManifest(input)
  if (!result.ok || !result.data) {
    return result
  }
  upsertManifest(result.data)
  return result
}

export function sealHandover(manifestNo: string): EngineResult<HandoverManifest> {
  const manifest = getManifest(manifestNo)
  if (!manifest) {
    return { ok: false, message: `没有找到交接单 ${manifestNo}` }
  }
  const all = listManifests()
  const sealSeq = nextSealSeq()
  const result = sealManifest(manifest, all, sealSeq)
  if (result.data) {
    upsertManifest(result.data)
  }
  return result
}

export function resumeHandover(manifestNo: string): EngineResult<HandoverManifest> {
  const manifest = getManifest(manifestNo)
  if (!manifest) {
    return { ok: false, message: `没有找到交接单 ${manifestNo}` }
  }
  const result = resumeManifest(manifest)
  if (result.data) {
    upsertManifest(result.data)
  }
  return result
}

export function interruptHandover(manifestNo: string): EngineResult<HandoverManifest> {
  const manifest = getManifest(manifestNo)
  if (!manifest) {
    return { ok: false, message: `没有找到交接单 ${manifestNo}` }
  }
  const result = interruptManifest(manifest)
  if (result.data) {
    upsertManifest(result.data)
  }
  return result
}

export function attemptFullReload(manifestNo: string): EngineResult<HandoverManifest> {
  const manifest = getManifest(manifestNo)
  if (!manifest) {
    return { ok: false, message: `没有找到交接单 ${manifestNo}` }
  }
  // 即使被拦截也把违规痕迹落盘，便于审计回看。
  const result = fullReloadAttempt(manifest)
  if (result.data) {
    upsertManifest(result.data)
  }
  return result
}

export function attemptStaleRollback(manifestNo: string): EngineResult<HandoverManifest> {
  const manifest = getManifest(manifestNo)
  if (!manifest || !manifest.receipt) {
    return { ok: false, message: `交接单 ${manifestNo} 不存在或尚未封单` }
  }
  // 构造一个序号更小的「旧回执」来模拟旧回执倒退攻击。
  const stale = { ...manifest.receipt, sealSeq: manifest.receipt.sealSeq - 1 }
  const result = rollbackWithStaleReceipt(manifest, stale)
  if (result.data) {
    upsertManifest(result.data)
  }
  return result
}

/**
 * 持久快照回放：直接从 localStorage 重新读取（模拟跨进程），
 * 再交给引擎核对三端 digest 与提交水位字节。
 */
export function replayHandover(manifestNo: string): EngineResult<ReplayState> {
  const persisted = getManifest(manifestNo)
  if (!persisted) {
    return { ok: false, message: `没有找到交接单 ${manifestNo}` }
  }
  return replayFromSnapshot(persisted)
}

export function resetHandovers(): HandoverManifest[] {
  return resetManifests()
}
