// Voice dictation audio prep, renderer side: whisper.cpp wants a 16 kHz
// mono WAV, and there is no ffmpeg here — so the MediaRecorder blob is
// decoded with WebAudio, resampled through an OfflineAudioContext, and
// encoded as 16-bit PCM WAV by hand.

export async function blobToWav16k(blob: Blob): Promise<Uint8Array> {
  const raw = await blob.arrayBuffer()
  const ac = new AudioContext()
  try {
    const decoded = await ac.decodeAudioData(raw)
    const rate = 16_000
    const frames = Math.max(1, Math.ceil(decoded.duration * rate))
    const off = new OfflineAudioContext(1, frames, rate)
    const src = off.createBufferSource()
    src.buffer = decoded
    src.connect(off.destination)
    src.start()
    const rendered = await off.startRendering()
    return encodeWavPcm16(rendered.getChannelData(0), rate)
  } finally {
    void ac.close()
  }
}

function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buffer)
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  wstr(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  wstr(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  let off = 44
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}
