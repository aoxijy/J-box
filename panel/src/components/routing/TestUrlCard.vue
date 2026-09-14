<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <h2 class="text-base font-semibold">{{ $t('testUrlTitle') }}</h2>
        <p class="text-base-content/60 text-xs">{{ $t('testUrlDescription') }}</p>
      </div>

      <div class="flex flex-col gap-3 sm:flex-row">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('testUrlLabel') }}</label>
          <input
            v-model="testUrl"
            type="url"
            class="input input-sm w-full font-mono text-xs"
            :placeholder="TEST_URL"
            @change="save('testUrl', testUrl)"
          />
          <p class="text-base-content/50 text-xs">{{ $t('testUrlHint') }}</p>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('directTestUrl') }}</label>
          <input
            v-model="directUrl"
            type="url"
            class="input input-sm w-full font-mono text-xs"
            :placeholder="DIRECT_TEST_URL"
            @change="save('directTestUrl', directUrl)"
          />
          <p class="text-base-content/50 text-xs">{{ $t('directTestUrlHint') }}</p>
        </div>
      </div>

      <!-- 分组可选的「自定义地址」:分组测速地址选「自定义地址」时引用这一条。
           典型用法:AI 分组用 https://api.openai.com/v1/models 测,才能反映该节点能不能访问 OpenAI。 -->
      <div class="flex min-w-0 flex-col gap-1">
        <label class="text-xs font-medium">{{ $t('customTestUrl') }}</label>
        <input
          v-model="customUrl"
          type="url"
          class="input input-sm w-full font-mono text-xs"
          placeholder="https://api.openai.com/v1/models"
          @change="save('customTestUrl', customUrl)"
        />
        <p class="text-base-content/50 text-xs">{{ $t('customTestUrlHint') }}</p>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { showNotification } from '@/helper/notification'
import type { JBoxProfile } from '@/api/jbox'
import { DIRECT_TEST_URL, TEST_URL } from '@/constant'
import { kernelTestUrl } from '@/helper/testUrl'
import { directTestUrl, speedtestUrl } from '@/store/settings'
import { ref, watch } from 'vue'

const props = defineProps<{
  profile: JBoxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<JBoxProfile>
}>()

const testUrl = ref(props.profile.testUrl || '')
const directUrl = ref(props.profile.directTestUrl || '')
const customUrl = ref(props.profile.customTestUrl || '')
watch(
  () => props.profile,
  (p) => {
    testUrl.value = p.testUrl || ''
    directUrl.value = p.directTestUrl || ''
    customUrl.value = p.customTestUrl || ''
  },
)

// 空就回落到 HTTP 默认值；自定义地址保留原协议；存进档案的同时
// 更新面板那份,延迟测试立刻按新地址走,不用刷新。
// 分组用的自定义地址允许留空(留空 = 引用它的分组回落全局地址),不套默认值。
const save = async (key: 'testUrl' | 'directTestUrl' | 'customTestUrl', raw: string) => {
  const value =
    key === 'customTestUrl'
      ? kernelTestUrl(raw)
      : kernelTestUrl(raw) || (key === 'testUrl' ? TEST_URL : DIRECT_TEST_URL)
  try {
    await props.patchProfile({ [key]: value })
    if (key === 'testUrl') { speedtestUrl.value = value; testUrl.value = value }
    else if (key === 'directTestUrl') { directTestUrl.value = value; directUrl.value = value }
    else { customUrl.value = value }
  } catch (err) {
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  }
}
</script>
