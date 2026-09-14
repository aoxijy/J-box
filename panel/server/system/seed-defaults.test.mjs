import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadStorageDefaults, seedDefaultStorage } from './seed-defaults.mjs'

const DEFAULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults')

const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-defaults-'))
  fs.writeFileSync(path.join(dir, 'storage-defaults.json'), JSON.stringify({
    'config/theme-mode': 'light', 'config/access-password': 'nope', 'jbox/profile': '{}', 'config/x': 1,
  }))
  fs.writeFileSync(path.join(dir, 'background-image.txt'), 'data:image/jpeg;base64,AAAA\n')
  return dir
}

test('loadStorageDefaults:只收 config/*(排除 access-*)的字符串值;背景必须是 data:image', () => {
  const { entries, background } = loadStorageDefaults(tmpDir())
  assert.deepEqual(entries, { 'config/theme-mode': 'light' })
  assert.equal(background, 'data:image/jpeg;base64,AAAA')
  assert.deepEqual(loadStorageDefaults('/nonexistent'), { entries: {}, background: '' })
})

test('seedDefaultStorage:全新安装写入默认值和背景;已有 config/* 时不动', () => {
  const dir = tmpDir()
  const rows = {}
  const r = seedDefaultStorage({ countConfigEntries: () => 0, insert: (k, v) => { rows[k] = v }, dir })
  assert.equal(r.seeded, 2)
  assert.equal(rows['config/theme-mode'], 'light')
  assert.equal(rows.__background_image__, 'data:image/jpeg;base64,AAAA')
  const rows2 = {}
  assert.deepEqual(seedDefaultStorage({ countConfigEntries: () => 5, insert: (k, v) => { rows2[k] = v }, dir }), { seeded: 0, profile: false })
  assert.deepEqual(rows2, {})
})

test('随包的默认值文件本身合法:有主题等关键项,背景是 data:image', () => {
  const { entries, background } = loadStorageDefaults()
  assert.equal(entries['config/theme-mode'], 'light')
  assert.ok(entries['config/global-radius'])
  assert.ok(!Object.keys(entries).some((k) => k.startsWith('config/access-')))
  assert.ok(background.startsWith('data:image/'))
})

test('全新安装同时写入默认档案(目标分流);已有 jbox/profile 或已有 config/* 时不动', async () => {
  const { loadProfileDefaults, PROFILE_KEY } = await import('./seed-defaults.mjs')
  const defaults = loadProfileDefaults()
  assert.ok(defaults && defaults.routing && defaults.routing.policies.length >= 5, '随包的 profile-defaults.json 要有一套站点集')
  const names = defaults.routing.policies.map((p) => p.name)
  for (const n of ['AI', '社交聊天', '微软苹果', '国外媒体', '开发平台', '国外', 'Games', '国内', '拦截']) assert.ok(names.includes(n), n)
  assert.equal(defaults.routing.fallbackName, '漏网之鱼')
  // 兜底不能是「直连」:没被站点集命中的域名会直连 + 拿上游 DNS 解析,被墙的那些就是污染/打不开
  // (2026-09-14 现场:兜底=直连时 dns.final=dns-direct)。健康检查地址必须是 HTTPS:
  // HTTP 的 gstatic 测不出 TLS / Google 系不通的节点,组会卡在坏节点上(实测真有这种节点)。
  assert.notEqual(defaults.routing.fallbackDefault, 'direct', '兜底默认要走代理')
  assert.match(String(defaults.testUrl), /^https:\/\//, '默认健康检查地址用 HTTPS')
  assert.equal(defaults.dns.fakeIpForProxy, true, '走代理域名默认 FakeIP:客户端 DNS 不能依赖节点')
  assert.equal(defaults.dns.mode, 'hijack', '默认 hijack:客户端 DNS 不经过 dnsmasq 那一跳')
  // 不带任何个人域名
  // 默认档案取自作者自己的路由器,发出去之前必须把个人域名摘干净
  const PERSONAL = /angeworld|opendoor|superdoor|wanhouse|wan\.family|ok1248/
  for (const p of defaults.routing.policies)
    for (const d of [...(p.domain || []), ...(p.domainSuffix || []), ...(p.domainKeyword || [])])
      assert.ok(!PERSONAL.test(d), d)
  // 全新:写入
  const fresh = new Map()
  const r1 = seedDefaultStorage({ countConfigEntries: () => 0, insert: (k, v) => fresh.set(k, v), hasKey: (k) => fresh.has(k) })
  assert.equal(r1.profile, true)
  assert.deepEqual(JSON.parse(fresh.get(PROFILE_KEY)).routing.policies.map((p) => p.name), names)
  // 已有档案:不覆盖
  const withProfile = new Map([[PROFILE_KEY, '{"routing":{"policies":[]}}']])
  const r2 = seedDefaultStorage({ countConfigEntries: () => 0, insert: (k, v) => withProfile.set(k, v), hasKey: (k) => withProfile.has(k) })
  assert.equal(r2.profile, false)
  assert.equal(withProfile.get(PROFILE_KEY), '{"routing":{"policies":[]}}')
  // 老安装(有 config/*):什么都不写
  const old = new Map()
  const r3 = seedDefaultStorage({ countConfigEntries: () => 5, insert: (k, v) => old.set(k, v), hasKey: (k) => old.has(k) })
  assert.equal(r3.profile, false)
  assert.equal(old.size, 0)
})

test('全新安装预置规则集:把随包 .srs 铺进 data/rulesets 并写状态;已有状态时不动', async () => {
  const { seedBundledRuleLists } = await import('./seed-defaults.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-rulesets-'))
  const dir = path.join(root, 'defaults')
  fs.mkdirSync(path.join(dir, 'rulesets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'rulesets', 'list-aaaa.srs'), 'srs-domain')
  fs.writeFileSync(path.join(dir, 'rulesets', 'list-aaaa-ip.srs'), 'srs-ip')
  fs.writeFileSync(path.join(dir, 'rule-lists.json'), JSON.stringify({
    'list-aaaa': { url: 'https://example.com/a.mrs', at: 0, counts: { domain: 2, ip_cidr: 1 }, split: 2 },
  }))
  const paths = { dataDir: path.join(root, 'data'), rulesetDir: path.join(root, 'data', 'rulesets') }
  const r = seedBundledRuleLists({ paths, dir })
  assert.equal(r.seeded, 2)
  assert.equal(r.lists, 1)
  assert.equal(fs.readFileSync(path.join(paths.rulesetDir, 'list-aaaa.srs'), 'utf8'), 'srs-domain')
  assert.equal(fs.readFileSync(path.join(paths.rulesetDir, 'list-aaaa-ip.srs'), 'utf8'), 'srs-ip')
  const state = JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'rule-lists.json'), 'utf8'))
  assert.equal(state['list-aaaa'].url, 'https://example.com/a.mrs')
  assert.ok(state['list-aaaa'].at > 0)
  assert.deepEqual(state['list-aaaa'].counts, { domain: 2, ip_cidr: 1 })
  assert.equal(state['list-aaaa'].split, 2)
  // 第二次(已有状态):不重铺,也不改已有的 at
  const at = state['list-aaaa'].at
  assert.deepEqual(seedBundledRuleLists({ paths, dir }), { seeded: 0, lists: 0 })
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'rule-lists.json'), 'utf8'))['list-aaaa'].at, at)
})

