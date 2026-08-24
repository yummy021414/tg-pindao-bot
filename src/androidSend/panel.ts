import { Context, Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { androidNoteSyncEnabled, isSuperAdmin } from '../config';
import { database } from '../database';
import { quotaLine } from './commands';
import { queueNoteSyncTasksForItems, summarizeSyncableItems } from './noteSync';

const ACTION_LABELS: Record<number, string> = { 1: '📝 笔记', 2: '🖼 展示', 3: '📍 位置', 4: '🔥 三连' };
const KEYWORDS_PER_PAGE = 8;

/**
 * Android 控制台：把原本的纯文本命令（/send、/mappings、/sendtasks 等）
 * 收进一块内联按钮面板。所有回调都走 as: 前缀，由 handleCallback 统一分发。
 * 选人/选内容用列表下标做回调参数（callback_data 上限 64 字节，中文关键词直接放会超）；
 * 下标在最终一步会重新解析成名字回显，映射列表极少变动，错位风险可以接受。
 */
export class AndroidPanel {
  static async open(ctx: Context): Promise<void> {
    await this.renderMenu(ctx);
  }

  static async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    try {
      await ctx.answerCbQuery();
    } catch {
      // 回调过期时 answerCbQuery 会报错，不影响后续渲染。
    }

    try {
      if (data === 'as:menu') return await this.renderMenu(ctx);
      if (data === 'as:maps') return await this.renderMappings(ctx);
      if (data === 'as:tasks') return await this.renderTasks(ctx);
      if (data === 'as:set') return await this.renderSettings(ctx);
      if (data === 'as:set:autosync') return await this.toggleAutoSync(ctx);
      if (data === 'as:close') {
        await ctx.deleteMessage().catch(() => undefined);
        return;
      }
      if (data === 'as:send') return await this.renderSendUsers(ctx);
      if (data.startsWith('as:send:u:')) return await this.renderSendContents(ctx, Number(data.slice(10)));
      if (data.startsWith('as:send:c:')) {
        const [userIndex, contentIndex] = data.slice(10).split(':').map(Number);
        return await this.renderSendActions(ctx, userIndex, contentIndex);
      }
      if (data.startsWith('as:send:a:')) {
        const [userIndex, contentIndex, action] = data.slice(10).split(':').map(Number);
        return await this.createSendTask(ctx, userIndex, contentIndex, action as 1 | 2 | 3 | 4);
      }
      if (data === 'as:ns' || data.startsWith('as:ns:p:')) {
        const page = data.startsWith('as:ns:p:') ? Number(data.slice(8)) : 0;
        return await this.renderNoteSyncKeywords(ctx, page);
      }
      if (data.startsWith('as:ns:k:')) return await this.renderNoteSyncConfirm(ctx, Number(data.slice(8)));
      if (data.startsWith('as:ns:go:')) return await this.queueNoteSync(ctx, Number(data.slice(9)));
      if (data.startsWith('as:lead:')) {
        // as:lead:<leadId>:<action>，leadId 里没有冒号，从末尾拆。
        const rest = data.slice(8);
        const splitAt = rest.lastIndexOf(':');
        return await this.renderLeadContentPick(ctx, rest.slice(0, splitAt), Number(rest.slice(splitAt + 1)) as 1 | 2 | 3 | 4);
      }
      if (data.startsWith('as:leadk:')) {
        // as:leadk:<leadId>:<action>:<contentIndex>
        const parts = data.slice(9).split(':');
        const contentIndex = Number(parts.pop());
        const action = Number(parts.pop()) as 1 | 2 | 3 | 4;
        return await this.createLeadTask(ctx, parts.join(':'), action, contentIndex);
      }
    } catch (error: any) {
      console.error('[Android 面板] 处理回调失败:', error?.message || error);
      await ctx.reply(`❌ 操作失败：${error?.message || '请重试'}`).catch(() => undefined);
    }
  }

  // ============ 主菜单 ============

  private static async renderMenu(ctx: Context): Promise<void> {
    const message =
      '🤖 Android 控制台\n\n' +
      '发送笔记、同步资料、查看任务都在这里点按钮完成。\n' +
      `${await quotaLine()}`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📤 发送笔记', 'as:send'), Markup.button.callback('📥 同步资料到笔记', 'as:ns')],
      [Markup.button.callback('📌 映射列表', 'as:maps'), Markup.button.callback('📋 任务队列', 'as:tasks')],
      [Markup.button.callback('⚙️ 设置', 'as:set'), Markup.button.callback('❌ 关闭', 'as:close')]
    ]);
    await this.render(ctx, message, keyboard.reply_markup);
  }

  // ============ 发送流程：选人 → 选内容 → 选动作 ============

  private static async renderSendUsers(ctx: Context): Promise<void> {
    const { users } = await database.listAndroidMappings();
    if (users.length === 0) {
      await this.render(
        ctx,
        '📤 发送笔记\n\n还没有用户映射。\n先用命令录入：\n/binduser 用户标识 | App用户名 | 备注',
        this.backKeyboard()
      );
      return;
    }
    const rows = users.map((user, index) => [
      Markup.button.callback(`👤 ${user.appUserId}｜${user.appUserName}`, `as:send:u:${index}`)
    ]);
    rows.push([Markup.button.callback('⬅️ 返回', 'as:menu')]);
    await this.render(ctx, '📤 发送笔记\n\n第 1 步：选择要发给谁。', Markup.inlineKeyboard(rows).reply_markup);
  }

  private static async renderSendContents(ctx: Context, userIndex: number): Promise<void> {
    const { users, contents } = await database.listAndroidMappings();
    const user = users[userIndex];
    if (!user) return await this.renderSendUsers(ctx);
    if (contents.length === 0) {
      await this.render(
        ctx,
        `📤 发送给 ${user.appUserName}\n\n还没有内容映射。\n先用命令录入：\n/bindcontent 内容ID | TG关键词 | App内容标识`,
        this.backKeyboard('as:send')
      );
      return;
    }
    const rows = contents.map((content, index) => [
      Markup.button.callback(`📄 ${content.tgKeyword}｜${content.appContentIdentifier}`, `as:send:c:${userIndex}:${index}`)
    ]);
    rows.push([Markup.button.callback('⬅️ 返回', 'as:send')]);
    await this.render(
      ctx,
      `📤 发送给 ${user.appUserName}\n\n第 2 步：选择发送哪条内容。`,
      Markup.inlineKeyboard(rows).reply_markup
    );
  }

  private static async renderSendActions(ctx: Context, userIndex: number, contentIndex: number): Promise<void> {
    const { users, contents } = await database.listAndroidMappings();
    const user = users[userIndex];
    const content = contents[contentIndex];
    if (!user || !content) return await this.renderSendUsers(ctx);
    const rows = [
      [1, 2].map(action => Markup.button.callback(ACTION_LABELS[action], `as:send:a:${userIndex}:${contentIndex}:${action}`)),
      [3, 4].map(action => Markup.button.callback(ACTION_LABELS[action], `as:send:a:${userIndex}:${contentIndex}:${action}`)),
      [Markup.button.callback('⬅️ 返回', `as:send:u:${userIndex}`)]
    ];
    await this.render(
      ctx,
      `📤 发送给 ${user.appUserName}\n内容：${content.tgKeyword}（${content.appContentIdentifier}）\n\n第 3 步：选择发送形式。点了就会排队。`,
      Markup.inlineKeyboard(rows).reply_markup
    );
  }

  private static async createSendTask(ctx: Context, userIndex: number, contentIndex: number, action: 1 | 2 | 3 | 4): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const { users, contents } = await database.listAndroidMappings();
    const user = users[userIndex];
    const content = contents[contentIndex];
    if (!user || !content) return await this.renderSendUsers(ctx);
    const tasks = await database.createAndroidSendTasks(user, [content], chatId, action);
    await this.render(
      ctx,
      `✅ 任务已排队，手机执行完会单独回执。\n\n` +
        `目标：${user.appUserId}（${user.appUserName}）\n` +
        `内容：${content.tgKeyword}（${content.appContentIdentifier}）\n` +
        `形式：${ACTION_LABELS[action]}\n` +
        `任务：${tasks[0].taskId}\n\n${await quotaLine()}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📤 再发一条', 'as:send'), Markup.button.callback('📋 任务队列', 'as:tasks')],
        [Markup.button.callback('⬅️ 返回主面板', 'as:menu')]
      ]).reply_markup
    );
  }

  // ============ 同步资料到真机笔记：选关键词 → 确认 → 排队 ============

  private static async mediaScopeUserId(ctx: Context): Promise<number | undefined> {
    const userId = ctx.from?.id;
    return userId && isSuperAdmin(userId) ? undefined : userId;
  }

  private static async renderNoteSyncKeywords(ctx: Context, page: number): Promise<void> {
    if (!androidNoteSyncEnabled) {
      await this.render(
        ctx,
        '📥 同步资料到笔记\n\n❌ 未启用：需要在服务器配置 ANDROID_WORKER_TOKEN，且 ANDROID_NOTE_SYNC 不为 false。',
        this.backKeyboard()
      );
      return;
    }
    const keywords = await database.getAllKeywords(await this.mediaScopeUserId(ctx));
    if (keywords.length === 0) {
      await this.render(ctx, '📥 同步资料到笔记\n\n资料库还是空的，先上传一些资料。', this.backKeyboard());
      return;
    }
    const totalPages = Math.ceil(keywords.length / KEYWORDS_PER_PAGE);
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * KEYWORDS_PER_PAGE;
    const slice = keywords.slice(start, start + KEYWORDS_PER_PAGE);

    const rows = slice.map((keyword, offset) => [
      Markup.button.callback(`📁 ${keyword}`, `as:ns:k:${start + offset}`)
    ]);
    const nav = [];
    if (safePage > 0) nav.push(Markup.button.callback('⬅️ 上一页', `as:ns:p:${safePage - 1}`));
    if (safePage < totalPages - 1) nav.push(Markup.button.callback('➡️ 下一页', `as:ns:p:${safePage + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([Markup.button.callback('⬅️ 返回主面板', 'as:menu')]);

    await this.render(
      ctx,
      `📥 同步资料到笔记\n\n选一个人（关键词），把 TA 在机器人里的资料同步成手机 App 里的笔记。\n` +
        `第 ${safePage + 1}/${totalPages} 页，共 ${keywords.length} 个关键词。`,
      Markup.inlineKeyboard(rows).reply_markup
    );
  }

  private static async keywordByIndex(ctx: Context, index: number): Promise<string | null> {
    const keywords = await database.getAllKeywords(await this.mediaScopeUserId(ctx));
    return keywords[index] ?? null;
  }

  private static async renderNoteSyncConfirm(ctx: Context, index: number): Promise<void> {
    const keyword = await this.keywordByIndex(ctx, index);
    if (!keyword) return await this.renderNoteSyncKeywords(ctx, 0);
    const items = await database.getMediaByKeyword(keyword, await this.mediaScopeUserId(ctx));
    const { batches, files } = summarizeSyncableItems(items);
    if (files === 0) {
      await this.render(
        ctx,
        `📥 「${keyword}」没有可同步的图片/视频（其他类型的文件无法进 App 笔记）。`,
        this.backKeyboard('as:ns')
      );
      return;
    }
    await this.render(
      ctx,
      `📥 同步「${keyword}」的资料\n\n` +
        `共 ${batches} 组 / ${files} 个图片视频。\n` +
        `确认后手机会新建 ${batches} 条笔记（每组一条，含原文案），执行完逐条回执。`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ 确认同步', `as:ns:go:${index}`)],
        [Markup.button.callback('⬅️ 返回列表', 'as:ns')]
      ]).reply_markup
    );
  }

  private static async queueNoteSync(ctx: Context, index: number): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const keyword = await this.keywordByIndex(ctx, index);
    if (!keyword) return await this.renderNoteSyncKeywords(ctx, 0);
    const items = await database.getMediaByKeyword(keyword, await this.mediaScopeUserId(ctx));
    const queued = await queueNoteSyncTasksForItems(items, keyword, chatId);
    await this.render(
      ctx,
      queued > 0
        ? `✅ 已排队 ${queued} 条「${keyword}」的笔记同步任务，手机执行完会单独回执。\n\n${await quotaLine()}`
        : `❌ 「${keyword}」没有排进任何任务（可能没有图片/视频，或排队出错，详见服务器日志）。`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📥 继续同步其他人', 'as:ns'), Markup.button.callback('📋 任务队列', 'as:tasks')],
        [Markup.button.callback('⬅️ 返回主面板', 'as:menu')]
      ]).reply_markup
    );
  }

  // ============ 圈子线索卡片：点动作 → 选内容 → 排队 ============

  /** 生成圈子线索卡片下方的四个动作按钮，server.ts 推送线索时使用。 */
  static leadKeyboard(leadId: string): InlineKeyboardMarkup {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📝 发笔记', `as:lead:${leadId}:1`), Markup.button.callback('🖼 发展示', `as:lead:${leadId}:2`)],
      [Markup.button.callback('📍 发位置', `as:lead:${leadId}:3`), Markup.button.callback('🔥 发三连', `as:lead:${leadId}:4`)]
    ]).reply_markup;
  }

  private static leadHeader(lead: { appUserName: string; circleContent: string }): string {
    return `📥 圈子线索\n用户：${lead.appUserName}\n内容：${lead.circleContent}`;
  }

  private static async renderLeadContentPick(ctx: Context, leadId: string, action: 1 | 2 | 3 | 4): Promise<void> {
    const lead = await database.getAndroidCircleLead(leadId);
    if (!lead) {
      await this.render(ctx, '❌ 这条线索已不存在（可能被清理），请等待新的推送。', this.backKeyboard());
      return;
    }
    const { contents } = await database.listAndroidMappings();
    if (contents.length === 0) {
      await this.render(
        ctx,
        `${this.leadHeader(lead)}\n\n还没有内容映射，先录入：\n/bindcontent 内容ID | TG关键词 | App内容标识`,
        this.leadKeyboard(leadId)
      );
      return;
    }
    const rows = contents.map((content, index) => [
      Markup.button.callback(`📄 ${content.tgKeyword}｜${content.appContentIdentifier}`, `as:leadk:${leadId}:${action}:${index}`)
    ]);
    rows.push([Markup.button.callback('⬅️ 重选形式', `as:lead:${leadId}:0`)]);
    await this.render(
      ctx,
      `${this.leadHeader(lead)}\n\n形式：${ACTION_LABELS[action] || '待选'}\n选择要发送的内容：`,
      action >= 1 && action <= 4 ? Markup.inlineKeyboard(rows).reply_markup : this.leadKeyboard(leadId)
    );
  }

  private static async createLeadTask(ctx: Context, leadId: string, action: 1 | 2 | 3 | 4, contentIndex: number): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const lead = await database.getAndroidCircleLead(leadId);
    const { contents } = await database.listAndroidMappings();
    const content = contents[contentIndex];
    if (!lead || !content) {
      await this.render(ctx, '❌ 线索或内容映射已变动，请重新操作。', this.backKeyboard());
      return;
    }
    const tasks = await database.createAndroidSendTasksForCircleLead(leadId, [content], chatId, action);
    await this.render(
      ctx,
      `${this.leadHeader(lead)}\n\n✅ 任务已排队\n内容：${content.tgKeyword}（${content.appContentIdentifier}）\n` +
        `形式：${ACTION_LABELS[action]}\n任务：${tasks[0].taskId}\n\n${await quotaLine()}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📋 任务队列', 'as:tasks'), Markup.button.callback('🤖 控制台', 'as:menu')]
      ]).reply_markup
    );
  }

  // ============ 映射 / 任务 / 设置 ============

  private static async renderMappings(ctx: Context): Promise<void> {
    const { users, contents } = await database.listAndroidMappings();
    const userLines = users.map(item => `• ${item.appUserId} → ${item.appUserName}${item.remark ? `（${item.remark}）` : ''}`);
    const contentLines = contents.map(
      item => `• ${item.tgKeyword} → ${item.contentId}：${item.appContentIdentifier}${item.appContentPosition ? ` [${item.appContentPosition}]` : ''}`
    );
    await this.render(
      ctx,
      `📌 用户映射\n${userLines.join('\n') || '（暂无）'}\n\n` +
        `📌 内容映射\n${contentLines.join('\n') || '（暂无）'}\n\n` +
        `录入 / 修改仍用命令：\n/binduser 用户标识 | App用户名 | 备注\n/bindcontent 内容ID | TG关键词 | App内容标识`,
      this.backKeyboard()
    );
  }

  private static async renderTasks(ctx: Context): Promise<void> {
    const tasks = await database.listAndroidSendTasks(15);
    const taskLines = tasks.map(item => {
      const status = { pending: '⏳ 等待', running: '▶️ 执行中', succeeded: '✅ 成功', failed: '❌ 失败' }[item.status];
      const kind = item.kind === 'noteSync' ? '同步笔记' : ACTION_LABELS[item.action || 1];
      return `${status}｜${item.kind === 'noteSync' ? item.tgKeyword : `${item.appUserId}｜${item.tgKeyword}`}｜${kind}${item.errorMessage ? `\n  原因：${item.errorMessage}` : ''}`;
    });
    await this.render(
      ctx,
      `📋 最近任务\n${taskLines.join('\n') || '（暂无）'}\n\n${await quotaLine()}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 刷新', 'as:tasks'), Markup.button.callback('⬅️ 返回', 'as:menu')]
      ]).reply_markup
    );
  }

  private static async renderSettings(ctx: Context): Promise<void> {
    const autoSyncOn = await database.getAndroidNoteSyncOnUpload(true);
    await this.render(
      ctx,
      '⚙️ Android 设置\n\n' +
        `上传资料后自动同步成手机笔记：${autoSyncOn ? '✅ 已开启' : '⛔ 已关闭'}\n` +
        (androidNoteSyncEnabled ? '' : '（注意：服务器未配置 ANDROID_WORKER_TOKEN，同步功能整体不可用）\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback(autoSyncOn ? '⛔ 关闭自动同步' : '✅ 开启自动同步', 'as:set:autosync')],
        [Markup.button.callback('⬅️ 返回', 'as:menu')]
      ]).reply_markup
    );
  }

  private static async toggleAutoSync(ctx: Context): Promise<void> {
    const current = await database.getAndroidNoteSyncOnUpload(true);
    await database.setAndroidNoteSyncOnUpload(!current);
    await this.renderSettings(ctx);
  }

  // ============ 渲染工具 ============

  private static backKeyboard(target = 'as:menu'): InlineKeyboardMarkup {
    return Markup.inlineKeyboard([[Markup.button.callback('⬅️ 返回', target)]]).reply_markup;
  }

  /** 回调里编辑原消息，命令入口发新消息；内容没变化时 Telegram 会报错，静默吞掉。 */
  private static async render(ctx: Context, text: string, keyboard: InlineKeyboardMarkup): Promise<void> {
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard });
        return;
      } catch (error: any) {
        if (String(error?.message || '').includes('message is not modified')) return;
        // 编辑失败（消息过旧等）时退回为发新消息。
      }
    }
    await ctx.reply(text, { reply_markup: keyboard });
  }
}
