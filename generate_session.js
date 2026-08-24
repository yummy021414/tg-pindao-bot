#!/usr/bin/env node
/**
 * Telegram Session 生成工具
 * 用公共 API 凭证生成 Session 字符串
 * 生成后可以直接在项目中使用
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

// 使用公共 API 凭证（Telethon 官方提供）
const API_ID = 6;
const API_HASH = 'eb06d4abfb49dc3eeb1aeb98ae0f581e';

console.log('\n' + '='.repeat(60));
console.log(' '.repeat(15) + 'Telegram Session 生成工具');
console.log('='.repeat(60));
console.log('\n📌 说明:');
console.log('  • 使用公共 API 凭证（完全合法）');
console.log('  • 只需要手机号和验证码');
console.log('  • 生成的 Session 可以重复使用');
console.log('  • Session 永久有效（除非手动退出登录）');
console.log('\n' + '='.repeat(60) + '\n');

(async () => {
  const stringSession = new StringSession(''); // 空 Session
  
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('📱 请输入手机号（如 +8613800138000）: '),
    password: async () => await input.text('🔐 如有两步验证密码，请输入（没有直接回车）: '),
    phoneCode: async () => await input.text('🔑 请输入验证码: '),
    onError: (err) => console.log('❌ 错误:', err),
  });

  console.log('\n' + '='.repeat(60));
  console.log('✅ 登录成功！');
  console.log('='.repeat(60));

  // 获取用户信息
  const me = await client.getMe();
  console.log('\n📋 账号信息:');
  console.log(`  • 名字: ${me.firstName} ${me.lastName || ''}`);
  console.log(`  • 用户名: @${me.username || '未设置'}`);
  console.log(`  • 手机号: ${me.phone}`);
  console.log(`  • 用户ID: ${me.id}`);

  // 保存 Session
  const sessionString = client.session.save();
  
  console.log('\n' + '='.repeat(60));
  console.log('🎉 Session 生成成功！');
  console.log('='.repeat(60));
  console.log('\n📝 你的 Session 字符串:');
  console.log('\n' + sessionString);
  console.log('\n' + '='.repeat(60));
  
  console.log('\n💡 使用方法:');
  console.log('  1. 复制上面的 Session 字符串');
  console.log('  2. 在机器人中使用 /添加账号 命令');
  console.log('  3. 粘贴这个 Session 字符串');
  console.log('  4. API ID 填: 6');
  console.log('  5. API Hash 填: eb06d4abfb49dc3eeb1aeb98ae0f581e');
  console.log('\n⚠️ 重要:');
  console.log('  • Session 是敏感信息，不要分享给他人！');
  console.log('  • 保存好这个字符串，可以重复使用');
  console.log('  • 如果泄露，请在 Telegram 中退出所有设备');
  console.log('\n' + '='.repeat(60) + '\n');

  // 保存到文件
  const fs = require('fs');
  const filename = `session_${me.phone}.txt`;
  fs.writeFileSync(filename, 
    `Telegram Session\n` +
    `================\n\n` +
    `账号信息:\n` +
    `  手机号: ${me.phone}\n` +
    `  用户名: @${me.username || '未设置'}\n` +
    `  用户ID: ${me.id}\n\n` +
    `Session 字符串:\n` +
    `${sessionString}\n\n` +
    `API 凭证（公共）:\n` +
    `  API ID: 6\n` +
    `  API Hash: eb06d4abfb49dc3eeb1aeb98ae0f581e\n\n` +
    `生成时间: ${new Date().toLocaleString('zh-CN')}\n`
  );
  
  console.log(`💾 Session 已保存到: ${filename}\n`);

  await client.disconnect();
  process.exit(0);
})();


