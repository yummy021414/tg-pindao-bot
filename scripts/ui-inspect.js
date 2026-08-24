/**
 * 真机页面取证：dump 控件树 + 截图 + 输出可读控件清单，用于填写 android-worker 的选择器。
 * 用法：node scripts/ui-inspect.js 页面名 [--tap x,y] [--swipe x1,y1,x2,y2] [--back] [--wait 毫秒]
 * 解析逻辑与 scripts/android-worker.ts 保持一致，避免"清单能看到、Worker 找不到"。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const name = args.find(item => !item.startsWith('--')) || 'now';
const option = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const adbPath = process.env.ADB_PATH || 'adb';
const device = process.env.ANDROID_SERIAL;
const adb = (...rest) =>
  execFileSync(adbPath, device ? ['-s', device, ...rest] : rest, { maxBuffer: 64 * 1024 * 1024 });

const outDir = path.resolve(__dirname, '..', 'data', 'ui-capture');
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);

if (args.includes('--back')) {
  adb('shell', 'input', 'keyevent', '4');
  sleep(1200);
}
if (option('--tap')) {
  const [x, y] = option('--tap').split(',');
  adb('shell', 'input', 'tap', x, y);
  sleep(Number(option('--wait') || 1500));
}
if (option('--swipe')) {
  const [x1, y1, x2, y2] = option('--swipe').split(',');
  adb('shell', 'input', 'swipe', x1, y1, x2, y2, '400');
  sleep(Number(option('--wait') || 1200));
}

const reparse = args.includes('--reparse');
let xml;
if (reparse) {
  xml = fs.readFileSync(path.join(outDir, `ui-${name}.xml`), 'utf8');
} else {
  adb('shell', 'uiautomator dump /sdcard/ui-capture.xml >/dev/null 2>&1');
  xml = adb('exec-out', 'cat', '/sdcard/ui-capture.xml').toString('utf8');
  fs.writeFileSync(path.join(outDir, `ui-${name}.xml`), xml, 'utf8');
  adb('shell', 'screencap', '-p', '/sdcard/ui-capture.png');
  adb('pull', '/sdcard/ui-capture.png', path.join(outDir, `shot-${name}.png`));
}
if (!reparse) execFileSync('powershell', [
  '-NoProfile', '-Command',
  `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${path.join(outDir, `shot-${name}.png`)}');` +
  `$s=New-Object System.Drawing.Bitmap($i,[int]($i.Width*0.5),[int]($i.Height*0.5));` +
  `$s.Save('${path.join(outDir, `shot-${name}-small.png`)}',[System.Drawing.Imaging.ImageFormat]::Png);$s.Dispose();$i.Dispose()`
]);

const decodeXml = value =>
  value
    .replace(/&#(\d+);/g, (_all, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const attr = (node, key) => decodeXml(node.match(new RegExp(`${key}="([^"]*)"`))?.[1] || '');

const nodes = Array.from(xml.matchAll(/<node\b[^>]*>/g)).map(match => ({
  text: attr(match[0], 'text'),
  resourceId: attr(match[0], 'resource-id'),
  contentDesc: attr(match[0], 'content-desc'),
  className: attr(match[0], 'class'),
  clickable: attr(match[0], 'clickable'),
  scrollable: attr(match[0], 'scrollable'),
  bounds: attr(match[0], 'bounds')
}));

const escapeInvisible = value => value.replace(/[\u0000-\u001f\u007f-\u00a0\ue000-\uf8ff]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const lines = [`页面: ${name}`, `控件总数: ${nodes.length}`, ''];
const listAll = args.includes('--all');
nodes.forEach((node, index) => {
  // 底部工具栏这类图标常常没有任何文本；可点击就必须列出来，否则只能靠截图猜坐标。
  if (!listAll && !node.text && !node.contentDesc && !node.resourceId && node.clickable !== 'true') return;
  const center = node.bounds.match(/\d+/g)?.map(Number) || [];
  const tap = center.length === 4
    ? `tap=${Math.round((center[0] + center[2]) / 2)},${Math.round((center[1] + center[3]) / 2)}`
    : 'tap=?';
  lines.push(`[${index}] clickable=${node.clickable} scrollable=${node.scrollable} ${tap} bounds=${node.bounds} class=${node.className}`);
  if (node.resourceId) lines.push(`     resource-id: ${node.resourceId}`);
  if (node.text) lines.push(`     text: ${escapeInvisible(node.text)}`);
  if (node.contentDesc) lines.push(`     desc: ${escapeInvisible(node.contentDesc)}`);
});
fs.writeFileSync(path.join(outDir, `nodes-${name}.txt`), lines.join('\n'), 'utf8');

console.log(`nodes: data/ui-capture/nodes-${name}.txt`);
console.log(`shot:  data/ui-capture/shot-${name}-small.png`);
