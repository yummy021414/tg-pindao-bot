import { Telegraf } from 'telegraf';
import { TelegramBot } from './bot';
import { config } from './config';
import { ForwardingService } from './forwarding';
import { BackupService } from './services/backup';
import { startWebServer } from './web/server';
import * as fs from 'fs';
import * as path from 'path';

// 简单的日志记录系统
const logPath = path.join(process.cwd(), 'data', 'bot.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function logToFile(message: string) {
  const timestamp = new Date().toLocaleString('zh-CN');
  logStream.write(`[${timestamp}] ${message}\n`);
}

// 重写 console.log 以便同时输出到文件和添加时间戳
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

// 格式化日志参数，特别处理 Error 对象
function formatLogArgs(args: any[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) {
      return `${a.name}: ${a.message}\n${a.stack}`;
    }
    try {
      return JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }).join(' ');
}

console.log = (...args: any[]) => {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  originalLog(`[${timestamp}]`, ...args);
  logToFile(formatLogArgs(args));
};

console.error = (...args: any[]) => {
  const msg = formatLogArgs(args);
  // 🚀 核心优化：过滤掉 GramJS 底层抛出的无害 TIMEOUT 错误日志
  if (msg.includes('TIMEOUT') && msg.includes('updates.js')) {
    return;
  }
  
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  originalError(`[${timestamp}] ❌`, ...args);
  logToFile(`ERROR: ${msg}`);
};

console.warn = (...args: any[]) => {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  originalWarn(`[${timestamp}] ⚠️`, ...args);
  logToFile(`WARN: ${formatLogArgs(args)}`);
};

async function main() {
  try {
    console.log('🚀 启动Telegram频道管理机器人...');
    console.log(`📊 配置信息:`);
    console.log(`   - 超级管理员ID: ${config.superAdminId}`);
    console.log(`   - 频道数量: ${config.channelIds.length}`);
    console.log(`   - 数据库路径: ${config.databasePath}`);
    
    // 检查环境变量中的代理设置
    const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
    const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (httpProxy || httpsProxy) {
      console.log(`🌐 检测到代理设置: HTTP=${httpProxy || '无'}, HTTPS=${httpsProxy || '无'}`);
    } else {
      console.log('🌐 未检测到代理设置');
      console.log('💡 如果网络连接有问题，可以设置环境变量:');
      console.log('   set HTTP_PROXY=http://proxy:port');
      console.log('   set HTTPS_PROXY=http://proxy:port');
    }
    
    const telegraf = new Telegraf(config.botToken, {
      handlerTimeout: 1800000, // 30 分钟
      telegram: {
        apiRoot: process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org' // 🚀 支持中转代理
      }
    });
    const forwardingService = new ForwardingService(telegraf);
    const bot = new TelegramBot(telegraf, forwardingService);
    
    // 1. 启动相册网页服务器 (最优先启动，确保外网可用)
    try {
      startWebServer(telegraf);
    } catch (webError) {
      console.error('❌ 网页服务器启动失败:', webError);
    }

    // 2. 启动自动备份服务
    const backupService = new BackupService();
    backupService.startAutoBackup();

    console.log('Starting bot...');
    console.log('💡 提示: 如果bot启动超时，请检查：');
    console.log('   1. 网络连接是否正常');
    console.log('   2. 是否能访问 https://api.telegram.org');
    console.log('   3. Bot Token是否正确');
    console.log('   4. 是否使用了代理/VPN\n');
    
    try {
      await bot.start();
      console.log('Bot started. Forwarding service disabled for safety.');
    } catch (error: any) {
      console.error('\n❌ bot.start() 失败:');
      console.error('错误信息:', error?.message || error);
      if (error?.stack) {
        console.error('错误堆栈:', error.stack);
      }
      
      // 如果是超时错误，给出更详细的建议
      if (error?.message?.includes('超时')) {
        console.error('\n💡 故障排查建议:');
        console.error('   1. 检查网络连接: ping api.telegram.org');
        console.error('   2. 如果在中国大陆，可能需要配置代理');
        console.error('   3. 检查Bot Token是否正确');
        console.error('   4. 尝试在浏览器访问: https://api.telegram.org/bot<TOKEN>/getMe');
        console.error('   5. 查看防火墙设置是否阻止了连接\n');
      }
      
      throw error;
    }
    // await forwardingService.start();
    // console.log('Forwarding service started.');
    
    console.log('✅ 机器人启动成功！');
    console.log('💡 按 Ctrl+C 停止机器人');
    
  } catch (error) {
    console.error('❌ 机器人启动失败:', error);
    process.exit(1);
  }
}

// 处理未捕获的异常 - 不退出进程，只记录错误
process.on('uncaughtException', (error) => {
  console.error('⚠️ 未捕获的异常 (继续运行):', error.message);
  console.log('🔄 机器人继续运行...');
});

process.on('unhandledRejection', (reason: any, promise) => {
  const msg = reason?.message || String(reason);
  // 🚀 核心优化：过滤掉 Promise 拒绝中的无害 TIMEOUT
  if (msg.includes('TIMEOUT') && (msg.includes('updates.js') || msg.includes('client.js'))) {
    return;
  }
  console.error('⚠️ 未处理的Promise拒绝 (继续运行):', reason);
  console.log('🔄 机器人继续运行...');
});

// 启动机器人
main();
