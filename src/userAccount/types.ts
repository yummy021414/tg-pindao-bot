// 用户账号控制相关类型定义

export interface UserAccountSession {
  id: number;
  phone: string;
  session: string;
  api_id: string;
  api_hash: string;
  nickname: string;
  is_active: boolean;
  created_at: string;
  last_used_at?: string;
}

export interface AutoReplyConfig {
  account_id: number;
  is_enabled: boolean;
  reply_message: string;
  created_at: string;
  updated_at: string;
}

export interface SendMessageTask {
  account_id: number;
  target_username?: string;
  target_userid?: number;
  message: string;
  keyword?: string; // 如果是发送媒体库（保留兼容性）
  keywords?: string[]; // 多个关键词（新功能）
  target_group?: string; // 目标群组
}

export interface PendingGroupSend {
  step: 'waiting_keyword' | 'collecting' | 'waiting_group' | 'selecting_hours' | 'waiting_time_range';
  keyword?: string; // 单个关键词（保留兼容性）
  keywords?: string[]; // 多个关键词
  collectedMessages?: any[]; // 收集到的消息
  targetChannel?: string;
}

