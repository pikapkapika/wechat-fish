# WeChat Fish 0.2.0 — 全自动部署说明（给 DSH / 自动化代理读）

> 这份文档写给「能执行 PowerShell 的代理」。按顺序做完，机器上就有一套能跑的微信薄桥接。
> **版本：0.2.0**（构建日期 2026-10-30）
> **安装包：`WeChatFish-Setup-x64.exe`（约 372 MB）**
> **SHA256：见发布方随包给出的 `SHA256SUMS.txt`**（本文档不内嵌，因为哈希会随包变化，内嵌就成了自指）
> 只认这个版本号。装完用「第 6 步」核对 `install-state.json` 里的 `version` 必须是 `0.2.0`，不一致就停下。

本文档与安装包**不含任何人的账号、聊天记录、令牌、群号或本机路径**。令牌在安装时随机生成，白名单默认是空的（空 = 谁都不回，安全默认值）。

---

## 0. 前置条件（不满足就停，不要硬装）

| 项 | 要求 | 检查命令 |
|---|---|---|
| 系统 | Windows 10/11 x64 | `[Environment]::Is64BitOperatingSystem` |
| PowerShell | 5.1+ | `$PSVersionTable.PSVersion.Major` |
| DSH | 已安装并登录 | `Test-Path "$env:USERPROFILE\.dsh"` |
| 磁盘 | ≥ 6 GB 空闲 | `(Get-PSDrive C).Free/1GB` |
| 微信 | **不要预装**，安装包自带 | `Get-Process Weixin -ErrorAction SilentlyContinue` 应为空 |
| 端口 | 30001 / 5031 / 11231 / 11232 空闲 | 见下方检查 |

```powershell
foreach ($p in 30001,5031,11231,11232) {
  if (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) {
    Write-Error "端口 $p 被占用，先停掉占用的进程再装"
  }
}
```

需要管理员权限的只有「安装」和「卸载」两步（注册两个登录计划任务）。

---

## 1. 校验安装包

`SHA256SUMS.txt` 由发布方随包提供（不在安装包内部，否则哈希会自指）。

```powershell
$Setup   = Join-Path $PWD 'WeChatFish-Setup-x64.exe'
$SumFile = Join-Path $PWD 'SHA256SUMS.txt'
if (-not (Test-Path $Setup))   { throw 'E_SETUP_MISSING: 找不到安装包' }
if (-not (Test-Path $SumFile)) { throw 'E_SUMS_MISSING: 找不到 SHA256SUMS.txt，向发布方索取' }
$Want = ((Get-Content $SumFile | Select-String 'WeChatFish-Setup-x64\.exe' | Select-Object -First 1).Line -split '\s+')[0]
$Got  = (Get-FileHash $Setup -Algorithm SHA256).Hash
if ($Got -ne $Want) { throw "E_HASH: 期望 $Want 实际 $Got" }
"OK 0.2.0 $Got"
```

---

## 2. 安装（静默，可换目录、可并行多实例）

安装包是 7-Zip SFX：双击会解包并调用 `install.cmd`。自动化建议**先解包再直接调 `install.ps1`**，参数可控、可拿到错误码。

```powershell
$Work = Join-Path $env:TEMP ('wf-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force $Work | Out-Null
& 'C:\Program Files\7-Zip\7z.exe' x $Setup "-o$Work" -y | Out-Null   # 没有 7-Zip 就先 winget install 7zip.7zip
& tar.exe -xf (Join-Path $Work 'bundle.tar') -C $Work                  # 得到 payload\ 与 install.ps1

$Target    = Join-Path $env:LOCALAPPDATA 'WeChatFish'   # 默认目录；要装两份就给不同的 Target + TaskSuffix
$Suffix    = ''                                          # 多实例时用 A/B，任务名会跟着变
$HookPort  = 30001
$Reader    = 5031
$Bridge    = 11232

if (Test-Path $Target) { throw 'E_TARGET_EXISTS: 目标目录已存在（安装器不覆盖，防误删）' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Work 'install.ps1') `
  -TargetDir $Target -TaskSuffix $Suffix `
  -Port $HookPort -ReaderPort $Reader -BridgePort $Bridge `
  -BootstrapAccount
