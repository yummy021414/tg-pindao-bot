/**
 * 本地 Windows/Android 执行端：顺序从 VPS 领任务，用 ADB + UIAutomator 操作手机。
 * 复制 android-worker.config.example.json 为 android-worker.config.json 后填写真实配置，
 * 再执行 npm run android:worker。不要把真实 token 或选择器配置提交到 Git。
 *
 * 目标 App 的会话页大量控件没有 resource-id / content-desc，因此选择器同时支持
 * 文本匹配、绝对坐标，以及"先命中锚点再点它旁边的无描述控件"（例如笔记左侧的勾选圆圈）。
 */
import axios from 'axios';
import { execFile } from 'child_process';
import { existsSync, promises as fs, readFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };

type Selector = {
  text?: string;
  textContains?: string;
  resourceId?: string;
  resourceIdContains?: string;
  contentDesc?: string;
  contentDescContains?: string;
  /**
   * 名字/正文在 text 或 content-desc 里都算命中。圈子卡片的昵称经常只在其中一个字段。
   */
  nameContains?: string;
  /** 多个命中时取面积最小的（点名字 pill，而不是整张卡片）。 */
  matchPick?: 'first' | 'smallest';
  className?: string;
  /** 该页控件既无 id 也无描述时，只能用绝对坐标；按 screenBase 等比缩放。 */
  tapAt?: [number, number];
  /**
   * 先命中上面的条件作为锚点，再点锚点旁边的控件（勾选圆圈、卡片里的头像这类没有描述的元素）。
   * 卡片高度会随内容变化，所以相对边缘的 fromTop/fromLeft 比相对中心的 offset 更稳。
   */
  anchorOffset?: {
    absoluteX?: number;
    absoluteY?: number;
    offsetX?: number;
    offsetY?: number;
    fromTop?: number;
    fromLeft?: number;
  };
  /** 当前屏找不到时向上滑动继续找。 */
  scroll?: boolean;
  /** 覆盖全局 scrollAttempts，圈子找人时需要多翻几屏。 */
  scrollAttempts?: number;
  /**
   * 限定在屏幕的某个区域内匹配（0~1 的比例）。
   * 例如底部 Tab 的"消息"要配 { top: 0.85 }，否则会误命中聊天里的"[消息自毁]"提示条。
   */
  areaRatio?: { top?: number; bottom?: number; left?: number; right?: number };
  /**
   * 先命中锚点（例如圈子里某个用户的卡片），再点落在它范围内的子控件（例如头像）。
   * 卡片高度随内容变化，按包含关系找子控件比按固定偏移猜坐标可靠。
   */
  within?: { className?: string; clickable?: boolean; pick?: 'first' | 'last' | 'smallest' };
  /**
   * 找不到就跳过而不是报错。用于"添加好友"这类只在特定状态下出现的按钮：
   * 已是好友时资料页没有这个按钮，此时直接进入下一步。
   */
  optional?: boolean;
  /**
   * 盲滑动一步（不点击）。用于 uiautomator 抓不到内容的页面（例如"我的"个人页是
   * Flutter/WebView 渲染，控件树读到的是旧窗口），只能靠坐标滑动把目标项露出来。
   * 格式 [x1, y1, x2, y2]，按 screenBase 等比缩放。
   */
  swipe?: [number, number, number, number];
};

type NoteSyncFile = { fileId: string; fileType: 'photo' | 'video' };

type NoteSyncPayload = {
  tgKeyword: string;
  caption?: string;
  files: NoteSyncFile[];
};

type Task = {
  taskId: string;
  /** 老队列没有这个字段，缺省按 send 处理。 */
  kind?: 'send' | 'noteSync';
  noteSync?: NoteSyncPayload;
  appUserName: string;
  appContentIdentifier: string;
  appContentPosition?: string;
  action?: 1 | 2 | 3 | 4;
  claimToken: string;
  /** 由圈子线索创建的发送任务：先从圈子找人，消息列表只做兜底。 */
  fromCircle?: boolean;
  circleContent?: string;
};

type ClaimHold = { reason: 'worker-busy' | 'daily-limit' | 'cooldown'; message: string; retryAfterMs: number };

type WorkerConfig = {
  serverUrl: string;
  workerToken: string;
  workerId: string;
  deviceId?: string;
  appPackage: string;
  adbPath?: string;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  scrollAttempts?: number;
  /** 选择器里绝对坐标所基于的分辨率；与真机不一致时自动等比换算。 */
  screenBase?: { width: number; height: number };
  /** 每个任务前是否冷启动 App（默认开）。关掉会更快，但要自己保证起点页面正确。 */
  restartApp?: boolean;
  /**
   * 演练模式：走完"进会话 → 打开分享面板 → 选类型 → 勾选内容 → 校验已选"，
   * 但不点发送。第一次接真机时务必先用它验证选择器，再关掉。
   */
  dryRun?: boolean;
  /** 开启后，Worker 在空闲时扫描圈子并把"用户 + 内容"线索投递到 Bot；不会发送任何私信。 */
  circleSync?: {
    enabled: boolean;
    intervalMs?: number;
    /** 每轮向下翻几屏再汇总投递，默认 6。 */
    scanScreens?: number;
    entry: Selector;
  };
  selectors: {
    /** 可选：回到消息/联系人列表的底部 Tab。 */
    conversationEntry?: Selector;
    /** 会话列表或联系人页中，定位目标用户。支持 $user。 */
    recipient?: Selector;
    /**
     * 进入目标会话需要多步时按顺序点击，用来覆盖"圈子里的人还没有会话记录"的情况：
     * 圈子 Tab → 该用户的头像 → 个人信息页的"发送消息"。配了它就不再用 conversationEntry + recipient。
     */
    recipientSteps?: Array<Selector & { label?: string }>;
    /**
     * 多条备选路径，按顺序尝试，第一条走通就算数。
     * 圈子内容几分钟就会被新动态刷走，而聊过一次的人会留在消息列表，
     * 因此"已有会话"和"圈子里现找"需要互相兜底。
     */
    recipientRoutes?: Array<{ name: string; steps: Array<Selector & { label?: string }> }>;
    /**
     * 打开"分享笔记"面板的步骤：会话底部的"+"（无描述，只能用坐标）→ 面板里的"笔记"。
     * 会话底部工具栏第三个图标打开的是笔记管理页，选完并不会发给当前会话，别用那个。
     */
    sharePanelSteps: Array<Selector & { label?: string }>;
    /** 已映射内容在列表中的条目；配 anchorOffset 点它左侧的勾选圆圈。 */
    content: Selector;
    /** 勾选后出现的计数，例如"已选 1 条"；用于确认真的选中了目标内容。 */
    selectedIndicator?: Selector;
    /**
     * 分享面板底部的"笔记/展示/位置/三连"。支持 $action。
     * 真机实测：它们不是切换标签，点下去就直接把已勾选的内容发出去并返回会话。
     */
    sendAction: Selector;
    /** 发送成功的判定信号；配成数组时必须全部命中才算成功。 */
    success: Selector | Selector[];
    /** 演练结束或失败时用来退出面板，避免手机停在半途页面。 */
    cancel?: Selector;
    /** 把 TG 素材同步成 App 笔记时用到的一组选择器。 */
    noteSync?: NoteSyncSelectors;
  };
};

