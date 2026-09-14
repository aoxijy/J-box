# sing-box 1.14.0 J-Box 兼容补丁

这是 J-Box 的兼容补丁，不是 sing-box 官方版本；不更改 J-Box 的 DNS 协议、规则顺序、解析器地址、策略出口、FakeIP 或旁路配置。完整发布构建保留上游全部默认功能（包括 Naive），采用 CGO 和静态 musl 链接。

## 已复现的问题

2026-09-10，在用户现有代理线路上，同一 TCP DNS 连接刚建立时正常，空闲 30 秒后再次查询不再收到应答，也没有及时收到 EOF。相同线路、解析器和查询，在独立进程对照中：

- 官方 1.13.14：空闲 32 秒后约 40 ms 返回。
- 官方 1.14.0：空闲 32 秒后连续两次超过 3 秒查询期限。
- 应用此补丁的 1.14.0：空闲后约 39、40 ms 返回。

1.13.14 的 TCP DNS 每次查询建立并关闭连接；1.14.0 增加了复用探测和共用连接。补丁只改变 `dns/transport/tcp.go` 的同步与异步 Exchange 入口，复用其原有 `exchangeSingle` 实现，恢复每次查询单独建立 TCP 连接的行为。查询仍经原策略的 `detour` 出口进行。TCP DNS 仍使用原服务器和端口，不改为 DoH、DoT 或 UDP。

这确认了本次空闲连接超时的触发机制，不表示所有节点和网络路径都会触发，也不表示所有网页的所有延迟均由此造成。首次创建连接也曾在一个隔离场景中超时一次，该结果保留在测试记录中。

## 构建与回归

要求 Go >= 1.25.5，实际验证使用 Go 1.26.8。源码固定为上游 v1.14.0，并核对下载归档 SHA-256；依赖沿用其 go.mod / go.sum。`CC` / `CXX` 必须使用适配目标架构的 Clang 与 musl sysroot；构建默认使用上游 `DEFAULT_BUILD_TAGS` 加 `with_musl`，不会退回缺少 Naive 的精简构建。

```sh
CC='/path/to/clang --target=x86_64-openwrt-linux-musl --sysroot=/path/to/x86_64-sysroot' \
CXX='/path/to/clang++ --target=x86_64-openwrt-linux-musl --sysroot=/path/to/x86_64-sysroot' \
JBOX_GO_BINARY=/path/to/go \
scripts/singbox-tcp-dns-hotfix/build.sh amd64 /path/to/output
```

arm64 将编译器 target 改为 `aarch64-openwrt-linux-musl`、使用相应 sysroot，并把脚本首个参数改为 `arm64`。已有上游归档时可设置 `JBOX_SINGBOX_SOURCE_ARCHIVE`，仍然强制检查 SHA-256。

本次构建工具链与上游 cronet-go 的 musl 方案相同：Chromium Clang `llvmorg-23-init-10931-g20b6ec66-11`，OpenWrt `23.05.5` / GCC `12.3.0` 的 x86_64、aarch64 musl sysroot；Naive 使用 go.sum 固定的 Cronet 静态库。二进制归档中的 `BUILD-INFO.json` 记录源码、工具链、构建标签和哈希，发布附件另含修改后的 sing-box 源码、补丁、测试和构建脚本。

TCP DNS 补丁最初版本为 `1.14.0-jbox-tcp1`。回归覆盖空闲连接无回应、同步/异步查询、A/AAAA/HTTPS 类型、查询 ID 和 NXDOMAIN 保留、查询取消后关闭连接。相同回归针对未修改源码运行时，在空闲后的第三次查询失败；补丁通过。

代价：缓存未命中的 TCP DNS 查询不再共享一条 TCP 连接，每次需要新建连接。正常 DNS 应答缓存保留，HTTP/QUIC 的业务连接复用不变。

## HTTP 测速（tcp2）

`1.14.0-jbox-tcp2` 保留 TCP DNS 补丁，并应用 `http-latency.patch`：

- Clash API 的 `/proxies/:name/delay` 和 `/group/:name/delay` 接受原样的 HTTP 地址，不再丢弃后回落到 gstatic HTTPS。
- 原生 URLTest 的空地址默认改为 HTTP。成功不足 1 ms 时返回 1 ms，避免客户端把成功的零延迟误判成不可用。
- 保留原生 HEAD 请求、不跟随重定向、节点出站拨号、历史记录和 URLTest 重选逻辑。URLTest 组使用其配置中的地址；手动组和单节点使用 API 指定的地址。
- HTTP 是默认值，自定义 HTTPS 仍然受支持。

