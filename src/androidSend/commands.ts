import { Context } from 'telegraf';
import { androidSendGuard, isSuperAdmin } from '../config';
import { database } from '../database';
import { resolveContentForKeyword } from './content';
import { queueNoteSyncForKeyword } from './noteSync';

function messageText(ctx: Context): string {
  return ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
}

function commandArguments(ctx: Context): string {
  return messageText(ctx).replace(/^\/[^\s]+(?:\s+|$)/u, '').trim();
}

function splitPipeOrWhitespace(value: string, minimum: number): string[] {
  const pipe = value.split('|').map(item => item.trim());
  if (pipe.length >= minimum && pipe.every(Boolean)) return pipe;
  return value.split(/\s+/u).filter(Boolean);
}

function lines(items: string[], empty: string): string {
  return items.length > 0 ? items.join('\n') : empty;
}

/** 把节流状态显式告诉管理员：任务排进队列不等于马上就会发出去。 */
export async function quotaLine(): Promise<string> {
  const quota = await database.getAndroidSendQuota(androidSendGuard.dailyLimit);
  const parts = [
    androidSendGuard.dailyLimit > 0
      ? `今日发送 ${quota.usedToday}/${androidSendGuard.dailyLimit}`
      : `今日发送 ${quota.usedToday}（未设上限）`,
    `等待 ${quota.pending}`,
    `执行中 ${quota.running}`
  ];
  const cooldownMs = quota.cooldownUntil ? new Date(quota.cooldownUntil).getTime() - Date.now() : 0;
  if (cooldownMs > 0) parts.push(`发送冷却 ${Math.ceil(cooldownMs / 1000)} 秒（同步笔记不受影响）`);
  if (androidSendGuard.dailyLimit > 0 && quota.remainingToday === 0) parts.push('发送已达上限，顺延到明天');
  return `📊 ${parts.join('｜')}`;
}

/** TG 命令层只创建人工映射和任务；绝不推断要发送的内容或用户。 */
export class AndroidSendCommands {
  static async handleCircleLeadReply(ctx: Context): Promise<boolean> {
    const chatId = ctx.chat?.id;
    const replyTo = ctx.message && 'reply_to_message' in ctx.message ? ctx.message.reply_to_message : undefined;
    if (!chatId || !replyTo) return false;
    const lead = await database.getAndroidCircleLeadByBotMessage(chatId, replyTo.message_id);
    if (!lead) return false;

    const parts = messageText(ctx).split(/\s+/u).filter(Boolean);
    const action = parts.length === 2 && /^[1-4]$/.test(parts[1]) ? Number(parts[1]) as 1 | 2 | 3 | 4 : null;
    if (!action) {
      await ctx.reply('这是一条圈子线索。请引用回复：关键词 1\n1=笔记，2=展示，3=位置，4=三连\n例如：上海001 1');
      return true;
    }
    const keyword = parts[0];
    const scopeUserId = ctx.from?.id && isSuperAdmin(ctx.from.id) ? undefined : ctx.from?.id;
    const content = await resolveContentForKeyword(keyword, scopeUserId);
    if (!content) {
      await ctx.reply(
        `❌ 资料库没有关键词「${keyword}」。\n` +
          `这个人的资料已经在机器人里的话，用那个关键词回复即可，例如：轻语 1\n` +
          `还没有的话先把资料上传到机器人，不用绑定通讯录。`
      );
      return true;
    }
    const tasks = await database.createAndroidSendTasksForCircleLead(lead.leadId, [content], chatId, action);
    const actionLabel = { 1: '笔记', 2: '展示', 3: '位置', 4: '三连' }[action];
    await ctx.reply(`✅ 已创建发送任务\n目标：${lead.appUserName}\n关键词：${keyword}\n类型：${actionLabel}\n任务：${tasks[0].taskId}`);
    return true;
  }

  static async bindUser(ctx: Context): Promise<void> {
    const parts = splitPipeOrWhitespace(commandArguments(ctx), 2);
    if (parts.length < 2) {
      await ctx.reply('用法：/binduser 用户标识 | App用户名或备注名 | 备注（可选）\n例如：/binduser A | 小王 | 测试号');
      return;
    }
    const [appUserId, appUserName, ...remarkParts] = parts;
    const user = await database.upsertAndroidAppUser({
      appUserId,
      appUserName,
      remark: remarkParts.join(' | ') || undefined
    });
    await ctx.reply(`✅ 已保存用户映射\n标识：${user.appUserId}\nApp 用户：${user.appUserName}${user.remark ? `\n备注：${user.remark}` : ''}`);
  }

