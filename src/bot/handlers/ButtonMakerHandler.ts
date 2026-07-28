import { Context, Markup } from 'telegraf';
import { BotMode, UserSession } from '../../types';
import { BUTTONS, config } from '../../config';
import { database } from '../../database';

export class ButtonMakerHandler {
  static async handleStart(ctx: Context, database: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session: UserSession = {
      userId,
      mode: BotMode.ButtonMaker,
      step: 'waiting_message',
      pendingButtonData: {
        buttons: []
      }
    };

    await database.saveUserSession(userId, session);

    const user = ctx.from!;
    const userDisplay = `${user.first_name || ''}${user.username ? ` (@${user.username})` : ''}`;
    console.log(`🔘 [按钮制作] ${userDisplay} (ID: ${userId}) -> 启动制作流程`);

    await ctx.reply(
      '🔘 按钮制作 - 第1步\n\n' +
      '请发送文案内容：\n' +
      '• 支持纯文字\n' +
      '• 支持照片+文字说明\n' +
      '• 支持视频+文字说明\n' +
      '• 直接发送即可',
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel_button_maker')]
      ])
    );
  }

  static async handleMessage(ctx: Context, database: any, session: UserSession): Promise<void> {
    if (!ctx.message) return;
    if ('text' in ctx.message && ctx.message.text.startsWith('/')) return;

    const message = ctx.message as any;
    const messageType = 
      message.photo ? 'photo' :
      message.video ? 'video' :
      message.text ? 'text' : null;

    if (!messageType) {
      await ctx.reply('❌ 不支持的消息类型，请发送文字、照片或视频。');
      return;
    }

    const content: any = {};
    if (messageType === 'text') {
      content.text = message.text;
    } else if (messageType === 'photo') {
      content.file_id = message.photo[message.photo.length - 1].file_id;
      content.caption = message.caption;
    } else if (messageType === 'video') {
      content.file_id = message.video.file_id;
      content.caption = message.caption;
    }

    session.pendingButtonData = {
      ...session.pendingButtonData,
      messageContent: content,
      messageType,
      buttons: []
    };
    session.step = 'waiting_button_text';
    
    await database.saveUserSession(session.userId, session);

    await ctx.reply(
      '🔘 按钮制作 - 第2步\n\n' +
      '请发送按钮上显示的文字：\n' +
      '(例如：点击查看详情)',
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel_button_maker')]
      ])
    );
  }

  static async handleButtonText(ctx: Context, database: any, session: UserSession): Promise<void> {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('❌ 请发送纯文字作为按钮名称。');
      return;
    }

    session.pendingButtonData!.tempButtonText = ctx.message.text;
    session.step = 'waiting_button_url';
    
    await database.saveUserSession(session.userId, session);

    await ctx.reply(
      '🔘 按钮制作 - 第3步\n\n' +
      '请发送按钮跳转的链接 (URL)：\n' +
      '(必须以 http:// 或 https:// 开头)',
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel_button_maker')]
      ])
    );
  }

  static async handleButtonUrl(ctx: Context, database: any, session: UserSession): Promise<void> {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('❌ 请发送有效的链接地址。');
      return;
    }

    let url = ctx.message.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('tg://')) {
        url = 'https://' + url;
    }

    // 保存新按钮
    session.pendingButtonData!.buttons.push({
      text: session.pendingButtonData!.tempButtonText!,
      url: url
    });
    
    // 清除临时文字
    session.pendingButtonData!.tempButtonText = undefined;
    
    await database.saveUserSession(session.userId, session);

    console.log(`🔘 [按钮制作] (ID: ${session.userId}) -> 已添加按钮: "${session.pendingButtonData!.buttons[session.pendingButtonData!.buttons.length-1].text}" (共${session.pendingButtonData!.buttons.length}个)`);

    await ctx.reply(
      `✅ 按钮已添加！目前共有 ${session.pendingButtonData!.buttons.length} 个按钮。\n\n` +
      '请选择操作：',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ 继续添加按钮', 'add_more_button')],
        [Markup.button.callback('✅ 预览并完成', 'preview_button_maker')],
        [Markup.button.callback('❌ 取消', 'cancel_button_maker')]
      ])
    );
  }

  static async handleAddMoreButton(ctx: Context, database: any, session: UserSession): Promise<void> {
    session.step = 'waiting_button_text';
    await database.saveUserSession(session.userId, session);
    await ctx.editMessageText('请输入下一个按钮的显示文字：');
  }

  static async handlePreview(ctx: Context, database: any, session: UserSession): Promise<void> {
    const userId = ctx.from?.id;
    const isAdmin = userId === config.superAdminId;
    const data = session.pendingButtonData!;

    // 构建键盘
    const buttonRows = [];
    for (const btn of data.buttons) {
      buttonRows.push([Markup.button.url(btn.text, btn.url)]);
    }
    
    // 普通用户添加广告
    if (!isAdmin) {
      buttonRows.push([Markup.button.url('免费制作自己的按钮广告', 'https://t.me/faziliaobot')]);
    }
    
    const keyboard = Markup.inlineKeyboard(buttonRows);

    try {
      await ctx.reply('✅ 制作完成！预览如下：');
      if (data.messageType === 'text') {
        await ctx.reply(data.messageContent.text, keyboard);
      } else if (data.messageType === 'photo') {
        await ctx.replyWithPhoto(data.messageContent.file_id, {
          caption: data.messageContent.caption,
          ...keyboard
        });
      } else if (data.messageType === 'video') {
        await ctx.replyWithVideo(data.messageContent.file_id, {
          caption: data.messageContent.caption,
          ...keyboard
        });
      }
    } catch (e: any) {
      console.error('预览发送失败', e);
      await ctx.reply('⚠️ 预览发送失败，可能是链接格式错误。');
      return;
    }

    const actionButtons: any[] = [
      [Markup.button.callback('👤 发送给我自己', 'send_button_to_me')]
    ];
    
    if (isAdmin) {
      actionButtons.push([Markup.button.callback('📢 发送到绑定群组', 'send_button_to_group')]);
    }
    
    actionButtons.push([Markup.button.callback('❌ 放弃并退出', 'cancel_button_maker')]);
    
    await ctx.reply('请选择发送目标：', Markup.inlineKeyboard(actionButtons));
  }

  static async handleSendToMe(ctx: Context, database: any, session: UserSession): Promise<void> {
    const userId = ctx.from?.id;
    const isAdmin = userId === config.superAdminId;
    const data = session.pendingButtonData!;
    
    const buttonRows = data.buttons.map(btn => [Markup.button.url(btn.text, btn.url)]);
    if (!isAdmin) {
      buttonRows.push([Markup.button.url('免费制作自己的按钮广告', 'https://t.me/faziliaobot')]);
    }
    
    const keyboard = Markup.inlineKeyboard(buttonRows);
    await ButtonMakerHandler.sendMessage(ctx, session.userId, data, keyboard);
    await ctx.reply('✅ 已发送给您。');
    await ButtonMakerHandler.cleanup(ctx, database, session.userId);
  }

  static async handleSendToGroup(ctx: Context, database: any, session: UserSession, bot: any): Promise<void> {
    const managedChannels = await database.getManagedChannels();
    if (!managedChannels || managedChannels.length === 0) {
        await ctx.reply('❌ 未配置任何频道/群组。');
        return;
    }

    // 只有管理员可以发送到群组
    const userId = ctx.from?.id;
    const isAdmin = userId === config.superAdminId;
    if (!isAdmin) return;

    // 显示频道选择键盘
    const buttons = await Promise.all(managedChannels.map(async (channelId: string) => {
        const name = await ButtonMakerHandler.getChannelName(bot, channelId);
        return [Markup.button.callback(name, `bm_send_to_${channelId}`)];
    }));
    
    buttons.push([Markup.button.callback('🔙 返回', 'preview_button_maker')]);

    await ctx.editMessageText('请选择要发送到的频道/群组：', Markup.inlineKeyboard(buttons));
  }

  static async handleGroupSelection(ctx: Context, database: any, session: UserSession, channelId: string): Promise<void> {
    const userId = ctx.from?.id;
    const isAdmin = userId === config.superAdminId;
    if (!isAdmin) return;

    const data = session.pendingButtonData!;
    const buttonRows = data.buttons.map(btn => [Markup.button.url(btn.text, btn.url)]);
    if (!isAdmin) {
      buttonRows.push([Markup.button.url('免费制作自己的按钮广告', 'https://t.me/faziliaobot')]);
    }
    
    const keyboard = Markup.inlineKeyboard(buttonRows);

    try {
        await ButtonMakerHandler.sendMessage(ctx, channelId, data, keyboard);
        await ctx.reply(`✅ 已成功发送到频道/群组。`);
    } catch (e: any) {
        console.error('发送失败', e);
        await ctx.reply(`❌ 发送失败: ${e?.message || '未知错误'}`);
    }
    
    await ButtonMakerHandler.cleanup(ctx, database, session.userId);
  }

  private static async getChannelName(bot: any, channelId: string): Promise<string> {
    try {
      const chat = await bot.telegram.getChat(channelId);
      if ('title' in chat) {
        return chat.title;
      } else if ('first_name' in chat) {
        return chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
      }
      return `📢 频道 ${channelId}`;
    } catch (error) {
      return `📢 频道 ${channelId}`;
    }
  }

  static async handleCancel(ctx: Context, database: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    await ButtonMakerHandler.cleanup(ctx, database, userId);
    await ctx.reply('❌ 按钮制作已取消。');
  }

  private static async sendMessage(ctx: Context, targetId: number | string, data: any, keyboard: any) {
      if (data.messageType === 'text') {
          await ctx.telegram.sendMessage(targetId, data.messageContent.text, keyboard);
      } else if (data.messageType === 'photo') {
          await ctx.telegram.sendPhoto(targetId, data.messageContent.file_id, {
              caption: data.messageContent.caption,
              ...keyboard
          });
      } else if (data.messageType === 'video') {
          await ctx.telegram.sendVideo(targetId, data.messageContent.file_id, {
              caption: data.messageContent.caption,
              ...keyboard
          });
      }
  }

  private static async cleanup(ctx: Context, database: any, userId: number) {
      await database.clearUserSession(userId);
  }
}
