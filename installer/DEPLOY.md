# WeChat Fish 0.2.1 — 全自动部署说明（给 DSH / 自动化代理读）

> 这份文档写给「能执行 PowerShell 的代理」。按 0–7 步做完，机器上就有一套能跑的微信薄桥接；8–10 步是卸载、错误码和隐私声明，装的时候不用读。
> **版本：0.2.1**（构建 2026-10-30）
> **安装包：`WeChatFish-Setup-x64.exe`（约 372 MB）**
> **SHA256：不内嵌在本文件里**（哈希会随包变化，写死就成了自指）。读同目录的 `SHA256SUMS.txt`，格式是 `<hash>  WeChatFish-Setup-x64.exe`。
> 只认这个版本号：装完必须用第 6 步核对 `install-state.json` 的 `version` 是 `0.2.1`、`VERSION.txt` 首行是 `0.2.1`，不一致就停下重来。

本文档与安装包**不含任何人的账号、聊天记录、令牌、群号或本机路径**。令牌在安装时随机生成；白名单默认空（空 = 谁都不回）。

**人工只有两处**：① UAC 提权弹窗（卸载必弹；安装视机器策略而定）；② 第 3 步的微信扫码。其它全部可自动。

---

## 0. 前置检查（任一不满足就停，不要硬装）

| 项 | 要求 | 检查命令 |
|---|---|---|
| 系统 | Windows 10 / 11 x64 | `[Environment]::Is64BitOperatingSystem` |
| PowerShell | 5.1+（用 `powershell.exe`，不是 `pwsh`） | `$PSVersionTable.PSVersion.Major` |
| DSH | 已安装并登录 | `Test-Path "$env:USERPROFILE\.dsh"` |
| 磁盘 | C: 盘 ≥ 6 GB 空闲 | `(Get-PSDrive C).Free/1GB` |
| 微信 | **不要预装**（包内自带 4.1.10.27） | `Get-Process Weixin,WeChat -ErrorAction SilentlyContinue` 应为空 |
| 7-Zip | 已安装（解包用） | `Test-Path 'C:\Program Files\7-Zip\7z.exe'` |
| 端口 | 30001 / 5031 / 11231 / 11232 空闲 | 见下方 |

```powershell
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'E_OS: 需要 64 位 Windows' }
if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'E_PS: 需要 PowerShell 5.1+' }
if ((Get-PSDrive C).Free/1GB -lt 6) { throw 'E_DISK: C: 盘空闲不足 6GB' }
if (Get-Process Weixin,WeChat -ErrorAction SilentlyContinue) { throw 'E_WECHAT_RUNNING: 先退出已安装的微信（包内要装自带的一份）' }
foreach ($p in 30001,5031,11231,11232) {
  if (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) {
    throw "E_PORT_IN_USE: 端口 $p 已被占用，先停掉占用的进程（Get-NetTCPConnection -LocalPort $p）"
  }
}
if (-not (Test-Path 'C:\Program Files\7-Zip\7z.exe')) { throw 'E_7ZIP: 先 winget install 7zip.7zip' }
'前置检查通过'
```

安装器还会把 adapter 端口 `8766` 写进 `workspace\config\wechatagent.json`；它不参与上面的四端口验收，保留默认值即可（要换就同时传 `-AdapterPort`）。

---

## 1. 校验安装包（别跳过）

`SHA256SUMS.txt` 由发布方随包提供，和 exe 放在同一个目录。

```powershell
$Setup   = Join-Path $PWD 'WeChatFish-Setup-x64.exe'
$SumFile = Join-Path $PWD 'SHA256SUMS.txt'
if (-not (Test-Path $Setup))   { throw 'E_SETUP_MISSING: 找不到安装包' }
if (-not (Test-Path $SumFile)) { throw 'E_SUMS_MISSING: 找不到 SHA256SUMS.txt，向发布方索取' }
$Want = ((Get-Content $SumFile | Select-String 'WeChatFish-Setup-x64\.exe' | Select-Object -First 1).Line -split '\s+')[0]
$Got  = (Get-FileHash $Setup -Algorithm SHA256).Hash
if ($Got -ne $Want) { throw "E_HASH: 期望 $Want 实际 $Got" }
"OK 0.2.1 $Got"
```

`Get-FileHash` 对 372 MB 要十几秒，属正常。哈希不一致就**不要装**，重新拷一份。

---

## 2. 解包并安装（静默、目录与端口可控）

