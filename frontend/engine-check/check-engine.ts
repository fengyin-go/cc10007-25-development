/**
 * 切换交接单引擎规则验证。
 * 用 esbuild 把 TS 转成 ESM 后用 node 运行；只依赖纯引擎，不触碰浏览器存储。
 */
import assert from 'node:assert/strict'

import {
  createManifest,
  cursorDigest,
  fnv1aHex,
  fullReloadAttempt,
  interruptManifest,
  replayFromSnapshot,
  resumeManifest,
  rollbackWithStaleReceipt,
  sealManifest,
} from '../src/data/handover/engine.ts'
import type { HandoverManifest } from '../src/data/handover/types.ts'

let passed = 0
function check(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const baseInput = {
  linkNo: 'DATA-0003',
  tables: ['ods_order', 'ods_pay', 'ods_user'],
  sourceConn: 'SRC-MYSQL',
  targetConn: 'TGT-HIVE',
  lagThresholdSec: 30,
}

function seal(m: HandoverManifest, all: HandoverManifest[], seq: number) {
  const r = sealManifest(m, all, seq)
  assert.ok(r.ok, `封单应成功: ${r.message}`)
  return r.data!
}

console.log('1. 交接单生成：覆盖带 / 重叠去重窗 / 未读游标')
check('表列表、两端连接、延迟阈值都写入交接单', () => {
  const r = createManifest(baseInput)
  assert.ok(r.ok && r.data)
  const m = r.data
  assert.equal(m.linkNo, 'DATA-0003')
  assert.deepEqual(m.tables, baseInput.tables)
  assert.equal(m.sourceConn, 'SRC-MYSQL')
  assert.equal(m.targetConn, 'TGT-HIVE')
  assert.equal(m.lagThresholdSec, 30)
  assert.equal(m.status, 'draft')
})

check('重叠去重窗宽度随延迟阈值变化，未读游标从窗起点单调进入尾流', () => {
  const a = createManifest({ ...baseInput, lagThresholdSec: 10 }).data!
  const b = createManifest({ ...baseInput, lagThresholdSec: 90 }).data!
  assert.ok(b.overlapTo > a.overlapTo)
  // 未读游标等于重叠窗起点，且严格落在覆盖带之后、尾流之前。
  assert.equal(a.unreadCursor, a.overlapFrom)
  assert.ok(a.unreadCursor > a.coverTo)
  // 同一根游标轴上，所有段区间按生成顺序严格递增。
  for (let i = 1; i < a.segments.length; i += 1) {
    assert.ok(a.segments[i].fromCursor > a.segments[i - 1].toCursor)
  }
})

check('范围段覆盖 covered/waiting/disconnected 三类，且第三表含断开段', () => {
  const m = createManifest(baseInput).data!
  const kinds = new Set(m.segments.map((s) => s.kind))
  assert.ok(kinds.has('covered') && kinds.has('waiting') && kinds.has('disconnected'))
  assert.ok(m.segments.some((s) => s.table === 'ods_user' && s.kind === 'disconnected'))
})

console.log('2. 同笔封单：目标落盘与源端水位签收一起完成')
check('封单后写入回执、提交水位与 cursor_digest', () => {
  const m = seal(createManifest(baseInput).data!, [], 1)
  assert.ok(m.receipt)
  assert.equal(m.receipt.sealSeq, 1)
  assert.equal(m.committedWatermark, m.receipt.targetWatermark)
  assert.equal(m.cursorDigest, m.receipt.cursorDigest)
  assert.equal(m.status, 'sealed')
})

check('封单是同笔事务：缺水位时整体回滚', () => {
  const m = createManifest(baseInput).data!
  // 人为破坏源端高水位，模拟签收条件不成立。
  const broken = { ...m, sourceHighWatermark: '' }
  const r = sealManifest(broken, [], 1)
  assert.equal(r.ok, false)
  assert.equal(r.data, undefined)
})

console.log('3. 中断续写：按剩余游标推进，整表重灌被禁止')
check('续写只推进等待段，未读游标单调向前，不发生整表重灌', () => {
  let m = seal(createManifest(baseInput).data!, [], 1)
  const before = m.unreadCursor
  // 表 3 张，每表至少 2 个等待段，续写多次直到无可推进。
  let guard = 0
  let lastUnread = before
  while (guard < 20) {
    const r = resumeManifest(m)
    assert.ok(r.ok, r.message)
    m = r.data!
    if (m.unreadCursor !== lastUnread) {
      assert.ok(m.unreadCursor > lastUnread, '游标只能前进')
      lastUnread = m.unreadCursor
    }
    if (m.status === 'completed' || m.status === 'interrupted') {
      // 第三张表有预置断开段，最终应停在 interrupted。
      if (!m.segments.some((s) => s.kind === 'waiting' && !s.landed)) break
    }
    guard += 1
  }
  assert.equal(m.status, 'interrupted')
  assert.ok(m.unreadCursor >= before)
})

check('整表重灌请求被拦截，游标不动并留痕', () => {
  const m = seal(createManifest(baseInput).data!, [], 1)
  const cursorBefore = m.unreadCursor
  const r = fullReloadAttempt(m)
  assert.equal(r.ok, false)
  assert.match(r.message, /整表重灌被禁止/)
  assert.equal(r.data!.unreadCursor, cursorBefore)
  assert.ok(r.data!.violations.some((v) => v.includes('整表重灌')))
})

console.log('4. 链路竞争：只认先封单者；旧回执不得倒退游标')
check('同链路第二张交接单封单被拒，状态 rejected', () => {
  const first = seal(createManifest(baseInput).data!, [], 1)
  const secondDraft = createManifest(baseInput).data!
  const r = sealManifest(secondDraft, [first], 2)
  assert.equal(r.ok, false)
  assert.equal(r.data!.status, 'rejected')
  assert.match(r.data!.violations[0], /先封单/)
})

check('不同链路的交接单互不影响，可各自封单', () => {
  const first = seal(createManifest(baseInput).data!, [], 1)
  const other = seal(
    createManifest({ ...baseInput, linkNo: 'DATA-0002' }).data!,
    [first],
    2,
  )
  assert.equal(other.status, 'sealed')
})

check('旧回执倒退游标被拒，当前游标与水位不变', () => {
  const m = seal(createManifest(baseInput).data!, [], 5)
  const stale = { ...m.receipt!, sealSeq: 2 }
  const cursorBefore = m.unreadCursor
  const r = rollbackWithStaleReceipt(m, stale)
  assert.equal(r.ok, false)
  assert.match(r.message, /旧回执不得倒退游标/)
  assert.equal(r.data!.unreadCursor, cursorBefore)
  assert.ok(r.data!.violations.some((v) => v.includes('倒退')))
})

console.log('5. 持久快照回放：三端 digest 一致，提交水位保留原始字节')
check('回放后 source/target/ODS digest 一致且字节完整', () => {
  const sealed = seal(createManifest(baseInput).data!, [], 1)
  // 模拟跨进程：JSON 序列化再解析（与 localStorage 同路径）。
  const persisted = JSON.parse(JSON.stringify(sealed)) as HandoverManifest
  const r = replayFromSnapshot(persisted)
  assert.ok(r.ok, r.message)
  const c = r.data!.digestCheck
  assert.equal(c.sourceDigest, c.targetDigest)
  assert.equal(c.targetDigest, c.odsDigest)
  assert.equal(c.sourceDigest, persisted.cursorDigest)
  assert.equal(r.data!.watermarkBytesPreserved, true)
  assert.equal(r.data!.restoredWatermark, sealed.committedWatermark)
})

check('提交水位含特殊字符也逐字节保留', () => {
  const m = seal(createManifest(baseInput).data!, [], 1)
  // 给提交水位塞入空格/中文/符号，确认不被 trim 或转码。
  const tricky = '  WM:水位#001 \t-='
  const tampered: HandoverManifest = {
    ...JSON.parse(JSON.stringify(m)),
    committedWatermark: tricky,
  }
  const r = replayFromSnapshot(tampered)
  // 字节被改动 → 与回执目标水位不一致 → 校验失败且字节判定为 false。
  assert.equal(r.ok, false)
  assert.equal(r.data!.restoredWatermark, tricky)
  assert.equal(r.data!.watermarkBytesPreserved, false)
})

check('未封单交接单不允许回放', () => {
  const draft = createManifest(baseInput).data!
  const r = replayFromSnapshot(draft)
  assert.equal(r.ok, false)
})

console.log('6. 摘要稳定性')
check('同样输入 digest 恒定，改一个字节 digest 即变', () => {
  const d1 = cursorDigest('L1', 'WM:100')
  const d2 = cursorDigest('L1', 'WM:100')
  const d3 = cursorDigest('L1', 'WM:101')
  assert.equal(d1, d2)
  assert.notEqual(d1, d3)
  assert.equal(fnv1aHex('').length, 8)
})

console.log(`\n全部通过：${passed} 项检查`)
