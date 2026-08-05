using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace QwenTrayGateway
{
    public sealed class BackendController : IDisposable
    {
        private readonly object sync = new object();
        private readonly GatewayConfig config;
        private readonly GatewayLogger logger;
        private Process process;
        private string state = "unloaded";
        private string lastError = string.Empty;

        public BackendController(GatewayConfig config, GatewayLogger logger)
        {
            this.config = config;
            this.logger = logger;
        }

        public string State
        {
            get
            {
                lock (sync)
                {
                    RefreshProcessState();
                    return state;
                }
            }
        }

        public string LastError
        {
            get { lock (sync) { return lastError; } }
        }

        public int ProcessId
        {
            get
            {
                lock (sync)
                {
                    RefreshProcessState();
                    return process == null ? 0 : process.Id;
                }
            }
        }

        public bool IsLoaded
        {
            get { return string.Equals(State, "loaded", StringComparison.Ordinal); }
        }

        public void EnsureStarted()
        {
            lock (sync)
            {
                RefreshProcessState();
                if (process != null && state == "loaded" && IsHealthy())
                {
                    return;
                }

                state = "loading";
                lastError = string.Empty;
                try
                {
                    ValidateFiles();
                    if (IsPortOpen(config.BackendPort))
                    {
                        throw new InvalidOperationException(
                            "Backend port " + config.BackendPort + " is already occupied by an unmanaged process.");
                    }
                    StartProcess();
                    WaitUntilHealthy();
                    RegisterConfiguredVoices();
                    state = "loaded";
                    logger.Write("backend_loaded pid=" + process.Id);
                }
                catch (Exception ex)
                {
                    lastError = ex.Message;
                    state = "error";
                    logger.Write("backend_start_failed error=" + Sanitize(ex.Message));
                    StopProcessLocked("startup failure");
                    throw;
                }
            }
        }

        public void Stop(string reason)
        {
            lock (sync)
            {
                StopProcessLocked(reason);
            }
        }

        public void Dispose()
        {
            Stop("gateway dispose");
        }

        private void ValidateFiles()
        {
            string[] paths =
            {
                config.BackendExecutable,
                config.ModelPath,
                config.CodecPath,
                config.VoiceReferenceWav
            };
            foreach (string path in paths)
            {
                if (!File.Exists(path))
                {
                    throw new FileNotFoundException("Required Qwen file is missing.", path);
                }
            }
        }

        private void StartProcess()
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = config.BackendExecutable;
            start.Arguments =
                "--model " + Quote(config.ModelPath) +
                " --codec " + Quote(config.CodecPath) +
                " --alias " + Quote(config.ModelAlias) +
                " --host 127.0.0.1" +
                " --port " + config.BackendPort +
                " --lang " + Quote(config.Language);
            start.WorkingDirectory = Path.GetDirectoryName(config.BackendExecutable);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;

            process = new Process();
            process.StartInfo = start;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (!string.IsNullOrEmpty(args.Data))
                {
                    logger.Write("backend_stdout " + Sanitize(args.Data));
                }
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (!string.IsNullOrEmpty(args.Data))
                {
                    logger.Write("backend_stderr " + Sanitize(args.Data));
                }
            };
            if (!process.Start())
            {
                throw new InvalidOperationException("tts-server.exe did not start.");
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            logger.Write("backend_starting pid=" + process.Id + " port=" + config.BackendPort);
        }

        private void WaitUntilHealthy()
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(config.BackendStartTimeoutSeconds);
            while (DateTime.UtcNow < deadline)
            {
                if (process.HasExited)
                {
                    throw new InvalidOperationException("Qwen backend exited during startup with code " + process.ExitCode + ".");
                }
                if (IsHealthy())
                {
                    return;
                }
                Thread.Sleep(250);
            }
            throw new TimeoutException("Qwen backend did not become healthy within the configured timeout.");
        }

        private bool IsHealthy()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + config.BackendPort + "/health");
                request.Timeout = 1000;
                request.ReadWriteTimeout = 1000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private void RegisterConfiguredVoices()
        {
            byte[] wav = File.ReadAllBytes(config.VoiceReferenceWav);
            RegisterVoice(config.VoiceName, wav);
            if (!string.Equals(config.VoiceName, config.VoiceAlias, StringComparison.Ordinal))
            {
                RegisterVoice(config.VoiceAlias, wav);
            }
        }

        private void RegisterVoice(string name, byte[] wav)
        {
            byte[] body = Encoding.UTF8.GetBytes(VoicePayloadBuilder.BuildJson(name, wav));
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                "http://127.0.0.1:" + config.BackendPort + "/v1/audio/voices");
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.ContentLength = body.Length;
            request.Timeout = 60000;
            request.ReadWriteTimeout = 60000;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(body, 0, body.Length);
            }
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode < HttpStatusCode.OK || response.StatusCode >= HttpStatusCode.MultipleChoices)
                {
                    throw new InvalidOperationException("Voice registration failed for " + name + ".");
                }
            }
            logger.Write("voice_registered name=" + name);
        }

        private void StopProcessLocked(string reason)
        {
            RefreshProcessState();
            if (process == null)
            {
                state = "unloaded";
                return;
            }

            try
            {
                string actualPath = process.MainModule.FileName;
                if (!PathSafety.SameExecutable(actualPath, config.BackendExecutable))
                {
                    lastError = "Refused to stop backend because its executable path changed.";
                    state = "error";
                    logger.Write("backend_stop_refused pid=" + process.Id);
                    return;
                }
                int pid = process.Id;
                process.Kill();
                process.WaitForExit(10000);
                logger.Write("backend_stopped pid=" + pid + " reason=" + Sanitize(reason));
            }
            catch (InvalidOperationException)
            {
            }
            finally
            {
                process.Dispose();
                process = null;
                state = "unloaded";
            }
        }

        private void RefreshProcessState()
        {
            if (process != null && process.HasExited)
            {
                logger.Write("backend_exited pid=" + process.Id + " code=" + process.ExitCode);
                process.Dispose();
                process = null;
                state = "unloaded";
            }
        }

        private static bool IsPortOpen(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                    bool connected = result.AsyncWaitHandle.WaitOne(300);
                    if (connected)
                    {
                        client.EndConnect(result);
                    }
                    return connected;
                }
            }
            catch
            {
                return false;
            }
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }

        private static string Sanitize(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }
            string oneLine = value.Replace("\r", " ").Replace("\n", " ");
            return oneLine.Length > 500 ? oneLine.Substring(0, 500) : oneLine;
        }
    }
}
