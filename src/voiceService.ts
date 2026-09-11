import type { AIService } from "./aiService";
import type { MediaService } from "./mediaService";

export type BigGVoiceState = "sleeping" | "listening" | "recording" | "processing" | "speaking";

export interface BigGVoiceCallbacks {
  onTranscript?: (text: string) => void;
  onStateChange?: (state: BigGVoiceState) => void;
  onError?: (message: string) => void;
}

/**
 * VoiceService — voice-in / voice-out bridge.
 *
 * Continuously segments the mic stream by live volume: speaks are captured
 * with MediaRecorder, shipped to the OpenRouter transcription pipeline, and
 * Big G's text replies are synthesized with the TTS pipeline and spoken from
 * the orb. This turns the overlay into a genuine talking round shape.
 */
export class VoiceService {
  private ai: AIService;
  private media: MediaService;
  private callbacks: BigGVoiceCallbacks;

  private active = false;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private state: BigGVoiceState = "sleeping";

  private volumePoll: number | null = null;
  private recordStartedAt = 0;
  private quietSinceMs: number | null = null;
  private speakingAudio: HTMLAudioElement | null = null;

  private readonly startThreshold = 0.1;
  private readonly quietFlushMs = 1100;
  private readonly maxSegmentMs = 6000;

  constructor(media: MediaService, ai: AIService, callbacks: BigGVoiceCallbacks = {}) {
    this.media = media;
    this.ai = ai;
    this.callbacks = callbacks;
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentState(): BigGVoiceState {
    return this.state;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.media.startHearing();
    this.setState("listening");
    if (this.speakingAudio) {
      this.speakingAudio.pause();
      this.speakingAudio = null;
    }
    this.volumePoll = window.setInterval(() => this.pollVolume(), 140);
  }

  /** Stops capture but lets any in-flight speak finish. */
  stop(): void {
    this.active = false;
    if (this.volumePoll !== null) {
      window.clearInterval(this.volumePoll);
      this.volumePoll = null;
    }
    this.stopSegment();
    this.media.stopHearing();
    this.setState("sleeping");
  }

  /**
   * Speaks a reply through TTS. While speaking, the orb shows a speaking
   * state and voice capture is paused so Big G does not hear its own voice.
   */
  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const captureWasOn = this.active;
    if (captureWasOn) this.stopSegment();
    this.setState("speaking");

    try {
      const blob = await this.ai.synthesizeSpeech({ text: trimmed });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.speakingAudio = audio;

      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        void audio.play();
      });

      URL.revokeObjectURL(url);
      if (this.speakingAudio === audio) this.speakingAudio = null;

      if (captureWasOn && this.active) {
        this.media.startHearing();
        this.setState("listening");
      }
    } catch (error) {
      this.callbacks.onError?.(`TTS failed: ${String(error)}`);
      this.setState(captureWasOn ? "listening" : "sleeping");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Internal: volume-driven utterance segmentation                      */
  /* ------------------------------------------------------------------ */

  private pollVolume(): void {
    if (!this.active) return;
    const level = this.media.liveVolume;

    if (!this.recorder) {
      if (level > this.startThreshold) {
        this.startSegment();
      }
      return;
    }

    if (level > this.startThreshold) {
      this.quietSinceMs = null;
      if (performance.now() - this.recordStartedAt > this.maxSegmentMs) {
        this.endSegmentAndTranscribe();
      }
      return;
    }

    if (this.quietSinceMs === null) {
      this.quietSinceMs = performance.now();
    } else if (performance.now() - this.quietSinceMs > this.quietFlushMs) {
      this.endSegmentAndTranscribe();
    }
  }

  private startSegment(): void {
    const stream = this.media.rawAudioStream;
    if (!stream) return;

    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: pickMimeType(),
      });
      this.recorder = recorder;
      this.chunks = [];
      this.recordStartedAt = performance.now();
      this.quietSinceMs = null;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onstop = () => this.handleSegmentStop();
      recorder.start();
      this.setState("recording");
    } catch (error) {
      this.callbacks.onError?.(`Recorder start failed: ${String(error)}`);
      this.recorder = null;
    }
  }

  private stopSegment(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    } else if (this.recorder) {
      this.recorder = null;
    }
  }

  private handleSegmentStop(): void {
    if (this.recorder) {
      this.recorder = null;
    }
    // Blob is assembled in endSegmentAndTranscribe via this.chunks.
  }

  private endSegmentAndTranscribe(): void {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    this.quietSinceMs = null;

    recorder.onstop = null;
    if (recorder.state !== "inactive") {
      recorder.stop();
    }

    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type ?? "audio/webm" });
    this.chunks = [];
    void this.transcribe(blob);
  }

  private async transcribe(blob: Blob): Promise<void> {
    if (blob.size < 1024) return;
    this.setState("processing");
    try {
      const result = await this.ai.transcribeAudio(blob);
      const text = result.text.trim();
      if (text) {
        this.callbacks.onTranscript?.(text);
      }
    } catch (error) {
      this.callbacks.onError?.(`STT failed: ${String(error)}`);
    } finally {
      if (this.active) {
        this.media.startHearing();
        this.setState("listening");
      }
    }
  }

  private setState(state: BigGVoiceState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}