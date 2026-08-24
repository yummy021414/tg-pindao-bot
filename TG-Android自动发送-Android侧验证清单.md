# TG-Android 自动发送系统 — Android 侧技术验证清单

在写任何代码之前先做完这份验证。目的只有一个：**确认目标 App 的界面能不能被程序稳定定位和点击**。

如果验证不通过，MVP 需求文档里被列为「后续扩展」的 OCR/视觉识别就会变成必做项，工作量和排期要重估。

已确认的前提：

- Bot 跑在 Linux VPS 的 Docker 里
- Android 模拟器跑在本地 Windows 电脑上
- 两者不在同一台机器，因此必须通过 HTTP 接口通信（本清单验证通过后再实现）

---

## 第 0 步：环境准备

### 装模拟器

推荐 Android Studio 自带的 Android Emulator，理由是它的 ADB 支持最完整，`uiautomator` 行为最标准。

雷电/MuMu/BlueStacks 这类游戏模拟器也能用 ADB，但它们改过系统框架，`uiautomator dump` 经常抓不全，遇到问题很难判断是 App 的问题还是模拟器的问题。**验证阶段请务必用官方 Emulator**，避免误判。

镜像选择：

- 系统镜像选 **x86_64**，ARM 镜像在 Windows 上慢到没法用
- Android 版本选 **11 或 12**（API 30/31）。太新的版本部分 App 有兼容问题，太旧的又可能被 App 拒绝登录
- 选 **不带 Google Play 的镜像**（即 AOSP 版本），这种镜像默认有 root，后续调试方便

### 找到 adb

Android Studio 装完后 adb 的默认路径：

```powershell
$env:Path += ";$env:LOCALAPPDATA\Android\Sdk\platform-tools"
adb version
```

建议把这个路径加进系统环境变量，省得每次都设。

### 装好 App 并登录

在模拟器里装上目标 App，用**小号**登录（自动化操作有封号风险，不要用主号）。手动进「圈子」，确认至少有 1 条你打算用来测试的笔记，以及 1 个能接收私信的目标用户。

---

## 第 1 步：确认 ADB 连接

```powershell
adb devices
```

期望看到类似 `emulator-5554   device`。

如果显示 `unauthorized`，在模拟器屏幕上点允许调试授权。如果列表是空的，先执行 `adb kill-server` 再 `adb devices`。

**记录**：设备序列号 = `________________`

---

## 第 2 步：抓控件树（最关键的一步）

手动把 App 停在「圈子」列表页，然后执行：

```powershell
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml ./ui-01-圈子列表.xml
```

打开 `ui-01-圈子列表.xml` 看内容，这决定了整个项目的走向：

| 看到的内容 | 含义 | 结论 |
|---|---|---|
| 大量 `<node>`，带 `resource-id`、`text`、`content-desc` | 原生控件，可精确定位 | 最好的情况，UIAutomator 够用 |
| 有 `<node>` 但 `resource-id` 全空、只有 `text` | 混合渲染，可按文本定位 | 可用，但选择器较脆弱 |
| 只有一两个巨大的 node，里面什么都没有 | Flutter / 自绘 canvas | **必须上 OCR**，需重估排期 |
| 报错或文件是空的 | dump 被 App 反调试拦截 | 需要换方案（无障碍服务或纯图像） |

**记录**：
- 圈子列表页的 dump 结果类型 = `________________`
- 笔记条目的定位方式（resource-id / text / 坐标）= `________________`

> 提示：如果 `uiautomator dump` 卡住不返回，通常是页面上有正在播放的动画或视频。等页面静止后再试，或加 `--compressed` 参数。

---

## 第 3 步：逐步验证发送流程

需求文档 §7 定义的五步，每一步都单独 dump 一次，把能用的选择器记下来。这份记录就是后续写自动化脚本的依据。

每一步的通用做法：

```powershell
# 1. 手动在模拟器上操作到目标页面
# 2. dump 当前页面
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml ./ui-0X-页面名.xml
# 3. 同时截图，方便对照
adb shell screencap -p /sdcard/s.png
adb pull /sdcard/s.png ./shot-0X-页面名.png
```

### 3.1 打开 App

拿到包名和启动 Activity：

