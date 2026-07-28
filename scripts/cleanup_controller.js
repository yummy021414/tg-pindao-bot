const fs = require('fs');
const path = require('path');
const filePath = path.join(process.cwd(), 'src/userAccount/controller.ts');
let content = fs.readFileSync(filePath, 'utf-8');
const searchStr = '  /**\n   * 使用程序定时器控制发�?;
const endStr = '  /**\n   * 查询任务状�?(增强�?';
const startIndex = content.indexOf(searchStr);
const endIndex = content.indexOf(endStr);
if (startIndex !== -1 && endIndex !== -1) {
    const newContent = content.substring(0, startIndex) + '  // 旧并发逻辑已被移除\n\n' + content.substring(endIndex);
    fs.writeFileSync(filePath, newContent);
    console.log('Successfully cleaned up controller.ts');
} else {
    console.log('Could not find legacy code blocks');
}
