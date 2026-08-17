using System;
using System.Collections.Generic;
using System.Net;
using System.Threading;

namespace QwenTrayGateway
{
    public sealed class SpeechRequestIdException : Exception
    {
        public SpeechRequestIdException(string message) : base(message) { }
    }

    // A stream session is deliberately independent of the HTTP connection.  This lets a
    // second loopback request cancel a long-running backend request by ID.
    public sealed class SpeechStreamSession
    {
        private readonly object sync = new object();
        private HttpWebRequest backendRequest;
        private int cancellationRequested;
        private int backendAbortCount;
        private long bytesSent;
        private string state = "active";
        private string error = string.Empty;
        private DateTime finishedUtc;

        public SpeechStreamSession(string requestId, string playbackId)
        {
            RequestId = requestId;
            PlaybackId = playbackId;
            CreatedUtc = DateTime.UtcNow;
        }

        public string RequestId { get; private set; }
        public string PlaybackId { get; private set; }
        public DateTime CreatedUtc { get; private set; }
        public bool ResponseStarted { get; set; }
        public bool IsCancellationRequested
        {
            get { return Interlocked.CompareExchange(ref cancellationRequested, 0, 0) != 0; }
        }
        public long BytesSent { get { return Interlocked.Read(ref bytesSent); } }
        public int BackendAbortCount { get { return Interlocked.CompareExchange(ref backendAbortCount, 0, 0); } }
        public string State { get { lock (sync) { return state; } } }
        public string Error { get { lock (sync) { return error; } } }
        public DateTime FinishedUtc { get { lock (sync) { return finishedUtc; } } }

        public void AttachBackendRequest(HttpWebRequest request)
        {
            bool abort;
            lock (sync)
            {
                backendRequest = request;
                abort = IsCancellationRequested;
            }
            if (abort && request != null)
            {
                AbortBackendRequest(request);
            }
        }

        public void Cancel()
        {
            HttpWebRequest request;
            Interlocked.Exchange(ref cancellationRequested, 1);
            lock (sync)
            {
                request = backendRequest;
                if (state == "active")
                {
                    state = "cancelled";
                }
            }
            if (request != null)
            {
                AbortBackendRequest(request);
            }
        }

        private void AbortBackendRequest(HttpWebRequest request)
        {
            Interlocked.Increment(ref backendAbortCount);
            try { request.Abort(); } catch { }
        }

        public void AddBytes(int count)
        {
            if (count > 0) { Interlocked.Add(ref bytesSent, count); }
        }

        public void Complete(string resultState, string resultError)
        {
            if (string.IsNullOrEmpty(resultState)) { resultState = "completed"; }
            lock (sync)
            {
                state = resultState;
                error = resultError ?? string.Empty;
                finishedUtc = DateTime.UtcNow;
            }
        }

        public void SetError(string value)
        {
            lock (sync) { error = value ?? string.Empty; }
        }

        public SpeechStreamSnapshot Snapshot()
        {
            lock (sync)
            {
                return new SpeechStreamSnapshot(
                    RequestId,
                    PlaybackId,
                    state,
                    error,
                    BytesSent,
                    CreatedUtc,
                    finishedUtc);
            }
        }
    }

    public sealed class SpeechStreamSnapshot
    {
        public SpeechStreamSnapshot(
            string requestId,
            string playbackId,
            string state,
            string error,
            long bytes,
            DateTime createdUtc,
            DateTime finishedUtc)
        {
            RequestId = requestId;
            PlaybackId = playbackId;
            State = state;
            Error = error ?? string.Empty;
            Bytes = bytes;
            CreatedUtc = createdUtc;
            FinishedUtc = finishedUtc;
        }

        public string RequestId { get; private set; }
        public string PlaybackId { get; private set; }
        public string State { get; private set; }
        public string Error { get; private set; }
        public long Bytes { get; private set; }
        public DateTime CreatedUtc { get; private set; }
        public DateTime FinishedUtc { get; private set; }
    }

    public sealed class SpeechStreamRegistry
    {
        private readonly object sync = new object();
        private readonly Dictionary<string, SpeechStreamSession> activeByRequest =
            new Dictionary<string, SpeechStreamSession>(StringComparer.Ordinal);
        private readonly Dictionary<string, SpeechStreamSession> activeByPlayback =
            new Dictionary<string, SpeechStreamSession>(StringComparer.Ordinal);
        private readonly Dictionary<string, SpeechStreamSnapshot> recent =
            new Dictionary<string, SpeechStreamSnapshot>(StringComparer.Ordinal);
        private const int MaxRecent = 128;
        private static readonly TimeSpan RecentLifetime = TimeSpan.FromMinutes(10);

