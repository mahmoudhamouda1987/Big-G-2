export interface BigGMediaOptions {
  audio: boolean;
  video: boolean;
  analyserSmoothing: number;
  frameWidth: number;
  frameQuality: number;
  minCaptureIntervalMs: number;
}

export interface BigGCapturedFrame {
  base64: string;
  mime: string;
  width: number;
  height: number;
  timestamp: number;
}

export type BigGPermissionStatus = "granted" | "denied" | "prompt";

const DEFAULT_OPTIONS: BigGMediaOptions = {
  audio: true,
  video: true,
  analyserSmoothing: 0.82,
  frameWidth: 320,
  frameQuality: 0.62,
  minCaptureIntervalMs: 500,
};

/**
 * MediaService — multi-modal cam & audio bridge for the Big G overlay.
 *
 * - Requests microphone + camera hardware permissions up front.
 * - Runs a Web Audio `AudioContext` + `AnalyserNode` pipeline that maps live
 *   speaking amplitude into a `volume` (0..1) used to drive the LISTENING
 *   orb animation pulse rate.
 * - Can extract low-overhead JPEG frames from the webcam and encode them as
 *   base64 data URLs, ready for multimodal context injection into the
 *   OpenRouter vision pipeline.
 */
export class MediaService {
  private readonly options: BigGMediaOptions;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private audioStream: MediaStream | null = null;
  private videoStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureContext: CanvasRenderingContext2D | null = null;
  private animationFrame: number | null = null;

  private micGranted = false;
  private camGranted = false;

  private volume = 0;
  private smoothedVolume = 0;
  private hearing = false;
  private lastCaptureAt = 0;

