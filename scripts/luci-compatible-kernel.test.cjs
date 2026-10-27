const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../openwrt/luci/htdocs/luci-static/resources/view/jbox/status.js'), 'utf8');
const start = source.indexOf('function compatibleKernelRelease(');
const end = source.indexOf('function checkCompatibleKernel()', start);
const parse = new Function(source.slice(start, end) + 'return compatibleKernelRelease;')();
function release() {
  return {tag_name:'v0.1.206', body:'<!-- jbox-compatible-kernel:1.14.4-jbox-tcp2 -->',
    assets:['-kernel.tar.gz','-kernel.tar.gz.sha256','-components.json','.tar.gz','.tar.gz.sha256']
      .map(suffix => ({name:'j-box-v0.1.206-linux-x64'+suffix}))};
}
test('published matching build becomes a compatible candidate', () => {
  assert.deepEqual(parse(release(),'x64'),{version:'1.14.4-jbox-tcp2',release:'v0.1.206'});
});
test('upstream version alone cannot enable an upgrade', () => {
  const r=release();r.body='Official latest v1.14.4';assert.throws(()=>parse(r,'x64'));
});
test('missing assets, unsupported architecture and prereleases cannot enable upgrade', () => {
  const r=release();r.assets.pop();assert.throws(()=>parse(r,'x64'));
  assert.throws(()=>parse(release(),'arm64'));
  assert.throws(()=>parse(release(),'mips'));
  assert.throws(()=>parse({...release(),prerelease:true},'x64'));
  assert.throws(()=>parse({...release(),draft:true},'x64'));
});
test('existing J-Box release notes remain discoverable', () => {
  const r=release();r.body='- sing-box 内核版本:`1.14.0-jbox-tcp2`';
  assert.equal(parse(r,'x64').version,'1.14.0-jbox-tcp2');
});