安装包是 7-Zip SFX：双击会自己解包并调 `install.cmd`。自动化建议**先解包、再直接调 `install.ps1`**——参数可控、能拿到错误码、不会弹自解压进度窗。

```powershell
$ErrorActionPreference = 'Stop'
$Setup = Join-Path $PWD 'WeChatFish-Setup-x64.exe'

# 2.1 解 SFX → 得到 bundle.tar + setup.cmd
$Work = Join-Path $env:TEMP ('wf-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force $Work | Out-Null
& 'C:\Program Files\7-Zip\7z.exe' x $Setup "-o$Work" -y | Out-Null
if (-not (Test-Path (Join-Path $Work 'bundle.tar'))) { throw 'E_UNPACK: 没解出 bundle.tar' }

# 2.2 解 bundle.tar → 得到 payload\、install.ps1、DEPLOY.md 等
& tar.exe -xf (Join-Path $Work 'bundle.tar') -C $Work
if (-not (Test-Path (Join-Path $Work 'payload\VERSION.txt'))) { throw 'E_UNPACK: bundle.tar 里没有 payload\VERSION.txt' }
if (-not (Test-Path (Join-Path $Work 'install.ps1')))        { throw 'E_UNPACK: bundle.tar 里没有 install.ps1' }
(Get-Content (Join-Path $Work 'payload\VERSION.txt') -TotalCount 1)   # 必须是 0.2.1

# 2.3 安装
$Target = Join-Path $env:LOCALAPPDATA 'WeChatFish'   # 默认目录；装第二份时换目录 + 换端口
$Suffix = ''                                          # 多实例用 A/B，计划任务名跟着变
$HookPort   = 30001
$ReaderPort = 5031
$BridgePort = 11232

if (Test-Path $Target) { throw 'E_TARGET_EXISTS: 目标目录已存在（安装器不覆盖，防误删）' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Work 'install.ps1') `
  -TargetDir    $Target `
  -TaskSuffix   $Suffix `
  -Port         $HookPort `
  -ReaderPort   $ReaderPort `
  -BridgePort   $BridgePort `
  -BootstrapAccount
$LASTEXITCODE   # 0=成功；非 0 见第 9 步错误码
```

`-BootstrapAccount` 会让安装器装完立刻进第 3 步（等你扫码）。如果你想把扫码单独做（比如先给用户发消息再让他扫），**去掉这个开关**，装完自己跑第 3 步的命令。

`install.ps1` 做了这些（每步都有校验，失败抛 `E_*`）：

1. 校验载荷完整性（client、hook、runtime、bridge、console、template 缺一不可）；
2. 拒绝覆盖已存在的目标目录、拒绝重名计划任务；
3. 复制客户端 / Hook / Python / Node / 桥接 / 控制台 / dsh-fish 插件到 `$Target`；
4. **随机生成 32 字节令牌**，写进 `workspace\state\hook\native-token.txt`、`workspace\state\wechat-io-config.json`、`app\bridge\config.json`，并同步进 `~\.dsh-fish\config.json` 的 `wechat.token`（原文件备份为 `config.json.bak-wechatfish`）；
5. 写 `app\bridge\config.json`（`fish.baseUrl=http://127.0.0.1:11231`、`batch.groupSilenceMs=6000`、`logLevel=info`、`whitelist=[]`）；
6. 生成 `start-reader.vbs` / `start-bridge.vbs`（用安装目录内的绝对路径），注册登录计划任务 `WeChatFishReader$Suffix` / `WeChatFishBridge$Suffix`；
7. ACL 锁定 `client\`，防微信自动更新把 Hook 顶掉（SDDL 存 `client-acl.json`，卸载时还原）；
8. 跑一次自检写 `self-test.json`（此时 `hook` / `reader` 报 `E_WECHAT_NOT_RUNNING` 是正常的——还没扫码）。

**本步验收**：返回 JSON 里 `installed=true`，`checks` 数组里 `bridge` 的 `ready=true`。`hook` / `reader` 红着属预期，继续第 3 步。

> 如果机器策略要求提权，这一步会弹一次 UAC —— 那是必须人工点的第一处。安装器本身不隐式提权。

---

## 3. 首次扫码（唯一必须人工的技术步骤）

微信的数据库密钥只在**登录那一刻**可用，登录完成后就抓不到了。这一步无法自动化，但可以**被代理驱动**：代理起脚本，脚本把微信窗口顶到前台，等人扫码，然后自己继续。

```powershell
# 先确保微信起来了（脚本会拒绝在你已登录另一个微信时动手）
if (-not (Get-Process Weixin -ErrorAction SilentlyContinue)) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Target\start-wechat.ps1" -Port 30001 -AdapterPort 8766
  Start-Sleep -Seconds 5
}
# 轮询 hook 健康，直到出现唯一已登录账号 → 抓密钥 → 起 reader
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Target\bootstrap-account.ps1" -TargetDir $Target -WaitSeconds 300
$LASTEXITCODE   # 0=OK
```

脚本行为：每秒查一次 `http://127.0.0.1:30001/WeChatAgent/health`，等到**恰好一个** `databaseAccounts` 就抓 DPAPI/DLL 密钥、写 `workspace\state\weflow\active-account.json`、启动 reader 任务，最后输出一行 JSON：`{"success":true,...,"readerSuccess":true}`。

