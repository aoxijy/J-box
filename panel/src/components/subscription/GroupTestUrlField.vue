<template>
  <div class="flex min-w-0 flex-1 flex-col gap-1">
    <label class="text-xs font-medium">{{ $t('groupTestUrl') }}</label>
    <select
      :value="mode"
      class="select select-sm w-full"
      @change="onModeChange"
    >
      <option value="global">{{ $t('testUrlModeGlobal') }}</option>
      <option value="custom">{{ $t('testUrlModeCustom') }}</option>
      <option
        v-for="preset in TEST_URL_PRESETS"
        :key="preset.id"
        :value="preset.url"
      >
        {{ $t(preset.labelKey) }}
      </option>
      <option value="manual">{{ $t('testUrlModeManual') }}</option>
    </select>
    <input
      v-if="mode === 'manual'"
      v-model="manualValue"
      type="url"
      class="input input-sm w-full font-mono text-xs"
      :placeholder="$t('groupTestUrlPlaceholder')"
      @change="emit('update:modelValue', manualValue.trim())"
    />
    <p
      v-else-if="mode === 'custom'"
      class="text-base-content/50 text-xs"
    >
      {{ $t('groupTestUrlCustomHint') }}
    </p>
    <p
      v-else
      class="text-base-content/50 text-xs"
    >
      {{ mode === 'global' ? $t('groupTestUrlPlaceholder') : currentUrl }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { TEST_URL_PRESETS } from '@/constant/testUrls'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const GLOBAL_MODE = 'global'
const CUSTOM_MODE = 'custom'
const MANUAL_MODE = 'manual'

// 选「手动输入」但不改内容时,值还是原来的(可能是某个预设);forceManual 让下拉停在
// 「手动输入」并露出输入框,不靠值本身去反推模式。
const forceManual = ref(false)
const manualValue = ref('')

const currentUrl = computed(() => (props.modelValue || '').trim())

const mode = computed(() => {
  if (forceManual.value) return MANUAL_MODE
  const value = currentUrl.value
  if (!value) return GLOBAL_MODE
  if (value === CUSTOM_MODE) return CUSTOM_MODE
  if (TEST_URL_PRESETS.some((preset) => preset.url === value)) return value
  return MANUAL_MODE
})

// 换分组/换编辑对象时,外部值变了就以它为准重新判断模式
watch(
  () => props.modelValue,
  (value) => {
    const trimmed = (value || '').trim()
    if (!trimmed || trimmed === CUSTOM_MODE || TEST_URL_PRESETS.some((preset) => preset.url === trimmed)) {
      forceManual.value = false
    }
    if (forceManual.value) manualValue.value = trimmed
  },
)

watch(
  mode,
  (value) => {
    if (value === MANUAL_MODE) manualValue.value = currentUrl.value
  },
  { immediate: true },
)

const onModeChange = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value
  if (value === MANUAL_MODE) {
    // 只是露出输入框,先不动已存的值:用户输入并失焦/回车后才写回
    forceManual.value = true
    manualValue.value = currentUrl.value
    return
  }
  forceManual.value = false
  emit('update:modelValue', value === GLOBAL_MODE ? '' : value)
}
</script>
