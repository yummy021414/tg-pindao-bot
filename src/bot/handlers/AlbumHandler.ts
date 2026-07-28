import { Context, Markup } from 'telegraf';
import { ErrorLogger } from '../../utils/errorLogger';
import { AlbumDataValidator } from '../../utils/albumValidator';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { BotMode, UserSession } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { config, isAdminUser, isSuperAdmin } from '../../config';
import https from 'https';
import axios from 'axios';

const MAX_GROUPS = 20;
const ALBUM_EXPIRE_DAYS = 3;

export class AlbumHandler {
  /** 相册公网地址：未配 HTTPS 证书时强制 http，避免生成 https 打不开 */
  private static getAlbumBaseUrl(): string {
    let domain = (process.env.DOMAIN || 'http://localhost:3000').trim().replace(/\/+$/, '');
    // 默认强制 http；以后上了证书可设 ALBUM_FORCE_HTTP=0
    if (process.env.ALBUM_FORCE_HTTP !== '0') {
      domain = domain.replace(/^https:\/\//i, 'http://');
    }
    if (!/^https?:\/\//i.test(domain)) {
      domain = `http://${domain}`;
    }
    return domain;
  }

  private static albumTimeouts: Map<number, NodeJS.Timeout> = new Map(); // 兼容旧逻辑
  /** key = `${userId}:${groupKey}` — 按 Telegram 相册分组收齐 */
  private static albumGroupTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private static albumReadyTimeouts: Map<number, NodeJS.Timeout> = new Map();
  /** 收集进度消息（编辑同一条，避免刷屏） */
  private static albumStatusMsgId: Map<number, number> = new Map();
  private static readonly GROUP_SETTLE_MS = 1600;
  /** 连续甩多组时：最后一条媒体后静默这么久，再汇总一次（不中途刷屏） */
  private static readonly READY_MS = 3500;
  private static httpsAgent = new https.Agent({ rejectUnauthorized: false });

  private static clearAlbumTimers(userId: number): void {
    const old = this.albumTimeouts.get(userId);
    if (old) {
      clearTimeout(old);
      this.albumTimeouts.delete(userId);
    }
    const ready = this.albumReadyTimeouts.get(userId);
    if (ready) {
      clearTimeout(ready);
      this.albumReadyTimeouts.delete(userId);
    }
    for (const key of Array.from(this.albumGroupTimeouts.keys())) {
      if (key.startsWith(`${userId}:`)) {
        clearTimeout(this.albumGroupTimeouts.get(key)!);
        this.albumGroupTimeouts.delete(key);
      }
    }
  }

  private static countAlbumFiles(groups: any[]): number {
    return (groups || []).reduce((n, g) => n + ((g.files && g.files.length) || 0), 0);
  }

  private static formatAlbumCollectStatus(session: UserSession): string {
    const groups = session.albumGroups || [];
    const groupCount = groups.length;
    const fileCount = this.countAlbumFiles(groups);
    const lines = groups.slice(0, 12).map((g: any, i: number) => {
      const t = String(g.caption || '').replace(/\s+/g, ' ').trim();
      const short = t.length > 36 ? t.slice(0, 36) + '…' : t;
      const safe = short.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `${i + 1}. ${(g.files || []).length}个文件 — <i>${safe || '(无文案)'}</i>`;
    });
    const more = groups.length > 12 ? `\n…共 ${groupCount} 组` : '';
    return (
      `📦 <b>资料已收到</b>\n` +
      `📊 共 <b>${groupCount}</b> 组 / <b>${fileCount}</b> 个文件（上限 ${MAX_GROUPS} 组）\n\n` +
      `<b>各组：</b>\n${lines.join('\n')}${more}\n\n` +
      `可继续再发，或点下方按钮。`
    );
  }

  /**
   * 停手汇总：始终在聊天底部新发一条（不编辑上方旧消息）。
   * 否则用户继续往下发图后，只改了上面的旧卡片，看起来像「没有后续反馈」。
   */
  private static async upsertAlbumCollectStatus(
    telegram: any,
    chatId: number,
    userId: number,
    session: UserSession
  ): Promise<void> {
    const text = this.formatAlbumCollectStatus(session);
    const markup = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ 完成生成', 'finish_album'),
        Markup.button.callback('❌ 取消', 'cancel_album_maker')
      ]
    ]);

    // 尽量删掉上一条汇总，避免一堆重复卡片
    const oldId = this.albumStatusMsgId.get(userId);
    if (oldId) {
      try {
        await telegram.deleteMessage(chatId, oldId);
      } catch {
        // 删不掉就留着，不影响新发
      }
      this.albumStatusMsgId.delete(userId);
    }

    try {
      const sent = await telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        ...markup
      });
      if (sent?.message_id) this.albumStatusMsgId.set(userId, sent.message_id);
      console.log(
        `[相册] 汇总反馈已发送 用户=${userId} 组=${(session.albumGroups || []).length} 文件=${this.countAlbumFiles(session.albumGroups || [])}`
      );
    } catch (e: any) {
      console.error('[相册] 发送收集进度失败:', e?.message || e);
    }
  }

  // 全局下载槽位：多人同时做相册时，限制总并发，避免把线路打爆；数据仍按人隔离不会串
  private static globalActiveDownloads = 0;
  private static globalDownloadWaiters: Array<() => void> = [];

  private static getGlobalDownloadLimit(): number {
    return Math.max(4, parseInt(process.env.ALBUM_GLOBAL_DOWNLOAD_LIMIT || '30', 10) || 30);
  }

  private static async acquireGlobalDownloadSlot(): Promise<void> {
    const limit = this.getGlobalDownloadLimit();
    if (this.globalActiveDownloads < limit) {
      this.globalActiveDownloads++;
      return;
    }
    await new Promise<void>(resolve => this.globalDownloadWaiters.push(resolve));
    this.globalActiveDownloads++;
  }

  private static releaseGlobalDownloadSlot(): void {
    this.globalActiveDownloads = Math.max(0, this.globalActiveDownloads - 1);
    const next = this.globalDownloadWaiters.shift();
    if (next) next();
  }

  /**
   * 把 pending 打成相册组。
   * - 传 groupKey：只冲这一组（连甩多组时用）
   * - 不传：按 groupKey 逐个冲完剩余（点「完成生成」时用）
   */
  private static flushPendingToGroup(session: UserSession, groupKey?: string): number {
    if (!session.pendingAlbumMedia || session.pendingAlbumMedia.length === 0) return 0;
    if (!session.albumGroups) session.albumGroups = [];

    const keys = groupKey
      ? [groupKey]
      : Array.from(new Set(session.pendingAlbumMedia.map((m: any) => m.groupKey || 'legacy')));

    let flushed = 0;
    for (const key of keys) {
      if (session.albumGroups.length >= MAX_GROUPS) {
        session.pendingAlbumMedia = session.pendingAlbumMedia.filter((m: any) => m.groupKey !== key);
        continue;
      }
      const items = session.pendingAlbumMedia.filter((m: any) => (m.groupKey || 'legacy') === key);
      if (items.length === 0) continue;

      const groupNum = session.albumGroups.length + 1;
      const filesWithTypes = items.map((m: any) => ({
        id: m.fileId,
        type: m.mediaType === 'photo' ? 'photo' : 'video'
      }));
      const mainCaption = items.find((m: any) => m.caption)?.caption || `第 ${groupNum} 组资料`;

      session.albumGroups.push({
        id: `group_${key}_${Date.now()}`,
        caption: mainCaption,
        files: filesWithTypes
      } as any);
      session.pendingAlbumMedia = session.pendingAlbumMedia.filter((m: any) => (m.groupKey || 'legacy') !== key);
      flushed++;
    }
    return flushed;
  }

  static async handleStart(ctx: Context, db: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const isAdmin = userId === config.superAdminId;

    const session: UserSession = {
      userId,
      mode: BotMode.AlbumMaker,
      step: 'waiting_album_name',
      albumGroups: [],
      pendingAlbumMedia: []
    };

    await db.saveUserSession(userId, session);

    const buttons = [
      [Markup.button.callback('🗂️ 我的相册', 'my_albums')],
      [Markup.button.callback('❌ 退出模式', 'cancel_album_maker')]
    ];

    if (isAdmin) {
      buttons.unshift([Markup.button.callback('👥 查看所有用户相册', 'all_user_albums')]);
    }

    const keyboard = Markup.inlineKeyboard(buttons);

    const welcomeMsg =
      '🖼️ <b>开启网页相册制作</b>\n\n' +
      `💡 相册生成后保留 <b>${ALBUM_EXPIRE_DAYS} 天</b>，到期自动清除\n` +
      `📦 单次最多 <b>${MAX_GROUPS}</b> 组资料\n\n` +
      '第一步：请先为这个相册起个名字（仅供自己查看识别）：';

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(welcomeMsg, { parse_mode: 'HTML', ...keyboard });
    } else {
      await ctx.reply(welcomeMsg, { parse_mode: 'HTML', ...keyboard });
    }
  }

  // 保留管理员授权入口（已不再拦截使用），避免旧回调报错
  static async handleAdminAuthStart(ctx: Context, _db: any): Promise<void> {
    if (ctx.from?.id !== config.superAdminId) return;
    const msg = 'ℹ️ 会员制度已取消，网页相册对所有用户开放，无需再授权。';
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(msg, {
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回', 'start_album_maker')]])
      });
    } else {
      await ctx.reply(msg);
    }
  }

  static async handleAdminUserIdInput(ctx: Context, _userIdStr: string, _userSessions: Map<number, UserSession>): Promise<void> {
    if (ctx.from?.id !== config.superAdminId) return;
    await ctx.reply('ℹ️ 会员制度已取消，无需再授权。');
  }

  static async handleGrantAuth(ctx: Context, _db: any, _userId: number, _days: string): Promise<void> {
    if (ctx.from?.id !== config.superAdminId) return;
    if (ctx.callbackQuery) await ctx.answerCbQuery('已取消会员制度').catch(() => {});
    await ctx.editMessageText('ℹ️ 会员制度已取消，网页相册对所有用户开放。', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回', 'start_album_maker')]])
    });
  }

  static async handleNameInput(ctx: Context, db: any, session: UserSession): Promise<void> {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (!text || text.length > 30) {
      await ctx.reply('❌ 名字不能为空且不能超过30个字，请重新输入：');
      return;
    }

    session.albumName = text;
    session.step = 'waiting_keyword';
    await db.saveUserSession(session.userId, session);

    await ctx.reply(
      `✅ 已设置相册名称：<b>${text}</b>\n\n` +
      '现在请开始发送资料：\n' +
      '1️⃣ <b>发送关键词</b>：从资料库同步（自动成组）\n' +
      '2️⃣ <b>直接发送照片/视频</b>：手动分批制作\n\n' +
      '💡 <b>制作规则</b>：\n' +
      '• 可连续甩多组相册，按 Telegram 相册自动分组，无需等 5 秒。\n' +
      `• 单次最多 <b>${MAX_GROUPS}</b> 组资料。\n` +
      '• 生成时会下载到本地；相册 3 天后自动清除。',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ 完成生成并获取链接', 'finish_album')],
          [Markup.button.callback('❌ 退出模式', 'cancel_album_maker')]
        ])
      }
    );
  }

  /** 从资料库按关键词同步到相册（生成时再本地下载） */
  static async handleKeyword(ctx: Context, db: any, userSessions: Map<number, UserSession>, keyword: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId) || await db.getUserSession(userId);
    if (!session || session.mode !== BotMode.AlbumMaker) return;

    if (!session.albumGroups) session.albumGroups = [];

    if (session.albumGroups.length >= MAX_GROUPS) {
      await ctx.reply(`⚠️ 单次相册最多 ${MAX_GROUPS} 组，请点击“完成生成”。`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ 完成生成', 'finish_album')],
        [Markup.button.callback('❌ 退出', 'cancel_album_maker')]
      ]));
      return;
    }

    // 与搜索一致：超管全库，子管理员自己的库，普通用户公共库
    let scopeUserId: number | undefined = config.superAdminId;
    if (isSuperAdmin(userId)) scopeUserId = undefined;
    else if (isAdminUser(userId)) scopeUserId = userId;

    const mediaItems = await db.getMediaByKeyword(keyword, scopeUserId);
    if (mediaItems.length === 0) {
      await ctx.reply(`❌ 资料库未找到关键词 "${keyword}" 的资料。`);
      return;
    }

    const batches: { [key: string]: any[] } = {};
    mediaItems.forEach((m: any) => {
      const bId = m.batchId || 'legacy';
      if (!batches[bId]) batches[bId] = [];
      batches[bId].push(m);
    });

    const batchIds = Object.keys(batches);
    let added = 0;

    for (let i = 0; i < batchIds.length; i++) {
      if (session.albumGroups.length >= MAX_GROUPS) break;

      const batchItems = batches[batchIds[i]];
      const mainCaption = batchItems.find((m: any) => m.caption)?.caption || `${keyword} 资料包`;

      session.albumGroups.push({
        id: `group_${Date.now()}_${i}`,
        caption: mainCaption,
        files: batchItems.map((m: any) => ({
          id: m.file_id,
          type: m.file_type === 'photo' ? 'photo' : 'video'
        }))
      } as any);
      added++;
    }

    userSessions.set(userId, session);
    await db.saveUserSession(userId, session);

    let msg = `✅ 已从资料库添加 "${keyword}" 的 ${added} 组资料。\n📊 当前 ${session.albumGroups.length}/${MAX_GROUPS} 组\n\n可继续发送关键词或图片，或点击“完成生成”。`;
    if (batchIds.length > added) {
      msg += `\n⚠️ 资料共 ${batchIds.length} 组，已达上限，仅加入前 ${added} 组。`;
    }

    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('✅ 完成生成', 'finish_album')],
      [Markup.button.callback('❌ 退出', 'cancel_album_maker')]
    ]));
  }

  static async handleMediaMessage(ctx: Context, mediaType: string, userSessions: Map<number, UserSession>, db: any): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    const session = userSessions.get(userId) || await db.getUserSession(userId);
    if (!session || session.mode !== BotMode.AlbumMaker) return;

    if (!session.pendingAlbumMedia) session.pendingAlbumMedia = [];
    if (!session.albumGroups) session.albumGroups = [];

    // 已满 20 组且当前没有进行中的待分批，拒绝新资料
    if (session.albumGroups.length >= MAX_GROUPS && session.pendingAlbumMedia.length === 0) {
      await ctx.reply(`⚠️ 单次相册最多 ${MAX_GROUPS} 组资料，请点击“完成生成”。`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ 完成生成', 'finish_album')],
        [Markup.button.callback('❌ 退出', 'cancel_album_maker')]
      ]));
      return;
    }

    let fileId: string | undefined;
    let caption: string | undefined;
    const message = ctx.message as any;
    const mediaGroupId = message?.media_group_id ? String(message.media_group_id) : undefined;
    const messageId = typeof message?.message_id === 'number' ? message.message_id : undefined;

    if (ctx.message) {
      if (mediaType === 'photo' && message.photo) {
        fileId = message.photo[message.photo.length - 1].file_id;
        caption = message.caption;
      } else if (mediaType === 'video' && message.video) {
        fileId = message.video.file_id;
        caption = message.caption;
      }
    }

    if (!fileId) return;

    // 按 Telegram 相册 ID 分组；单图各自一组，连甩多组也不会并在一起
    const groupKey = mediaGroupId || `single_${messageId || Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    session.pendingAlbumMedia.push({ fileId, mediaType, caption, groupKey, mediaGroupId: mediaGroupId || null });
    userSessions.set(userId, session);
    await db.saveUserSession(userId, session);

    const groupTimerKey = `${userId}:${groupKey}`;
    const existingGroupTimer = this.albumGroupTimeouts.get(groupTimerKey);
    if (existingGroupTimer) clearTimeout(existingGroupTimer);

    const groupTimer = setTimeout(async () => {
      this.albumGroupTimeouts.delete(groupTimerKey);
      try {
        let currentSession = userSessions.get(userId) || await db.getUserSession(userId);
        if (!currentSession?.pendingAlbumMedia?.length) return;
        if (!currentSession.albumGroups) currentSession.albumGroups = [];

        if (currentSession.albumGroups.length >= MAX_GROUPS) {
          currentSession.pendingAlbumMedia = currentSession.pendingAlbumMedia.filter((m: any) => m.groupKey !== groupKey);
          userSessions.set(userId, currentSession);
          await db.saveUserSession(userId, currentSession);
          return;
        }

        const n = this.flushPendingToGroup(currentSession, groupKey);
        if (n <= 0) return;
        userSessions.set(userId, currentSession);
        await db.saveUserSession(userId, currentSession);
        console.log(`📦 [相册分组] 用户 ${userId} 组 ${groupKey} 已入册，当前 ${currentSession.albumGroups.length}/${MAX_GROUPS}`);
        // 连发中不刷进度，等停手 READY_MS 再汇总
      } catch (err: any) {
        console.error(`[相册模式] ❌ 分组打包失败:`, err.message);
      }
    }, this.GROUP_SETTLE_MS);
    this.albumGroupTimeouts.set(groupTimerKey, groupTimer);

    // 连续发多组时不断重置；停手约 3.5 秒后只反馈一次：几组/几个文件 + 按钮
    const existingReady = this.albumReadyTimeouts.get(userId);
    if (existingReady) clearTimeout(existingReady);
    const readyTimer = setTimeout(async () => {
      this.albumReadyTimeouts.delete(userId);
      try {
        // 稍等组定时器收尾，避免刚停手时最后一组还在 pending
        await new Promise(r => setTimeout(r, 400));
        let currentSession = userSessions.get(userId) || await db.getUserSession(userId);
        if (!currentSession || currentSession.mode !== BotMode.AlbumMaker) {
          console.warn(`[相册] 汇总跳过：会话无效或已退出 mode=${currentSession?.mode}`);
          return;
        }
        if (currentSession.pendingAlbumMedia && currentSession.pendingAlbumMedia.length > 0) {
          this.flushPendingToGroup(currentSession);
          userSessions.set(userId, currentSession);
          await db.saveUserSession(userId, currentSession);
        }
        if (!(currentSession.albumGroups && currentSession.albumGroups.length > 0)) return;
        // 确保内存会话与最新组数一致
        if (userSessions) userSessions.set(userId, currentSession);
        await this.upsertAlbumCollectStatus(ctx.telegram, chatId, userId, currentSession);
      } catch (err: any) {
        console.error(`[相册模式] ❌ 汇总提示失败:`, err.message);
      }
    }, this.READY_MS);
    this.albumReadyTimeouts.set(userId, readyTimer);
  }

  static async handleMyAlbums(ctx: Context, db: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
    }

    try {
      const albums = await db.getUserAlbums(userId);
      await this.showAlbumList(ctx, db, albums, '🗂️ <b>我的相册列表</b>\n\n');
    } catch (error: any) {
      ErrorLogger.log('AlbumHandler.handleMyAlbums', error, userId);
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('❌ 列表加载失败').catch(() => {});
      }
    }
  }

  static async handleAllUserAlbums(ctx: Context, db: any): Promise<void> {
    const userId = ctx.from?.id;
    if (userId !== config.superAdminId) return;

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
    }

    try {
      const albums = await db.getAllAlbums();
      await this.showAlbumList(ctx, db, albums, '👥 <b>所有用户相册 (管理员)</b>\n\n');
    } catch (error: any) {
      ErrorLogger.log('AlbumHandler.handleAllUserAlbums', error, userId);
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('❌ 列表加载失败').catch(() => {});
      }
    }
  }

  private static async showAlbumList(ctx: Context, _db: any, albums: any[], title: string): Promise<void> {
    if (!albums || albums.length === 0) {
      const msg = '📭 暂无相册数据。';
      if (ctx.callbackQuery) {
        await ctx.editMessageText(msg, Markup.inlineKeyboard([[Markup.button.callback('🔙 返回', 'start_album_maker')]]));
      } else {
        await ctx.reply(msg);
      }
      return;
    }

    let text = title;
    const buttons = [];
    const displayAlbums = albums.slice(0, 15);

    for (let i = 0; i < displayAlbums.length; i++) {
      const album = displayAlbums[i];
      if (!album) continue;

      const date = album.createdAt ? new Date(album.createdAt).toLocaleDateString('zh-CN') : '未知日期';
      const rawName = album.name || '未命名相册';
      const safeName = String(rawName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      text += `${i + 1}. <b>${safeName}</b> (${date})\n`;
      text += `🔗 链接: <code>${this.getAlbumBaseUrl()}/v/${album.id}</code>\n\n`;

      buttons.push([
        Markup.button.callback(`🗑️ 删除: ${safeName.substring(0, 12)}`, `delete_album_${album.id}`)
      ]);
    }

    text += `💡 提示：点击链接可复制。相册 ${ALBUM_EXPIRE_DAYS} 天后自动清理，且不进入资料备份。`;

    const finalKeyboard = Markup.inlineKeyboard([
      ...buttons,
      [Markup.button.callback('🔙 返回', 'start_album_maker')]
    ]);

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...finalKeyboard });
      } catch (err: any) {
        if (!(err.message && err.message.includes('message is not modified'))) {
          throw err;
        }
      }
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...finalKeyboard });
    }
  }

  static async handleDeleteAlbum(ctx: Context, db: any, albumId: string): Promise<void> {
    try {
      const album = await db.getAlbum(albumId);
      if (album) {
        const albumPath = path.join(process.cwd(), 'data/public/albums', albumId);
        if (fs.existsSync(albumPath)) {
          fs.rmSync(albumPath, { recursive: true, force: true });
        }
        await db.deleteAlbum(albumId);

        if (ctx.callbackQuery) {
          await ctx.answerCbQuery('✅ 相册已删除').catch(() => {});
        }

        const userId = ctx.from?.id;
        if (userId) {
          const albums = await db.getUserAlbums(userId);
          await this.showAlbumList(ctx, db, albums, '🗂️ <b>我的相册列表</b>\n\n');
        }
      } else if (ctx.callbackQuery) {
        await ctx.answerCbQuery('❌ 相册不存在').catch(() => {});
      }
    } catch (error) {
      console.error('删除相册失败:', error);
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('❌ 删除失败').catch(() => {});
      }
    }
  }

  private static processingUsers: Set<number> = new Set();

  private static resolveDownloadUrl(fileLinkHref: string): string {
    let downloadUrl = fileLinkHref;
    const apiRoot = process.env.TELEGRAM_API_ROOT;
    if (apiRoot && apiRoot !== 'https://api.telegram.org') {
      downloadUrl = downloadUrl.replace('https://api.telegram.org', apiRoot);
    }
    return downloadUrl;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private static async downloadTelegramFileOnce(
    ctx: Context,
    fileId: string,
    savePath: string
  ): Promise<void> {
    if (fs.existsSync(savePath)) {
      try { fs.unlinkSync(savePath); } catch {}
    }

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const downloadUrl = this.resolveDownloadUrl(fileLink.href);
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      httpsAgent: this.httpsAgent,
      timeout: 600000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 300
    });

    const writer = fs.createWriteStream(savePath);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: any) => {
        if (settled) return;
        settled = true;
        try { response.data.destroy(); } catch {}
        try { writer.destroy(); } catch {}
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        try {
          const size = fs.existsSync(savePath) ? fs.statSync(savePath).size : 0;
          if (size <= 0) {
            fail(new Error('下载文件为空'));
            return;
          }
          resolve();
        } catch (e) {
          fail(e);
        }
      };

      response.data.on('error', fail);
      writer.on('error', fail);
      writer.on('finish', ok);
      response.data.pipe(writer);
    });
  }

  /** 带重试的下载：网络抖动/限流时自动重试（占用全局下载槽） */
  private static async downloadTelegramFile(
    ctx: Context,
    fileId: string,
    savePath: string,
    maxAttempts: number = 3
  ): Promise<void> {
    await this.acquireGlobalDownloadSlot();
    try {
      let lastError: any;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.downloadTelegramFileOnce(ctx, fileId, savePath);
          return;
        } catch (err: any) {
          lastError = err;
          if (fs.existsSync(savePath)) {
            try { fs.unlinkSync(savePath); } catch {}
          }
          const msg = err?.message || String(err);
          console.warn(`[相册下载] 第${attempt}/${maxAttempts}次失败: ${msg}`);
          // 文件过大（Bot API 约 20MB 上限）无需重试
          if (/file is too big|FILE_TOO_BIG|too large/i.test(msg)) break;
          if (attempt < maxAttempts) {
            await this.sleep(800 * attempt + Math.floor(Math.random() * 400));
          }
        }
      }
      throw lastError || new Error('下载失败');
    } finally {
      this.releaseGlobalDownloadSlot();
    }
  }

  /** 全局并发池：跨组同时下载 */
  private static async runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    if (items.length === 0) return;
    let nextIndex = 0;
    let done = 0;
    const total = items.length;
    const runners = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= total) break;
        await worker(items[i], i);
        done++;
        if (onProgress) onProgress(done, total);
      }
    });
    await Promise.all(runners);
  }

  static async handleFinish(ctx: Context, db: any, userSessions?: Map<number, UserSession>): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    if (this.processingUsers.has(userId)) {
      await ctx.reply('⚠️ 您已有相册正在后台生成中，请稍候完成后再试。\n💡 期间可正常使用搜索/发布等其它功能。');
      return;
    }

    // 清理所有分组/汇总定时器，立刻把 pending 并入组
    this.clearAlbumTimers(userId);

    const session = (userSessions && userSessions.get(userId)) || await db.getUserSession(userId);
    if (!session) {
      await ctx.reply('❌ 会话已失效，请重新开始制作相册。');
      return;
    }

    this.flushPendingToGroup(session);

    if (!session.albumGroups || session.albumGroups.length === 0) {
      await ctx.reply('❌ 您还没有添加任何资料，请先发送资料。');
      return;
    }

    // 快照数据后立刻退出相册模式，避免阻塞搜索/发布等其它功能
    let finalGroupsData = JSON.parse(JSON.stringify(session.albumGroups));
    const albumName = session.albumName || `未命名相册_${Date.now().toString().slice(-4)}`;
    const userFirstName = ctx.from?.first_name || '未知';
    const groupCount = finalGroupsData.length;
    const fileCount = this.countAlbumFiles(finalGroupsData);

    if (finalGroupsData.length > MAX_GROUPS) {
      await ctx.reply(`⚠️ 共 ${finalGroupsData.length} 组资料，已超过上限，仅生成前 ${MAX_GROUPS} 组。`);
      finalGroupsData = finalGroupsData.slice(0, MAX_GROUPS);
    }

    if (userSessions) userSessions.delete(userId);
    await db.clearUserSession(userId);
    this.albumStatusMsgId.delete(userId);

    this.processingUsers.add(userId);
    // 一点生成就先报组数/文件数，不再依赖停手汇总
    const statusMsg = await ctx.reply(
      `🚀 <b>相册已转入后台生成</b>\n` +
      `📦 已确认 <b>${groupCount}</b> 组 / <b>${fileCount}</b> 个文件\n` +
      `📊 准备下载中...\n` +
      `💡 期间可正常使用搜索、发布、上传等。`,
      { parse_mode: 'HTML' }
    );

    const telegram = ctx.telegram;

    // 后台执行：不阻塞 Telegraf 主循环
    setImmediate(() => {
      this.runAlbumGenerationInBackground({
        telegram,
        db,
        userId,
        chatId,
        statusMessageId: statusMsg.message_id,
        albumName,
        userFirstName,
        finalGroupsData
      }).catch(async (error: any) => {
        ErrorLogger.log('AlbumHandler.backgroundGenerate', error, userId);
        try {
          await telegram.sendMessage(chatId, `❌ 生成相册失败，请重试: ${error?.message || error}`);
        } catch {}
      }).finally(() => {
        this.processingUsers.delete(userId);
      });
    });
  }

  private static async runAlbumGenerationInBackground(opts: {
    telegram: Context['telegram'];
    db: any;
    userId: number;
    chatId: number;
    statusMessageId: number;
    albumName: string;
    userFirstName: string;
    finalGroupsData: any[];
  }): Promise<void> {
    const { telegram, db, userId, chatId, statusMessageId, albumName, userFirstName } = opts;
    let finalGroupsData = opts.finalGroupsData;

    const albumId = `album_${uuidv4().slice(0, 8)}`;
    const albumBaseDir = path.join(process.cwd(), 'data/public/albums', albumId);

    type DlTask = {
      groupIndex: number;
      fileIdx: number;
      file: any;
      savePath: string;
      relativeId: string;
      type: 'photo' | 'video';
    };

    const groupResults: Array<Array<{ id: string; type: string; order: number } | null>> = [];
    const allTasks: DlTask[] = [];

    for (let i = 0; i < finalGroupsData.length; i++) {
      const group = finalGroupsData[i];
      const videoDir = path.join(albumBaseDir, `group_${i + 1}`, 'videos');
      const photoDir = path.join(albumBaseDir, `group_${i + 1}`, 'photos');
      if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
      if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

      groupResults[i] = new Array(group.files.length).fill(null);

      for (let fileIdx = 0; fileIdx < group.files.length; fileIdx++) {
        const file = group.files[fileIdx];
        const uniqueId = `${i}_${fileIdx}_${String(file.id).substring(String(file.id).length - 8)}`;
        if (file.type === 'video') {
          const fileName = `video_${uniqueId}.mp4`;
          allTasks.push({
            groupIndex: i,
            fileIdx,
            file,
            savePath: path.join(videoDir, fileName),
            relativeId: `group_${i + 1}/videos/${fileName}`,
            type: 'video'
          });
        } else {
          const fileName = `photo_${uniqueId}.jpg`;
          allTasks.push({
            groupIndex: i,
            fileIdx,
            file,
            savePath: path.join(photoDir, fileName),
            relativeId: `group_${i + 1}/photos/${fileName}`,
            type: 'photo'
          });
        }
      }
    }

    // 单人任务并发（默认提高到 12）；多人时还有全局上限保护
    const GLOBAL_CONCURRENCY = Math.max(1, parseInt(process.env.ALBUM_DOWNLOAD_CONCURRENCY || '12', 10) || 12);
    let lastProgressEdit = 0;
    const totalPlanned = allTasks.length;

    // 伪造一个轻量 ctx 供下载复用 getFileLink
    const fakeCtx = { telegram } as Context;

    const tryDownloadTask = async (task: DlTask, attempts: number) => {
      await this.downloadTelegramFile(fakeCtx, task.file.id, task.savePath, attempts);
      // 结果写入本任务私有数组，不会串到其他人
      groupResults[task.groupIndex][task.fileIdx] = {
        id: task.relativeId,
        type: task.type,
        order: task.fileIdx
      };
    };

    const updateProgress = (phase: string, done: number, total: number) => {
      const now = Date.now();
      if (done === total || done % 5 === 0 || now - lastProgressEdit > 2000) {
        lastProgressEdit = now;
        telegram.editMessageText(
          chatId,
          statusMessageId,
          undefined,
          `🚀 ${phase}\n` +
          `📦 ${finalGroupsData.length} 组 / ${totalPlanned} 个文件\n` +
          `📊 进度：${done}/${total}\n` +
          `⚡ 单人并发：${GLOBAL_CONCURRENCY} / 全局上限：${this.getGlobalDownloadLimit()}\n` +
          `💡 其它功能可正常使用`
        ).catch(() => {});
      }
    };

    console.log(`[相册后台] 用户 ${userId} 开始生成 ${albumId}，组数=${finalGroupsData.length}，文件=${totalPlanned}`);

    await this.runPool(allTasks, GLOBAL_CONCURRENCY, async (task) => {
      try {
        await tryDownloadTask(task, 3);
      } catch (err: any) {
        console.error(`❌ 首轮失败 (组${task.groupIndex + 1}, 文件${task.fileIdx + 1}):`, err.message);
      }
    }, (done, total) => updateProgress('后台下载中...', done, total));

    const failedTasks = allTasks.filter(t => !groupResults[t.groupIndex][t.fileIdx]);
    if (failedTasks.length > 0) {
      await telegram.editMessageText(
        chatId,
        statusMessageId,
        undefined,
        `♻️ 正在补下失败文件：0/${failedTasks.length}`
      ).catch(() => {});

      await this.runPool(failedTasks, Math.min(3, GLOBAL_CONCURRENCY), async (task) => {
        try {
          await tryDownloadTask(task, 4);
        } catch (err: any) {
          console.error(`❌ 补下仍失败 (组${task.groupIndex + 1}, 文件${task.fileIdx + 1}):`, err.message);
        }
      }, (done, total) => updateProgress('后台补下中...', done, total));
    }

    const finalGroups = [];
    let successCount = 0;
    for (let i = 0; i < finalGroupsData.length; i++) {
      const processedFiles = (groupResults[i] || []).filter(
        (f): f is { id: string; type: string; order: number } => !!f
      );
      successCount += processedFiles.length;
      if (processedFiles.length === 0) {
        console.warn(`⚠️ 第 ${i + 1} 组全部下载失败，已跳过`);
        continue;
      }
      finalGroups.push({
        id: `group_${i + 1}`,
        caption: finalGroupsData[i].caption,
        files: processedFiles.map(({ id, type }) => ({ id, type }))
      });
    }

    const failCount = totalPlanned - successCount;
    if (finalGroups.length === 0) {
      throw new Error('所有资料下载失败，请稍后重试（可能含超过20MB的视频，Bot无法下载）');
    }

    const albumData = { id: albumId, userId, name: albumName, groups: finalGroups, createdAt: new Date().toISOString() };
    const validation = AlbumDataValidator.validate(albumData);
    if (!validation.valid) throw new Error(validation.errors.join('；') || '数据不完整');

    await db.saveAlbum(albumId, albumData);

    const url = `${this.getAlbumBaseUrl()}/v/${albumId}`;
    const adminId = config.superAdminId;
    const totalFiles = successCount;

    if (userId !== adminId) {
      const adminMsg = `🔔 <b>新相册生成提醒</b>\n\n` +
                       `👤 用户: ${userFirstName} (ID: <code>${userId}</code>)\n` +
                       `🏷️ 名称: <b>${albumName}</b>\n` +
                       `📂 组数: ${finalGroups.length} / 资料: ${totalFiles}` +
                       (failCount > 0 ? `（失败 ${failCount}）` : '') + `\n` +
                       `⏳ ${ALBUM_EXPIRE_DAYS} 天后自动清除\n\n` +
                       `🔗 链接: <code>${url}</code>`;
      try {
        await telegram.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' });
      } catch (e) {
        console.error('通知管理员失败:', e);
      }
    }

    const qrBuffer = await qrcode.toBuffer(url);
    await telegram.deleteMessage(chatId, statusMessageId).catch(() => {});

    let caption = `✅ <b>相册制作成功！</b>\n\n` +
               `🏷️ 名称：<b>${albumName}</b>\n` +
               `📂 组数：${finalGroups.length}　资料：${totalFiles}/${totalPlanned}\n`;
    if (failCount > 0) {
      caption += `⚠️ 有 <b>${failCount}</b> 个文件下载失败（常见原因：视频超过20MB）\n`;
    }
    caption += `⏳ 将在 <b>${ALBUM_EXPIRE_DAYS} 天</b>后自动清除（不进入备份）\n\n` +
               `🔗 专属链接 (点击复制)：\n<code>${url}</code>`;

    await telegram.sendPhoto(chatId, { source: qrBuffer }, {
      caption,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🏠 返回主菜单', 'back_to_main')]])
    });
  }

  static async handleCancel(ctx: Context, db: any): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const pendingTimer = this.albumTimeouts.get(userId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.albumTimeouts.delete(userId);
    }
    await db.clearUserSession(userId);
    await ctx.reply('❌ 已退出相册制作模式。');
  }
}
