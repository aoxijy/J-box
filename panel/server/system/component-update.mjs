// Local verification only. Downloads are handled by update.sh from our own GitHub Release.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const GEO_DIR = 'panel/server/resources/geodata'
const HASH = /^[a-f0-9]{64}$/
const VERSION = /^v[0-9][A-Za-z0-9._-]*$/
const GEO_FILE = /^(geoip|geosite)-[A-Za-z0-9._!@-]+\.srs$/
const readJson = name => JSON.parse(fs.readFileSync(name, 'utf8'))
export const fileHash = name => {
  const hash = createHash('sha256')
  const fd = fs.openSync(name, 'r')
  try {
    const block = Buffer.allocUnsafe(1024 * 1024)
    let size
    while ((size = fs.readSync(fd, block))) hash.update(block.subarray(0, size))
    return hash.digest('hex')
  } finally { fs.closeSync(fd) }
}

export const validateManifest = (manifest, arch, expected = '') => {
  if (manifest.schema !== 1 || !VERSION.test(manifest.version) || !['x64', 'arm64'].includes(arch)
      || manifest.arch !== arch || (expected && manifest.version !== expected)) throw new Error('组件清单版本或架构不匹配')
  if (Object.keys(manifest.components || {}).sort().join(',') !== 'app,geo,kernel,runtime') throw new Error('组件清单不完整')
  for (const kind of ['app', 'runtime', 'kernel', 'geo']) {
    const c = manifest.components?.[kind]
    const asset = `j-box-${manifest.version}-linux-${arch}-${kind}.tar.gz`
    if (!c || c.asset !== asset || !HASH.test(c.sha256) || !Number.isSafeInteger(c.size) || c.size < 1
        || typeof c.version !== 'string' || !c.version) throw new Error(`组件清单不合法: ${kind}`)
    if (kind === 'geo') {
      if (!/^[a-f0-9]{40}$/.test(c.version) || !HASH.test(c.manifestSha256)) throw new Error('Geo 清单不合法')
    } else if (kind !== 'app') {
      const prefix = kind === 'kernel' ? 'bin/' : 'node/'
      const required = kind === 'kernel' ? 'bin/sing-box' : 'node/bin/node'
      if (!c.files?.[required] || !Object.entries(c.files).every(([name, hash]) => name.startsWith(prefix)
          && /^[A-Za-z0-9/._+-]+$/.test(name) && !name.includes('..') && HASH.test(hash))) throw new Error(`组件文件清单不合法: ${kind}`)
    }
  }
  if (manifest.components.app.version !== manifest.version) throw new Error('程序版本不匹配')
  return manifest
}

export const componentMatches = (root, kind, component) => {
  try {
    if (kind === 'app') return false
    if (kind !== 'geo') {
      return Object.entries(component.files).every(([name, hash]) => fileHash(path.join(root, name)) === hash)
    }
    const dir = path.join(root, GEO_DIR)
    if (fileHash(path.join(dir, 'manifest.json')) !== component.manifestSha256) return false
    const geo = readJson(path.join(dir, 'manifest.json'))
    if (geo.version !== component.version || geo.schema !== 1) return false
    const files = Object.entries(geo.files || {})
    return files.length > 0 && ['geoip', 'geosite'].every(k => geo.counts?.[k] > 0
      && geo.counts[k] === files.filter(([name]) => name.startsWith(k + '-')).length)
      && files.every(([name, hash]) => GEO_FILE.test(name) && !name.includes('..') && HASH.test(hash)
        && fileHash(path.join(dir, name)) === hash)
  } catch { return false }
}

export const planUpdate = (manifest, root, arch, expected) => {
  validateManifest(manifest, arch, expected)
  return Object.entries(manifest.components).map(([kind, c]) => ({
    kind, action: componentMatches(root, kind, c) ? 'reuse' : 'download', ...c,
  })).sort((a, b) => ['app', 'runtime', 'kernel', 'geo'].indexOf(a.kind) - ['app', 'runtime', 'kernel', 'geo'].indexOf(b.kind))
}

export const verifyStage = (manifest, root) => {
  validateManifest(manifest, manifest.arch)
  const meta = readJson(path.join(root, 'meta.json'))
  if (meta.version !== manifest.version || meta.arch !== manifest.arch
      || meta.singboxVersion !== manifest.components.kernel.version
      || meta.nodeVersion !== manifest.components.runtime.version
      || meta.geoVersion !== manifest.components.geo.version) throw new Error('安装包元数据与组件清单不匹配')
  for (const kind of ['runtime', 'kernel', 'geo']) {
    if (!componentMatches(root, kind, manifest.components[kind])) throw new Error(`组件校验失败: ${kind}`)
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, file, root, arch, expected] = process.argv.slice(2)
    const manifest = readJson(file)
    if (command === 'plan') {
      for (const c of planUpdate(manifest, root, arch, expected)) console.log([c.kind, c.action, c.asset, c.sha256, c.size].join('\t'))
    } else if (command === 'verify') verifyStage(manifest, root)
    else throw new Error('unknown command')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
