const { database } = require('../dist/database');

async function run() {
  console.log('🔄 正在重置所有资料的同步标记 (抹除永久坐标)...');
  
  try {
    const allMedia = await database.getAllMedia();
    let count = 0;
    
    for (const m of allMedia) {
      if (m.source_msg_id) {
        // 通过数据库接口将永久坐标抹除
        await database.updateMediaSource(m.id, "", 0);
        count++;
      }
    }
    
    console.log(`\n✅ 重置完成！共清理 ${count} 条同步标记。`);
    console.log(`💡 现在您可以运行新版 vault-sync.js 进行全新的严谨备份了。`);
    process.exit(0);
  } catch (error) {
    console.error('❌ 重置失败:', error.message);
    process.exit(1);
  }
}

run();