`build.sh` 同时运行 TCP DNS 和 HTTP/HTTPS 探测回归。面板的 `server/system/http-latency.integration.test.mjs` 启动真实内核、三个本地 HTTP CONNECT 节点和一个 204 服务，覆盖指定地址、直连、手动选择、批量检测、自动优选、定时调度、主备失败阈值、全部失败及恢复回切。测试不使用真实订阅或路由器配置。

本机可以设置 `JBOX_TEST_SINGBOX=/path/to/new/sing-box` 运行集成测试；发布 CI 使用本次从源码构建的完整内核。内核和面板必须一起更新，旧版内核仍会丢弃 HTTP 测速地址。

## 探测状态码（tcp3）

`1.14.0-jbox-tcp3` 在 tcp2 之上追加 `urltest-status.patch`：

- 原生 URLTest 只看 HTTP 往返成功与否、不读状态码。于是按地区封锁的站点（例如 OpenAI 对不支持地区返回 `403 unsupported_country_region_territory`）也会被判成「可用」，AI 分组可能选中实际打不开 OpenAI 的节点。
- 补丁把 `403 / 451 / 511`（被拒绝 / 法律屏蔽 / 门户认证）判为探测失败；其余状态（`204/200/401/404/429…`）保持原样，一律算可达。
- 因此 `https://api.openai.com/v1/models` 成为一个有判别力的地址：健康节点回 `401`（缺 API key）算通，被封锁/被拒回 `403` 算不通。实测 HEAD/GET 均为 401。
- 内置预设地址（gstatic / Cloudflare / YouTube 的 `generate_204`、Microsoft `connecttest`、GitHub `robots.txt`）都不会返回 403，行为不变。
- 回归：`TestJBoxHTTPRejectedStatusIsFailure`（403 必须失败）、`TestJBoxHTTPAuthChallengeIsReachable`（401 仍算可达），随 `http_latency_test.go` 一起在构建时运行。

## Clash API 定时探测（tcp4）

`1.14.0-jbox-tcp4` 在 tcp3 之上追加 `urltest-force.patch`：

- 问题:内核的 `/proxies/:name/delay` 每被调用一次,就会对**所有包含该节点的 URLTest 组**
  重跑一次择优(`PerformUpdateCheck`)。面板按检测间隔定时探测时,一个被多个组共享的节点
  几秒内会被反复探测,顺带把每个组都重选一遍——用户设的 300 秒间隔完全不起作用,重选还
  常常跳到 history 里延迟低、其实已经不通的节点上。
- 补丁给两个 Clash API 端点都加了 `force`(默认 `true`,与上游一致)与 `interval`(毫秒,
  仅 `/proxies/:name/delay` 用):
  - `force=false` + `interval` 且该节点 history 还新鲜 → **直接把已有延迟返回**,既不重测
    也不触发 `PerformUpdateCheck`;
  - `force=false` 的组测速走新的 `URLTestGroup.URLTestForce(ctx, force)`,没到间隔的成员
    由内核自己跳过(上游 `URLTestOutbounds` 原有逻辑);
  - **不带这两个参数 = 手动测速,仍然是强制真测**(面板「测速」按钮、订阅页一键测速走的
    就是这条)。
- 面板侧对应实现见 `panel/server/system/probe-coordinator.mjs`(按「节点 + 测速地址」共享
  结果、并发合并、按各组最短 interval 复用)。
- 旧版内核会忽略这两个参数,行为退回"每次都真测";面板侧的复用依然生效,所以面板与内核
  可以分开升级。

## 交付边界

`build.sh` 只生成完整静态内核，不会部署、替换正式路由器或发布 GitHub Release。构建后通过 `dt-needed.py --assert-static` 检查没有动态链接器和动态库依赖。

最初用于定位故障的 CGO=0 精简二进制未包含 Naive，只用于开发验证；正式发布包使用后续完整构建。部署先用新二进制 `check` 当前生成配置、验证隔离实例，再备份原内核并替换。保留原 config.json、config.meta.json、档案、用户选择及 DNS 上游设置；通过正常服务重启启用新内核。

上游源码：

- https://github.com/SagerNet/sing-box/blob/v1.13.14/dns/transport/tcp.go
- https://github.com/SagerNet/sing-box/blob/v1.14.0/dns/transport/tcp.go
- https://github.com/SagerNet/sing-box/blob/v1.14.0/dns/transport/multiplexer.go
