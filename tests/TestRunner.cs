using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;

internal static class TestRunner
{
    private static int failures;
    private static Assembly gatewayAssembly;

    private static void Main(string[] args)
    {
        if (args.Length != 1)
        {
            Fail("usage", "Expected the gateway executable path.");
            Finish();
            return;
        }

        if (!File.Exists(args[0]))
        {
            Fail("gateway assembly exists", "Gateway executable is missing: " + args[0]);
            Finish();
            return;
        }

        gatewayAssembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
        Run("default config is loopback and idle", TestDefaultConfig);
        Run("backend trigger routing is exact", TestBackendRouting);
        Run("idle policy respects requests and setting", TestIdlePolicy);
        Run("management token is required", TestManagementToken);
        Run("extension origin and bearer token are validated", TestClientAuthentication);
        Run("executable path comparison is normalized", TestPathSafety);
        Run("HTTP parser preserves UTF-8 request body", TestHttpParser);
        Run("large voice reference serializes without truncation", TestLargeVoicePayload);
        Run("backend routes require the extension client header", TestBackendClientPolicy);
        Run("unauthenticated backend requests do not start the model", TestRejectedBackendRequest);
        Run("gateway responses never expose wildcard CORS", TestNoWildcardCors);
        Run("streaming protocol advertises truthful capabilities", TestStreamingProtocol);
        Run("stream registry supports cancellation and status", TestSpeechStreamRegistry);
        Run("gateway rejects cross-session ID pairs", TestMismatchedIdsRejectedByGateway);
        Run("chunked audio framing is standard HTTP/1.1", TestChunkedFraming);
        Run("stream proxy maps gateway endpoint to legacy backend", TestTransportStreamProxy);
        Run("streaming IDs reject header injection", TestStreamingIds);
        Run("health exposes stream limits and backend mode", TestHealthCapabilities);
        Finish();
    }

    private static void Run(string name, Action test)
    {
        try
        {
            test();
            Console.WriteLine("PASS " + name);
        }
        catch (Exception ex)
        {
            Fail(name, Unwrap(ex).Message);
        }
    }

    private static void TestDefaultConfig()
    {
        Type type = RequiredType("QwenTrayGateway.GatewayConfig");
        object config = type.GetMethod("CreateDefaults").Invoke(null, new object[] { @"C:\runtime" });
        Equal("127.0.0.1", Property(config, "GatewayHost"), "GatewayHost");
        Equal(7811, Property(config, "GatewayPort"), "GatewayPort");
        Equal(7812, Property(config, "BackendPort"), "BackendPort");
        Equal(10, Property(config, "IdleMinutes"), "IdleMinutes");
        Equal(true, Property(config, "AutoUnload"), "AutoUnload");
    }

    private static void TestBackendRouting()
    {
        Type type = RequiredType("QwenTrayGateway.GatewayProtocol");
        MethodInfo method = type.GetMethod("RequiresBackend");
        Equal(true, method.Invoke(null, new object[] { "POST", "/v1/audio/speech" }), "speech");
        Equal(true, method.Invoke(null, new object[] { "GET", "/v1/audio/voices" }), "voices");
        Equal(true, method.Invoke(null, new object[] { "DELETE", "/v1/audio/voices/test" }), "delete voice");
        Equal(false, method.Invoke(null, new object[] { "GET", "/health" }), "health");
        Equal(false, method.Invoke(null, new object[] { "OPTIONS", "/v1/audio/speech" }), "preflight");
        Equal(false, method.Invoke(null, new object[] { "POST", "/gateway/exit" }), "management");
        Equal(false, method.Invoke(null, new object[] { "POST", "/not-v1/audio/speech" }), "lookalike path");
    }

