import { Context, Markup } from 'telegraf';
import { database } from '../../database';
import { BotMode, UserSession } from '../../types';
import { SearchHandler } from './SearchHandler';
import { config } from '../../config';

export class TagFilterHandler {
  // 启动标签筛选模式
  static async handleStart(ctx: Context, db: typeof database): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session: UserSession = {
      userId,
      mode: BotMode.TagFilter,
      step: 'waiting_keyword'
    };

    await db.saveUserSession(userId, session);

    const recommendedTags = await db.getRecommendedTags();
    const isAdmin = userId === config.superAdminId;

    let text = '🏷️ <b>标签筛选模式已激活</b>\n\n' +
               '请直接输入想要筛选的<b>标签或关键字</b>（支持模糊搜索）：\n' +
               '例如：<code>W⬆️</code>、<code>静安</code>、<code>VIP</code>\n\n' +
               '💡 系统将扫描所有资料文案并列出匹配的关键词。';

    const buttons = [];
    
    // 生成推荐标签按钮（每行3个）
    if (recommendedTags.length > 0) {
      text += '\n\n推荐标签：';
      for (let i = 0; i < recommendedTags.length; i += 3) {
        const row = recommendedTags.slice(i, i + 3).map(tag => 
          Markup.button.callback(tag, `tag_select_${tag}`)
        );
        buttons.push(row);
      }
    }

    // 管理员功能按钮
    if (isAdmin) {
      buttons.push([Markup.button.callback('🔧 管理推荐标签', 'admin_manage_tags')]);
    }

    buttons.push([Markup.button.callback('❌ 退出筛选模式', 'cancel_tag_filter')]);

    const keyboard = Markup.inlineKeyboard(buttons);

