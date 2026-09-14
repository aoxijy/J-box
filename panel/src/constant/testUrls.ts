// 分组测速地址的预设。值是真实 URL——存进 group.testUrl,服务端生成配置时直接用。
// 「自定义地址」不是预设:它写哨兵值 custom,由服务端解析成档案里的 customTestUrl
// (见 server/engine/test-url.mjs),这样在「后端设置 → 测速地址」改一次,引用它的分组全部跟着变。
//
// 说明:随包内核打过 urltest-status.patch——403/451/511(被拒绝/地区封锁/门户认证)算探测
// 失败,其余状态一律算可达。所以 api.openai.com/v1/models 是有判别力的:健康节点回 401
// (缺 API key)算通,被 OpenAI 按地区封锁回 403 算不通。内核版本见
// scripts/singbox-tcp-dns-hotfix/README.md 的「探测状态码(tcp3)」。
export const CUSTOM_TEST_URL_TOKEN = 'custom'

export interface TestUrlPreset {
  id: string
  labelKey: string
  url: string
}

export const TEST_URL_PRESETS: TestUrlPreset[] = [
  { id: 'openai', labelKey: 'testUrlPresetOpenAI', url: 'https://api.openai.com/v1/models' },
  { id: 'google', labelKey: 'testUrlPresetGoogle', url: 'http://www.gstatic.com/generate_204' },
  { id: 'github', labelKey: 'testUrlPresetGitHub', url: 'https://github.com/robots.txt' },
  { id: 'cloudflare', labelKey: 'testUrlPresetCloudflare', url: 'http://cp.cloudflare.com/generate_204' },
  { id: 'youtube', labelKey: 'testUrlPresetYouTube', url: 'https://www.youtube.com/generate_204' },
  { id: 'microsoft', labelKey: 'testUrlPresetMicrosoft', url: 'http://www.msftconnecttest.com/connecttest.txt' },
]

export const isTestUrlPreset = (value?: string): boolean =>
  TEST_URL_PRESETS.some((preset) => preset.url === (value || '').trim())
