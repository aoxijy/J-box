// 分组测速地址的预设。值是真实 URL——存进 group.testUrl,服务端生成配置时直接用。
// 「自定义地址」不是预设:它写哨兵值 custom,由服务端解析成档案里的 customTestUrl
// (见 server/engine/test-url.mjs),这样在「后端设置 → 测速地址」改一次,引用它的分组全部跟着变。
//
// 说明:内核 URLTest 只看 HTTP 往返是否成功、不校验状态码(实测 sing-box 1.14
// common/urltest/urltest.go 不读 StatusCode),所以 api.openai.com 返回 401 也算"通"——
// 它测的正是"这个节点能不能连上 OpenAI",而不是"有没有带 API key"。
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
