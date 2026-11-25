export type SfxPreset =
  | "jump"
  | "coin"
  | "hit"
  | "dash"
  | "explosion"
  | "win"
  | "lose"
  | "click";

/**
 * Zero-asset Web Audio procedural SFX synthesizer with automatic iOS Safari
 * first-gesture AudioContext unlock.
 */
export class ProceduralAudio {
  private ctx: AudioContext | null = null;
  private muted = false;
  private unlockHandler: (() => void) | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.unlockHandler = () => {
        this.unlock();
      };
      window.addEventListener("pointerdown", this.unlockHandler, { passive: true });
      window.addEventListener("keydown", this.unlockHandler, { passive: true });
    }
  }

  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  play(preset: SfxPreset, volume = 0.22): void {
    if (this.muted) return;
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.connect(gain);

    switch (preset) {
      case "coin": {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(740, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.17);
        break;
      }
      case "dash": {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(180, now + 0.12);
        gain.gain.setValueAtTime(volume * 0.7, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
        osc.start(now);
        osc.stop(now + 0.14);
        break;
      }
      case "jump": {
        osc.type = "sine";
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.exponentialRampToValueAtTime(640, now + 0.14);
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.16);
        break;
      }
      case "hit": {
        osc.type = "square";
        osc.frequency.setValueAtTime(190, now);
        osc.frequency.exponentialRampToValueAtTime(65, now + 0.14);
        gain.gain.setValueAtTime(volume * 0.9, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.16);
        break;
      }
      case "explosion": {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(32, now + 0.35);
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);
        osc.start(now);
        osc.stop(now + 0.38);
        break;
      }
      case "win": {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.09);
        osc.frequency.setValueAtTime(783.99, now + 0.18);
        osc.frequency.setValueAtTime(1046.5, now + 0.27);
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.start(now);
        osc.stop(now + 0.46);
        break;
      }
      case "lose": {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(340, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.35);
        gain.gain.setValueAtTime(volume * 0.85, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
        osc.start(now);
        osc.stop(now + 0.4);
        break;
      }
      case "click":
      default: {
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(volume * 0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.start(now);
        osc.stop(now + 0.05);
        break;
      }
    }
  }

  destroy(): void {
    if (typeof window !== "undefined" && this.unlockHandler) {
      window.removeEventListener("pointerdown", this.unlockHandler);
      window.removeEventListener("keydown", this.unlockHandler);
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