```

`install.ps1` 会做这些（都有幂等校验，失败会抛 `E_*` 错误码）：

1. 校验载荷完整性；
2. 复制客户端 / Hook / Python / Node / 桥接 / 控制台 / DSH 插件到 `$Target`；
3. **随机生成 32 字节令牌**，写进 `workspace\state\hook\native-token.txt`、`workspace\state\wechat-io-config.json`、`app\bridge\config.json`，并同步到 `~/.dsh-fish\config.json` 的 `wechat.token`；
4. 生成 `start-reader.vbs` / `start-bridge.vbs`，注册登录计划任务 `WeChatFishReader$Suffix` / `WeChatFishBridge$Suffix`；
5. 锁定 `client\` 目录 ACL，防止微信自动更新后 Hook 失效；
6. 跑一次自检，写 `self-test.json`。

**验收**：命令返回 JSON 里 `installed=true`，且 `checks` 里三项 `ready=true`。若 `hook/reader` 报 `E_WECHAT_NOT_RUNNING`，属正常——微信还没登录，继续第 3 步。

---

## 3. 首次登录（唯一必须人工的一步）

微信数据库密钥只在**登录那一刻**可用，抓不到就无法启动 reader，这一步无法自动化。

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Target\bootstrap-account.ps1" -TargetDir $Target -WaitSeconds 300
```

执行后会在屏幕上弹微信窗口，**让使用者扫码登录**。脚本会轮询 `/WeChatAgent/health`，等到唯一账号后抓密钥、写配置、拉起 reader，最后退出码 0 并输出 `success=true`。

- 超时（默认 180 秒，上面给了 300）会以非 0 退出，重新执行即可；
- 已经登录过的机器重装时也要再扫一次（密钥与登录态绑定）；
- 成功后 `first-run.cmd` 不需要再点。

**验收**：

```powershell
$io = Get-Content "$Target\workspace\state\wechat-io-config.json" -Raw | ConvertFrom-Json
"reader=${($io.reader_base_url)} token.len=$($io.reader_token.Length)"
Get-Content "$Target\workspace\state\weflow\active-account.json" -Raw | ConvertFrom-Json | Select-Object -ExpandProperty success
```

---

## 4. 把 dsh-fish 插件挂进 DSH（自动化）

插件已经在 `$Target\app\dsh-fish`，但 DSH 只认自己的 profile：

```powershell
$ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$Modules    = Join-Path $ProfileDir 'node_modules'
$PluginSrc  = Join-Path $Target 'app\dsh-fish'
$Link       = Join-Path $Modules 'dsh-fish'
New-Item -ItemType Directory -Force $Modules | Out-Null

# 已存在同名目录/链接先删（只删链接，不动源目录）
if (Test-Path $Link) { (Get-Item $Link).Delete() }
cmd /c mklink /J "$Link" "$PluginSrc" | Out-Null

$PkgFile = Join-Path $ProfileDir 'package.json'
$pkg = Get-Content $PkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-fish' -NotePropertyValue ("link:" + ($PluginSrc -replace '\\','/')) -Force
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) }
$bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ }
if ($bundles -notcontains 'dsh-fish') { $bundles += 'dsh-fish' }
$pkg.dsh.profile.bundles = $bundles
[IO.File]::WriteAllText($PkgFile, ($pkg | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
```

**验收**：`Test-Path $Link` 为真；`(Get-Content $PkgFile -Raw | ConvertFrom-Json).dsh.profile.bundles` 里含 `dsh-fish`。

> **重启 DSH 才会加载插件**。如果执行者是 DSH 自己，这一步留给用户（或写进计划任务，下次启动生效）。插件加载后 `~/.dsh-fish/logs/dsh-fish.log` 会出现 `[wechat] 通道已监听 127.0.0.1:11231`。

---

## 5. 配置（安装器已写好，这里只核对）

| 文件 | 关键字段 | 期望 |
|---|---|---|
| `$Target\app\bridge\config.json` | `reader/hook/fish.token` | 三处都是同一个随机令牌 |
| 同上 | `whitelist` | `[]`（空 = 不回任何人） |
| 同上 | `fish.baseUrl` | `http://127.0.0.1:11231` |
| 同上 | `batch.groupSilenceMs` | `6000` |
| 同上 | `mentionAliases` | `[]`（默认不靠正文判断 @；要认 @ 就填她在这台微信里的昵称，如 `["小助手"]`） |
| `~/.dsh-fish/config.json` | `wechat.enabled` | `true` |
| 同上 | `wechat.port` / `wechat.token` | `11231` / 与桥接一致 |
| 同上 | `wechat.groupPerHour` / `groupGapMin` | `4` / `10` |

