param([switch]$Build)
$ErrorActionPreference='Stop'
# Preparation only by default. Never install build tools or produce an EXE implicitly.
$dist=Join-Path $PSScriptRoot 'dist';New-Item -ItemType Directory -Force $dist|Out-Null
$stage=Join-Path $dist 'sfx-stage';New-Item -ItemType Directory -Force $stage|Out-Null
$launch='call install.cmd %*'
# IExpress flattens source directories: retain the payload tree inside a TAR archive.
$sed=@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$dist\WeChatFish-Setup-x64.exe
FriendlyName=WeChatFish 0.1.1
AppLaunched=cmd.exe /c setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
[Strings]
FILE0="bundle.tar"
FILE1="setup.cmd"
"@
$sed|Set-Content "$dist\WeChatFish.sed" -Encoding Default
if(!$Build){Write-Host '已生成 SED；下一步确认后使用 -Build 构建。';return}
& tar.exe -cf "$stage\bundle.tar" -C $PSScriptRoot payload install.cmd install.ps1 uninstall.ps1 start-wechat.ps1 bootstrap-account.ps1 first-run.cmd DEPLOY.md
if($LASTEXITCODE){throw 'E_TAR: 无法创建保留目录结构的载荷'}
@('@echo off','cd /d "%~dp0"','tar.exe -xf bundle.tar', $launch,'exit /b %errorlevel%')|Set-Content "$stage\setup.cmd" -Encoding ASCII
# IExpress 读不了这个 SED（弹窗卡死构建），直接用 7-Zip SFX
Write-Host '跳过 IExpress，使用 7-Zip SFX'
$seven="$env:ProgramFiles\7-Zip\7z.exe"
if(!(Test-Path $seven)){$seven="${env:ProgramFiles(x86)}\7-Zip\7z.exe"}
if(!(Test-Path $seven)){
  & winget.exe install --id 7zip.7zip --exact --accept-package-agreements --accept-source-agreements
  $seven="$env:ProgramFiles\7-Zip\7z.exe"
  if(!(Test-Path $seven)){throw 'E_7ZIP_INSTALL: 请手动安装 7-Zip 后重试'}
}
Write-Host ('使用 7-Zip: '+$seven)
# Official SDK version is explicit and reproducible, not an executable from a mirror.
# 已经解出 SFX 就复用：每次构建都联网下载，代理抖一下整条流水线就断在这
$sfx=Get-ChildItem "$dist\lzma-sdk" -Filter 7zSD.sfx -Recurse -ErrorAction SilentlyContinue|Select-Object -First 1
if(!$sfx){
 if(!(Test-Path "$dist\lzma-sdk.7z")){Invoke-WebRequest 'https://www.7-zip.org/a/7z920_extra.7z' -OutFile "$dist\lzma-sdk.7z"}
 & $seven x "$dist\lzma-sdk.7z" "-o$dist\lzma-sdk" -y
 if($LASTEXITCODE){throw 'E_SDK_EXTRACT'}
 $sfx=Get-ChildItem "$dist\lzma-sdk" -Filter 7zSD.sfx -Recurse|Select-Object -First 1
}
if(!$sfx){throw 'E_SFX_MISSING: SDK 未包含 7zSD.sfx，请提供官方安装模块'}
Remove-Item "$dist\payload.7z" -Force -ErrorAction SilentlyContinue
& $seven a -t7z -m0=lzma -mx=3 "$dist\payload.7z" "$stage\bundle.tar" "$stage\setup.cmd"
if($LASTEXITCODE){throw 'E_7ZIP_ARCHIVE'}
$config=";!@Install@!UTF-8!`nTitle=`"WeChatFish`"`nRunProgram=`"setup.cmd`"`n;!@InstallEnd@!`n"
$out=[IO.File]::Create("$dist\WeChatFish-Setup-x64.exe")
try{foreach($f in @($sfx.FullName)){ $b=[IO.File]::ReadAllBytes($f);$out.Write($b,0,$b.Length)};$b=[Text.Encoding]::UTF8.GetBytes($config);$out.Write($b,0,$b.Length);$input=[IO.File]::OpenRead("$dist\payload.7z");try{$input.CopyTo($out)}finally{$input.Dispose()}}finally{$out.Dispose()}
