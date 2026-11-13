/**
 * 交接单本地持久化。
 * 与 entries 存储分开，使用独立 key；committed_watermark 按字符串原样存取，
 * 不做任何编码/裁剪，保证跨进程（刷新即模拟跨进程）字节一致。
 */
import type { HandoverManifest } from './types'

const STORAGE_KEY = 'data-layer-studio:handover-manifests'
const SEQ_KEY = 'data-layer-studio:handover-seal-seq'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): HandoverManifest[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    return JSON.parse(raw) as HandoverManifest[]
  } catch {
    return []
  }
}

let cache: HandoverManifest[] | null = null

export function listManifests(): HandoverManifest[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function getManifest(manifestNo: string): HandoverManifest | undefined {
  return listManifests().find((m) => m.manifestNo === manifestNo)
}

/** 整体落盘：调用方负责把整份数组传回来，保证一次写入即一致视图。 */
export function persistManifests(manifests: HandoverManifest[]): void {
  cache = clone(manifests)
  if (typeof window !== 'undefined' && window.localStorage) {
    // JSON 序列化保留字符串原始字节，committed_watermark 不被转换。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}

export function upsertManifest(manifest: HandoverManifest): HandoverManifest[] {
  const rows = listManifests()
  const index = rows.findIndex((m) => m.manifestNo === manifest.manifestNo)
  const next = [...rows]
  if (index >= 0) {
    next[index] = clone(manifest)
  } else {
    next.push(clone(manifest))
  }
  persistManifests(next)
  return next
}

/** 取下一个全局封单序号并持久化，先封单者拿到更小的序号。 */
export function nextSealSeq(): number {
  const base = typeof window !== 'undefined' && window.localStorage
  const current = base ? Number(window.localStorage.getItem(SEQ_KEY) ?? '0') : 0
  const next = current + 1
  if (base) {
    window.localStorage.setItem(SEQ_KEY, String(next))
  }
  return next
}

export function resetManifests(): HandoverManifest[] {
  cache = []
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
    window.localStorage.removeItem(SEQ_KEY)
  }
  return []
}

export function handoverStorageKey(): string {
  return STORAGE_KEY
}
