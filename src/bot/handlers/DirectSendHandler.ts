import { Context, Markup } from 'telegraf';
import { BotMode, UserSession } from '../../types';
import { database } from '../../database';

export class DirectSendHandler {
  static async handleStart(ctx: Context, db: typeof database): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session: UserSession = {
      userId,
      mode: BotMode.SendDataToUser,
      step: 'waiting_direct_send_target'
    };

    await db.saveUserSession(userId, session);

    await ctx.editMessageText(
      '📤 定向投送与私聊模式\n\n' +
      '请输入目标用户的 **User ID** 或 **用户名**：\n' +
      '• ID：例如 `123456789`\n' +
      '• 用户名：例如 `@username`\n\n' +
      '💡 锁定后，您可以：\n' +
      '1. 发送关键词 -> 投送库内资料\n' +
      '2. 发送普通文字/图片/视频 -> 直接私信给对方',
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel_direct_send')]
      ])
    );
  }

  static async handleTargetInput(ctx: Context, db: typeof database, session: UserSession): Promise<void> {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (!text) return;

    let targetUserId: number | undefined;
    let targetDisplay = text;

    try {
      if (text.startsWith('@')) {
        const username = text.substring(1);
        const users = await db.getAllActiveUsers();
        const foundUser = users.find(u => u.username?.toLowerCase() === username.toLowerCase());
        if (foundUser) {
          targetUserId = foundUser.id;
          targetDisplay = `${foundUser.first_name || ''} (@${foundUser.username})`.trim();
        } else {
          await ctx.reply('❌ 无法找到该用户名对应的用户。请确保该用户已经与机器人开启过对话。');
          return;
        }
      } else if (/^\d+$/.test(text)) {
        targetUserId = parseInt(text);
        const users = await db.getAllActiveUsers();
        const foundUser = users.find(u => u.id === targetUserId);
        if (foundUser) {
          targetDisplay = `${foundUser.first_name || ''} (ID: ${foundUser.id})`.trim();
        }
      }

      if (!targetUserId) {
        await ctx.reply('❌ 无法找到该用户。请确保该用户已经与机器人开启过对话。');
        return;
      }

      session.targetUserId = targetUserId;
      session.targetUserDisplay = targetDisplay;
      session.step = 'waiting_keyword';
      
      await db.saveUserSession(session.userId, session);

      await ctx.reply(
        `✅ 已锁定目标用户：**${targetDisplay}**\n\n` +
        `🚀 **现在您可以直接发送内容了：**\n\n` +
        `• **发关键词**：自动搜索并投送库内资料\n` +
        `• **发文字/图片/视频**：直接作为私信转发给对方\n\n` +
        `💡 资料投送逻辑：优先尝试作为关键词搜索，若库内无匹配项，则作为普通文字私信发送。`,
        Markup.inlineKeyboard([
          [Markup.button.callback('❌ 结束投送与会话', 'cancel_direct_send')]
        ])
      );

    } catch (error) {
      console.error('处理定向发送目标输入错误:', error);
      await ctx.reply('❌ 处理输入时发生错误。');
    }
  }

  static async handleInput(ctx: Context, db: typeof database, session: UserSession, bot: any): Promise<void> {
    if (!session.targetUserId) return;

    // 处理媒体文件
    const message = ctx.message as any;
    if (message.photo || message.video || message.document || message.audio || message.voice || message.sticker) {
        await DirectSendHandler.forwardMediaToUser(ctx, session.targetUserId);
        await ctx.reply(`✅ 媒体文件已转发给 ${session.targetUserDisplay}`);
        return;
    }

    // 处理文字输入
    const text = message.text;
    if (!text) return;

    try {
      // 1. 尝试作为关键词搜索
      const mediaItems = await db.searchMedia(text, undefined, 1000);
      
      if (mediaItems.length > 0) {
        await ctx.reply(`🔍 发现关键词 "${text}" 的资料，正在向 ${session.targetUserDisplay} 投送...`);
        await DirectSendHandler.sendMediaItemsToUser(bot, session.targetUserId, mediaItems);
        await ctx.reply(`✅ 库内资料投送成功！`);
      } else {
        // 2. 库内无匹配，作为普通文字消息发送
        await bot.telegram.sendMessage(session.targetUserId, text);
        await ctx.reply(`💬 库内无匹配资料，已作为普通文字私信发送给 ${session.targetUserDisplay}`);
      }

    } catch (error: any) {
      console.error('投送/私信错误:', error);
      await ctx.reply(`❌ 发送失败: ${error?.message || '未知错误'}`);
    }
  }

  private static async forwardMediaToUser(ctx: Context, targetId: number): Promise<void> {
    const message = ctx.message as any;
    const caption = message.caption || '';

    if (message.photo) {
        await ctx.telegram.sendPhoto(targetId, message.photo[message.photo.length - 1].file_id, { caption });
    } else if (message.video) {
        await ctx.telegram.sendVideo(targetId, message.video.file_id, { caption });
    } else if (message.document) {
        await ctx.telegram.sendDocument(targetId, message.document.file_id, { caption });
    } else if (message.audio) {
        await ctx.telegram.sendAudio(targetId, message.audio.file_id, { caption });
    } else if (message.voice) {
        await ctx.telegram.sendVoice(targetId, message.voice.file_id, { caption });
    } else if (message.sticker) {
        await ctx.telegram.sendSticker(targetId, message.sticker.file_id);
    }
  }

  private static async sendMediaItemsToUser(bot: any, targetId: number, mediaItems: any[]): Promise<void> {
    const mainCaptionMedia = mediaItems.find(item => item.caption && item.caption.trim().length > 0);
    const mainCaption = mainCaptionMedia ? mainCaptionMedia.caption : '';

    const photoItems = mediaItems.filter(item => item.file_type === 'photo');
    const videoItems = mediaItems.filter(item => item.file_type === 'video');
    const documentItems = mediaItems.filter(item => item.file_type === 'document');
    const audioItems = mediaItems.filter(item => item.file_type === 'audio');
    const voiceItems = mediaItems.filter(item => item.file_type === 'voice');

    const visualMedia = [...photoItems, ...videoItems];
    if (visualMedia.length > 0) {
      const chunks = DirectSendHandler.chunkArray(visualMedia, 10);
      for (let i = 0; i < chunks.length; i++) {
        const mediaGroup = chunks[i].map((item, index) => ({
          type: item.file_type as any,
          media: item.file_id,
          caption: (i === 0 && index === 0 && mainCaption) ? mainCaption : undefined
        }));
        await bot.telegram.sendMediaGroup(targetId, mediaGroup);
        if (i < chunks.length - 1) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (documentItems.length > 0) {
      const chunks = DirectSendHandler.chunkArray(documentItems, 10);
      for (const chunk of chunks) {
        const mediaGroup = chunk.map((item) => ({ type: 'document' as const, media: item.file_id }));
        await bot.telegram.sendMediaGroup(targetId, mediaGroup);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const others = [...audioItems, ...voiceItems];
    for (const item of others) {
      if (item.file_type === 'audio') {
        await bot.telegram.sendAudio(targetId, item.file_id, { caption: item.caption });
      } else {
        await bot.telegram.sendVoice(targetId, item.file_id, { caption: item.caption });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
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
