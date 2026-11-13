<template>
  <section class="range-reader">
    <div class="reader-head">
      <h3>{{ title }}</h3>
      <p class="page-desc">{{ desc }}</p>
    </div>

    <div v-if="!manifests.length" class="empty-box">
      数据同步尚未生成交接单。请先到「数据同步」生成并封单，这里会读取同一份交接单范围。
    </div>

    <template v-else>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">等待范围段</span>
          <strong class="stat-value seg-waiting">{{ countOf('waiting') }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">覆盖范围段</span>
          <strong class="stat-value seg-covered">{{ countOf('covered') }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">断开范围段</span>
          <strong class="stat-value seg-disconnected">{{ countOf('disconnected') }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">读取交接单数</span>
          <strong class="stat-value">{{ manifests.length }}</strong>
        </article>
      </div>

      <div v-for="m in manifests" :key="m.manifestNo" class="manifest-card">
        <header class="manifest-head">
          <div>
            <strong>{{ m.manifestNo }}</strong>
            <span class="link-no">链路 {{ m.linkNo }} · 表 {{ m.tables.join(', ') }}</span>
          </div>
          <span :class="['status-pill', `status-${m.status}`]">{{ STATUS_LABEL[m.status] }}</span>
        </header>

        <!-- 范围条：把每张表的段按比例铺成一条色带，等待/覆盖/断开一目了然。 -->
        <div class="range-track" :title="`${m.manifestNo} 范围带`">
          <span
            v-for="seg in m.segments"
            :key="`${m.manifestNo}-${seg.index}`"
            :class="['track-seg', `track-${seg.kind}`, { dim: !seg.landed && seg.kind === 'covered' }]"
          >
            {{ seg.table }}#{{ seg.index }}
          </span>
        </div>

        <table class="data-table seg-table">
          <thead>
            <tr>
              <th>同步表</th>
              <th>游标区间（原始字节）</th>
              <th>范围</th>
              <th>落盘</th>
              <th v-if="consumer === 'ods'">ODS 读取结论</th>
              <th v-else-if="consumer === 'qual'">质量判定</th>
              <th v-else>监控告警</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="seg in m.segments" :key="`${m.manifestNo}-${seg.index}`">
              <td>{{ seg.table }}</td>
              <td class="mono">[{{ seg.fromCursor }} , {{ seg.toCursor }}]</td>
              <td :class="`seg-${seg.kind}`">{{ SEGMENT_LABEL[seg.kind] }}</td>
              <td>{{ seg.landed ? '已落盘' : '未落盘' }}</td>
              <td>{{ odsOrConsumerConclusion(seg.kind, seg.landed, seg.reason) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { loadManifests } from '@/data/handover/service'
import { SEGMENT_LABEL, STATUS_LABEL } from '@/data/handover/types'
import type { HandoverManifest, SegmentKind } from '@/data/handover/types'

const props = defineProps<{
  consumer: 'ods' | 'qual' | 'moni'
  title: string
  desc: string
}>()

// 直接读取数据同步封单后的同一份交接单，不另存副本，保证回看以数据同步为主对象。
const manifests = computed<HandoverManifest[]>(() => loadManifests())

function countOf(kind: SegmentKind): number {
  return manifests.value.reduce(
    (sum, m) => sum + m.segments.filter((s) => s.kind === kind).length,
    0,
  )
}

function odsOrConsumerConclusion(
  kind: SegmentKind,
  landed: boolean,
  reason?: string,
): string {
  if (props.consumer === 'ods') {
    if (kind === 'covered') {
      return landed ? '贴源读取全量快照覆盖数据' : '覆盖带尚未落盘，暂不读取'
    }
    if (kind === 'waiting') {
      return '沿增量尾流等待新游标到达'
    }
    return '链路断开，ODS 停在当前游标不越界读取'
  }
  if (props.consumer === 'qual') {
    if (kind === 'covered') {
      return landed ? '覆盖带去重窗内按主键去重校验' : '覆盖未落盘，规则挂起'
    }
    if (kind === 'waiting') {
      return '等待段纳入增量质量规则巡检'
    }
    return `断开段不产出质量结论（${reason ?? '链路断开'}）`
  }
  // moni
  if (kind === 'covered') {
    return landed ? '覆盖带落盘延迟正常' : '覆盖带落盘滞后，触发关注'
  }
  if (kind === 'waiting') {
    return '按延迟阈值监控等待时长'
  }
  return `断开告警：${reason ?? '链路断开'}`
}
</script>

<style scoped>
.range-reader {
  margin-top: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}
.reader-head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.empty-box {
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 18px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.manifest-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.manifest-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.link-no {
  margin-left: 10px;
  color: var(--muted);
  font-size: 12px;
}
.range-track {
  display: flex;
  gap: 2px;
  margin-bottom: 10px;
  border-radius: 6px;
  overflow: hidden;
}
.track-seg {
  flex: 1;
  font-size: 10px;
  color: #fff;
  text-align: center;
  padding: 4px 2px;
  white-space: nowrap;
  overflow: hidden;
}
.track-covered {
  background: #12b76a;
}
.track-waiting {
  background: #f79009;
}
.track-disconnected {
  background: #f04438;
}
.track-seg.dim {
  opacity: 0.45;
}
.seg-table {
  margin-top: 6px;
}
.mono {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  word-break: break-all;
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
</style>
