# WE 壁纸新标签页

浏览器新标签页太素了，而 Wallpaper Engine 里好看的壁纸都待在桌面上。
这个小扩展把两者接上：打开新标签页就是你的场景壁纸，能动、能跟着鼠标晃、还能点。

当前版本 **1.0.0**。

![新标签页](docs/img/hero.png)

## 它能做什么

- **场景壁纸**：直接读 `scene.pkg` 或散装 `scene.json`，本地渲染，不联网
- **视频 / 图片**：`video/*`、`image/*`、`gif` 走原生标签播放
- **壁纸自己的属性**：作品里做的那些滑块、开关、下拉、颜色，都会出现在面板里，拖一下立刻生效
- **鼠标视差**：移动鼠标，画面跟着轻微位移（下面有个坑，见后文）
- **画质与性能**：帧率上限、渲染倍率、FXAA/MSAA、粒子、后处理，随时改随时生效；帧率掉下去会自动降分辨率
- **亮度、场景音量、自动轮换**：轮换支持 5/10/30/60 分钟，顺序或随机
- **音频响应**：麦克风频谱，或接 [media-bridge](https://github.com/oneincase/media-bridge) 用系统声音
- **从壁纸取色（莫奈）**：按壁纸配色/画面主色生成界面强调色，设置面板里可关

### 设置面板

![设置面板](docs/img/settings.png)

右下角齿轮打开。壁纸库按类型分组，超过 50 张那一组会变成可滚动的框，滚轮停在框里就能翻，不用去够滚动条。

## 装上试试

1. `edge://extensions`（或 `chrome://extensions`）→ 打开「开发人员模式」
2. 「加载解压缩的扩展」→ 选这个仓库里的 `we-newtab` 目录
3. 新标签页右下角齿轮 →「添加目录…」→ 选壁纸目录

Steam 创意工坊的壁纸通常在：

```
<你的 Steam 库>\steamapps\workshop\content\431960\<创意工坊 id>\
```

也可以直接选 Wallpaper Engine 的 `projects` 目录，两种结构都认。

## 在 Steam 里找新壁纸

设置 → 壁纸目录 →「在 Steam 中浏览工坊」会在新标签页打开 Wallpaper Engine 的创意工坊页面。
点订阅后下载交给 Steam 客户端，下完扩展会自动扫到（目录监听），不用回设置里刷新。
## 踩过的几个坑

写的时候最花时间的不是功能，是这些：

**沙箱里什么都不给用。** 场景必须在 `sandbox` 页里渲染（要 `eval`），而沙箱是不透明源：
`localStorage` 一碰就抛 `SecurityError`，`caches` 直接不可用。最后用 `Object.defineProperty`
把它们垫成内存实现，才让引擎跑起来。

**大包不能复制。** 300MB 的 `scene.pkg` 如果读成 ArrayBuffer 再 `postMessage`，内存直接翻倍。
现在传的是 `File` 对象——结构化克隆只传引用，省掉一次整包复制。

**视差不是不生效，是被图层深度乘没了。** 引擎把相机偏移乘到每个图层的 `parallaxDepth` 上，
而不少壁纸只开了全局 `cameraparallax`、图层没写深度，结果恒等于 0。
现在装配完会检查一遍：缺深度的普通图层补 1，作者写了的保持原样，天空盒跳过。
对照测试：移动鼠标前后做画面互相关，从 0px 变成 14px。

**跨域帧的 `event.source` 不可靠。** 沙箱 iframe 里比对 `event.source === frame.contentWindow`
会漏消息，改成宿主给每个帧编号、回包带编号。

## 场景渲染协议

宿主页和沙箱渲染页之间只有 `postMessage`，一条场景的生命周期长这样：

```
宿主                                  沙箱渲染页
 │  {t:"ping"} ───────────────────────▶  探活（沙箱页可能比宿主先就绪）
 │  ◀─────────────────────── {t:"pong"}
 │  {t:"mount", pkgFile|entry,
 │   project, props, opts} ────────────▶  createScene() + load()
 │                                        └─ {t:"read", id, path}
 │  ◀──────────────── {t:"read:res", file}   宿主用 FS Access 读盘回传
 │  ◀────────────────────── {t:"ready", width, height, layers}
 │  {t:"props"} / {t:"update"} / {t:"volume"} / {t:"audio"}
 │  ◀──────────── {t:"stats"} / {t:"diag"} / {t:"error"}
```

| mount 字段 | 说明 |
|---|---|
| `pkgFile` | 场景包 `File`，只传引用 |
| `entry` | 散装工程入口（如 `scene.json`），和 `pkgFile` 二选一 |
| `props` | 用户属性初值，装配后会再下发一次（有些壁纸装配期不读属性） |
| `opts` | `fps` / `dpr` / `fit` / `scripts` / `quality` / `volume` |

## 有多快

真机：Edge 稳定版 + RTX 5070 Ti Laptop。

| 场景包 | 到首帧 |
|---|---|
| 0.17MB | ~505ms |
| 2.4MB | ~290ms |
| 314MB | ~1.6s（解析占 1.1s） |
| 视频 10.8MB | ~81ms |

时间基本都花在解析、贴图上传和着色器编译上。想压到 250ms 以内，只有很小的场景能做到——
试过关后处理、预热 WebGL、保留解析缓存，收益要么没有要么不明显，所以别信"秒开 3A 场景"这种话。

## 系统音频（可选）

浏览器读不到系统声音，这条只能借本地中间件：

```powershell
media-bridge-win32-x64.exe serve --http 127.0.0.1:8765
```

然后设置 → 动态效果 → 音频响应 →「系统音频（media-bridge）」，端口保持 8765。
扩展订阅它的 SSE 频谱流（`/v1/events?events=spectrum&spectrumMs=100`），64 段直接喂给场景。

没装也没关系，默认用引擎自带的模拟频谱，只是不跟真实声音联动。

## 显卡偏好（可选）

浏览器没有切换 GPU 的接口，得装一次本地辅助程序：

```powershell
cd we-newtab\native
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

它会写 `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`，卸载跑 `uninstall.ps1`。

## 代码结构

```
we-newtab/
  manifest.json       MV3 清单
  newtab.html/.css    页面 + 设置面板
  core.js             基础层：DOM、IndexedDB、设置、文件系统访问
  library.js          壁纸库：目录检测、扫描、列表渲染、变更监听
  playback.js         播放层：场景/视频/图片、属性下发、效果、轮换、音频
  panel.js            设置面板：选项卡、控件、显卡、空状态
  app.js              启动流程
  props.js            壁纸属性引擎
  render.html/.js     沙箱渲染页（WebWallGL 宿主）
  vendor/             WebWallGL 运行时
  native/             显卡偏好 Native Messaging 宿主
  test/smoke.mjs      属性引擎离线用例（23 项）
  docs/               展示页与截图
```

## 做不到的

- 只能替换新标签页，做不了桌面壁纸和多显示器同步
- 系统声音必须借助 media-bridge，浏览器本身拿不到
- 场景解析时间没法缓存（引擎不提供场景序列化），大包就是要等
- 创意工坊的订阅和下载得在 Steam 客户端里做，浏览器端做不了

## 许可

代码 MIT。场景渲染依赖 WebWallGL（MIT，作者 oneincase），`vendor/` 里的文件原样分发。
