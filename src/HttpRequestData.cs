using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace QwenTrayGateway
{
    public sealed class HttpRequestData
    {
        public string Method { get; private set; }
        public string PathAndQuery { get; private set; }
        public string Version { get; private set; }
        public IDictionary<string, string> Headers { get; private set; }
        public byte[] Body { get; private set; }

        public static HttpRequestData Parse(byte[] raw)
        {
            if (raw == null)
            {
                throw new InvalidDataException("Request is empty.");
            }

            int headerEnd = FindHeaderEnd(raw);
            if (headerEnd < 0)
            {
                throw new InvalidDataException("HTTP headers are incomplete.");
            }

            string headerText = Encoding.ASCII.GetString(raw, 0, headerEnd);
            string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0)
            {
                throw new InvalidDataException("HTTP request line is missing.");
            }

            string[] requestLine = lines[0].Split(new[] { ' ' }, 3);
            if (requestLine.Length != 3)
            {
                throw new InvalidDataException("HTTP request line is invalid.");
            }

            Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 1; index < lines.Length; index++)
            {
                if (lines[index].Length == 0)
                {
                    continue;
                }
                int colon = lines[index].IndexOf(':');
                if (colon <= 0)
                {
                    throw new InvalidDataException("HTTP header is invalid.");
                }
                headers[lines[index].Substring(0, colon).Trim()] = lines[index].Substring(colon + 1).Trim();
            }

            int contentLength = 0;
            string contentLengthText;
            if (headers.TryGetValue("Content-Length", out contentLengthText) &&
                (!int.TryParse(contentLengthText, out contentLength) || contentLength < 0))
            {
                throw new InvalidDataException("Content-Length is invalid.");
            }
            if (headers.ContainsKey("Transfer-Encoding"))
            {
                throw new InvalidDataException("Chunked requests are not supported.");
            }

            int bodyOffset = headerEnd + 4;
            if (raw.Length - bodyOffset != contentLength)
            {
                throw new InvalidDataException("HTTP request body length does not match Content-Length.");
            }

            byte[] body = new byte[contentLength];
            if (contentLength > 0)
            {
                Buffer.BlockCopy(raw, bodyOffset, body, 0, contentLength);
            }

            HttpRequestData request = new HttpRequestData();
            request.Method = requestLine[0].ToUpperInvariant();
            request.PathAndQuery = requestLine[1];
            request.Version = requestLine[2];
            request.Headers = headers;
            request.Body = body;
            return request;
        }

        public static HttpRequestData ReadFrom(Stream stream)
        {
            MemoryStream buffer = new MemoryStream();
            int state = 0;
            while (buffer.Length < 65536)
            {
                int value = stream.ReadByte();
                if (value < 0)
                {
                    throw new EndOfStreamException("Connection closed before HTTP headers completed.");
                }
                buffer.WriteByte((byte)value);
                state = NextHeaderState(state, (byte)value);
                if (state == 4)
                {
                    break;
                }
            }
            if (state != 4)
            {
                throw new InvalidDataException("HTTP headers exceed 64 KiB.");
            }

            byte[] headerBytes = buffer.ToArray();
            string headerText = Encoding.ASCII.GetString(headerBytes);
            int contentLength = ReadContentLength(headerText);
            if (contentLength > 16 * 1024 * 1024)
            {
                throw new InvalidDataException("HTTP request body exceeds 16 MiB.");
            }
            for (int index = 0; index < contentLength; index++)
            {
                int value = stream.ReadByte();
                if (value < 0)
                {
                    throw new EndOfStreamException("Connection closed before request body completed.");
                }
                buffer.WriteByte((byte)value);
            }
            return Parse(buffer.ToArray());
        }

        public string Header(string name)
        {
            string value;
            return Headers.TryGetValue(name, out value) ? value : null;
        }

        private static int FindHeaderEnd(byte[] bytes)
        {
            for (int index = 0; index <= bytes.Length - 4; index++)
            {
                if (bytes[index] == 13 && bytes[index + 1] == 10 &&
                    bytes[index + 2] == 13 && bytes[index + 3] == 10)
                {
                    return index;
                }
            }
            return -1;
        }

        private static int NextHeaderState(int state, byte value)
        {
            byte[] target = { 13, 10, 13, 10 };
            if (value == target[state])
            {
                return state + 1;
            }
            return value == 13 ? 1 : 0;
        }

        private static int ReadContentLength(string headerText)
        {
            string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            foreach (string line in lines)
            {
                int colon = line.IndexOf(':');
                if (colon > 0 && string.Equals(line.Substring(0, colon).Trim(), "Content-Length", StringComparison.OrdinalIgnoreCase))
                {
                    int result;
                    if (!int.TryParse(line.Substring(colon + 1).Trim(), out result) || result < 0)
                    {
                        throw new InvalidDataException("Content-Length is invalid.");
                    }
                    return result;
                }
            }
            return 0;
        }
    }
}
