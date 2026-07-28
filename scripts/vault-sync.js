"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const telegraf_1 = require("telegraf");
const config_1 = require("../src/config");
const database_1 = require("../src/database");
const UploadHandler_1 = require("../src/bot/handlers/UploadHandler");
async function startSync() {
    console.log('🚀 [金库同步工具] 正在启动...');
    const persistentChannelId = config_1.config.persistentChannelId;
    if (!persistentChannelId) {
        console.error('❌ 错误：请先在 .env 中配置 PERSISTENT_CHANNEL_ID');
        process.exit(1);
    }
    // 1. 初始化 Bot
    const bot = new telegraf_1.Telegraf(config_1.config.botToken);
    console.log(`🤖 机器人已就绪，目标金库: ${persistentChannelId}`);
    // 2. 获取所有媒体数据
    const allMedia = await database_1.database.getAllMedia();
    // 筛选出还没有永久坐标的资料
    const pendingItems = allMedia.filter((m) => !m.source_msg_id);
    if (pendingItems.length === 0) {
        console.log('✅ 所有资料都已拥有永久坐标，无需同步。');
        process.exit(0);
    }
    console.log(`📊 发现 ${pendingItems.length} 个文件需要同步到金库。`);
    // 3. 按批次 (BatchId) 分组，确保相册不散
    const batches = {};
    pendingItems.forEach((item) => {
        const bId = item.batchId || `single_${item.id}`;
        if (!batches[bId])
            batches[bId] = [];
        batches[bId].push(item);
    });
    const batchIds = Object.keys(batches);
    console.log(`📦 已拆分为 ${batchIds.length} 组资料包，准备开始同步...`);
    // 4. 逐组同步
    for (let i = 0; i < batchIds.length; i++) {
        const bId = batchIds[i];
        const items = batches[bId];
        const keyword = items[0].keyword;
        console.log(`[${i + 1}/${batchIds.length}] 正在同步关键词 "${keyword}" (${items.length}个文件)...`);
        try {
            // 调用我们刚重构的、带坐标记录功能的发布函数
            // @ts-ignore
            await UploadHandler_1.UploadHandler.publishToChannel(bot, persistentChannelId, items, keyword, database_1.database);
            console.log(`   ✅ 同步成功，已更新数据库坐标。`);
        }
        catch (err) {
            console.error(`   ❌ 同步失败: ${err.message}`);
            if (err.message.includes('file identifier')) {
                console.warn(`   ⚠️ 警告：当前 Token 无法识别该文件，该条目已无法自动备份，建议手动重传。`);
            }
        }
        // 🚀 防洪保护：每组之间停顿 3 秒，避免触发 Telegram 限制
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    console.log('\n✨ [同步完成] 您的资料库已全量进入金库！');
    process.exit(0);
}
startSync().catch(console.error);
//# sourceMappingURL=vault-sync.js.map