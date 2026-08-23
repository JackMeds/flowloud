(function audioImportModule(root, factory) {
  const wav = root.QwenReaderWav || (typeof require === 'function' ? require('./wav.js') : null);
  const api = factory(wav);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QwenReaderAudioImport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeAudioImport(wav) {
  'use strict';

  const FRAME_MS = 20;
  const BOUNDARY_MS = 100;
  const MIN_SEGMENT_SECONDS = 5;
  const TARGET_SEGMENT_SECONDS = 10;
  const MAX_SEGMENT_SECONDS = 15;
  const ABSOLUTE_ACTIVE_RMS = 0.01;

  function coded(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function isFloat32Array(value) {
    return Object.prototype.toString.call(value) === '[object Float32Array]';
  }

  function percentile(values, fraction) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
  }

  function downmix(channelArrays) {
    if (!Array.isArray(channelArrays) || channelArrays.length === 0) {
      throw coded('invalid_audio');
    }
    const length = channelArrays[0] && channelArrays[0].length;
    if (!Number.isInteger(length) || length === 0 || channelArrays.some((channel) => !isFloat32Array(channel) || channel.length !== length)) {
      throw coded('invalid_audio');
    }

    const output = new Float32Array(length);
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      let sum = 0;
      for (let channelIndex = 0; channelIndex < channelArrays.length; channelIndex += 1) {
        sum += channelArrays[channelIndex][sampleIndex];
      }
      output[sampleIndex] = sum / channelArrays.length;
    }
    return output;
  }

  function analyzeFrames(samples, sampleRate, frameMs) {
    if (!isFloat32Array(samples) || samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw coded('invalid_audio');
    }
    const durationMs = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : FRAME_MS;
    const frameSize = Math.max(1, Math.round(sampleRate * durationMs / 1000));
    const frames = [];

    for (let start = 0; start < samples.length; start += frameSize) {
      const end = Math.min(samples.length, start + frameSize);
      let energy = 0;
      let peak = 0;
      for (let index = start; index < end; index += 1) {
        const value = samples[index];
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      frames.push({ start: start, end: end, rms: Math.sqrt(energy / (end - start)), peak: peak, active: false, clipped: peak >= 0.995 });
    }

    const noiseFloor = percentile(frames.map((frame) => frame.rms), 0.2);
    const activeThreshold = Math.max(ABSOLUTE_ACTIVE_RMS, noiseFloor * 3.1623);
    for (const frame of frames) frame.active = frame.rms >= activeThreshold;
    return frames;
  }

  function optionSeconds(options, name, fallback) {
    const value = options && Number(options[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function candidateStats(frames, start, end, sampleRate) {
    const inside = frames.filter((frame) => frame.start >= start && frame.end <= end);
    const active = inside.filter((frame) => frame.active);
    const durationSeconds = (end - start) / sampleRate;
    const activeSeconds = active.reduce((total, frame) => total + (frame.end - frame.start) / sampleRate, 0);
    const rmsValues = active.map((frame) => frame.rms);
    const mean = rmsValues.reduce((total, value) => total + value, 0) / rmsValues.length;
    const variance = rmsValues.reduce((total, value) => total + (value - mean) * (value - mean), 0) / rmsValues.length;
    let longestInactiveRun = 0;
    let inactiveRun = 0;
    for (const frame of inside) {
      if (frame.active) {
        longestInactiveRun = Math.max(longestInactiveRun, inactiveRun);
        inactiveRun = 0;
      } else {
        inactiveRun += (frame.end - frame.start) / sampleRate;
      }
    }
    longestInactiveRun = Math.max(longestInactiveRun, inactiveRun);
    const clippedRatio = inside.length === 0 ? 1 : inside.filter((frame) => frame.clipped).length / inside.length;
    return {
      start: start,
      end: end,
      durationSeconds: durationSeconds,
      activeSeconds: activeSeconds,
      activeRatio: durationSeconds === 0 ? 0 : activeSeconds / durationSeconds,
      rmsVariation: mean === 0 ? Infinity : Math.sqrt(variance) / mean,
      clippedRatio: clippedRatio,
      internalSilenceSeconds: longestInactiveRun,
    };
  }

  function selectReferenceSegment(samples, sampleRate, options) {
    if (!isFloat32Array(samples) || samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw coded('invalid_audio');
    }
    const minSeconds = Math.min(MAX_SEGMENT_SECONDS, Math.max(
      MIN_SEGMENT_SECONDS,
      optionSeconds(options, 'minSeconds', MIN_SEGMENT_SECONDS),
    ));
    const maxSeconds = Math.max(minSeconds, Math.min(
      MAX_SEGMENT_SECONDS,
      optionSeconds(options, 'maxSeconds', MAX_SEGMENT_SECONDS),
    ));
    const frames = analyzeFrames(samples, sampleRate, FRAME_MS);
    let activeFrames = frames.filter((frame) => frame.active);
    let activeSeconds = activeFrames.reduce(
      (total, frame) => total + (frame.end - frame.start) / sampleRate,
      0,
    );

    // A clean sample can contain speech from the first frame to the last. In that
    // case the 20th percentile is speech rather than a noise floor, so the
    // relative 10 dB threshold can incorrectly mark every frame inactive. Fall
    // back to the absolute -40 dBFS floor only when the relative pass cannot
    // provide the minimum amount of speech.
    if (activeSeconds + 1e-9 < minSeconds) {
      for (const frame of frames) frame.active = frame.rms >= ABSOLUTE_ACTIVE_RMS;
      activeFrames = frames.filter((frame) => frame.active);
      activeSeconds = activeFrames.reduce(
        (total, frame) => total + (frame.end - frame.start) / sampleRate,
        0,
      );
    }
    if (activeSeconds + 1e-9 < minSeconds) throw coded('voice_too_short');

    const boundarySamples = Math.max(1, Math.round(sampleRate * BOUNDARY_MS / 1000));
    const paddingSamples = Math.floor(sampleRate * 0.15);
    const firstActive = activeFrames[0];
    const lastActive = activeFrames[activeFrames.length - 1];
    const earliestStart = Math.max(0, firstActive.start - paddingSamples);
    const latestEnd = Math.min(samples.length, lastActive.end + paddingSamples);
    const firstStart = Math.ceil(earliestStart / boundarySamples) * boundarySamples;
    const lastEnd = Math.floor(latestEnd / boundarySamples) * boundarySamples;
    const minWindow = Math.ceil(minSeconds * sampleRate / boundarySamples) * boundarySamples;
    const maxWindow = Math.floor(maxSeconds * sampleRate / boundarySamples) * boundarySamples;
    const candidates = [];

    for (let start = firstStart; start < lastEnd; start += boundarySamples) {
      for (let duration = minWindow; duration <= maxWindow && start + duration <= lastEnd; duration += boundarySamples) {
        const candidate = candidateStats(frames, start, start + duration, sampleRate);
        if (candidate.activeSeconds + 1e-9 < minSeconds) continue;
        candidate.score = candidate.activeRatio * 100
          - candidate.rmsVariation * 20
          - candidate.clippedRatio * 80
          - candidate.internalSilenceSeconds * 4
          - Math.abs(candidate.durationSeconds - TARGET_SEGMENT_SECONDS) * 0.5;
        candidates.push(candidate);
      }
    }

    if (candidates.length === 0) throw coded('voice_too_short');
    const unclipped = candidates.filter((candidate) => candidate.clippedRatio === 0);
    const eligible = unclipped.length > 0 ? unclipped : candidates;
    eligible.sort((left, right) => right.score - left.score || left.start - right.start || left.durationSeconds - right.durationSeconds);
    const selected = eligible[0];
    const segmentSamples = samples.slice(selected.start, selected.end);
    let peak = 0;
    for (let index = 0; index < segmentSamples.length; index += 1) peak = Math.max(peak, Math.abs(segmentSamples[index]));
    return {
      samples: segmentSamples,
      startSeconds: selected.start / sampleRate,
      endSeconds: selected.end / sampleRate,
      durationSeconds: selected.durationSeconds,
      peak: peak,
      activeRatio: selected.activeRatio,
    };
  }

  function processAudioBuffer(audioBuffer, wavModule) {
    if (!audioBuffer || !Number.isInteger(audioBuffer.numberOfChannels) || audioBuffer.numberOfChannels <= 0 || !Number.isFinite(audioBuffer.sampleRate)) {
      throw coded('invalid_audio');
    }
    const channels = [];
    for (let index = 0; index < audioBuffer.numberOfChannels; index += 1) {
      channels.push(new Float32Array(audioBuffer.getChannelData(index)));
    }
    const segment = selectReferenceSegment(downmix(channels), audioBuffer.sampleRate);
    const encoder = wavModule || wav;
    if (!encoder || typeof encoder.encodeMono16 !== 'function') throw coded('invalid_audio');
    return { wav: encoder.encodeMono16(segment.samples, audioBuffer.sampleRate, 24000), segment: segment };
  }

  async function decodeFile(file, audioContext) {
    if (!file || typeof file.arrayBuffer !== 'function') throw coded('invalid_audio');
    try {
      return await audioContext.decodeAudioData(await file.arrayBuffer());
    } catch (_) {
      throw coded('audio_decode_failed');
    }
  }

  return Object.freeze({ downmix, analyzeFrames, selectReferenceSegment, processAudioBuffer, decodeFile });
}));