- 超时（默认 180s，上面给了 300s）→ 非 0 退出，**重新执行即可**；
- 抓不到密钥（`E_KEY_EXTRACTION_FAILED`）→ 退出微信重新登录，登录窗口出现时立刻重跑；
- 已经登录过的机器重装，也要再扫一次（密钥与登录态绑定）。

**本步验收**：

```powershell
$io = Get-Content "$Target\workspace\state\wechat-io-config.json" -Raw | ConvertFrom-Json
"reader=$($io.reader_base_url) token.len=$($io.reader_token.Length)"     # token.len 应为 64
$acc = Get-Content "$Target\workspace\state\weflow\active-account.json" -Raw | ConvertFrom-Json
$acc.success                                                              # 应为 True
(Get-NetTCPConnection -State Listen -LocalPort 5031 -ErrorAction SilentlyContinue) -ne $null   # 应为 True
```

---

## 4. 把 `app\dsh-fish` 挂进 DSH（junction + profile）

插件文件已经躺在 `$Target\app\dsh-fish`，但 DSH 只认自己 profile 里的 `node_modules` 和 `dsh.profile.bundles`。下面这段可以直接跑（幂等，重复执行安全）：

```powershell
$ErrorActionPreference = 'Stop'
$ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$Modules    = Join-Path $ProfileDir 'node_modules'
$PluginSrc  = Join-Path $Target 'app\dsh-fish'
$Link       = Join-Path $Modules 'dsh-fish'

if (-not (Test-Path $PluginSrc)) { throw 'E_PLUGIN_MISSING: 安装目录里没有 app\dsh-fish' }
New-Item -ItemType Directory -Force $Modules | Out-Null
if (Test-Path $Link) { (Get-Item $Link).Delete() }          # 只删链接，不动源目录
cmd /c mklink /J "$Link" "$PluginSrc" | Out-Null

$PkgFile = Join-Path $ProfileDir 'package.json'
$pkg = Get-Content $PkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-fish' -NotePropertyValue ("link:" + ($PluginSrc -replace '\\','/')) -Force
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }) }
$bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ }
if ($bundles -notcontains 'dsh-fish') { $bundles += 'dsh-fish' }
$pkg.dsh.profile.bundles = $bundles
[IO.File]::WriteAllText($PkgFile, ($pkg | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
'插件已挂载'
```

**本步验收**：

```powershell
(Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-fish").LinkType      # Junction
((Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles) -contains 'dsh-fish'   # True
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-fish\lib\clock.js"   # True
```

> **插件要重启 DSH 才加载**。如果执行者就是 DSH 自己，这一步不能自己做——留给用户，或写进计划任务让下次启动生效。加载成功后 `~\.dsh-fish\logs\dsh-fish.log` 会出现 `[wechat] 通道已监听 127.0.0.1:11231`。

---

## 5. 配置核对（安装器已写好，这里只对账）

| 文件 | 字段 | 期望 |
|---|---|---|
| `<Target>\app\bridge\config.json` | `fish.token` | 与插件一致（安装时随机生成） |
| 同上 | `whitelist` | `[]`（空 = 不回任何人，安全默认） |
| 同上 | `fish.baseUrl` | `http://127.0.0.1:11231` |
| 同上 | `statusPort` | `11232` |
| 同上 | `batch.groupSilenceMs` | `6000` |
| 同上 | `logLevel` | `info`（排查时改 `debug`；`0.2.1` 起四级：error/warn/info/debug） |
| 同上 | `mentionAliases` | `[]`（默认不靠正文判断 @；要认就填她自己的微信昵称，如 `["小助手"]`） |
| `<Target>\workspace\state\wechat-io-config.json` | `reader_token` / `hook_base_url` / `reader_port` | 64 位十六进制 / `http://127.0.0.1:30001` / `5031` |
| `~\.dsh-fish\config.json` | `wechat.enabled` | `true` |
| 同上 | `wechat.token` | 与桥接一致 |
| 同上 | `wechat.maxReplyChars` / `groupPerHour` / `groupGapMin` | `300` / `4` / `10` |
| `<Target>\install-state.json` | `version` | **`0.2.1`** |

