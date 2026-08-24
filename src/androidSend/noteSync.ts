import { androidNoteSyncEnabled } from '../config';
import { database } from '../database';
import { MediaItem } from '../types';

/**
 * 把一批媒体记录排成 App 笔记同步任务。
 * 一组资料（同一 batchId）对应 App 里的一条笔记，所以按批次分别排队。
 * 上传后的自动同步和面板里的手动同步共用这一份逻辑。
 * 排队失败不影响调用方的主流程，吞掉异常只记日志。
 */
export async function queueNoteSyncTasksForItems(
  items: MediaItem[],
  keyword: string,
  chatId: number | undefined
): Promise<number> {
  if (!androidNoteSyncEnabled || !chatId) return 0;

  const groups = new Map<string, MediaItem[]>();
  for (const item of items) {
    const key = item.batchId || 'default';
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  let queued = 0;
  for (const groupItems of groups.values()) {
    const files = groupItems
      .filter(item => item.file_type === 'photo' || item.file_type === 'video')
      .map(item => ({ fileId: item.file_id, fileType: item.file_type as 'photo' | 'video' }));
    if (!files.length) continue;
    const caption = groupItems.find(item => item.caption?.trim())?.caption?.trim();
    try {
      await database.createAndroidNoteSyncTask({ tgKeyword: keyword, caption, files }, chatId);
      queued++;
    } catch (error: any) {
      console.error('[Android 同步] 排队笔记任务失败:', error?.message || error);
    }
  }
  return queued;
}

/** 统计某关键词下可同步的内容：多少组（=多少条笔记）、多少个图片/视频文件。 */
export function summarizeSyncableItems(items: MediaItem[]): { batches: number; files: number } {
  const batchIds = new Set<string>();
  let files = 0;
  for (const item of items) {
    if (item.file_type !== 'photo' && item.file_type !== 'video') continue;
    files++;
    batchIds.add(item.batchId || 'default');
  }
  return { batches: batchIds.size, files };
}

/** 资料库里解析关键词：精确匹配，其次忽略大小写。 */
export async function resolveLibraryKeyword(input: string, scopeUserId?: number): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const exact = await database.getMediaByKeyword(trimmed, scopeUserId);
  if (exact.length) return trimmed;
  const keywords = await database.getAllKeywords(scopeUserId);
  return keywords.find(item => item === trimmed)
    || keywords.find(item => item.toLowerCase() === trimmed.toLowerCase())
    || null;
}

export async function queueNoteSyncForKeyword(
  input: string,
  chatId: number,
  scopeUserId?: number
): Promise<{ ok: true; keyword: string; queued: number; batches: number; files: number } | { ok: false; error: string }> {
  const keyword = await resolveLibraryKeyword(input, scopeUserId);
  if (!keyword) {
    return { ok: false, error: `资料库没有关键词「${input.trim()}」。把资料上传到机器人后，再发：同步 ${input.trim()}` };
  }
  const items = await database.getMediaByKeyword(keyword, scopeUserId);
  const summary = summarizeSyncableItems(items);
  if (summary.files === 0) {
    return { ok: false, error: `「${keyword}」没有可同步的图片/视频。` };
  }
  const queued = await queueNoteSyncTasksForItems(items, keyword, chatId);
  if (queued <= 0) {
    return { ok: false, error: `「${keyword}」排队失败，请看服务器日志。` };
  }
  return { ok: true, keyword, queued, ...summary };
}
