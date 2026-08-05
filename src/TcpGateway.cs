using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace QwenTrayGateway
{
    public sealed class TcpGateway : IDisposable
    {
        private readonly GatewayConfig config;
        private readonly BackendController backend;
        private readonly GatewayLogger logger;
        private readonly Timer idleTimer;
        private TcpListener listener;
        private Thread acceptThread;
        private volatile bool stopping;
        private int activeRequests;
        private DateTime lastActivityUtc;

        public event Action ExitRequested;

        public TcpGateway(GatewayConfig config, BackendController backend, GatewayLogger logger)
        {
            this.config = config;
            this.backend = backend;
            this.logger = logger;
            lastActivityUtc = DateTime.UtcNow;
            idleTimer = new Timer(CheckIdle, null, Timeout.Infinite, Timeout.Infinite);
        }

        public int ActiveRequests { get { return Interlocked.CompareExchange(ref activeRequests, 0, 0); } }
        public DateTime LastActivityUtc { get { return lastActivityUtc; } }

        public void Start()
        {
            if (listener != null)
            {
                return;
            }
            listener = new TcpListener(IPAddress.Loopback, config.GatewayPort);
            listener.Start();
            stopping = false;
            acceptThread = new Thread(AcceptLoop);
            acceptThread.IsBackground = true;
            acceptThread.Name = "Qwen gateway accept loop";
            acceptThread.Start();
            idleTimer.Change(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
            logger.Write("gateway_listening address=127.0.0.1 port=" + config.GatewayPort);
        }

        public void Stop()
        {
            stopping = true;
            idleTimer.Change(Timeout.Infinite, Timeout.Infinite);
            TcpListener local = listener;
            listener = null;
            if (local != null)
            {
                try { local.Stop(); } catch { }
            }
            if (acceptThread != null && Thread.CurrentThread != acceptThread)
            {
                acceptThread.Join(2000);
            }
            logger.Write("gateway_stopped");
        }

        public void Dispose()
        {
            Stop();
            idleTimer.Dispose();
        }

        public string BuildStatusJson()
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["gateway"] = "ok";
            result["backend"] = backend.State;
            result["backendPid"] = backend.ProcessId;
            result["activeRequests"] = ActiveRequests;
            result["autoUnload"] = config.AutoUnload;
            result["idleMinutes"] = config.IdleMinutes;
            result["lastActivityUtc"] = lastActivityUtc.ToString("o");
            if (!string.IsNullOrEmpty(backend.LastError))
            {
                result["lastError"] = backend.LastError;
            }
            return new JavaScriptSerializer().Serialize(result);
        }

        private void AcceptLoop()
        {
            while (!stopping)
            {
                try
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
                catch (SocketException)
                {
                    if (!stopping) { logger.Write("gateway_accept_socket_error"); }
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    logger.Write("gateway_accept_error type=" + ex.GetType().Name);
                }
            }
        }

        private void HandleClient(object state)
        {
            using (TcpClient client = (TcpClient)state)
            {
                client.ReceiveTimeout = 120000;
                client.SendTimeout = 120000;
                using (NetworkStream stream = client.GetStream())
                {
                    try
                    {
                        HttpRequestData request = HttpRequestData.ReadFrom(stream);
                        Dispatch(request, stream);
                    }
                    catch (Exception ex)
                    {
                        logger.Write("request_error type=" + ex.GetType().Name + " message=" + Safe(ex.Message));
                        TryWriteJson(stream, 400, "Bad Request", ErrorJson("bad_request", ex.Message));
                    }
                }
            }
        }

        private void Dispatch(HttpRequestData request, Stream output)
        {
            string path = GatewayProtocol.StripQuery(request.PathAndQuery);
            bool requiresBackend = GatewayProtocol.RequiresBackend(
                request.Method,
                request.PathAndQuery);
            if (requiresBackend &&
                !GatewayProtocol.IsTrustedBackendClient(
                    request.Header("X-Qwen-Reader-Client")))
            {
                logger.Write("request_rejected reason=missing_client_header path=" + Safe(path));
                WriteJson(output, 403, "Forbidden", ErrorJson("forbidden_client", "A trusted Qwen Reader client header is required."));
                return;
            }
            if (request.Method == "OPTIONS")
            {
                WriteResponse(output, 204, "No Content", "text/plain", new byte[0], null);
                return;
            }
            if (request.Method == "GET" && path == "/health")
            {
                WriteJson(output, 200, "OK", BuildStatusJson());
                return;
            }
            if (request.Method == "GET" && path == "/gateway/status")
            {
                WriteJson(output, 200, "OK", BuildStatusJson());
                return;
            }
            if (path.StartsWith("/gateway/", StringComparison.Ordinal))
            {
                HandleManagement(request, path, output);
                return;
            }
            if (!requiresBackend)
            {
                WriteJson(output, 404, "Not Found", ErrorJson("not_found", "Unknown local gateway endpoint."));
                return;
            }

            Interlocked.Increment(ref activeRequests);
            try
            {
                backend.EnsureStarted();
                Proxy(request, output);
            }
            catch (Exception ex)
            {
                logger.Write("proxy_failed path=" + path + " type=" + ex.GetType().Name);
                WriteJson(output, 503, "Service Unavailable", ErrorJson("backend_unavailable", ex.Message));
            }
            finally
            {
                lastActivityUtc = DateTime.UtcNow;
                Interlocked.Decrement(ref activeRequests);
            }
        }

        private void HandleManagement(HttpRequestData request, string path, Stream output)
        {
            if (request.Method != "POST" ||
                !GatewayProtocol.IsAuthorized(config.ManagementToken, request.Header("X-Qwen-Gateway-Token")))
            {
                WriteJson(output, 403, "Forbidden", ErrorJson("forbidden", "A valid local management token is required."));
                return;
            }

            if (path == "/gateway/load")
            {
                try
                {
                    backend.EnsureStarted();
                    lastActivityUtc = DateTime.UtcNow;
                    WriteJson(output, 200, "OK", BuildStatusJson());
                }
                catch (Exception ex)
                {
                    WriteJson(output, 503, "Service Unavailable", ErrorJson("backend_unavailable", ex.Message));
                }
                return;
            }
            if (path == "/gateway/unload")
            {
                if (ActiveRequests > 0)
                {
                    WriteJson(output, 409, "Conflict", ErrorJson("busy", "A speech request is still active."));
                    return;
                }
                backend.Stop("manual unload");
                WriteJson(output, 200, "OK", BuildStatusJson());
                return;
            }
            if (path == "/gateway/exit")
            {
                WriteJson(output, 200, "OK", "{\"status\":\"exiting\"}");
                Action handler = ExitRequested;
                if (handler != null)
                {
                    ThreadPool.QueueUserWorkItem(delegate { handler(); });
                }
                return;
            }
            WriteJson(output, 404, "Not Found", ErrorJson("not_found", "Unknown management endpoint."));
        }

        private void Proxy(HttpRequestData request, Stream output)
        {
            string url = "http://127.0.0.1:" + config.BackendPort + request.PathAndQuery;
            HttpWebRequest backendRequest = (HttpWebRequest)WebRequest.Create(url);
            backendRequest.Method = request.Method;
            backendRequest.Timeout = 120000;
            backendRequest.ReadWriteTimeout = 120000;
            backendRequest.AllowAutoRedirect = false;
            string contentType = request.Header("Content-Type");
            if (!string.IsNullOrEmpty(contentType)) { backendRequest.ContentType = contentType; }
            string accept = request.Header("Accept");
            if (!string.IsNullOrEmpty(accept)) { backendRequest.Accept = accept; }
            string authorization = request.Header("Authorization");
            if (!string.IsNullOrEmpty(authorization)) { backendRequest.Headers["Authorization"] = authorization; }
            if (request.Body.Length > 0)
            {
                backendRequest.ContentLength = request.Body.Length;
                using (Stream body = backendRequest.GetRequestStream())
                {
                    body.Write(request.Body, 0, request.Body.Length);
                }
            }

            HttpWebResponse backendResponse = null;
            try
            {
                backendResponse = (HttpWebResponse)backendRequest.GetResponse();
            }
            catch (WebException ex)
            {
                backendResponse = ex.Response as HttpWebResponse;
                if (backendResponse == null) { throw; }
            }

            using (backendResponse)
            using (Stream body = backendResponse.GetResponseStream())
            using (MemoryStream copy = new MemoryStream())
            {
                body.CopyTo(copy);
                WriteResponse(
                    output,
                    (int)backendResponse.StatusCode,
                    backendResponse.StatusDescription,
                    backendResponse.ContentType,
                    copy.ToArray(),
                    backendResponse.Headers);
            }
        }

        private void CheckIdle(object ignored)
        {
            try
            {
                if (IdlePolicy.ShouldUnload(
                    lastActivityUtc,
                    DateTime.UtcNow,
                    config.AutoUnload,
                    config.IdleMinutes,
                    ActiveRequests,
                    backend.IsLoaded))
                {
                    backend.Stop("idle timeout");
                }
            }
            catch (Exception ex)
            {
                logger.Write("idle_check_error type=" + ex.GetType().Name);
            }
        }

        private static string ErrorJson(string code, string message)
        {
            Dictionary<string, object> error = new Dictionary<string, object>();
            error["code"] = code;
            error["message"] = message;
            Dictionary<string, object> root = new Dictionary<string, object>();
            root["error"] = error;
            return new JavaScriptSerializer().Serialize(root);
        }

        private static void WriteJson(Stream output, int status, string reason, string json)
        {
            WriteResponse(output, status, reason, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json), null);
        }

        private static void TryWriteJson(Stream output, int status, string reason, string json)
        {
            try { WriteJson(output, status, reason, json); } catch { }
        }

        private static void WriteResponse(
            Stream output,
            int status,
            string reason,
            string contentType,
            byte[] body,
            WebHeaderCollection forwardedHeaders)
        {
            StringBuilder header = new StringBuilder();
            header.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason ?? string.Empty).Append("\r\n");
            header.Append("Content-Type: ").Append(string.IsNullOrEmpty(contentType) ? "application/octet-stream" : contentType).Append("\r\n");
            header.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            header.Append("Connection: close\r\n");
            header.Append("Cache-Control: no-store\r\n");
            if (forwardedHeaders != null && !string.IsNullOrEmpty(forwardedHeaders["Content-Disposition"]))
            {
                header.Append("Content-Disposition: ").Append(forwardedHeaders["Content-Disposition"]).Append("\r\n");
            }
            header.Append("\r\n");
            byte[] headerBytes = Encoding.ASCII.GetBytes(header.ToString());
            output.Write(headerBytes, 0, headerBytes.Length);
            if (body.Length > 0) { output.Write(body, 0, body.Length); }
            output.Flush();
        }

        private static string Safe(string value)
        {
            if (string.IsNullOrEmpty(value)) { return string.Empty; }
            string oneLine = value.Replace("\r", " ").Replace("\n", " ");
            return oneLine.Length > 300 ? oneLine.Substring(0, 300) : oneLine;
        }
    }
}
