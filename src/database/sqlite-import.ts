import * as fs from 'fs';
import * as path from 'path';

// 简单的 SQLite 数据导入工具
export class SqliteImporter {
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // 检查数据库文件是否存在
  public checkDatabaseExists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  // 获取数据库文件大小
  public getDatabaseSize(): number {
    if (!this.checkDatabaseExists()) {
      return 0;
    }
    return fs.statSync(this.dbPath).size;
  }

  // 检查是否是有效的 SQLite 文件
  public isValidSqliteFile(): boolean {
    if (!this.checkDatabaseExists()) {
      return false;
    }
    
    try {
      const buffer = fs.readFileSync(this.dbPath).slice(0, 15);
      const header = buffer.toString('ascii');
      return header.startsWith('SQLite format 3');
    } catch (error) {
      return false;
    }
  }

  // 创建数据迁移提示
  public createMigrationGuide(): string {
    return `
📋 SQLite 数据迁移指南

当前状态：
- 数据库文件: ${this.dbPath}
- 文件存在: ${this.checkDatabaseExists() ? '✅' : '❌'}
- 文件大小: ${this.getDatabaseSize()} bytes
- 有效 SQLite: ${this.isValidSqliteFile() ? '✅' : '❌'}

迁移步骤：
1. 确保你的完整数据库文件在 data/bot.db
2. 运行数据迁移脚本
3. 验证数据完整性

💡 如果文件大小小于 1MB，可能不是完整的数据库文件
    `;
  }
}

// 创建导入器实例
export const sqliteImporter = new SqliteImporter(path.join(process.cwd(), 'data', 'bot.db'));