        public bool TryRegister(SpeechStreamSession session)
        {
            if (session == null) { throw new ArgumentNullException("session"); }
            lock (sync)
            {
                PruneLocked(DateTime.UtcNow);
                if (activeByRequest.ContainsKey(session.RequestId) ||
                    activeByPlayback.ContainsKey(session.PlaybackId))
                {
                    return false;
                }
                activeByRequest[session.RequestId] = session;
                activeByPlayback[session.PlaybackId] = session;
                return true;
            }
        }

        public bool Cancel(string requestId, string playbackId)
        {
            SpeechStreamSession session = FindActive(requestId, playbackId);
            if (session == null) { return false; }
            session.Cancel();
            return true;
        }

        public SpeechStreamSession FindActive(string requestId, string playbackId)
        {
            lock (sync)
            {
                SpeechStreamSession requestSession = null;
                SpeechStreamSession playbackSession = null;
                bool hasRequestId = !string.IsNullOrEmpty(requestId);
                bool hasPlaybackId = !string.IsNullOrEmpty(playbackId);
                if (hasRequestId) { activeByRequest.TryGetValue(requestId, out requestSession); }
                if (hasPlaybackId) { activeByPlayback.TryGetValue(playbackId, out playbackSession); }
                if (hasRequestId && hasPlaybackId)
                {
                    return requestSession != null && object.ReferenceEquals(requestSession, playbackSession)
                        ? requestSession
                        : null;
                }
                return hasRequestId ? requestSession : playbackSession;
            }
        }

        public SpeechStreamSnapshot FindByIds(string requestId, string playbackId)
        {
            if (string.IsNullOrEmpty(requestId) || string.IsNullOrEmpty(playbackId)) { return null; }
            SpeechStreamSession active = FindActive(requestId, playbackId);
            if (active != null) { return active.Snapshot(); }
            lock (sync)
            {
                PruneLocked(DateTime.UtcNow);
                SpeechStreamSnapshot requestSnapshot;
                SpeechStreamSnapshot playbackSnapshot;
                if (!recent.TryGetValue(requestId, out requestSnapshot) ||
                    !recent.TryGetValue(playbackId, out playbackSnapshot) ||
                    !object.ReferenceEquals(requestSnapshot, playbackSnapshot))
                {
                    return null;
                }
                return requestSnapshot;
            }
        }

        public SpeechStreamSnapshot Find(string id)
        {
            if (string.IsNullOrEmpty(id)) { return null; }
            SpeechStreamSession activeSession = null;
            SpeechStreamSnapshot completedSnapshot = null;
            lock (sync)
            {
                PruneLocked(DateTime.UtcNow);
                if (activeByRequest.TryGetValue(id, out activeSession) || activeByPlayback.TryGetValue(id, out activeSession))
                {
                    // Snapshot outside the registry lock to keep the lock order one-way:
                    // session -> registry during completion, registry -> session is unsafe.
                }
                else if (recent.TryGetValue(id, out completedSnapshot))
                {
                    return completedSnapshot;
                }
            }
            return activeSession == null ? null : activeSession.Snapshot();
        }

        public void Complete(SpeechStreamSession session, string resultState, string error)
        {
            if (session == null) { return; }
            session.Complete(resultState, error);
            SpeechStreamSnapshot snapshot = session.Snapshot();
            lock (sync)
            {
                SpeechStreamSession active;
                if (activeByRequest.TryGetValue(session.RequestId, out active) && object.ReferenceEquals(active, session))
                {
                    activeByRequest.Remove(session.RequestId);
                }
                if (activeByPlayback.TryGetValue(session.PlaybackId, out active) && object.ReferenceEquals(active, session))
                {
                    activeByPlayback.Remove(session.PlaybackId);
                }
                recent[session.RequestId] = snapshot;
                recent[session.PlaybackId] = snapshot;
                PruneLocked(DateTime.UtcNow);
            }
        }

        private void PruneLocked(DateTime nowUtc)
        {
            List<string> expired = new List<string>();
            foreach (KeyValuePair<string, SpeechStreamSnapshot> pair in recent)
            {
                DateTime basis = pair.Value.FinishedUtc == DateTime.MinValue ? pair.Value.CreatedUtc : pair.Value.FinishedUtc;
                if (nowUtc - basis > RecentLifetime)
                {
                    expired.Add(pair.Key);
                }
            }
            foreach (string key in expired) { recent.Remove(key); }
            while (recent.Count > MaxRecent)
            {
                string oldestKey = null;
                DateTime oldest = DateTime.MaxValue;
                foreach (KeyValuePair<string, SpeechStreamSnapshot> pair in recent)
                {
                    DateTime basis = pair.Value.FinishedUtc == DateTime.MinValue ? pair.Value.CreatedUtc : pair.Value.FinishedUtc;
                    if (basis < oldest) { oldest = basis; oldestKey = pair.Key; }
                }
                if (oldestKey == null) { break; }
                recent.Remove(oldestKey);
            }
        }
    }
}
