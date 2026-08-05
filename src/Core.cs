using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace QwenTrayGateway
{
    public sealed class GatewayConfig
    {
        public string GatewayHost { get; set; }
        public int GatewayPort { get; set; }
        public int BackendPort { get; set; }
        public string BackendExecutable { get; set; }
        public string ModelPath { get; set; }
        public string CodecPath { get; set; }
        public string ModelAlias { get; set; }
        public string Language { get; set; }
        public int IdleMinutes { get; set; }
        public bool AutoUnload { get; set; }
        public int BackendStartTimeoutSeconds { get; set; }
        public string VoiceReferenceWav { get; set; }
        public string VoiceName { get; set; }
        public string VoiceAlias { get; set; }
        public string ManagementToken { get; set; }
        public string LogDirectory { get; set; }

        public static GatewayConfig CreateDefaults(string runtimeDirectory)
        {
            GatewayConfig config = new GatewayConfig();
            config.GatewayHost = "127.0.0.1";
            config.GatewayPort = 7811;
            config.BackendPort = 7812;
            config.BackendExecutable = Path.Combine(runtimeDirectory, "bin", "tts-server.exe");
            config.ModelPath = Path.Combine(runtimeDirectory, "models", "qwen-talker-1.7b-base-Q8_0.gguf");
            config.CodecPath = Path.Combine(runtimeDirectory, "models", "qwen-tokenizer-12hz-Q8_0.gguf");
            config.ModelAlias = "qwen3-tts-1.7b-base";
            config.Language = "Chinese";
            config.IdleMinutes = 10;
            config.AutoUnload = true;
            config.BackendStartTimeoutSeconds = 60;
            config.VoiceReferenceWav = Path.Combine(runtimeDirectory, "voices", "邵思萌", "reference.wav");
            config.VoiceName = "邵思萌";
            config.VoiceAlias = "qwen-clone";
            config.ManagementToken = CreateToken();
            config.LogDirectory = Path.Combine(runtimeDirectory, "logs");
            return config;
        }

        public static GatewayConfig LoadOrCreate(string path)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            GatewayConfig config;
            if (File.Exists(path))
            {
                config = serializer.Deserialize<GatewayConfig>(File.ReadAllText(path, Encoding.UTF8));
            }
            else
            {
                config = CreateDefaults(Path.GetDirectoryName(Path.GetFullPath(path)));
                Save(path, config);
            }

            Validate(config);
            Directory.CreateDirectory(config.LogDirectory);
            return config;
        }

        public static void Save(string path, GatewayConfig config)
        {
            Validate(config);
            string directory = Path.GetDirectoryName(Path.GetFullPath(path));
            Directory.CreateDirectory(directory);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            File.WriteAllText(path, serializer.Serialize(config), new UTF8Encoding(false));
        }

        public static void Validate(GatewayConfig config)
        {
            if (config == null)
            {
                throw new InvalidDataException("Gateway configuration is empty.");
            }
            if (!string.Equals(config.GatewayHost, "127.0.0.1", StringComparison.Ordinal))
            {
                throw new InvalidDataException("GatewayHost must be 127.0.0.1.");
            }
            if (config.GatewayPort < 1 || config.GatewayPort > 65535 ||
                config.BackendPort < 1 || config.BackendPort > 65535 ||
                config.GatewayPort == config.BackendPort)
            {
                throw new InvalidDataException("Gateway and backend ports must be different valid ports.");
            }
            if (config.IdleMinutes < 1)
            {
                throw new InvalidDataException("IdleMinutes must be at least 1.");
            }
            if (config.BackendStartTimeoutSeconds < 5)
            {
                throw new InvalidDataException("BackendStartTimeoutSeconds must be at least 5.");
            }
            if (string.IsNullOrWhiteSpace(config.ManagementToken))
            {
                throw new InvalidDataException("ManagementToken is required.");
            }
        }

        private static string CreateToken()
        {
            byte[] bytes = new byte[32];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
    }

    public static class GatewayProtocol
    {
        public static bool RequiresBackend(string method, string path)
        {
            string normalizedMethod = (method ?? string.Empty).ToUpperInvariant();
            string normalizedPath = StripQuery(path);
            if (normalizedMethod == "OPTIONS")
            {
                return false;
            }
            if (normalizedMethod == "POST" && normalizedPath == "/v1/audio/speech")
            {
                return true;
            }
            if (normalizedMethod == "GET" &&
                (normalizedPath == "/v1/models" || normalizedPath == "/v1/audio/voices"))
            {
                return true;
            }
            if (normalizedMethod == "POST" && normalizedPath == "/v1/audio/voices")
            {
                return true;
            }
            return normalizedMethod == "DELETE" &&
                   normalizedPath.StartsWith("/v1/audio/voices/", StringComparison.Ordinal);
        }

        public static bool IsAuthorized(string expected, string provided)
        {
            if (string.IsNullOrEmpty(expected) || string.IsNullOrEmpty(provided))
            {
                return false;
            }
            byte[] left = Encoding.UTF8.GetBytes(expected);
            byte[] right = Encoding.UTF8.GetBytes(provided);
            int difference = left.Length ^ right.Length;
            int length = Math.Max(left.Length, right.Length);
            for (int index = 0; index < length; index++)
            {
                byte leftByte = index < left.Length ? left[index] : (byte)0;
                byte rightByte = index < right.Length ? right[index] : (byte)0;
                difference |= leftByte ^ rightByte;
            }
            return difference == 0;
        }

        public static bool IsTrustedBackendClient(string clientHeader)
        {
            return string.Equals(
                clientHeader,
                "qwen-reader-extension-v1",
                StringComparison.Ordinal);
        }

        public static string StripQuery(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return "/";
            }
            int query = path.IndexOf('?');
            return query < 0 ? path : path.Substring(0, query);
        }
    }

    public static class IdlePolicy
    {
        public static bool ShouldUnload(
            DateTime lastActivityUtc,
            DateTime nowUtc,
            bool enabled,
            int idleMinutes,
            int activeRequests,
            bool backendLoaded)
        {
            return enabled &&
                   backendLoaded &&
                   activeRequests == 0 &&
                   idleMinutes > 0 &&
                   nowUtc - lastActivityUtc >= TimeSpan.FromMinutes(idleMinutes);
        }
    }

    public static class PathSafety
    {
        public static bool SameExecutable(string left, string right)
        {
            if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right))
            {
                return false;
            }
            return string.Equals(
                Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
        }
    }

    public static class VoicePayloadBuilder
    {
        public static string BuildJson(string name, byte[] wav)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ArgumentException("Voice name is required.", "name");
            }
            if (wav == null || wav.Length == 0)
            {
                throw new ArgumentException("Voice reference WAV is empty.", "wav");
            }
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["name"] = name;
            payload["ref_text"] = string.Empty;
            payload["wav_b64"] = Convert.ToBase64String(wav);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = int.MaxValue;
            return serializer.Serialize(payload);
        }
    }

    public sealed class GatewayLogger
    {
        private readonly object sync = new object();
        private readonly string path;

        public GatewayLogger(string directory)
        {
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "gateway.log");
        }

        public void Write(string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine;
            lock (sync)
            {
                File.AppendAllText(path, line, new UTF8Encoding(false));
            }
        }
    }
}
