# asy-webdav — 山大云盘 WebDAV 网关

**不装官方客户端、不需要本地同步盘**，直接用 [`asy-cli`](../asy-cli) 的 AnyShare HTTP API 提供标准 WebDAV 服务，供 Zotero / Obsidian 使用。

```
┌─────────┐   WebDAV    ┌──────────────┐   AnyShare HTTP API   ┌────────────┐
│ Zotero  │ ──────────▶ │  asy-webdav  │ ────────────────────▶ │  山大云盘   │
│ Obsidian│ ◀────────── │  (本服务)     │ ◀──────────────────── │ (AnyShare) │
└─────────┘  127.0.0.1  └──────────────┘   osdownload/直传直链   └────────────┘
                         自定义 webdav-server FileSystem
```

对比原来的 `webdav-wrapper` 方案（官方客户端 + `D:\SyncDisk` + 本地 WebDAV）：

| | webdav-wrapper | asy-webdav（本服务） |
|---|---|---|
| 官方客户端 | 必须装、必须常开 | **不需要** |
| 本地磁盘占用 | 云端全量镜像 | **零**（只在未知长度上传时用临时文件） |
| 同步延迟 | 取决于客户端 | 实时直读云端 |
| 多设备 | 只有同步盘所在那台能提供 WebDAV | 任何能跑 Node 的机器都行（Linux 服务器也可以） |
| 顺带解决 | — | 官方客户端 `winhook64.dll` 注入导致 Obsidian 崩溃的问题 |

---

## 快速开始

### 0. 前置条件