type NoteSyncSelectors = {
  /** 从任意页面走到"我的笔记"：底部"我的" Tab → 我的笔记。 */
  entrySteps: Array<Selector & { label?: string }>;
  /** "我的笔记"页顶部的统计文字，用来读出当前条数并在保存后核对 +1。 */
  noteCounter: Selector;
  /** 右上角"+" → "新增笔记"。 */
  createSteps: Array<Selector & { label?: string }>;
  /** 编辑页底部的"文字"，点了会插入文本块并弹出键盘。 */
  textBlock: Selector;
  /** 编辑页底部的"图片" / "视频"，点了会打开系统相册选择器。 */
  photoBlock: Selector;
  videoBlock: Selector;
  /** 插完照片后的「下一步」；有的机型是向导式，没有这一步就跳过。 */
  nextStep?: Selector;
  /** 系统选择器里的条目，描述含文件名；用 $file 占位。 */
  pickerItem: Selector;
  /** 系统选择器右下角的"确认"。 */
  pickerConfirm: Selector;
  /** 编辑页右上角的保存勾。 */
  save: Selector;
};

type UiNode = { text: string; resourceId: string; contentDesc: string; className: string; clickable: boolean; bounds: string };

const configPath = process.env.ANDROID_WORKER_CONFIG || path.resolve(process.cwd(), 'android-worker.config.json');
if (!existsSync(configPath)) {
  throw new Error(`未找到 ${configPath}。请先由 android-worker.config.example.json 复制一份并填写。`);
}
const config: WorkerConfig = JSON.parse(readFileSync(configPath, 'utf8'));
if (!config.appPackage) throw new Error('android-worker.config.json 缺少 appPackage。');
// 本地演练只操作手机、不领任务，因此不要求先配好 VPS 地址和令牌。
const isLocalProbe = process.argv.includes('--probe') || process.argv.includes('--notesync');
if (!isLocalProbe && (!config.serverUrl || !config.workerToken || !config.workerId)) {
  throw new Error('android-worker.config.json 缺少 serverUrl、workerToken 或 workerId。');
}

const ACTION_LABELS = { 1: '笔记', 2: '展示', 3: '位置', 4: '三连' } as const;

function resolveAdbPath(): string {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    config.adbPath,
    process.env.ADB_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', exe),
    path.join(process.env.ANDROID_HOME || '', 'platform-tools', exe),
    path.join(process.env.ANDROID_SDK_ROOT || '', 'platform-tools', exe),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exe)
  ].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    '找不到 adb。请安装 Android platform-tools，或在 android-worker.config.json 里填写 adbPath（例如 C:\\\\Users\\\\你\\\\AppData\\\\Local\\\\Android\\\\Sdk\\\\platform-tools\\\\adb.exe）。'
  );
}

const adbBin = resolveAdbPath();

function adbArgs(args: string[]): string[] {
  return config.deviceId ? ['-s', config.deviceId, ...args] : args;
}

