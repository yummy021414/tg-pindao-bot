/**
 * 金库（永久备份频道）工具：换 Token 时靠 source_* 坐标 + 认领新 file_id。
 */
import { MediaItem } from '../types';
import { config } from '../config';
import { database } from '../database';

type Db = typeof database;

export type MediaFileType = MediaItem['file_type'];

export function extractFileFromMessage(
  msg: any
): { file_id: string; file_type: MediaFileType } | null {
  if (!msg) return null;
  if (msg.photo?.length) {
    return { file_id: msg.photo[msg.photo.length - 1].file_id, file_type: 'photo' };
  }
  if (msg.video) return { file_id: msg.video.file_id, file_type: 'video' };
  if (msg.document) return { file_id: msg.document.file_id, file_type: 'document' };
  if (msg.audio) return { file_id: msg.audio.file_id, file_type: 'audio' };
  if (msg.voice) return { file_id: msg.voice.file_id, file_type: 'voice' };
  if (msg.animation) return { file_id: msg.animation.file_id, file_type: 'animation' };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: 'video_note' };
  return null;
}

export function getClaimToChatId(): string | undefined {
  return process.env.CLAIM_TO_CHAT_ID || (config.superAdminId ? String(config.superAdminId) : undefined);
}

export function hasVaultCoords(item: Pick<MediaItem, 'source_chat_id' | 'source_msg_id'>): boolean {
  return Boolean(item.source_chat_id && item.source_msg_id);
}

export interface VaultCoverageStats {
  total: number;
  withSource: number;
  withoutSource: number;
  vaultChannelId?: string;
}

export async function getVaultCoverageStats(
  db: Db = database
): Promise<VaultCoverageStats> {
  const all = await db.getAllMedia();
  const withSource = all.filter(m => hasVaultCoords(m)).length;
  return {
    total: all.length,
    withSource,
    withoutSource: all.length - withSource,
    vaultChannelId: config.persistentChannelId
  };
}

/**
 * 从金库 forward 到认领私聊，提取当前 bot 的新 file_id 并写库。
 * 成功后尽量删除私聊里的转发，避免刷屏。
 */
export async function refreshFileIdFromVault(
  telegram: any,
  item: MediaItem,
  db: Db,
  claimToChatId?: string
): Promise<{ ok: boolean; file_id?: string; error?: string }> {
  if (!hasVaultCoords(item)) {
    return { ok: false, error: 'missing source coords' };
  }
  const claimTo = claimToChatId || getClaimToChatId();
  if (!claimTo) {
    return { ok: false, error: 'no CLAIM_TO_CHAT_ID' };
  }

  try {
    const fromChat = String(item.source_chat_id);
    const msgId = Number(item.source_msg_id);
    const fwd: any = await telegram.forwardMessage(claimTo, fromChat, msgId);
    const extracted = extractFileFromMessage(fwd);
    if (!extracted) {
      return { ok: false, error: 'no media in forwarded message' };
    }

    await db.updateMediaFileId(item.id, extracted.file_id, extracted.file_type);
    item.file_id = extracted.file_id;
    item.file_type = extracted.file_type;

    try {
      if (fwd?.message_id) {
        await telegram.deleteMessage(claimTo, fwd.message_id);
      }
    } catch {
      // 无私聊删消息权限时忽略
    }

    return { ok: true, file_id: extracted.file_id };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export interface VaultAccessResult {
  ok: boolean;
  chatId?: string;
  title?: string;
  type?: string;
  botStatus?: string;
  botUsername?: string;
  botId?: number;
  error?: string;
  hint?: string;
}

/** 启动/归档前探测：当前 Token 能否访问金库 */
export async function checkVaultAccess(telegram: any, chatId?: string): Promise<VaultAccessResult> {
  const id = chatId || config.persistentChannelId;
  if (!id) {
    return {
      ok: false,
      error: '未配置 PERSISTENT_CHANNEL_ID',
      hint: '在 .env 填写备份频道 ID，并把【当前这个】bot 加成该频道管理员'
    };
  }

  let me: any;
  try {
    me = await telegram.getMe();
  } catch (e: any) {
    return { ok: false, chatId: id, error: `getMe 失败: ${e.message}` };
  }

  try {
    const chat: any = await telegram.getChat(id);
    let botStatus = 'unknown';
    try {
      const m = await telegram.getChatMember(id, me.id);
      botStatus = m.status;
    } catch (e: any) {
      botStatus = `查询失败:${e.message}`;
    }

    const canPost = ['administrator', 'creator'].includes(botStatus);
    if (!canPost) {
      return {
        ok: false,
        chatId: id,
        title: chat.title || chat.username,
        type: chat.type,
        botStatus,
        botUsername: me.username,
        botId: me.id,
        error: `bot 在该聊天状态为 ${botStatus}，无法发备份`,
        hint: `请把 @${me.username} 加成管理员（需有发消息权限），不要加错成别的 bot`
      };
    }

    return {
      ok: true,
      chatId: id,
      title: chat.title || chat.username,
      type: chat.type,
      botStatus,
      botUsername: me.username,
      botId: me.id
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    return {
      ok: false,
      chatId: id,
      botUsername: me.username,
      botId: me.id,
      error: msg,
      hint: msg.includes('chat not found')
        ? `当前 bot @${me.username} (id=${me.id}) 访问不到 ${id}。请在该频道「管理员」里确认加的是这一个账号，加完后等几秒再试。频道 ID 与讨论群 ID 不要混用。`
        : `请检查 PERSISTENT_CHANNEL_ID 与 bot 权限`
    };
  }
}
