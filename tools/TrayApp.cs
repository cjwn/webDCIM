using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace OutputWebViewerTray
{
    static class NativeMethods
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
    }

    sealed class TrayContext : ApplicationContext
    {
        private readonly string rootDir;
        private readonly string cacheDir;
        private readonly string logFile;
        private readonly string pidFile;
        private readonly string portFile;
        private readonly string startupLnk;
        private readonly string nodeExe;
        private readonly int port;
        private readonly string localUrl;
        private readonly object logLock = new object();

        private readonly NotifyIcon tray;
        private readonly Icon iconRunning;
        private readonly Icon iconStopped;
        private readonly ToolStripMenuItem miStatus;
        private readonly ToolStripMenuItem miStartup;
        private readonly System.Windows.Forms.Timer statusTimer;

        private Process serverProc;
        private StreamWriter logWriter;
        private volatile bool exiting;

        public TrayContext(string rootDir, string nodeExe, int port, bool openBrowser)
        {
            this.rootDir = rootDir;
            this.nodeExe = nodeExe;
            this.port = port;
            this.localUrl = "http://localhost:" + port;
            this.cacheDir = Path.Combine(rootDir, "cache");
            this.logFile = Path.Combine(cacheDir, "server.log");
            this.pidFile = Path.Combine(cacheDir, "server.pid");
            this.portFile = Path.Combine(cacheDir, "port.txt");
            this.startupLnk = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Startup),
                "OUTPUTWebViewer.lnk"
            );

            Directory.CreateDirectory(cacheDir);

            iconRunning = CreateLensIcon(Color.FromArgb(255, 77, 159, 255));
            iconStopped = CreateLensIcon(Color.FromArgb(255, 245, 158, 11));

            tray = new NotifyIcon
            {
                Icon = iconStopped,
                Text = "照片库总览 - 启动中…",
                Visible = true
            };

            var menu = new ContextMenuStrip();

            miStatus = new ToolStripMenuItem("○ 正在启动…") { Enabled = false };

            var miOpen = new ToolStripMenuItem("打开照片库 (" + localUrl + ")");
            miOpen.Font = new Font(miOpen.Font, FontStyle.Bold);
            miOpen.Click += delegate { OpenUrl(localUrl); };

            var miCopyLan = new ToolStripMenuItem("复制局域网访问地址");
            miCopyLan.Click += delegate
            {
                string u = GetLanUrl();
                try { Clipboard.SetText(u); } catch { }
                ShowBalloon("已复制局域网地址", u, ToolTipIcon.Info);
            };

            var miRestart = new ToolStripMenuItem("重启服务");
            miRestart.Click += delegate
            {
                tray.Icon = iconStopped;
                tray.Text = "照片库总览 - 正在重启…";
                if (StartServer(true))
                {
                    ShowBalloon("照片库服务已重启", "最新代码已生效 (" + localUrl + ")", ToolTipIcon.Info);
                }
            };

            var miLog = new ToolStripMenuItem("查看运行日志");
            miLog.Click += delegate
            {
                if (File.Exists(logFile))
                {
                    try { Process.Start("notepad.exe", "\"" + logFile + "\""); } catch { }
                }
            };

            var miDir = new ToolStripMenuItem("打开程序目录");
            miDir.Click += delegate
            {
                try { Process.Start("explorer.exe", "\"" + rootDir + "\""); } catch { }
            };

            miStartup = new ToolStripMenuItem("开机自动启动（静默托盘）")
            {
                CheckOnClick = true,
                Checked = File.Exists(startupLnk)
            };
            miStartup.Click += delegate
            {
                try
                {
                    SetAutoStart(miStartup.Checked);
                    if (miStartup.Checked)
                        ShowBalloon("已开启开机自启", "下次开机将静默常驻右下角托盘", ToolTipIcon.Info);
                    else
                        ShowBalloon("已关闭开机自启", "已从 Windows 启动项移除", ToolTipIcon.Info);
                }
                catch (Exception ex)
                {
                    miStartup.Checked = File.Exists(startupLnk);
                    ShowBalloon("设置开机自启失败", ex.Message, ToolTipIcon.Warning);
                }
            };

            var miExit = new ToolStripMenuItem("退出服务");
            miExit.Click += delegate { ExitApp(); };

            menu.Items.Add(miStatus);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miOpen);
            menu.Items.Add(miCopyLan);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miRestart);
            menu.Items.Add(miLog);
            menu.Items.Add(miDir);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miStartup);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miExit);

            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenUrl(localUrl); };

            statusTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            statusTimer.Tick += delegate
            {
                if (!exiting) UpdateStatus();
            };
            statusTimer.Start();

            bool ok = StartServer(!openBrowser);
            if (ok && openBrowser) OpenUrl(localUrl);
        }

        private static Icon CreateLensIcon(Color ringColor)
        {
            using (var bmp = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);

                using (var bg = new SolidBrush(Color.FromArgb(255, 22, 27, 36)))
                    g.FillEllipse(bg, 1, 1, 30, 30);

                using (var ring = new Pen(ringColor, 3.2f))
                    g.DrawEllipse(ring, 4, 4, 24, 24);

                using (var inner = new SolidBrush(Color.FromArgb(255, 36, 48, 68)))
                    g.FillEllipse(inner, 9, 9, 14, 14);

                using (var glint = new SolidBrush(Color.FromArgb(230, 220, 240, 255)))
                    g.FillEllipse(glint, 12, 11, 5, 5);

                IntPtr hIcon = bmp.GetHicon();
                try
                {
                    using (var tmp = Icon.FromHandle(hIcon))
                    {
                        return (Icon)tmp.Clone();
                    }
                }
                finally
                {
                    NativeMethods.DestroyIcon(hIcon);
                }
            }
        }

        private static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        private void ShowBalloon(string title, string text, ToolTipIcon icon)
        {
            try
            {
                tray.BalloonTipTitle = title;
                tray.BalloonTipText = text;
                tray.BalloonTipIcon = icon;
                tray.ShowBalloonTip(2500);
            }
            catch { }
        }

        private void WriteLog(string line)
        {
            if (line == null) return;
            lock (logLock)
            {
                try
                {
                    if (logWriter != null)
                    {
                        logWriter.WriteLine(line);
                        logWriter.Flush();
                    }
                }
                catch { }
            }
        }

        private void CloseLog()
        {
            lock (logLock)
            {
                if (logWriter != null)
                {
                    try { logWriter.Dispose(); } catch { }
                    logWriter = null;
                }
            }
        }

        private static void TaskKillTree(int pid)
        {
            if (pid <= 0) return;
            try
            {
                var psi = new ProcessStartInfo("taskkill.exe", "/F /T /PID " + pid)
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (var p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(3000);
                }
            }
            catch { }
        }

        private static void KillPortListeners(int targetPort)
        {
            try
            {
                var psi = new ProcessStartInfo("netstat.exe", "-ano")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (var p = Process.Start(psi))
                {
                    if (p == null) return;
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);

                    var regex = new Regex(@":" + targetPort + @"\s+\S+\s+LISTENING\s+(\d+)\s*$", RegexOptions.Multiline);
                    var killed = new HashSet<int>();
                    foreach (Match m in regex.Matches(output))
                    {
                        int pid;
                        if (int.TryParse(m.Groups[1].Value, out pid) && pid > 0 && killed.Add(pid))
                        {
                            TaskKillTree(pid);
                        }
                    }
                }
            }
            catch { }
        }

        private void StopServer()
        {
            if (serverProc != null)
            {
                try
                {
                    if (!serverProc.HasExited) TaskKillTree(serverProc.Id);
                }
                catch { }
                try { serverProc.Dispose(); } catch { }
                serverProc = null;
            }
            CloseLog();

            if (File.Exists(pidFile))
            {
                try
                {
                    int oldPid;
                    if (int.TryParse(File.ReadAllText(pidFile).Trim(), out oldPid) && oldPid > 0)
                    {
                        TaskKillTree(oldPid);
                    }
                }
                catch { }
                try { File.Delete(pidFile); } catch { }
            }
            KillPortListeners(port);
        }

        private bool IsServerReady()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/state");
                req.Timeout = 1500;
                req.Method = "GET";
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private string GetLanUrl()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/state");
                req.Timeout = 1500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string json = sr.ReadToEnd();
                    Match m = Regex.Match(json, "\"urls\"\\s*:\\s*\\[\\s*\"([^\"]+)\"");
                    if (m.Success) return m.Groups[1].Value;
                }
            }
            catch { }

            try
            {
                var skip = new Regex(@"vmware|virtualbox|vethernet|loopback|wsl|tap|tun|zerotier|hamachi", RegexOptions.IgnoreCase);
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up || skip.IsMatch(ni.Name)) continue;
                    foreach (UnicastIPAddressInformation ua in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        string ip = ua.Address.ToString();
                        if (ip.StartsWith("127.") || ip.StartsWith("169.254.")) continue;
                        return "http://" + ip + ":" + port;
                    }
                }
            }
            catch { }
            return localUrl;
        }

        private void UpdateStatus()
        {
            bool running = false;
            int pid = 0;
            try
            {
                if (serverProc != null && !serverProc.HasExited)
                {
                    running = true;
                    pid = serverProc.Id;
                }
            }
            catch { }

            if (running)
            {
                tray.Icon = iconRunning;
                tray.Text = "照片库总览 - 运行中 (:" + port + ")";
                miStatus.Text = "● 运行中 (PID " + pid + " · :" + port + ")";
            }
            else
            {
                tray.Icon = iconStopped;
                tray.Text = "照片库总览 - 已停止";
                miStatus.Text = "○ 服务未运行";
            }
        }

        private bool StartServer(bool silent)
        {
            StopServer();

            try
            {
                lock (logLock)
                {
                    // 日志超过 2 MB 时自动保留最近 512 KB，避免无限膨胀同时保留历史删除记录
                    if (File.Exists(logFile) && new FileInfo(logFile).Length > 2 * 1024 * 1024)
                    {
                        byte[] all = File.ReadAllBytes(logFile);
                        int keep = Math.Min(all.Length, 512 * 1024);
                        int startIdx = all.Length - keep;
                        while (startIdx < all.Length && all[startIdx] != (byte)'\n') startIdx++;
                        if (startIdx < all.Length) startIdx++;
                        using (var fs = new FileStream(logFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
                        {
                            byte[] bom = new byte[] { 0xEF, 0xBB, 0xBF };
                            fs.Write(bom, 0, bom.Length);
                            fs.Write(all, startIdx, all.Length - startIdx);
                        }
                    }
                    bool needBom = !File.Exists(logFile) || new FileInfo(logFile).Length == 0;
                    logWriter = new StreamWriter(
                        new FileStream(logFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                        new UTF8Encoding(needBom)
                    );
                    logWriter.WriteLine();
                    logWriter.WriteLine("======== 启动服务 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ========");
                    logWriter.Flush();
                }
            }
            catch { }

            var psi = new ProcessStartInfo(nodeExe, "server.js")
            {
                WorkingDirectory = rootDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            psi.EnvironmentVariables["PORT"] = port.ToString();

            serverProc = new Process { StartInfo = psi };
            serverProc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
            serverProc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
            serverProc.Start();
            serverProc.BeginOutputReadLine();
            serverProc.BeginErrorReadLine();

            bool ok = false;
            for (int i = 0; i < 25; i++)
            {
                Thread.Sleep(200);
                if (serverProc.HasExited) break;
                if (IsServerReady()) { ok = true; break; }
            }

            UpdateStatus();
            if (ok)
            {
                if (!silent)
                    ShowBalloon("照片库总览已启动", "访问 " + localUrl + " · 双击托盘图标打开网页", ToolTipIcon.Info);
                return true;
            }
            ShowBalloon("照片库启动失败", "请右键「查看运行日志」排查错误", ToolTipIcon.Warning);
            return false;
        }

        private void SetAutoStart(bool enable)
        {
            if (enable)
            {
                Type wshType = Type.GetTypeFromProgID("WScript.Shell");
                object wsh = Activator.CreateInstance(wshType);
                try
                {
                    object sc = wshType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, wsh, new object[] { startupLnk });
                    Type scType = sc.GetType();
                    scType.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { Application.ExecutablePath });
                    scType.InvokeMember("Arguments", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { "--silent" });
                    scType.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { rootDir });
                    scType.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { "OUTPUTWebViewer 照片库总览托盘服务" });
                    scType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, sc, null);
                }
                finally
                {
                    Marshal.FinalReleaseComObject(wsh);
                }
            }
            else if (File.Exists(startupLnk))
            {
                File.Delete(startupLnk);
            }
        }

        private void ExitApp()
        {
            exiting = true;
            statusTimer.Stop();
            StopServer();
            tray.Visible = false;
            tray.Dispose();
            iconRunning.Dispose();
            iconStopped.Dispose();
            ExitThread();
        }
    }

    static class Program
    {
        private static string FindRootDir()
        {
            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            for (int i = 0; i < 3 && !string.IsNullOrEmpty(dir); i++)
            {
                if (File.Exists(Path.Combine(dir, "server.js"))) return dir;
                dir = Path.GetDirectoryName(dir);
            }
            return Path.GetDirectoryName(Application.ExecutablePath);
        }

        private static string FindNodeExe()
        {
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string p in pathEnv.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(p)) continue;
                try
                {
                    string cand = Path.Combine(p.Trim(), "node.exe");
                    if (File.Exists(cand)) return cand;
                }
                catch { }
            }
            string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            return File.Exists(pf) ? pf : null;
        }

        private static int DetectPort(string rootDir)
        {
            int port;
            string envPort = Environment.GetEnvironmentVariable("PORT");
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out port) && port > 0) return port;
            string portFile = Path.Combine(rootDir, "cache", "port.txt");
            if (File.Exists(portFile))
            {
                try
                {
                    if (int.TryParse(File.ReadAllText(portFile).Trim(), out port) && port > 0) return port;
                }
                catch { }
            }
            return 7788;
        }

        [STAThread]
        static void Main(string[] args)
        {
            try { NativeMethods.SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool silent = false;
            foreach (string a in args)
            {
                if (string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "-silent", StringComparison.OrdinalIgnoreCase))
                {
                    silent = true;
                }
            }

            string rootDir = FindRootDir();
            int port = DetectPort(rootDir);

            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\OUTPUTWebViewer_Tray_Mutex", out createdNew))
            {
                if (!createdNew)
                {
                    if (!silent)
                    {
                        try { Process.Start(new ProcessStartInfo("http://localhost:" + port) { UseShellExecute = true }); } catch { }
                    }
                    return;
                }

                string nodeExe = FindNodeExe();
                if (string.IsNullOrEmpty(nodeExe))
                {
                    MessageBox.Show(
                        "未找到 Node.js，请先从 https://nodejs.org/ 安装后再启动。",
                        "照片库总览",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }

                Application.Run(new TrayContext(rootDir, nodeExe, port, !silent));
            }
        }
    }
}
