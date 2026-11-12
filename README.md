# 微信薄桥接（WeChat Fish）· 0.2.1

把 DSH 接进微信：她在群里像人一样说话，能看图、认人、挑表情、记得住前几天的事。

这不是又一个"自动回复机器人"。判断该不该回、回什么、发多快，都由 DSH 里的插件负责；这个安装包只负责把"耳朵、嘴和后台"装好。

**当前版本：0.2.1**（构建 2026-10-30）· 安装包 `WeChatFish-Setup-x64.exe` · 校验值见同目录 `SHA256SUMS.txt`

---

## 它是什么

四层，全部跑在本机回环上，聊天记录不出这台机器：

```
┌──────────────────────────────────────────────────────┐
│ 1. 微信客户端 4.1.10.27（随包自带，已注入 Hook）        │
│    进程内 version.dll 监听 127.0.0.1:30001             │
│    能做的事：发消息、读库、抓图片/表情、等送达回执        │
└───────────────────────┬──────────────────────────────┘
                        │ 本机 HTTP（同一枚随机令牌）
┌───────────────────────┴──────────────────────────────┐
│ 2. reader（Python）  127.0.0.1:5031                    │
│    读消息流（SSE）、下载图片与表情到本地、维护会话表      │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────┴──────────────────────────────┐
│ 3. 桥接（Node）  127.0.0.1:11232                       │
│    攒批、静默窗口、限流、去重、白名单、发送、回执轮询     │
│    日志分级 ERROR/WARN/INFO/DEBUG                      │
└───────────────────────┬──────────────────────────────┘
                        │ 127.0.0.1:11231
┌───────────────────────┴──────────────────────────────┐
│ 4. DSH 插件 dsh-fish（她的大脑）                        │
│    该不该回、怎么回、发多少字、要不要发表情、记什么       │
└──────────────────────────────────────────────────────┘
```

还有一个**控制台**（`wechat-fish-console.exe`）不属于消息链路，只负责看状态、勾会话、改频率、翻日志。

为什么要分成四层：微信的东西只能由注入的 DLL 碰，Python 负责脏活（解库、转图），Node 负责节奏和队列，判断留给 DSH——任何一层崩了，其它层还能告诉你崩在哪。

## 0.2.1 相对 0.2.0

- **桥接日志分级**：ERROR / WARN / INFO / DEBUG，`config.json` 的 `logLevel` 决定落盘粒度；控制台日志页可按级别筛选。排查"她为什么不回"时先看 WARN。
- **微信设置页实时热更新**：控制台保存桥接配置后约 1.5 秒自动重启通道（reader SSE 与发送通道），不用手动停服务、不用重开微信。
- **修复设置页读错接口导致保存清空令牌**：以前在"设置"页点保存会把 `fish.token` 覆盖成空值，表现是装完能连、存一次就不说话了。
- **控制台健康检查超时 2s → 5s**：模型排队或机器卡顿时不再误报组件离线。

## 系统要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11，64 位 |
| PowerShell | 5.1 或更高（系统自带即可，不需要 PowerShell 7） |
| DSH | 已安装并登录（"大脑"运行在 DSH 里） |
| 微信账号 | 一个愿意用来做机器人的号，建议小号 |
| 磁盘 | 安装包 372 MB，安装后约 1.3 GB，留 ≥ 6 GB 空闲最稳 |
| 权限 | 安装/卸载要一次管理员（注册两个登录计划任务）；日常运行**不要**管理员 |
| 网络 | 只有 DSH 调模型时联网；安装本身不需要网络 |

安装包自带微信 4.1.10.27 客户端、Hook 组件、Python/Node 运行时，**不需要另外装 WeChatAgent，也不要预装微信**（自带的那份会被 ACL 锁定，防止自动更新把 Hook 顶掉）。

## 如何让任何智能体直接安装

把本文件（`README.md`）和 `DEPLOY.md` 一起交给任意一个能执行 PowerShell 的智能体，说一句"按 DEPLOY 装"，就够了——`DEPLOY.md` 是给人读也给代理直接执行的分步说明（步骤 0–7），里面的命令可以原样粘贴运行，每一步都带验收条件和错误码表；代理读完不需要再问你任何配置问题，令牌由安装器当场随机生成。

