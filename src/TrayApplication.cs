using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace QwenTrayGateway
{
    public sealed class TrayApplication : ApplicationContext
    {
        private readonly GatewayConfig config;
        private readonly string configPath;
        private readonly BackendController backend;
        private readonly TcpGateway gateway;
        private readonly GatewayLogger logger;
        private readonly NotifyIcon notifyIcon;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem autoUnloadItem;
        private readonly ToolStripMenuItem startupItem;
        private readonly System.Windows.Forms.Timer statusTimer;
        private readonly Control marshalControl;
        private bool exiting;

        public TrayApplication(string configPath, bool showTray)
        {
            this.configPath = Path.GetFullPath(configPath);
            config = GatewayConfig.LoadOrCreate(this.configPath);
            logger = new GatewayLogger(config.LogDirectory);
            backend = new BackendController(config, logger);
            gateway = new TcpGateway(config, backend, logger);
            gateway.ExitRequested += RequestExitFromWorker;

            marshalControl = new Control();
            marshalControl.CreateControl();

            ContextMenuStrip menu = new ContextMenuStrip();
            statusItem = new ToolStripMenuItem("状态：模型未加载");
            statusItem.Enabled = false;
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("立即加载模型", null, delegate { RunWorker(LoadBackend); });
            menu.Items.Add("立即卸载模型", null, delegate { RunWorker(UnloadBackend); });
            autoUnloadItem = new ToolStripMenuItem("自动卸载：10 分钟");
            autoUnloadItem.Checked = config.AutoUnload;
            autoUnloadItem.CheckOnClick = true;
            autoUnloadItem.Click += ToggleAutoUnload;
            menu.Items.Add(autoUnloadItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开日志目录", null, OpenLogs);
            startupItem = new ToolStripMenuItem("开机自动启动");
            startupItem.CheckOnClick = true;
            startupItem.Checked = File.Exists(StartupShortcutPath());
            startupItem.Click += ToggleStartup;
            menu.Items.Add(startupItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("完全退出", null, delegate { ExitAll(); });

            notifyIcon = new NotifyIcon();
            notifyIcon.Icon = SystemIcons.Application;
            notifyIcon.Text = "Qwen 网页朗读：模型未加载";
            notifyIcon.ContextMenuStrip = menu;
            notifyIcon.Visible = showTray;

            statusTimer = new System.Windows.Forms.Timer();
            statusTimer.Interval = 1000;
            statusTimer.Tick += delegate { UpdateStatus(); };
            statusTimer.Start();

            try
            {
                gateway.Start();
                logger.Write("tray_gateway_started");
            }
            catch (Exception ex)
            {
                logger.Write("gateway_start_failed type=" + ex.GetType().Name + " message=" + ex.Message);
                if (showTray)
                {
                    notifyIcon.ShowBalloonTip(8000, "Qwen 网页朗读启动失败", ex.Message, ToolTipIcon.Error);
                }
                throw;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                statusTimer.Dispose();
                notifyIcon.Visible = false;
                notifyIcon.Dispose();
                gateway.Dispose();
                backend.Dispose();
                marshalControl.Dispose();
            }
            base.Dispose(disposing);
        }

        private void UpdateStatus()
        {
            string state = backend.State;
            string text;
            if (gateway.ActiveRequests > 0) { text = "正在生成"; }
            else if (state == "loading") { text = "模型正在加载"; }
            else if (state == "loaded") { text = "模型已加载"; }
            else if (state == "error") { text = "后端错误"; }
            else { text = "模型未加载"; }
            statusItem.Text = "状态：" + text;
            notifyIcon.Text = ShortTooltip("Qwen 网页朗读：" + text);
        }

        private void LoadBackend()
        {
            try
            {
                backend.EnsureStarted();
                ShowMessage("Qwen 网页朗读", "模型已加载。", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                ShowMessage("Qwen 模型加载失败", ex.Message, ToolTipIcon.Error);
            }
        }

        private void UnloadBackend()
        {
            if (gateway.ActiveRequests > 0)
            {
                ShowMessage("Qwen 网页朗读", "当前仍在生成语音，暂不卸载。", ToolTipIcon.Warning);
                return;
            }
            backend.Stop("tray unload");
            ShowMessage("Qwen 网页朗读", "模型已卸载，显存已释放。", ToolTipIcon.Info);
        }

        private void ToggleAutoUnload(object sender, EventArgs args)
        {
            config.AutoUnload = autoUnloadItem.Checked;
            GatewayConfig.Save(configPath, config);
            logger.Write("auto_unload_changed enabled=" + config.AutoUnload);
        }

        private void ToggleStartup(object sender, EventArgs args)
        {
            try
            {
                if (startupItem.Checked) { CreateStartupShortcut(); }
                else if (File.Exists(StartupShortcutPath())) { File.Delete(StartupShortcutPath()); }
                logger.Write("startup_changed enabled=" + startupItem.Checked);
            }
            catch (Exception ex)
            {
                startupItem.Checked = !startupItem.Checked;
                ShowMessage("开机启动设置失败", ex.Message, ToolTipIcon.Error);
            }
        }

        private void OpenLogs(object sender, EventArgs args)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = config.LogDirectory,
                UseShellExecute = true
            });
        }

        private void RequestExitFromWorker()
        {
            if (!marshalControl.IsDisposed)
            {
                marshalControl.BeginInvoke(new Action(ExitAll));
            }
        }

        private void ExitAll()
        {
            if (exiting) { return; }
            exiting = true;
            statusTimer.Stop();
            gateway.Stop();
            backend.Stop("complete exit");
            notifyIcon.Visible = false;
            logger.Write("tray_gateway_exit");
            ExitThread();
        }

        private void RunWorker(Action action)
        {
            ThreadPool.QueueUserWorkItem(delegate { action(); });
        }

        private void ShowMessage(string title, string message, ToolTipIcon icon)
        {
            if (!marshalControl.IsDisposed)
            {
                marshalControl.BeginInvoke(new Action(delegate
                {
                    notifyIcon.ShowBalloonTip(5000, title, message, icon);
                }));
            }
        }

        private void CreateStartupShortcut()
        {
            CreateShortcut(
                StartupShortcutPath(),
                Assembly.GetExecutingAssembly().Location,
                string.Empty,
                Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));
        }

        public static void CreateShortcut(string shortcutPath, string targetPath, string arguments, string workingDirectory)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { shortcutPath });
            Type shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
            shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments ?? string.Empty });
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
            shortcutType.InvokeMember("WindowStyle", BindingFlags.SetProperty, null, shortcut, new object[] { 7 });
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }

        public static string StartupShortcutPath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Startup),
                "Qwen 网页朗读.lnk");
        }

        private static string ShortTooltip(string text)
        {
            return text.Length <= 63 ? text : text.Substring(0, 63);
        }
    }
}