```powershell
# App 在前台时执行，看当前 Activity
adb shell dumpsys window | Select-String "mCurrentFocus"
```

**记录**：包名 = `________________`  启动命令 = `adb shell monkey -p 包名 -c android.intent.category.LAUNCHER 1`

### 3.2 进入「圈子」

**记录**：入口按钮的定位方式 = `________________`

### 3.3 定位并打开指定笔记

这是需求文档里 `app_content_position` 字段真正要存的东西。重点判断：

- 笔记能不能靠**标题文字**唯一定位？（最稳）
- 还是只能靠**在列表里的第几个**？（feed 顺序一变就错，很脆弱）
- App 内有没有搜索框，能直接搜到这条笔记？（最理想）

**记录**：定位手段 = `________________`  是否需要滚动查找 = `________________`

### 3.4 点开分享/发送入口

**记录**：按钮定位方式 = `________________`

### 3.5 选择目标用户并发送

这对应 `app_user_name` 字段。同样要判断是能搜索用户名，还是只能在好友列表里翻。

**记录**：用户定位方式 = `________________`  发送确认按钮 = `________________`

### 3.6 确认发送成功的判定信号

自动化必须能自己判断成功还是失败，不能只是「点完就算成功」。找一个可靠信号：

- 出现「已发送」toast？
- 弹窗自动关闭并返回上一页？
- 会话列表里出现新记录？

**记录**：成功信号 = `________________`  失败时的表现 = `________________`

---

## 第 4 步：验证程序化点击

前面都是手动操作加 dump。这一步要确认程序真的能点得动。挑第 3.2 步的「圈子」入口试：

```powershell
# 用 dump 出来的 bounds 中心点坐标
adb shell input tap 540 1800

# 输入文本（搜索框场景）
adb shell input text "test"

# 滚动
adb shell input swipe 540 1500 540 500 300
```

如果 `input tap` 有反应，说明最基础的自动化通路是打通的。

**记录**：程序化点击是否生效 = `________________`

> 注意：`adb shell input text` 不支持中文。后续如果需要输入中文（比如搜索笔记标题、用户名），要用 ADBKeyBoard 这类输入法 APK，或者改用 Appium 的 `setValue`。这一点提前确认，会影响技术选型。

---

## 第 5 步：判定结论

把上面的记录汇总，对照下表：

| 情况 | 后续方案 | 大致工作量 |
|---|---|---|
| 控件树完整，关键元素都有 resource-id | Appium + UIAutomator2，按选择器写脚本 | Android 侧 3-5 天 |
| 只能按 text 定位，但都能定位到 | 同上，但选择器更脆弱，要多加重试和超时 | Android 侧 5-8 天 |
| 部分页面抓不到控件 | UIAutomator 为主 + 关键页面 OCR 兜底 | Android 侧 2 周以上 |
| 完全抓不到控件 | 纯图像识别（模板匹配 + OCR），需重新评估 MVP 范围 | 需要重新排期 |

---

## 附：验证通过后的开发顺序

1. **TG 侧数据层**：在 `src/database/json-database.ts` 的 `DatabaseData` 里加 `appUsers`、`appContents`、`sendTasks` 三个集合
2. **TG 侧管理命令**：`/绑定用户`、`/绑定内容`、`/映射列表`，用于录入人工映射（需求文档 §12 把管理界面推后了，但 MVP 总得有录入手段）
3. **TG 侧发送命令**：注意 Telegram 不把 `/发送` 识别为命令实体（只认 `[a-zA-Z0-9_]`），要注册成 `/send` 或在文本处理器里拦截中文
4. **任务队列 + HTTP 接口**：因为模拟器和 bot 不同机，执行端通过 HTTP 轮询领任务、回写结果。项目里已有 `express` 和 `src/web/server.ts` 可以直接扩展
5. **Android 执行端**：按本清单记录的选择器实现五步流程
6. **节流保护**：任务之间加随机延迟，并设每日发送上限。连续私信是第三方 App 风控最敏感的行为

---

## 风险提醒

- 自动化操作第三方社交 App 大概率违反其服务条款，账号被封是可预期成本，全程用小号
- App 版本更新会让 UI 选择器失效，需要预留维护成本
- 模拟器的分辨率和系统语言一旦改变，坐标类定位会全部失效。建议固定一套模拟器配置并记录下来
