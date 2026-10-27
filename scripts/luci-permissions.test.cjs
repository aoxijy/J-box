const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
for (const name of ['install.sh', 'update.sh']) {
  test(name + ' exposes LuCI assets after copying mode 700 files under umask 077', {skip:process.platform==='win32'}, t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jbox-luci-permissions-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const source=path.join(dir,'source');
    const assets=[
      ['openwrt/luci/htdocs/luci-static/resources/view/jbox/status.js','www/luci-static/resources/view/jbox/status.js'],
      ['openwrt/luci/root/usr/share/luci/menu.d/luci-app-jbox.json','usr/share/luci/menu.d/luci-app-jbox.json'],
      ['openwrt/luci/root/usr/share/rpcd/acl.d/luci-app-jbox.json','usr/share/rpcd/acl.d/luci-app-jbox.json'],
    ];
    for(const [input,output] of assets){
      const file=path.join(source,input);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');fs.chmodSync(file,0o700);
      const dest=path.join(dir,output);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,'old');fs.chmodSync(dest,0o700);
    }
    const full=fs.readFileSync(path.join(__dirname,name),'utf8');
    const start=full.indexOf('mkdir -p /www/luci-static/resources/view/jbox');
    const end=full.indexOf(name==='install.sh'?'\n# 不清缓存':'\n# 用 -rf',start);
    assert.ok(start>=0&&end>start);
    const block=full.slice(start,end).replace(/(?<=[\s"=])\/(www|usr\/share)\//g,(_,prefix)=>dir+'/'+prefix+'/');
    execFileSync('sh',['-eu','-c',`umask 077\nINSTALL_ROOT='${source}'\ndie(){ echo "$*" >&2; exit 1; }\nwarn(){ echo "$*" >&2; exit 1; }\n${block}`]);
    for(const [,output] of assets){
      const file=path.join(dir,output);
      assert.equal(fs.statSync(file).mode&0o777,0o644);
      assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o755);
      assert.equal(fs.readFileSync(file,'utf8'),'fixture');
    }
  });
}
