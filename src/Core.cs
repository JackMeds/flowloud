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
        public string ModelId { get; set; }
        public string Quantization { get; set; }
        public string Language { get; set; }
        public int IdleMinutes { get; set; }
        public bool AutoUnload { get; set; }
        public int BackendStartTimeoutSeconds { get; set; }
        // Limits apply to both the legacy buffered endpoint and the streaming endpoint.
        // They are intentionally conservative because the gateway is a loopback service
        // that owns a single GPU-backed backend process.
        public int MaxConcurrentRequests { get; set; }
        public int RequestTimeoutSeconds { get; set; }
        public int MaxStreamBytes { get; set; }
        public int StreamChunkBytes { get; set; }
        public string VoiceReferenceWav { get; set; }
        public string VoiceName { get; set; }
        public string VoiceAlias { get; set; }
        public string ManagementToken { get; set; }
        public string ClientToken { get; set; }
        public string LogDirectory { get; set; }

        public static GatewayConfig CreateDefaults(string runtimeDirectory)
        {
            GatewayConfig config = new GatewayConfig();
            config.GatewayHost = "127.0.0.1";
            config.GatewayPort = 7811;
            config.BackendPort = 7812;
            config.BackendExecutable = ResolvePath(runtimeDirectory, "FLOWLOUD_TTS_EXECUTABLE", Path.Combine("bin", "tts-server.exe"));
            config.ModelPath = ResolveModelFile(runtimeDirectory, "FLOWLOUD_TTS_MODEL", "qwen-talker-*.gguf", Path.Combine("models", "model.gguf"));
            config.CodecPath = ResolveModelFile(runtimeDirectory, "FLOWLOUD_TTS_CODEC", "qwen-tokenizer-*.gguf", Path.Combine("models", "codec.gguf"));
            config.ModelId = Environment.GetEnvironmentVariable("FLOWLOUD_TTS_MODEL_ID") ?? Path.GetFileNameWithoutExtension(config.ModelPath);
            config.Quantization = Environment.GetEnvironmentVariable("FLOWLOUD_TTS_QUANTIZATION") ?? GuessQuantization(config.ModelPath);
            config.ModelAlias = config.ModelId;
            config.Language = "Chinese";
            config.IdleMinutes = 10;
            config.AutoUnload = true;
            config.BackendStartTimeoutSeconds = 60;
            config.MaxConcurrentRequests = 2;
            config.RequestTimeoutSeconds = 120;
            config.MaxStreamBytes = 64 * 1024 * 1024;
            config.StreamChunkBytes = 32 * 1024;
            config.VoiceReferenceWav = ResolveReferenceAudio(runtimeDirectory);
            config.VoiceName = Environment.GetEnvironmentVariable("FLOWLOUD_TTS_VOICE_NAME") ?? VoiceNameFromPath(config.VoiceReferenceWav);
            config.VoiceAlias = Environment.GetEnvironmentVariable("FLOWLOUD_TTS_VOICE_ALIAS") ?? config.VoiceName;
            config.ManagementToken = CreateToken();
            config.ClientToken = CreateToken();
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

            bool upgradedClientToken = string.IsNullOrWhiteSpace(config.ClientToken);
            ApplyDefaults(config);
            Validate(config);
            if (upgradedClientToken) { Save(path, config); }
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
            if (config.MaxConcurrentRequests < 1 || config.MaxConcurrentRequests > 16)
            {
                throw new InvalidDataException("MaxConcurrentRequests must be between 1 and 16.");
            }
            if (config.RequestTimeoutSeconds < 5 || config.RequestTimeoutSeconds > 1800)
            {
                throw new InvalidDataException("RequestTimeoutSeconds must be between 5 and 1800.");
            }
            if (config.MaxStreamBytes < 1024 * 1024 || config.MaxStreamBytes > 512 * 1024 * 1024)
            {
                throw new InvalidDataException("MaxStreamBytes must be between 1 MiB and 512 MiB.");
            }
            if (config.StreamChunkBytes < 1024 || config.StreamChunkBytes > 1024 * 1024)
            {
                throw new InvalidDataException("StreamChunkBytes must be between 1 KiB and 1 MiB.");
            }
            if (string.IsNullOrWhiteSpace(config.ManagementToken))
            {
                throw new InvalidDataException("ManagementToken is required.");
            }
            if (string.IsNullOrWhiteSpace(config.ClientToken))
            {
                throw new InvalidDataException("ClientToken is required.");
            }
        }

        private static void ApplyDefaults(GatewayConfig config)
        {
            // gateway.json files created by older versions do not contain the streaming
            // fields. Treat zero as "not configured" so upgrades remain seamless.
            if (config.MaxConcurrentRequests <= 0) { config.MaxConcurrentRequests = 2; }
            if (config.RequestTimeoutSeconds <= 0) { config.RequestTimeoutSeconds = 120; }
            if (config.MaxStreamBytes <= 0) { config.MaxStreamBytes = 64 * 1024 * 1024; }
            if (config.StreamChunkBytes <= 0) { config.StreamChunkBytes = 32 * 1024; }
            if (string.IsNullOrWhiteSpace(config.ClientToken)) { config.ClientToken = CreateToken(); }
            if (string.IsNullOrWhiteSpace(config.ModelId)) { config.ModelId = config.ModelAlias; }
            if (string.IsNullOrWhiteSpace(config.ModelAlias)) { config.ModelAlias = config.ModelId; }
            if (string.IsNullOrWhiteSpace(config.Quantization)) { config.Quantization = GuessQuantization(config.ModelPath); }
        }

        private static string ResolvePath(string runtimeDirectory, string environmentName, string fallbackRelativePath)
        {
            string configured = Environment.GetEnvironmentVariable(environmentName);
            if (string.IsNullOrWhiteSpace(configured)) { return Path.Combine(runtimeDirectory, fallbackRelativePath); }
            return Path.IsPathRooted(configured) ? configured : Path.Combine(runtimeDirectory, configured);
        }

        private static string ResolveModelFile(string runtimeDirectory, string environmentName, string pattern, string fallbackRelativePath)
        {
            string configured = Environment.GetEnvironmentVariable(environmentName);
            if (!string.IsNullOrWhiteSpace(configured))
            {
                return Path.IsPathRooted(configured) ? configured : Path.Combine(runtimeDirectory, configured);
            }
            string modelDirectory = Path.Combine(runtimeDirectory, "models");
            if (Directory.Exists(modelDirectory))
            {
                string[] matches = Directory.GetFiles(modelDirectory, pattern, SearchOption.TopDirectoryOnly);
                Array.Sort(matches, StringComparer.OrdinalIgnoreCase);
                if (matches.Length > 0) { return matches[0]; }
            }
            return Path.Combine(runtimeDirectory, fallbackRelativePath);
        }

        private static string ResolveReferenceAudio(string runtimeDirectory)
        {
            string configured = Environment.GetEnvironmentVariable("FLOWLOUD_TTS_REFERENCE_AUDIO");
            if (!string.IsNullOrWhiteSpace(configured))
            {
                return Path.IsPathRooted(configured) ? configured : Path.Combine(runtimeDirectory, configured);
            }
            string voiceDirectory = Path.Combine(runtimeDirectory, "voices");
            if (Directory.Exists(voiceDirectory))
            {
                string[] matches = Directory.GetFiles(voiceDirectory, "*.wav", SearchOption.AllDirectories);
                Array.Sort(matches, StringComparer.OrdinalIgnoreCase);
                if (matches.Length > 0) { return matches[0]; }
            }
            return Path.Combine(runtimeDirectory, "voices", "reference.wav");
        }

        private static string VoiceNameFromPath(string referenceAudio)
        {
            string directory = Path.GetDirectoryName(referenceAudio);
            string name = string.IsNullOrWhiteSpace(directory) ? string.Empty : Path.GetFileName(directory);
            return string.IsNullOrWhiteSpace(name) || string.Equals(name, "voices", StringComparison.OrdinalIgnoreCase) ? "default" : name;
        }

        private static string GuessQuantization(string modelPath)
        {
            string name = Path.GetFileNameWithoutExtension(modelPath) ?? string.Empty;
            string[] parts = name.Split('-');
            if (parts.Length == 0) { return "auto"; }
            string candidate = parts[parts.Length - 1];
            return candidate.StartsWith("Q", StringComparison.OrdinalIgnoreCase) || candidate.StartsWith("F", StringComparison.OrdinalIgnoreCase) || candidate.StartsWith("BF", StringComparison.OrdinalIgnoreCase)
                ? candidate : "auto";
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
            if (normalizedMethod == "POST" && normalizedPath == "/v1/audio/speech/stream")
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

        public static bool IsSpeechStream(string method, string path)
        {
            return string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(StripQuery(path), "/v1/audio/speech/stream", StringComparison.Ordinal);
        }

        public static bool IsSpeechCancel(string method, string path)
        {
            return string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(StripQuery(path), "/v1/audio/speech/cancel", StringComparison.Ordinal);
        }

        public static bool IsSpeechStatus(string method, string path)
        {
            if (!string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            string normalizedPath = StripQuery(path);
            return normalizedPath.StartsWith("/v1/audio/speech/status/", StringComparison.Ordinal) &&
                   normalizedPath.Length > "/v1/audio/speech/status/".Length;
        }

        public static bool RequiresTrustedClient(string method, string path)
        {
            return RequiresBackend(method, path) || IsSpeechCancel(method, path) || IsSpeechStatus(method, path);
        }

        public static bool IsSafeRequestId(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 128)
            {
                return false;
            }
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if ((character >= 'a' && character <= 'z') ||
                    (character >= 'A' && character <= 'Z') ||
                    (character >= '0' && character <= '9') ||
                    character == '-' || character == '_' || character == '.' || character == ':')
                {
                    continue;
                }
                return false;
            }
            return true;
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

        public static string BearerToken(string authorization)
        {
            const string prefix = "Bearer ";
            if (string.IsNullOrWhiteSpace(authorization) ||
                !authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return string.Empty;
            }
            return authorization.Substring(prefix.Length).Trim();
        }

        public static bool IsTrustedExtensionOrigin(string origin)
        {
            if (string.IsNullOrEmpty(origin)) { return true; }
            Uri parsed;
            if (!Uri.TryCreate(origin, UriKind.Absolute, out parsed) ||
                !string.Equals(parsed.Scheme, "chrome-extension", StringComparison.OrdinalIgnoreCase) ||
                !string.IsNullOrEmpty(parsed.Query) || !string.IsNullOrEmpty(parsed.Fragment))
            {
                return false;
            }
            string host = parsed.Host;
            if (host.Length != 32) { return false; }
            for (int index = 0; index < host.Length; index++)
            {
                if (host[index] < 'a' || host[index] > 'p') { return false; }
            }
            return true;
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
