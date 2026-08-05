(function (root) {
  'use strict';

  function writeAscii(view, offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  function toPcm16(sample) {
    const bounded = Math.max(-1, Math.min(1, sample));
    return bounded < 0 ? Math.round(bounded * 0x8000) : Math.round(bounded * 0x7fff);
  }

  function resample(samples, sourceRate, targetRate) {
    if (sourceRate === targetRate) {
      return samples;
    }

    const outputLength = Math.max(1, Math.floor(samples.length * targetRate / sourceRate));
    const output = new Float32Array(outputLength);
    const ratio = sourceRate / targetRate;
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(left + 1, samples.length - 1);
      const fraction = position - left;
      output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
    return output;
  }

  function encodeMono16(samples, sourceRate, targetRate) {
    if (Object.prototype.toString.call(samples) !== '[object Float32Array]' || samples.length === 0) {
      throw new TypeError('需要至少一个单声道 Float32 PCM 样本');
    }
    if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
      throw new TypeError('采样率必须为正数');
    }

    const output = resample(samples, sourceRate, targetRate);
    const dataLength = output.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    for (let index = 0; index < output.length; index += 1) {
      view.setInt16(44 + index * 2, toPcm16(output[index]), true);
    }
    return buffer;
  }

  root.QwenReaderWav = { encodeMono16: encodeMono16 };
}(globalThis));
