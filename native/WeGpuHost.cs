using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// 原生消息宿主：读写 Windows 的浏览器显卡偏好（HKCU\...\DirectX\UserGpuPreferences）。
// 协议：stdin/stdout 各为 4 字节小端长度 + UTF-8 JSON。
internal static class Program
{
    private const string RegPath = @"Software\Microsoft\DirectX\UserGpuPreferences";
    private const string HostName = "com.we.newtab.gpu";

    private static readonly string[] Candidates =
    {
        @"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
        @"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
        @"%LocalAppData%\Microsoft\Edge\Application\msedge.exe",
        @"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        @"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        @"%LocalAppData%\Google\Chrome\Application\chrome.exe",
        @"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe",
        @"%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe",
        @"%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe",
        @"%LocalAppData%\Chromium\Application\chrome.exe",
    };

    private static string Expand(string path)
    {
        return Environment.ExpandEnvironmentVariables(path);
    }

    private static List<string> FindBrowsers()
    {
        var list = new List<string>();
        foreach (var raw in Candidates)
        {
            var path = Expand(raw);
            if (File.Exists(path) && !list.Contains(path)) list.Add(path);
        }
        return list;
    }

    private static int ReadPreference(string exePath)
    {
        using (var key = Registry.CurrentUser.OpenSubKey(RegPath))
        {
            if (key == null) return 0;
            var value = key.GetValue(exePath) as string;
            if (string.IsNullOrEmpty(value)) return 0;
            // 形如 "GpuPreference=2;"
            var idx = value.IndexOf("GpuPreference=", StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return 0;
            var rest = value.Substring(idx + "GpuPreference=".Length);
            var end = rest.IndexOf(';');
            if (end >= 0) rest = rest.Substring(0, end);
            int parsed;
            return int.TryParse(rest.Trim(), out parsed) ? parsed : 0;
        }
    }

    private static void WritePreference(string exePath, int pref)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(RegPath))
        {
            if (key == null) throw new InvalidOperationException("无法写入注册表");
            if (pref <= 0) key.DeleteValue(exePath, false);
            else key.SetValue(exePath, "GpuPreference=" + pref + ";", RegistryValueKind.String);
        }
    }


    // ---------- 其它窗口遮挡采集（Windows） ----------

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);
    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

    private const uint GW_HWNDPREV = 3;
    private const uint GA_ROOT = 2;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x80;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;

    private static string ProcessNameOf(IntPtr hWnd)
    {
        try
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return "";
            using (var process = Process.GetProcessById((int)pid)) return process.ProcessName.ToLowerInvariant();
        }
        catch { return ""; }
    }

    private static bool WindowRectOf(IntPtr hWnd, out RECT rect)
    {
        var size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(RECT));
        if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, size) == 0) return true;
        return GetWindowRect(hWnd, out rect);
    }

    private static bool IsCloaked(IntPtr hWnd)
    {
        int cloaked;
        try { return DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0; }
        catch { return false; }
    }

    private static double UnionArea(List<int[]> rects)
    {
        if (rects.Count == 0) return 0;
        var xs = new List<int>();
        foreach (var r in rects) { xs.Add(r[0]); xs.Add(r[0] + r[2]); }
        xs.Sort();
        var unique = new List<int>();
        foreach (var x in xs) if (unique.Count == 0 || unique[unique.Count - 1] != x) unique.Add(x);
        double area = 0;
        for (var i = 0; i + 1 < unique.Count; i++)
        {
            int x0 = unique[i], x1 = unique[i + 1];
            if (x1 <= x0) continue;
            var intervals = new List<int[]>();
            foreach (var r in rects)
            {
                if (r[0] <= x0 && r[0] + r[2] >= x1)
                    intervals.Add(new[] { r[1], r[1] + r[3] });
            }
            intervals.Sort((a, b) => a[0].CompareTo(b[0]));
            int covered = 0, start = 0, end = 0;
            bool has = false;
            foreach (var it in intervals)
            {
                if (!has) { start = it[0]; end = it[1]; has = true; continue; }
                if (it[0] > end) { covered += end - start; start = it[0]; end = it[1]; }
                else if (it[1] > end) end = it[1];
            }
            if (has) covered += end - start;
            area += (double)covered * (x1 - x0);
        }
        return area;
    }

    private static IntPtr FindEdgeWindow(RECT tab)
    {
        IntPtr byCenter = IntPtr.Zero;
        IntPtr byOverlap = IntPtr.Zero;
        var cx = (tab.Left + tab.Right) / 2;
        var cy = (tab.Top + tab.Bottom) / 2;
        EnumWindowsProc visit = (h, l) =>
        {
            if (!IsWindowVisible(h) || IsIconic(h) || ProcessNameOf(h) != "msedge") return true;
            RECT r;
            if (!WindowRectOf(h, out r)) return true;
            if (cx >= r.Left && cx <= r.Right && cy >= r.Top && cy <= r.Bottom)
            {
                byCenter = h;
                return false;
            }
            if (byOverlap == IntPtr.Zero && r.Right > tab.Left && r.Left < tab.Right && r.Bottom > tab.Top && r.Top < tab.Bottom)
                byOverlap = h;
            return true;
        };
        EnumWindows(visit, IntPtr.Zero);
        GC.KeepAlive(visit);
        return byCenter != IntPtr.Zero ? byCenter : byOverlap;
    }

    private static object WindowCoverage(double x, double y, double w, double h, double dpr)
    {
        try
        {
            var tabRect = new RECT
            {
                Left = (int)Math.Round(x * dpr),
                Top = (int)Math.Round(y * dpr),
                Right = (int)Math.Round((x + w) * dpr),
                Bottom = (int)Math.Round((y + h) * dpr),
            };
            var hwnd = FindEdgeWindow(tabRect);
            if (hwnd == IntPtr.Zero)
                return new Dictionary<string, object> { { "ok", false }, { "reason", "edge-window-not-found" } };
            double left = x * dpr, top = y * dpr, right = (x + w) * dpr, bottom = (y + h) * dpr;
            var tabArea = Math.Max(1, (right - left) * (bottom - top));
            var rects = new List<int[]>();
            var cursor = GetWindow(hwnd, GW_HWNDPREV);
            var guard = 0;
            while (cursor != IntPtr.Zero && guard++ < 512)
            {
                if (IsWindowVisible(cursor) && !IsIconic(cursor) && !IsCloaked(cursor)
                    && (GetWindowLong(cursor, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) == 0
                    && ProcessNameOf(cursor) != "msedge")
                {
                    RECT r;
                    if (WindowRectOf(cursor, out r))
                    {
                        var l = Math.Max(left, r.Left);
                        var t = Math.Max(top, r.Top);
                        var rr = Math.Min(right, r.Right);
                        var bb = Math.Min(bottom, r.Bottom);
                        if (rr > l && bb > t)
                            rects.Add(new[] { (int)Math.Round(l - left), (int)Math.Round(t - top), (int)Math.Round(rr - l), (int)Math.Round(bb - t) });
                    }
                }
                cursor = GetWindow(cursor, GW_HWNDPREV);
            }
            var area = UnionArea(rects);
            var css = new List<object>();
            foreach (var r in rects) css.Add(new[] { r[0] / dpr, r[1] / dpr, r[2] / dpr, r[3] / dpr });
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "coverage", area / tabArea },
                { "rects", css },
                { "count", rects.Count },
            };
        }
        catch (Exception error)
        {
            return new Dictionary<string, object> { { "ok", false }, { "reason", error.Message } };
        }
    }

    // ---------- media-bridge 服务 ----------

    // 默认去 Program Files 找（安装版通常在这里），找不到再退回用户目录
    private static readonly string[] BridgeCandidates =
    {
        @"%ProgramFiles%\media-bridge-win32-x64.exe",
        @"%ProgramFiles%\media-bridge\media-bridge-win32-x64.exe",
        @"%ProgramW6432%\media-bridge-win32-x64.exe",
        @"%ProgramW6432%\media-bridge\media-bridge-win32-x64.exe",
        @"%LOCALAPPDATA%\media-bridge\media-bridge-win32-x64.exe",
        @"%USERPROFILE%\Downloads\media-bridge-win32-x64.exe",
        @"%USERPROFILE%\Desktop\media-bridge-win32-x64.exe",
    };

    private static string FindBridge(string preferred)
    {
        if (!string.IsNullOrWhiteSpace(preferred))
        {
            var wanted = Expand(preferred.Trim().Trim('"'));
            if (File.Exists(wanted)) return wanted;
        }
        foreach (var raw in BridgeCandidates)
        {
            var path = Expand(raw);
            if (File.Exists(path)) return path;
        }
        return null;
    }

    private static string BridgePidFile()
    {
        return Path.Combine(DataDir(), "bridge-pid.txt");
    }

    // 只认自己启动的那一个；按进程名判断会把 DSH 插件等其它 media-bridge 误当成自己的
    private static Process OwnBridgeProcess()
    {
        try
        {
            if (!File.Exists(BridgePidFile())) return null;
            int pid;
            if (!int.TryParse(File.ReadAllText(BridgePidFile()).Trim(), out pid) || pid <= 0) return null;
            var process = Process.GetProcessById(pid);
            if (process.HasExited) return null;
            return process;
        }
        catch
        {
            return null;
        }
    }

    private static bool BridgeRunning()
    {
        return OwnBridgeProcess() != null;
    }

    private static List<Dictionary<string, object>> BridgeProcessList()
    {
        var own = OwnBridgeProcess();
        var ownPid = own == null ? 0 : own.Id;
        var list = new List<Dictionary<string, object>>();
        foreach (var name in new[] { "media-bridge-win32-x64", "media-bridge-win32-arm64" })
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                var path = "";
                try { path = process.MainModule == null ? "" : process.MainModule.FileName; } catch { }
                list.Add(new Dictionary<string, object>
                {
                    { "pid", process.Id },
                    { "path", path },
                    { "own", process.Id == ownPid },
                });
            }
        }
        return list;
    }

    private static string AutostartFile()
    {
        var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        return Path.Combine(startup, "we-newtab-media-bridge.vbs");
    }

    private static int StartBridgeProcess(string path, int port)
    {
        var info = new ProcessStartInfo(path, "serve --http 127.0.0.1:" + port)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(path) ?? Environment.CurrentDirectory,
        };
        var process = Process.Start(info);
        if (process == null) return 0;
        try { File.WriteAllText(BridgePidFile(), process.Id.ToString()); } catch { }
        return process.Id;
    }



    // ---------- 本地壁纸服务（网页壁纸） ----------

    // 网页壁纸需要一个真实的 http 源：iframe 才有正常 origin，前端路由、相对资源、
    // 视频流式、鼠标/触摸才是原生行为。服务独立进程常驻，不随原生消息通道退出。

    private static string DataDir()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WeNewTab");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string PortFile() { return Path.Combine(DataDir(), "web-port.txt"); }
    private static string PidFile() { return Path.Combine(DataDir(), "web-pid.txt"); }
    private static string RootsFile() { return Path.Combine(DataDir(), "web-roots.json"); }

    private static readonly Dictionary<string, string> ContentTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" }, { ".htm", "text/html; charset=utf-8" },
        { ".js", "text/javascript; charset=utf-8" }, { ".mjs", "text/javascript; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" }, { ".json", "application/json; charset=utf-8" },
        { ".png", "image/png" }, { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" },
        { ".gif", "image/gif" }, { ".webp", "image/webp" }, { ".svg", "image/svg+xml" },
        { ".ico", "image/x-icon" }, { ".mp4", "video/mp4" }, { ".webm", "video/webm" },
        { ".mp3", "audio/mpeg" }, { ".ogg", "audio/ogg" }, { ".wav", "audio/wav" },
        { ".woff", "font/woff" }, { ".woff2", "font/woff2" }, { ".ttf", "font/ttf" },
        { ".otf", "font/otf" }, { ".txt", "text/plain; charset=utf-8" },
    };

    // 注入到网页壁纸里的最小 WE 兼容层 + 铺满裁切缩放
    private const string WebShim =
        "(function(){" +
        "if(window.__weShim)return;window.__weShim=true;" +
        "window.wallpaperPropertyListener=window.wallpaperPropertyListener||{};" +
        "window.wallpaperRegisterAudioListener=function(cb){window.__weAudio=cb};" +
        "var __weAudioBuf=new Float32Array(128);var __wePaused=[];" +
        "addEventListener('message',function(e){var d=e.data;if(!d)return;" +
        "if(d.__weProps){pending=d.__weProps;if(!tryApply())queueApply();}" +
        "if(d.__weAudio&&window.__weAudio){try{var L=d.__weAudio.left||[],R=d.__weAudio.right||[];for(var i=0;i<64;i++){__weAudioBuf[i]=Math.min(1,L[i]||0);__weAudioBuf[64+i]=Math.min(1,R[i]||0)}window.__weAudio(__weAudioBuf);if(!window.__weAudioReported){window.__weAudioReported=1;report('audio',{len:__weAudioBuf.length})}}catch(_){}}" +
        "if(d.__weFit){fit(typeof d.__weFit==='object'?d.__weFit.mode:null);}" +
        "if(d.__wePause){__wePaused=[];document.querySelectorAll('audio,video').forEach(function(m){if(!m.paused){__wePaused.push([m,m.currentTime]);m.pause()}});}" +
        "if(d.__weResume){__wePaused.forEach(function(x){try{x[0].currentTime=x[1];x[0].play()}catch(_){}});__wePaused=[];}" +
        "if(d.__weVolume){applyVolume(Number(d.__weVolume.value)||0);}" +
        "});" +
        "var pending=null,applyTimer=null;" +
        "function tryApply(){var L=window.wallpaperPropertyListener;if(pending&&L&&L.applyUserProperties){try{var keys=Object.keys(pending);L.applyUserProperties(pending);report('props',{n:keys.length,none:0});pending=null;if(applyTimer){clearInterval(applyTimer);applyTimer=null}return true}catch(_){report('error',{msg:'applyUserProperties failed',st:String(_.stack||'')});return true}}return false}" +
        "function queueApply(){if(applyTimer)return;var n=0;applyTimer=setInterval(function(){tryApply();if(!pending||++n>50){clearInterval(applyTimer);applyTimer=null}},200);}" +
        "function report(kind,extra){try{var m={kind:kind,title:document.title||'',w:innerWidth,h:innerHeight};if(extra)for(var k in extra)m[k]=extra[k];parent.postMessage({__weWeb:m},'*');}catch(_){}}" +
        "var fitMode='cover',lastW=0,lastH=0,lastMode='',webVolume=1;" +
        "function applyVolume(v,silent){webVolume=Math.max(0,Math.min(1,v));var ms=document.querySelectorAll('audio,video');for(var i=0;i<ms.length;i++){ms[i].volume=webVolume;ms[i].muted=webVolume<=0}if(!silent)report('volume',{v:webVolume})}" +
        "if(window.MutationObserver){new MutationObserver(function(){applyVolume(webVolume,true)}).observe(document.documentElement,{childList:true,subtree:true})}" +
        "function fit(mode){" +
        "if(mode)fitMode=mode;" +
        "var doc=document.documentElement,body=document.body;if(!body)return;" +
        "body.style.transform='';body.style.position='';body.style.width='';body.style.height='';body.style.left='';body.style.top='';" +
        "doc.style.overflow='hidden';" +
        "var nw=Math.max(doc.scrollWidth,body.scrollWidth,innerWidth||1);" +
        "var nh=Math.max(doc.scrollHeight,body.scrollHeight,innerHeight||1);" +
        "if(nw===lastW&&nh===lastH&&fitMode===lastMode){report('fit',{nw:nw,nh:nh,s:1,mode:fitMode});return;}" +
        "lastW=nw;lastH=nh;lastMode=fitMode;" +
        "if(nw<=innerWidth+1&&nh<=innerHeight+1){report('fit',{nw:nw,nh:nh,s:1,mode:fitMode});return;}" +
        "var sx=innerWidth/nw,sy=innerHeight/nh,s;" +
        "if(fitMode==='contain'){s=Math.min(sx,sy);}else if(fitMode==='stretch'){s=1;}else{s=Math.max(sx,sy);}" +
        "body.style.position='absolute';body.style.transformOrigin='0 0';" +
        "if(fitMode==='stretch'){body.style.width=innerWidth+'px';body.style.height=innerHeight+'px';body.style.transform='scale('+sx+','+sy+')';}" +
        "else{body.style.width=nw+'px';body.style.height=nh+'px';body.style.transform='scale('+s+')';}" +
        "body.style.left=((innerWidth-nw*sx)/2)+'px';body.style.top=((innerHeight-nh*(fitMode==='stretch'?sy:s))/2)+'px';" +
        "report('fit',{nw:nw,nh:nh,s:s,mode:fitMode});" +
        "}" +
        "addEventListener('resize',fit);" +
        "addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){report('resource',{url:String(t.src||t.href).slice(-80)})}else{report('error',{msg:String(e.message||e),st:String(e.error&&e.error.stack||'')})}},true);" +
        "if(document.fonts){document.fonts.ready.then(function(){" +
        "var fams=[];try{for(var i=0;i<document.styleSheets.length;i++){var ss=document.styleSheets[i],rules;try{rules=ss.cssRules}catch(_){continue}for(var j=0;j<rules.length;j++){var r=rules[j];var t=r.type===5||(r.constructor&&r.constructor.name==='CSSFontFaceRule');if(!t)continue;var f=String(r.style.fontFamily||'').replace(/[\\x22\\x27]/g,'').trim();if(f&&fams.indexOf(f)<0)fams.push(f)}}}catch(_){}" +
        "var miss=[];for(var k=0;k<fams.length;k++){try{if(!document.fonts.check('16px '+String.fromCharCode(34)+fams[k]+String.fromCharCode(34)))miss.push(fams[k])}catch(_){}}" +
        "report('fontcheck',{total:fams.length,missing:miss.length,list:miss.join('|').slice(0,120)});" +
        "for(var q=0;q<fams.length;q++){(function(fam){try{document.fonts.load('16px '+String.fromCharCode(34)+fam+String.fromCharCode(34)).then(function(faces){report('fontloaded',{family:fam,ok:faces.length>0})}).catch(function(){report('fontloaded',{family:fam,ok:false})})}catch(_){}})(fams[q])}" +
        "}).catch(function(){});}" +
        "if(document.readyState==='complete'){setTimeout(fit,120);}else{addEventListener('load',function(){setTimeout(fit,120)})}" +
        "setTimeout(fit,1500);" +
        "setTimeout(fit,3500);setTimeout(fit,7000);" +
        "if(window.ResizeObserver){var ro=new ResizeObserver(function(){clearTimeout(window.__weFitT);window.__weFitT=setTimeout(function(){fit();},200)});addEventListener('load',function(){try{ro.observe(document.documentElement);ro.observe(document.body)}catch(_){}});}" +
        "function inputReport(e){report('pointer',{x:e.clientX,y:e.clientY,type:e.pointerType||e.type})}" +
        "addEventListener('pointerdown',inputReport,true);" +
        "addEventListener('touchstart',function(e){var t=e.touches&&e.touches[0];report('pointer',{x:t?t.clientX:0,y:t?t.clientY:0,type:'touch'})},true);" +
        "setTimeout(function(){var L=window.wallpaperPropertyListener;report('listener',{has:!!(L&&L.applyUserProperties),type:typeof L})},1200);" +
        "setTimeout(function(){var L=window.wallpaperPropertyListener;report('listener',{has:!!(L&&L.applyUserProperties),type:typeof L})},3000);" +
        "function reportMedia(){try{var vs=document.querySelectorAll('video');var arr=[];for(var i=0;i<vs.length;i++){var v=vs[i];arr.push({src:String(v.currentSrc||v.src||'').split('/').pop(),paused:v.paused,rs:v.readyState,t:Math.round(v.currentTime*10)/10,vol:v.volume,muted:v.muted})}report('media',{n:vs.length,videos:JSON.stringify(arr).slice(0,300)})}catch(_){}}" +
        "function autoplayMedia(){try{var ms=document.querySelectorAll('video,audio');for(var i=0;i<ms.length;i++){var m=ms[i];if(m.paused){var p=m.play();if(p&&p.catch)p.catch(function(){})}}}catch(_){}}" +
        "setTimeout(autoplayMedia,1200);setTimeout(autoplayMedia,2500);" +
        "setTimeout(reportMedia,3000);setTimeout(reportMedia,6000);" +
        "report('ready');" +
        "})();";

    private static List<string> _rootsCache;
    private static DateTime _rootsAt = DateTime.MinValue;

    // 读取扩展写入的根目录 + Steam 库目录
    private static List<string> LoadRoots()
    {
        if (_rootsCache != null && (DateTime.UtcNow - _rootsAt).TotalSeconds < 10) return _rootsCache;
        var list = new List<string>();
        try
        {
            var file = RootsFile();
            if (File.Exists(file))
            {
                var serializer = new JavaScriptSerializer();
                var arr = serializer.Deserialize<List<string>>(File.ReadAllText(file, Encoding.UTF8));
                if (arr != null) list.AddRange(arr);
            }
        }
        catch { }
        foreach (var root in SteamRoots()) if (!list.Contains(root)) list.Add(root);
        _rootsCache = list;
        _rootsAt = DateTime.UtcNow;
        return list;
    }

    private static List<string> SteamRoots()
    {
        var roots = new List<string>();
        var libs = new List<string>();
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
            {
                var steam = key == null ? null : key.GetValue("SteamPath") as string;
                if (!string.IsNullOrEmpty(steam)) libs.Add(steam.Replace('/', '\\'));
            }
        }
        catch { }
        foreach (var guess in new[] { @"%ProgramFiles(x86)%\Steam", @"%ProgramFiles%\Steam", @"%LocalAppData%\Steam" })
        {
            var path = Expand(guess);
            if (Directory.Exists(path) && !libs.Contains(path)) libs.Add(path);
        }
        foreach (var lib in new List<string>(libs))
        {
            var vdf = Path.Combine(lib, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(vdf)) continue;
            try
            {
                foreach (var line in File.ReadAllLines(vdf))
                {
                    var trimmed = line.Trim();
                    if (trimmed.IndexOf("\"path\"", StringComparison.OrdinalIgnoreCase) != 0) continue;
                    var pieces = trimmed.Split('"');
                    if (pieces.Length < 4) continue;
                    var extra = pieces[3].Replace("\\\\", "\\");
                    if (Directory.Exists(extra) && !libs.Contains(extra)) libs.Add(extra);
                }
            }
            catch { }
        }
        foreach (var lib in libs)
        {
            var workshop = Path.Combine(lib, "steamapps", "workshop", "content", "431960");
            if (Directory.Exists(workshop) && !roots.Contains(workshop)) roots.Add(workshop);
            var projects = Path.Combine(lib, "steamapps", "common", "wallpaper_engine", "projects");
            if (Directory.Exists(projects) && !roots.Contains(projects)) roots.Add(projects);
        }
        return roots;
    }


    // Wallpaper Engine 自带的全局字体目录（assets/fonts），场景里常直接引用这些字体名
    private static string WeFontsDir()
    {
        foreach (var root in SteamRoots())
        {
            try
            {
                // root = ...\steamapps\workshop\content\431960
                var lib = Path.GetFullPath(Path.Combine(root, "..", "..", "..", ".."));
                var fonts = Path.Combine(lib, "steamapps", "common", "wallpaper_engine", "assets", "fonts");
                if (Directory.Exists(fonts)) return fonts;
            }
            catch { }
        }
        return null;
    }

    // ---------- 宿主扫描（Steam / WE projects） ----------

    private static string WallMapFile() { return Path.Combine(DataDir(), "wall-map.json"); }
    private static Dictionary<string, string> _wallMap = null;
    private static DateTime _wallMapAt = DateTime.MinValue;

    private static Dictionary<string, string> LoadWallMap()
    {
        if (_wallMap != null) return _wallMap;
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (File.Exists(WallMapFile()))
            {
                var serializer = new JavaScriptSerializer();
                var raw = serializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(WallMapFile(), Encoding.UTF8));
                if (raw != null) foreach (var kv in raw) map[kv.Key] = kv.Value;
            }
        }
        catch { }
        _wallMap = map;
        return map;
    }

    private static string ShortHash(string text)
    {
        using (var sha = System.Security.Cryptography.SHA1.Create())
        {
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
            var sb = new StringBuilder();
            for (var i = 0; i < 6; i++) sb.Append(bytes[i].ToString("x2"));
            return sb.ToString();
        }
    }

    private static object ScanWalls()
    {
        var started = Environment.TickCount;
        var entries = new List<Dictionary<string, object>>();
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in LoadRoots())
        {
            if (!Directory.Exists(root)) continue;
            var candidates = new List<string>();
            try
            {
                foreach (var dir in Directory.GetDirectories(root)) candidates.Add(dir);
                foreach (var dir in Directory.GetDirectories(root))
                {
                    try { foreach (var sub in Directory.GetDirectories(dir)) candidates.Add(sub); } catch { }
                }
            }
            catch { }
            foreach (var dir in candidates)
            {
                var projectFile = Path.Combine(dir, "project.json");
                if (!File.Exists(projectFile)) continue;
                string full;
                try { full = Path.GetFullPath(dir); } catch { continue; }
                if (!seen.Add(full)) continue;
                Dictionary<string, object> project = null;
                try
                {
                    var serializer = new JavaScriptSerializer();
                    project = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(projectFile, Encoding.UTF8));
                }
                catch { continue; }
                var id = "p" + ShortHash(full);
                map[id] = full;
                var type = project.ContainsKey("type") ? Convert.ToString(project["type"]) : "";
                entries.Add(new Dictionary<string, object>
                {
                    { "hostId", id },
                    { "dir", full },
                    { "title", project.ContainsKey("title") ? Convert.ToString(project["title"]) : Path.GetFileName(full) },
                    { "type", type == null ? "" : type.ToLowerInvariant() },
                    { "preview", project.ContainsKey("preview") ? Convert.ToString(project["preview"]) : "" },
                    { "file", project.ContainsKey("file") ? Convert.ToString(project["file"]) : "" },
                    { "contentrating", project.ContainsKey("contentrating") ? Convert.ToString(project["contentrating"]) : "" },
                    { "project", project },
                });
            }
        }
        try
        {
            var serializer = new JavaScriptSerializer();
            File.WriteAllText(WallMapFile(), serializer.Serialize(map), new UTF8Encoding(false));
            _wallMap = map;
            _wallMapAt = DateTime.UtcNow;
        }
        catch { }
        var list = new List<object>();
        foreach (var e in entries) list.Add(e);
        var rootList = new List<object>();
        foreach (var root in LoadRoots()) rootList.Add(root);
        return new Dictionary<string, object>
        {
            { "ok", true },
            { "count", entries.Count },
            { "ms", Environment.TickCount - started },
            { "roots", rootList },
            { "entries", list },
        };
    }

    private static string ThumbDir()
    {
        var dir = Path.Combine(DataDir(), "thumbs");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string VideoCacheDir()
    {
        var dir = Path.Combine(DataDir(), "video-cache");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string ThumbFile(string id)
    {
        var map = LoadWallMap();
        string dir;
        if (!map.TryGetValue(id, out dir)) return null;
        string preview = "preview.jpg";
        try
        {
            var serializer = new JavaScriptSerializer();
            var project = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dir, "project.json"), Encoding.UTF8));
            if (project != null && project.ContainsKey("preview") && !string.IsNullOrWhiteSpace(Convert.ToString(project["preview"])))
                preview = Convert.ToString(project["preview"]);
        }
        catch { }
        var src = Path.Combine(dir, preview.Replace('/', '\\'));
        if (!File.Exists(src)) return null;
        var ext = Path.GetExtension(src);
        var cache = Path.Combine(ThumbDir(), id + ext);
        try
        {
            if (!File.Exists(cache) || File.GetLastWriteTimeUtc(cache) < File.GetLastWriteTimeUtc(src))
                File.Copy(src, cache, true);
            return cache;
        }
        catch { return src; }
    }

    private static string FindFfmpeg()
    {
        foreach (var guess in new[]
        {
            @"%USERPROFILE%\scoop\shims\ffmpeg.exe",
            @"%LOCALAPPDATA%\Programs\ffmpeg\bin\ffmpeg.exe",
            @"C:\ffmpeg\bin\ffmpeg.exe",
            @"%ProgramFiles%\ffmpeg\bin\ffmpeg.exe",
        })
        {
            var path = Expand(guess);
            if (File.Exists(path)) return path;
        }
        try
        {
            var info = new ProcessStartInfo("where.exe", "ffmpeg")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            };
            using (var process = Process.Start(info))
            {
                if (process != null)
                {
                    var output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(3000);
                    foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                        if (File.Exists(line.Trim())) return line.Trim();
                }
            }
        }
        catch { }
        return null;
    }

    private static string FindFfprobe()
    {
        foreach (var guess in new[]
        {
            @"%USERPROFILE%\scoop\shims\ffprobe.exe",
            @"%LOCALAPPDATA%\Programs\ffmpeg\bin\ffprobe.exe",
            @"C:\ffmpeg\bin\ffprobe.exe",
            @"%ProgramFiles%\ffmpeg\bin\ffprobe.exe",
        })
        {
            var path = Expand(guess);
            if (File.Exists(path)) return path;
        }
        try
        {
            var info = new ProcessStartInfo("where.exe", "ffprobe")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            };
            using (var process = Process.Start(info))
            {
                if (process != null)
                {
                    var output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(3000);
                    foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                        if (File.Exists(line.Trim())) return line.Trim();
                }
            }
        }
        catch { }
        return null;
    }

    private static Dictionary<string, object> ProbeVideo(string path)
    {
        var info = new Dictionary<string, object>();
        try
        {
            var ffprobe = FindFfprobe();
            if (ffprobe == null) return info;
            var psi = new ProcessStartInfo(ffprobe,
                "-v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -of default=noprint_wrappers=1 \"" + path + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var process = Process.Start(psi))
            {
                if (process == null) return info;
                var output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(5000);
                foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var idx = line.IndexOf('=');
                    if (idx <= 0) continue;
                    var key = line.Substring(0, idx).Trim();
                    var value = line.Substring(idx + 1).Trim();
                    if (key == "width" || key == "height")
                    {
                        double number;
                        if (double.TryParse(value, out number)) info[key] = (int)number;
                    }
                    else if (key == "avg_frame_rate")
                    {
                        double fps = 0;
                        var parts = value.Split('/');
                        if (parts.Length == 2)
                        {
                            double a, b;
                            if (double.TryParse(parts[0], out a) && double.TryParse(parts[1], out b) && b > 0) fps = a / b;
                        }
                        else double.TryParse(value, out fps);
                        if (fps > 0) info["fps"] = Math.Round(fps * 100) / 100;
                    }
                }
            }
        }
        catch { }
        return info;
    }

    private static readonly Dictionary<string, Process> VideoJobs = new Dictionary<string, Process>();

    private static string VideoHash(string id, string path, double fps)
    {
        try
        {
            var info = new FileInfo(path);
            return "v" + ShortHash(id + "|" + path + "|" + info.Length + "|" + info.LastWriteTimeUtc.Ticks + "|" + fps.ToString("0.##"));
        }
        catch { return "v" + ShortHash(id + "|" + path + "|" + fps.ToString("0.##")); }
    }

    private static object VideoPrepare(string id, string relative, double targetFps)
    {
        var map = LoadWallMap();
        string dir;
        if (!map.TryGetValue(id, out dir))
            return new Dictionary<string, object> { { "ok", false }, { "error", "unknown-id" } };
        var baseFull = Path.GetFullPath(dir);
        var src = Path.GetFullPath(Path.Combine(baseFull, (relative ?? "").Replace('/', '\\')));
        if (!src.StartsWith(baseFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(src))
            return new Dictionary<string, object> { { "ok", false }, { "error", "source-not-found" } };

        var probe = ProbeVideo(src);
        var sourceFps = probe.ContainsKey("fps") ? Convert.ToDouble(probe["fps"]) : 30;
        var width = probe.ContainsKey("width") ? Convert.ToInt32(probe["width"]) : 0;
        var height = probe.ContainsKey("height") ? Convert.ToInt32(probe["height"]) : 0;
        var fps = targetFps > 0 ? Math.Min(240, Math.Round(targetFps)) : sourceFps;
        // 源帧率本来就不高于显示器上限：不转码，直接原片（最高分辨率 + 原生帧率）
        if (fps >= sourceFps - 0.5)
        {
            return new Dictionary<string, object>
            {
                { "ok", true }, { "state", "original" },
                { "width", width }, { "height", height },
                { "sourceFps", sourceFps }, { "fps", sourceFps },
            };
        }

        var hash = VideoHash(id, src, fps);
        var outFile = Path.Combine(VideoCacheDir(), hash + ".mp4");
        var tempFile = outFile + ".part.mp4";
        var port = EnsureWebServer();
        if (File.Exists(outFile))
            return new Dictionary<string, object>
            {
                { "ok", true }, { "state", "ready" },
                { "url", "http://127.0.0.1:" + port + "/vcache/" + hash + ".mp4" },
                { "width", width }, { "height", height },
                { "sourceFps", sourceFps }, { "fps", fps },
            };
        if (File.Exists(tempFile))
        {
            long length = 0;
            try { length = new FileInfo(tempFile).Length; } catch { }
            var ffmpegs = Process.GetProcessesByName("ffmpeg");
            if (ffmpegs.Length > 0)
                return new Dictionary<string, object> { { "ok", true }, { "state", "running" }, { "fps", fps } };
            double age = 0;
            try { age = (DateTime.UtcNow - File.GetLastWriteTimeUtc(tempFile)).TotalMilliseconds; } catch { }
            if (length > 1024 && age >= 800)
            {
                try { if (File.Exists(outFile)) File.Delete(outFile); File.Move(tempFile, outFile); } catch { }
                if (File.Exists(outFile))
                    return new Dictionary<string, object>
                    {
                        { "ok", true }, { "state", "ready" },
                        { "url", "http://127.0.0.1:" + port + "/vcache/" + hash + ".mp4" },
                        { "width", width }, { "height", height },
                        { "sourceFps", sourceFps }, { "fps", fps },
                    };
            }
            if (length <= 1024 && age >= 5000)
            {
                try { File.Delete(tempFile); } catch { }
                return new Dictionary<string, object> { { "ok", false }, { "error", "ffmpeg-failed" } };
            }
            return new Dictionary<string, object> { { "ok", true }, { "state", "running" }, { "fps", fps } };
        }
        try
        {
            try { if (File.Exists(tempFile)) File.Delete(tempFile); } catch { }
            var ffmpeg = FindFfmpeg();
            if (ffmpeg == null)
                return new Dictionary<string, object> { { "ok", false }, { "error", "ffmpeg-not-found" } };
            // 保持源分辨率（不加 scale），只把帧率压到显示器上限
            var args = "-y -hide_banner -loglevel error -i \"" + src + "\" -vf \"fps=" + fps.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + "\" -c:v libx264 -preset veryfast -crf 24 -c:a aac -b:a 128k -movflags +faststart \"" + tempFile + "\"";
            var info = new ProcessStartInfo(ffmpeg, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                WorkingDirectory = VideoCacheDir(),
            };
            var process = Process.Start(info);
            if (process != null)
            {
                var logPath = outFile + ".log";
                try { File.WriteAllText(logPath, ""); } catch { }
                process.ErrorDataReceived += (sender, ev) =>
                {
                    if (string.IsNullOrEmpty(ev.Data)) return;
                    try { File.AppendAllText(logPath, ev.Data + Environment.NewLine); } catch { }
                };
                process.BeginErrorReadLine();
            }
        }
        catch (Exception error)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", error.Message } };
        }
        return new Dictionary<string, object>
        {
            { "ok", true }, { "state", "running" },
            { "width", width }, { "height", height },
            { "sourceFps", sourceFps }, { "fps", fps },
        };
    }

    // ---------- 与 DSH 共用 media-bridge：代理 DSH 宿主的音频路由 ----------

    private static int _dshPort = -1;
    private static DateTime _dshProbeAt = DateTime.MinValue;

    private static string DshGet(int port, string path, int timeoutMs)
    {
        try
        {
            var request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create("http://127.0.0.1:" + port + "/wallpaper-engine/" + path);
            request.Method = "GET";
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.Proxy = null;
            using (var response = (System.Net.HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd();
        }
        catch { return null; }
    }

    private static int DshPort()
    {
        if (_dshPort > 0 && (DateTime.UtcNow - _dshProbeAt).TotalSeconds < 30 && DshGet(_dshPort, "audio-spectrum", 400) != null)
            return _dshPort;
        _dshPort = 0;
        _dshProbeAt = DateTime.UtcNow;
        // DSH GUI 常用端口优先
        foreach (var guess in new[] { 55904, 8080, 3000 })
            if (DshGet(guess, "audio-spectrum", 300) != null) { _dshPort = guess; return guess; }
        try
        {
            foreach (var listener in System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            {
                if (listener.Port <= 1024 || listener.Port == 43197) continue;
                if (DshGet(listener.Port, "audio-spectrum", 200) != null) { _dshPort = listener.Port; return listener.Port; }
            }
        }
        catch { }
        return 0;
    }

    private static string DshProxy(string route)
    {
        var port = DshPort();
        if (port <= 0) return "{\"ok\":false,\"error\":\"dsh-not-found\"}";
        var body = DshGet(port, route, 800);
        return body ?? "{\"ok\":false,\"error\":\"dsh-timeout\"}";
    }

    private static bool ProbeBridgePort(int port)
    {
        try
        {
            var request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create("http://127.0.0.1:" + port + "/v1/now");
            request.Method = "GET";
            request.Timeout = 250;
            request.ReadWriteTimeout = 250;
            request.Proxy = null;
            using (var response = (System.Net.HttpWebResponse)request.GetResponse())
                return (int)response.StatusCode >= 200 && (int)response.StatusCode < 300;
        }
        catch { return false; }
    }

    private static object ScanBridgePorts()
    {
        var found = new List<int>();
        foreach (var port in new[] { 8765, 8766, 8767, 8768, 8769, 8770, 8771, 8772 })
            if (ProbeBridgePort(port)) found.Add(port);
        return new Dictionary<string, object>
        {
            { "ok", true },
            { "ports", found },
            { "port", found.Count > 0 ? found[0] : 0 },
        };
    }

    private static string ResolveAssetFile(string id, string relative)
    {
        if (string.IsNullOrEmpty(id)) return null;
        var map = LoadWallMap();
        string dir;
        if (!map.TryGetValue(id, out dir)) return null;
        var baseFull = Path.GetFullPath(dir);
        if (relative == null) relative = "";
        relative = relative.TrimStart('/', '\\');
        var full = Path.GetFullPath(Path.Combine(baseFull, relative.Replace('/', '\\')));
        if (!full.StartsWith(baseFull, StringComparison.OrdinalIgnoreCase)) return null;
        if (Directory.Exists(full))
        {
            var index = Path.Combine(full, "index.html");
            if (File.Exists(index)) return index;
            return null;
        }
        return File.Exists(full) ? full : null;
    }

    private static string ResolveWallFile(string id, string relative)
    {
        if (string.IsNullOrEmpty(id)) return null;
        if (relative == null) relative = "";
        foreach (var root in LoadRoots())
        {
            string full;
            try { full = Path.GetFullPath(Path.Combine(root, id, relative.Replace('/', '\\'))); }
            catch { continue; }
            var rootFull = Path.GetFullPath(root).TrimEnd('\\') + "\\";
            if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) continue;
            if (Directory.Exists(full))
            {
                var index = Path.Combine(full, "index.html");
                return File.Exists(index) ? index : null;
            }
            if (File.Exists(full)) return full;
        }
        return null;
    }

    private static bool TryListen(int port, out TcpListener listener)
    {
        listener = null;
        try
        {
            var l = new TcpListener(IPAddress.Loopback, port);
            l.Start();
            listener = l;
            return true;
        }
        catch { return false; }
    }

    private static bool Listening(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var task = client.ConnectAsync(IPAddress.Loopback, port);
                if (!task.Wait(300)) return false;
                return client.Connected;
            }
        }
        catch { return false; }
    }

    private static readonly int[] PortCandidates = { 43197, 43198, 43199, 43200, 43201, 43202, 43203, 43204 };

    // 确保服务在跑：已有端口能连上就直接用，否则另起一个独立进程
    private static int EnsureWebServer()
    {
        int saved;
        if (int.TryParse(ReadText(PortFile()), out saved) && saved > 0 && Listening(saved)) return saved;
        foreach (var port in PortCandidates)
        {
            if (Listening(port)) { File.WriteAllText(PortFile(), port.ToString()); return port; }
        }
        foreach (var port in PortCandidates)
        {
            TcpListener probe;
            if (!TryListen(port, out probe)) continue;
            probe.Stop();
            var exe = Process.GetCurrentProcess().MainModule.FileName;
            var info = new ProcessStartInfo(exe, "--webserver " + port + " \"" + RootsFile() + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            var child = Process.Start(info);
            for (var i = 0; i < 30; i++)
            {
                if (Listening(port))
                {
                    File.WriteAllText(PortFile(), port.ToString());
                    if (child != null) File.WriteAllText(PidFile(), child.Id.ToString());
                    return port;
                }
                System.Threading.Thread.Sleep(100);
            }
        }
        return 0;
    }

    private static string ReadText(string file)
    {
        try { return File.Exists(file) ? File.ReadAllText(file).Trim() : ""; } catch { return ""; }
    }

    private static void StopWebServer()
    {
        int pid;
        if (int.TryParse(ReadText(PidFile()), out pid) && pid > 0)
        {
            try { Process.GetProcessById(pid).Kill(); } catch { }
        }
        try { if (File.Exists(PortFile())) File.Delete(PortFile()); } catch { }
        try { if (File.Exists(PidFile())) File.Delete(PidFile()); } catch { }
    }

    private static void RunWebServer(string portText, string rootsFile)
    {
        int port = 43197;
        int.TryParse(portText, out port);
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        while (true)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); }
            catch { break; }
            System.Threading.ThreadPool.QueueUserWorkItem(HandleWebClient, client);
        }
    }

    private static void HandleWebClient(object state)
    {
        var client = (TcpClient)state;
        try
        {
            using (client)
            using (var stream = client.GetStream())
            {
                client.ReceiveTimeout = 15000;
                client.SendTimeout = 30000;
                var buffer = new byte[32768];
                var length = 0;
                while (length < buffer.Length)
                {
                    var read = stream.Read(buffer, length, buffer.Length - length);
                    if (read <= 0) break;
                    length += read;
                    if (Encoding.ASCII.GetString(buffer, 0, length).IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0) break;
                }
                if (length == 0) return;
                var headerText = Encoding.ASCII.GetString(buffer, 0, length);
                var lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
                var pieces = lines[0].Split(' ');
                if (pieces.Length < 2) return;
                var method = pieces[0];
                if (method != "GET" && method != "HEAD") return;

                var path = pieces[1];
                var q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);
                var parts = path.Trim('/').Split('/');
                if (parts.Length == 1 && parts[0] == "wefonts")
                {
                    var dir = WeFontsDir();
                    var names = new List<string>();
                    if (dir != null)
                    {
                        try
                        {
                            foreach (var f in Directory.GetFiles(dir, "*.*", SearchOption.TopDirectoryOnly))
                            {
                                var fExt = Path.GetExtension(f).ToLowerInvariant();
                                if (fExt == ".ttf" || fExt == ".otf" || fExt == ".woff" || fExt == ".woff2") names.Add(Path.GetFileName(f));
                            }
                        }
                        catch { }
                    }
                    WriteWeb(stream, 200, "OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(names)), method == "HEAD", null);
                    return;
                }
                if (parts.Length >= 2 && parts[0] == "wefonts")
                {
                    var fontsDir = WeFontsDir();
                    var rel = Uri.UnescapeDataString(string.Join("/", parts, 1, parts.Length - 1));
                    var fontFile = fontsDir == null ? null : Path.GetFullPath(Path.Combine(fontsDir, rel.Replace('/', '\\')));
                    if (fontFile == null || !fontFile.StartsWith(Path.GetFullPath(fontsDir), StringComparison.OrdinalIgnoreCase) || !File.Exists(fontFile))
                    {
                        WriteWeb(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"), false, null);
                        return;
                    }
                    var fext = Path.GetExtension(fontFile);
                    string ftype;
                    if (!ContentTypes.TryGetValue(fext, out ftype)) ftype = "application/octet-stream";
                    var fbody = File.ReadAllBytes(fontFile);
                    WriteWeb(stream, 200, "OK", ftype, fbody, method == "HEAD", null);
                    return;
                }
                if (parts.Length >= 2 && parts[0] == "dsh" && (parts[1] == "spectrum" || parts[1] == "now-playing"))
                {
                    var body = DshProxy(parts[1] == "spectrum" ? "audio-spectrum" : "now-playing");
                    WriteWeb(stream, 200, "OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(body), method == "HEAD", null);
                    return;
                }
                if (parts.Length >= 2 && parts[0] == "thumb")
                {
                    var thumb = ThumbFile(Uri.UnescapeDataString(parts[1]));
                    if (thumb == null)
                    {
                        WriteWeb(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"), false, null);
                        return;
                    }
                    var text = Path.GetExtension(thumb);
                    string ttype;
                    if (!ContentTypes.TryGetValue(text, out ttype)) ttype = "application/octet-stream";
                    WriteWeb(stream, 200, "OK", ttype, File.ReadAllBytes(thumb), method == "HEAD", null);
                    return;
                }
                if (parts.Length >= 2 && parts[0] == "vcache")
                {
                    var name = Uri.UnescapeDataString(parts[1]);
                    if (name.IndexOfAny(new[] { '/', '\\' }) >= 0) name = Path.GetFileName(name);
                    var vfile = Path.Combine(VideoCacheDir(), name);
                    if (!File.Exists(vfile))
                    {
                        WriteWeb(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"), false, null);
                        return;
                    }
                    WriteWeb(stream, 200, "OK", "video/mp4", File.ReadAllBytes(vfile), method == "HEAD", null);
                    return;
                }
                if (parts.Length >= 2 && parts[0] == "asset")
                {
                    var assetId = Uri.UnescapeDataString(parts[1]);
                    var assetRel = parts.Length > 2 ? Uri.UnescapeDataString(string.Join("/", parts, 2, parts.Length - 2)) : "";
                    var assetFile = ResolveAssetFile(assetId, assetRel);
                    if (assetFile == null)
                    {
                        WriteWeb(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"), false, null);
                        return;
                    }
                    var aext = Path.GetExtension(assetFile);
                    string atype;
                    if (!ContentTypes.TryGetValue(aext, out atype)) atype = "application/octet-stream";
                    if (aext.Equals(".html", StringComparison.OrdinalIgnoreCase) || aext.Equals(".htm", StringComparison.OrdinalIgnoreCase))
                    {
                        var ahtml = InjectShim(File.ReadAllText(assetFile, Encoding.UTF8), assetId, "/asset/");
                        WriteWeb(stream, 200, "OK", atype, Encoding.UTF8.GetBytes(ahtml), method == "HEAD", null);
                        return;
                    }
                    var abody = File.ReadAllBytes(assetFile);
                    WriteWeb(stream, 200, "OK", atype, abody, method == "HEAD", null);
                    return;
                }
                if (parts.Length < 2 || parts[0] != "wall")
                {
                    WriteWeb(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"), false, null);
                    return;
                }
                var id = Uri.UnescapeDataString(parts[1]);
                var relative = parts.Length > 2 ? Uri.UnescapeDataString(string.Join("/", parts, 2, parts.Length - 2)) : "";
                var file = ResolveWallFile(id, relative);
                if (file == null && relative.Length > 0 && !Path.HasExtension(relative))
                {
                    file = ResolveWallFile(id, "index.html"); // 前端路由回退
                }
                if (file == null)
                {
                    WriteWeb(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"), false, null);
                    return;
                }

                var ext = Path.GetExtension(file);
                string type;
                if (!ContentTypes.TryGetValue(ext, out type)) type = "application/octet-stream";

                if (ext.Equals(".html", StringComparison.OrdinalIgnoreCase) || ext.Equals(".htm", StringComparison.OrdinalIgnoreCase))
                {
                    var html = InjectShim(File.ReadAllText(file, Encoding.UTF8), id, "/wall/");
                    var body = Encoding.UTF8.GetBytes(html);
                    WriteWeb(stream, 200, "OK", type, body, method == "HEAD", null);
                    return;
                }

                var info = new FileInfo(file);
                long start = 0, end = info.Length - 1;
                var rangeHeader = "";
                foreach (var line in lines)
                {
                    if (line.StartsWith("Range:", StringComparison.OrdinalIgnoreCase)) { rangeHeader = line.Substring(6).Trim(); break; }
                }
                var partial = false;
                if (rangeHeader.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
                {
                    var spec = rangeHeader.Substring(6).Split(',')[0].Trim();
                    var dash = spec.IndexOf('-');
                    if (dash >= 0)
                    {
                        long.TryParse(spec.Substring(0, dash), out start);
                        var tail = spec.Substring(dash + 1);
                        if (tail.Length > 0 && long.TryParse(tail, out end)) { }
                        if (end >= info.Length) end = info.Length - 1;
                        if (start <= end) partial = true;
                    }
                }
                var count = end - start + 1;
                var head = new StringBuilder();
                head.Append("HTTP/1.1 ").Append(partial ? 206 : 200).Append(partial ? " Partial Content" : " OK").Append("\r\n");
                head.Append("Content-Type: ").Append(type).Append("\r\n");
                head.Append("Content-Length: ").Append(count).Append("\r\n");
                if (partial) head.Append("Content-Range: bytes ").Append(start).Append('-').Append(end).Append('/').Append(info.Length).Append("\r\n");
                // 静态资源允许缓存，HTML 仍不缓存（避免注入的 shim/页面被旧缓存顶掉）
                var cache = ext.Equals(".html", StringComparison.OrdinalIgnoreCase) || ext.Equals(".htm", StringComparison.OrdinalIgnoreCase)
                    ? "no-store"
                    : "public, max-age=31536000, immutable";
                head.Append("Accept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: ").Append(cache).Append("\r\nConnection: close\r\n\r\n");
                var headBytes = Encoding.ASCII.GetBytes(head.ToString());
                stream.Write(headBytes, 0, headBytes.Length);
                if (method != "HEAD")
                {
                    using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    {
                        fs.Seek(start, SeekOrigin.Begin);
                        var chunk = new byte[128 * 1024];
                        var left = count;
                        while (left > 0)
                        {
                            var want = (int)Math.Min(chunk.Length, left);
                            var got = fs.Read(chunk, 0, want);
                            if (got <= 0) break;
                            stream.Write(chunk, 0, got);
                            left -= got;
                        }
                    }
                }
                stream.Flush();
            }
        }
        catch { }
    }

    private static string InjectShim(string html, string id, string prefix)
    {
        var snippet = "<base href=\"" + prefix + Uri.EscapeDataString(id) + "/\"><script>" + WebShim + "</script>";
        var idx = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        return idx >= 0 ? html.Substring(0, idx) + snippet + html.Substring(idx) : snippet + html;
    }

    private static void WriteWeb(NetworkStream stream, int code, string reason, string type, byte[] body, bool headOnly, string extra)
    {
        var head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(code).Append(' ').Append(reason).Append("\r\n");
        head.Append("Content-Type: ").Append(type).Append("\r\n");
        head.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        head.Append("Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
        var bytes = Encoding.ASCII.GetBytes(head.ToString());
        stream.Write(bytes, 0, bytes.Length);
        if (!headOnly && body.Length > 0) stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    private static readonly Stream StdIn = Console.OpenStandardInput();

    private static string ReadMessage()
    {
        var stdin = StdIn;
        var header = new byte[4];
        if (ReadFull(stdin, header, 4) != 4) return null;
        var length = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
        if (length <= 0 || length > 64 * 1024 * 1024) return null;
        var body = new byte[length];
        if (ReadFull(stdin, body, length) != length) return null;
        return Encoding.UTF8.GetString(body);
    }

    private static int ReadFull(Stream stream, byte[] buffer, int count)
    {
        var offset = 0;
        while (offset < count)
        {
            var read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) return offset;
            offset += read;
        }
        return offset;
    }

    private static void WriteMessage(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        var stdout = Console.OpenStandardOutput();
        stdout.Write(BitConverter.GetBytes(bytes.Length), 0, 4);
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
    }

    private static void Main(string[] args)
    {
        if (args.Length >= 3 && args[0] == "--webserver")
        {
            RunWebServer(args[1], args[2]);
            return;
        }

        var serializer = new JavaScriptSerializer();
        string message;
        while ((message = ReadMessage()) != null)
        {
            Dictionary<string, object> request;
            try { request = serializer.Deserialize<Dictionary<string, object>>(message); }
            catch { WriteMessage("{\"ok\":false,\"error\":\"bad json\"}"); continue; }

            var cmd = request.ContainsKey("cmd") ? Convert.ToString(request["cmd"]) : "";
            var browsers = FindBrowsers();

            if (cmd == "status")
            {
                var list = new List<Dictionary<string, object>>();
                foreach (var browser in browsers)
                {
                    var item = new Dictionary<string, object>
                    {
                        { "path", browser },
                        { "pref", ReadPreference(browser) },
                    };
                    list.Add(item);
                }
                var payload = new Dictionary<string, object>
                {
                    { "ok", true },
                    { "host", HostName },
                    { "browsers", list },
                };
                WriteMessage(serializer.Serialize(payload));
                continue;
            }

            if (cmd == "set")
            {
                var pref = request.ContainsKey("pref") ? Convert.ToInt32(request["pref"]) : 2;
                var changed = new List<string>();
                foreach (var browser in browsers)
                {
                    try
                    {
                        WritePreference(browser, pref);
                        changed.Add(browser);
                    }
                    catch
                    {
                        // 单个浏览器失败不影响其它
                    }
                }
                var payload = new Dictionary<string, object>
                {
                    { "ok", true },
                    { "pref", pref },
                    { "changed", changed },
                    { "restart", changed.Count > 0 },
                };
                WriteMessage(serializer.Serialize(payload));
                continue;
            }


            if (cmd == "bridge-status")
            {
                var bridgePath = FindBridge(request.ContainsKey("path") ? Convert.ToString(request["path"]) : "");
                var own = OwnBridgeProcess();
                var processes = BridgeProcessList();
                var info = new Dictionary<string, object>
                {
                    { "ok", true },
                    { "running", own != null },
                    { "pid", own == null ? 0 : own.Id },
                    { "path", bridgePath ?? "" },
                    { "processes", processes },
                    { "others", processes.Count - (own == null ? 0 : 1) },
                };
                WriteMessage(serializer.Serialize(info));
                continue;
            }

            if (cmd == "video-prepare")
            {
                var vid = request.ContainsKey("id") ? Convert.ToString(request["id"]) : "";
                var vpath = request.ContainsKey("path") ? Convert.ToString(request["path"]) : "";
                var vfps = request.ContainsKey("fps") ? Convert.ToDouble(request["fps"]) : 0;
                WriteMessage(serializer.Serialize(VideoPrepare(vid, vpath, vfps)));
                continue;
            }

            if (cmd == "add-root")
            {
                var path = request.ContainsKey("path") ? Convert.ToString(request["path"]) : "";
                if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
                {
                    WriteMessage("{\"ok\":false,\"error\":\"目录不存在\"}");
                    continue;
                }
                var roots = new List<string>();
                try
                {
                    if (File.Exists(RootsFile()))
                    {
                        var loaded = serializer.Deserialize<List<string>>(File.ReadAllText(RootsFile(), Encoding.UTF8));
                        if (loaded != null) roots.AddRange(loaded);
                    }
                }
                catch { }
                var full = Path.GetFullPath(path);
                if (!roots.Contains(full)) roots.Add(full);
                File.WriteAllText(RootsFile(), serializer.Serialize(roots), new UTF8Encoding(false));
                _rootsCache = null;
                WriteMessage(serializer.Serialize(new Dictionary<string, object> { { "ok", true }, { "roots", roots.Count }, { "path", full } }));
                continue;
            }

            if (cmd == "wall-scan")
            {
                WriteMessage(serializer.Serialize(ScanWalls()));
                continue;
            }

            if (cmd == "window-coverage")
            {
                var x = request.ContainsKey("x") ? Convert.ToDouble(request["x"]) : 0;
                var y = request.ContainsKey("y") ? Convert.ToDouble(request["y"]) : 0;
                var w = request.ContainsKey("w") ? Convert.ToDouble(request["w"]) : 0;
                var h = request.ContainsKey("h") ? Convert.ToDouble(request["h"]) : 0;
                var dpr = request.ContainsKey("dpr") ? Convert.ToDouble(request["dpr"]) : 1;
                WriteMessage(serializer.Serialize(WindowCoverage(x, y, w, h, dpr)));
                continue;
            }

            if (cmd == "bridge-port-scan")
            {
                WriteMessage(serializer.Serialize(ScanBridgePorts()));
                continue;
            }

            if (cmd == "bridge-scan")
            {
                var processes = BridgeProcessList();
                WriteMessage(serializer.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "processes", processes },
                    { "own", BridgeRunning() },
                }));
                continue;
            }

            if (cmd == "bridge-start")
            {
                var port = request.ContainsKey("port") ? Convert.ToInt32(request["port"]) : 8765;
                var bridgePath = FindBridge(request.ContainsKey("path") ? Convert.ToString(request["path"]) : "");
                if (bridgePath == null)
                {
                    WriteMessage("{\"ok\":false,\"error\":\"找不到 media-bridge-win32-x64.exe（默认找 Downloads 目录）\"}");
                    continue;
                }
                if (BridgeRunning())
                {
                    WriteMessage("{\"ok\":true,\"already\":true}");
                    continue;
                }
                try
                {
                    var pid = StartBridgeProcess(bridgePath, port);
                    WriteMessage(serializer.Serialize(new Dictionary<string, object> { { "ok", true }, { "pid", pid } }));
                }
                catch (Exception error)
                {
                    WriteMessage(serializer.Serialize(new Dictionary<string, object> { { "ok", false }, { "error", error.Message } }));
                }
                continue;
            }

            if (cmd == "bridge-stop")
            {
                var killed = 0;
                var own = OwnBridgeProcess();
                if (own != null)
                {
                    try { own.Kill(); killed++; } catch { }
                }
                try { if (File.Exists(BridgePidFile())) File.Delete(BridgePidFile()); } catch { }
                WriteMessage(serializer.Serialize(new Dictionary<string, object> { { "ok", true }, { "killed", killed } }));
                continue;
            }

            if (cmd == "web-serve")
            {
                var roots = new List<string>();
                var rawRoots = request.ContainsKey("roots") ? request["roots"] as System.Collections.ArrayList : null;
                if (rawRoots != null) foreach (var item in rawRoots) { var text = Convert.ToString(item); if (!string.IsNullOrWhiteSpace(text) && Directory.Exists(text)) roots.Add(text); }
                File.WriteAllText(RootsFile(), serializer.Serialize(roots), new UTF8Encoding(false));
                _rootsCache = null;
                var bound = EnsureWebServer();
                WriteMessage(serializer.Serialize(new Dictionary<string, object>
                {
                    { "ok", bound > 0 }, { "port", bound }, { "roots", LoadRoots() },
                }));
                continue;
            }

            if (cmd == "web-stop")
            {
                StopWebServer();
                WriteMessage("{\"ok\":true}");
                continue;
            }

            if (cmd == "autostart-clean")
            {
                var removed = false;
                try { var file = AutostartFile(); if (File.Exists(file)) { File.Delete(file); removed = true; } } catch { }
                WriteMessage(serializer.Serialize(new Dictionary<string, object> { { "ok", true }, { "removed", removed } }));
                continue;
            }

            WriteMessage("{\"ok\":false,\"error\":\"unknown command\"}");
        }
    }
}