    private static void TestIdlePolicy()
    {
        Type type = RequiredType("QwenTrayGateway.IdlePolicy");
        MethodInfo method = type.GetMethod("ShouldUnload");
        DateTime now = new DateTime(2026, 7, 30, 12, 20, 0, DateTimeKind.Utc);
        DateTime old = now.AddMinutes(-11);
        object[] baseline = { old, now, true, 10, 0, true };
        Equal(true, method.Invoke(null, baseline), "expired idle backend");
        Equal(false, method.Invoke(null, new object[] { old, now, true, 10, 1, true }), "active request");
        Equal(false, method.Invoke(null, new object[] { old, now, false, 10, 0, true }), "disabled");
        Equal(false, method.Invoke(null, new object[] { old, now, true, 10, 0, false }), "not loaded");
        Equal(false, method.Invoke(null, new object[] { now.AddMinutes(-9), now, true, 10, 0, true }), "not expired");
    }

    private static void TestManagementToken()
    {
        Type type = RequiredType("QwenTrayGateway.GatewayProtocol");
        MethodInfo method = type.GetMethod("IsAuthorized");
        Equal(true, method.Invoke(null, new object[] { "secret-token", "secret-token" }), "matching token");
        Equal(false, method.Invoke(null, new object[] { "secret-token", "" }), "missing token");
        Equal(false, method.Invoke(null, new object[] { "secret-token", "secret-tokeN" }), "different token");
    }