**只有两件事必须人工**：

1. **UAC 提权弹窗**：注册/删除计划任务需要管理员，代理不能替你点"是"。
2. **微信扫码登录**：数据库密钥只在登录那一刻存在，必须真人拿手机扫一次（每台新机器一次）。`DEPLOY.md` 第 3 步会等你扫完再继续。

人工做完这两件事，其余（校验 SHA256、解包、装到指定目录、把插件挂进 DSH profile、核对配置、启动验收、开白名单）代理可以全自动走完。

最短路径（代理视角）：

```powershell
# 0) 把 README.md / DEPLOY.md / SHA256SUMS.txt / WeChatFish-Setup-x64.exe 放在同一个目录
Get-FileHash .\WeChatFish-Setup-x64.exe -Algorithm SHA256   # 与 SHA256SUMS.txt 比对
# 1) 7z 解包 → tar 解包 → 调 install.ps1（详见 DEPLOY.md 第 2 步）
# 2) 人工扫码（DEPLOY.md 第 3 步）
# 3) junction 挂进 DSH profile（DEPLOY.md 第 4 步）
# 4) 四端口 + /health + /status 验收（DEPLOY.md 第 6 步）
```

## 目录结构

**发布包（桌面 `WeChatFish-0.2.1\`）**

```
WeChatFish-0.2.1\
├─ WeChatFish-Setup-x64.exe     7-Zip 自解压安装器（372 MB）
├─ README.md                    本文件
├─ DEPLOY.md                    给自动化代理的分步部署说明
└─ SHA256SUMS.txt               exe 的 SHA256（先校验再装）
```

安装器内部：`bundle.tar`（保留目录结构）里是 `payload\` + `install.ps1` / `install.cmd` / `uninstall.ps1` / `start-wechat.ps1` / `bootstrap-account.ps1` / `first-run.cmd` / `DEPLOY.md`。

**安装后（默认 `%LOCALAPPDATA%\WeChatFish\`）**

```
WeChatFish\
├─ client\                 微信客户端 4.1.10.27 + version.dll（ACL 锁定，防自动更新）
├─ hook\                   Hook 组件与 build.json
├─ runtime\                node.exe 与嵌入式 Python
├─ app\
│  ├─ bridge\              桥接：main.js + src\*.js + config.json（真实令牌）
│  ├─ console\             控制台 wechat-fish-console.exe + 三个 .cs 源码
│  ├─ dsh-fish\            插件：lib\（含 clock.js、wechat\quota.js）+ media\ + 文档
│  ├─ template\            workspace 模板（reader-api.py、weflow-cli 等）
│  └─ weflow\              WeFlow 读取层与 wx_key.dll
├─ workspace\              运行数据：config\、state\（令牌、账号）、logs\、scripts\
├─ logs\                   进程级日志
├─ install-state.json      安装参数（version / 端口 / taskSuffix）—— 验收就查这里
├─ self-test.json          装完那次自检的结果
├─ VERSION.txt             版本与本版变更
├─ first-run.cmd           首次扫码引导（双击即可）
├─ start-wechat.ps1        启动微信
├─ uninstall.ps1           卸载
└─ README.md / RELEASE.md / NOTICE.txt / DEPLOY.md
```

`workspace\` 是数据目录：卸载不带 `-Purge` 时它会被保留，重装后她记得的人还在。

## 日常使用

桌面「微信薄桥接」快捷方式打开控制台，8 个页签：

| 页签 | 用途 |
|---|---|
| 连接 | 启动/停止服务、启动微信、四个组件状态与计数 |
| 会话 | 勾选允许她说话的群和好友（不在名单里的一律不回） |
| 设置 | 回复频率、表情概率、静默间隔、日志级别（保存后 1.5 秒热更新） |
| 服务 | 单个服务的启动、停止、诊断 |
| 日志 | 实时看桥接日志，可按 ERROR/WARN/INFO/DEBUG 筛选 |
| 表情库 | 已收集的表情缩略图墙 |
| 时段与管理员 | 静默时段、管理员名单、群成员列表 |
| 群友 | 每个人的记忆：说话次数、发过什么、角色标签 |

## 端口

| 端口 | 用途 |
|---|---|
| 30001 | Hook（微信进程内，发消息/读库） |
| 5031 | reader（读消息、取图） |
| 11231 | DSH 插件（她的大脑） |
| 11232 | 桥接（攒批与状态查询） |

全部只监听 `127.0.0.1`，不对外。安装器还会把 adapter 端口 8766 写进 `workspace\config\wechatagent.json`，保留默认即可。

## 常见问题

**装完她不说话？**
默认白名单是空的——空 = 谁都不回，这是安全默认值。控制台「会话」页勾上群/好友再保存，或按 `DEPLOY.md` 第 7 步直接改 `config.json` 的 `whitelist`。

**四个状态点有红的？**
「服务」页看具体哪个组件。`E_WECHAT_NOT_RUNNING` = 微信没起（点"启动微信"）；`E_NOT_LOGGED_IN` = 没登录（扫码）；`E_NOT_LISTENING` = 该服务没起来（看 `logs\`）。

**保存设置后令牌空了 / 桥接连不上插件？**
那是 0.2.0 的 bug，0.2.1 已修。老安装升级后如果仍不一致：`install-state.json` 与 `app\bridge\config.json`、`~/.dsh-fish\config.json` 三处的 token 要一样，重跑安装器最省事。

**表情发不出去？**
微信只接受 GIF 表情，转换由包内 Python 做。日志页筛 `[meme]` 看转换是否失败。

**消息要几分钟才回？**
被限流了。设置页看回复频率上限（`pacing.baseMs` / `maxPerMinute`），群里另外有 `groupPerHour`（默认 4）和 `groupGapMin`（默认 10 分钟）配额。

**微信自动更新了怎么办？**
`client\` 被 ACL 锁住就是为了防这个。万一被更新，Hook 会拒绝加载（只支持 4.1.10.27），用安装包重装一遍，然后重新扫码。

**重装要重新扫码吗？**
要。密钥与登录态绑定，每台机器每次全新安装都要扫一次（`first-run.cmd`）。

**想装第二份（另一个号）？**
换 `-TargetDir` 和 `-TaskSuffix`，端口也要错开，详见 `DEPLOY.md` 第 2 步。

## 卸载

```powershell
# 保留聊天数据（workspace\ 留着）
powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\WeChatFish\uninstall.ps1"

