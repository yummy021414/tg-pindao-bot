# 数据库管理脚本

## 清理数据库

### Windows (PowerShell)
```powershell
npm run clear-db-win
```
或直接运行：
```powershell
powershell -ExecutionPolicy Bypass -File scripts/clear-database.ps1
```

### Linux/Mac
```bash
npm run clear-db
```
或直接运行：
```bash
node scripts/clear-database.js
```

## 自动备份功能

机器人启动后会自动启动备份服务：
- **备份频率**: 每3天一次（凌晨0点）
- **备份位置**: `backups/backup_YYYY-MM-DDTHH-MM-SS/`
- **备份内容**:
  - `bot.json` - 主数据库
  - `user_accounts.json` - 用户账号数据库
  - `sessions/` - 会话目录
- **备份保留**: 自动保留最近10个备份，删除更旧的备份

## 备份文件结构

```
backups/
├── backup_2024-01-01T00-00-00/
│   ├── bot.json
│   ├── user_accounts.json
│   ├── sessions/
│   └── backup_info.json
├── backup_2024-01-04T00-00-00/
│   └── ...
└── ...
```

## 注意事项

⚠️ **清理数据库会删除所有数据！**
- 清理前请确保已备份重要数据
- 备份文件位于 `backups/` 目录，不会被清理
- 清理后重新启动机器人会创建新的空数据库

