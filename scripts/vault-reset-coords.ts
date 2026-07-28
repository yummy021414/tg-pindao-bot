/**
 * 清除所有媒体的金库坐标（危险操作，仅本地重建备份时用）。
 *   npm run vault:reset-coords
 */
import dotenv from 'dotenv';
dotenv.config();

import { database } from '../src/database';

async function main() {
  const confirm = process.argv.includes('--yes');
  if (!confirm) {
    console.log('⚠️ 这将清除全部 source_chat_id / source_msg_id。');
    console.log('确认执行: npm run vault:reset-coords -- --yes');
    process.exit(1);
  }

  const all = await database.getAllMedia();
  let count = 0;
  for (const m of all) {
    if (m.source_chat_id || m.source_msg_id) {
      await database.updateMediaSource(m.id, '', 0, { force: true });
      count++;
    }
  }
  console.log(`✅ 已清除 ${count} 条金库坐标。下一步: npm run vault:sync`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
