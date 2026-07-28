import { Context, Markup } from 'telegraf';
import { BotMode, UserSession } from '../../types';
import { database } from '../../database';

export class BroadcastDataHandler {
  static async handleStart(ctx: Context, db: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session: UserSession = {
      userId,
      mode: BotMode.BroadcastData,
      step: 'waiting_keyword'
    };

    await db.saveUserSession(userId, session);

    const text = '📦 **全员资料群发模式**\n\n' +
                 '请输入要群发的 **关键词**：\n\n' +
                 '💡 开启后，您可以：\n' +
                 '1. 发送关键词 -> 机器人自动搜索库内资料\n' +
                 '2. 确认后 -> 资料将分批投送给所有活跃用户\n\n' +
                 '⚠️ 注意：大批量群发可能需要较长时间，请勿重复操作。';

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'cancel_broadcast')]])
      });
    } else {
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'cancel_broadcast')]])
      });
    }
  }

  static async handleInput(ctx: Context, db: any, session: UserSession, bot: any): Promise<void> {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (!text) return;

    try {
      // 1. 尝试作为关键词搜索
      const mediaItems = await db.getMediaByKeyword(text);
      
      if (mediaItems.length > 0) {
        const userCount = await db.getUserCount();
        await ctx.reply(
          `🔍 发现关键词 "${text}" 的资料共 ${mediaItems.length} 个文件。\n\n` +
          `📊 目标用户总数: ${userCount}\n` +
          `⚠️ 确认要群发给所有用户吗？`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ 确认并开始群发', `confirm_broadcast_data_${text}`)],
            [Markup.button.callback('❌ 取消', 'cancel_broadcast')]
          ])
        );
      } else {
        await ctx.reply(`❌ 库内未找到关键词 "${text}" 的资料，请重新输入：`);
      }

    } catch (error: any) {
      console.error('群发资料搜索错误:', error);
      await ctx.reply(`❌ 搜索失败: ${error?.message || '未知错误'}`);
    }
  }

  static async executeBroadcast(ctx: Context, db: any, bot: any, keyword: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery('🚀 正在启动群发任务...');
    await ctx.editMessageText(`🚀 正在向所有用户群发关键词 "${keyword}" 的资料...`);

    try {
      const mediaItems = await db.getMediaByKeyword(keyword);
      const users = await db.getAllActiveUsers();
      
      if (users.length === 0) {
        await ctx.reply('❌ 没有找到活跃用户。');
        return;
      }

      let successCount = 0;
      let failCount = 0;

      // 为管理员提供一个实时进度的通知消息
      const progressMsg = await ctx.reply(`⏳ 群发进度: 0/${users.length}`);

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        try {
          // 排除管理员自己
          if (user.id === userId) {
            successCount++;
            continue;
          }

          await this.sendMediaItemsToUser(bot, user.id, mediaItems);
          successCount++;
          
          // 每 5 个人更新一次进度，避免频繁编辑
          if (successCount % 5 === 0) {
            await ctx.telegram.editMessageText(ctx.chat!.id, progressMsg.message_id, undefined, 
              `⏳ 群发进度: ${successCount}/${users.length}`
            ).catch(() => {});
          }

          // 避免频率限制，每发一个人延迟 1 秒
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          failCount++;
          console.error(`群发资料失败 - 用户 ${user.id}:`, error);
        }
      }

      await ctx.reply(
        `✅ 群发任务完成！\n\n` +
        `关键词: "${keyword}"\n` +
        `✅ 成功: ${successCount} 人\n` +
        `❌ 失败: ${failCount} 人\n` +
        `📊 总计: ${users.length} 人`
      );

      // 清理会话
      await db.clearUserSession(userId);

    } catch (error: any) {
      console.error('执行群发资料错误:', error);
      await ctx.reply(`❌ 群发失败: ${error.message}`);
    }
  }

  private static async sendMediaItemsToUser(bot: any, targetId: number, mediaItems: any[]): Promise<void> {
    // 按批次分组（保持隔离）
    const batches: { [key: string]: any[] } = {};
    mediaItems.forEach(item => {
      const bId = item.batchId || 'legacy';
      if (!batches[bId]) batches[bId] = [];
      batches[bId].push(item);
    });

    const batchIds = Object.keys(batches);

    for (const bId of batchIds) {
      const batch = batches[bId];
      const mainCaptionMedia = batch.find(item => item.caption && item.caption.trim().length > 0);
      const mainCaption = mainCaptionMedia ? mainCaptionMedia.caption : '';

      const photoItems = batch.filter(item => item.file_type === 'photo');
      const videoItems = batch.filter(item => item.file_type === 'video');
      const animationItems = batch.filter(item => item.file_type === 'animation');
      const documentItems = batch.filter(item => item.file_type === 'document');
      const audioItems = batch.filter(item => item.file_type === 'audio');

      // 1. 发送视觉组 (图/视/动)
      const visualMedia = [...photoItems, ...videoItems, ...animationItems];
      if (visualMedia.length > 0) {
        const chunks = this.chunkArray(visualMedia, 10);
        for (let i = 0; i < chunks.length; i++) {
          const mediaGroup = chunks[i].map((item, index) => ({
            type: (item.file_type === 'animation' ? 'video' : item.file_type) as any,
            media: item.file_id,
            caption: (i === 0 && index === 0 && mainCaption) ? mainCaption : undefined
          }));
          await bot.telegram.sendMediaGroup(targetId, mediaGroup);
          if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1500));
        }
      }

      // 2. 发送文档组
      if (documentItems.length > 0) {
        const chunks = this.chunkArray(documentItems, 10);
        for (const chunk of chunks) {
          const mediaGroup = chunk.map(item => ({ type: 'document' as const, media: item.file_id }));
          await bot.telegram.sendMediaGroup(targetId, mediaGroup);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // 3. 语音和其他单独发送
      const others = batch.filter(item => item.file_type === 'voice' || item.file_type === 'video_note' || item.file_type === 'audio');
      for (const item of others) {
        if (item.file_type === 'voice') await bot.telegram.sendVoice(targetId, item.file_id);
        else if (item.file_type === 'video_note') await bot.telegram.sendVideoNote(targetId, item.file_id);
        else if (item.file_type === 'audio') await bot.telegram.sendAudio(targetId, item.file_id);
        await new Promise(r => setTimeout(r, 800));
      }
      
      // 批次间延迟
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  private static chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}






