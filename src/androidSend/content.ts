import { database } from '../database';
import { AndroidAppContent } from '../database/json-database';

/**
 * 发送时用资料库关键词定位 App 笔记，不必再维护一份通讯录/内容映射。
 * 若管理员曾经手动 /bindcontent，仍优先用那条映射（App 里标题和关键词不一致时）。
 */
export async function resolveContentForKeyword(
  keyword: string,
  scopeUserId?: number
): Promise<AndroidAppContent | null> {
  const trimmed = keyword.trim();
  if (!trimmed) return null;

  const mapped = await database.getAndroidAppContentByKeyword(trimmed);
  if (mapped) return mapped;

  const items = await database.getMediaByKeyword(trimmed, scopeUserId);
  if (!items.length) return null;

  const caption = items.find(item => item.caption?.trim())?.caption?.trim().replace(/\s+/g, ' ') || '';
  const now = new Date().toISOString();
  return {
    contentId: `lib:${trimmed}`,
    tgKeyword: trimmed,
    appContentIdentifier: trimmed,
    appContentPosition: caption ? caption.slice(0, 24) : undefined,
    createdAt: now,
    updatedAt: now
  };
}