async function adb(...args: string[]): Promise<string> {
  const result = await execFileAsync(adbBin, adbArgs(args), { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function pressBack(settleMs = 900): Promise<void> {
  await adb('shell', 'input', 'keyevent', '4');
  invalidateUi();
  await wait(settleMs);
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_all, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function attr(node: string, name: string): string {
  const value = node.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '';
  return decodeXml(value);
}

/**
 * 抓控件树是整个流程最贵的操作：真机实测 uiautomator dump 固定要 2.3 秒，
 * 而一次点击只要 93 毫秒。因此只要屏幕没被我们自己动过，就复用上一次的结果。
 * 任何 tap/swipe/按键之后都会调 invalidateUi()，不存在读到过期界面的风险。
 */
let uiCache: UiNode[] | null = null;

/** 抓屏耗时统计，任务结束时打印，方便判断慢在抓屏还是等待。 */
const perf = { dumps: 0, dumpMs: 0, cacheHits: 0, startedAt: 0 };

function resetPerf(): void {
  perf.dumps = 0;
  perf.dumpMs = 0;
  perf.cacheHits = 0;
  perf.startedAt = Date.now();
}

function perfSummary(): string {
  const total = ((Date.now() - perf.startedAt) / 1000).toFixed(1);
  return `用时 ${total}s，抓屏 ${perf.dumps} 次共 ${(perf.dumpMs / 1000).toFixed(1)}s，命中缓存 ${perf.cacheHits} 次`;
}

function invalidateUi(): void {
  uiCache = null;
}

async function dumpUi(force = false): Promise<UiNode[]> {
  if (!force && uiCache) {
    perf.cacheHits++;
    return uiCache;
  }
  const startedAt = Date.now();
  await adb('shell', 'uiautomator dump /sdcard/android-send-window.xml >/dev/null 2>&1');
  const xml = await adb('exec-out', 'cat', '/sdcard/android-send-window.xml');
  perf.dumps++;
  perf.dumpMs += Date.now() - startedAt;
  uiCache = Array.from(xml.matchAll(/<node\b[^>]*>/g)).map(match => ({
    text: attr(match[0], 'text'),
    resourceId: attr(match[0], 'resource-id'),
    contentDesc: attr(match[0], 'content-desc'),
    className: attr(match[0], 'class'),
    clickable: attr(match[0], 'clickable') === 'true',
    bounds: attr(match[0], 'bounds')
  }));
  return uiCache;
}

let screenSize: { width: number; height: number } | null = null;
async function getScreenSize(): Promise<{ width: number; height: number }> {
  if (screenSize) return screenSize;
  const output = await adb('shell', 'wm', 'size');
  const match = output.match(/Override size:\s*(\d+)x(\d+)/) || output.match(/Physical size:\s*(\d+)x(\d+)/);
  screenSize = match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1080, height: 2340 };
  return screenSize;
}

/** 选择器里的坐标按取证机型记录；换机或改分辨率后按比例换算，而不是直接点错位置。 */
async function scalePoint(point: Point): Promise<Point> {
  const base = config.screenBase;
  if (!base?.width || !base?.height) return point;
  const actual = await getScreenSize();
  return {
    x: Math.round(point.x * (actual.width / base.width)),
    y: Math.round(point.y * (actual.height / base.height))
  };
}

function selectorFor(selector: Selector, task: Task): Selector {
  const actionLabel = ACTION_LABELS[task.action || 1];
  const replace = (value?: string) => value === undefined ? undefined : value
    .replace(/\$content/g, task.appContentIdentifier)
    .replace(/\$position/g, task.appContentPosition || '')
    .replace(/\$user/g, task.appUserName)
    .replace(/\$circle/g, (task.circleContent || task.appUserName).replace(/\s+/g, ' ').slice(0, 18))
    .replace(/\$action/g, actionLabel);
  return {
    ...selector,
    text: replace(selector.text),
    textContains: replace(selector.textContains),
    nameContains: replace(selector.nameContains),
    resourceId: replace(selector.resourceId),
    resourceIdContains: replace(selector.resourceIdContains),
    contentDesc: replace(selector.contentDesc),
    contentDescContains: replace(selector.contentDescContains)
  };
}

function hasMatcher(selector: Selector): boolean {
  return Boolean(
    selector.text || selector.textContains || selector.resourceId ||
    selector.resourceIdContains || selector.contentDesc || selector.contentDescContains || selector.nameContains
  );
}

function nodeMatches(node: UiNode, selector: Selector): boolean {
  if (selector.nameContains !== undefined) {
    const haystack = `${node.text}\n${node.contentDesc}`;
    if (!haystack.includes(selector.nameContains)) return false;
  }
  if (selector.text !== undefined && node.text !== selector.text) return false;
  if (selector.textContains !== undefined && !node.text.includes(selector.textContains)) return false;
  if (selector.resourceId !== undefined && node.resourceId !== selector.resourceId) return false;
  if (selector.resourceIdContains !== undefined && !node.resourceId.includes(selector.resourceIdContains)) return false;
  if (selector.contentDesc !== undefined && node.contentDesc !== selector.contentDesc) return false;
  if (selector.contentDescContains !== undefined && !node.contentDesc.includes(selector.contentDescContains)) return false;
  if (selector.className !== undefined && node.className !== selector.className) return false;
  return hasMatcher(selector);
}

function boundsBox(bounds: string): Box {
  const values = bounds.match(/\d+/g)?.map(Number) || [];
  if (values.length !== 4) throw new Error(`控件 bounds 无效：${bounds || '空'}`);
  return { left: values[0], top: values[1], right: values[2], bottom: values[3] };
}

function boxCenter(box: Box): Point {
  return { x: Math.round((box.left + box.right) / 2), y: Math.round((box.top + box.bottom) / 2) };
}

async function find(selector: Selector, task: Task, force = false): Promise<UiNode | null> {
  const resolved = selectorFor(selector, task);
  const nodes = await dumpUi(force);
  const area = selector.areaRatio;
  const size = area ? await getScreenSize() : null;
  const inArea = (node: UiNode): boolean => {
    if (!area || !size) return true;
    let center: Point;
    try {
      center = boxCenter(boundsBox(node.bounds));
    } catch {
      return false;
    }
    if (area.top !== undefined && center.y < area.top * size.height) return false;
    if (area.bottom !== undefined && center.y > area.bottom * size.height) return false;
    if (area.left !== undefined && center.x < area.left * size.width) return false;
    if (area.right !== undefined && center.x > area.right * size.width) return false;
    return true;
  };
  const hits = nodes.filter(node => nodeMatches(node, resolved) && inArea(node));
  if (!hits.length) return null;
  if (selector.matchPick === 'smallest') {
    return [...hits].sort((a, b) => {
      const first = boundsBox(a.bounds);
      const second = boundsBox(b.bounds);
      const areaA = (first.right - first.left) * (first.bottom - first.top);
      const areaB = (second.right - second.left) * (second.bottom - second.top);
      return areaA - areaB;
    })[0];
  }
  return hits[0];
}

async function swipe(fromRatio: number, toRatio: number): Promise<void> {
  const { width, height } = await getScreenSize();
  await adb('shell', 'input', 'swipe',
    String(Math.round(width / 2)), String(Math.round(height * fromRatio)),
    String(Math.round(width / 2)), String(Math.round(height * toRatio)), '400');
  invalidateUi();
  await wait(700);
}

const swipeUp = () => swipe(0.72, 0.30);

/** 上一轮滚动会把列表留在中间，不先回顶就会"明明有却找不到"。 */
async function scrollToTop(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) await swipe(0.30, 0.78);
}

async function waitFor(selector: Selector, task: Task, label: string, timeoutMs = config.waitTimeoutMs || 10_000): Promise<UiNode> {
  const scrollAttempts = selector.scroll ? (selector.scrollAttempts ?? config.scrollAttempts ?? 6) : 0;
  if (scrollAttempts > 0) {
    const visible = await find(selector, task);
    if (visible) return visible;
    await scrollToTop();
  }
  for (let attempt = 0; attempt <= scrollAttempts; attempt++) {
    const endAt = Date.now() + timeoutMs;
    let firstLook = true;
    while (Date.now() < endAt) {
      // 重试必须重新抓取；而 dump 本身就要 2 秒多，足够当轮询间隔，不用再额外 sleep。
      const node = await find(selector, task, !firstLook);
      firstLook = false;
      if (node) return node;
    }
    if (attempt < scrollAttempts) await swipeUp();
  }
  const suffix = scrollAttempts > 0 ? `（已滚动 ${scrollAttempts} 次）` : '';
  throw new Error(`未找到「${label}」${suffix}；请对照 data/ui-capture 的取证结果检查 selectors 配置。`);
}

/** 返回真正要点击的坐标：纯坐标选择器直接换算，锚点选择器再叠加偏移。 */
async function resolvePoint(selector: Selector, task: Task, label: string, timeoutMs?: number): Promise<Point> {
  if (!hasMatcher(selector)) {
    if (!selector.tapAt) throw new Error(`选择器「${label}」既没有匹配条件也没有 tapAt 坐标。`);
    return scalePoint({ x: selector.tapAt[0], y: selector.tapAt[1] });
  }
  const node = await waitFor(selector, task, label, timeoutMs);
  const box = boundsBox(node.bounds);
  const center = boxCenter(box);

  if (selector.within) {
    const { className, clickable, pick } = selector.within;
    const children = (await dumpUi()).filter(item => {
      if (className !== undefined && item.className !== className) return false;
      if (clickable !== undefined && item.clickable !== clickable) return false;
      let childBox: Box;
      try {
        childBox = boundsBox(item.bounds);
      } catch {
        return false;
      }
      if (childBox.right - childBox.left >= box.right - box.left && childBox.bottom - childBox.top >= box.bottom - box.top) {
        return false;
      }
      return childBox.left >= box.left && childBox.top >= box.top && childBox.right <= box.right && childBox.bottom <= box.bottom;
    });
    if (children.length === 0) throw new Error(`「${label}」的锚点内没有符合 within 条件的子控件。`);
    const sorted = children.sort((a, b) => {
      const first = boundsBox(a.bounds);
      const second = boundsBox(b.bounds);
      if (pick === 'smallest') {
        const areaA = (first.right - first.left) * (first.bottom - first.top);
        const areaB = (second.right - second.left) * (second.bottom - second.top);
        return areaA - areaB || first.top - second.top || first.left - second.left;
      }
      return first.top - second.top || first.left - second.left;
    });
    return boxCenter(boundsBox((pick === 'last' ? sorted[sorted.length - 1] : sorted[0]).bounds));
  }

  const offset = selector.anchorOffset;
  if (!offset) return center;

  const absolute = offset.absoluteX !== undefined || offset.absoluteY !== undefined
    ? await scalePoint({ x: offset.absoluteX ?? center.x, y: offset.absoluteY ?? center.y })
    : null;
  const edge = offset.fromTop !== undefined || offset.fromLeft !== undefined
    ? await scalePoint({ x: offset.fromLeft ?? 0, y: offset.fromTop ?? 0 })
    : null;

  return {
    x: absolute?.x ?? (edge && offset.fromLeft !== undefined ? box.left + edge.x : center.x + (offset.offsetX || 0)),
    y: absolute?.y ?? (edge && offset.fromTop !== undefined ? box.top + edge.y : center.y + (offset.offsetY || 0))
  };
}

async function tapSelector(selector: Selector, task: Task, label: string, settleMs = 800, timeoutMs?: number): Promise<void> {
  const point = await resolvePoint(selector, task, label, timeoutMs);
  await adb('shell', 'input', 'tap', String(point.x), String(point.y));
  invalidateUi();
  await wait(settleMs);
}

/**
 * 每轮先杀掉再启动：App 会停在上一轮结束的页面（会话页、笔记详情……），
 * 靠按返回键复位并不可靠，冷启动才能保证每次都从同一个首页开始。
 */
async function launchApp(): Promise<void> {
  if (config.restartApp !== false) {
    await adb('shell', 'am', 'force-stop', config.appPackage);
    await wait(500);
  }
  await adb('shell', 'monkey', '-p', config.appPackage, '-c', 'android.intent.category.LAUNCHER', '1');
  invalidateUi();
  await wait(config.restartApp === false ? 1200 : 3000);
}

/**
 * App 会停在上一轮结束的页面（会话页、分享面板……），下一轮直接找底部 Tab 必然失败。
 * 因此每轮开始和结束都退回会话列表，保证起点一致。
 */
async function resetToConversationList(task: Task): Promise<void> {
  const entry = config.selectors.conversationEntry;
  if (!entry || !hasMatcher(entry)) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await find(entry, task)) return;
    await pressBack();
  }
}

