#!/usr/bin/env node

/**
 * 清理数据库脚本
 * 清除所有数据库文件，但保留备份
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const filesToClear = [
  'bot.json',
  'user_accounts.json'
];
const dirsToClear = [
  'sessions'
];

console.log('════════════════════════════════════════');
console.log('  数据库清理工具');
console.log('════════════════════════════════════════');
console.log('');

// 检查数据目录是否存在
if (!fs.existsSync(dataDir)) {
  console.log('⚠️ 数据目录不存在:', dataDir);
  process.exit(0);
}

let clearedCount = 0;

// 清理文件
console.log('📄 清理数据库文件...');
for (const file of filesToClear) {
  const filePath = path.join(dataDir, file);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`✅ 已删除: ${file}`);
      clearedCount++;
    } catch (error) {
      console.error(`❌ 删除失败 ${file}:`, error.message);
    }
  } else {
    console.log(`ℹ️  文件不存在: ${file}`);
  }
}

// 清理目录
console.log('');
console.log('📁 清理数据库目录...');
for (const dir of dirsToClear) {
  const dirPath = path.join(dataDir, dir);
  if (fs.existsSync(dirPath)) {
    try {
      deleteDirectory(dirPath);
      console.log(`✅ 已删除目录: ${dir}/`);
      clearedCount++;
    } catch (error) {
      console.error(`❌ 删除目录失败 ${dir}:`, error.message);
    }
  } else {
    console.log(`ℹ️  目录不存在: ${dir}/`);
  }
}

console.log('');
console.log('════════════════════════════════════════');
console.log(`✅ 清理完成！共清理 ${clearedCount} 个项目`);
console.log('════════════════════════════════════════');
console.log('');
console.log('💡 提示:');
console.log('  - 备份文件未受影响，位于 backups/ 目录');
console.log('  - 重新启动机器人将创建新的数据库文件');
console.log('');

/**
 * 递归删除目录
 */
function deleteDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteDirectory(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

