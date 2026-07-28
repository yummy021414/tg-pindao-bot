/**
 * 查看金库备份覆盖情况（有多少条已有 source_*）。
 *
 *   npm run vault:status
 */
import dotenv from 'dotenv';
dotenv.config();

import { config } from '../src/config';
import { database } from '../src/database';
import { getVaultCoverageStats, hasVaultCoords } from '../src/services/vault';

async function main() {
  const stats = await getVaultCoverageStats(database);
  const pct = stats.total ? ((stats.withSource / stats.total) * 100).toFixed(1) : '0.0';

  console.log('📦 金库备份状态');
  console.log(`   PERSISTENT_CHANNEL_ID: ${stats.vaultChannelId || '（未配置）'}`);
  console.log(`   PERSISTENT_GROUP_ID:   ${config.persistentGroupId || '（未配置，可选）'}`);
  console.log(`   媒体总数:     ${stats.total}`);
  console.log(`   已有坐标:     ${stats.withSource} (${pct}%)`);
  console.log(`   缺少坐标:     ${stats.withoutSource}`);

  if (!stats.vaultChannelId) {
    console.log('\n⚠️ 请先在 .env 配置 PERSISTENT_CHANNEL_ID，并把 bot 设为该频道管理员。');
  } else if (stats.withoutSource > 0) {
    console.log('\n👉 补齐坐标: npm run vault:sync');
    console.log('   小批量试跑: npm run vault:sync -- --limit=5');
  } else {
    console.log('\n✅ 坐标齐全。换新 bot 时: npm run vault:claim');
  }

  // 抽样几条缺坐标的关键词，方便排查
  if (stats.withoutSource > 0) {
    const missing = (await database.getAllMedia())
      .filter(m => !hasVaultCoords(m))
      .slice(0, 8);
    console.log('\n缺坐标抽样:');
    for (const m of missing) {
      console.log(`   #${m.id} kw="${m.keyword}" type=${m.file_type}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
