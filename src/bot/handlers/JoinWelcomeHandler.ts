import { Context, Markup } from 'telegraf';
import { BotMode, UserSession, JoinWelcomeConfig } from '../../types';
import { database } from '../../database';

export class JoinWelcomeHandler {
  static async handleStart(ctx: Context, db: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session: UserSession = {
      userId,
      mode: BotMode.JoinWelcome,
      step: 'waiting_join_welcome_message',
      pendingJoinWelcomeData: {
        buttons: []
      }
    };

    await db.saveUserSession(userId, session);

    await ctx.editMessageText(
      '📝 设置关注/进群自动回复\n\n' +
      '请发送回复内容：\n' +
      '• 支持纯文字\n' +
      '• 支持照片+文字说明\n' +
      '• 支持视频+文字说明\n' +
      '• 直接发送即可\n\n' +
      '💡 当有人申请加入频道/进群时，机器人将自动私信发送此内容。',
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel_join_welcome')]
      ])
    );
  }

  static async handleMessage(ctx: Context, db: any, session: UserSession): Promise<void> {
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

    session.pendingJoinWelcomeData = {
      ...session.pendingJoinWelcomeData,
      messageContent: content,
      messageType,
      buttons: []
    };
    session.step = 'waiting_join_welcome_button_text';
    
    await db.saveUserSession(session.userId, session);

    await ctx.reply(
      '✅ 已收到主文案内容！\n\n' +
      '现在设置跳转按钮（第1步/共2步）：\n' +
      '请输入按钮上显示的文字：\n' +
      '(例如：点击查看详情)',
      Markup.inlineKeyboard([
        [Markup.button.callback('⏩ 跳过按钮设置（直接保存）', 'save_join_welcome_no_buttons')],
        [Markup.button.callback('❌ 取消设置', 'cancel_join_welcome')]
      ])
    );
  }

  static async handleButtonText(ctx: Context, db: any, session: UserSession): Promise<void> {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('❌ 请发送纯文字作为按钮名称。');
      return;
    }

    session.pendingJoinWelcomeData!.tempButtonText = ctx.message.text;
    session.step = 'waiting_join_welcome_button_url';
    
    await db.saveUserSession(session.userId, session);

    await ctx.reply(
      '设置跳转按钮（第2步/共2步）：\n' +
      '请输入按钮跳转的链接 (URL)：\n' +
      '(必须以 http:// 或 https:// 开头)',
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ 取消', 'cancel_join_welcome')]
      ])
    );
  }

  static async handleButtonUrl(ctx: Context, db: any, session: UserSession): Promise<void> {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('❌ 请发送有效的链接地址。');
      return;
    }

    let url = ctx.message.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('tg://')) {
        url = 'https://' + url;
    }

    // 保存新按钮
    session.pendingJoinWelcomeData!.buttons.push({
      text: session.pendingJoinWelcomeData!.tempButtonText!,
      url: url
    });
    
    // 清除临时文字
    session.pendingJoinWelcomeData!.tempButtonText = undefined;
    
    await db.saveUserSession(session.userId, session);

    await ctx.reply(
      `✅ 按钮已添加！目前共有 ${session.pendingJoinWelcomeData!.buttons.length} 个按钮。\n\n` +
      '请选择操作：',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ 继续添加按钮', 'add_more_welcome_button')],
        [Markup.button.callback('💾 保存并开启', 'confirm_save_join_welcome')],
        [Markup.button.callback('❌ 取消', 'cancel_join_welcome')]
      ])
    );
  }

  static async handleAddMoreButton(ctx: Context, db: any, session: UserSession): Promise<void> {
    session.step = 'waiting_join_welcome_button_text';
    await db.saveUserSession(session.userId, session);
    await ctx.reply('请输入下一个按钮的显示文字：');
  }

  static async handleConfirmSave(ctx: Context, db: any, session: UserSession): Promise<void> {
    const data = session.pendingJoinWelcomeData!;
    
    const config: JoinWelcomeConfig = {
      enabled: true,
      messageContent: data.messageContent,
      messageType: data.messageType!,
      buttons: data.buttons
    };

    await db.saveJoinWelcomeConfig(config);
    await db.clearUserSession(session.userId);

    await ctx.reply(
      '🎊 关注自动回复设置成功！\n\n' +
      '✅ 功能已开启\n' +
      '💡 现在只要有新成员申请加入频道或进群，机器人将自动私信该内容。',
      Markup.inlineKeyboard([
        [Markup.button.callback('🏠 返回主菜单', 'back_to_main')]
      ])
    );
  }

  static async handleCancel(ctx: Context, db: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    await db.clearUserSession(userId);
    await ctx.reply('❌ 自动回复设置已取消。');
  }
}

