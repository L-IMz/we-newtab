using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Diagnostics;
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

    private static readonly string[] BridgeCandidates =
    {
        @"%USERPROFILE%\Downloads\media-bridge-win32-x64.exe",
        @"%USERPROFILE%\Desktop\media-bridge-win32-x64.exe",
        @"%LOCALAPPDATA%\media-bridge\media-bridge-win32-x64.exe",
        @"%ProgramFiles%\media-bridge\media-bridge-win32-x64.exe",
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

    private static void WriteAutostart(bool enabled, string path, int port)
    {
        var file = AutostartFile();
        if (!enabled)
        {
            if (File.Exists(file)) File.Delete(file);
            return;
        }
        var script = "CreateObject(\"WScript.Shell\").Run \"\"\"" + path + "\"\" serve --http 127.0.0.1:" + port + "\", 0, False";
        File.WriteAllText(file, script, new UTF8Encoding(false));
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

    private static void Main()
    {
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
                    { "autostart", File.Exists(AutostartFile()) },
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

            if (cmd == "bridge-autostart")
            {
                var enabled = request.ContainsKey("enabled") && Convert.ToBoolean(request["enabled"]);
                var port = request.ContainsKey("port") ? Convert.ToInt32(request["port"]) : 8765;
                var bridgePath = FindBridge(request.ContainsKey("path") ? Convert.ToString(request["path"]) : "");
                if (bridgePath == null)
                {
                    WriteMessage("{\"ok\":false,\"error\":\"找不到 media-bridge-win32-x64.exe\"}");
                    continue;
                }
                try
                {
                    WriteAutostart(enabled, bridgePath, port);
                    WriteMessage(serializer.Serialize(new Dictionary<string, object> { { "ok", true }, { "autostart", enabled } }));
                }
                catch (Exception error)
                {
                    WriteMessage(serializer.Serialize(new Dictionary<string, object> { { "ok", false }, { "error", error.Message } }));
                }
                continue;
            }

            WriteMessage("{\"ok\":false,\"error\":\"unknown command\"}");
        }
    }
}
