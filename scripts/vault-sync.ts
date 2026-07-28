/**
 * 老 bot 归档到金库：把还没有 source_msg_id 的资料发到 PERSISTENT_CHANNEL_ID，并写回坐标。
 *
 * 用法：
 *   npm run vault:sync
 *   npm run vault:sync -- --force
 *   npm run vault:sync -- --limit=3
 *
 * 使用 .env 里的 BOT_TOKEN（当作「老 bot」）
 */
import dotenv from 'dotenv';
dotenv.config();

import { Telegraf } from 'telegraf';
import { config } from '../src/config';
import { database } from '../src/database';
import { UploadHandler } from '../src/bot/handlers/UploadHandler';
import { MediaItem } from '../src/types';
import { getVaultCoverageStats } from '../src/services/vault';

async function startSync() {
  console.log('🚀 [金库同步/归档] 启动...');

  const persistentChannelId = config.persistentChannelId;
  if (!persistentChannelId) {
    console.error('❌ 请先在 .env 中配置 PERSISTENT_CHANNEL_ID');
    process.exit(1);
  }

  const force = process.argv.includes('--force');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

  const bot = new Telegraf(config.botToken);
  const me = await bot.telegram.getMe();
  console.log(`🤖 当前 bot: @${me.username} → 金库 ${persistentChannelId}`);

  try {
    const chat = await bot.telegram.getChat(persistentChannelId);
    console.log(`✅ 能访问金库: ${(chat as any).title || persistentChannelId}`);
  } catch (e: any) {
    console.error(`❌ 无法访问备份频道，请把当前 bot 加成管理员。${e.message}`);
    process.exit(1);
  }

  const before = await getVaultCoverageStats(database);
  console.log(`📊 归档前：共 ${before.total}，有坐标 ${before.withSource}，缺坐标 ${before.withoutSource}`);

  const allMedia = await database.getAllMedia();
  let pendingItems = force
    ? allMedia
    : allMedia.filter((m: MediaItem) => !m.source_msg_id);

  if (pendingItems.length === 0) {
    console.log('✅ 所有资料都已有永久坐标，无需同步。下一步: npm run vault:claim');
    process.exit(0);
  }

  if (limit > 0) {
    pendingItems = pendingItems.slice(0, limit);
    console.log(`🔢 仅处理 ${pendingItems.length} 条 (--limit)`);
  }

  console.log(`📊 待归档 ${pendingItems.length} 个文件${force ? ' (--force 重写坐标)' : ''}`);

  const batches: { [key: string]: MediaItem[] } = {};
  pendingItems.forEach((item: MediaItem) => {
    const bId = item.batchId || `single_${item.id}`;
    if (!batches[bId]) batches[bId] = [];
    batches[bId].push(item);
  });

  const batchIds = Object.keys(batches);
  console.log(`📦 共 ${batchIds.length} 组`);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < batchIds.length; i++) {
    const items = batches[batchIds[i]];
    const keyword = items[0].keyword;
    console.log(`[${i + 1}/${batchIds.length}] "${keyword}" (${items.length} 文件)...`);

    try {
      await UploadHandler.archiveBatchToChannel(
        bot,
        persistentChannelId,
        items,
        keyword,
        database,
        { forceSource: true }
      );
      console.log('   ✅ 已写入 source_chat_id / source_msg_id');
      ok++;
    } catch (err: any) {
      fail++;
      console.error(`   ❌ ${err.message}`);
      if (String(err.message).includes('file identifier') || String(err.message).includes('FILE_REFERENCE')) {
        console.warn('   ⚠️ 当前 Token 认不出该 file_id，需用原始 bot 重传后再归档');
      }
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  const after = await getVaultCoverageStats(database);
  console.log(`\n✨ 归档结束：成功组 ${ok}，失败组 ${fail}`);
  console.log(`📊 归档后：有坐标 ${after.withSource}，缺坐标 ${after.withoutSource}`);
  console.log('下一步（新 bot 认领）: npm run vault:claim -- --limit=5');
  process.exit(fail > 0 ? 1 : 0);
}

startSync().catch(err => {
  console.error(err);
  process.exit(1);
});
