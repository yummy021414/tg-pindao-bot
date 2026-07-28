/**
 * 新 bot 认领金库资料：用 NEW_BOT_TOKEN 从备份频道 forwardMessage，
 * 拿到新 file_id 写回数据库。
 *
 * 用法：
 *   npm run vault:claim
 *   npm run vault:claim -- --dry-run
 *   npm run vault:claim -- --limit=5
 *   npm run vault:claim -- --keep-forwards   # 不删除认领私聊里的转发
 *
 * 前置：
 *   1. .env 配好 NEW_BOT_TOKEN、PERSISTENT_CHANNEL_ID、CLAIM_TO_CHAT_ID
 *   2. 新 bot 已是备份频道管理员
 *   3. 你已私聊新 bot /start
 *   4. 库里媒体已有 source_*（先 npm run vault:sync）
 */
import dotenv from 'dotenv';
dotenv.config();

import { Telegraf } from 'telegraf';
import { database } from '../src/database';
import {
  extractFileFromMessage,
  getClaimToChatId,
  getVaultCoverageStats,
  hasVaultCoords
} from '../src/services/vault';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const keepForwards = process.argv.includes('--keep-forwards');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

  const newToken = process.env.NEW_BOT_TOKEN || process.env.CLAIM_BOT_TOKEN;
  const claimTo = getClaimToChatId();
  const vaultId = process.env.PERSISTENT_CHANNEL_ID;

  if (!newToken) {
    console.error('❌ 请在 .env 配置 NEW_BOT_TOKEN（新临时机器人 Token）');
    process.exit(1);
  }
  if (!claimTo) {
    console.error('❌ 请在 .env 配置 CLAIM_TO_CHAT_ID（你的 Telegram 数字 ID，需先私聊新 bot /start）');
    process.exit(1);
  }
  if (!vaultId) {
    console.error('❌ 请在 .env 配置 PERSISTENT_CHANNEL_ID（备份频道）');
    process.exit(1);
  }

  console.log('🚀 [金库认领] 启动');
  console.log(`   金库频道: ${vaultId}`);
  console.log(`   认领目标私聊: ${claimTo}`);
  console.log(`   dry-run: ${dryRun}`);

  const bot = new Telegraf(newToken);
  const me = await bot.telegram.getMe();
  console.log(`🤖 新 bot: @${me.username} (id=${me.id})`);

  try {
    const chat = await bot.telegram.getChat(vaultId);
    console.log(`✅ 能访问金库: ${(chat as any).title || vaultId}`);
  } catch (e: any) {
    console.error(`❌ 新 bot 无法访问备份频道，请把新 bot 加成频道管理员。错误: ${e.message}`);
    process.exit(1);
  }

  const coverage = await getVaultCoverageStats(database);
  console.log(`📊 库内 ${coverage.total} 条；有永久坐标 ${coverage.withSource}；缺坐标 ${coverage.withoutSource}`);
  if (coverage.withoutSource > 0) {
    console.warn('⚠️ 缺坐标的请先用老 bot 跑: npm run vault:sync');
  }

  let pending = (await database.getAllMedia()).filter(m => hasVaultCoords(m));
  if (pending.length === 0) {
    console.log('没有可认领的条目，退出。');
    if (coverage.total === 0) {
      console.log('');
      console.log('💡 库里媒体是 0，常见原因：');
      console.log('   1. 刚清空数据库后没有【重启】bot，上传只进了频道、库没落盘');
      console.log('   2. 上传用的是别的机器/容器上的 bot，和本机 data/bot.json 不是同一份库');
      console.log('正确顺序：重启 bot → 上传并仅保存 → npm run vault:status（有坐标）→ npm run vault:claim');
    } else {
      console.log('💡 库里有媒体但没有 source 坐标，请先: npm run vault:sync');
    }
    process.exit(0);
  }

  if (limit > 0) {
    pending = pending.slice(0, limit);
    console.log(`🔢 仅处理前 ${pending.length} 条 (--limit=${limit})`);
  }

  let ok = 0;
  let fail = 0;
  const pendingUpdates: Array<{ id: number; fileId: string; fileType?: any }> = [];

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const fromChat = String(item.source_chat_id);
    const msgId = Number(item.source_msg_id);
    process.stdout.write(`[${i + 1}/${pending.length}] id=${item.id} kw="${item.keyword}" msg=${msgId} ... `);

    if (dryRun) {
      console.log('DRY');
      ok++;
      continue;
    }

    try {
      const fwd: any = await bot.telegram.forwardMessage(claimTo, fromChat, msgId);
      const extracted = extractFileFromMessage(fwd);
      if (!extracted) {
        console.log('❌ 无法从消息提取 file_id（可能是纯文字）');
        fail++;
        continue;
      }

      pendingUpdates.push({
        id: item.id,
        fileId: extracted.file_id,
        fileType: extracted.file_type
      });
      console.log(`✅ ${extracted.file_type}`);
      ok++;

      if (!keepForwards && fwd?.message_id) {
        try {
          await bot.telegram.deleteMessage(claimTo, fwd.message_id);
        } catch {
          // ignore
        }
      }

      await new Promise(r => setTimeout(r, 800));
    } catch (e: any) {
      console.log(`❌ ${e.message}`);
      fail++;
      const msg = String(e.message || '');
      if (msg.includes('chat not found') || msg.includes('blocked') || msg.includes("can't initiate")) {
        console.error('💡 请先用你的账号私聊新 bot 发送 /start');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (!dryRun && pendingUpdates.length > 0) {
    const n = await database.batchUpdateMediaFileIds(pendingUpdates);
    console.log(`💾 已批量写入 ${n} 条新 file_id`);
  }

  console.log(`\n✨ 认领结束：成功 ${ok}，失败 ${fail}`);
  if (!dryRun && ok > 0) {
    console.log('下一步：把 .env 的 BOT_TOKEN 换成 NEW_BOT_TOKEN，本地 npm run dev 验证搜索/发送。');
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