    try {
      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      }
    } catch (e) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  }

  // 处理用户输入的标签
  static async handleTagInput(ctx: Context, db: typeof database, tag: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const statusMsg = await ctx.reply(`🔍 正在扫描文案包含 "${tag}" 的资料...`);

    try {
      // 1. 获取所有媒体
      const allMedia = await db.getAllMedia();
      
      // 2. 模糊匹配文案并记录每个关键词的最新信息
      const searchTag = tag.toLowerCase();
      // 存储格式: { keyword: { time: number, maxId: number } }
      const keywordStatsMap = new Map<string, { time: number, maxId: number }>();
      
      allMedia.forEach(m => {
        const caption = m.caption || '';
        // 🚀 核心修复：标准化处理
        const normalizedCaption = caption.toLowerCase().replace(/\uFE0F/g, '');
        const normalizedTag = tag.toLowerCase().replace(/\uFE0F/g, '');
        
        // 1. 针对 "W⬆️" 的精准排除逻辑（使用排除法）
        let testCaption = normalizedCaption;
        if (normalizedTag === 'w⬆') {
          // 🚀 彻底排除带 5、五 或 外 的长标签及其变体（含空格）
          testCaption = testCaption
            .replace(/5\s*外\s*w\s*⬆/g, '')
            .replace(/5\s*w\s*⬆/g, '')
            .replace(/五\s*外\s*w\s*⬆/g, '')
            .replace(/五\s*w\s*⬆/g, '')
            .replace(/外\s*w\s*⬆/g, '');
        }

        // 2. 检查剩余文案中是否还包含目标标签
        if (!testCaption.includes(normalizedTag)) return;

        const currentTime = m.uploaded_at ? new Date(m.uploaded_at).getTime() : 0;
        const currentId = m.id || 0;
        
        const existing = keywordStatsMap.get(m.keyword);
        if (!existing || currentTime > existing.time || (currentTime === existing.time && currentId > existing.maxId)) {
          keywordStatsMap.set(m.keyword, { 
            time: isNaN(currentTime) ? 0 : currentTime, 
            maxId: currentId 
          });
        }
      });

      // 3. 核心排序：最新上传在前，时间相同则按ID倒序
      const sortedKeywords = Array.from(keywordStatsMap.entries())
        .sort((a, b) => {
          // 先比较时间
          if (b[1].time !== a[1].time) {
            return b[1].time - a[1].time;
          }
          // 时间相同时比较 ID
          return b[1].maxId - a[1].maxId;
        })
        .map(entry => entry[0]);

      if (sortedKeywords.length === 0) {
        await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined, 
          `❌ 未找到文案中包含 "${tag}" 的资料。\n\n请尝试输入其他标签：`, 
          Markup.inlineKeyboard([
            [Markup.button.callback('🔙 换个标签', 'start_tag_filter')],
            [Markup.button.callback('❌ 退出模式', 'cancel_tag_filter')]
          ])
        );
        return;
      }

      // 4. 生成关键词按钮矩阵（每行3个，最多显示90个）
      const displayKeywords = sortedKeywords.slice(0, 90);
      const buttons = [];
      for (let i = 0; i < displayKeywords.length; i += 3) {
        const row = displayKeywords.slice(i, i + 3).map(kw => 
          Markup.button.callback(kw.substring(0, 12), `tag_view_${kw}`)
        );
        buttons.push(row);
      }

      buttons.push([
        Markup.button.callback('🔙 换个标签搜', 'start_tag_filter'),
        Markup.button.callback('❌ 退出', 'cancel_tag_filter')
      ]);

      await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined,
        `✅ 找到 ${sortedKeywords.length} 个匹配关键词：\n` +
        `🏷️ 标签: <b>${tag}</b>\n\n` +
        `💡 排序: <b>最新上传在前</b>\n` +
        `👇 点击下方按钮查看资料：`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
      );

    } catch (error) {
      console.error('标签筛选搜索失败:', error);
      await ctx.reply('❌ 搜索过程中发生错误。');
    }
  }

  // 管理员管理标签页面
  static async handleAdminManageTags(ctx: Context, db: typeof database): Promise<void> {
    const userId = ctx.from?.id;
    if (userId !== config.superAdminId) return;

    const tags = await db.getRecommendedTags();
    let text = '🔧 <b>管理推荐标签</b>\n\n' +
               '当前预设标签：\n' +
               (tags.length > 0 ? tags.map((t, i) => `${i+1}. <code>${t}</code>`).join('\n') : '暂无标签') + '\n\n' +
               '请选择操作：';

    const buttons = [
      [Markup.button.callback('➕ 添加新标签', 'admin_add_tag')],
      [Markup.button.callback('➖ 删除标签', 'admin_del_tag_list')],
      [Markup.button.callback('🔙 返回筛选', 'start_tag_filter')]
    ];

    const keyboard = Markup.inlineKeyboard(buttons);

    try {
      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      }
    } catch (e) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  }

  // 处理管理员添加标签
  static async handleAdminAddTagPrompt(ctx: Context): Promise<void> {
    const text = '📝 请直接输入要添加的标签名称：\n(如：5⬆️)';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'admin_manage_tags')]]);
    
    try {
      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, keyboard);
      } else {
        await ctx.reply(text, keyboard);
      }
    } catch (e) {
      await ctx.reply(text, keyboard);
    }
  }

  static async handleAdminAddTag(ctx: Context, db: typeof database, tag: string): Promise<void> {
    const tags = await db.getRecommendedTags();
    const userId = ctx.from?.id;
    
    if (!tags.includes(tag)) {
      tags.push(tag);
      await db.saveRecommendedTags(tags);
      await ctx.reply(`✅ 已成功添加推荐标签: ${tag}`);
    } else {
      await ctx.reply('❌ 该标签已存在。');
    }

    // 清除正在添加标签的状态，恢复到模式内
    if (userId) {
      const session = await db.getUserSession(userId);
      if (session) {
        session.pendingText = undefined;
        await db.saveUserSession(userId, session);
      }
    }

    await this.handleAdminManageTags(ctx, db);
  }

  // 删除标签列表
  static async handleAdminDelTagList(ctx: Context, db: typeof database): Promise<void> {
    const tags = await db.getRecommendedTags();
    if (tags.length === 0) {
      await ctx.answerCbQuery('❌ 暂无可删除的标签');
      return;
    }

    const buttons = tags.map(tag => [Markup.button.callback(`🗑️ 删除 ${tag}`, `admin_del_tag_do_${tag}`)]);
    buttons.push([Markup.button.callback('🔙 返回', 'admin_manage_tags')]);

    await ctx.editMessageText('🗑️ 请选择要删除的标签：', Markup.inlineKeyboard(buttons));
  }

  static async handleAdminDelTag(ctx: Context, db: typeof database, tag: string): Promise<void> {
    let tags = await db.getRecommendedTags();
    tags = tags.filter(t => t !== tag);
    await db.saveRecommendedTags(tags);
    await ctx.answerCbQuery(`✅ 已删除标签: ${tag}`);
    await this.handleAdminManageTags(ctx, db);
  }
}
