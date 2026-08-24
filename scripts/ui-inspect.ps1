param(
  [string]$Name = "now"
)

# 真机页面取证：dump 控件树 + 截图 + 输出可读控件清单，供填写 android-worker 选择器。
# 结果一律写成 UTF-8 文件，避免 GBK 控制台把 App 里的中文显示成乱码。
$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\data\ui-capture"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$xmlPath = Join-Path $outDir "ui-$Name.xml"
$pngPath = Join-Path $outDir "shot-$Name.png"
$smallPath = Join-Path $outDir "shot-$Name-small.png"
$listPath = Join-Path $outDir "nodes-$Name.txt"

adb shell "uiautomator dump /sdcard/ui-capture.xml >/dev/null 2>&1" | Out-Null
adb pull /sdcard/ui-capture.xml $xmlPath | Out-Null
adb shell screencap -p /sdcard/ui-capture.png | Out-Null
adb pull /sdcard/ui-capture.png $pngPath | Out-Null

Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($pngPath)
$scale = 540 / $image.Width
$small = New-Object System.Drawing.Bitmap($image, [int]($image.Width * $scale), [int]($image.Height * $scale))
$small.Save($smallPath, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
$image.Dispose()

$xml = [xml](Get-Content $xmlPath -Encoding UTF8)
$all = $xml.SelectNodes("//node")
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("页面: $Name")
$lines.Add("控件总数: $($all.Count)")
$lines.Add("")
$index = 0
foreach ($node in $all) {
  $index++
  $text = ($node.GetAttribute("text") -replace "\r?\n", " ⏎ ")
  $desc = ($node.GetAttribute("content-desc") -replace "\r?\n", " ⏎ ")
  $rid = $node.GetAttribute("resource-id")
  if (-not $text -and -not $desc -and -not $rid) { continue }
  $lines.Add("[$index] clickable=$($node.GetAttribute('clickable')) bounds=$($node.GetAttribute('bounds')) class=$($node.GetAttribute('class'))")
  if ($rid) { $lines.Add("     resource-id: $rid") }
  if ($text) { $lines.Add("     text: $text") }
  if ($desc) { $lines.Add("     desc: $desc") }
}
[IO.File]::WriteAllLines($listPath, $lines, (New-Object Text.UTF8Encoding($false)))

Write-Host "nodes: $listPath"
Write-Host "xml:   $xmlPath"
Write-Host "shot:  $smallPath"