async function cleanupToStart(task: Task): Promise<void> {
  if (config.selectors.cancel) {
    await tapSelector(config.selectors.cancel, task, '取消分享', 600).catch(() => undefined);
  }
  await resetToConversationList(task).catch(() => undefined);
}

async function runRecipientSteps(steps: Array<Selector & { label?: string }>, task: Task, prefix = ''): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const label = `${prefix}${step.label || `第 ${index + 1} 步`}`;
    if (step.swipe) {
      // 盲滑动：uiautomator 抓不到的页面（"我的"个人页）只能按坐标滑。
      const [x1, y1, x2, y2] = step.swipe;
      const from = await scalePoint({ x: x1, y: y1 });
      const to = await scalePoint({ x: x2, y: y2 });
      await adb('shell', 'input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), '400');
      invalidateUi();
      await wait(1000);
      continue;
    }
    if (step.optional) {
      // 可选步骤（如"添加好友"）：已是好友时按钮不存在。超时设 2 秒，
      // 一次抓屏（约 2.3 秒）结束后即判定跳过，不做第二次。
      try {
        await tapSelector(step, task, label, 700, 2000);
      } catch {
        console.log(`[Android Worker] 可选步骤「${label}」未出现，跳过。`);
      }
      continue;
    }
    // 每步之后紧接着就是一次 2 秒多的控件树抓取，页面早就稳定了，这里不必再长等。
    await tapSelector(step, task, label, 700);
  }
}

