import { Context, Telegraf } from 'telegraf';
import { database } from '../../database';
import { UserSession, MediaItem } from '../../types';
import { config, getAdminChannelIds, getAdminPersistentChannelId, hasAdminChannelMap } from '../../config';
import { recordPublishEvent } from '../../services/publishAudit';
import { checkVaultAccess } from '../../services/vault';

export class UploadHandler {
  /** 同一 Telegram 相册内收齐等待（ms） */
  private static readonly GROUP_SETTLE_MS = 1600;
  /** 全部停手后弹出「选择频道」（ms） */
  private static readonly SESSION_READY_MS = 2800;
  /** key = `${userId}:${groupKey}` */
  private static groupTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private static sessionReadyTimeouts: Map<number, NodeJS.Timeout> = new Map();

  private static countBatches(pending: any[]): number {
    return new Set(pending.map(m => m.batchId || 'legacy')).size;
  }

  private static getOrCreateBatchId(session: UserSession, groupKey: string): string {
    const map = ((session as any).batchIdByGroup || {}) as Record<string, string>;
    if (!map[groupKey]) {
      map[groupKey] = `batch_${groupKey}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      (session as any).batchIdByGroup = map;
    }
    return map[groupKey];
  }

  /** 相册通常只有第一条带 caption：收齐后把本组文案写到组内每条，避免丢失/串组 */
  private static syncGroupCaption(pending: any[], groupKey: string): string | undefined {
    const items = pending.filter((m: any) => m.groupKey === groupKey);
    if (items.length === 0) return undefined;
    const groupCaption = items.find((m: any) => m.caption && String(m.caption).trim())?.caption?.trim();
    for (const m of items) {
      m.groupCaption = groupCaption || undefined;
      // 保证组内至少有一条带 caption，供发布/搜索取「本组文案」
      if (groupCaption && !m.caption) {
        // 不给每条都写 caption（避免单发时刷屏），只记 groupCaption；发布时按组取
      }
    }
    // 把文案落到组内第一条（有 caption 的优先已有；否则补到第一条）
    if (groupCaption) {
      const hasAny = items.some((m: any) => m.caption && String(m.caption).trim());
      if (!hasAny) items[0].caption = groupCaption;
    }
    return groupCaption;
  }

  /** 按 batch 顺序生成文案预览（每组各自一条，不会串成第一组） */
  private static buildGroupCaptionSummary(pending: any[]): string {
    const order: string[] = [];
    const byBatch = new Map<string, any[]>();
    for (const m of pending) {
      const b = m.batchId || 'legacy';
      if (!byBatch.has(b)) {
        byBatch.set(b, []);
        order.push(b);
      }
      byBatch.get(b)!.push(m);
    }
    const lines: string[] = [];
    order.forEach((b, idx) => {
      const items = byBatch.get(b)!;
      const cap =
        items.find((m: any) => m.groupCaption && String(m.groupCaption).trim())?.groupCaption ||
        items.find((m: any) => m.caption && String(m.caption).trim())?.caption ||
        '';
      const preview = String(cap).replace(/\s+/g, ' ').trim();
      const short = preview.length > 40 ? preview.slice(0, 40) + '…' : preview;
      lines.push(
        short
          ? `${idx + 1}. ${items.length}个文件 — <i>${this.escapeHtml(short)}</i>`
          : `${idx + 1}. ${items.length}个文件 — <i>(无文案)</i>`
      );
    });
    // 预览太长时截断
    if (lines.length <= 12) return lines.join('\n');
    return lines.slice(0, 12).join('\n') + `\n…共 ${lines.length} 组`;
  }

  private static escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private static itemCaption(media: any): string | undefined {
    const c = (media.caption || media.groupCaption || '').trim();
    return c || undefined;
  }

  static async handleKeywordInput(
    ctx: Context, 
    keyword: string, 
    userSessions: Map<number, UserSession>, 
    db: typeof database
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId);
    if (!session || !(session.mode === 'upload' || session.mode === 'add_review')) return;

    session.currentKeyword = keyword;
    session.step = 'waiting_media';
    session.pendingMedia = [];
    (session as any).batchIdByGroup = {};
    (session as any).currentBatchId = undefined;
    
    userSessions.set(userId, session);
    await db.saveUserSession(userId, session);

    await ctx.reply(
      `📤 上传模式\n\n` +
      `关键词: "${keyword}"\n\n` +
      `请上传媒体文件（支持图片、视频、文档、音频等）：\n\n` +
      `💡 可连续甩多组相册，机器人会按 Telegram 相册自动分组，不会并成一组。\n` +
      `💡 发完后稍等片刻，再点「选择频道」。`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'cancel' }]] } }
    );
  }

  static async handleMediaMessage(
    ctx: Context, 
    mediaType: string, 
    userSessions: Map<number, UserSession>, 
    db: typeof database
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId);
    // 🚀 优化：允许在等待媒体、选择频道、确认中等多个阶段继续收集媒体，防止网络延迟导致丢包
    const allowedSteps = ['waiting_media', 'selecting_channel', 'confirming'];
    const allowedModes = ['upload', 'add_review'];
    if (!session || !allowedModes.includes(session.mode) || !allowedSteps.includes(session.step)) {
      return;
    }

    if (!session.pendingMedia) {
      session.pendingMedia = [];
    }

    let fileId: string | undefined;
    let caption: string | undefined;
    const msg: any = ctx.message;
    const mediaGroupId: string | undefined = msg?.media_group_id
      ? String(msg.media_group_id)
      : undefined;
    const messageId: number | undefined = typeof msg?.message_id === 'number' ? msg.message_id : undefined;

    if (ctx.message) {
      switch (mediaType) {
        case 'photo':
          if ('photo' in ctx.message && ctx.message.photo) {
            const photo = ctx.message.photo;
            if (photo.length > 0) {
              fileId = photo[photo.length - 1].file_id;
              caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
            }
          }
          break;
        case 'video':
          if ('video' in ctx.message && ctx.message.video) {
            const video = ctx.message.video;
            fileId = video.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'document':
          if ('document' in ctx.message && ctx.message.document) {
            const document = ctx.message.document;
            fileId = document.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'audio':
          if ('audio' in ctx.message && ctx.message.audio) {
            const audio = ctx.message.audio;
            fileId = audio.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'voice':
          if ('voice' in ctx.message && ctx.message.voice) {
            const voice = ctx.message.voice;
            fileId = voice.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'animation':
          if ('animation' in ctx.message && ctx.message.animation) {
            const animation = ctx.message.animation;
            fileId = animation.file_id;
            caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
          }
          break;
        case 'video_note':
          if ('video_note' in ctx.message && ctx.message.video_note) {
            const video_note = ctx.message.video_note;
            fileId = video_note.file_id;
            caption = undefined; // 视频动态没有caption
          }
          break;
      }
    }

    if (fileId) {
      // 确保caption不为空字符串
      const cleanCaption = caption && caption.trim().length > 0 ? caption.trim() : undefined;
      // Telegram 相册用 media_group_id；单图/单视频各自一组，避免和别的并在一起
      const groupKey = mediaGroupId || `single_${messageId || Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const batchId = this.getOrCreateBatchId(session, groupKey);
      
      session.pendingMedia.push({
        file_id: fileId,
        file_type: mediaType,
        caption: cleanCaption,
        batchId,
        mediaGroupId: mediaGroupId || null,
        groupKey
      });

      userSessions.set(userId, session);
      await db.saveUserSession(userId, session);

      const groupTimerKey = `${userId}:${groupKey}`;
      const existingGroupTimer = this.groupTimeouts.get(groupTimerKey);
      if (existingGroupTimer) clearTimeout(existingGroupTimer);

      // 仅等待「当前这一组相册」收齐，不影响其它组
      const groupTimer = setTimeout(() => {
        this.groupTimeouts.delete(groupTimerKey);
        const cur = userSessions.get(userId);
        if (!cur?.pendingMedia) return;
        const groupCap = this.syncGroupCaption(cur.pendingMedia, groupKey);
        const n = cur.pendingMedia.filter((m: any) => m.groupKey === groupKey).length;
        const batchCount = this.countBatches(cur.pendingMedia);
        console.log(
          `📦 [上传分组] 用户 ${userId} 组 ${groupKey} 收齐 ${n} 个 | 文案="${(groupCap || '').slice(0, 40)}" | 当前共 ${batchCount} 组 / ${cur.pendingMedia.length} 文件`
        );
        userSessions.set(userId, cur);
      }, this.GROUP_SETTLE_MS);
      this.groupTimeouts.set(groupTimerKey, groupTimer);

      // 全部停手后再提示选频道（连甩多组时不会中途乱弹）
      const existingReady = this.sessionReadyTimeouts.get(userId);
      if (existingReady) clearTimeout(existingReady);

      const readyTimer = setTimeout(async () => {
        this.sessionReadyTimeouts.delete(userId);
        const currentSession = userSessions.get(userId);
        if (!currentSession || !(currentSession.mode === 'upload' || currentSession.mode === 'add_review') || !currentSession.pendingMedia) return;

        // 收尾：给每组再同步一次文案（防止定时器竞态）
        const keys = Array.from(new Set(currentSession.pendingMedia.map((m: any) => m.groupKey).filter(Boolean)));
        for (const gk of keys) this.syncGroupCaption(currentSession.pendingMedia, gk as string);
        userSessions.set(userId, currentSession);

        const total = currentSession.pendingMedia.length;
        const groups = this.countBatches(currentSession.pendingMedia);
        const captionSummary = this.buildGroupCaptionSummary(currentSession.pendingMedia);

        console.log(`📋 媒体收集完成 - 用户: ${userId}, ${groups} 组 / ${total} 文件`);

        const messageText =
          `📤 <b>上传模式</b>\n\n` +
          `✅ <b>资料收集完成</b>\n` +
          `• 关键词: <code>${currentSession.currentKeyword}</code>\n` +
          `• 已接收: <b>${groups}</b> 组 / <b>${total}</b> 个文件\n\n` +
          `<b>各组文案（各自独立，不会串组）：</b>\n${captionSummary}\n\n` +
          `💡 多组相册已自动分开，发布/搜索时每组用自己的文案。\n` +
          `请点击下方按钮选择目标频道：`;

        const sendFeedback = async (retries = 3) => {
          const targetId = ctx.from?.id || userId;
          for (let i = 0; i < retries; i++) {
            try {
              await ctx.telegram.sendMessage(targetId, messageText, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[{ text: '📢 选择频道', callback_data: 'select_channel' }]]
                }
              });
              return;
            } catch (error: any) {
              if (i === retries - 1) throw error;
              console.warn(`⚠️ 发送上传反馈失败 (ID: ${targetId})，正在进行第 ${i + 1} 次重试... 错误: ${error.message}`);
              await new Promise(r => setTimeout(r, 1500));
            }
          }
        };

        sendFeedback().catch(err => {
          console.error('❌ 发送上传反馈最终失败:', err.message);
        });
      }, this.SESSION_READY_MS);

