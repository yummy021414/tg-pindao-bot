import * as fs from 'fs';
import * as path from 'path';
import cron from 'node-cron';
import { config } from '../config';
import { database } from '../database';

export class BackupService {
  private backupDir: string;
  private dataDir: string;
  private backupInterval: string = '0 0 */3 * *'; // 每3天凌晨执行一次

  constructor() {
    // 确定数据目录和备份目录
    const projectRoot = path.join(__dirname, '..', '..');
    this.dataDir = path.join(projectRoot, 'data');
    this.backupDir = path.join(projectRoot, 'backups');
    
    // 确保备份目录存在
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * 执行数据库备份
   */
  async performBackup(): Promise<string | null> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const backupSubDir = path.join(this.backupDir, `backup_${timestamp}`);
      
      // 创建备份子目录
      if (!fs.existsSync(backupSubDir)) {
        fs.mkdirSync(backupSubDir, { recursive: true });
      }

      let backedUpFiles: string[] = [];

      // 备份主数据库文件（排除相册数据，相册不进入资料备份）
      const botDbPath = path.join(this.dataDir, 'bot.json');
      if (fs.existsSync(botDbPath)) {
        const backupPath = path.join(backupSubDir, 'bot.json');
        try {
          const botData = JSON.parse(fs.readFileSync(botDbPath, 'utf8'));
          delete botData.albums;
          fs.writeFileSync(backupPath, JSON.stringify(botData, null, 2));
        } catch {
          fs.copyFileSync(botDbPath, backupPath);
        }
        backedUpFiles.push('bot.json');
        console.log(`✅ 已备份: bot.json（已排除相册）`);
      }

      // 备份用户账号数据库
      const userAccountsPath = path.join(this.dataDir, 'user_accounts.json');
      if (fs.existsSync(userAccountsPath)) {
        const backupPath = path.join(backupSubDir, 'user_accounts.json');
        fs.copyFileSync(userAccountsPath, backupPath);
        backedUpFiles.push('user_accounts.json');
        console.log(`✅ 已备份: user_accounts.json`);
      }

      // 备份 sessions 目录（如果存在）
      const sessionsDir = path.join(this.dataDir, 'sessions');
      if (fs.existsSync(sessionsDir)) {
        const backupSessionsDir = path.join(backupSubDir, 'sessions');
        this.copyDirectory(sessionsDir, backupSessionsDir);
        backedUpFiles.push('sessions/');
        console.log(`✅ 已备份: sessions/`);
      }

      if (backedUpFiles.length === 0) {
        console.log('⚠️ 没有找到需要备份的文件');
        // 删除空的备份目录
        fs.rmdirSync(backupSubDir);
        return null;
      }

      // 创建备份信息文件
      const backupInfo = {
        timestamp: new Date().toISOString(),
        files: backedUpFiles,
        version: '1.0'
      };
      fs.writeFileSync(
        path.join(backupSubDir, 'backup_info.json'),
        JSON.stringify(backupInfo, null, 2)
      );

      console.log(`📦 备份完成: ${backupSubDir}`);
      console.log(`   备份文件数: ${backedUpFiles.length}`);
      
      // 清理旧备份（保留最近3个备份，防止占用过多硬盘空间）
      this.cleanOldBackups();

      return backupSubDir;
    } catch (error: any) {
      console.error('❌ 备份失败:', error?.message || error);
      return null;
    }
  }

  /**
   * 递归复制目录 (增加过滤逻辑，绝对不备份视频缓存和日志)
   */
  private copyDirectory(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      // 🚀 核心防御：绝对不备份视频缓存和巨大的日志文件
      const blackList = ['public', 'albums', 'bot.log', 'errors.log', 'temp_logs.txt'];
      if (blackList.includes(entry.name)) continue;

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * 清理旧备份，只保留最近3个
   */
  private cleanOldBackups(): void {
    try {
      const backups = fs.readdirSync(this.backupDir)
        .filter(item => {
          const itemPath = path.join(this.backupDir, item);
          return fs.statSync(itemPath).isDirectory() && item.startsWith('backup_');
        })
        .map(item => ({
          name: item,
          path: path.join(this.backupDir, item),
          time: fs.statSync(path.join(this.backupDir, item)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time); // 按时间倒序排列

      // 如果超过3个备份，删除最旧的
      if (backups.length > 3) {
        const toDelete = backups.slice(3);
        for (const backup of toDelete) {
          this.deleteDirectory(backup.path);
          console.log(`🗑️ 已清理多余备份: ${backup.name}`);
        }
      }
    } catch (error: any) {
      console.error('⚠️ 清理旧备份失败:', error?.message || error);
    }
  }

  /**
   * 递归删除目录
   */
  private deleteDirectory(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
      fs.readdirSync(dirPath).forEach((file) => {
        const curPath = path.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          this.deleteDirectory(curPath);
        } else {
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(dirPath);
    }
  }

  /**
   * 启动自动备份任务
   */
  startAutoBackup(): void {
    console.log('🔄 启动自动备份服务...');
    console.log(`   备份频率: 每3天一次（凌晨0点）`);
    console.log(`   备份目录: ${this.backupDir}`);

    // 立即执行一次备份（用于测试）
    this.performBackup().then(() => {
      console.log('✅ 初始备份完成');
    });

    // 设置定时任务：每3天凌晨0点执行
    cron.schedule(this.backupInterval, () => {
      console.log('⏰ 定时备份任务触发...');
      this.performBackup();
    });

    // 每24小时清理一次过期相册（3天以上）
    cron.schedule('0 2 * * *', () => {
      console.log('⏰ 定时清理过期相册任务触发...');
      this.cleanExpiredAlbums();
    });

    console.log('✅ 自动备份与清理服务已启动');
  }

  /**
   * 清理超过3天的相册文件和数据（相册不进入备份）
   */
  async cleanExpiredAlbums(): Promise<void> {
    try {
      const expiredAlbums = await database.getExpiredAlbums(3);
      if (expiredAlbums.length === 0) return;

      console.log(`🧹 发现 ${expiredAlbums.length} 个过期相册，准备清理...`);

      for (const album of expiredAlbums) {
        try {
          const albumPath = path.join(process.cwd(), 'data/public/albums', album.id);
          if (fs.existsSync(albumPath)) {
            this.deleteDirectory(albumPath);
          }
          await database.deleteAlbum(album.id);
          console.log(`🗑️ 已清理过期相册: ${album.name || album.id}`);
        } catch (err: any) {
          console.error(`❌ 清理相册 ${album.id} 失败:`, err.message);
        }
      }
      console.log('✅ 过期相册清理完成');
    } catch (error: any) {
      console.error('⚠️ 清理过期相册失败:', error?.message || error);
    }
  }

  /**
   * 手动触发备份（供管理员命令使用）
   */
  async manualBackup(): Promise<string | null> {
    console.log('📦 手动触发备份...');
    return await this.performBackup();
  }
}

