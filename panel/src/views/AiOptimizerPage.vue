<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto" :style="padding">
    <div class="grid grid-cols-1 gap-3 p-3 xl:grid-cols-2">
      <section class="card border border-base-300/60 bg-base-100">
        <div class="card-body gap-4 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold">{{ $t('aiOptimizerTitle') }}</h2>
              <p class="mt-1 text-xs text-base-content/60">{{ $t('aiOptimizerDescription') }}</p>
            </div>
            <span class="badge badge-warning badge-sm">{{ $t('aiModelNotReady') }}</span>
          </div>
          <label class="flex items-center justify-between gap-3">
            <span class="text-sm">{{ $t('aiOptimizerEnabled') }}</span>
            <input v-model="settings.enabled" type="checkbox" class="toggle toggle-primary toggle-sm" :disabled="busy" @change="save(true)" />
          </label>
          <label class="form-control gap-1">
            <span class="label-text text-sm">{{ $t('aiPolicyPriority') }} ({{ settings.policyPriority }}%)</span>
            <input v-model.number="settings.policyPriority" type="range" min="0" max="100" step="1" class="range range-primary range-sm" @change="save()" />
            <span class="text-xs text-base-content/60">{{ $t('aiPolicyPriorityHint') }}</span>
          </label>
          <label class="form-control gap-1">
            <span class="label-text text-sm">{{ $t('aiSensitivity') }} ({{ settings.sensitivityMs }} ms)</span>
            <input v-model.number="settings.sensitivityMs" type="number" min="0" max="10000" step="5" class="input input-bordered input-sm w-36" @change="save()" />
            <span class="text-xs text-base-content/60">{{ $t('aiSensitivityHint') }}</span>
          </label>
          <label class="flex items-center justify-between gap-3">
            <span class="text-sm">{{ $t('aiAsnPriority') }}</span>
            <input v-model="settings.asnPriority" type="checkbox" class="toggle toggle-primary toggle-sm" disabled />
          </label>
          <p class="text-xs text-warning">{{ $t('aiAsnUnavailable') }}</p>
          <button class="btn btn-outline btn-sm self-start" :disabled="busy" @click="apply">{{ $t('aiApplySettings') }}</button>
        </div>
      </section>

      <section class="card border border-base-300/60 bg-base-100">
        <div class="card-body gap-4 p-4">
          <div>
            <h2 class="text-base font-semibold">{{ $t('aiTrainingTitle') }}</h2>
            <p class="mt-1 text-xs text-base-content/60">{{ $t('aiTrainingDescription') }}</p>
          </div>
          <label class="flex items-center justify-between gap-3">
            <span class="text-sm">{{ $t('aiCollectTraining') }}</span>
            <input v-model="settings.collectTrainingData" type="checkbox" class="toggle toggle-primary toggle-sm" @change="save()" />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="form-control gap-1">
              <span class="label-text text-sm">{{ $t('aiMinSamples') }}</span>
              <input v-model.number="settings.minSamples" type="number" min="1" max="10" class="input input-bordered input-sm" @change="save()" />
            </label>
            <label class="form-control gap-1">
              <span class="label-text text-sm">{{ $t('aiSampleAge') }}</span>
              <input v-model.number="settings.maxSampleAgeHours" type="number" min="1" max="720" class="input input-bordered input-sm" @change="save()" />
            </label>
          </div>
          <label class="form-control gap-1">
            <span class="label-text text-sm">{{ $t('aiLatencyWeight') }} ({{ settings.latencyWeight }}%)</span>
            <input v-model.number="settings.latencyWeight" type="range" min="0" max="100" step="1" class="range range-primary range-sm" @change="save()" />
          </label>
          <label class="form-control gap-1">
            <span class="label-text text-sm">{{ $t('aiReliabilityWeight') }} ({{ settings.reliabilityWeight }}%)</span>
            <input v-model.number="settings.reliabilityWeight" type="range" min="0" max="100" step="1" class="range range-primary range-sm" @change="save()" />
          </label>
          <label class="form-control gap-1">
            <span class="label-text text-sm">{{ $t('aiJitterWeight') }} ({{ settings.jitterWeight }}%)</span>
            <input v-model.number="settings.jitterWeight" type="range" min="0" max="100" step="1" class="range range-primary range-sm" @change="save()" />
          </label>
          <label class="form-control gap-1">
            <span class="label-text text-sm">{{ $t('aiProbeInterval') }}</span>
            <input v-model.number="settings.intervalSeconds" type="number" min="15" max="3600" step="15" class="input input-bordered input-sm w-36" @change="save()" />
          </label>
          <div class="alert alert-info py-2 text-xs">{{ $t('aiTrainingNotReady') }}</div>
          <button class="btn btn-primary btn-sm self-start" disabled :title="$t('aiModelNotReady')">
            {{ $t('aiUpdateModel') }}
          </button>
        </div>
      </section>
      <section class="card border border-base-300/60 bg-base-100 xl:col-span-2">
        <div class="card-body gap-3 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold">{{ $t('aiRuntimeStatus') }}</h2>
              <p class="mt-1 text-xs text-base-content/60">{{ statusText }}</p>
            </div>
            <button class="btn btn-primary btn-sm" :disabled="!settings.enabled || busy" @click="runNow">{{ $t('aiRunNow') }}</button>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <div v-for="group in status.groups" :key="group.tag" class="rounded-box border border-base-300/60 p-3 text-sm">
              <div class="font-medium">{{ group.tag }}</div>
              <div class="mt-1 text-xs text-base-content/60">{{ group.members }} nodes · {{ group.selected || '—' }}</div>
            </div>
          </div>
          <p v-if="status.lastError" class="text-sm text-error">{{ status.lastError }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { deployNow, fetchAiOptimizerStatus, fetchProfile, runAiOptimizerNow, saveProfile, type JBoxProfile } from '@/api/jbox'
import { AI_OPTIMIZER_DEFAULTS, normalizeAiOptimizerSettings } from '@/helper/ai-optimizer-settings.mjs'
import { usePaddingForViews } from '@/composables/paddingViews'
import { showNotification } from '@/helper/notification'
import { onMounted, reactive, ref, computed } from 'vue'

const { padding } = usePaddingForViews({ offsetTop: 0, offsetBottom: 0 })
const busy = ref(false)
const settings = reactive({ ...AI_OPTIMIZER_DEFAULTS })
const status = reactive({ enabled: false, groups: [] as { tag: string; url: string; members: number; selected: string }[], lastRunAt: 0, lastError: '', tested: 0, selected: 0 })
const statusText = computed(() => status.enabled ? `${status.groups.length} groups · ${status.selected}/${status.tested} selected` : 'AI takeover disabled')

const refreshStatus = async () => {
  try { Object.assign(status, await fetchAiOptimizerStatus()) } catch { /* status refresh is best-effort */ }
}

const load = async () => {
  try {
    const profile = await fetchProfile()
    Object.assign(settings, normalizeAiOptimizerSettings(profile.aiOptimizer))
  } catch (error) {
    showNotification({ content: 'routeTestRequestFailed', params: { message: error instanceof Error ? error.message : String(error) }, type: 'alert-error' })
  }
  await refreshStatus()
}

const save = async (applyRuntime = false) => {
  if (busy.value) return
  busy.value = true
  const normalized = normalizeAiOptimizerSettings(settings)
  Object.assign(settings, normalized)
  try {
    await saveProfile({ aiOptimizer: normalized } as Partial<JBoxProfile>)
    if (applyRuntime) {
      await deployNow()
      await refreshStatus()
    }
    showNotification({ content: 'aiSettingsSaved', type: 'alert-success', timeout: 1800 })
  } catch (error) {
    showNotification({ content: 'routeTestRequestFailed', params: { message: error instanceof Error ? error.message : String(error) }, type: 'alert-error' })
    await load()
  } finally {
    busy.value = false
  }
}

const apply = () => save(true)
const runNow = async () => {
  if (busy.value) return
  busy.value = true
  try { await runAiOptimizerNow(); await refreshStatus() }
  catch (error) { showNotification({ content: 'routeTestRequestFailed', params: { message: error instanceof Error ? error.message : String(error) }, type: 'alert-error' }) }
  finally { busy.value = false }
}

onMounted(() => {
  void load()
  window.setInterval(refreshStatus, 15000)
})
</script>
