export interface AudioFeatures {
  amplitude: number;
  low: number;
  mid: number;
  high: number;
  direction: -1 | 1;
}

type AudioSource = {
  getInputVolume(): number;
  getOutputVolume(): number;
  getInputByteFrequencyData(): Uint8Array;
  getOutputByteFrequencyData(): Uint8Array;
};

class AudioReactiveEngine {
  readonly current: AudioFeatures = { amplitude: 0, low: 0, mid: 0, high: 0, direction: 1 };
  private source?: AudioSource;
  private frame?: number;
  private speaking = false;

  bind(source: AudioSource) { this.source = source; }

  start(isSpeaking: () => boolean) {
    this.stop();
    const loop = () => {
      this.speaking = isSpeaking();
      this.sample();
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.current.amplitude *= .45;
  }

  private sample() {
    if (!this.source) return;
    const bytes = this.speaking ? this.source.getOutputByteFrequencyData() : this.source.getInputByteFrequencyData();
    const volume = this.speaking ? this.source.getOutputVolume() : this.source.getInputVolume();
    const band = (from: number, to: number) => {
      if (!bytes.length) return 0;
      let total = 0;
      const end = Math.min(to, bytes.length);
      for (let index = Math.min(from, end); index < end; index += 1) total += bytes[index];
      return end > from ? total / (end - from) / 255 : 0;
    };
    const smooth = this.speaking ? .12 : .18;
    this.current.amplitude += (Math.min(1, volume * 2.5) - this.current.amplitude) * smooth;
    this.current.low += (band(0, Math.ceil(bytes.length * .2)) - this.current.low) * .1;
    this.current.mid += (band(Math.ceil(bytes.length * .2), Math.ceil(bytes.length * .62)) - this.current.mid) * .1;
    this.current.high += (band(Math.ceil(bytes.length * .62), bytes.length) - this.current.high) * .08;
    this.current.direction = this.speaking ? 1 : -1;
  }
}

export const audioReactiveEngine = new AudioReactiveEngine();