/** 进入目标用户的会话：按配置的路径依次尝试，全部失败才算任务失败。 */
async function openConversation(task: Task): Promise<void> {
  const { recipientRoutes, recipientSteps, conversationEntry, recipient } = config.selectors;

  if (recipientRoutes?.length) {
    const failures: string[] = [];
    const routes = [...recipientRoutes].sort((left, right) => {
      if (!task.fromCircle) return 0;
      const score = (name: string) => (name.includes('圈子') ? 0 : 1);
      return score(left.name) - score(right.name);
    });
    for (const route of routes) {
      try {
        await runRecipientSteps(route.steps, task, `${route.name}：`);
        return;
      } catch (error: any) {
        failures.push(`${route.name}（${error?.message || error}）`);
        // 上一条路径可能停在半途页面，重新冷启动才能让下一条从首页开始。
        await launchApp();
      }
    }
    throw new Error(`进入「${task.appUserName}」的会话失败，已尝试：${failures.join('；')}`);
  }

  if (recipientSteps?.length) {
    await runRecipientSteps(recipientSteps, task);
    return;
  }
  if (!recipient) throw new Error('selectors 需要配置 recipient 或 recipientSteps 之一。');
  if (conversationEntry) {
    await resetToConversationList(task);
    await tapSelector(conversationEntry, task, '消息/联系人入口', 1000);
  }
  await tapSelector(recipient, task, `目标会话「${task.appUserName}」`, 1500);
}

// ============ 同步笔记：TG 素材 → 手机相册 → App 新增笔记 ============

/** 系统相册选择器一次最多选 9 个，素材更多时要分批点"图片/视频"。 */
const PICKER_BATCH_SIZE = 9;
const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME';
const ASSET_CACHE_DIR = path.resolve(process.cwd(), 'data', 'android-cache');

type PushedAsset = { fileType: 'photo' | 'video'; remotePath: string; fileName: string };

/** 把 $file 换成实际文件名，避免为此改动所有选择器函数的签名。 */
function withFileName(selector: Selector, fileName: string): Selector {
  const swap = (value?: string) => value?.replace(/\$file/g, fileName);
  return {
    ...selector,
    text: swap(selector.text),
    textContains: swap(selector.textContains),
    contentDesc: swap(selector.contentDesc),
    contentDescContains: swap(selector.contentDescContains)
  };
}

async function mediaScan(remotePath: string): Promise<void> {
  // push 进去的文件不入 MediaStore 的话，系统相册选择器里根本看不到。
  await adb('shell', 'content', 'call', '--uri', 'content://media/external/file',
    '--method', 'scan_file', '--arg', remotePath).catch(() => undefined);
}

/** 下载素材并推进手机相册。文件名带 taskId，既能精确选中也方便事后清理。 */
async function pushNoteAssets(task: Task, payload: NoteSyncPayload): Promise<PushedAsset[]> {
  await fs.mkdir(ASSET_CACHE_DIR, { recursive: true });
  const pushed: PushedAsset[] = [];

  for (const [index, file] of payload.files.entries()) {
    const response = await http.get(`/api/android/media/${file.fileId}`, { responseType: 'arraybuffer', timeout: 180_000 });
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const isVideo = contentType.startsWith('video/') || (!contentType.startsWith('image/') && file.fileType === 'video');
    const fileName = `tgnote-${task.taskId}-${String(index + 1).padStart(2, '0')}.${isVideo ? 'mp4' : 'jpg'}`;
    const localPath = path.join(ASSET_CACHE_DIR, fileName);
    const remotePath = `/sdcard/${isVideo ? 'Movies' : 'Pictures'}/${fileName}`;

    await fs.writeFile(localPath, Buffer.from(response.data));
    await adb('push', localPath, remotePath);
    await mediaScan(remotePath);
    await fs.unlink(localPath).catch(() => undefined);

    pushed.push({ fileType: isVideo ? 'video' : 'photo', remotePath, fileName });
  }
  // 扫描是异步入库的，紧接着打开选择器有时还看不到，留一点余量。
  await wait(1500);
  return pushed;
}

/** 素材只是同步用的中间产物，无论成败都要从相册里清掉，免得污染用户的相册。 */
async function cleanupNoteAssets(assets: PushedAsset[]): Promise<void> {
  for (const asset of assets) {
    await adb('shell', 'rm', '-f', asset.remotePath).catch(() => undefined);
    await mediaScan(asset.remotePath);
  }
}

async function hasAdbKeyboard(): Promise<boolean> {
  const list = await adb('shell', 'ime', 'list', '-s').catch(() => '');
  return list.includes('com.android.adbkeyboard');
}

/**
 * adb shell input text 只能打 ASCII，中文会被直接丢掉。
 * 装了 ADBKeyBoard 就临时切过去用广播注入，用完立刻切回原输入法。
 */
