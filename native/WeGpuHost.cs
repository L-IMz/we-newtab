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

    private static bool BridgeRunning()
    {
        return Process.GetProcessesByName("media-bridge-win32-x64").Length > 0;
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
        return process == null ? 0 : process.Id;
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
        "var __weAudioBuf=new Float32Array(128);" +
        "addEventListener('message',function(e){var d=e.data;if(!d)return;" +
        "if(d.__weProps){pending=d.__weProps;if(!tryApply())queueApply();}" +
        "if(d.__weAudio&&window.__weAudio){try{var L=d.__weAudio.left||[],R=d.__weAudio.right||[];for(var i=0;i<64;i++){__weAudioBuf[i]=Math.min(1,L[i]||0);__weAudioBuf[64+i]=Math.min(1,R[i]||0)}window.__weAudio(__weAudioBuf);if(!window.__weAudioReported){window.__weAudioReported=1;report('audio',{len:__weAudioBuf.length})}}catch(_){}}" +
        "if(d.__weFit){fit(typeof d.__weFit==='object'?d.__weFit.mode:null);}" +
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
                    var html = InjectShim(File.ReadAllText(file, Encoding.UTF8), id);
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

    private static string InjectShim(string html, string id)
    {
        var snippet = "<base href=\"/wall/" + Uri.EscapeDataString(id) + "/\"><script>" + WebShim + "</script>";
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

    private static string ReadMessage()
    {
        var stdin = Console.OpenStandardInput();
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
                var info = new Dictionary<string, object>
                {
                    { "ok", true },
                    { "running", BridgeRunning() },
                    { "path", bridgePath ?? "" },
                };
                WriteMessage(serializer.Serialize(info));
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
                foreach (var process in Process.GetProcessesByName("media-bridge-win32-x64"))
                {
                    try { process.Kill(); killed++; } catch { }
                }
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
