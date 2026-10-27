const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

test('EasyTier launch wrapping is idempotent and preserves updater binary paths', {skip:process.platform==='win32'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbox-easytier-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const fixture = `#!/bin/sh
easytierbin=/usr/bin/easytier-core
path=$(dirname "$easytierbin")
ver="$($easytierbin -V)"
cd /tmp ; \${easytierbin} -c \${config_file} &
cd /tmp ; \${easytierbin} \${core_cmd} &
`;
  for (const folder of ['usr/bin', 'usr/libexec', 'etc/init.d', 'opt/j-box/data', 'proc']) {
    fs.mkdirSync(path.join(dir, folder), {recursive:true});
  }
  fs.writeFileSync(path.join(dir,'usr/bin/easytier-core'), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir,'usr/bin/easytier-core'), 0o755);
  const init = path.join(dir,'etc/init.d/easytier');
  fs.writeFileSync(init, fixture);
  const source = fs.readFileSync(path.join(__dirname,'../openwrt/initd/easytier-compat.sh'),'utf8');
  const script = source.replace(/\/(usr|etc|opt|proc)\//g, (_,prefix) => dir+'/'+prefix+'/')
    .replace('command -v capsh', 'command -v sh');
  execFileSync('sh', ['-eu','-c',script]);
  const first = fs.readFileSync(init,'utf8');
  assert.equal(first.split('jbox-easytier-core').length-1, 2);
  assert.ok(first.includes('easytierbin=/usr/bin/easytier-core'));
  assert.ok(first.includes('ver="$($easytierbin -V)"'));
  execFileSync('sh', ['-eu','-c',script]);
  assert.equal(fs.readFileSync(init,'utf8'), first);
  const wrapper = fs.readFileSync(path.join(dir,'usr/libexec/jbox-easytier-core'),'utf8');
  assert.ok(wrapper.includes('--gid=20260'));
  assert.ok(wrapper.includes('jbox-easytier "$@"'));
  assert.ok(!wrapper.includes('/usr/bin/easytier-core'));
});