async function typeUnicodeText(text: string): Promise<void> {
  const previous = (await adb('shell', 'settings', 'get', 'secure', 'default_input_method')).trim();
  try {
    await adb('shell', 'ime', 'enable', ADB_KEYBOARD_IME);
    await adb('shell', 'ime', 'set', ADB_KEYBOARD_IME);
    await wait(1200);
    await adb('shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(text, 'utf8').toString('base64'));
    invalidateUi();
    await wait(1200);
  } finally {
    if (previous && previous !== ADB_KEYBOARD_IME) {
      await adb('shell', 'ime', 'set', previous).catch(() => undefined);
    }
  }
}

/** 从"共 1 个分组，合计 76 条笔记"里读出条数，用来核对保存是否真的生效。 */
async function readNoteCount(task: Task, selectors: NoteSyncSelectors): Promise<number | null> {
  const node = await find(selectors.noteCounter, task).catch(() => null);
  if (!node) return null;
  const source = `${node.contentDesc} ${node.text}`;
  const matched = source.match(/合计\s*(\d+)\s*条/) || source.match(/(\d+)\s*条笔记/);
  return matched ? Number(matched[1]) : null;
}

/** 分批点开选择器，每批按文件名精确勾选，再确认。 */
async function pickAssets(
  task: Task,
  selectors: NoteSyncSelectors,
  block: Selector,
  assets: PushedAsset[],
  label: string
): Promise<void> {
  for (let offset = 0; offset < assets.length; offset += PICKER_BATCH_SIZE) {
    const batch = assets.slice(offset, offset + PICKER_BATCH_SIZE);
    await tapSelector(block, task, `插入${label}`, 2500);
    for (const asset of batch) {
      await tapSelector(withFileName(selectors.pickerItem, asset.fileName), task, `选中${label}「${asset.fileName}」`, 700);
    }
    await tapSelector(selectors.pickerConfirm, task, `确认${label}`, 3000);
  }
}

/**
 * 真机实测路径：我的 → 我的笔记 → 右上角 + → 新增笔记 →
 * 文字（需 ADBKeyBoard）→ 图片 → 视频 → 右上角保存 → 核对笔记条数 +1。
 */
async function executeNoteSync(task: Task): Promise<void> {
  const payload = task.noteSync;
  if (!payload) throw new Error('同步笔记任务缺少 noteSync 数据。');
  const selectors = config.selectors.noteSync;
  if (!selectors) throw new Error('android-worker.config.json 的 selectors 缺少 noteSync 配置，无法同步笔记。');
  if (!payload.files.length) throw new Error('同步笔记任务没有可用素材。');

  const assets = await pushNoteAssets(task, payload);
  try {
    await launchApp();
    await runRecipientSteps(selectors.entrySteps, task, '进入我的笔记：');

    const before = await readNoteCount(task, selectors);
    await runRecipientSteps(selectors.createSteps, task, '新增笔记：');

    let captionSkipped = false;
    const noteText = [payload.tgKeyword?.trim(), payload.caption?.trim()].filter(Boolean).join('\n');
    if (noteText) {
      if (await hasAdbKeyboard()) {
        await tapSelector(selectors.textBlock, task, '插入文字块', 1500);
        await typeUnicodeText(noteText);
        await pressBack(1000);
      } else {
        // 没装 ADBKeyBoard 就没法输入中文，此时同步媒体比整单失败更有用。
        captionSkipped = true;
      }
    }

    const photos = assets.filter(asset => asset.fileType === 'photo');
    const videos = assets.filter(asset => asset.fileType === 'video');
    console.log(`[Android Worker] 素材分类：照片 ${photos.length}，视频 ${videos.length}`);
    if (photos.length) await pickAssets(task, selectors, selectors.photoBlock, photos, '照片');
    if (photos.length && selectors.nextStep) {
      try {
        await tapSelector(selectors.nextStep, task, '下一步', 1200, 4000);
      } catch {
        console.log('[Android Worker] 「下一步」未出现，继续找视频入口。');
      }
    }
    if (videos.length) {
      try {
        await pickAssets(task, selectors, selectors.videoBlock, videos, '视频');
      } catch (error) {
        if (!selectors.nextStep) throw error;
        await tapSelector(selectors.nextStep, task, '下一步（视频前）', 1200, 4000).catch(() => undefined);
        await pickAssets(task, selectors, selectors.videoBlock, videos, '视频');
      }
    }

    if (config.dryRun) {
      throw new Error('演练模式（dryRun）：已完成新增笔记的选择器验证，未保存。确认无误后把 dryRun 改为 false。');
    }

    await tapSelector(selectors.save, task, '保存笔记', 4000);

    const after = await readNoteCount(task, selectors);
    if (before !== null && after !== null && after <= before) {
      throw new Error(`点了保存但笔记条数没有增加（${before} → ${after}），判定为保存失败。`);
    }
    if (captionSkipped) {
      throw new Error('笔记已创建，但文案未同步：手机上没装 ADBKeyBoard，adb 无法输入中文。装好后重新上传即可带文案。');
    }
  } finally {
    await cleanupNoteAssets(assets);
  }
}

/**
 * 真机实测路径：进入目标会话 → "+" → 笔记 → 勾选已映射内容 →
 * 校验"已选 N 条" → 点底部的笔记/展示/位置/三连（这一步就是发送）→ 校验成功信号。
 */
async function executeTask(task: Task): Promise<void> {
  const selectors = config.selectors;
  const actionLabel = ACTION_LABELS[task.action || 1];
  await launchApp();
  await openConversation(task);
  await runRecipientSteps(selectors.sharePanelSteps, task, '打开分享面板：');
  try {
    await tapSelector(selectors.content, task, `勾选内容「${task.appContentIdentifier}」`, 600);
  } catch (error) {
    if (!task.appContentPosition) throw error;
    const fallback = { ...selectors.content, contentDescContains: task.appContentPosition };
    await tapSelector(fallback, task, `勾选内容（文案）「${task.appContentPosition}」`, 600);
  }

  if (selectors.selectedIndicator) {
    // 勾选没生效就发送，等于把空内容或错内容发给真人，所以这里失败必须整单终止。
    await waitFor(selectors.selectedIndicator, task, '已选条数校验', 5000).catch(() => {
      throw new Error(`已勾选内容「${task.appContentIdentifier}」后未出现预期的已选条数，已放弃发送。`);
    });
  }

  if (config.dryRun) {
    // --stay 用于取证"发送"和"成功信号"：把手机停在已勾选状态，人工接着点下一步。
    if (!process.argv.includes('--stay')) await cleanupToStart(task);
    throw new Error('演练模式（dryRun）：已完成选择器验证，未执行发送。确认无误后把 dryRun 改为 false。');
  }

  await tapSelector(selectors.sendAction, task, `发送（${actionLabel}）`, 1500);
  // 多条信号只需抓一次屏：第一条抓完后其余走缓存，除非它们还没同时渲染出来。
  const signals = Array.isArray(selectors.success) ? selectors.success : [selectors.success];
  for (const [index, signal] of signals.entries()) {
    await waitFor(signal, task, `发送成功信号 ${index + 1}/${signals.length}`);
  }
  // restartApp 开着时下一轮会冷启动，收尾复位纯属浪费两次抓取。
  if (config.restartApp === false) await resetToConversationList(task).catch(() => undefined);
}

const http = axios.create({
  baseURL: (config.serverUrl || '').replace(/\/$/, ''),
  timeout: 20_000,
  headers: { Authorization: `Bearer ${config.workerToken}` }
});

async function complete(task: Task, success: boolean, errorMessage?: string): Promise<void> {
  await http.post(`/api/android/tasks/${encodeURIComponent(task.taskId)}/complete`, {
    workerId: config.workerId,
    claimToken: task.claimToken,
    success,
    errorMessage
  });
}

function collectCircleLeadsFromNodes(nodes: UiNode[]): Array<{ appUserId: string; appUserName: string; circleContent: string }> {
  const cards = nodes.filter(node => {
    const desc = node.contentDesc;
    if (!desc.includes('\n')) return false;
    const first = desc.split('\n')[0].trim();
    if (first.length < 2 || first.length > 40) return false;
    if (/^(消息|联系人|圈子|发现|我的|全部|未分组)$/u.test(first)) return false;
    return /报名[:：]\s*\d+/u.test(desc) || /[\u4e00-\u9fff]/.test(first);
  });
  const texts = nodes.filter(node => node.text.trim().length >= 2);
  return cards.map(card => {
    const box = boundsBox(card.bounds);
    const body = texts
      .filter(node => {
        const center = boxCenter(boundsBox(node.bounds));
        return center.y >= box.top && center.y <= box.bottom && center.x >= box.left && center.x <= box.right;
      })
      .map(node => node.text.trim())
      .join(' ');
    const lines = card.contentDesc.split('\n').map(item => item.trim()).filter(Boolean);
    const appUserName = lines[0];
    const fromDesc = lines.slice(1).filter(line => !/报名[:：]/u.test(line) && line !== appUserName).join(' ');
    return { appUserId: appUserName, appUserName, circleContent: body || fromDesc };
  }).filter(lead => lead.appUserName && lead.circleContent);
}

/**
 * 圈子页把发帖人资料放在 content-desc、笔记正文放在 text，两者是同一张卡片的不同子节点。
 * 必须按卡片 bounds 归属配对：只按出现顺序配对，会把 A 的正文安到 B 头上。
 * 每轮多翻几屏，否则一次只能抓到当前可见的两三条。
 */
async function syncCircleLeads(): Promise<void> {
  const sync = config.circleSync;
  if (!sync?.enabled) return;
  const probeTask: Task = { taskId: 'circle-sync', appUserName: '', appContentIdentifier: '', claimToken: '' };
  await launchApp();
  await tapSelector(sync.entry, probeTask, '圈子入口', 1200);

  const seen = new Map<string, { appUserId: string; appUserName: string; circleContent: string }>();
  const screens = Math.max(1, sync.scanScreens ?? 6);
  for (let screen = 0; screen < screens; screen++) {
    const leads = collectCircleLeadsFromNodes(await dumpUi(screen > 0));
    for (const lead of leads) {
      const key = `${lead.appUserName}\n${lead.circleContent}`;
      if (!seen.has(key)) seen.set(key, lead);
    }
    if (screen < screens - 1) await swipeUp();
  }

  const leads = [...seen.values()].slice(0, 40);
  if (leads.length === 0) {
    console.log('[Android Worker] 圈子扫描未找到可投递线索。');
    return;
  }
  const response = await http.post('/api/android/circle-leads', { leads });
  console.log(`[Android Worker] 圈子扫描：新增 ${response.data?.created?.length || 0} 条，跳过 ${response.data?.skipped || 0} 条（本轮看到 ${leads.length} 条）。`);
}

/**
 * 本地演练：不连 VPS，直接按配置在真机上走一遍选择器路径并停在发送前。
 * 用法：npm run android:probe -- --user 会话名 --content 内容片段 [--action 1]
 */
async function probe(): Promise<void> {
  const argOf = (flag: string) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const appUserName = argOf('--user');
  const appContentIdentifier = argOf('--content');
  if (!appUserName || !appContentIdentifier) {
    throw new Error('用法：npm run android:probe -- --user 会话名 --content 内容片段 [--action 1]');
  }
  const action = Number(argOf('--action') || 1);
  if (![1, 2, 3, 4].includes(action)) throw new Error('--action 只能是 1(笔记) 2(展示) 3(位置) 4(三连)');

  const task: Task = {
    taskId: 'probe',
    appUserName,
    appContentIdentifier,
    action: action as 1 | 2 | 3 | 4,
    claimToken: ''
  };
  // 默认强制演练，避免手滑给真人发消息；--live 才会真的发出去。
  const live = process.argv.includes('--live');
  console.log(`[Android Probe] ${live ? '真实发送' : '演练'}：${appUserName} ← ${appContentIdentifier}（${ACTION_LABELS[task.action!]}）`);
  const original = config.dryRun;
  config.dryRun = !live;
  resetPerf();
  try {
    await executeTask(task);
    console.log(`[Android Probe] ✅ 已真实发送并命中成功信号。（${perfSummary()}）`);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (message.includes('演练模式')) {
      console.log(`[Android Probe] ✅ 选择器全部命中，已停在发送前并退出面板。（${perfSummary()}）`);
      return;
    }
    console.error(`[Android Probe] ❌ ${message}`);
    await cleanupToStart(task).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    config.dryRun = original;
  }
}

/**
 * 本地演练同步笔记：用电脑上的图片/视频直接走一遍建笔记流程，不连 VPS。
 * 用法：npm run android:notesync -- --files a.jpg,b.mp4 [--caption "文案"] [--live]
 */
async function probeNoteSync(): Promise<void> {
  const argOf = (flag: string) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const rawFiles = (argOf('--files') || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!rawFiles.length) {
    throw new Error('用法：npm run android:notesync -- --files 图片或视频路径[,更多] [--caption "文案"] [--live]');
  }

  const live = process.argv.includes('--live');
  const caption = argOf('--caption');
  const task: Task = {
    taskId: `probe${Date.now().toString(36)}`,
    kind: 'noteSync',
    appUserName: '本机账号',
    appContentIdentifier: 'note-sync-probe',
    claimToken: '',
    noteSync: { tgKeyword: 'probe', caption, files: [] }
  };

  // 演练直接用本地文件，跳过下载环节；其余步骤和真实任务完全一致。
  await fs.mkdir(ASSET_CACHE_DIR, { recursive: true });
  const assets: PushedAsset[] = [];
  for (const [index, source] of rawFiles.entries()) {
    if (!existsSync(source)) throw new Error(`文件不存在：${source}`);
    const isVideo = /\.(mp4|mov|3gp|mkv)$/i.test(source);
    const fileName = `tgnote-${task.taskId}-${String(index + 1).padStart(2, '0')}${path.extname(source) || (isVideo ? '.mp4' : '.jpg')}`;
    const remotePath = `/sdcard/${isVideo ? 'Movies' : 'Pictures'}/${fileName}`;
    await adb('push', source, remotePath);
    await mediaScan(remotePath);
    assets.push({ fileType: isVideo ? 'video' : 'photo', remotePath, fileName });
  }
  await wait(1500);

  console.log(`[Android Probe] ${live ? '真实创建笔记' : '演练'}：${assets.length} 个素材${caption ? '，含文案' : ''}`);
  const selectors = config.selectors.noteSync;
  if (!selectors) throw new Error('selectors 缺少 noteSync 配置。');
  const original = config.dryRun;
  config.dryRun = !live;
  resetPerf();
  try {
    await launchApp();
    await runRecipientSteps(selectors.entrySteps, task, '进入我的笔记：');
    const before = await readNoteCount(task, selectors);
    await runRecipientSteps(selectors.createSteps, task, '新增笔记：');

    if (caption?.trim()) {
      if (await hasAdbKeyboard()) {
        await tapSelector(selectors.textBlock, task, '插入文字块', 1500);
        await typeUnicodeText(caption.trim());
        await pressBack(1000);
      } else {
        console.warn('[Android Probe] ⚠️ 未检测到 ADBKeyBoard，本次跳过文案。');
      }
    }

    const photos = assets.filter(asset => asset.fileType === 'photo');
    const videos = assets.filter(asset => asset.fileType === 'video');
    if (photos.length) await pickAssets(task, selectors, selectors.photoBlock, photos, '照片');
    if (videos.length) await pickAssets(task, selectors, selectors.videoBlock, videos, '视频');

    if (!live) {
      console.log(`[Android Probe] ✅ 选择器全部命中，已停在保存前（未保存）。（${perfSummary()}）`);
      return;
    }
    await tapSelector(selectors.save, task, '保存笔记', 4000);
    const after = await readNoteCount(task, selectors);
    if (before !== null && after !== null && after <= before) {
      throw new Error(`点了保存但笔记条数没有增加（${before} → ${after}）。`);
    }
    console.log(`[Android Probe] ✅ 笔记已保存：${before ?? '?'} → ${after ?? '?'} 条。（${perfSummary()}）`);
  } catch (error: any) {
    console.error(`[Android Probe] ❌ ${error?.message || error}`);
    process.exitCode = 1;
  } finally {
    config.dryRun = original;
    await cleanupNoteAssets(assets);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--notesync')) {
    await probeNoteSync();
    return;
  }
  if (process.argv.includes('--probe')) {
    await probe();
    return;
  }
  const pollIntervalMs = config.pollIntervalMs || 3000;
  console.log(`[Android Worker] 已启动：${config.workerId}，设备：${config.deviceId || '默认设备'}，adb：${adbBin}${config.dryRun ? '（演练模式，不会真正发送）' : ''}`);
  let lastCircleSyncAt = 0;
  const stop = () => {
    console.log('[Android Worker] 正在退出…');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (true) {
    try {
      const response = await http.get('/api/android/tasks/next', { params: { workerId: config.workerId } });
      const task: Task | null = response.data?.task || null;
      const hold: ClaimHold | null = response.data?.hold || null;
      if (!task) {
        if (hold) console.log(`[Android Worker] 队列暂不放行：${hold.message}`);
        // 服务端要求冷却或已达上限时不去碰手机，避免无谓的前台操作被风控盯上。
        const idleMs = hold ? Math.min(Math.max(hold.retryAfterMs, 1000), 15 * 60_000) : pollIntervalMs;
        // 圈子最快 10 秒刷一次，但没必要推那么勤；默认 3 分钟一批。
        const syncInterval = config.circleSync?.intervalMs || 180_000;
        if (config.circleSync?.enabled && hold?.reason !== 'worker-busy' && Date.now() - lastCircleSyncAt >= syncInterval) {
          lastCircleSyncAt = Date.now();
          await syncCircleLeads().catch(error => console.error(`[Android Worker] 圈子扫描失败：${error?.message || error}`));
        }
        await wait(idleMs);
        continue;
      }
      const isNoteSync = task.kind === 'noteSync';
      console.log(isNoteSync
        ? `[Android Worker] 开始同步笔记 ${task.taskId}：${task.noteSync?.tgKeyword}（${task.noteSync?.files.length || 0} 个素材）`
        : `[Android Worker] 开始任务 ${task.taskId}：${task.appUserName} ← ${task.appContentIdentifier}`);
      resetPerf();
      try {
        if (isNoteSync) await executeNoteSync(task);
        else await executeTask(task);
        await complete(task, true);
        console.log(`[Android Worker] 任务成功：${task.taskId}（${perfSummary()}）`);
      } catch (error: any) {
        const message = String(error?.message || error).slice(0, 500);
        console.error(`[Android Worker] 任务失败：${task.taskId}，${message}`);
        await cleanupToStart(task).catch(() => undefined);
        await complete(task, false, message);
      }
    } catch (error: any) {
      console.error(`[Android Worker] 轮询异常：${error?.response?.data?.error || error?.message || error}`);
      await wait(pollIntervalMs);
    }
  }
}

main().catch(error => {
  console.error('[Android Worker] 致命错误：', error?.message || error);
  process.exit(1);
});
