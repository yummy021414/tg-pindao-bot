import fs from 'fs';
import path from 'path';

/**
 * 全局错误日志记录器
 */
export class ErrorLogger {
  private static errorLogPath = path.join(process.cwd(), 'data', 'errors.log');

  static log(context: string, error: any, userId?: number): void {
    const timestamp = new Date().toISOString();
    const userInfo = userId ? `用户${userId}` : '系统';
    const errorMsg = `[${timestamp}] [${context}] ${userInfo}: ${error.message || error}`;
    
    // 控制台输出
    console.error(errorMsg);
    
    // 写入错误日志文件
    try {
      const logDir = path.dirname(this.errorLogPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.appendFileSync(this.errorLogPath, errorMsg + '\n');
    } catch (logError) {
      console.error('无法写入错误日志:', logError);
    }
  }

  static warn(context: string, message: string, userId?: number): void {
    const timestamp = new Date().toISOString();
    const userInfo = userId ? `用户${userId}` : '系统';
    const warnMsg = `[${timestamp}] [⚠️ ${context}] ${userInfo}: ${message}`;
    console.warn(warnMsg);
  }
}
