```powershell
$b = Get-Content "$Target\app\bridge\config.json" -Raw | ConvertFrom-Json
$d = Get-Content "$env:USERPROFILE\.dsh-fish\config.json" -Raw | ConvertFrom-Json
if ($b.fish.token -ne $d.wechat.token) { throw 'E_TOKEN_MISMATCH: 桥接与插件令牌不一致（重跑安装器最省事）' }
if (-not $b.fish.token)                { throw 'E_TOKEN_EMPTY: 令牌是空值（0.2.0 的设置页 bug，0.2.1 已修）' }
if ($b.whitelist.Count -ne 0)          { Write-Warning "白名单非空：$($b.whitelist.Count) 项（装完应为 0）" }
if ($b.statusPort -ne 11232)           { throw "E_PORT: statusPort 是 $($b.statusPort)，应为 11232" }
'配置一致'
```

---

## 6. 启动与验收（四端口 + health + status）

```powershell
$Suffix = ''   # 与安装时一致
Start-ScheduledTask -TaskName "WeChatFishReader$Suffix"
Start-ScheduledTask -TaskName "WeChatFishBridge$Suffix"
Start-Sleep -Seconds 8

# 6.1 四个端口必须在听
@{ hook=30001; reader=5031; fish=11231; bridge=11232 }.GetEnumerator() | ForEach-Object {
  $ok = Get-NetTCPConnection -State Listen -LocalPort $_.Value -ErrorAction SilentlyContinue
  "{0,-7} :{1}  {2}" -f $_.Key, $_.Value, ($(if ($ok) {'LISTEN'} else {'DOWN'}))
}

# 6.2 插件健康（她的大脑）
Invoke-RestMethod 'http://127.0.0.1:11231/health' | ConvertTo-Json -Depth 4

# 6.3 桥接状态
Invoke-RestMethod 'http://127.0.0.1:11232/status' | ConvertTo-Json -Depth 6
```

全部 `LISTEN` + 两个接口都返回 JSON，才算装好。

**版本核对（必须，不一致就停）**：

```powershell
$state = Get-Content "$Target\install-state.json" -Raw | ConvertFrom-Json
if ($state.version -ne '0.2.1') { throw "E_VERSION: 装出来的版本是 $($state.version)，不是 0.2.1" }
$v = (Get-Content "$Target\VERSION.txt" -TotalCount 1).Trim()
if ($v -ne '0.2.1') { throw "E_VERSION: VERSION.txt 首行是 $v，不是 0.2.1" }
"OK WeChat Fish 0.2.1"
```

**桥接日志应出现**（顺序不定，`logs\bridge.log` 或控制台日志页）：

```
[whitelist] （空，谁都不回）
[reader] ... SSE ...
[bridge] started
```

`0.2.1` 的每行带级别前缀（`[ERROR]` / `[WARN]` / `[INFO]` / `[DEBUG]`）。只想看要紧的就 `logLevel=warn`；排查时 `debug`（注意 `debug` 会把每条原始事件都写盘，别长期开）。

---

## 7. 开启会话（装完默认全静默）

白名单为空时她不会回任何人——这是故意的。两种开法：

**a) 控制台**：桌面「微信薄桥接」→「会话」页 → 勾群/好友 →「保存」。`0.2.1` 起保存会**热更新**，约 1.5 秒内通道自动重启，不用手动停服务。

**b) 直接改配置（自动化）**：

```powershell
$file = "$Target\app\bridge\config.json"
$cfg  = Get-Content $file -Raw | ConvertFrom-Json
$cfg.whitelist = @('wechat:group:<群会话id>', 'wechat:private:<好友会话id>')
[IO.File]::WriteAllText($file, ($cfg | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
# 约 1.5–3 秒后日志出现 [whitelist] 已热更新：N → M 个会话（debug 级）
```

会话 id 从 reader 取（要用 `reader_token`）：

```powershell
$io = Get-Content "$Target\workspace\state\wechat-io-config.json" -Raw | ConvertFrom-Json
Invoke-RestMethod 'http://127.0.0.1:5031/api/v1/sessions' -Headers @{ Authorization = "Bearer $($io.reader_token)" } |
  ConvertTo-Json -Depth 5
```

