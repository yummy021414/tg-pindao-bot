import dotenv from 'dotenv';
import path from 'path';
import { BotConfig } from '../types';

dotenv.config();

export const config: BotConfig = {
  // 必须从 .env 读取，不要在代码里写真实 Token / ID
  botToken: process.env.BOT_TOKEN || '',
  superAdminId: parseInt(process.env.SUPER_ADMIN_ID || '0', 10),
  channelIds: (process.env.CHANNEL_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  databasePath: process.env.DATABASE_PATH || path.resolve(__dirname, '..', '..', 'data', 'bot.db'),
  persistentChannelId: process.env.PERSISTENT_CHANNEL_ID,
  persistentGroupId: process.env.PERSISTENT_GROUP_ID
};

/** 本地 Android 执行端访问队列时使用。生产环境必须配置为随机长字符串。 */
export const androidWorkerToken = process.env.ANDROID_WORKER_TOKEN || '';
export const androidTaskLeaseMs = Math.max(30_000, parseInt(process.env.ANDROID_TASK_LEASE_MS || '300000', 10) || 300000);

const positiveInt = (raw: string | undefined, fallback: number, minimum = 0): number => {
  const value = parseInt(raw || '', 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
};

/**
 * 节流保护：连续私信是第三方 App 风控最敏感的行为。
 * 两次真实发送之间取 [min,max] 的随机间隔，并限制每日发送次数（0 表示不限）。
 */
const androidSendMinIntervalMs = positiveInt(process.env.ANDROID_SEND_MIN_INTERVAL_MS, 20_000);
export const androidSendGuard = {
  minIntervalMs: androidSendMinIntervalMs,
  maxIntervalMs: Math.max(androidSendMinIntervalMs, positiveInt(process.env.ANDROID_SEND_MAX_INTERVAL_MS, 45_000)),
  dailyLimit: positiveInt(process.env.ANDROID_DAILY_SEND_LIMIT, 30)
};

/**
 * 上传资料后是否自动排队"同步到 App 笔记"。
 * 只有配了执行端 Token 的部署才会用到，所以默认跟随它开启；设 ANDROID_NOTE_SYNC=false 可单独关掉。
 */
export const androidNoteSyncEnabled =
  !!androidWorkerToken && (process.env.ANDROID_NOTE_SYNC || '').toLowerCase() !== 'false';

if (!config.botToken) {
  console.warn('⚠️ 未配置 BOT_TOKEN，请在 .env 中填写后再启动');
}

const parseIdList = (raw: string): number[] =>
  raw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => parseInt(id, 10))
    .filter(n => !Number.isNaN(n));

// 格式: "管理员ID=频道1,频道2;管理员ID=频道3"
const parseAdminChannelMap = (raw: string): Record<string, string[]> => {
  const result: Record<string, string[]> = {};
  raw
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const [adminIdRaw, channelsRaw] = part.split('=');
      const adminId = (adminIdRaw || '').trim();
      if (!adminId || !channelsRaw) return;
      const channels = channelsRaw
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
      if (channels.length > 0) {
        result[adminId] = channels;
      }
    });
  return result;
};

const parseAdminPersistentMap = (raw: string): Record<string, string> => {
  const result: Record<string, string> = {};
  raw
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const [adminIdRaw, channelIdRaw] = part.split('=');
      const adminId = (adminIdRaw || '').trim();
      const channelId = (channelIdRaw || '').trim();
      if (adminId && channelId) {
        result[adminId] = channelId;
      }
    });
  return result;
};

export const secondaryAdminIds: number[] = parseIdList(process.env.ADMIN_IDS || '');
export const adminIds: number[] = Array.from(
  new Set([config.superAdminId, ...secondaryAdminIds])
);

const adminChannelMap = parseAdminChannelMap(process.env.ADMIN_CHANNEL_MAP || '');
const adminPersistentChannelMap = parseAdminPersistentMap(process.env.ADMIN_PERSISTENT_CHANNEL_MAP || '');

export const isAdminUser = (userId: number): boolean => adminIds.includes(userId);
export const isSuperAdmin = (userId: number): boolean => userId === config.superAdminId;

export const getAdminChannelIds = (userId: number): string[] => {
  const scopedChannels = adminChannelMap[String(userId)];
  if (scopedChannels && scopedChannels.length > 0) {
    return scopedChannels;
  }
  return config.channelIds;
};

/** 是否配置了该管理员的独立频道映射（ADMIN_CHANNEL_MAP） */
export const hasAdminChannelMap = (userId: number): boolean => {
  const scoped = adminChannelMap[String(userId)];
  return Boolean(scoped && scoped.length > 0);
};

export const getAdminPersistentChannelId = (userId: number): string | undefined =>
  adminPersistentChannelMap[String(userId)] || config.persistentChannelId;

// 授权用户列表：来自环境变量 AUTHORIZED_USERS（逗号分隔），并且自动包含超级管理员
const envAuthorized = parseIdList(process.env.AUTHORIZED_USERS || '');

export const authorizedUsers: number[] = Array.from(
  new Set([...adminIds, ...envAuthorized])
);

// Telegram 公共 API 凭证（用于用户账号登录）
// 这些是 Telethon/GramJS 官方提供的测试凭证，完全可以使用
export const DEFAULT_API_CREDENTIALS = {
  API_ID: '6',
  API_HASH: 'eb06d4abfb49dc3eeb1aeb98ae0f581e'
};

export const BOT_COMMANDS = {
  START: 'start',
  SEARCH: 'search',
  UPLOAD: 'upload',
  PUBLISH: 'publish',
  HELP: 'help',
  ADMIN: 'admin'
} as const;

export const BUTTONS = {
  // 核心功能键盘按钮 (普通用户可见)
  SEARCH_DATA: '🔍 搜索资料',
  UPLOAD_DATA: '📁 上传资料',
  VIEW_KEYWORDS: '🗂️ 查看关键词',
  CHAT_WITH_ADMIN: '💬 联系管理员',
  HELP: 'ℹ️ 帮助',
  
  // 管理员功能键盘按钮
  PUBLISH_CONTENT: '🚀 发布内容',
  VIEW_DATA: '📄 查看资料',
  CHANNEL_MANAGE: '🏢 频道管理',
  BUTTON_MAKER: '🔘 按钮制作',
  PERMISSION_MANAGE: '🔐 权限管理',
  BROADCAST_MESSAGE: '📢 群发消息',
  KEYWORD_OPTIMIZE: '🔧 关键词优化',
  APPROVAL: '📝 申请审批',
  
  // 权限管理按钮
  GRANT_MONTHLY: '📅 授权1个月',
  GRANT_QUARTERLY: '📅 授权3个月',
  REVOKE_PERMISSION: '🚫 撤销权限',
  VIEW_PERMISSIONS: '📋 查看权限',
  
  // 内联按钮
  BACK_TO_MAIN: '⬅️ 返回主菜单',
  CANCEL: '❌ 取消',
  CONFIRM: '✅ 确认',
  SAVE_ONLY: '💾 仅保存',
  SAVE_AND_PUBLISH: '💾📢 保存并发布'
} as const;
