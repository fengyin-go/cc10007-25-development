<template>
  <section class="handover-panel">
    <div class="handover-head">
      <div>
        <h3>切换交接单（全量快照 → 增量尾流）</h3>
        <p class="page-desc">
          依据同步表列表、两端连接与延迟阈值生成交接单，标出覆盖带、重叠去重窗与未读游标；
          目标落盘与源端水位同笔封单，中断后按剩余游标续写，禁止整表重灌。
        </p>
      </div>
      <button class="btn ghost" type="button" @click="resetAll">清空交接单</button>
    </div>

    <form class="filter-bar handover-form" @submit.prevent="onGenerate">
      <label class="filter-item">
        <span>同步链路</span>
        <select v-model="form.linkNo" required>
          <option v-for="row in links" :key="String(row.id)" :value="String(row['链路编号'])">
            {{ row['链路编号'] }}（{{ row['源端连接'] }} → {{ row['目标端连接'] }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>同步表列表（逗号分隔）</span>
        <input v-model="form.tablesText" placeholder="ods_order,ods_pay,ods_user" required />
      </label>
      <label class="filter-item">
        <span>延迟阈值（秒）</span>
        <input v-model.number="form.lagThresholdSec" type="number" min="1" required />
      </label>
      <button class="btn primary" type="submit">生成交接单</button>
    </form>

    <p v-if="message" :class="['handover-msg', messageOk ? 'ok-text' : 'error-text']">{{ message }}</p>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>交接单号</th>
          <th>链路</th>
          <th>同步表</th>
          <th>状态</th>
          <th>未读游标</th>
          <th>cursor_digest</th>
          <th>提交水位（原始字节）</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in manifests" :key="m.manifestNo">
          <td>
            <button class="link" type="button" @click="toggleDetail(m.manifestNo)">
              {{ m.manifestNo }}
            </button>
          </td>
          <td>{{ m.linkNo }}</td>
          <td>{{ m.tables.join(', ') }}</td>
          <td :class="statusClass(m.status)">{{ STATUS_LABEL[m.status] }}</td>
          <td class="mono">{{ m.unreadCursor }}</td>
          <td class="mono">{{ m.cursorDigest ?? '—' }}</td>
          <td class="mono">{{ m.committedWatermark ?? '—' }}</td>
          <td class="row-actions">
            <button v-if="m.status === 'draft'" class="link" type="button" @click="onSeal(m.manifestNo)">
              同笔封单
            </button>
            <button
              v-if="canResume(m.status)"
              class="link"
              type="button"
              @click="onResume(m.manifestNo)"
            >
              按剩余游标续写
            </button>
            <button
              v-if="m.receipt && m.status !== 'completed' && m.status !== 'rejected'"
              class="link"
              type="button"
              @click="onInterrupt(m.manifestNo)"
            >
              模拟中断
            </button>
            <button
              v-if="m.receipt && m.status !== 'rejected'"
              class="link danger"
              type="button"
              @click="onFullReload(m.manifestNo)"
            >
              整表重灌（应拦截）
            </button>
            <button
              v-if="m.receipt"
              class="link danger"
              type="button"
              @click="onStaleRollback(m.manifestNo)"
            >
              旧回执倒退（应拒绝）
            </button>
            <button
              v-if="m.receipt"
              class="link"
              type="button"
              @click="onReplay(m.manifestNo)"
            >
              快照回放校验
            </button>
          </td>
        </tr>
        <tr v-if="!manifests.length">
          <td colspan="8" class="empty-state">暂无交接单，先选择链路生成一张</td>
        </tr>
      </tbody>
    </table>

    <div v-for="m in manifests" :key="`detail-${m.manifestNo}`">
      <article v-if="openNo === m.manifestNo" class="handover-detail">
        <header class="detail-head">
          <h4>{{ m.manifestNo }} 范围明细</h4>
          <span :class="['status-pill', statusClass(m.status)]">{{ STATUS_LABEL[m.status] }}</span>
        </header>

        <div class="range-grid">
          <div>
            <span class="range-label">覆盖带（全量快照）</span>
            <p class="mono">[{{ m.coverFrom }} , {{ m.coverTo }}]</p>
          </div>
          <div>
            <span class="range-label">重叠去重窗（延迟阈值 {{ m.lagThresholdSec }}s）</span>
            <p class="mono">[{{ m.overlapFrom }} , {{ m.overlapTo }}]</p>
          </div>
          <div>
            <span class="range-label">尚未读取游标</span>
            <p class="mono">{{ m.unreadCursor }}</p>
          </div>
          <div>
            <span class="range-label">源端高水位</span>
            <p class="mono">{{ m.sourceHighWatermark }}</p>
          </div>
        </div>

        <table class="data-table seg-table">
          <thead>
            <tr>
              <th>段</th>
              <th>同步表</th>
              <th>区间（原始字节游标）</th>
              <th>范围状态</th>
              <th>落盘</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="seg in m.segments" :key="`${m.manifestNo}-${seg.index}`">
              <td>{{ seg.index }}</td>
              <td>{{ seg.table }}</td>
              <td class="mono">[{{ seg.fromCursor }} , {{ seg.toCursor }}]</td>
              <td :class="segClass(seg.kind)">{{ SEGMENT_LABEL[seg.kind] }}</td>
              <td>{{ seg.landed ? '已落盘' : '未落盘' }}</td>
              <td>{{ seg.reason ?? '—' }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="m.receipt" class="receipt-box">
          <h5>封单回执（先封单者赢）</h5>
          <p class="mono">sealSeq={{ m.receipt.sealSeq }} · sealedAt={{ formatTime(m.receipt.sealedAt) }}</p>
          <p class="mono">源端签收水位：{{ m.receipt.sourceWatermark }}</p>
          <p class="mono">目标落盘水位：{{ m.receipt.targetWatermark }}</p>
          <p class="mono">回执 cursor_digest：{{ m.receipt.cursorDigest }}</p>
        </div>

        <ul v-if="m.violations.length" class="violation-list">
          <li v-for="(v, i) in m.violations" :key="i" class="error-text">{{ v }}</li>
        </ul>

        <article v-if="replayResult && replayResult.manifestNo === m.manifestNo" class="replay-box">
          <h5>持久快照回放核对</h5>
          <p class="mono">source digest：{{ replayResult.digestCheck.sourceDigest }}</p>
          <p class="mono">target digest：{{ replayResult.digestCheck.targetDigest }}</p>
          <p class="mono">ODS&nbsp;&nbsp;&nbsp; digest：{{ replayResult.digestCheck.odsDigest }}</p>
          <p :class="replayResult.digestCheck.consistent ? 'ok-text' : 'error-text'">
            三端 cursor_digest {{ replayResult.digestCheck.consistent ? '一致' : '不一致' }}
          </p>
          <p class="mono">恢复提交水位：{{ replayResult.restoredWatermark }}</p>
          <p :class="replayResult.watermarkBytesPreserved ? 'ok-text' : 'error-text'">
            committed_watermark 原始字节 {{ replayResult.watermarkBytesPreserved ? '完整保留' : '被改动' }}
          </p>
        </article>
      </article>
    </div>

    <article class="watermark-review">
      <h4>增量水位回看（以数据同步为主对象）</h4>
      <p class="page-desc">
        回看只围绕同步链路的增量水位：封单提交水位、当前未读游标与源端高水位逐条核对，
        游标只能向前，任何倒退或整表重灌都会在违规记录里留痕。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>链路</th>
            <th>交接单</th>
            <th>封单提交水位（原始字节）</th>
            <th>当前未读游标</th>
            <th>源端高水位</th>
            <th>水位核对</th>
            <th>违规留痕</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in manifests" :key="`wm-${m.manifestNo}`">
            <td>{{ m.linkNo }}</td>
            <td>{{ m.manifestNo }}</td>
            <td class="mono">{{ m.committedWatermark ?? '—' }}</td>
            <td class="mono">{{ m.unreadCursor }}</td>
            <td class="mono">{{ m.sourceHighWatermark }}</td>
            <td :class="watermarkOk(m) ? 'ok-text' : 'error-text'">
              {{ watermarkOk(m) ? '游标未倒退' : '存在异常' }}
            </td>
            <td>{{ m.violations.length ? `${m.violations.length} 条` : '无' }}</td>
          </tr>
          <tr v-if="!manifests.length">
            <td colspan="7" class="empty-state">暂无交接单水位可回看</td>
          </tr>
        </tbody>
      </table>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import {
  attemptFullReload,
  attemptStaleRollback,
  generateHandover,
  interruptHandover,
  loadManifests,
  replayHandover,
  resetHandovers,
  resumeHandover,
  sealHandover,
} from '@/data/handover/service'
import { SEGMENT_LABEL, STATUS_LABEL } from '@/data/handover/types'
import type {
  HandoverManifest,
  ManifestStatus,
  ReplayState,
  SegmentKind,
} from '@/data/handover/types'

const links = ref<EntryRow[]>([])
const manifests = ref<HandoverManifest[]>([])
const openNo = ref<string>('')
const message = ref('')
const messageOk = ref(true)
const replayResult = ref<ReplayState | null>(null)

const form = reactive({
  linkNo: '',
  tablesText: 'ods_order,ods_pay,ods_user',
  lagThresholdSec: 30,
})

const cards = computed(() => [
  { label: '交接单总数', value: manifests.value.length },
  {
    label: '已封单（含尾流）',
    value: manifests.value.filter((m) => m.receipt !== null && m.status !== 'rejected').length,
  },
  { label: '中断待续写', value: manifests.value.filter((m) => m.status === 'interrupted').length },
  { label: '竞争/违规拒绝', value: manifests.value.filter((m) => m.status === 'rejected').length },
])

function canResume(status: ManifestStatus): boolean {
  return status === 'sealed' || status === 'streaming' || status === 'interrupted'
}

function statusClass(status: ManifestStatus): string {
  return `status-${status}`
}

/** 水位核对：已封单且无违规、未读游标不早于提交水位，即视为健康。 */
function watermarkOk(m: HandoverManifest): boolean {
  if (m.status === 'rejected' || m.violations.length > 0) {
    return false
  }
  if (!m.committedWatermark) {
    return true
  }
  // 游标为定长编码字符串，字典序与编码顺序一致，可直接比较先后。
  return m.unreadCursor >= m.committedWatermark
}

function segClass(kind: SegmentKind): string {
  return `seg-${kind}`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function flash(ok: boolean, text: string): void {
  messageOk.value = ok
  message.value = text
}

function refresh(): void {
  manifests.value = loadManifests()
}

function onGenerate(): void {
  const tables = form.tablesText
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
  const link = links.value.find((row) => String(row['链路编号']) === form.linkNo)
  if (!link) {
    flash(false, '请选择有效的同步链路')
    return
  }
  const result = generateHandover({
    linkNo: form.linkNo,
    tables,
    sourceConn: String(link['源端连接']),
    targetConn: String(link['目标端连接']),
    lagThresholdSec: Number(form.lagThresholdSec),
  })
  flash(result.ok, result.message)
  if (result.ok && result.data) {
    openNo.value = result.data.manifestNo
  }
  refresh()
}

function onSeal(no: string): void {
  const result = sealHandover(no)
  flash(result.ok, result.message)
  refresh()
}

function onResume(no: string): void {
  const result = resumeHandover(no)
  flash(result.ok, result.message)
  refresh()
}

function onInterrupt(no: string): void {
  const result = interruptHandover(no)
  flash(result.ok, result.message)
  refresh()
}

function onFullReload(no: string): void {
  const result = attemptFullReload(no)
  // 被拦截属于规则生效，提示用错误色强调「已拦截」。
  flash(false, result.message)
  refresh()
}

function onStaleRollback(no: string): void {
  const result = attemptStaleRollback(no)
  flash(false, result.message)
  refresh()
}

function onReplay(no: string): void {
  const result = replayHandover(no)
  flash(result.ok, result.message)
  if (result.data) {
    replayResult.value = result.data
    openNo.value = no
  }
  refresh()
}

function toggleDetail(no: string): void {
  openNo.value = openNo.value === no ? '' : no
  if (openNo.value !== no) {
    replayResult.value = null
  }
}

function resetAll(): void {
  resetHandovers()
  replayResult.value = null
  openNo.value = ''
  flash(true, '交接单已清空')
  refresh()
}

onMounted(() => {
  links.value = listEntries('datasync').items
  if (links.value.length && !form.linkNo) {
    form.linkNo = String(links.value[0]['链路编号'])
  }
  refresh()
})
</script>

<style scoped>
.handover-panel {
  margin-top: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}
.handover-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.handover-head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.handover-form {
  margin-top: 12px;
}
.handover-msg {
  font-size: 13px;
  margin: 8px 0;
}
.ok-text {
  color: #067647;
}
.mono {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  word-break: break-all;
}
.link.danger {
  color: #b42318;
}
.handover-detail {
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 14px;
  margin: 10px 0 18px;
  background: #fbfdff;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.range-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 10px 0;
}
.range-label {
  font-size: 12px;
  color: var(--muted);
}
.range-grid p {
  margin: 2px 0 0;
}
.seg-table {
  margin-top: 8px;
}
.status-pill {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.status-draft {
  color: #64748b;
  background: #eef2f7;
}
.status-sealed,
.status-streaming {
  color: #1f6feb;
  background: #e8f0fe;
}
.status-interrupted {
  color: #b54708;
  background: #fef3e2;
}
.status-completed {
  color: #067647;
  background: #e7f6ee;
}
.status-rejected {
  color: #b42318;
  background: #fdeaea;
}
.seg-waiting {
  color: #b54708;
  font-weight: 600;
}
.seg-covered {
  color: #067647;
  font-weight: 600;
}
.seg-disconnected {
  color: #b42318;
  font-weight: 600;
}
.receipt-box,
.replay-box {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
}
.receipt-box h5,
.replay-box h5 {
  margin: 0 0 6px;
}
.receipt-box p,
.replay-box p {
  margin: 2px 0;
}
.violation-list {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12px;
}
.watermark-review {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.watermark-review h4 {
  margin: 0 0 4px;
}
</style>
