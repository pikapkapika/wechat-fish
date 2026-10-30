$ErrorActionPreference='Stop'
$dist=Join-Path $PSScriptRoot 'dist'
$config=";!@Install@!UTF-8!`nTitle=`"WeChatFish`"`nRunProgram=`"setup.cmd`"`n;!@InstallEnd@!`n"
$out=[IO.File]::Create("$dist\WeChatFish-Setup-x64.exe")
try {
 foreach($file in @("$dist\sfx-module\7zSD.sfx")){ $input=[IO.File]::OpenRead($file);try{$input.CopyTo($out)}finally{$input.Dispose()} }
 $b=[Text.Encoding]::UTF8.GetBytes($config);$out.Write($b,0,$b.Length)
 $input=[IO.File]::OpenRead("$dist\release-payload.7z");try{$input.CopyTo($out)}finally{$input.Dispose()}
}finally{$out.Dispose()}
Get-Item "$dist\WeChatFish-Setup-x64.exe" | Select-Object FullName,Length
Get-FileHash "$dist\WeChatFish-Setup-x64.exe" -Algorithm SHA256
