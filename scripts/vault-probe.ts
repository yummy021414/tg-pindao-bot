/**
 * 探测当前 BOT_TOKEN 能否访问 .env 里配置的频道/金库。
 *   npm run vault:probe
 */
import dotenv from 'dotenv';
dotenv.config();

import { Telegraf } from 'telegraf';
import { config } from '../src/config';
import { checkVaultAccess } from '../src/services/vault';

async function main() {
  const bot = new Telegraf(config.botToken);
  const me = await bot.telegram.getMe();
  console.log(`🤖 当前 Token 对应: @${me.username} (id=${me.id})`);
  console.log('   请确认你加进备份频道的就是这个账号，不是旧 bot。\n');

  const ids = [
    { label: 'PERSISTENT_CHANNEL_ID', id: config.persistentChannelId },
    { label: 'PERSISTENT_GROUP_ID', id: config.persistentGroupId },
    ...config.channelIds.map((id, i) => ({ label: `CHANNEL_IDS[${i}]`, id }))
  ];

  for (const item of ids) {
    if (!item.id) {
      console.log(`— ${item.label}: （未配置）`);
      continue;
    }
    const r = await checkVaultAccess(bot.telegram, item.id);
    if (r.ok) {
      console.log(`✅ ${item.label}=${item.id}  ${r.type}「${r.title}」 status=${r.botStatus}`);
    } else {
      console.log(`❌ ${item.label}=${item.id}`);
      console.log(`   ${r.error}`);
      if (r.hint) console.log(`   💡 ${r.hint}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
