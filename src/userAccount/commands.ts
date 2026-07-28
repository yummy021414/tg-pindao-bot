// 用户账号管理命令处理器
import { Context, Markup } from 'telegraf';
import { userAccountDb } from './database';
import { accountController } from './controller';
import { config, getAdminChannelIds } from '../config';
import { database } from '../database';
import { getPublishEventsInRange } from '../services/publishAudit';

// 检查telegram库是否可用
let telegramAvailable = false;
try {
  require('telegram');
  telegramAvailable = true;
} catch (e) {
  // telegram库未安装
}

export class UserAccountCommands {
  private pendingSessions: Map<number, {
    step: 'waiting_login_method' | 'waiting_session' | 'waiting_nickname' | 'waiting_api_id' | 'waiting_api_hash';
    session?: string;
    api_id?: string;
    api_hash?: string;
    nickname?: string;
  }> = new Map();

  private pendingMessages: Map<number, {
    step: 'waiting_target' | 'waiting_message';
    target?: string;
  }> = new Map();

  private pendingGroupSend: Map<number, {
    step: 'waiting_keyword' | 'selecting_hours' | 'waiting_group' | 'waiting_time_range';
    keyword?: string; 
    keywords?: string[]; 
    collectedMessages?: any[]; 
    targetChannel?: string; 
    taskId?: string; 
    timeRange?: string; // 新增：保存用户输入的时间段，如 09:00-18:00
  }> = new Map();

  private pendingAutoReply: Map<number, {
    step: 'waiting_message';
  }> = new Map();

  private pendingExtractKeywords: Map<number, {
    step: 'waiting_range';
  }> = new Map();

  // 检查是否是超管
  private isSuperAdmin(userId: number): boolean {
    return userId === config.superAdminId;
  }

