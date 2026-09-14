// 测速地址默认使用 HTTP；随包内核的 Clash API 保留用户指定的协议、主机和路径。
export const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204'
export const DEFAULT_DIRECT_TEST_URL = 'http://connectivitycheck.platform.hicloud.com/generate_204'

// 仅移除输入首尾空白，不替换用户指定的检测地址或协议。
export const kernelTestUrl = (raw) => typeof raw === 'string' ? raw.trim() : ''

// 分组测速地址的哨兵值:分组选「自定义地址」时存这个,生成配置 / 延迟测试时再解析成
// 档案里的 customTestUrl。存引用而不是存 URL,「后端设置 → 测速地址」里改一次自定义
// 地址,所有引用它的分组(如 AI 分组用 OpenAI 接口测)一起跟着变。
export const CUSTOM_TEST_URL_TOKEN = 'custom'

// 解析一个分组的测速地址:
//   'custom'      → 档案里的 customTestUrl(没填就回落全局 testUrl)
//   具体 URL       → 原样用(预设地址或手动输入)
//   空            → 全局 testUrl
export const resolveGroupTestUrl = (groupTestUrl, { testUrl, customTestUrl } = {}) => {
  const raw = typeof groupTestUrl === 'string' ? groupTestUrl.trim() : ''
  if (raw === CUSTOM_TEST_URL_TOKEN) {
    const custom = typeof customTestUrl === 'string' ? customTestUrl.trim() : ''
    return custom || testUrl || DEFAULT_TEST_URL
  }
  return raw || testUrl || DEFAULT_TEST_URL
}

// 只迁移旧版内置默认值；自定义 HTTP / HTTPS 地址保持不变。
export const ensureTestUrlDefaults = (store) => {
  const profile = store.getProfile() || {}
  const patch = {}
  if (profile.testUrl === 'https://www.gstatic.com/generate_204') patch.testUrl = DEFAULT_TEST_URL
  if (['https://connectivitycheck.platform.hicloud.com/generate_204', 'http://www.msftconnecttest.com/connecttest.txt'].includes(profile.directTestUrl)) {
    patch.directTestUrl = DEFAULT_DIRECT_TEST_URL
  }
  if (!Object.keys(patch).length) return false
  store.setProfile(patch)
  return true
}