```powershell
$b = Get-Content "$Target\app\bridge\config.json" -Raw | ConvertFrom-Json
$d = Get-Content "$env:USERPROFILE\.dsh-fish\config.json" -Raw | ConvertFrom-Json
if ($b.fish.token -ne $d.wechat.token) { throw 'E_TOKEN_MISMATCH: 桥接与插件令牌不一致' }
"OK token 一致，whitelist=$($b.whitelist.Count) 项"
```

---

## 6. 启动与验收

```powershell
$Suffix = ''   # 与安装时一致
Start-ScheduledTask -TaskName "WeChatFishReader$Suffix"
Start-ScheduledTask -TaskName "WeChatFishBridge$Suffix"
Start-Sleep -Seconds 8

# 四个组件
@{ hook = 30001; reader = 5031; fish = 11231; bridge = 11232 } | ForEach-Object {
  $name = $_.Keys; $port = $_.Values
  $ok = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  "{0,-7} :{1}  {2}" -f $name, $port, ($(if ($ok) { 'LISTEN' } else { 'DOWN' }))
}

# 插件健康
Invoke-RestMethod 'http://127.0.0.1:11231/health'
# 桥接状态
Invoke-RestMethod 'http://127.0.0.1:11232/status' | ConvertTo-Json -Depth 6
```

**版本核对（必须）**：

```powershell
$state = Get-Content "$Target\install-state.json" -Raw | ConvertFrom-Json
if ($state.version -ne '0.2.0') { throw "E_VERSION: 装出来的版本是 $($state.version)，不是 0.2.0" }
Get-Content "$Target\VERSION.txt" -TotalCount 1   # 必须是 0.2.0
"OK WeChat Fish 0.2.0"
```

桥接日志里应能看到这几行（顺序不一定）：

```
[whitelist] （空，谁都不回）
[reader] ... SSE ...
[bridge] started
```

---

## 7. 开启会话（装完默认全静默）

白名单为空时她不会回任何人。两种开法：

- **控制台**：桌面「微信薄桥接」→「会话」→ 勾选群/好友 →「保存」。保存后桥接 3 秒内热更新，不用重启。
- **直接改配置**（自动化）：

```powershell
$file = "$Target\app\bridge\config.json"
$cfg  = Get-Content $file -Raw | ConvertFrom-Json
$cfg.whitelist = @('wechat:group:<群会话id>', 'wechat:private:<好友会话id>')
[IO.File]::WriteAllText($file, ($cfg | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
# 3 秒后日志出现 [whitelist] 已热更新：N → M 个会话
```

会话 id 从 `http://127.0.0.1:5031/api/v1/sessions` 取（需要 `Authorization: Bearer <reader_token>`）。

---

## 8. 回滚 / 卸载

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Target\uninstall.ps1"          # 保留数据
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Target\uninstall.ps1" -Purge   # 连数据一起删
```

卸载会：停任务、按命令行杀 reader/bridge、删目录、删桌面快捷方式。跑着的微信要自己关。

---

## 9. 故障码

| 输出 | 含义 | 处理 |
|---|---|---|
| `E_TARGET_EXISTS` | 目标目录已存在 | 换目录，或先卸载 |
| `E_TASK_EXISTS` | 计划任务重名 | 换 `-TaskSuffix`，或先删任务 |
| `E_PORT_IN_USE` | 端口被占 | 查 `Get-NetTCPConnection -LocalPort <n>` 停掉 |
| `E_PAYLOAD` | 安装包不完整 | 重新校验 SHA256 |
| `E_WECHAT_NOT_RUNNING` / `E_NOT_LOGGED_IN` | 微信没起/没登录 | 第 3 步扫码 |
| `E_KEY_EXTRACTION_FAILED` | 密钥没抓到 | 退出微信重新扫码（登录那一刻才抓得到） |
| `E_READER_START_FAILED` | reader 起不来 | 看 `$Target\workspace\logs`、控制台「服务」页 |
| `E_TOKEN_MISMATCH` | 桥接与插件令牌不一致 | 重跑安装器，或手动把两边改成同一个 |

---

## 10. 隐私与边界

- 安装包与本文档**不含任何人的账号、群号、令牌、聊天记录或本机用户名**。
- 令牌在安装时用 `RandomNumberGenerator` 现生成，每台机器不同。
- 白名单默认空；装完不会自动回任何消息。
- 所有数据在 `%LOCALAPPDATA%\WeChatFish` 与本机 `~/.dsh-fish`，不上传。
- 只有 DSH 调用模型时联网。
- 向微信注入 Hook 违反微信用户协议，账号有被封风险；这是使用者自己的选择，安装器不对此负责。
