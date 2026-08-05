using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace QwenTrayGateway
{
    internal static class Program
    {
        private const string MutexName = "Local\\QwenTrayGateway-7811";

        [STAThread]
        private static void Main(string[] args)
        {
            string configPath = Path.Combine(
                Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                "gateway.json");
            bool showTray = true;
            string command = null;
            for (int index = 0; index < args.Length; index++)
            {
                if (args[index] == "--config" && index + 1 < args.Length)
                {
                    configPath = Path.GetFullPath(args[++index]);
                }
                else if (args[index] == "--no-tray")
                {
                    showTray = false;
                }
                else if (args[index] == "--load" || args[index] == "--unload" || args[index] == "--exit")
                {
                    command = args[index].Substring(2);
                }
            }

            if (command != null)
            {
                SendManagementCommand(configPath, command);
                return;
            }

            bool created;
            using (Mutex mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    return;
                }
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (TrayApplication context = new TrayApplication(configPath, showTray))
                    {
                        Application.Run(context);
                    }
                }
                catch (Exception ex)
                {
                    WriteStartupError(configPath, ex);
                    Environment.ExitCode = 2;
                }
            }
        }

        private static void SendManagementCommand(string configPath, string command)
        {
            try
            {
                GatewayConfig config = GatewayConfig.LoadOrCreate(configPath);
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + config.GatewayPort + "/gateway/" + command);
                request.Method = "POST";
                request.ContentLength = 0;
                request.Timeout = 65000;
                request.Headers["X-Qwen-Gateway-Token"] = config.ManagementToken;
                using (request.GetResponse()) { }
            }
            catch
            {
            }
        }

        private static void WriteStartupError(string configPath, Exception exception)
        {
            try
            {
                string directory = Path.GetDirectoryName(Path.GetFullPath(configPath));
                string logDirectory = Path.Combine(directory, "logs");
                Directory.CreateDirectory(logDirectory);
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") +
                              " startup_failed type=" + exception.GetType().Name +
                              " message=" + exception.Message.Replace("\r", " ").Replace("\n", " ") +
                              Environment.NewLine;
                File.AppendAllText(
                    Path.Combine(logDirectory, "gateway-startup-error.log"),
                    line,
                    new UTF8Encoding(false));
            }
            catch
            {
            }
        }
    }
}
