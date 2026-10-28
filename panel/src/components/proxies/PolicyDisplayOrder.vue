<template>
  <!-- Display and matching both follow Settings > Target routing. -->
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-2">
      <div class="text-xs font-medium">{{ $t('policyMatchOrder') }}</div>
      <div class="flex flex-col gap-1">
        <!-- 前置自定义分流固定排在所有站点集之前(见 server/engine/routing.mjs),所以钉在这一列
             最上面。它不是站点集、不占编号,用「前置」标记表示"在下面这些之前";没规则或停用时
             它不进内核配置,标成未生效并压暗。 -->
        <div
          v-if="customPolicySummary"
          class="bg-base-200/60 flex items-center gap-2 rounded-lg px-2 py-1.5"
          :class="!customPolicySummary.active && 'opacity-50'"
        >
          <span class="w-4 shrink-0" />
          <ProxyIcon
            v-if="customIcon"
            :icon="customIcon"
            :size="16"
            :scale="customPolicySummary.iconScale"
            :margin="0"
          />
          <span class="truncate text-sm">{{ customPolicySummary.name }}</span>
          <span class="badge badge-ghost badge-xs shrink-0">{{ $t('routingCustomBadge') }}</span>
          <span
            v-if="!customPolicySummary.active"
            class="text-base-content/50 shrink-0 text-xs"
          >{{ $t('routingCustomInactiveBadge') }}</span>
        </div>
        <div
          v-for="(name, index) in matchOrder"
          :key="name"
          class="bg-base-200/60 flex items-center gap-2 rounded-lg px-2 py-1.5"
        >
          <span class="text-base-content/40 w-4 shrink-0 text-center text-xs">{{ index + 1 }}</span>
          <ProxyIcon
            v-if="iconOf(name)"
            :icon="iconOf(name)"
            :size="16"
            :scale="scaleOf(name)"
            :margin="0"
          />
          <span class="truncate text-sm">{{ name }}</span>
        </div>
      </div>
      <p class="text-base-content/50 text-xs">{{ $t('policyMatchOrderHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import ProxyIcon from '@/components/proxies/ProxyIcon.vue'
import { iconUrlFor } from '@/helper/iconUrl'
import { customPolicySummary, siteSetIconScales, siteSetIcons, siteSetOrder } from '@/store/jboxSiteSets'
import { computed } from 'vue'

const iconOf = (name: string) => iconUrlFor(siteSetIcons.value.get(name) || 'globe:earth-meridians') || ''
const scaleOf = (name: string) => siteSetIconScales.value.get(name) || 0
const matchOrder = computed(() => siteSetOrder.value)
const customIcon = computed(() => iconUrlFor(customPolicySummary.value?.icon || '') || '')
</script>
