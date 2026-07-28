# PowerShell 版本的数据库清理脚本

Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  数据库清理工具" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$dataDir = Join-Path $PSScriptRoot "..\data"
$filesToClear = @(
    "bot.json",
    "user_accounts.json"
)
$dirsToClear = @(
    "sessions"
)

# 检查数据目录是否存在
if (-not (Test-Path $dataDir)) {
    Write-Host "⚠️ 数据目录不存在: $dataDir" -ForegroundColor Yellow
    exit 0
}

$clearedCount = 0

# 清理文件
Write-Host "📄 清理数据库文件..." -ForegroundColor Green
foreach ($file in $filesToClear) {
    $filePath = Join-Path $dataDir $file
    if (Test-Path $filePath) {
        try {
            Remove-Item $filePath -Force
            Write-Host "✅ 已删除: $file" -ForegroundColor Green
            $clearedCount++
        } catch {
            Write-Host "❌ 删除失败 $file : $_" -ForegroundColor Red
        }
    } else {
        Write-Host "ℹ️  文件不存在: $file" -ForegroundColor Gray
    }
}

# 清理目录
Write-Host ""
Write-Host "📁 清理数据库目录..." -ForegroundColor Green
foreach ($dir in $dirsToClear) {
    $dirPath = Join-Path $dataDir $dir
    if (Test-Path $dirPath) {
        try {
            Remove-Item $dirPath -Recurse -Force
            Write-Host "✅ 已删除目录: $dir/" -ForegroundColor Green
            $clearedCount++
        } catch {
            Write-Host "❌ 删除目录失败 $dir : $_" -ForegroundColor Red
        }
    } else {
        Write-Host "ℹ️  目录不存在: $dir/" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "✅ 清理完成！共清理 $clearedCount 个项目" -ForegroundColor Green
Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "💡 提示:" -ForegroundColor Yellow
Write-Host "  - 备份文件未受影响，位于 backups/ 目录"
Write-Host "  - 重新启动机器人将创建新的数据库文件"
Write-Host ""