  constructor(partialOptions: Partial<BigGMediaOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...partialOptions };
  }

  get micPermission(): BigGPermissionStatus {
    return this.micGranted ? "granted" : this.permDenied("audio") ? "denied" : "prompt";
  }

  get camPermission(): BigGPermissionStatus {
    return this.camGranted ? "granted" : this.permDenied("video") ? "denied" : "prompt";
  }

  get micAvailable(): boolean {
    return this.micGranted;
  }

  get cameraEnabled(): boolean {
    return !!this.videoStream && this.videoStream.getTracks().some((t) => t.readyState === "live");
  }

  get hearingActive(): boolean {
    return this.hearing;
  }

  get liveVolume(): number {
    return this.smoothedVolume;
  }

  /** Mic stream, used by VoiceService for MediaRecorder segmentation. */
  get rawAudioStream(): MediaStream | null {
    return this.audioStream;
  }

  private permDenied(kind: "audio" | "video"): boolean {
    const trackKind = kind === "audio" ? "audio" : "video";
    const stream = kind === "audio" ? this.audioStream : this.videoStream;
    return !!stream && stream.getTracks().every((t) => t.kind === trackKind && t.readyState === "ended");
  }

  /** Requests hardware permissions and boots the analyser + camera pipelines. */
  async initialize(): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.options.audio) tasks.push(this.openMicrophone());
    if (this.options.video) tasks.push(this.openCamera());
    await Promise.all(tasks);

    if (this.audioContext && this.analyser) {
      this.startAnalysisLoop();
    }
  }

  /** Requests a fresh microphone stream and attaches it to the analyser. */
  async openMicrophone(): Promise<void> {
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .catch((err: unknown) => {
        this.micGranted = false;
        throw new Error(`Microphone permission/device error: ${describeMediaError(err)}`);
      });

    this.audioStream = stream;
    this.micGranted = true;

    this.teardownAudioGraph();

    this.audioContext = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

    const source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = this.options.analyserSmoothing;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    source.connect(this.analyser);

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume().catch(() => undefined);
    }
  }

  /** Requests a webcam stream and prepares the offscreen frame extractor. */
  async openCamera(): Promise<void> {
    const stream = await navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      })
      .catch((err: unknown) => {
        this.camGranted = false;
        throw new Error(`Camera permission/device error: ${describeMediaError(err)}`);
      });

    this.videoStream = stream;
    this.camGranted = true;

    this.videoElement ||= document.createElement("video");
    this.videoElement.srcObject = stream;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    await this.videoElement.play().catch(() => undefined);

    this.captureCanvas ||= document.createElement("canvas");
    this.captureContext = this.captureCanvas.getContext("2d");
  }

  /**
   * Extracts a raw webcam frame, downscales it, and returns it as base64.
   * Returns null when the camera is unavailable or the previous capture is
   * still inside the throttle window.
   */
  async captureFrame(): Promise<BigGCapturedFrame | null> {
    const now = performance.now();
    if (now - this.lastCaptureAt < this.options.minCaptureIntervalMs) {
      return null;
    }

    const video = this.videoElement;
    if (!video || !this.captureCanvas || !this.captureContext || !this.videoStream) {
      return null;
    }
    if (video.readyState < 2 || video.videoWidth === 0) {
      return null;
    }

    const scale = this.options.frameWidth / Math.max(1, video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    this.captureCanvas.width = width;
    this.captureCanvas.height = height;
    this.captureContext.drawImage(video, 0, 0, width, height);

    this.lastCaptureAt = now;
    return {
      base64: this.captureCanvas.toDataURL("image/jpeg", this.options.frameQuality),
      mime: "image/jpeg",
      width,
      height,
      timestamp: Date.now(),
    };
  }

  /** Grants or revokes webcam access. Revoking stops frames from being captured. */
  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      if (this.cameraEnabled) return;
      try {
        await this.openCamera();
      } catch (error) {
        throw new Error(String(error));
      }
      return;
    }
    this.videoStream?.getTracks().forEach((t) => t.stop());
    this.videoStream = null;
    this.videoElement?.removeAttribute("src");
    this.camGranted = false;
    this.lastCaptureAt = 0;
  }

  /** Grants or revokes microphone access. Revoking silences listening + recording. */
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.stopHearing();
      this.audioStream?.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
      this.micGranted = false;
      this.teardownAudioGraph();
      return;
    }
    if (this.micGranted) return;
    await this.openMicrophone();
  }

  /** Pauses the voice-analysis loop and silences the analyser feed. */
  stopHearing(): void {
    this.hearing = false;
    this.smoothedVolume = 0;
  }

  /** Resumes live amplitude analysis from the mic. */
  startHearing(): void {
    if (!this.analyser || !this.audioContext) return;
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume().catch(() => undefined);
    }
    this.hearing = true;
  }

  private startAnalysisLoop(): void {
    if (this.animationFrame !== null) return;

    const tick = () => {
      if (this.analyser && this.frequencyData) {
        this.analyser.getByteFrequencyData(this.frequencyData);
        let sum = 0;
        const usable = Math.floor(this.frequencyData.length * 0.85);
        for (let i = 0; i < usable; i++) {
          sum += this.frequencyData[i]!;
        }
        const magnitude = usable > 0 ? sum / (usable * 255) : 0;
        this.volume = clamp01(magnitude * 2.4);
        this.smoothedVolume += (this.volume - this.smoothedVolume) * 0.28;
      }
      this.animationFrame = requestAnimationFrame(tick);
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  private teardownAudioGraph(): void {
    this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.analyser = null;
    this.frequencyData = null;
  }

  /** Releases every hardware resource owned by the bridge. */
  destroy(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.audioStream?.getTracks().forEach((t) => t.stop());
    this.videoStream?.getTracks().forEach((t) => t.stop());
    this.audioStream = null;
    this.videoStream = null;
    this.videoElement?.removeAttribute("src");
    this.videoElement = null;
    this.teardownAudioGraph();
    this.hearing = false;
    this.smoothedVolume = 0;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function describeMediaError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  switch (e?.name) {
    case "NotAllowedError":
      return "permission denied by user or OS";
    case "NotFoundError":
      return "no recording device found";
    case "NotReadableError":
      return "device is locked by another process";
    case "OverconstrainedError":
      return "no device satisfies the requested constraints";
    default:
      return e?.message ?? String(err);
  }
}