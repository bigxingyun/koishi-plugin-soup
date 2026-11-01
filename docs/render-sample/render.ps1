# 批量渲染：plan.json -> HTML -> PNG
# 用法：.\render.ps1            渲染 plans/ 下全部
#       .\render.ps1 02-hannibal 只渲染指定的一锅

param([string]$Only = "")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$py = "C:\Users\otto\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$dir = $PSScriptRoot

$plans = Get-ChildItem "$dir\plans\*.json" | Sort-Object Name
if ($Only) { $plans = $plans | Where-Object { $_.BaseName -like "*$Only*" } }

$textures = Join-Path $dir "tex\grain.png"
if (-not (Test-Path $textures)) {
  Write-Host "生成纸纹贴图…"
  & $py "$dir\make-textures.py"
}

foreach ($p in $plans) {
  $slug = $p.BaseName
  $outName = "sample-$slug.png"
  $html = Join-Path $dir "_build-$slug.html"
  $raw = Join-Path $dir "_raw.png"

  & $py "$dir\build.py" $p.FullName
  if ($LASTEXITCODE -ne 0) { throw "build 失败：$slug" }

  if (Test-Path $raw) { Remove-Item $raw }
  $uri = "file:///" + ($html -replace '\\', '/')
  & $chrome --headless=new --disable-gpu --hide-scrollbars `
    --force-device-scale-factor=2 --window-size=720,3000 `
    --screenshot="$raw" $uri 2>&1 | Out-Null
  Start-Sleep -Milliseconds 250
  if (-not (Test-Path $raw)) { throw "截图失败：$slug" }

  & $py "$dir\crop.py" $raw (Join-Path $dir $outName)
  Remove-Item $raw
}

Write-Host "`n完成。输出：" -ForegroundColor Green
Get-ChildItem "$dir\sample-*.png" | Select-Object Name, @{n = "KB"; e = { [math]::Round($_.Length / 1kb) } } | Format-Table -AutoSize
