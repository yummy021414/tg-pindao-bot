const fs = require('fs');
const path = require('path');
const filePath = path.join(process.cwd(), 'src/userAccount/controller.ts');
let text = fs.readFileSync(filePath, 'utf-8');
const lines = text.split('\n');
const startIdx = lines.findIndex(l => l.includes('scheduleMessagesWithTimers'));
const endIdx = lines.findIndex(l => l.includes('查询任务状�?(增强�?'));
if (startIdx !== -1 && endIdx !== -1) {
    const newLines = [...lines.slice(0, startIdx - 3), '  // 旧并发逻辑已被移除', '', ...lines.slice(endIdx)];
    fs.writeFileSync(filePath, newLines.join('\n'));
    console.log('Cleaned up successfully');
}