**验收**：随便找个被勾的会话发一句话，`logs\bridge.log` 里应出现 `[skip]` 消失、`[fish]` 结果、`[send] ok`。

---

## 8. 卸载 / 回滚

```powershell
# 保留数据（workspace\ 留着，重装后她还记得人）
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Target\uninstall.ps1" -TargetDir $Target -TaskSuffix $Suffix

# 连数据一起删
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Target\uninstall.ps1" -TargetDir $Target -TaskSuffix $Suffix -Purge
```

卸载会：**自请求提权**（UAC 弹窗，人工点）→ 停并删 `WeChatFishReader/Bridge$Suffix` 任务（校验任务命令行含 `$Target`，不碰别人的任务）→ 按命令行杀该目录下的 python/node/wscript → 删桌面快捷方式（只在指向本目录时）→ 还原 `client\` ACL → `-Purge` 时做安全检查（marker、绝对路径、无 junction）后递归删除。

`-TaskSuffix` **必须和安装时一致**，否则 `E_SCOPE` 拒绝执行。跑着的微信要自己关——卸载器不会替你杀 `Weixin.exe`。

---

## 9. 故障码

| 码 / 输出 | 含义 | 处理 |
|---|---|---|
| `E_OS` / `E_PS` / `E_DISK` / `E_7ZIP` | 前置检查不过 | 按第 0 步逐项满足 |
| `E_SETUP_MISSING` / `E_SUMS_MISSING` | 包或校验文件缺失 | 重新拷贝整份发布目录 |
| `E_HASH` | SHA256 不一致 | **停止安装**，重新拿包（可能下载/拷贝损坏） |
| `E_UNPACK` | 解包不完整 | 换临时目录重解；7z / tar 版本异常时手动解 |
| `E_PAYLOAD` | 安装包内缺文件 | 同上；校验 SHA256 |
| `E_TARGET_EXISTS` | 目标目录已存在 | 换目录，或先卸载 |
| `E_TASK_EXISTS` | 计划任务重名 | 换 `-TaskSuffix`，或先删任务 |
| `E_SUFFIX` | `-TaskSuffix` 含非法字符 | 只用字母数字 `_` `-` |
| `E_PORT_IN_USE` | 端口被占 | `Get-NetTCPConnection -LocalPort <n>` 找占用者并停掉 |
| `E_WECHAT_NOT_RUNNING` | 微信没起 | 第 3 步；或 `start-wechat.ps1` |
| `E_NOT_LOGGED_IN` | 微信没登录 | 扫码 |
| `E_KEY_EXTRACTION_FAILED` | 密钥没抓到 | 退出微信重新登录，登录窗口出现后立刻重跑第 3 步 |
| `E_READER_START_FAILED` | reader 起不来 | 看 `$Target\workspace\logs`、控制台「服务」页；端口 5031 是否被占 |
| `E_TOKEN_MISMATCH` | 桥接与插件令牌不一致 | 重跑安装器，或手动把两边改成同一个 64 位串 |
| `E_PLUGIN_MISSING` | `app\dsh-fish` 不存在 | 安装是否完整；重跑安装器 |
| `E_VERSION` | 装出来的版本不是 0.2.1 | 用错包了，重新拿 0.2.1 |
| `E_SCOPE` / `E_TASK_SCOPE` / `E_NOT_OURS` | 卸载参数与安装不匹配 | `-TaskSuffix`、`-TargetDir` 必须与 `install-state.json` 一致 |
| `E_PURGE_SCOPE` / `E_PURGE_LINK` | 目录安全检查失败 | 手动确认路径后删除，别强拆 |

---

## 10. 隐私与边界

- 安装包与本文档**不含任何人的账号、群号、令牌、聊天记录或本机用户名**；代码与示例里出现的一律是占位符（`alice`、`wechat:group:100000000` 这类），不是真实 id。
- 令牌用 `RandomNumberGenerator` 现生成，每台机器不同，只落在本机三个文件里。
- 白名单默认空，装完不会自动回任何消息。
- 数据只在 `%LOCALAPPDATA%\WeChatFish` 与 `~\.dsh-fish`，不上传；只有 DSH 调模型时联网。
- 向微信注入 Hook **违反微信用户协议**，账号有被封风险；这是使用者的选择，安装器不对此负责。建议用小号。
- 不要用它做群发、营销、刷屏或冒充他人。