  /** 当前东八区年月日时分 */
  private chinaNowParts(): { y: number; m: number; d: number; hh: number; mm: number } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(new Date());
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
    return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
  }

  /** 解析单个时间点（精确到分钟，按东八区理解） */
  private parseDateTimeInput(text: string): Date | null {
    let raw = text.trim()
      .replace(/[年月]/g, '-')
      .replace(/[日号]/g, ' ')
      .replace(/\//g, '-')
      .replace(/\s+/g, ' ')
      .trim();

    const cn = this.chinaNowParts();

    // 1) 2026-7-15 13:00
    let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (m) {
      return this.buildDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10));
    }

    // 2) 7-15 13:00（当年）
    m = raw.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (m) {
      return this.buildDate(cn.y, parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10));
    }

    // 3) 仅 13:00（今天，东八区）
    m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      return this.buildDate(cn.y, cn.m, cn.d, parseInt(m[1], 10), parseInt(m[2], 10));
    }

    return null;
  }

  /** 一行解析起止：7-15 13:00 到 7-15 14:30 / 7-15 13:00-14:30 / 13:00-14:30 */
  private parseTimeRangeInput(text: string): { start: Date; end: Date } | null {
    const raw = text.trim()
      .replace(/[～~—–]/g, '-')
      .replace(/到|至/g, '到')
      .replace(/\s*到\s*/g, ' 到 ')
      .replace(/\s+/g, ' ')
      .trim();

    // A) 完整两段：xxx 到 yyy
    if (raw.includes(' 到 ')) {
      const [a, b] = raw.split(' 到 ').map(s => s.trim());
      const start = this.parseDateTimeInput(a);
      const end = this.parseDateTimeInput(b);
      if (start && end) return { start, end };
      return null;
    }

    // B) 同一天：7-15 13:00-14:30 或 2026-7-15 13:00-14:30
    let m = raw.match(/^((?:\d{4}-)?\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (m) {
      const start = this.parseDateTimeInput(`${m[1]} ${m[2]}`);
      const end = this.parseDateTimeInput(`${m[1]} ${m[3]}`);
      if (start && end) return { start, end };
    }

    // C) 今天：13:00-14:30
    m = raw.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (m) {
      const start = this.parseDateTimeInput(m[1]);
      const end = this.parseDateTimeInput(m[2]);
      if (start && end) return { start, end };
    }

    return null;
  }

  /** 按东八区墙钟构造 Date（与 published_at 的 UTC 毫秒可正确比较） */
  private buildDate(y: number, month: number, day: number, hh: number, mm: number): Date | null {
    if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    // 先用 UTC 解释该墙钟，再减 8 小时 → 得到东八区该时刻的真实 Instant
    const asUtc = Date.parse(`${y}-${pad(month)}-${pad(day)}T${pad(hh)}:${pad(mm)}:00.000Z`);
    if (Number.isNaN(asUtc)) return null;
    return new Date(asUtc - 8 * 60 * 60 * 1000);
  }

  private formatDateTime(d: Date): string {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  }

  /** 是否正在等待提取关键词的时间段输入（供主路由拦截搜索） */
  isAwaitingExtractInput(userId: number): boolean {
    return this.pendingExtractKeywords.get(userId)?.step === 'waiting_range';
  }

  looksLikeTimeRange(text: string): boolean {
    return !!this.parseTimeRangeInput(text);
  }

  private keepExtractWaiting(userId: number): void {
    this.pendingExtractKeywords.set(userId, { step: 'waiting_range' });
  }

  // 主菜单 - 账号管理
  async handleAccountMenu(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) {
      await ctx.reply('⛔ 只有超级管理员可以使用此功能');
      return;
    }

    // 检查telegram库
    if (!telegramAvailable) {
      await ctx.reply(
        '⚠️ 账号控制功能需要安装额外的依赖库\n\n' +
        '请运行以下命令安装：\n' +
        '```\nnpm install telegram input\n```\n\n' +
        '然后重启机器人即可使用。',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('👥 账号列表与管理', 'account_list_manage'), Markup.button.callback('🤖 自动回复设置', 'auto_reply_menu')],
      [Markup.button.callback('📦 发送媒体库资源', 'send_media_library')],
      [Markup.button.callback('📋 提取发布关键词', 'extract_publish_keywords')],
      [Markup.button.callback('📊 详细任务监控', 'view_task_status'), Markup.button.callback('💬 发送单条私信', 'send_private_msg')],
      [Markup.button.callback('⬅️ 关闭控制面板', 'account_menu_close')]
    ]);

    const message = '🎛️ **账号控制中心**\n\n' +
                    '在这里您可以管理绑定的 Telegram 协议号，执行大规模资料搬运任务，以及设置自动回复。\n\n' +
                    '📋 *提取发布关键词*：按时间段列出你发布到频道的关键词，方便控制账号更新。\n\n' +
                    '💡 *请选择下方功能开始操作：*';

    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }

  // 返回主菜单按钮（内联）
  private getBackButton() {
    return [Markup.button.callback('🔙 返回控制面板', 'back_to_account_menu')];
  }

  // 关闭面板回调
  async handleMenuClose(ctx: Context): Promise<void> {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('已关闭面板');
      await ctx.deleteMessage();
    }
  }

  // 添加账号 - 引导选择登录方式
  async handleAddAccount(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;

    const apiConfig = await userAccountDb.getApiConfig();
    
    if (!apiConfig) {
      // 如果没有全局配置，先引导设置 API 信息
      this.pendingSessions.set(ctx.from!.id, { step: 'waiting_api_id' });
    await ctx.reply(
        '📝 添加新账号 (首次设置)\n\n' +
        '检测到您尚未设置全局 API 配置，请先从 https://my.telegram.org 获取 API ID 和 Hash。\n\n' +
        '第1步：📡 请发送 API ID：'
      );
    } else {
      // 已有配置，直接选择登录方式
      this.pendingSessions.set(ctx.from!.id, { 
        step: 'waiting_login_method',
        api_id: apiConfig.api_id,
        api_hash: apiConfig.api_hash
      });
      
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔐 协议号登录 (Session字符串)', 'login_method_session')],
      ]);

      await ctx.reply('🚀 请选择登录方式：', keyboard);
    }
  }

  // 处理登录方式选择回调
  async handleLoginMethodCallback(ctx: Context, method: 'session'): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingSessions.get(userId);
    if (!pending) return;

    pending.step = 'waiting_session';
    await ctx.editMessageText('📝 请发送您的 <b>Session 协议字符串</b>：', { parse_mode: 'HTML' });
    this.pendingSessions.set(userId, pending);
  }

  // 处理API ID输入
  async handleApiIdInput(ctx: Context, apiId: string): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingSessions.get(userId);

    if (!pending || pending.step !== 'waiting_api_id') return;

    pending.api_id = apiId.trim();
    pending.step = 'waiting_api_hash';
    this.pendingSessions.set(userId, pending);

    await ctx.reply('✅ API ID已接收\n\n第2步：🔑 请发送 API Hash：');
  }

  // 处理API Hash输入
  async handleApiHashInput(ctx: Context, apiHash: string): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingSessions.get(userId);

    if (!pending || pending.step !== 'waiting_api_hash') return;

    pending.api_hash = apiHash.trim();
    this.pendingSessions.set(userId, pending);

    // 设置全局配置并进入选择模式
    await userAccountDb.setGlobalApiConfig(pending.api_id!, apiHash.trim());
    
    await ctx.reply('✅ 全局 API 配置已保存！');
    
    pending.step = 'waiting_login_method';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔐 协议号登录 (Session字符串)', 'login_method_session')],
    ]);

    await ctx.reply('🚀 请选择登录方式：', keyboard);
  }

  // 处理Session输入
  async handleSessionInput(ctx: Context, input: string): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingSessions.get(userId);

    if (!pending || pending.step !== 'waiting_session') return;

    pending.session = input.trim();
    pending.step = 'waiting_nickname';
    this.pendingSessions.set(userId, pending);

    await ctx.reply(
      '✅ Session已接收\n\n' +
      '📝 请给这个账号起个昵称（方便识别）：'
    );
  }

  // 处理昵称输入并完成添加
  async handleNicknameInput(ctx: Context, nickname: string): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingSessions.get(userId);

    if (!pending || pending.step !== 'waiting_nickname') return;

    pending.nickname = nickname.trim();
    await this.finishAddAccount(ctx, pending);
  }

  // 完成添加账号（统一处理）
  private async finishAddAccount(ctx: Context, pending: any): Promise<void> {
    const userId = ctx.from!.id;

    try {
      // 验证必要字段
      if (!pending.session || !pending.api_id || !pending.api_hash || !pending.nickname) {
        await ctx.reply('❌ 信息不完整！请重新添加账号');
        this.pendingSessions.delete(userId);
        return;
      }

      // 保存账号到数据库
      const accountId = await userAccountDb.addAccount({
        phone: pending.phone || '', 
        session: pending.session,
        api_id: pending.api_id,
        api_hash: pending.api_hash,
        nickname: pending.nickname,
        is_active: false,
      });

      // 尝试登录
      await ctx.reply('🔄 正在验证Session并登录账号...\n\n这可能需要几秒钟时间，请稍候...');
      
      const result = await accountController.loginWithSession(
        accountId,
        pending.api_id,
        pending.api_hash,
        pending.session
      );

      if (result.success) {
        const userInfo = result.userInfo || await accountController.getAccountInfo(accountId);
        if (userInfo?.phone) {
          await userAccountDb.updateAccountPhone(accountId, userInfo.phone);
        }
        
        await userAccountDb.setActiveAccount(accountId);
        
        await ctx.reply(
          `✅ 账号添加成功并已激活！\n\n` +
          `📝 昵称: ${pending.nickname}\n` +
          `🆔 ID: ${accountId}\n` +
          `👤 用户名: ${userInfo?.username || '未设置'}\n` +
          `📱 手机: ${userInfo?.phone || '未知'}\n` +
          `🟢 状态: 已激活（当前使用中）\n\n` +
          `💡 现在可以使用发私信、发送媒体库等功能了！`
        );
      } else {
        await ctx.reply(
          `⚠️ 账号已保存，但登录失败\n\n` +
          `错误信息：${result.error || '未知错误'}\n\n` +
          `💡 建议：检查Session是否最新，确认API ID/Hash正确。`
        );
      }

      this.pendingSessions.delete(userId);
    } catch (error: any) {
      await ctx.reply(`❌ 添加账号失败: ${error.message}`);
      this.pendingSessions.delete(userId);
    }
  }

  // 查看账号列表
  async handleAccountList(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;

    const accounts = await userAccountDb.getAllAccounts();

    let message = '📋 **账号管理中心**\n\n';
    const inlineButtons: any[][] = [];

    // 添加账号按钮放在最上面
    inlineButtons.push([Markup.button.callback('➕ 添加新协议号', 'add_account_start')]);

    if (accounts.length === 0) {
      message += '📭 暂无已保存的账号。';
    } else {
    for (const account of accounts) {
        const status = account.is_active ? '✅ **[当前激活]**' : '⭕ 已保存';
      message += `${status} ${account.nickname}\n`;
        message += `   🆔 ID: \`${account.id}\` | 📱 \`${account.phone || '未记录'}\`\n\n`;
        
        inlineButtons.push([
          Markup.button.callback(`⚡ 激活`, `switch_account_${account.id}`),
          Markup.button.callback(`🗑️ 删除`, `delete_account_${account.id}`)
        ]);
      }
    }

    inlineButtons.push(this.getBackButton());

    const finalKeyboard = Markup.inlineKeyboard(inlineButtons);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...finalKeyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...finalKeyboard });
    }
  }

  // 切换账号
  async handleSwitchAccount(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;

    const accounts = await userAccountDb.getAllAccounts();
    if (accounts.length === 0) {
      await ctx.reply('📭 还没有添加任何账号');
      return;
    }

    const buttons = accounts.map(acc => [
      Markup.button.callback(`${acc.is_active ? '✅' : '⭕'} ${acc.nickname}`, `switch_account_${acc.id}`)
    ]);

    await ctx.reply('🔄 请选择要切换到的账号：', Markup.inlineKeyboard(buttons));
  }

  async handleSwitchAccountCallback(ctx: Context, accountId: number): Promise<void> {
      await ctx.answerCbQuery('🔄 正在切换账号...');
      const success = await accountController.activateAccount(accountId);
      if (success) {
        const account = await userAccountDb.getAccount(accountId);
      await ctx.editMessageText(`✅ 账号已切换为: ${account?.nickname}`);
      } else {
      await ctx.editMessageText('❌ 切换失败，请检查账号连接状态');
    }
  }

  // 删除账号
  async handleDeleteAccount(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;

    const accounts = await userAccountDb.getAllAccounts();
    if (accounts.length === 0) {
      await ctx.reply('📭 还没有添加任何账号');
      return;
    }

    const buttons = accounts.map(acc => [
      Markup.button.callback(`🗑️ 删除 ${acc.nickname}`, `delete_account_${acc.id}`)
    ]);

    await ctx.reply('🗑️ 请选择要删除的账号：', Markup.inlineKeyboard(buttons));
  }

  async handleDeleteAccountCallback(ctx: Context, accountId: number): Promise<void> {
      const account = await userAccountDb.getAccount(accountId);
    await ctx.editMessageText(
      `❓ 确定要删除账号 "${account?.nickname}" 吗？\n\n⚠️ 删除后将无法通过此账号发送资料。`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ 确认删除', `confirm_delete_${accountId}`)],
        [Markup.button.callback('❌ 取消', 'cancel_delete')]
      ])
    );
  }

  async handleConfirmDelete(ctx: Context, accountId: number): Promise<void> {
      const success = await accountController.deleteAccount(accountId);
      if (success) {
      await ctx.answerCbQuery('✅ 账号已删除');
      await ctx.editMessageText('✅ 账号及其 Session 已成功从服务器移除。');
      } else {
      await ctx.answerCbQuery('❌ 删除失败');
      }
  }

  // 自动回复
  async handleAutoReplyMenu(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;

    const activeAccount = await userAccountDb.getActiveAccount();
    if (!activeAccount) {
      await ctx.reply('⚠️ 请先激活一个账号');
      return;
    }

    const config = await userAccountDb.getAutoReply(activeAccount.id);
    const status = config?.is_enabled ? '🟢 已启用' : '🔴 已禁用';
    const message = config?.reply_message || '未设置';

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📝 设置回复内容', 'set_auto_reply_msg')],
      [
        Markup.button.callback('✅ 启用', 'enable_auto_reply'),
        Markup.button.callback('❌ 禁用', 'disable_auto_reply')
      ],
      this.getBackButton()
    ]);

    const replyMsg = `🤖 **自动回复管理**\n\n` +
      `👤 账号: ${activeAccount.nickname}\n` +
      `📊 状态: ${status}\n` +
                     `💬 内容: ${message}`;

    if (ctx.callbackQuery) {
      await ctx.editMessageText(replyMsg, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(replyMsg, { parse_mode: 'Markdown', ...keyboard });
    }
  }

  async handleSetAutoReplyMessage(ctx: Context): Promise<void> {
    this.pendingAutoReply.set(ctx.from!.id, { step: 'waiting_message' });
    await ctx.reply('📝 请输入自动回复的内容：');
  }

  async handleAutoReplyMessageInput(ctx: Context, message: string): Promise<void> {
    const userId = ctx.from!.id;
      const activeAccount = await userAccountDb.getActiveAccount();
    if (activeAccount) {
      await userAccountDb.setAutoReply(activeAccount.id, message.trim(), false);
      await ctx.reply('✅ 内容已设置！请点击“启用”按钮正式激活。');
    }
      this.pendingAutoReply.delete(userId);
    }

  async handleStopTaskCallback(ctx: Context, taskId: string): Promise<void> {
    const success = accountController.stopTask(taskId);
    if (success) {
      await ctx.answerCbQuery('🛑 任务已终止');
      await ctx.editMessageText(`✅ 任务 \`${taskId}\` 已被成功停止并移除。`, { parse_mode: 'Markdown' });
    } else {
      await ctx.answerCbQuery('❌ 停止失败：任务可能已结束');
    }
    }

  async handleEnableAutoReply(ctx: Context): Promise<void> {
    const activeAccount = await userAccountDb.getActiveAccount();
    if (activeAccount) {
    await userAccountDb.toggleAutoReply(activeAccount.id, true);
    await accountController.enableAutoReply(activeAccount.id);
      await ctx.editMessageText('✅ 自动回复监听已开启');
    }
  }

  async handleDisableAutoReply(ctx: Context): Promise<void> {
    const activeAccount = await userAccountDb.getActiveAccount();
    if (activeAccount) {
    await userAccountDb.toggleAutoReply(activeAccount.id, false);
      await accountController.disableAutoReply(activeAccount.id);
      await ctx.editMessageText('❌ 自动回复监听已关闭');
    }
  }

  // 发送媒体库
  async handleSendMediaLibrary(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;
    const activeAccount = await userAccountDb.getActiveAccount();
    if (!activeAccount) {
      await ctx.reply('⚠️ 请先激活一个账号');
      return;
    }
    this.pendingGroupSend.set(ctx.from!.id, { step: 'waiting_keyword' });
    await ctx.reply('📦 媒体库发送\n\n请输入要发送的关键词（支持多行或逗号分隔）：');
  }

  async handleKeywordInput(ctx: Context, keywordsText: string): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingGroupSend.get(userId);
    if (!pending || pending.step !== 'waiting_keyword') return;

    let keywordLines = keywordsText.split(/[\n,，\s]+/).map(k => k.trim().replace(/^@+/, '')).filter(k => k.length > 0);
    keywordLines = [...new Set(keywordLines)];

    const validKeywords = [];
    for (const keyword of keywordLines) {
      if (await database.keywordExists(keyword)) validKeywords.push(keyword);
    }

    if (validKeywords.length === 0) {
      await ctx.reply('❌ 所有关键词都不存在，请重新输入');
      return;
    }

    await ctx.reply(`🎯 已识别 ${validKeywords.length} 个有效关键词。资料预览已准备就绪。\n\n下一步：请输入目标群组/频道的用户名或ID：`);
    pending.keywords = validKeywords;
    pending.step = 'waiting_group';
    this.pendingGroupSend.set(userId, pending);
  }

  async handleGroupInput(ctx: Context, group: string): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingGroupSend.get(userId);
    if (!pending || pending.step !== 'waiting_group') return;

      pending.targetChannel = group;
      pending.step = 'selecting_hours';

      const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🚀 极速连发 (搜完即发)', 'send_hours_0')],
      [Markup.button.callback('🕒 1小时内', 'send_hours_1'), Markup.button.callback('🛡️ 6小时内', 'send_hours_6')],
      [Markup.button.callback('😴 12小时', 'send_hours_12'), Markup.button.callback('💤 24小时 (超稳)', 'send_hours_24')],
      [Markup.button.callback('📅 自定义时间段 (几点到几点)', 'send_custom_range')]
      ]);

    await ctx.reply(`✅ 目标已设置：${group}\n\n⏰ 请选择运行模式或自定义时间：`, keyboard);
  }

  async handleHoursCallback(ctx: Context, hours: number): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingGroupSend.get(userId);
    if (!pending || pending.step !== 'selecting_hours') return;

    const result = await accountController.startBackgroundCollectionTask(
      userId, pending.keywords!, pending.targetChannel!,
      { spreadHours: hours, startDelay: hours <= 1 ? 0.02 : 0.1 },
      async (taskResult: any) => {
        if (taskResult.success) {
          await ctx.reply(`🎉 任务执行完毕！\n📊 关键词已全部处理：${pending.keywords?.join(', ')}\n✅ 资料已送达指定目标。`);
        } else {
          await ctx.reply(`❌ 任务执行中断: ${taskResult.error}`);
        }
      }
    );
    await ctx.reply(result.message);
    this.pendingGroupSend.delete(userId);
  }

  // 自定义时间段启动
  async handleCustomRangeStart(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingGroupSend.get(userId);
    if (!pending) return;

    pending.step = 'waiting_time_range';
    this.pendingGroupSend.set(userId, pending);

    await ctx.reply(
      '🕒 **请输入自定义更新时间段**\n\n' +
      '格式示例：`09:00-18:00` 或 `22:30-02:00`\n\n' +
      '💡 机器人将自动计算间隔，在此期间内严格串行更新完所有关键词。',
      { parse_mode: 'Markdown' }
    );
  }

  // 处理时间段输入
  async handleTimeRangeInput(ctx: Context, text: string): Promise<void> {
    const userId = ctx.from!.id;
    const pending = this.pendingGroupSend.get(userId);
    if (!pending || pending.step !== 'waiting_time_range') return;

    const rangeRegex = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/;
    const match = text.trim().match(rangeRegex);

    if (!match) {
      await ctx.reply('❌ 格式错误！请输入正确的格式，例如：`09:00-18:00`');
      return;
    }

    const startTimeStr = match[1];
    const endTimeStr = match[2];

    try {
      const result = await accountController.startBackgroundTimeRangeTask(
        userId, 
        pending.keywords!, 
        pending.targetChannel!,
        startTimeStr,
        endTimeStr,
        async (taskResult: any) => {
          if (taskResult.success) {
            await ctx.reply(`🎉 计划任务圆满完成！\n⏰ 时间段：${startTimeStr} 至 ${endTimeStr}\n✅ 所有资料已按计划送达。`);
          } else {
            await ctx.reply(`❌ 计划任务中断: ${taskResult.error}`);
          }
        }
      );

      await ctx.reply(result.message);
      this.pendingGroupSend.delete(userId);
    } catch (error: any) {
      await ctx.reply(`❌ 任务启动失败: ${error.message}`);
    }
  }

  // 查看任务状态
  async handleTaskStatus(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;

    const tasks = accountController.getRunningTasks();
    if (tasks.length === 0) {
      await ctx.reply('📭 当前没有正在运行的任务。');
      return;
    }

    let message = '📋 **详细后台任务状态**\n\n';
    const inlineButtons: any[][] = [];

    tasks.forEach((task, index) => {
      const statusIcon = task.status === 'completed' ? '✅' : 
                        task.status === 'failed' ? '❌' : 
                        task.status === 'collecting' ? '🔍' : '⏳';
      
      const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
      const elapsedText = elapsed > 60 ? `${Math.floor(elapsed/60)}分${elapsed%60}秒` : `${elapsed}秒`;

      message += `${index + 1}. 🆔 \`${task.taskId}\`\n`;
      message += `   状态: ${statusIcon} ${task.status}\n`;
      message += `   进度: \`${task.progress}\` (关键词)\n`;
      message += `   当前正在处理: **${task.currentKeyword}**\n`;
      message += `   已运行: ${elapsedText}\n`;
      message += `   已采集资源: ${task.collectedCount} 个\n\n`;

      inlineButtons.push([Markup.button.callback(`🛑 停止任务 ${index + 1}`, `stop_task_${task.taskId}`)]);
    });

    inlineButtons.push(this.getBackButton());

    const finalKeyboard = Markup.inlineKeyboard(inlineButtons);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...finalKeyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...finalKeyboard });
    }
  }

  async handleCancel(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    this.pendingSessions.delete(userId);
    this.pendingMessages.delete(userId);
    this.pendingGroupSend.delete(userId);
    this.pendingAutoReply.delete(userId);
    this.pendingExtractKeywords.delete(userId);
    await ctx.reply('❌ 已取消当前操作。');
  }

  // 静默清理所有待办状态（切换模式时调用）
  silentCleanup(userId: number): void {
    this.pendingSessions.delete(userId);
    this.pendingMessages.delete(userId);
    this.pendingGroupSend.delete(userId);
    this.pendingAutoReply.delete(userId);
    this.pendingExtractKeywords.delete(userId);
  }

  // ========== 提取发布时间段关键词（仅超管，精确到分钟） ==========
  async handleExtractPublishKeywordsStart(ctx: Context): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;
    this.silentCleanup(ctx.from!.id);
    this.pendingExtractKeywords.set(ctx.from!.id, { step: 'waiting_range' });

    const msg =
      '📋 <b>提取发布关键词</b>（精确到分钟 · 东八区）\n\n' +
      '数据来源（合并）：\n' +
      '1. 发布审计日志 / bot.log（几点发了哪个词）\n' +
      '2. 资料库发布时间 / 入库时间\n\n' +
      '请直接发送一段时间，例如：\n' +
      '• <code>7-15 13:00 到 7-15 14:30</code>\n' +
      '• <code>7-15 13:00-14:30</code>（同一天）\n' +
      '• <code>13:00-14:30</code>（今天）\n\n' +
      '⏳ 发送后会继续等待下一段，不会当成搜索关键词\n' +
      '发送 /cancel 取消';

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⏱ 最近1小时', 'extract_kw_1h'), Markup.button.callback('⏱ 最近3小时', 'extract_kw_3h')],
      this.getBackButton()
    ]);

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(msg, { parse_mode: 'HTML', ...keyboard });
    } else {
      await ctx.reply(msg, { parse_mode: 'HTML', ...keyboard });
    }
  }

  async handleExtractPreset(ctx: Context, preset: string): Promise<void> {
    if (!this.isSuperAdmin(ctx.from?.id!)) return;
    await ctx.answerCbQuery().catch(() => {});

    const now = new Date();
    let start: Date;
    const end = now;

    if (preset === '1h') {
      start = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    } else if (preset === '3h') {
      start = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    } else {
      // 兼容旧回调，统一引导重新输入精确时间
      await this.handleExtractPublishKeywordsStart(ctx);
      return;
    }

    // 查完后继续保持等待，避免下一段输入掉进「搜索关键词」
    this.keepExtractWaiting(ctx.from!.id);
    await this.replyExtractedKeywords(ctx, start, end);
  }

  async handleExtractCustomStart(ctx: Context): Promise<void> {
    // 兼容旧按钮：直接进入精确时间输入
    await this.handleExtractPublishKeywordsStart(ctx);
  }

  private async handleExtractRangeInput(ctx: Context, text: string): Promise<void> {
    const range = this.parseTimeRangeInput(text);
    if (!range) {
      // 格式不对也保持等待，绝不交给搜索
      this.keepExtractWaiting(ctx.from!.id);
      await ctx.reply(
        '❌ 时间格式不对，请按「几点到几点」发送，例如：\n' +
        '• <code>7-15 13:00 到 7-15 14:30</code>\n' +
        '• <code>7-15 13:00-14:30</code>\n' +
        '• <code>13:00-14:30</code>\n\n' +
        '仍在提取模式中，不会当作搜索关键词。发送 /cancel 取消。',
        { parse_mode: 'HTML' }
      );
      return;
    }
    if (range.end.getTime() < range.start.getTime()) {
      this.keepExtractWaiting(ctx.from!.id);
      await ctx.reply('❌ 结束时间不能早于开始时间，请重发：');
      return;
    }
    this.keepExtractWaiting(ctx.from!.id);
    await this.replyExtractedKeywords(ctx, range.start, range.end);
  }

  private async replyExtractedKeywords(ctx: Context, start: Date, end: Date): Promise<void> {
    const userId = ctx.from!.id;
    this.keepExtractWaiting(userId);
    const channelIds = getAdminChannelIds(userId).map(String).filter(Boolean);

    await ctx.reply('🔍 正在按时间段筛选（资料库 + 发布日志）...');

    const [dbRows, logRows] = await Promise.all([
      database.getPublishedKeywordsByTimeRange(userId, start, end, channelIds),
      getPublishEventsInRange(start, end, userId)
    ]);

    // 合并：日志优先（真实发布时间），再补资料库时段命中；有日志时不再倾倒全部 no_time
    type Row = { keyword: string; publishedAt: string; matchBy?: string };
    const merged = new Map<string, Row>();
    const rank = (m?: string) =>
      m === 'audit_log' || m === 'bot_log' ? 5 :
      m === 'published_at' ? 4 :
      m === 'uploaded_at' ? 3 :
      m === 'same_day' ? 2 :
      m === 'no_time' ? 1 : 0;

    for (const r of logRows) {
      merged.set(r.keyword, { keyword: r.keyword, publishedAt: r.publishedAt, matchBy: r.matchBy });
    }
    for (const r of dbRows) {
      if (r.matchBy === 'no_time' && logRows.length > 0) continue; // 有日志就别刷 200+ 无时间
      const existing = merged.get(r.keyword);
      if (!existing || rank(r.matchBy) > rank(existing.matchBy)) {
        merged.set(r.keyword, { keyword: r.keyword, publishedAt: r.publishedAt, matchBy: r.matchBy });
      }
    }

    const rows = Array.from(merged.values()).sort(
      (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
    );
    const timedRows = rows.filter(r => r.matchBy !== 'no_time');
    const noTimeRows = rows.filter(r => r.matchBy === 'no_time');
    const fromLog = rows.filter(r => r.matchBy === 'bot_log' || r.matchBy === 'audit_log').length;
    const precise = rows.filter(r => r.matchBy === 'published_at').length;
    const byUpload = rows.filter(r => r.matchBy === 'uploaded_at').length;
    const sameDay = rows.filter(r => r.matchBy === 'same_day').length;

    const header =
      `📋 <b>提取结果</b>\n` +
      `⏱ ${this.formatDateTime(start)} ~ ${this.formatDateTime(end)}（东八区）\n` +
      `📢 频道：${channelIds.length ? channelIds.map(c => `<code>${c}</code>`).join(', ') : '未配置 CHANNEL_IDS'}\n` +
      `📦 合计：<b>${rows.length}</b> 个\n` +
      `   · 日志还原 ${fromLog} / 库精确 ${precise} / 入库 ${byUpload} / 同日 ${sameDay}` +
      (noTimeRows.length ? ` / 无时间 ${noTimeRows.length}` : '') +
      `\n\n`;

    if (rows.length === 0) {
      await ctx.reply(
        header +
          '❌ 该时段在资料库和日志里都没有发布记录。\n\n' +
          '💡 若刚部署，请确认 <code>data/bot.log</code> 已挂载且当天有发布日志。',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 重新开始', 'extract_publish_keywords')],
            this.getBackButton()
          ])
        }
      );
      return;
    }

    // —— 时段内可确认（含日志）——
    if (timedRows.length > 0) {
      let chunk = header + `<b>✅ 时段内发布记录（${timedRows.length}）</b>\n`;
      for (let i = 0; i < timedRows.length; i++) {
        const r = timedRows[i];
        const t = this.formatDateTime(new Date(r.publishedAt));
        const tag =
          r.matchBy === 'bot_log' || r.matchBy === 'audit_log' ? ' ·日志' :
          r.matchBy === 'published_at' ? '' :
          r.matchBy === 'same_day' ? ' ·同日' : ' ·入库';
        const line = `${i + 1}. <code>${r.keyword}</code>  <i>${t}${tag}</i>\n`;
        if ((chunk + line).length > 3500) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
          chunk = '';
        }
        chunk += line;
      }
      if (chunk) await ctx.reply(chunk, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(
        header +
          '⚠️ 日志与精确时间都未命中此时段，下面仅有无发布时间的库内已发布列表。',
        { parse_mode: 'HTML' }
      );
    }

    // —— 无日志时才补充无时间列表 ——
    if (noTimeRows.length > 0) {
      await ctx.reply(
        `⚠️ <b>无精确时间的已发布（${noTimeRows.length}）</b>\n日志未还原到此时段时的兜底列表。`,
        { parse_mode: 'HTML' }
      );
      let chunk = '';
      for (let i = 0; i < noTimeRows.length; i++) {
        const line = `${i + 1}. <code>${noTimeRows[i].keyword}</code>\n`;
        if ((chunk + line).length > 3500) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
          chunk = '';
        }
        chunk += line;
      }
      if (chunk) await ctx.reply(chunk, { parse_mode: 'HTML' });
    }

    const keywordOnly = [
      ...timedRows.map(r => r.keyword),
      ...noTimeRows.map(r => r.keyword)
    ].join('\n');
    const copyHeader = '📝 <b>纯关键词（可直接复制）</b>\n\n';

    if ((copyHeader + `<code>${keywordOnly}</code>`).length <= 4000) {
      await ctx.reply(copyHeader + `<code>${keywordOnly}</code>`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 再提取一次', 'extract_publish_keywords')],
          [Markup.button.callback('📦 去发送媒体库', 'send_media_library')],
          this.getBackButton()
        ])
      });
    } else {
      const parts = keywordOnly.split('\n');
      let buf = '';
      for (let i = 0; i < parts.length; i++) {
        const kw = parts[i];
        if ((buf + kw + '\n').length > 3500) {
          await ctx.reply(`📝 纯关键词：\n<code>${buf.trim()}</code>`, { parse_mode: 'HTML' });
          buf = '';
        }
        buf += kw + '\n';
      }
      if (buf.trim()) {
        await ctx.reply(`📝 纯关键词：\n<code>${buf.trim()}</code>`, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 再提取一次', 'extract_publish_keywords')],
            [Markup.button.callback('📦 去发送媒体库', 'send_media_library')],
            this.getBackButton()
          ])
        });
      }
    }
  }

  async handleTextMessage(ctx: Context): Promise<boolean> {
    const userId = ctx.from!.id;
    const text = (ctx.message as any).text;
    if (!text) return false;

    if (text === '/cancel' || text === '取消' || text === '❌ 取消') {
      await this.handleCancel(ctx);
      return true;
    }

    const extractPending = this.pendingExtractKeywords.get(userId);
    if (extractPending?.step === 'waiting_range') {
      await this.handleExtractRangeInput(ctx, text);
      return true;
    }

    const sessionPending = this.pendingSessions.get(userId);
    if (sessionPending) {
      switch (sessionPending.step) {
        case 'waiting_session': await this.handleSessionInput(ctx, text); return true;
        case 'waiting_api_id': await this.handleApiIdInput(ctx, text); return true;
        case 'waiting_api_hash': await this.handleApiHashInput(ctx, text); return true;
        case 'waiting_nickname': await this.handleNicknameInput(ctx, text); return true;
      }
    }

    const groupPending = this.pendingGroupSend.get(userId);
    if (groupPending) {
      switch (groupPending.step) {
        case 'waiting_keyword': await this.handleKeywordInput(ctx, text); return true;
        case 'waiting_group': await this.handleGroupInput(ctx, text); return true;
        case 'waiting_time_range': await this.handleTimeRangeInput(ctx, text); return true;
      }
    }

    const autoReplyPending = this.pendingAutoReply.get(userId);
    if (autoReplyPending?.step === 'waiting_message') {
          await this.handleAutoReplyMessageInput(ctx, text);
      return true;
    }

    return false;
  }
}

export const userAccountCommands = new UserAccountCommands();
