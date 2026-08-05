using System;
using System.IO;
using System.Reflection;
using System.Text;

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
        Run("executable path comparison is normalized", TestPathSafety);
        Run("HTTP parser preserves UTF-8 request body", TestHttpParser);
        Run("large voice reference serializes without truncation", TestLargeVoicePayload);
        Run("backend routes require the extension client header", TestBackendClientPolicy);
        Run("unauthenticated backend requests do not start the model", TestRejectedBackendRequest);
        Run("gateway responses never expose wildcard CORS", TestNoWildcardCors);
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
            if (!response.StartsWith("HTTP/1.1 403 Forbidden", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Missing client header did not return HTTP 403.");
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