- Node.js 18+
- 一个能用的 AnyShare 账号（本项目在山大云盘 `icloud.sdu.edu.cn` 上实测）
- **[`asy-cli`](https://github.com/HTwoOhwater/anyshare-university-cli)** —— 本项目的云盘 API 全部来自它

`asy-cli` 没有发布到 npm，但已声明为本项目的依赖，`npm install` 会**自动从 GitHub 拉取**，
不需要手动克隆。装完登录一次即可（token 会自动续期）：

```bat
asy-webdav login --cas
```

> **为什么不是 `asy login`**：npm 全局安装时**不会**把依赖包的 bin 放到 PATH 上
> （实测 `asy.cmd` 只躺在 `node_modules/asy-webdav/node_modules/.bin/` 里，外面调不到）。
> `asy-webdav login` 直接用装载器解析到的那个 asy-cli 实例，参数**原样转发**
> （`--cas`、`--cookie`、`--refresh-token` 等都能用），也保证凭据写进服务将要读取的目录。
>
> 想单独把 asy-cli 当命令行工具用，再装一次即可：
> `npm i -g github:HTwoOhwater/anyshare-university-cli`

> 本网关按下面的顺序找 `asy-cli`：
>
> 1. 环境变量 `ASY_CLI_PATH` 指向的目录
> 2. `asy-webdav` 的同级目录 `../asy-cli`（开发时的布局）
> 3. 包内嵌套的 `node_modules/anyshare-university-cli`
> 4. **Node 模块解析** —— 走这条路才能正确处理 npm 的依赖提升
>    （本地安装和 `-g` 全局安装都会把依赖提到顶层 `node_modules`，
>    上面写死的第 3 条在那个布局下并不存在）

### 1. 安装

**方式 A：全局安装（推荐，一条命令）**

```bat
npm install -g github:HTwoOhwater/asy-webdav
```

装完就有 `asy-webdav` 命令，配置和日志放在用户目录，升级包不会丢。

**方式 B：克隆仓库（想改代码时用）**

```bat
cd C:\path\to\asy-webdav
npm install
```

> 方式 B 的目录结构（`asy-cli` 由 npm 自动装进 `node_modules`，无需手动 clone）：
>
> ```
> C:\path\to\asy-webdav\
> ├── cli.js
> ├── server.js
> ├── config.json          ← 首次运行生成（含密码，已在 .gitignore 里）
> └── node_modules\
>     └── anyshare-university-cli\   ← npm install 自动拉取
> ```

### 2. 配置 `config.json`（首次运行会自动生成）

```json
{
  "port": 1901,
  "host": "127.0.0.1",
  "username": "webdav",
  "password": "<自动生成的随机密码>",
  "remoteRoot": "/WebDAV/SyncDisk",
  "cacheTtlMs": 15000,
  "apiConcurrency": 4,
  "ondup": 3,
  "debug": false,
  "asyConfigDir": ""
}
```

| 字段 | 说明 |
|---|---|
| `port` | 监听端口（默认 1901） |
| `host` | 单个监听地址。默认 `127.0.0.1`（只本机可访问） |
| `hosts` | **要同时监听多个地址时用这个**（优先级高于 `host`）。例如 `["127.0.0.1", "100.104.198.100"]` = 本机 + Tailscale。填的是**本机要绑定的地址**，不是客户端白名单，也**不支持网段**（见下） |
| `username` / `password` | WebDAV Basic 认证（强制开启） |
| `remoteRoot` | WebDAV 的 `/` 映射到云端哪个目录。默认 `/WebDAV/SyncDisk`（和原方案同一个目录，可无缝切换） |
| `cacheTtlMs` | 目录列举缓存。**这个值直接决定 API 调用量**，15 秒足够 Zotero/Obsidian 用 |
| `apiConcurrency` | 同时在飞的云盘 API 请求上限，别设太大 |
| `ondup` | 上传重名策略：`1`=拒绝同名 `2`=保留两者 `3`=覆盖（默认 3，见下文实测） |
| `asyConfigDir` | 本服务独立使用的 asy-cli 凭据目录，**强烈建议设置**（见「坑」第 1 条） |

> ⚠️ **不要用 `0.0.0.0`**。那会让服务同时暴露在校园网 IP 上（`<校园网IP>`），
> 而保护只有一层 Basic 认证。用 `hosts` 明确列出允许的地址即可。

> 📌 **`hosts` 填的是「本机绑定到哪个地址」，不是「允许哪些客户端访问」。**
>
> 这是最容易搞混的一点。绑定本机的一个地址之后，那个网络上的**所有**设备都能连，
> 不需要、也**不能**写网段：
>
> - 实测 `["100.64.0.0/10"]` → 启动失败：`getaddrinfo ENOTFOUND 100.64.0.0/10`
>   （`listen()` 会把 host 当主机名去解析，CIDR 解析不了）
> - 实测绑定 `100.104.198.100` 时，iPad（`100.109.148.19`）发了 **195 个请求全部成功** ——
>   客户端 IP 和绑定 IP 不同，照样能连
>
> 所以只需填**本机自己的地址**，一个就够。`asy-webdav config set hosts` 会在填错时当场提示，
> `asy-webdav doctor` 也会列出本机可用地址。

### 3. 启动

```bat
asy-webdav start          :: 后台启动
asy-webdav status         :: 看状态（进程 / 端口 / 端到端探测）
asy-webdav stop           :: 停止
asy-webdav restart        :: 重启
```

想看实时输出就用前台模式（Ctrl+C 停止，不写 PID 文件）：

```bat
asy-webdav start --foreground
:: 或者直接 npm start
```

启动成功的样子：

```
✅ 服务已启动
   PID      : 31496
   监听地址 : 127.0.0.1:1901  ,  100.x.y.z:1901
   日志     : C:\...\server.log
   停止     : asy-webdav stop
```

`asy-webdav status` 会顺便发一个**带认证的 `PROPFIND /`** 做端到端验证，
这样「进程活着但云端不通」这种情况也能立刻看出来：

```
运行状态
  状态         : ✅ 运行中（127.0.0.1:1901）
  PID          : 31496（来源：pid 文件）
  端到端       : ✅ PROPFIND / → 207
```

> 启动时会先解析云端根目录，配置错了会立刻报错，而不是等 Zotero 报错。

### 4. 配置 Zotero

编辑 → 首选项 → 同步 → 文件同步方式选 **WebDAV**：

- URL：`http://127.0.0.1:1901/zotero`
- 用户名 / 密码：`config.json` 里的

### 5. 配置 Obsidian（Remotely Save 插件）

- 远程服务：**WebDAV**
- 服务器地址：**要填到 vault 那一层**，例如 `http://127.0.0.1:1901/obsidian/MyVault`
- 用户名 / 密码：同上

> ⚠️ **不要把地址填成 vault 的父目录**（如 `http://127.0.0.1:1901/obsidian`）。
>
> Remotely Save 会把「本地 vault 根」映射到「你填的远程目录」。如果填的是父目录：
>
> - 本地 `笔记/` 会被传到 `/obsidian/笔记/`（平级错位，跑到 vault 外面去了）
> - 而云端已有的 `MyVault/`、`Obsidian Vault/` 在本地没有对应物 → 双向同步下会被判定为
>   「远端已删除」→ **有可能把整个 vault 从云端删掉**
>
> 判断 vault 根的方法：**该目录下有 `.obsidian/` 文件夹**。
>
> ```powershell
> Get-ChildItem C:\Users\<用户名>\Documents -Directory -Force -Filter .obsidian -Recurse -Depth 3
> ```

> 举例：假设你的 vault 叫 `MyVault`，它在云端位于 `/WebDAV/SyncDisk/obsidian/MyVault`，
> 本地在 `C:\Users\<用户名>\Documents\MyVault`。那么 Remotely Save 的服务器地址就是
> `http://127.0.0.1:1901/obsidian/MyVault`——**多一层都不行，少一层更不行**。

> `/zotero` 已存在于云端，两个客户端互不干扰。

---

## 命令行参考

`asy-webdav` 分两层，互不依赖。

### 进程管理（三平台一致，不需要任何权限）

| 命令 | 说明 |
|---|---|
| `asy-webdav start` | 后台启动，写 PID 文件与日志 |
| `asy-webdav start --foreground` | 前台运行，Ctrl+C 停止（不写 PID 文件） |
| `asy-webdav stop [--force]` | 停止。`--force` 用于「端口被占但查不到 PID」时 |
| `asy-webdav restart` | 重启 |
| `asy-webdav status [--json] [--no-probe]` | 状态：进程 / 端口 / 端到端探测 / 后端凭据 |
| `asy-webdav logs [--access\|--err] [-f] [-n 30]` | 看日志，`-f` 持续跟踪 |

「是否在运行」以**端口能否连通**为准，而不是只看 PID 文件。这一点是刻意的：

- 服务由 systemd / 任务计划程序拉起时**根本没有 PID 文件**，只看文件会误判成「未运行」；
- 反过来，手工 `node server.js` 起的进程也能被 `stop` 认出来（按端口反查 PID）。

### 后端登录

| 命令 | 说明 |
|---|---|
| `asy-webdav login [参数…]` | 登录云盘，参数原样转发给 asy-cli（如 `asy-webdav login --cas`） |

### 配置与诊断

| 命令 | 说明 |
|---|---|
| `asy-webdav config show` | 显示配置（密码打码） |
| `asy-webdav config set <键> <值>` | 改配置，`hosts` 用逗号分隔 |
| `asy-webdav config path` | 显示各文件位置 |
| `asy-webdav doctor` | 环境自检 |

**换机器部署前先跑 `asy-webdav doctor`**：

```
✅ Node.js 版本
✅ 运行目录可写
✅ 配置文件
✅ 监听地址
✅ 服务运行中
✅ 端到端探测
✅ asy-cli
✅ 凭据
⚠️  服务化（自启）
```

其中「监听地址」专治换机器的经典翻车：`hosts` 里写死的旧机器 IP
不属于新机器时，服务会因 `EADDRNOTAVAIL` **直接启动失败**。doctor 会提前指出来。

### 文件位置与环境变量

默认全部与包同目录（和旧版本一致）。用 `ASY_WEBDAV_HOME` 可以改到别处：

```bat
set ASY_WEBDAV_HOME=C:\data\asy-webdav
asy-webdav config path
```

| 环境变量 | 作用 |
|---|---|
| `ASY_WEBDAV_HOME` | 运行目录（`config.json` / 日志 / PID 文件） |
| `ASY_WEBDAV_CONFIG` | 只覆盖 `config.json` 的路径 |
| `ASY_CONFIG_DIR` | 传给 `asy-cli` 的凭据目录 |
| `ASY_CLI_PATH` | `asy-cli` 仓库位置 |

## 服务化（开机 / 登录自启）

```bat
asy-webdav service install          :: 登录后自动启动（不需要管理员权限）
asy-webdav service install --boot   :: 开机就启动（Windows 需要管理员）
asy-webdav service status
asy-webdav service uninstall
```

`--dry-run` 只打印将要写入的内容，不落盘 —— 装之前先看一眼最稳妥：

```bat
asy-webdav service install --dry-run
```

按平台生成**原生**配置，不引入 nssm 之类的第三方包装器：

| 平台 | 生成什么 | 默认 | `--boot` | `--system` |
|---|---|---|---|---|
| Windows | `.cmd` 包装脚本 + 任务计划程序任务 | 登录触发（免管理员） | `ONSTART` + SYSTEM（需管理员） | — |
| Linux | systemd unit | `systemctl --user`（免 root） | 自动开 `linger` | 装到 `/etc/systemd/system`（需 sudo） |
| macOS | launchd plist | `~/Library/LaunchAgents` | 同左 | `/Library/LaunchDaemons`（需 root） |

### 为什么生成的配置里要写死绝对路径

服务/计划任务在**「没有加载用户配置文件」**的环境下运行时，`os.homedir()`
会指向 `C:\Windows\System32\config\systemprofile` 之类的系统目录，
于是 `~/.anyshare-cli/config.json` 就找不到了，服务直接起不来。

所以生成的单元文件/包装脚本会把 `ASY_WEBDAV_HOME`、`ASY_CONFIG_DIR`、
`ASY_CLI_PATH` 三个**绝对路径**钉死。这也正是 `config.json` 里 `asyConfigDir`
那一项存在的意义。

> 💡 **顺带解决 token 互踢**：给服务单独设一份 `asyConfigDir` 并单独登录一次，
> 服务就有了自己的 `refresh_token`，不会再和 `asy` 命令行互相踢下线（见「坑」第 5 条）。

### 重启后不登录也能用吗

| 方式 | 重启后 | 需要管理员 |
|---|---|---|
| `service install`（默认） | 必须先登录一次 | ❌ |
| `service install --boot` | 不用登录 | ✅ |

如果是从 iPad 通过 Tailscale 连桌面机，而桌面机重启后停在登录界面，
默认方式就连不上 —— 要避免就必须用 `--boot`。

## 在新机器上部署

```bat
:: 1. 装（需要 Node 18+）
npm install -g github:HTwoOhwater/asy-webdav

:: 2. 登录云盘（asy-cli 会作为依赖自动装好）
asy-webdav login --cas

:: 3. 生成配置，记下打印出来的密码
asy-webdav config show

:: 4. 改监听地址 —— 填新机器自己的地址
asy-webdav config set hosts 127.0.0.1,100.x.y.z

:: 5. 启动并自检
asy-webdav start
asy-webdav doctor
```

### 必须改的两项

| 配置 | 不改会怎样 |
|---|---|
| `hosts` | 里面写死的旧机器 IP 不属于新机器时，`listen` 报 `EADDRNOTAVAIL`，服务**直接启动失败**。改成新机器自己的地址（`ipconfig` / `ip addr` 看，或跑 `asy-webdav doctor` 让它列出来）。**只填地址，不填网段** |
| `remoteRoot` | 必须和旧机器**一字不差**，否则客户端看到的是另一个目录 |

> ⚠️ `remoteRoot` 是唯一真正危险的一项。如果指到一个空目录，
> Remotely Save 可能把「云端为空」理解成「文件都被删了」，**反向删除本地文件**。
> 改完先跑 `asy-webdav doctor` 确认树是对的，再让客户端连。

### 迁移顺序

两个实例共用同一份 `refresh_token` 会互相踢下线，所以按这个顺序：

```
新机器装好 → asy-webdav doctor 通过 → 旧机器 asy-webdav stop → 客户端改地址
```

`asy-webdav doctor` 会把上面每一项都检查一遍，包括「监听地址是否属于本机」
和「WebDAV 密码是否为空」。

## 远程访问（Tailscale）

有两种方式，**可以同时用**。

### 方式一：直连 Tailscale IP（最简单，和原来 1900 的用法一样）

在 `config.json` 里让网关同时监听 loopback 和 Tailscale IP：

```json
"hosts": ["127.0.0.1", "100.x.y.z"]
```

重启后，尾网里的任何设备直接用：

```
http://100.x.y.z:1901/zotero
```

本机客户端继续用 `http://127.0.0.1:1901/zotero`，两边互不影响。
校园网 IP `<校园网IP>` 上**访问不到**（因为没绑它），这一点可以用下面的命令验证。

### 方式二：`tailscale serve`（带合法 HTTPS 证书）

```powershell
tailscale serve --bg 1901          # HTTPS 443
tailscale serve --bg --http=80 1901  # 可选：再加一条纯 HTTP
```

得到：

```
https://myhost.tailxxxxx.ts.net/   ->  http://127.0.0.1:1901
```

好处是证书由 Let's Encrypt 签发，`ssl_verify_result` 为 0，浏览器和客户端都不会报证书错误。

### 各客户端的地址

| 场景 | 地址 |
|---|---|
| 本机 Zotero | `http://127.0.0.1:1901/zotero` |
| 本机 Obsidian | `http://127.0.0.1:1901/obsidian/MyVault` |
| 尾网设备（推荐） | `http://100.x.y.z:1901/...` |
| 尾网设备（HTTPS） | `https://myhost.tailxxxxx.ts.net/...` |

用户名 / 密码同 `config.json`。

### 验证方法

```powershell
# 本机、尾网 IP、域名 都应返回 207；校园网 IP 应连接失败
curl.exe -o NUL -w "%{http_code}`n" -u 'webdav:密码' -X PROPFIND -H "Depth: 0" http://100.x.y.z:1901/
curl.exe -m 5 http://<校园网IP>:1901/     # 应当失败
```

管理命令：

```powershell
tailscale serve status                 # 看当前配置
tailscale serve --https=443 off        # 关掉 HTTPS
tailscale serve --http=80 off          # 关掉 HTTP
tailscale serve reset                  # 清空全部
```

### ⚠️ 关于 `tailscale funnel`（真正的公网暴露）

`serve` 只有**登录了你同一个尾网的设备**能访问；`funnel` 才是对**整个互联网**开放。

**本项目的密码是弱口令时，绝对不要开 funnel。** 一旦开启，等于把一个能完全读写你
山大云盘的 WebDAV 端点挂到公网上，扫描器会在几小时内找到并尝试爆破。

如果确实需要公网访问，至少要做到：

1. 换成 16 位以上随机密码
2. 只暴露需要的子路径，而不是整个云端根
3. 加一层反向代理做速率限制 / IP 白名单

---

## 防火墙说明

网关只监听 `127.0.0.1`，所以**不需要任何入站防火墙规则**——`tailscale serve` 由
`tailscaled` 负责对外监听，而它本来就有放行规则。

可以用下面这条确认校园网 IP 上确实访问不到：

```powershell
curl.exe -m 5 http://<校园网IP>:1901/     # 应当连接失败
```

`node.exe` 在 `Private` 配置下已有入站放行规则（Windows 首次监听时确认过），
但**因为绑定的是 127.0.0.1，这条规则不会让外部访问到本服务**。

---

## 从 webdav-wrapper 切换过来

两者可以并存（不同端口），但**建议只留一个**，否则同一份云端目录会被两条链路同时写：

| 步骤 | 操作 |
|---|---|
| 1 | 先启动本服务（1901）验证 Zotero/Obsidian 连接正常 |
| 2 | 把 Zotero / Obsidian 里的地址从 `1900` 改成 `1901` |
| 3 | 确认无误后，关掉 `webdav-wrapper`（1900） |
| 4 | 官方云盘客户端可以退出并取消同步——本服务不再需要 `D:\SyncDisk` 这个本地镜像了 |

> 如果官方客户端还在同步 `/WebDAV/SyncDisk`，它会把本服务写进去的改动拉回 `D:\SyncDisk`，反之亦然。
> 两边最终会收敛，但会有无谓的来回搬运，建议关掉。

**顺带提醒**：`webdav-wrapper/config.json` 当前是 `"host": "0.0.0.0"`（监听所有网卡，含校园网），
而同目录 README 第 99 行明确写着"不要改成 0.0.0.0"。要么改回 `127.0.0.1` / Tailscale IP，要么直接停用它。

---

## 实测结果

### 真实云盘冒烟测试（`scripts/live-smoke.js`，16/16 通过）

```
✅ PROPFIND / Depth:1                    HTTP 207
✅ MKCOL /sub                            HTTP 201
✅ PUT /sub/hello.txt (流式)              HTTP 201
✅ GET /sub/hello.txt 内容一致            sha256 完全一致
✅ PUT /sub/big.bin (3 MB 流式)           8.4 MB/s
✅ GET /sub/big.bin 内容一致              21 MB/s, sha256 完全一致
✅ PUT 覆盖已存在文件                     HTTP 200
✅ PUT/GET 中文文件名                     正常
✅ PROPFIND 元数据（size/etag/mtime）     完整，无 -1
✅ COPY 同目录改新名字                    正常，内容正确
✅ MOVE 跨目录 + 改名                     正常，源已消失
✅ MOVE 同目录改名                        正常，内容完好
✅ COPY 覆盖已存在目标                    正常，源文件未受影响
✅ DELETE 文件                            HTTP 200
✅ DELETE 非空目录（递归）                HTTP 200
✅ 测试目录已清空
```

### 只读验证真实数据

挂载 `/WebDAV/SyncDisk`（原方案的目录）和 `/WebDAV/SyncDisk/zotero`：

```
PROPFIND / Depth:1 -> HTTP 207，4 个子项
  [D] /obsidian/  [D] /zotero/  [F] 删除测试.txt 25 B  [F] 同步测试.txt 33 B
GET /同步测试.txt -> HTTP 200, Content-Length 33, 实收 33 B

PROPFIND /zotero Depth:1 -> HTTP 207，579 个子项   ← 真实 Zotero 附件库
```

### 离线测试（`npm test`，61/61 通过）

- **22 项契约测试**：用内存假云盘 + 假对象存储跑一个**真实的 webdav-server**，
  发真实 HTTP 请求，不碰学校服务器、不产生外网流量。
- **31 项 CLI 测试**：参数解析、中文对齐、配置默认值、监听地址校验，
  以及三个平台的服务配置生成（systemd unit / launchd plist / Windows 包装脚本）
  都是纯函数，可以在任何系统上验证任意平台的输出。
- **8 项配置测试**：含一条回归测试 —— **首次生成配置必须带非空随机密码**。
  曾经 `asy-webdav config set` 在配置文件不存在时会生成**空密码**的配置，
  服务随后以空密码对外提供 WebDAV（实测 `webdav:` + 空密码 PROPFIND 返回 207）。
  现在所有会写配置的路径都走 `loadOrCreate()`，且 `doctor` 会把空密码判为失败。

---

## 踩到的坑（都是实测出来的，文档里没有）

### 1. `ondup` 的真实语义和文档不一致 ⚠️

`asy-cli` 文档里写 `ondup: 1`，容易以为 1 是覆盖。用 `scripts/probe-ondup.js` 对真实云盘做对照实验的结果：

| ondup | 真实语义 |
|---|---|
| `0` | 非法 → `HTTP 400 参数不合法` |
| `1` | **拒绝同名** → `HTTP 403 存在同类型的同名文件名` |
| `2` | **保留两者 / 自动改名**（新文件叫 `name (2).ext`） |
| `3` | **覆盖**（原文件被替换） |
| `4+` | 非法 → `HTTP 400 参数不合法` |

而且**不同接口接受的取值还不一样**（`scripts/probe-rename.js`）：

| 接口 | ondup=1 | ondup=2 | ondup=3 |
|---|---|---|---|
| `osbeginupload` | 拒绝同名 | 保留两者 | 覆盖 |
| `file/rename` | 拒绝同名 | ⚠️ 调用"成功"但目标内容没变、源文件却消失了 | `403 当前操作不支持覆盖` |
| `file/move` | — | 保留两者 | — |

结论：
- **PUT 覆盖必须用 `ondup=3`**（本服务默认值）
- **改名只能在目标名确定空着时用 `ondup=1`**；`rename` 的 ondup=2 有丢数据风险，代码里绝不使用
- `asy-cli` 自己的 `put` 默认 `ondup=1`，所以 `asy put` 覆盖已有文件会直接 403 —— 这是 `asy-cli` 的一个可用性问题，值得反馈上游

### 2. `move` 不允许目标父目录与源相同

同目录改名调 `file/move` 会得到 `HTTP 403 对象无法移动到相同的路径或者子路径`。
必须识别这种情况并改走 `rename`（见 `_transfer`）。

### 3. `copy` / `move` 不能同时指定新名字

API 只接受 `{docid, destparent, ondup}`，没有"新名字"参数。所以「跨目录 + 改名」只能两步走。

这里有个**很隐蔽的坑**：如果直接用 `ondup=1` 复制到目标目录，而目标目录里恰好有一个和**源文件同名**的对象——同目录改名时那个对象就是源文件自己——就会把源文件覆盖掉。

本服务的做法：统一用 `ondup=2`（绝不覆盖）执行，然后对比操作前后的目录列举用**差集**找出新产生的条目，再单独 `rename` 成目标名。这样不管服务端的自动改名规则是什么（`name (2).ext` / `name_1.ext` …）都能对上。

### 4. 云盘删除是最终一致的

删掉一个文件后立刻用同名重新上传，服务端仍可能认为同名存在，从而触发自动改名（实测复现）。
所以 `renameInto()` 在遇到同名时会做几次短暂重试，仍失败就报 409 —— 宁可失败，也不冒覆盖/丢数据的风险。

### 5. token 会互相踢下线 ⚠️

`refresh_token` 是**轮换**的：刷新一次就下发新的、旧的作废。
如果本服务和 `asy` 命令行共用一份 `~/.anyshare-cli/config.json`，两边都刷新就会互相把对方踢下线（`invalid_grant`）。

**解决办法**：给本服务一个独立凭据目录（两个 OAuth 会话互不影响）：

```bat
set ASY_CONFIG_DIR=C:\path\to\asy-webdav\.asy-config
node "C:\path\to\asy-cli\asy.js" login --cas
```

然后在 `config.json` 里写 `"asyConfigDir": ".asy-config"`。

服务本身也会在检测到这类错误时打印明确的提示，而不是丢一个 `invalid_grant` 让人猜。

### 6. 目录的 `modified_at` 不随子文件变化

实测：`SyncDisk` 的 `modified_at` 停在 09-17，而里面文件的 `modified_at` 是 09-09。
所以本服务的 **ETag 用文件的 `rev`**（32 位 hex 版本号），Last-Modified 用 `modified_at`（秒级）。
依赖"目录 mtime 变化"来判断子项变更的客户端可能会漏判——Zotero 和 Remotely Save 都是逐文件比对的，不受影响。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **无大文件分片上传** | 单请求流式上传（实测 3 MB / 8 MB/s 稳定）。云盘的 `osinitmultiupload` 分片接口还没接，超大文件（几百 MB）建议先用 `asy put` |
| **Range 请求不省流量** | webdav-server 会在服务端丢弃范围外的字节，也就是 Range 请求仍会完整下载后截取。Zotero/Obsidian 基本不用 Range，暂未处理 |
| **缓存有 TTL 延迟** | 别的客户端改了云端，本服务最多 `cacheTtlMs` 之后才看到。调小更实时、调大更省 API |
| **LOCK 只在内存里** | 进程重启后锁丢失。Zotero / Remotely Save 都不强依赖 LOCK |
| **不能删 WebDAV 根** | `DELETE /` 返回 403，防止误删整个云端目录 |
| **不支持 WebDAV 属性持久化** | `PROPPATCH` 的属性存在内存里，重启即失 |

---

## 目录结构

| 文件 | 作用 |
|---|---|
| `cli.js` | **命令行入口**：`start`/`stop`/`status`/`logs`/`service`/`config`/`doctor` |
| `server.js` | 服务入口（普通前台程序，不知道服务管理器存在） |
| `lib/paths.js` | 统一的运行目录 / 配置文件 / PID / 日志路径解析 |
| `lib/config.js` | 配置读写（`server.js` 与 `cli.js` 共用） |
| `lib/daemon.js` | 进程生命周期：PID 文件、后台守护、按端口反查进程 |
| `lib/service.js` | 服务化：生成 systemd / launchd / 任务计划程序配置 |
| `lib/asy-cli.js` | 定位并加载 `asy-cli` 的 `lib/`（不复制代码，可用 `ASY_CLI_PATH` 指定） |
| `lib/client.js` | 云盘访问层：路径解析、目录列举缓存、并发闸门、上传/下载 |
| `lib/anyshare-fs.js` | **核心**：`webdav-server` 的 `FileSystem` 子类，把所有钩子接到云盘 API |
| `lib/util.js` | TTL 缓存、并发闸门、路径工具 |
| `test/fake-cloud.js` | 测试用假云盘（内存 API + 假对象存储），行为刻意模仿真实 API 的怪癖 |
| `test/contract.test.js` | 22 项端到端契约测试 |
| `test/cli.test.js` | 31 项 CLI / 平台适配单元测试（纯函数，不碰网络与系统） |
| `test/config.test.js` | 8 项配置模块测试（含「不得生成空密码」的回归测试） |
| `scripts/live-smoke.js` | 真实云盘冒烟测试（16 项，自动清理） |
| `scripts/probe-ondup.js` | `ondup` 语义对照实验 |
| `scripts/probe-rename.js` | `rename` 的 ondup 语义对照实验 |
| `scripts/peek.js` | 只读查看任意云端目录（不写入） |
| `scripts/mirror-up.js` | **本地目录 → 云端单向镜像**（默认 dry-run，用于「本地覆盖云端」） |

---

## 开发 / 测试

```bat
npm test                                  :: 61 项离线测试
node --test test/cli.test.js              :: 只跑 CLI / 平台适配
node --test test/config.test.js           :: 只跑配置模块
node scripts/peek.js --root /WebDAV/SyncDisk       :: 只读看看云端目录
node scripts/live-smoke.js --root /WebDAV/asy-webdav-test  :: 真实云盘全流程（自己清理）
```

`live-smoke.js` 只动 `--root` 指定的目录，跑完会清空它。**不要**直接指向正在用的数据目录。

---

## 用本地目录覆盖云端（`scripts/mirror-up.js`）

当本地那份比云端新（例如客户端同步一直失败、内容只在本地），用它把本地推上去。

```powershell
# 1) 先看差异 —— 默认就是 dry-run，不会修改任何东西
node scripts/mirror-up.js --local "D:\SyncDisk\obsidian\MyVault" --remote "/obsidian/MyVault"

# 2) 确认无误后执行
node scripts/mirror-up.js --local "..." --remote "..." --apply

# 3) 想确保逐字节一致（只比大小会漏掉「同大小但内容不同」）
node scripts/mirror-up.js --local "..." --remote "..." --force --apply

# 4) 真正的镜像：连「云端有、本地没有」的条目也删掉（破坏性，默认关闭）
node scripts/mirror-up.js --local "..." --remote "..." --apply --delete
```

行为要点：

| 项 | 说明 |
|---|---|
| 默认 | **dry-run**，只打印差异。必须显式加 `--apply` 才动数据 |
| 比较依据 | 文件大小。同大小默认跳过；`--force` 则全部重传 |
| 删除 | **默认不删**。云端多出来的条目只在加 `--delete` 时才删 |
| 走哪条路 | 走本机 WebDAV 网关（HTTP），**不直接调云盘 API**，所以不会和 `asy-cli` 争抢 `refresh_token` |
| 零字节文件 | 支持（实测 sha256 与本地一致） |
| 中文/空格路径 | 支持（脚本按段做 URL 编码） |

> 执行完再跑一次不带 `--apply` 的 dry-run，如果显示 `【上传/覆盖】0` 就说明云端已经和本地一致。
> 想进一步确认内容，可以下载几个文件用 `Get-FileHash -Algorithm SHA256` 和本地比对。

---

## 安全说明

- 默认只监听 `127.0.0.1`，强制 Basic 认证，无密码一律 401
- 首次运行自动生成随机密码，建议改成强密码
- 云端凭据在 `~/.anyshare-cli/config.json`（或 `asyConfigDir`），**不要提交到仓库**
- 访问日志写在 `access.log`（含方法/URL/状态码/用户/IP），排查连接问题用
- 别把端口暴露到公网；要远程访问就走 Tailscale

---

*本项目仅供个人学习与科研使用；请遵守山东大学云盘服务条款，勿存放涉密或违规内容。*
