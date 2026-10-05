import { scanWave } from "../src/wave.js";

export class MemoryWritable {
  constructor() { this.bytes = new Uint8Array(); this.closed = false; this.aborted = false; }
  async write({ position = 0, data }) {
    if (this.closed || this.aborted) throw new Error("stream is closed");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
    if (position + bytes.length > this.bytes.length) { const next = new Uint8Array(position + bytes.length); next.set(this.bytes); this.bytes = next; }
    this.bytes.set(bytes, position);
  }
  async truncate(size) { this.bytes = this.bytes.slice(0, size); }
  async close() { this.closed = true; }
  async abort() { this.aborted = true; }
}

export async function audioRecord(name, channels, { sampleRate = 48000, bits = 16, float = false, timeReference = 172800000n } = {}) {
  const count = channels.length, frames = channels[0].length, bytes = bits / 8;
  const dataSize = frames * count * bytes;
  const buffer = new Uint8Array(44 + dataSize + (dataSize & 1));
  const view = new DataView(buffer.buffer);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) buffer[offset + i] = text.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, buffer.length - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, float ? 3 : 1, true); view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * count * bytes, true);
  view.setUint16(32, count * bytes, true); view.setUint16(34, bits, true); tag(36, "data"); view.setUint32(40, dataSize, true);
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < count; ch++) {
    const value = channels[ch][i], offset = 44 + (i * count + ch) * bytes;
    if (float && bits === 32) view.setFloat32(offset, value, true);
    else if (float && bits === 64) view.setFloat64(offset, value, true);
    else if (bits === 8) view.setUint8(offset, Math.max(0, Math.min(255, Math.round(value * 128 + 128))));
    else if (bits === 16) view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
    else if (bits === 24) { const pcm = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608))); buffer[offset] = pcm & 255; buffer[offset+1] = (pcm >> 8) & 255; buffer[offset+2] = (pcm >> 16) & 255; }
    else if (bits === 32) view.setInt32(offset, Math.max(-2147483648, Math.min(2147483647, Math.round(value * 2147483648))), true);
    else throw new Error("Unsupported test encoding");
  }
  const file = new File([buffer], name);
  const record = await scanWave({ getFile: async () => file });
  return { ...record, oldTimeReference: timeReference };
}