test('随包的规则集快照和默认档案对得上:档案里每条规则集链接都有编好的 .srs 与状态', async () => {
  const { loadProfileDefaults } = await import('./seed-defaults.mjs')
  const { listTagForUrl } = await import('../engine/rule-list.mjs')
  const state = JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, 'rule-lists.json'), 'utf8'))
  const profile = loadProfileDefaults()
  const urls = []
  for (const p of profile.routing.policies) for (const u of (p.ruleUrls || [])) urls.push(u)
  assert.ok(urls.length > 0, '默认档案里要有规则集链接')
  for (const url of urls) {
    const tag = listTagForUrl(url)
    assert.ok(state[tag], `缺少 ${tag} 的状态`)
    assert.equal(state[tag].url, url)
    assert.ok(
      fs.existsSync(path.join(DEFAULTS_DIR, 'rulesets', `${tag}.srs`)) || fs.existsSync(path.join(DEFAULTS_DIR, 'rulesets', `${tag}-ip.srs`)),
      `缺少 ${tag} 的 .srs`,
    )
  }
})

test('预置的规则集让首次部署不必联网:ensureRuleLists 直接用这份快照', async () => {
  const { seedBundledRuleLists, loadProfileDefaults } = await import('./seed-defaults.mjs')
  const { ensureRuleLists } = await import('./rule-lists.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-offline-'))
  const paths = { dataDir: path.join(root, 'data'), rulesetDir: path.join(root, 'data', 'rulesets') }
  const seeded = seedBundledRuleLists({ paths, dir: DEFAULTS_DIR })
  assert.ok(seeded.seeded > 0)
  const routing = loadProfileDefaults().routing
  const ctx = {
    exists: async (p) => fs.existsSync(p),
    readFile: async (p) => fs.readFileSync(p, 'utf8'),
    writeFile: async (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d) },
    mkdirp: async (p) => { fs.mkdirSync(p, { recursive: true }) },
    remove: async (p) => { fs.rmSync(p, { force: true }) },
    exec: async () => { throw new Error('本地文件是最新版式,不该调用内核重新编译') },
  }
  let fetched = 0
  const r = await ensureRuleLists(ctx, paths, routing, { fetchImpl: async () => { fetched += 1; throw new Error('offline') } })
  assert.equal(r.ok, true)
  assert.equal(fetched, 0, '预置的文件与状态都新鲜,一次网络都不该发')
  assert.deepEqual(r.updated, [])
  assert.deepEqual(r.failed, [])
  // 形状表拿得到,生成配置时才知道每条链接该引用哪几份 .srs
  const tag = Object.keys(r.lists)[0]
  assert.ok(r.lists[tag].domain || r.lists[tag].ip)
})