      this.sessionReadyTimeouts.set(userId, readyTimer);
    }
  }

  static async handleChannelSelection(
    ctx: Context, 
    userSessions: Map<number, UserSession>,
    bot: Telegraf
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId);
    if (!session || !(session.mode === 'upload' || session.mode === 'add_review') || !session.pendingMedia || session.pendingMedia.length === 0) {
      return;
    }

    session.step = 'confirming';
    userSessions.set(userId, session);

    const adminChannelIds = hasAdminChannelMap(userId)
      ? getAdminChannelIds(userId)
      : await database.getManagedChannels();
    const channelButtons = await Promise.all(
      adminChannelIds.map(async channelId => 
        [{ text: await this.getChannelFullName(bot, channelId), callback_data: `upload_channel_${channelId}` }]
      )
    );
    channelButtons.push([{ text: '💾 仅保存到数据库', callback_data: 'save_only' }]);

    // 确认前再同步各组文案
    const gkeys = Array.from(new Set(session.pendingMedia.map((m: any) => m.groupKey).filter(Boolean)));
    for (const gk of gkeys) this.syncGroupCaption(session.pendingMedia, gk as string);

    const groupCount = this.countBatches(session.pendingMedia);
    const captionSummary = this.buildGroupCaptionSummary(session.pendingMedia);
    await ctx.reply(
      `📤 <b>上传确认</b>\n\n` +
      `关键词: <code>${session.currentKeyword}</code>\n` +
      `媒体: <b>${groupCount}</b> 组 / <b>${session.pendingMedia.length}</b> 个文件\n\n` +
      `<b>各组文案：</b>\n${captionSummary}\n\n` +
      `请选择操作：`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: channelButtons }
      }
    );
  }

  static async handleSaveOnly(
    ctx: Context, 
    userSessions: Map<number, UserSession>, 
    db: typeof database
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId);
    if (!session || !(session.mode === 'upload' || session.mode === 'add_review') || !session.pendingMedia || !session.currentKeyword) {
      return;
    }

    try {
      // 显示处理中消息
      const processingMsg = await ctx.reply('💾 正在保存并同步备份...');

      let savedCount = 0;
      const savedItems: MediaItem[] = []; // 🚀 记录以便后续备份
      const isReviewMode = session.pendingText === 'is_review_mode';

      for (const media of session.pendingMedia) {
        // 每组用自己的文案（caption / groupCaption），不会套用其它组
        let finalCaption = this.itemCaption(media) || '';
        if (session.pendingText && session.pendingText.trim() && !isReviewMode) {
          // pendingText 是用户额外补的总说明：只加到「本组有文案的那条」或每组第一条，避免污染整组
          const isGroupPrimary =
            !!media.caption ||
            session.pendingMedia.find((x: any) => x.batchId === media.batchId) === media;
          if (isGroupPrimary) {
            finalCaption = finalCaption
              ? finalCaption + '\n\n' + session.pendingText.trim()
              : session.pendingText.trim();
          }
        }

        const mediaItem: Omit<MediaItem, 'id'> = {
          keyword: session.currentKeyword,
          file_id: media.file_id,
          file_type: media.file_type as any,
          caption: finalCaption || undefined,
          uploaded_by: userId,
          uploaded_at: new Date().toISOString(),
          is_published: false,
          batchId: media.batchId || (session as any).currentBatchId || `batch_${Date.now()}`,
          is_review: isReviewMode 
        };

        const id = await db.saveMedia(mediaItem);
        savedItems.push({ ...mediaItem, id });
        savedCount++;
      }

      // 即使是「仅保存」，也强制发到金库并锁定 source_*（换 Token 可复活）
      const persistentChannelId = getAdminPersistentChannelId(userId);
      let vaultOk = false;
      let vaultError = '';
      if (persistentChannelId) {
        console.log(`📡 [影子备份] 正在同步 ${savedCount} 个文件到永久仓库 ${persistentChannelId}...`);
        try {
          await this.publishToChannel(ctx as any, persistentChannelId, savedItems, session.currentKeyword, db, {
            writeSource: true,
            forceSource: true,
            requireSuccess: true
          });
          vaultOk = true;
        } catch (e: any) {
          vaultError = e?.message || String(e);
          console.error('📡 [影子备份] 失败:', vaultError);
        }
      } else {
        vaultError = '未配置 PERSISTENT_CHANNEL_ID';
        console.warn('⚠️ 未配置 PERSISTENT_CHANNEL_ID，本次仅入库、无金库坐标，换 Token 后可能无法自愈');
      }

      // 清理会话
      userSessions.delete(userId);
      await db.clearUserSession(userId);

      // 如果是好评模式，触发全员推送
      if (isReviewMode) {
        this.broadcastReviewUpdate(ctx, db);
      }

      const groupCount = this.countBatches(savedItems);
      let completionText: string;
      if (isReviewMode) {
        completionText = vaultOk
          ? `✅ 好评记录已保存并完成备份！\n\n关键词: "${session.currentKeyword}"`
          : `⚠️ 好评已入库，但金库备份失败！\n\n关键词: "${session.currentKeyword}"\n原因: ${vaultError}\n\n请确认当前 bot 已是备份频道管理员后重试。`;
      } else if (vaultOk) {
        completionText =
          `✅ 资料已保存并完成同步备份！\n\n关键词: "${session.currentKeyword}"\n已备份 ${groupCount} 组 / ${savedCount} 个媒体文件。\n\n💡 即使换了 Token，这些资料也将永不丢失。`;
      } else {
        completionText =
          `⚠️ 资料已写入数据库，但金库备份失败（频道里不会有文件）！\n\n` +
          `关键词: "${session.currentKeyword}"\n` +
          `已入库 ${groupCount} 组 / ${savedCount} 个文件\n` +
          `金库: ${persistentChannelId || '未配置'}\n` +
          `原因: ${vaultError}\n\n` +
          `👉 把【当前这个】bot 加成备份频道管理员后，再上传一次或跑 vault:sync。`;
      }
      
      const completionKeyboard = { inline_keyboard: [[{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] };

      try {
        await ctx.telegram.editMessageText(ctx.chat?.id, processingMsg.message_id, undefined, completionText, { reply_markup: completionKeyboard });
      } catch (editError) {
        await ctx.reply(completionText, { reply_markup: completionKeyboard });
      }

    } catch (error) {
      console.error('保存媒体错误:', error);
      await ctx.reply('❌ 保存时发生错误，请稍后重试。');
    }
  }

  static async handleSaveAndPublish(
    ctx: Context, 
    userSessions: Map<number, UserSession>, 
    db: typeof database, 
    bot: Telegraf
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = userSessions.get(userId);
    if (!session || !(session.mode === 'upload' || session.mode === 'add_review') || !session.pendingMedia || !session.currentKeyword || !session.selectedChannel) {
      return;
    }

    try {
      // 显示处理中消息
      const processingMsg = await ctx.reply('💾📢 正在保存并发布...');

      console.log(`🔄 开始处理上传 - 用户: ${userId}, 关键词: ${session.currentKeyword}, 媒体数量: ${session.pendingMedia.length}`);

      let savedCount = 0;
      const mediaIds: number[] = [];
      const isReviewMode = session.pendingText === 'is_review_mode';

      // 保存到数据库
      console.log('📊 开始保存到数据库...');
      const savedItems: MediaItem[] = []; // 🚀 修改：记录保存成功的完整对象
      for (const media of session.pendingMedia) {
        try {
        const mediaItem: Omit<MediaItem, 'id'> = {
          keyword: session.currentKeyword,
          file_id: media.file_id,
          file_type: media.file_type as any,
          caption: (() => {
            // 本组原始 caption 优先；否则仅组内第一条补上 groupCaption，其它条保持空
            if (media.caption && String(media.caption).trim()) return String(media.caption).trim();
            const firstOfBatch = session.pendingMedia.find((x: any) => x.batchId === media.batchId);
            if (firstOfBatch === media) return this.itemCaption(media);
            return undefined;
          })(),
          channel_id: session.selectedChannel,
          uploaded_by: userId,
          uploaded_at: new Date().toISOString(),
          is_published: true,
          published_at: new Date().toISOString(),
          batchId: media.batchId || (session as any).currentBatchId || `batch_${Date.now()}`,
          is_review: isReviewMode 
        };

        const id = await db.saveMedia(mediaItem);
        savedItems.push({ ...mediaItem, id }); // 🚀 记录
        savedCount++;
          console.log(`✅ 已保存媒体 ${savedCount}/${session.pendingMedia.length}`);
        } catch (saveError) {
          console.error('❌ 保存单个媒体失败:', saveError);
        }
      }

      console.log('📢 开始发布到频道...');
      // 先发金库锁定 source_*，再发业务频道（业务频道不得覆盖金库坐标）
      const persistentChannelId = getAdminPersistentChannelId(userId);
      let vaultNote = '';
      if (persistentChannelId && persistentChannelId !== session.selectedChannel) {
        console.log(`📡 [影子备份] 发布前同步到永久仓库...`);
        try {
          await this.publishToChannel(bot, persistentChannelId, savedItems, session.currentKeyword, db, {
            writeSource: true,
            forceSource: true,
            requireSuccess: true
          });
          vaultNote = '\n📦 金库备份: 成功';
        } catch (e: any) {
          console.error('备份同步失败:', e.message);
          vaultNote = `\n⚠️ 金库备份失败: ${e.message}`;
        }
      }

      // 发布到目标频道：仅在尚无坐标时回填（例如未配金库）
      await this.publishToChannel(bot, session.selectedChannel, savedItems, session.currentKeyword, db, {
        writeSource: true,
        forceSource: persistentChannelId === session.selectedChannel,
        requireSuccess: true
      });

      recordPublishEvent({
        keyword: session.currentKeyword,
        userId,
        channelId: session.selectedChannel,
        source: 'save_and_publish',
        count: savedCount
      });

      // 清理会话
      userSessions.delete(userId);
      await db.clearUserSession(userId);

      // 🚀 新增：如果是好评模式，触发全员推送
      if (isReviewMode) {
        this.broadcastReviewUpdate(ctx, db);
      }

      // 编辑处理中消息为完成消息 (带错误捕获)
      const groupCount = this.countBatches(savedItems);
      const completionMsg = `✅ 保存并发布完成！\n\n` +
        `关键词: "${session.currentKeyword}"\n` +
        `频道: ${await this.getChannelName(bot, session.selectedChannel)}\n` +
        `已处理 ${groupCount} 组 / ${savedCount} 个媒体文件` +
        `${vaultNote}\n\n` +
        `💡 多组已分开发布，不会并成一组。`;
      const completionKbd = { inline_keyboard: [[{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]] };

      try {
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          processingMsg.message_id,
          undefined,
          completionMsg,
          { reply_markup: completionKbd }
      );
      } catch (editError) {
        await ctx.reply(completionMsg, { reply_markup: completionKbd });
      }

    } catch (error: any) {
      console.error('保存并发布错误:', error);
      
      // 清理会话，即使出错也要清理
      try {
        userSessions.delete(userId);
        await db.clearUserSession(userId);
      } catch (cleanupError) {
        console.error('清理会话失败:', cleanupError);
      }
      
      // 提供更具体的错误信息
      let errorMessage = '❌ 发布时发生错误，请稍后重试。';
      
      if (error.message?.includes('发布超时')) {
        errorMessage = '❌ 发布超时，可能是网络问题或媒体文件过多。\n\n💡 建议：\n1. 减少一次上传的文件数量\n2. 检查网络连接\n3. 稍后重试';
      } else if (error.message?.includes('无法发布到频道')) {
        errorMessage = `❌ ${error.message}\n\n💡 请确保：\n1. 机器人已添加到频道\n2. 机器人有发布权限\n3. 频道ID正确`;
      } else if (error.response?.error_code === 429) {
        errorMessage = '❌ 发布频率过快，请稍后重试。\n\n💡 建议：减少一次上传的文件数量';
      }
      
      await ctx.reply(errorMessage, { 
        reply_markup: { 
          inline_keyboard: [
            [{ text: '🏠 返回主菜单', callback_data: 'back_to_main' }]
          ] 
        } 
      });
    }
  }

  /** 金库归档：把一组资料发到永久备份频道并强制写入 source_* */
  static async archiveBatchToChannel(
    botOrCtx: Telegraf | Context,
    channelId: string,
    mediaList: MediaItem[],
    keyword: string,
    db: typeof database,
    options?: { forceSource?: boolean }
  ): Promise<{ sent: number; failed: number }> {
    return this.publishToChannel(botOrCtx, channelId, mediaList, keyword, db, {
      writeSource: true,
      forceSource: options?.forceSource !== false,
      requireSuccess: true
    });
  }

  private static async publishToChannel(
    botOrCtx: Telegraf | Context,
    channelId: string,
    mediaList: MediaItem[],
    keyword: string,
    db: typeof database,
    options?: { writeSource?: boolean; forceSource?: boolean; requireSuccess?: boolean }
  ): Promise<{ sent: number; failed: number }> {
    const telegram = (botOrCtx as any).telegram || (botOrCtx as any).tg || (botOrCtx as Context).telegram;
    const writeSource = options?.writeSource !== false;
    const forceSource = Boolean(options?.forceSource);
    const requireSuccess = Boolean(options?.requireSuccess);

    if (requireSuccess || forceSource) {
      const access = await checkVaultAccess(telegram, channelId);
      if (!access.ok) {
        const detail = [
          access.error || '无法访问目标聊天',
          access.hint,
          access.botUsername ? `当前 bot: @${access.botUsername}` : ''
        ].filter(Boolean).join(' | ');
        console.error(`❌ [发布预检失败] ${channelId}: ${detail}`);
        throw new Error(detail);
      }
      console.log(`✅ [发布预检] ${access.type}「${access.title}」bot=@${access.botUsername} status=${access.botStatus}`);
    }

    const batches: { [key: string]: MediaItem[] } = {};
    for (const item of mediaList) {
      const bId = item.batchId || `legacy_${item.id}`;
      if (!batches[bId]) batches[bId] = [];
      batches[bId].push(item);
    }
    const batchIds = Object.keys(batches);
    console.log(`📢 [上传发布] 关键词="${keyword}" 共 ${batchIds.length} 组 / ${mediaList.length} 文件 → 频道 ${channelId}`);

    let sent = 0;
    let failed = 0;
    for (let bi = 0; bi < batchIds.length; bi++) {
      const r = await this.publishOneBatch(telegram, channelId, batches[batchIds[bi]], keyword, db, {
        writeSource,
        forceSource
      });
      sent += r.sent;
      failed += r.failed;
      if (bi < batchIds.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    console.log(`📋 发送结束：成功 ${sent}，失败 ${failed}`);
    if (requireSuccess && sent === 0) {
      throw new Error(`全部发送失败（0/${mediaList.length}），目标 ${channelId}`);
    }
    if (requireSuccess && failed > 0 && sent < mediaList.length) {
      console.warn(`⚠️ 部分发送失败 ${failed}/${mediaList.length}`);
    }
    return { sent, failed };
  }

  /** 发布单个 batch（一组相册） */
  private static async publishOneBatch(
    telegram: any,
    channelId: string,
    batchItems: MediaItem[],
    keyword: string,
    db: typeof database,
    options?: { writeSource?: boolean; forceSource?: boolean }
  ): Promise<{ sent: number; failed: number }> {
    const writeSource = options?.writeSource !== false;
    const forceSource = Boolean(options?.forceSource);
    let sent = 0;
    let failed = 0;
    const recordSource = async (id: number, msgId: number) => {
      if (!writeSource) return;
      await db.updateMediaSource(id, channelId, msgId, { force: forceSource });
    };

    const groupedMedia = this.groupMediaByType(batchItems);
    const photoItems = groupedMedia['photo'] || [];
    const videoItems = groupedMedia['video'] || [];
    const documentItems = groupedMedia['document'] || [];
    const audioItems = groupedMedia['audio'] || [];
    const combinedMedia = [...photoItems, ...videoItems, ...documentItems, ...audioItems];

    if (combinedMedia.length > 0) {
      console.log(`📸 发送一组媒体 - ${combinedMedia.length} 个 (batch=${batchItems[0]?.batchId || 'n/a'})`);

      let captionIndex = 0;
      let mainCaption = '';
      for (let j = 0; j < combinedMedia.length; j++) {
        const c = (combinedMedia[j].caption || (combinedMedia[j] as any).groupCaption || '').trim();
        if (c) {
          captionIndex = j;
          mainCaption = c;
          break;
        }
      }

      if (combinedMedia.length <= 10) {
        try {
          const mediaGroup = combinedMedia.map((item, index) => ({
            type: item.file_type as any,
            media: item.file_id,
            caption: index === captionIndex ? mainCaption : undefined
          }));
          const sentMsgs = await telegram.sendMediaGroup(channelId, mediaGroup);
          for (let i = 0; i < sentMsgs.length; i++) {
            await recordSource(combinedMedia[i].id, sentMsgs[i].message_id);
            sent++;
          }
        } catch (error) {
          console.error('发送完整媒体组失败，降级为单个发送:', error);
          for (let i = 0; i < combinedMedia.length; i++) {
            try {
              const msg = await this.sendSingleMediaToChannel(telegram, channelId, combinedMedia[i], keyword);
              if (msg) {
                await recordSource(combinedMedia[i].id, msg.message_id);
                sent++;
              } else {
                failed++;
              }
            } catch (singleError) {
              failed++;
              console.error(`发送单个媒体 ${i + 1} 错误:`, singleError);
            }
          }
        }
      } else {
        const chunks = this.chunkArray(combinedMedia, 10);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          try {
            const mediaGroup = chunk.map((item, index) => ({
              type: item.file_type as any,
              media: item.file_id,
              caption: (i === 0 && index === captionIndex) ? mainCaption : undefined
            }));
            const sentMsgs = await telegram.sendMediaGroup(channelId, mediaGroup);
            for (let k = 0; k < sentMsgs.length; k++) {
              await recordSource(chunk[k].id, sentMsgs[k].message_id);
              sent++;
            }
            if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000));
          } catch (error) {
            console.error(`发送媒体组 ${i + 1} 失败:`, error);
            failed += chunk.length;
          }
        }
      }
    }

    const voiceItems = groupedMedia['voice'] || [];
    for (const item of voiceItems) {
      try {
        const msg = await this.sendSingleMediaToChannel(telegram, channelId, item, keyword);
        if (msg) {
          await recordSource(item.id, msg.message_id);
          sent++;
        } else {
          failed++;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        failed++;
        console.error('发送语音消息错误:', error);
      }
    }

    return { sent, failed };
  }

  private static async sendSingleMediaToChannel(telegram: any, channelId: string, item: any, keyword?: string): Promise<any> {
    const caption = this.buildCaption(keyword || '', item.caption);
    
    switch (item.file_type) {
      case 'photo':
        return await telegram.sendPhoto(channelId, item.file_id, { caption });
      case 'video':
        return await telegram.sendVideo(channelId, item.file_id, { caption });
      case 'document':
        return await telegram.sendDocument(channelId, item.file_id, { caption });
      case 'audio':
        return await telegram.sendAudio(channelId, item.file_id, { caption });
      case 'voice':
        return await telegram.sendVoice(channelId, item.file_id, { caption });
      case 'animation':
        return await telegram.sendAnimation(channelId, item.file_id, { caption });
      case 'video_note':
        return await telegram.sendVideoNote(channelId, item.file_id);
      default:
        return null;
    }
  }

  private static groupMediaByType(mediaList: any[]): { [key: string]: any[] } {
    const grouped: { [key: string]: any[] } = {};
    
    mediaList.forEach(item => {
      if (!grouped[item.file_type]) {
        grouped[item.file_type] = [];
      }
      grouped[item.file_type].push(item);
    });
    
    return grouped;
  }

  private static chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private static async getChannelName(bot: Telegraf, channelId: string): Promise<string> {
    try {
      const chat = await bot.telegram.getChat(channelId);
      if ('title' in chat) {
        return chat.title;
      } else if ('first_name' in chat) {
        return chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
      }
      return `📢 频道 ${channelId}`;
    } catch (error) {
      console.error(`获取频道名称失败 ${channelId}:`, error);
      return `📢 频道 ${channelId}`;
    }
  }

  private static async getChannelFullName(bot: Telegraf, channelId: string): Promise<string> {
    try {
      const chat = await bot.telegram.getChat(channelId);
      if ('title' in chat) {
        return `${chat.title} - 功能正常`;
      } else if ('first_name' in chat) {
        const name = chat.first_name + (chat.last_name ? ` ${chat.last_name}` : '');
        return `${name} - 功能正常`;
      }
      return `📢 频道 ${channelId}`;
    } catch (error) {
      console.error(`获取频道完整名称失败 ${channelId}:`, error);
      return `📢 频道 ${channelId}`;
    }
  }

  private static buildCaption(keyword: string, originalCaption?: string): string {
    console.log(`🔍 buildCaption调用 - keyword: "${keyword}", originalCaption: "${originalCaption}"`);
    
    // 只返回原始说明，不添加关键词标签
    const result = originalCaption || '';
    
    console.log(`📝 buildCaption结果: "${result}"`);
    return result;
  }

  /**
   * 🚀 新增：群发好评库更新通知给所有活跃用户
   */
  private static async broadcastReviewUpdate(ctx: Context, db: typeof database): Promise<void> {
    try {
      const users = await db.getAllActiveUsers();
      if (users.length === 0) return;

      const broadcastMsg = "资料好评库已经更新  请点击 “查看资料” 好评库 查看详情好评";
      
      console.log(`📢 [好评库群发] 开始推送给 ${users.length} 个活跃用户...`);
      
      // 异步执行，不阻塞当前的保存/发布流程
      setImmediate(async () => {
        let successCount = 0;
        let blockedCount = 0;
        const adminId = config.superAdminId;

        for (const user of users) {
          try {
            await ctx.telegram.sendMessage(user.id, broadcastMsg);
            successCount++;
            
            // 🚀 频率限制保护
            await new Promise(resolve => setTimeout(resolve, 50)); 
          } catch (e: any) {
            // 🚀 核心逻辑：如果用户拉黑了机器人
            if (e.message && (e.message.includes('blocked') || e.message.includes('Forbidden') || e.code === 403)) {
              blockedCount++;
              // 1. 从数据库移除该活跃用户
              await db.removeUser(user.id);
              // 2. 提醒管理员
              const userDisplay = user.username ? `@${user.username}` : (user.first_name || '未知用户');
              await ctx.telegram.sendMessage(adminId, `🗑️ **用户已失效**\n\n用户 \`${userDisplay}\` (ID: \`${user.id}\`) 已拉黑机器人，已自动将其从活跃列表中移除。`, { parse_mode: 'Markdown' }).catch(() => {});
            }
          }
        }
        console.log(`📢 [好评库群发] 推送完成: 成功 ${successCount}/${users.length}, 移除拉黑用户 ${blockedCount} 个`);
      });
    } catch (error) {
      console.error('好评库群发初始化失败:', error);
    }
  }
}
