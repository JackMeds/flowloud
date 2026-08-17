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
        private readonly SpeechStreamRegistry speechStreams;
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
            speechStreams = new SpeechStreamRegistry();
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
            Dictionary<string, object> capabilities = new Dictionary<string, object>();
            capabilities["transportStreaming"] = true;
            capabilities["backendIncrementalGeneration"] = false;
            capabilities["cancel"] = true;
            capabilities["status"] = true;
            capabilities["endpoint"] = "/v1/audio/speech/stream";
            capabilities["mode"] = "wav-transport-chunked";
            result["capabilities"] = capabilities;
            result["limits"] = new Dictionary<string, object>
            {
                { "maxConcurrentRequests", config.MaxConcurrentRequests },
                { "requestTimeoutSeconds", config.RequestTimeoutSeconds },
                { "maxStreamBytes", config.MaxStreamBytes },
                { "streamChunkBytes", config.StreamChunkBytes }
            };
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
                int ioTimeout = Math.Max(1000, Math.Min(Int32.MaxValue / 2, config.RequestTimeoutSeconds * 1000));
                client.ReceiveTimeout = ioTimeout;
                client.SendTimeout = ioTimeout;
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
            if (GatewayProtocol.RequiresTrustedClient(request.Method, request.PathAndQuery) &&
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
            if (GatewayProtocol.IsSpeechCancel(request.Method, request.PathAndQuery))
            {
                HandleSpeechCancel(request, output);
                return;
            }
            if (GatewayProtocol.IsSpeechStatus(request.Method, request.PathAndQuery))
            {
                HandleSpeechStatus(request, path, output);
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

            if (!TryEnterRequest())
            {
                WriteJson(output, 429, "Too Many Requests", ErrorJson("rate_limited", "Too many active speech requests."));
                return;
            }
            SpeechStreamSession streamSession = null;
            bool streamRegistered = false;
            try
            {
                if (GatewayProtocol.IsSpeechStream(request.Method, request.PathAndQuery))
                {
                    streamSession = CreateSpeechStreamSession(request);
                    if (!speechStreams.TryRegister(streamSession))
                    {
                        WriteJson(output, 409, "Conflict", ErrorJson("duplicate_request_id", "The request or playback ID is already active."));
                        return;
                    }
                    streamRegistered = true;
                }
                backend.EnsureStarted();
                if (streamSession != null && streamRegistered)
                {
                    ProxyStream(request, output, streamSession);
                }
                else
                {
                    Proxy(request, output);
                }
            }
            catch (Exception ex)
            {
                logger.Write("proxy_failed path=" + path + " type=" + ex.GetType().Name);
                if (streamSession != null) { streamSession.SetError(ex.Message); }
                // Before a streaming response starts, preserve a normal JSON error status.
                // Once chunked headers are out, ProxyStream owns the terminal trailer.
                if (streamSession == null || !streamSession.ResponseStarted)
                {
                    bool invalidId = ex is SpeechRequestIdException;
                    WriteJson(output,
                        invalidId ? 400 : 503,
                        invalidId ? "Bad Request" : "Service Unavailable",
                        ErrorJson(
                            invalidId ? "invalid_request_id" : (streamSession != null && streamSession.IsCancellationRequested ? "cancelled" : "backend_unavailable"),
                            ex.Message));
                }
            }
            finally
            {
                if (streamSession != null && streamRegistered)
                {
                    string resultState = streamSession.IsCancellationRequested ? "cancelled" : streamSession.State;
                    if (resultState == "active") { resultState = "failed"; }
                    if (speechStreams.Find(streamSession.RequestId) != null)
                    {
                        speechStreams.Complete(streamSession, resultState, resultState == "failed" ? streamSession.Error : string.Empty);
                    }
                }
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

        private void HandleSpeechCancel(HttpRequestData request, Stream output)
        {
            SpeechRequestIds ids;
            try
            {
                ids = ResolveSpeechRequestIds(request, false);
            }
            catch (Exception ex)
            {
                WriteJson(output, 400, "Bad Request", ErrorJson("invalid_request_id", ex.Message));
                return;
            }
            if (string.IsNullOrEmpty(ids.RequestId) && string.IsNullOrEmpty(ids.PlaybackId))
            {
                WriteJson(output, 400, "Bad Request", ErrorJson("missing_request_id", "request_id or playback_id is required."));
                return;
            }
            SpeechStreamSession active = speechStreams.FindActive(ids.RequestId, ids.PlaybackId);
            if (active == null)
            {
                bool mismatch = !string.IsNullOrEmpty(ids.RequestId) &&
                                !string.IsNullOrEmpty(ids.PlaybackId) &&
                                speechStreams.FindActive(ids.RequestId, null) != null &&
                                speechStreams.FindActive(null, ids.PlaybackId) != null;
                WriteJson(output,
                    mismatch ? 409 : 404,
                    mismatch ? "Conflict" : "Not Found",
                    ErrorJson(
                        mismatch ? "request_id_mismatch" : "request_not_found",
                        mismatch ? "request_id and playback_id belong to different active requests." : "No active speech request matches the supplied ID."));
                return;
            }
            active.Cancel();

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["status"] = "cancellation_requested";
            result["request_id"] = active.RequestId;
            result["playback_id"] = active.PlaybackId;
            WriteJson(output, 202, "Accepted", new JavaScriptSerializer().Serialize(result));
        }

        private void HandleSpeechStatus(HttpRequestData request, string path, Stream output)
        {
            string prefix = "/v1/audio/speech/status/";
            string id = path.Substring(prefix.Length);
            try { id = Uri.UnescapeDataString(id); } catch { }
            if (!GatewayProtocol.IsSafeRequestId(id))
            {
                WriteJson(output, 400, "Bad Request", ErrorJson("invalid_request_id", "The request ID contains unsupported characters."));
                return;
            }
            string requestId = request.Header("X-Qwen-Request-Id");
            string playbackId = request.Header("X-Qwen-Playback-Id");
            if ((!string.IsNullOrEmpty(requestId) && !GatewayProtocol.IsSafeRequestId(requestId)) ||
                (!string.IsNullOrEmpty(playbackId) && !GatewayProtocol.IsSafeRequestId(playbackId)))
            {
                WriteJson(output, 400, "Bad Request", ErrorJson("invalid_request_id", "A supplied status ID contains unsupported characters."));
                return;
            }

            SpeechStreamSnapshot snapshot;
            bool pairedLookup = false;
            if (!string.IsNullOrEmpty(requestId) && !string.IsNullOrEmpty(playbackId))
            {
                if (!string.Equals(id, requestId, StringComparison.Ordinal) && !string.Equals(id, playbackId, StringComparison.Ordinal))
                {
                    WriteJson(output, 409, "Conflict", ErrorJson("request_id_mismatch", "The path ID does not match the supplied request/playback pair."));
                    return;
                }
                snapshot = speechStreams.FindByIds(requestId, playbackId);
                pairedLookup = true;
            }
            else if (!string.IsNullOrEmpty(requestId) && !string.Equals(id, requestId, StringComparison.Ordinal))
            {
                snapshot = speechStreams.FindByIds(requestId, id);
                pairedLookup = true;
            }
            else if (!string.IsNullOrEmpty(playbackId) && !string.Equals(id, playbackId, StringComparison.Ordinal))
            {
                snapshot = speechStreams.FindByIds(id, playbackId);
                pairedLookup = true;
            }
            else
            {
                snapshot = speechStreams.Find(id);
            }
            if (snapshot == null)
            {
                WriteJson(output,
                    pairedLookup ? 409 : 404,
                    pairedLookup ? "Conflict" : "Not Found",
                    ErrorJson(
                        pairedLookup ? "request_id_mismatch" : "request_not_found",
                        pairedLookup ? "request_id and playback_id do not identify the same speech request." : "No speech request matches the supplied ID."));
                return;
            }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["status"] = snapshot.State;
            result["request_id"] = snapshot.RequestId;
            result["playback_id"] = snapshot.PlaybackId;
            result["bytes"] = snapshot.Bytes;
            result["backend_incremental_generation"] = false;
            if (!string.IsNullOrEmpty(snapshot.Error)) { result["error"] = snapshot.Error; }
            WriteJson(output, 200, "OK", new JavaScriptSerializer().Serialize(result));
        }

        private bool TryEnterRequest()
        {
            while (true)
            {
                int current = Interlocked.CompareExchange(ref activeRequests, 0, 0);
                if (current >= config.MaxConcurrentRequests) { return false; }
                if (Interlocked.CompareExchange(ref activeRequests, current + 1, current) == current)
                {
                    return true;
                }
            }
        }

        private static SpeechStreamSession CreateSpeechStreamSession(HttpRequestData request)
        {
            SpeechRequestIds ids = ResolveSpeechRequestIds(request, true);
            return new SpeechStreamSession(ids.RequestId, ids.PlaybackId);
        }

        private sealed class SpeechRequestIds
        {
            public string RequestId;
            public string PlaybackId;
        }

        private static SpeechRequestIds ResolveSpeechRequestIds(HttpRequestData request, bool generateMissing)
        {
            string requestId = request.Header("X-Qwen-Request-Id");
            string playbackId = request.Header("X-Qwen-Playback-Id");
            IDictionary<string, object> body = ReadJsonObject(request.Body);
            if (string.IsNullOrEmpty(requestId)) { requestId = ReadJsonId(body, "request_id", "requestId"); }
            if (string.IsNullOrEmpty(playbackId)) { playbackId = ReadJsonId(body, "playback_id", "playbackId"); }
            if (!string.IsNullOrEmpty(requestId) && !GatewayProtocol.IsSafeRequestId(requestId))
            {
                throw new SpeechRequestIdException("X-Qwen-Request-Id is invalid.");
            }
            if (!string.IsNullOrEmpty(playbackId) && !GatewayProtocol.IsSafeRequestId(playbackId))
            {
                throw new SpeechRequestIdException("X-Qwen-Playback-Id is invalid.");
            }
            if (generateMissing)
            {
                if (string.IsNullOrEmpty(requestId)) { requestId = Guid.NewGuid().ToString("N"); }
                if (string.IsNullOrEmpty(playbackId)) { playbackId = Guid.NewGuid().ToString("N"); }
            }
            return new SpeechRequestIds { RequestId = requestId, PlaybackId = playbackId };
        }

        private static IDictionary<string, object> ReadJsonObject(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0) { return null; }
            string text = Encoding.UTF8.GetString(bytes).Trim();
            if (text.Length == 0 || text[0] != '{') { return null; }
            try
            {
                return new JavaScriptSerializer().DeserializeObject(text) as IDictionary<string, object>;
            }
            catch
            {
                // The backend will produce the authoritative malformed-body error. IDs are
                // optional metadata, so do not make legacy requests fail at this layer.
                return null;
            }
        }

        private static string ReadJsonId(IDictionary<string, object> body, string first, string second)
        {
            if (body == null) { return null; }
            object value;
            if (body.TryGetValue(first, out value) || body.TryGetValue(second, out value))
            {
                return value as string;
            }
            return null;
        }

        private void Proxy(HttpRequestData request, Stream output)
        {
            HttpWebRequest backendRequest = CreateBackendRequest(request);
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
                CopyResponseBody(body, copy, config.MaxStreamBytes);
                WriteResponse(
                    output,
                    (int)backendResponse.StatusCode,
                    backendResponse.StatusDescription,
                    backendResponse.ContentType,
                    copy.ToArray(),
                    backendResponse.Headers);
            }
        }

        private HttpWebRequest CreateBackendRequest(HttpRequestData request)
        {
            string backendPath = request.PathAndQuery;
            if (GatewayProtocol.IsSpeechStream(request.Method, request.PathAndQuery))
            {
                int queryIndex = backendPath.IndexOf('?');
                backendPath = "/v1/audio/speech" + (queryIndex < 0 ? string.Empty : backendPath.Substring(queryIndex));
            }
            string url = "http://127.0.0.1:" + config.BackendPort + backendPath;
            HttpWebRequest backendRequest = (HttpWebRequest)WebRequest.Create(url);
            backendRequest.Method = request.Method;
            int timeout = Math.Max(1000, Math.Min(Int32.MaxValue / 2, config.RequestTimeoutSeconds * 1000));
            backendRequest.Timeout = timeout;
            backendRequest.ReadWriteTimeout = timeout;
            backendRequest.AllowAutoRedirect = false;
            string contentType = request.Header("Content-Type");
            if (!string.IsNullOrEmpty(contentType)) { backendRequest.ContentType = contentType; }
            string accept = request.Header("Accept");
            if (!string.IsNullOrEmpty(accept)) { backendRequest.Accept = accept; }
            string authorization = request.Header("Authorization");
            if (!string.IsNullOrEmpty(authorization)) { backendRequest.Headers["Authorization"] = authorization; }
            return backendRequest;
        }

        private void ProxyStream(HttpRequestData request, Stream output, SpeechStreamSession session)
        {
            HttpWebRequest backendRequest = CreateBackendRequest(request);
            session.AttachBackendRequest(backendRequest);
            if (request.Body.Length > 0)
            {
                backendRequest.ContentLength = request.Body.Length;
                using (Stream body = backendRequest.GetRequestStream())
                {
                    body.Write(request.Body, 0, request.Body.Length);
                }
            }

            HttpWebResponse backendResponse = null;
            bool headersSent = false;
            string terminalStatus = "completed";
            string terminalError = string.Empty;
            try
            {
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
                {
                    if ((int)backendResponse.StatusCode < 200 || (int)backendResponse.StatusCode >= 300)
                    {
                        using (MemoryStream errorBody = new MemoryStream())
                        {
                            CopyResponseBody(body, errorBody, config.MaxStreamBytes);
                            WriteResponse(
                                output,
                                (int)backendResponse.StatusCode,
                                backendResponse.StatusDescription,
                                backendResponse.ContentType,
                                errorBody.ToArray(),
                                backendResponse.Headers);
                        }
                        terminalStatus = "failed";
                        terminalError = "backend_http_" + (int)backendResponse.StatusCode;
                        return;
                    }

                    string contentType = string.IsNullOrEmpty(backendResponse.ContentType) ? "audio/wav" : backendResponse.ContentType;
                    try
                    {
                        WriteChunkedHeaders(output, contentType, session.RequestId, session.PlaybackId);
                    }
                    catch (IOException)
                    {
                        session.Cancel();
                        logger.Write("stream_client_disconnected request_id=" + Safe(session.RequestId));
                        throw;
                    }
                    session.ResponseStarted = true;
                    headersSent = true;
                    byte[] buffer = new byte[config.StreamChunkBytes];
                    long total = 0;
                    DateTime deadline = DateTime.UtcNow.AddSeconds(config.RequestTimeoutSeconds);
                    while (true)
                    {
                        if (session.IsCancellationRequested)
                        {
                            terminalStatus = "cancelled";
                            break;
                        }
                        if (DateTime.UtcNow > deadline)
                        {
                            session.Cancel();
                            terminalStatus = "failed";
                            terminalError = "timeout";
                            break;
                        }
                        int count = body.Read(buffer, 0, buffer.Length);
                        if (count <= 0) { break; }
                        total += count;
                        if (total > config.MaxStreamBytes)
                        {
                            session.Cancel();
                            terminalStatus = "failed";
                            terminalError = "stream_too_large";
                            break;
                        }
                        try
                        {
                            WriteChunk(output, buffer, count);
                        }
                        catch (IOException)
                        {
                            session.Cancel();
                            logger.Write("stream_client_disconnected request_id=" + Safe(session.RequestId));
                            terminalStatus = "cancelled";
                            break;
                        }
                        session.AddBytes(count);
                    }
                    if (session.IsCancellationRequested && terminalStatus == "completed")
                    {
                        terminalStatus = "cancelled";
                    }
                }
            }
            catch (Exception ex)
            {
                if (session.IsCancellationRequested)
                {
                    terminalStatus = "cancelled";
                    terminalError = string.Empty;
                }
                else if (headersSent)
                {
                    terminalStatus = "failed";
                    terminalError = Safe(ex.Message);
                }
                else
                {
                    throw;
                }
            }
            finally
            {
                session.SetError(terminalError);
                if (headersSent)
                {
                    try { WriteChunkedEnd(output, terminalStatus, terminalError); } catch { }
                }
            }
        }

        private static void CopyResponseBody(Stream input, Stream output, int maximumBytes)
        {
            byte[] buffer = new byte[32 * 1024];
            long total = 0;
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                total += count;
                if (total > maximumBytes)
                {
                    throw new InvalidDataException("Backend response exceeds the configured stream limit.");
                }
                output.Write(buffer, 0, count);
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

        private static void WriteChunkedHeaders(
            Stream output,
            string contentType,
            string requestId,
            string playbackId)
        {
            StringBuilder header = new StringBuilder();
            header.Append("HTTP/1.1 200 OK\r\n");
            header.Append("Content-Type: ").Append(string.IsNullOrEmpty(contentType) ? "audio/wav" : contentType).Append("\r\n");
            header.Append("Transfer-Encoding: chunked\r\n");
            header.Append("Connection: close\r\n");
            header.Append("Cache-Control: no-store\r\n");
            header.Append("X-Qwen-Request-Id: ").Append(requestId).Append("\r\n");
            header.Append("X-Qwen-Playback-Id: ").Append(playbackId).Append("\r\n");
            header.Append("X-Qwen-Stream-Mode: wav-transport-chunked\r\n");
            header.Append("X-Qwen-Backend-Incremental-Generation: false\r\n");
            header.Append("Trailer: X-Qwen-Stream-Status, X-Qwen-Stream-Error\r\n");
            header.Append("\r\n");
            byte[] bytes = Encoding.ASCII.GetBytes(header.ToString());
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }

        private static void WriteChunk(Stream output, byte[] buffer, int count)
        {
            byte[] prefix = Encoding.ASCII.GetBytes(count.ToString("X") + "\r\n");
            output.Write(prefix, 0, prefix.Length);
            output.Write(buffer, 0, count);
            byte[] suffix = Encoding.ASCII.GetBytes("\r\n");
            output.Write(suffix, 0, suffix.Length);
            output.Flush();
        }

        private static void WriteChunkedEnd(Stream output, string status, string error)
        {
            StringBuilder trailer = new StringBuilder();
            trailer.Append("0\r\n");
            trailer.Append("X-Qwen-Stream-Status: ").Append(SafeHeaderValue(status)).Append("\r\n");
            if (!string.IsNullOrEmpty(error))
            {
                trailer.Append("X-Qwen-Stream-Error: ").Append(SafeHeaderValue(error)).Append("\r\n");
            }
            trailer.Append("\r\n");
            byte[] bytes = Encoding.ASCII.GetBytes(trailer.ToString());
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }

        private static string SafeHeaderValue(string value)
        {
            if (string.IsNullOrEmpty(value)) { return string.Empty; }
            return value.Replace("\r", " ").Replace("\n", " ");
        }

        private static string Safe(string value)
        {
            if (string.IsNullOrEmpty(value)) { return string.Empty; }
            string oneLine = value.Replace("\r", " ").Replace("\n", " ");
            return oneLine.Length > 300 ? oneLine.Substring(0, 300) : oneLine;
        }
    }
}