    private static void TestClientAuthentication()
    {
        Type type = RequiredType("QwenTrayGateway.GatewayProtocol");
        MethodInfo bearer = type.GetMethod("BearerToken");
        MethodInfo origin = type.GetMethod("IsTrustedExtensionOrigin");
        Equal("secret-token", bearer.Invoke(null, new object[] { "Bearer secret-token" }), "bearer token");
        Equal("secret-token", bearer.Invoke(null, new object[] { "bearer secret-token" }), "case-insensitive bearer scheme");
        Equal("", bearer.Invoke(null, new object[] { "Basic secret-token" }), "wrong authorization scheme");
        Equal(true, origin.Invoke(null, new object[] { null }), "extension request without Origin");
        Equal(true, origin.Invoke(null, new object[] { "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }), "valid extension origin");
        Equal(false, origin.Invoke(null, new object[] { "https://example.com" }), "web origin rejected");
        Equal(false, origin.Invoke(null, new object[] { "chrome-extension://invalid" }), "invalid extension id rejected");
    }

    private static void TestPathSafety()
    {
        Type type = RequiredType("QwenTrayGateway.PathSafety");
        MethodInfo method = type.GetMethod("SameExecutable");
        string left = Path.Combine(Path.GetTempPath(), "Qwen", "..", "Qwen", "tts-server.exe");
        string right = Path.Combine(Path.GetTempPath(), "Qwen", "tts-server.exe");
        Equal(true, method.Invoke(null, new object[] { left, right }), "normalized same path");
        Equal(false, method.Invoke(null, new object[] { left, right + ".other" }), "different path");
    }

    private static void TestHttpParser()
    {
        Type type = RequiredType("QwenTrayGateway.HttpRequestData");
        MethodInfo method = type.GetMethod("Parse");
        byte[] body = Encoding.UTF8.GetBytes("{\"input\":\"你好，邵思萌\"}");
        byte[] head = Encoding.ASCII.GetBytes(
            "POST /v1/audio/speech HTTP/1.1\r\n" +
            "Host: 127.0.0.1:7811\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: " + body.Length + "\r\n\r\n");
        byte[] raw = new byte[head.Length + body.Length];
        Buffer.BlockCopy(head, 0, raw, 0, head.Length);
        Buffer.BlockCopy(body, 0, raw, head.Length, body.Length);

        object parsed = method.Invoke(null, new object[] { raw });
        Equal("POST", Property(parsed, "Method"), "method");
        Equal("/v1/audio/speech", Property(parsed, "PathAndQuery"), "path");
        byte[] parsedBody = (byte[])Property(parsed, "Body");
        Equal(Encoding.UTF8.GetString(body), Encoding.UTF8.GetString(parsedBody), "UTF-8 body");
    }

    private static void TestLargeVoicePayload()
    {
        Type type = RequiredType("QwenTrayGateway.VoicePayloadBuilder");
        MethodInfo method = type.GetMethod("BuildJson");
        byte[] wav = new byte[1764044];
        wav[0] = (byte)'R';
        wav[1] = (byte)'I';
        wav[2] = (byte)'F';
        wav[3] = (byte)'F';
        string json = (string)method.Invoke(null, new object[] { "邵思萌", wav });
        if (json.Length < 2300000)
        {
            throw new InvalidOperationException("Serialized voice payload is unexpectedly short: " + json.Length);
        }
        if (!json.Contains("wav_b64") || !json.Contains("邵思萌"))
        {
            throw new InvalidOperationException("Serialized voice payload lost required fields.");
        }
    }

    private static void TestBackendClientPolicy()
    {
        Type type = RequiredType("QwenTrayGateway.GatewayProtocol");
        MethodInfo method = type.GetMethod("IsTrustedBackendClient");
        if (method == null)
        {
            throw new InvalidOperationException("Missing GatewayProtocol.IsTrustedBackendClient");
        }
        Equal(true, method.Invoke(null, new object[] { "qwen-reader-extension-v1" }), "extension client header");
        Equal(false, method.Invoke(null, new object[] { null }), "missing client header");
        Equal(false, method.Invoke(null, new object[] { "" }), "empty client header");
        Equal(false, method.Invoke(null, new object[] { "qwen-reader-extension-v2" }), "unknown client header");
    }

    private static void TestRejectedBackendRequest()
    {
        string temp = Path.Combine(Path.GetTempPath(), "QwenGatewayTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        Type configType = RequiredType("QwenTrayGateway.GatewayConfig");
        object config = configType.GetMethod("CreateDefaults").Invoke(null, new object[] { temp });
        Type loggerType = RequiredType("QwenTrayGateway.GatewayLogger");
        object logger = Activator.CreateInstance(loggerType, new object[] { temp });
        Type backendType = RequiredType("QwenTrayGateway.BackendController");
        object backend = Activator.CreateInstance(backendType, new object[] { config, logger });
        Type gatewayType = RequiredType("QwenTrayGateway.TcpGateway");
        object gateway = Activator.CreateInstance(gatewayType, new object[] { config, backend, logger });
        Type requestType = RequiredType("QwenTrayGateway.HttpRequestData");
        object request = requestType.GetMethod("Parse").Invoke(null, new object[] {
            Encoding.ASCII.GetBytes(
                "GET /v1/audio/voices HTTP/1.1\r\n" +
                "Host: 127.0.0.1:7811\r\n" +
                "Content-Length: 0\r\n\r\n")
        });
        using (MemoryStream output = new MemoryStream())
        {
            gatewayType.GetMethod("Dispatch", BindingFlags.Instance | BindingFlags.NonPublic)
                .Invoke(gateway, new object[] { request, output });
            string response = Encoding.ASCII.GetString(output.ToArray());
            if (!response.StartsWith("HTTP/1.1 401 Unauthorized", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Missing client authentication did not return HTTP 401.");
            }
        }
        Equal("unloaded", Property(backend, "State"), "backend remains unloaded");
        ((IDisposable)gateway).Dispose();
        ((IDisposable)backend).Dispose();
    }

    private static void TestNoWildcardCors()
    {
        Type type = RequiredType("QwenTrayGateway.TcpGateway");
        MethodInfo method = type.GetMethod(
            "WriteResponse",
            BindingFlags.Static | BindingFlags.NonPublic);
        if (method == null)
        {
            throw new InvalidOperationException("Missing TcpGateway.WriteResponse");
        }
        using (MemoryStream output = new MemoryStream())
        {
            method.Invoke(null, new object[] {
                output,
                200,
                "OK",
                "application/json",
                Encoding.UTF8.GetBytes("{}"),
                null
            });
            string response = Encoding.ASCII.GetString(output.ToArray());
            if (response.IndexOf("Access-Control-Allow-Origin", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                throw new InvalidOperationException("Response contains a cross-origin access grant.");
            }
        }
    }

    private static void TestStreamingProtocol()
    {
        Type type = RequiredType("QwenTrayGateway.GatewayProtocol");
        MethodInfo requiresBackend = type.GetMethod("RequiresBackend");
        MethodInfo trusted = type.GetMethod("RequiresTrustedClient");
        MethodInfo stream = type.GetMethod("IsSpeechStream");
        MethodInfo cancel = type.GetMethod("IsSpeechCancel");
        MethodInfo status = type.GetMethod("IsSpeechStatus");
        Equal(true, requiresBackend.Invoke(null, new object[] { "POST", "/v1/audio/speech/stream" }), "stream backend route");
        Equal(true, trusted.Invoke(null, new object[] { "POST", "/v1/audio/speech/stream" }), "stream trusted route");
        Equal(true, stream.Invoke(null, new object[] { "POST", "/v1/audio/speech/stream?x=1" }), "stream endpoint");
        Equal(true, cancel.Invoke(null, new object[] { "POST", "/v1/audio/speech/cancel" }), "cancel endpoint");
        Equal(true, status.Invoke(null, new object[] { "GET", "/v1/audio/speech/status/request-1" }), "status endpoint");
        Equal(false, requiresBackend.Invoke(null, new object[] { "POST", "/v1/audio/speech/cancel" }), "cancel does not load backend");
    }

    private static void TestSpeechStreamRegistry()
    {
        Type registryType = RequiredType("QwenTrayGateway.SpeechStreamRegistry");
        Type sessionType = RequiredType("QwenTrayGateway.SpeechStreamSession");
        object registry = Activator.CreateInstance(registryType);
        object session = Activator.CreateInstance(sessionType, new object[] { "req-1", "play-1" });
        Equal(true, registryType.GetMethod("TryRegister").Invoke(registry, new object[] { session }), "register");
        object duplicate = Activator.CreateInstance(sessionType, new object[] { "req-1", "play-2" });
        Equal(false, registryType.GetMethod("TryRegister").Invoke(registry, new object[] { duplicate }), "duplicate request ID");
        object second = Activator.CreateInstance(sessionType, new object[] { "req-2", "play-2" });
        Equal(true, registryType.GetMethod("TryRegister").Invoke(registry, new object[] { second }), "register second session");
        Equal(null, registryType.GetMethod("FindActive").Invoke(registry, new object[] { "req-1", "play-2" }), "mismatched active pair");
        Equal(false, registryType.GetMethod("Cancel").Invoke(registry, new object[] { "req-1", "play-2" }), "reject mismatched cancellation pair");
        Equal(false, Property(session, "IsCancellationRequested"), "first session remains active after mismatch");
        Equal(false, Property(second, "IsCancellationRequested"), "second session remains active after mismatch");
        Equal(null, registryType.GetMethod("FindByIds").Invoke(registry, new object[] { "req-1", "play-2" }), "mismatched status pair");
        object pairedSnapshot = registryType.GetMethod("FindByIds").Invoke(registry, new object[] { "req-1", "play-1" });
        Equal("req-1", Property(pairedSnapshot, "RequestId"), "matched status pair");
        Equal(true, registryType.GetMethod("Cancel").Invoke(registry, new object[] { "", "play-1" }), "cancel by playback ID");
        Equal(true, Property(session, "IsCancellationRequested"), "session cancellation flag");
        sessionType.GetMethod("AddBytes").Invoke(session, new object[] { 7 });
        registryType.GetMethod("Complete").Invoke(registry, new object[] { session, "cancelled", "client_cancelled" });
        object snapshot = registryType.GetMethod("Find").Invoke(registry, new object[] { "req-1" });
        Equal("cancelled", Property(snapshot, "State"), "cancelled status");
        Equal(7L, Property(snapshot, "Bytes"), "stream byte count");
        Equal("client_cancelled", Property(snapshot, "Error"), "stream error");
    }

    private static void TestChunkedFraming()
    {
        Type type = RequiredType("QwenTrayGateway.TcpGateway");
        MethodInfo headers = type.GetMethod("WriteChunkedHeaders", BindingFlags.Static | BindingFlags.NonPublic);
        MethodInfo chunk = type.GetMethod("WriteChunk", BindingFlags.Static | BindingFlags.NonPublic);
        MethodInfo end = type.GetMethod("WriteChunkedEnd", BindingFlags.Static | BindingFlags.NonPublic);
        if (headers == null || chunk == null || end == null) { throw new InvalidOperationException("Missing chunked writer."); }
        using (MemoryStream output = new MemoryStream())
        {
            headers.Invoke(null, new object[] { output, "audio/wav", "req-1", "play-1" });
            chunk.Invoke(null, new object[] { output, Encoding.ASCII.GetBytes("abc"), 3 });
            end.Invoke(null, new object[] { output, "completed", "" });
            string response = Encoding.ASCII.GetString(output.ToArray());
            if (response.IndexOf("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase) < 0 ||
                response.IndexOf("X-Qwen-Backend-Incremental-Generation: false", StringComparison.OrdinalIgnoreCase) < 0 ||
                response.IndexOf("\r\n3\r\nabc\r\n0\r\nX-Qwen-Stream-Status: completed\r\n\r\n", StringComparison.Ordinal) < 0)
            {
                throw new InvalidOperationException("Chunked framing or truthful stream metadata is missing.");
            }
        }
    }

    private static void TestMismatchedIdsRejectedByGateway()
    {
        string temp = Path.Combine(Path.GetTempPath(), "QwenGatewayIdPairTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        Type configType = RequiredType("QwenTrayGateway.GatewayConfig");
        object config = configType.GetMethod("CreateDefaults").Invoke(null, new object[] { temp });
        configType.GetProperty("ClientToken").SetValue(config, "test-client-token", null);
        Type loggerType = RequiredType("QwenTrayGateway.GatewayLogger");
        object logger = Activator.CreateInstance(loggerType, new object[] { temp });
        Type backendType = RequiredType("QwenTrayGateway.BackendController");
        object backend = Activator.CreateInstance(backendType, new object[] { config, logger });
        Type gatewayType = RequiredType("QwenTrayGateway.TcpGateway");
        object gateway = Activator.CreateInstance(gatewayType, new object[] { config, backend, logger });
        object registry = gatewayType.GetField("speechStreams", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(gateway);
        Type registryType = RequiredType("QwenTrayGateway.SpeechStreamRegistry");
        Type sessionType = RequiredType("QwenTrayGateway.SpeechStreamSession");
        object first = Activator.CreateInstance(sessionType, new object[] { "req-a", "play-a" });
        object second = Activator.CreateInstance(sessionType, new object[] { "req-b", "play-b" });
        registryType.GetMethod("TryRegister").Invoke(registry, new object[] { first });
        registryType.GetMethod("TryRegister").Invoke(registry, new object[] { second });

        Type requestType = RequiredType("QwenTrayGateway.HttpRequestData");
        MethodInfo dispatch = gatewayType.GetMethod("Dispatch", BindingFlags.Instance | BindingFlags.NonPublic);
        byte[] cancelBody = Encoding.UTF8.GetBytes("{\"request_id\":\"req-a\",\"playback_id\":\"play-b\"}");
        byte[] cancelHead = Encoding.ASCII.GetBytes(
            "POST /v1/audio/speech/cancel HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "X-Qwen-Reader-Client: qwen-reader-extension-v1\r\n" +
            "Authorization: Bearer test-client-token\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: " + cancelBody.Length + "\r\n\r\n");
        byte[] cancelRaw = new byte[cancelHead.Length + cancelBody.Length];
        Buffer.BlockCopy(cancelHead, 0, cancelRaw, 0, cancelHead.Length);
        Buffer.BlockCopy(cancelBody, 0, cancelRaw, cancelHead.Length, cancelBody.Length);
        object cancelRequest = requestType.GetMethod("Parse").Invoke(null, new object[] { cancelRaw });
        using (MemoryStream cancelOutput = new MemoryStream())
        {
            dispatch.Invoke(gateway, new object[] { cancelRequest, cancelOutput });
            string response = Encoding.UTF8.GetString(cancelOutput.ToArray());
            if (!response.StartsWith("HTTP/1.1 409 Conflict", StringComparison.Ordinal) ||
                response.IndexOf("request_id_mismatch", StringComparison.Ordinal) < 0)
            {
                throw new InvalidOperationException("Cross-session cancellation did not return an explicit mismatch.");
            }
        }
        Equal(false, Property(first, "IsCancellationRequested"), "first cross-session cancel safety");
        Equal(false, Property(second, "IsCancellationRequested"), "second cross-session cancel safety");

        object statusRequest = requestType.GetMethod("Parse").Invoke(null, new object[] {
            Encoding.ASCII.GetBytes(
                "GET /v1/audio/speech/status/req-a HTTP/1.1\r\n" +
                "Host: 127.0.0.1\r\n" +
                "X-Qwen-Reader-Client: qwen-reader-extension-v1\r\n" +
                "Authorization: Bearer test-client-token\r\n" +
                "X-Qwen-Request-Id: req-a\r\n" +
                "X-Qwen-Playback-Id: play-b\r\n" +
                "Content-Length: 0\r\n\r\n")
        });
        using (MemoryStream statusOutput = new MemoryStream())
        {
            dispatch.Invoke(gateway, new object[] { statusRequest, statusOutput });
            string response = Encoding.UTF8.GetString(statusOutput.ToArray());
            if (!response.StartsWith("HTTP/1.1 409 Conflict", StringComparison.Ordinal) ||
                response.IndexOf("request_id_mismatch", StringComparison.Ordinal) < 0)
            {
                throw new InvalidOperationException("Cross-session status lookup did not return an explicit mismatch.");
            }
        }
        ((IDisposable)gateway).Dispose();
        ((IDisposable)backend).Dispose();
    }

    private static void TestStreamingIds()
    {
        Type type = RequiredType("QwenTrayGateway.GatewayProtocol");
        MethodInfo safe = type.GetMethod("IsSafeRequestId");
        Equal(true, safe.Invoke(null, new object[] { "request-1.playback_2:3" }), "safe ID");
        Equal(false, safe.Invoke(null, new object[] { "request\r\nX-Evil: 1" }), "header injection");
        Equal(false, safe.Invoke(null, new object[] { "../request" }), "path traversal marker");
        Equal(false, safe.Invoke(null, new object[] { new string('a', 129) }), "oversized ID");
    }

    private static void TestTransportStreamProxy()
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        string observedRequestLine = string.Empty;
        Exception serverError = null;
        Thread server = new Thread(new ThreadStart(delegate
        {
            try
            {
                for (int requestIndex = 0; requestIndex < 2; requestIndex++)
                {
                    using (TcpClient client = listener.AcceptTcpClient())
                    using (NetworkStream input = client.GetStream())
                    {
                        MemoryStream request = new MemoryStream();
                        int state = 0;
                        while (state != 4)
                        {
                            int value = input.ReadByte();
                            if (value < 0) { throw new EndOfStreamException("fake backend request ended early"); }
                            request.WriteByte((byte)value);
                            byte[] target = { 13, 10, 13, 10 };
                            state = value == target[state] ? state + 1 : (value == 13 ? 1 : 0);
                        }
                        string header = Encoding.ASCII.GetString(request.ToArray());
                        if (requestIndex == 0)
                        {
                            observedRequestLine = header.Split(new[] { "\r\n" }, StringSplitOptions.None)[0];
                        }
                        byte[] response = Encoding.ASCII.GetBytes(
                            "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: audio/wav\r\n" +
                            "Content-Length: 7\r\n" +
                            "Connection: close\r\n\r\nFAKEAUD");
                        input.Write(response, 0, response.Length);
                        input.Flush();
                    }
                }
            }
            catch (Exception ex)
            {
                serverError = ex;
            }
        }));
        server.IsBackground = true;
        server.Start();

        string temp = Path.Combine(Path.GetTempPath(), "QwenGatewayStreamProxy-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        Type configType = RequiredType("QwenTrayGateway.GatewayConfig");
        object config = configType.GetMethod("CreateDefaults").Invoke(null, new object[] { temp });
        configType.GetProperty("BackendPort").SetValue(config, port, null);
        Type loggerType = RequiredType("QwenTrayGateway.GatewayLogger");
        object logger = Activator.CreateInstance(loggerType, new object[] { temp });
        Type backendType = RequiredType("QwenTrayGateway.BackendController");
        object backend = Activator.CreateInstance(backendType, new object[] { config, logger });
        Type gatewayType = RequiredType("QwenTrayGateway.TcpGateway");
        object gateway = Activator.CreateInstance(gatewayType, new object[] { config, backend, logger });
        Type requestType = RequiredType("QwenTrayGateway.HttpRequestData");
        byte[] body = Encoding.UTF8.GetBytes("{\"input\":\"hello\"}");
        byte[] head = Encoding.ASCII.GetBytes(
            "POST /v1/audio/speech/stream HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: " + body.Length + "\r\n\r\n");
        byte[] raw = new byte[head.Length + body.Length];
        Buffer.BlockCopy(head, 0, raw, 0, head.Length);
        Buffer.BlockCopy(body, 0, raw, head.Length, body.Length);
        object parsed = requestType.GetMethod("Parse").Invoke(null, new object[] { raw });
        Type sessionType = RequiredType("QwenTrayGateway.SpeechStreamSession");
        object session = Activator.CreateInstance(sessionType, new object[] { "req-proxy", "play-proxy" });
        using (MemoryStream output = new MemoryStream())
        {
            try
            {
                gatewayType.GetMethod("ProxyStream", BindingFlags.Instance | BindingFlags.NonPublic)
                    .Invoke(gateway, new object[] { parsed, output, session });
            }
            catch (TargetInvocationException ex)
            {
                throw Unwrap(ex);
            }
            string responseText = Encoding.ASCII.GetString(output.ToArray());
            if (observedRequestLine != "POST /v1/audio/speech HTTP/1.1")
            {
                throw new InvalidOperationException("Streaming gateway path was not mapped to legacy backend path: " + observedRequestLine);
            }
            if (responseText.IndexOf("\r\n7\r\nFAKEAUD\r\n0\r\nX-Qwen-Stream-Status: completed\r\n\r\n", StringComparison.Ordinal) < 0)
            {
                throw new InvalidOperationException("Proxy did not emit the complete chunked WAV response.");
            }
        }
        object disconnectedSession = Activator.CreateInstance(sessionType, new object[] { "req-disconnect", "play-disconnect" });
        using (DisconnectingOutputStream disconnectedOutput = new DisconnectingOutputStream())
        {
            try
            {
                gatewayType.GetMethod("ProxyStream", BindingFlags.Instance | BindingFlags.NonPublic)
                    .Invoke(gateway, new object[] { parsed, disconnectedOutput, disconnectedSession });
            }
            catch (TargetInvocationException ex)
            {
                throw Unwrap(ex);
            }
        }
        Equal(true, Property(disconnectedSession, "IsCancellationRequested"), "client disconnect cancellation flag");
        int abortCount = (int)Property(disconnectedSession, "BackendAbortCount");
        if (abortCount < 1)
        {
            throw new InvalidOperationException("Client disconnect did not call HttpWebRequest.Abort().");
        }
        server.Join(5000);
        listener.Stop();
        if (serverError != null) { throw serverError; }
        ((IDisposable)gateway).Dispose();
        ((IDisposable)backend).Dispose();
    }

    private sealed class DisconnectingOutputStream : Stream
    {
        private bool headersWritten;

        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position
        {
            get { throw new NotSupportedException(); }
            set { throw new NotSupportedException(); }
        }

        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }

        public override void Write(byte[] buffer, int offset, int count)
        {
            if (headersWritten) { throw new IOException("simulated client disconnect"); }
            string text = Encoding.ASCII.GetString(buffer, offset, count);
            if (text.IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0)
            {
                headersWritten = true;
            }
        }
    }

    private static void TestHealthCapabilities()
    {
        string temp = Path.Combine(Path.GetTempPath(), "QwenGatewayHealthTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        Type configType = RequiredType("QwenTrayGateway.GatewayConfig");
        object config = configType.GetMethod("CreateDefaults").Invoke(null, new object[] { temp });
        Type loggerType = RequiredType("QwenTrayGateway.GatewayLogger");
        object logger = Activator.CreateInstance(loggerType, new object[] { temp });
        Type backendType = RequiredType("QwenTrayGateway.BackendController");
        object backend = Activator.CreateInstance(backendType, new object[] { config, logger });
        Type gatewayType = RequiredType("QwenTrayGateway.TcpGateway");
        object gateway = Activator.CreateInstance(gatewayType, new object[] { config, backend, logger });
        string json = (string)gatewayType.GetMethod("BuildStatusJson").Invoke(gateway, null);
        if (json.IndexOf("transportStreaming", StringComparison.Ordinal) < 0 ||
            json.IndexOf("backendIncrementalGeneration", StringComparison.Ordinal) < 0 ||
            json.IndexOf("\"cancel\":true", StringComparison.Ordinal) < 0 ||
            json.IndexOf("maxConcurrentRequests", StringComparison.Ordinal) < 0 ||
            json.IndexOf("\"protocolVersion\":3", StringComparison.Ordinal) < 0 ||
            json.IndexOf("ClientToken", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            throw new InvalidOperationException("Health capabilities are incomplete.");
        }
        ((IDisposable)gateway).Dispose();
        ((IDisposable)backend).Dispose();
    }

    private static Type RequiredType(string name)
    {
        Type type = gatewayAssembly.GetType(name, false);
        if (type == null)
        {
            throw new InvalidOperationException("Missing type " + name);
        }
        return type;
    }

    private static object Property(object instance, string name)
    {
        PropertyInfo property = instance.GetType().GetProperty(name);
        if (property == null)
        {
            throw new InvalidOperationException("Missing property " + instance.GetType().FullName + "." + name);
        }
        return property.GetValue(instance, null);
    }

    private static void Equal(object expected, object actual, string label)
    {
        if (!object.Equals(expected, actual))
        {
            throw new InvalidOperationException(
                label + ": expected <" + expected + "> but got <" + actual + ">.");
        }
    }

    private static Exception Unwrap(Exception ex)
    {
        while (ex is TargetInvocationException && ex.InnerException != null)
        {
            ex = ex.InnerException;
        }
        return ex;
    }

    private static void Fail(string name, string message)
    {
        failures++;
        Console.Error.WriteLine("FAIL " + name + ": " + message);
    }

    private static void Finish()
    {
        Console.WriteLine("RESULT " + (failures == 0 ? "PASS" : "FAIL") + " failures=" + failures);
        Environment.ExitCode = failures == 0 ? 0 : 1;
    }
}