# 连数据一起删
powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\WeChatFish\uninstall.ps1" -Purge
```

卸载会请求一次管理员权限（删计划任务要）。跑着的微信请自己关掉——安装器不会替你杀进程。

---

## 许可与风险声明

| 组件 | 来源 | 许可 |
|---|---|---|
| 桥接 / 控制台 / dsh-fish 插件 | 本项目 | MIT |
| reader / WeFlow 读取层 | [WeChatAgent](https://github.com/sourcepro5/WeChatAgent) | MIT |
| Hook 组件（`version.dll`） | [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) | 已获得再分发授权 |
| 微信客户端 4.1.10.27 | 腾讯 | 随包分发，版权归腾讯所有 |

完整署名见 `NOTICE.txt`。

**风险声明（请认真读）**

- 向微信客户端注入组件、读取本地数据库，**违反微信用户协议**；账号存在被限制或封禁的实时风险。请用小号，并自行承担后果。
- 这是"让一个模型用你的号说话"的工具。说错话的是她，担责任的是你。群里出现纠纷、被举报、被踢，都不在安装器的责任范围内。
- 本软件按 MIT 提供，**不附带任何担保**，包括可用性与特定用途适用性。
- 包内微信客户端版权归腾讯所有，仅随本安装器分发，不得单独再分发。
- 不要用它做群发、营销、刷屏、冒充他人身份——那既违反协议也违反常识。

## 隐私

- 所有数据留在本机：`%LOCALAPPDATA%\WeChatFish`、`~/.dsh-fish`。
- 聊天记录只在本地，用于生成上下文；不会上传到任何本项目服务器。
- 安装包与文档**不含任何人的账号、群号、聊天记录、令牌或本机路径**。令牌在安装时用 `RandomNumberGenerator` 现生成，每台机器不同。
- 白名单默认空：装完不会自动回任何消息，必须你亲手勾。
- 只有 DSH 调用模型时联网（那是 DSH 的接口，不由本包控制）。