  static async bindContent(ctx: Context): Promise<void> {
    const parts = splitPipeOrWhitespace(commandArguments(ctx), 3);
    if (parts.length < 3) {
      await ctx.reply('用法：/bindcontent 内容ID | TG关键词 | App 内容标题/唯一标识 | 位置或备用定位（可选） | 备注（可选）\n例如：/bindcontent C001 | 上海001 | 上海探店笔记');
      return;
    }
    const [contentId, tgKeyword, appContentIdentifier, appContentPosition, ...remarkParts] = parts;
    const content = await database.upsertAndroidAppContent({
      contentId,
      tgKeyword,
      appContentIdentifier,
      appContentPosition: appContentPosition || undefined,
      remark: remarkParts.join(' | ') || undefined
    });
    await ctx.reply(`✅ 已保存内容映射\n内容：${content.contentId}\n关键词：${content.tgKeyword}\n定位标识：${content.appContentIdentifier}`);
  }

  /** 直接输入关键词同步：同步 轻语 或 /notesync 轻语 */
  static async syncNotes(ctx: Context, keywordOverride?: string): Promise<void> {
    const keyword = (keywordOverride ?? commandArguments(ctx)).trim();
    if (!keyword) {
      await ctx.reply('把资料库里的人同步到手机笔记，直接发：\n同步 轻语\n或 /notesync 轻语');
      return;
    }
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const scopeUserId = ctx.from?.id && isSuperAdmin(ctx.from.id) ? undefined : ctx.from?.id;
    const result = await queueNoteSyncForKeyword(keyword, chatId, scopeUserId);
    if (result.ok === false) {
      await ctx.reply(`❌ ${result.error}`);
      return;
    }
    await ctx.reply(
      `✅ 已排队 ${result.queued} 条「${result.keyword}」的笔记同步（${result.batches} 组 / ${result.files} 个文件）。\n` +
        `Worker 空闲就会执行，不等发送冷却。\n\n${await quotaLine()}`
    );
  }

  static async handleSyncText(ctx: Context): Promise<boolean> {
    const matched = messageText(ctx).match(/^同步\s+(\S.*)$/u);
    if (!matched) return false;
    await this.syncNotes(ctx, matched[1].trim());
    return true;
  }

  static async send(ctx: Context): Promise<void> {
    const parts = commandArguments(ctx).split(/\s+/u).filter(Boolean);
    if (parts.length < 2) {
      await ctx.reply('用法：/send 用户标识 TG关键词1 [TG关键词2 ...]\n例如：/send A 上海001 北京003');
      return;
    }
    const [appUserId, ...keywords] = parts;
    const appUser = await database.getAndroidAppUser(appUserId);
    if (!appUser) {
      await ctx.reply(`❌ 未找到用户映射「${appUserId}」。请先使用 /binduser 录入。`);
      return;
    }
    const resolved = await Promise.all(keywords.map(keyword => resolveContentForKeyword(keyword)));
    const missing = keywords.filter((_keyword, index) => !resolved[index]);
    if (missing.length > 0) {
      await ctx.reply(`❌ 资料库没有这些关键词：${missing.join('、')}\n把资料上传到机器人后即可发送，不必 /bindcontent。未创建任何任务。`);
      return;
    }
    const contents = resolved.filter((item): item is NonNullable<typeof item> => !!item);
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply('❌ 无法识别当前会话，任务未创建。');
      return;
    }
    const tasks = await database.createAndroidSendTasks(appUser, contents, chatId);
    await ctx.reply(
      `✅ 已创建 ${tasks.length} 个发送任务，将由单个 Android 执行端顺序处理。\n` +
      `用户：${appUserId}（${appUser.appUserName}）\n内容：${keywords.join('、')}\n` +
      `任务：${tasks.map(task => task.taskId).join('、')}\n${await quotaLine()}`
    );
  }

  static async mappings(ctx: Context): Promise<void> {
    const { users, contents } = await database.listAndroidMappings();
    const userLines = users.map(item => `• ${item.appUserId} → ${item.appUserName}${item.remark ? `（${item.remark}）` : ''}`);
    const contentLines = contents.map(item => `• ${item.tgKeyword} → ${item.contentId}：${item.appContentIdentifier}${item.appContentPosition ? ` [${item.appContentPosition}]` : ''}`);
    await ctx.reply(`📌 用户映射\n${lines(userLines, '（暂无）')}\n\n📌 内容映射\n${lines(contentLines, '（暂无）')}`);
  }

  static async tasks(ctx: Context): Promise<void> {
    const tasks = await database.listAndroidSendTasks();
    await ctx.reply(`📋 最近发送任务\n${lines(tasks.map(item => {
      const status = { pending: '等待', running: '执行中', succeeded: '成功', failed: '失败' }[item.status];
      const actionLabel = { 1: '笔记', 2: '展示', 3: '位置', 4: '三连' }[item.action || 1];
      return `• ${status}｜${item.appUserId}｜${item.tgKeyword}｜${actionLabel}｜${item.taskId}${item.errorMessage ? `\n  原因：${item.errorMessage}` : ''}`;
    }), '（暂无）')}\n\n${await quotaLine()}`);
  }
}
