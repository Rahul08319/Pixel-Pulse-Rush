import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ytg from "@/lib/ytgame";
import {
  evaluateRhythmTelemetry,
  computeStandardDeviation,
  computeMean,
  type PlayerSessionTelemetry,
  type TypeSafeEvaluationReport,
} from "@/lib/typesafe-ai-routing";
import {
  trackCloudSaveEvent,
  getCloudSaveAnalyticsSummary,
  getAllCloudSaveAnalyticsEvents,
  type CloudSaveAnalyticsSummary,
} from "@/lib/cloud-save-analytics";
import { TypeSafeNeuralInspector } from "@/components/TypeSafeNeuralInspector";
import {
  Brain,
  Volume2,
  VolumeX,
  Play,
  RotateCcw,
  Sparkles,
  Trophy,
  Share2,
  Copy,
  Download,
  Flame,
  Gauge,
  Sliders,
  ChevronRight,
  Gamepad2,
  Maximize,
  Minimize,
} from "lucide-react";


/* ============================================================
 * Pixel Pulse Rush
 * 4-lane neon rhythm game with procedural chiptune (Web Audio API)
 * ============================================================ */

const LANES = 4;
const LANE_KEYS = ["d", "f", "j", "k"] as const;
const LANE_COLORS = ["#ff3ea5", "#22e2ff", "#ffe94a", "#5cff8a"] as const;
const HIT_LINE_RATIO = 0.82;
const NOTE_TRAVEL_MS = 1600;
const MAX_MISSES = 3;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
  sparkle: boolean;
};

type Ripple = {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  alpha: number;
};

type Difficulty = "easy" | "normal" | "hard";

type DifficultyConfig = {
  label: string;
  bpm: number;
  bpmJitter: number;
  density: number;
  hitWindow: number;
  perfectWindow: number;
  blurb: string;
};

const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  easy: {
    label: "EASY",
    bpm: 104,
    bpmJitter: 6,
    density: 0.55,
    hitWindow: 190,
    perfectWindow: 90,
    blurb: "100–110 BPM · loose timing · sparse notes",
  },
  normal: {
    label: "NORMAL",
    bpm: 130,
    bpmJitter: 8,
    density: 1.0,
    hitWindow: 140,
    perfectWindow: 55,
    blurb: "125–140 BPM · standard timing · full pattern",
  },
  hard: {
    label: "HARD",
    bpm: 162,
    bpmJitter: 10,
    density: 1.45,
    hitWindow: 95,
    perfectWindow: 35,
    blurb: "155–170 BPM · tight timing · dense pattern",
  },
};

// ---------- Persistence ----------
const STATS_KEY = "ppr:stats:v1";
const OFFSET_KEY = "ppr:offset:v1";

// Current cloud-save schema version. Bump when the shape of `stats` changes
// and add a case to `migrateCloudPayload` below.
const CLOUD_SAVE_VERSION = 2;

type DiffStats = {
  bestScore: number;
  bestCombo: number;
  bestAccuracy: number;
  plays: number;
};
type AllStats = Record<Difficulty, DiffStats>;
const EMPTY_STATS: AllStats = {
  easy: { bestScore: 0, bestCombo: 0, bestAccuracy: 0, plays: 0 },
  normal: { bestScore: 0, bestCombo: 0, bestAccuracy: 0, plays: 0 },
  hard: { bestScore: 0, bestCombo: 0, bestAccuracy: 0, plays: 0 },
};

/**
 * Versioned cloud-save envelope. Older builds wrote raw AllStats without
 * a wrapper (implicit v1). New builds always write { v, stats }.
 * When the schema evolves, bump CLOUD_SAVE_VERSION and add a migration
 * branch — never mutate the shape of an existing version in place.
 */
type CloudSaveV2 = { v: 2; stats: AllStats };
type CloudSave = CloudSaveV2;

function coerceDiffStats(x: unknown): DiffStats {
  const o = (x ?? {}) as Partial<DiffStats>;
  return {
    bestScore: Math.max(0, Math.floor(Number(o.bestScore) || 0)),
    bestCombo: Math.max(0, Math.floor(Number(o.bestCombo) || 0)),
    bestAccuracy: Math.max(0, Math.min(100, Math.floor(Number(o.bestAccuracy) || 0))),
    plays: Math.max(0, Math.floor(Number(o.plays) || 0)),
  };
}

function coerceAllStats(x: unknown): AllStats {
  const o = (x ?? {}) as Partial<Record<Difficulty, unknown>>;
  return {
    easy: coerceDiffStats(o.easy),
    normal: coerceDiffStats(o.normal),
    hard: coerceDiffStats(o.hard),
  };
}

type InterstitialHint = "cooldown" | "unavailable" | "shown" | null;

export type SaveRetryState = {
  state: "idle" | "pending" | "backoff" | "abandoned";
  attempts: number;
  maxAttempts: number;
  /** Epoch ms of the next eligible retry, or null when idle/abandoned. */
  nextAttemptAt: number | null;
};

export type DebugLogEntry = {
  at: number;
  source: "window.onerror" | "unhandledrejection" | "console.error" | "network" | "sdk";
  message: string;
};

/** Best-effort stringify for arbitrary thrown/logged values. */
function safeStringify(v: unknown): string {
  try {
    return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

type DebugInfo = {
  cloudSchemaVersion: number;
  cloudSourceVersion: number | null;
  cloudMigrationStatus: MigrationStatus | "pending";
  inPlayables: boolean;
  lastAd: { kind: "interstitial" | "rewarded"; result: string; at: number } | null;
  lastSave: { ok: boolean; note: string; at: number } | null;
  saveQueueDepth: number;
  saveQueueAttempts: number;
  saveRetry: SaveRetryState;
  lastError: string | null;
  errorLog: DebugLogEntry[];
  cloudAnalytics: CloudSaveAnalyticsSummary;
};

type MigrationStatus =
  | "empty"
  | "loaded_v2"
  | "migrated_from_v1"
  | "salvaged_unknown"
  | "invalid_json"
  | "wrong_shape";

/** Parse a raw cloud payload, migrating older schemas up to the current one. */
function migrateCloudPayload(
  raw: string,
): { save: CloudSave | null; status: MigrationStatus; sourceVersion: number | null } {
  if (!raw) return { save: null, status: "empty", sourceVersion: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { save: null, status: "invalid_json", sourceVersion: null };
  }
  if (!parsed || typeof parsed !== "object")
    return { save: null, status: "wrong_shape", sourceVersion: null };

  const maybeVersioned = parsed as { v?: number; stats?: unknown };
  // v1 (legacy): the payload IS the AllStats object, no envelope.
  if (typeof maybeVersioned.v !== "number") {
    return {
      save: { v: 2, stats: coerceAllStats(parsed) },
      status: "migrated_from_v1",
      sourceVersion: 1,
    };
  }
  if (maybeVersioned.v === 2) {
    return {
      save: { v: 2, stats: coerceAllStats(maybeVersioned.stats) },
      status: "loaded_v2",
      sourceVersion: 2,
    };
  }
  // Unknown future version — try to salvage `stats` if present, else drop.
  if (maybeVersioned.stats && typeof maybeVersioned.stats === "object") {
    return {
      save: { v: 2, stats: coerceAllStats(maybeVersioned.stats) },
      status: "salvaged_unknown",
      sourceVersion: maybeVersioned.v,
    };
  }
  return { save: null, status: "wrong_shape", sourceVersion: maybeVersioned.v };
}

function encodeCloudPayload(stats: AllStats): string {
  const payload: CloudSaveV2 = { v: CLOUD_SAVE_VERSION, stats };
  return JSON.stringify(payload);
}

// ---------- Cloud save retry queue ----------
// When a saveData call fails (rate-limit / transient / offline) we keep the
// payload queued in localStorage and retry it: on interval, on `online`, and
// after any subsequent successful save. Only the newest payload is kept —
// intermediate stats are strictly older and safe to drop.
//
// Retries use exponential backoff with full jitter so a rate-limited or
// offline device doesn't hammer saveData, and give up after MAX_SAVE_ATTEMPTS
// so a permanently-bad payload can't retry forever.
const CLOUD_QUEUE_KEY = "ppr:cloudq:v1";
const SAVE_BASE_DELAY_MS = 2_000;
const SAVE_MAX_DELAY_MS = 120_000;
export const MAX_SAVE_ATTEMPTS = 8;

/** Full-jitter exponential backoff: random in [base, base * 2^attempt]. */
function backoffDelay(attempts: number): number {
  const ceiling = Math.min(SAVE_MAX_DELAY_MS, SAVE_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(SAVE_BASE_DELAY_MS + Math.random() * Math.max(0, ceiling - SAVE_BASE_DELAY_MS));
}

type QueuedSave = {
  payload: string;
  queuedAt: number;
  attempts: number;
  /** Epoch ms before which no retry should be attempted. */
  nextAttemptAt: number;
  /** True once we've exhausted MAX_SAVE_ATTEMPTS. */
  abandoned?: boolean;
};

function readQueue(): QueuedSave | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CLOUD_QUEUE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QueuedSave;
    if (!parsed || typeof parsed.payload !== "string") return null;
    if (typeof parsed.nextAttemptAt !== "number") parsed.nextAttemptAt = 0;
    if (typeof parsed.attempts !== "number") parsed.attempts = 0;
    return parsed;
  } catch {
    return null;
  }
}
function writeQueue(q: QueuedSave | null) {
  try {
    if (!q) localStorage.removeItem(CLOUD_QUEUE_KEY);
    else localStorage.setItem(CLOUD_QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
}

function loadStats(): AllStats {
  if (typeof window === "undefined") return EMPTY_STATS;
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return EMPTY_STATS;
    const parsed = JSON.parse(raw);
    return { ...EMPTY_STATS, ...parsed };
  } catch {
    return EMPTY_STATS;
  }
}
function saveStats(s: AllStats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
function loadOffset(): number {
  if (typeof window === "undefined") return 0;
  try {
    const v = localStorage.getItem(OFFSET_KEY);
    return v ? Number(v) || 0 : 0;
  } catch {
    return 0;
  }
}
function saveOffset(v: number) {
  try {
    localStorage.setItem(OFFSET_KEY, String(v));
  } catch {
    /* ignore */
  }
}

type Note = {
  id: number;
  lane: number;
  spawnAt: number;
  hitAt: number;
  hit: boolean;
  missed: boolean;
  judged: boolean;
};

type Judgement = { text: string; color: string; at: number };

type GameState = "idle" | "playing" | "paused" | "over" | "calibrating";

type FinalStats = {
  score: number;
  bestCombo: number;
  accuracy: number;
  hits: number;
  total: number;
  difficulty: Difficulty;
  bpm: number;
  newBestScore: boolean;
  newBestCombo: boolean;
};

// ---------- Procedural chiptune ----------
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12];
const ROOT_MIDI = 45;

function midiToFreq(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

type ScheduleCb = (beat: number, hitTime: number, lanes: number[]) => void;

class ChiptuneEngine {
  ctx: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  bpm: number;
  beatDur: number;
  density: number;
  startTime = 0;
  running = false;
  nextBeat = 0;
  beatIndex = 0;
  seed: number;
  scheduleCb: ScheduleCb | null = null;

  constructor(bpm: number, density: number) {
    const Ctor: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext || window.AudioContext;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.bpm = bpm;
    this.beatDur = 60 / bpm;
    this.density = density;
    this.seed = Math.floor(Math.random() * 1e9);
  }

  rand(n: number) {
    let x = (this.seed + n * 2654435761) >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  }

  blip(freq: number, when: number, dur: number, type: OscillatorType, gain = 0.25) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  noise(when: number, dur: number, gain = 0.15, highpass = 4000) {
    const buf = this.ctx.createBuffer(
      1,
      Math.max(1, Math.floor(this.ctx.sampleRate * dur)),
      this.ctx.sampleRate,
    );
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "highpass";
    bp.frequency.value = highpass;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  kick(when: number) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(120, when);
    o.frequency.exponentialRampToValueAtTime(40, when + 0.15);
    g.gain.setValueAtTime(0.6, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
    o.connect(g);
    g.connect(this.master);
    o.start(when);
    o.stop(when + 0.25);
  }

  scheduleBeat(beat: number, when: number) {
    const bar = Math.floor(beat / 16);
    const posInBar = beat % 16;
    if (posInBar % 4 === 0) this.kick(when);
    if (posInBar % 2 === 1) this.noise(when, 0.05, 0.08, 6000);
    if (posInBar === 4 || posInBar === 12) this.noise(when, 0.12, 0.18, 2000);

    const r = this.rand(beat);
    if (r > 0.15) {
      const scaleStep = SCALE[Math.floor(this.rand(beat * 3.7 + 1) * SCALE.length)];
      const octave = Math.floor(this.rand(beat * 1.3 + 7) * 3);
      const freq = midiToFreq(ROOT_MIDI + scaleStep + octave * 12 + 12);
      const type: OscillatorType =
        this.rand(beat * 0.9) > 0.5 ? "square" : "triangle";
      this.blip(freq, when, 0.14, type, 0.18);
    }
    if (posInBar % 2 === 0) {
      const bassStep = SCALE[(bar + Math.floor(posInBar / 4)) % SCALE.length];
      const f = midiToFreq(ROOT_MIDI + bassStep);
      this.blip(f, when, 0.22, "square", 0.22);
    }
  }

  patternForBeat(beat: number): number[] {
    const lanes: number[] = [];
    const posInBar = beat % 16;
    const d = this.density;
    if (posInBar % 4 === 0) {
      if (d >= 1 || this.rand(beat * 7.3 + 11) < 0.85) {
        lanes.push(Math.floor(this.rand(beat * 2 + 5) * LANES));
      }
    }
    const offBeatChance = 0.65 * d;
    if (posInBar % 2 === 1 && this.rand(beat * 1.7) < offBeatChance) {
      lanes.push(Math.floor(this.rand(beat * 4.1 + 3) * LANES));
    }
    const sixteenthChance = 0.15 * d;
    if (this.rand(beat * 0.53) < sixteenthChance) {
      const l = Math.floor(this.rand(beat * 5.9) * LANES);
      if (!lanes.includes(l)) lanes.push(l);
    }
    if (d > 1.2 && posInBar % 8 === 0 && this.rand(beat * 9.1) < 0.4) {
      const l = Math.floor(this.rand(beat * 11.3) * LANES);
      if (!lanes.includes(l)) lanes.push(l);
    }
    return lanes;
  }

  runLoop() {
    const loop = () => {
      if (!this.running) return;
      const now = this.ctx.currentTime;
      while (this.startTime + this.nextBeat * this.beatDur < now + 2.2) {
        const when = this.startTime + this.nextBeat * this.beatDur;
        this.scheduleBeat(this.nextBeat, when);
        const lanes = this.patternForBeat(this.nextBeat);
        this.scheduleCb?.(this.nextBeat, when, lanes);
        this.nextBeat++;
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  start(scheduleAhead: ScheduleCb) {
    this.scheduleCb = scheduleAhead;
    this.running = true;
    this.startTime = this.ctx.currentTime + 0.2;
    this.nextBeat = 0;
    this.beatIndex = 0;
    this.runLoop();
  }

  pauseAudioTime = 0;
  pauseWallTime = 0;

  pause() {
    this.running = false;
    this.pauseAudioTime = this.ctx.currentTime;
    this.pauseWallTime = performance.now();
    try {
      this.ctx.suspend();
    } catch {
      /* ignore */
    }
  }

  async unpause(): Promise<number> {
    try {
      if (this.ctx.state !== "running") await this.ctx.resume();
    } catch {
      /* ignore */
    }
    this.running = true;

    // Measure beat timing drift during pause
    const resumedAudioTime = this.ctx.currentTime;
    let drift = 0;
    if (this.pauseAudioTime > 0) {
      drift = Math.max(0, resumedAudioTime - this.pauseAudioTime);
    }

    // Shift procedural timeline start so notes and beats align to resumed audio clock
    if (drift > 0.005) {
      this.startTime += drift;
    }

    // Guard against burst scheduling: ensure nextBeat never lags behind current audio time
    const currentAudioTime = this.ctx.currentTime;
    const currentBeatFromStart = (currentAudioTime - this.startTime) / this.beatDur;
    if (this.nextBeat < currentBeatFromStart) {
      this.nextBeat = Math.max(this.nextBeat, Math.ceil(currentBeatFromStart));
    }

    this.runLoop();
    return drift;
  }

  stop() {
    this.running = false;
    try {
      this.master.gain.exponentialRampToValueAtTime(
        0.0001,
        this.ctx.currentTime + 0.3,
      );
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.ctx.close();
      } catch {
        /* ignore */
      }
    }, 400);
  }

  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }
}

// ---------- Component ----------
export default function PixelPulseRush() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The focusable play surface — keeps keyboard focus inside the game. */
  const playSurfaceRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ChiptuneEngine | null>(null);
  const notesRef = useRef<Note[]>([]);
  const noteIdRef = useRef(0);
  const stateRef = useRef<GameState>("idle");
  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const missesRef = useRef(0);
  const judgementsRef = useRef<Judgement[]>([]);
  const pulseRef = useRef(0);
  const laneFlashRef = useRef<number[]>([0, 0, 0, 0]);
  const particlesRef = useRef<Particle[]>([]);
  const ripplesRef = useRef<Ripple[]>([]);
  const hitWindowRef = useRef(DIFFICULTIES.normal.hitWindow);
  const perfectWindowRef = useRef(DIFFICULTIES.normal.perfectWindow);
  const latencyOffsetRef = useRef(0);

  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [state, setState] = useState<GameState>("idle");
  const [hud, setHud] = useState({ score: 0, combo: 0, misses: 0, best: 0 });
  const [finalStats, setFinalStats] = useState<FinalStats | null>(null);
  const [statsAll, setStatsAll] = useState<AllStats>(EMPTY_STATS);
  const [latencyOffset, setLatencyOffset] = useState<number>(0);
  const [shareUrl, setShareUrl] = useState<string>("");
  const [challenge, setChallenge] = useState<
    | null
    | { score: number; combo: number; acc: number; diff: Difficulty }
  >(null);

  // TypeSafe AI Neural Telemetry & Audio state
  const hitDeltasRef = useRef<number[]>([]);
  const consecutiveMissesRef = useRef(0);
  const laneDistributionRef = useRef<[number, number, number, number]>([0, 0, 0, 0]);
  const perfectHitsRef = useRef(0);
  const greatHitsRef = useRef(0);
  const gameStartTimeRef = useRef(0);
  const [typeSafeReport, setTypeSafeReport] = useState<TypeSafeEvaluationReport | null>(null);
  const [neuralDrawerOpen, setNeuralDrawerOpen] = useState(false);
  const [soundMuted, setSoundMuted] = useState(false);
  const [pressedLanes, setPressedLanes] = useState<boolean[]>([false, false, false, false]);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const playUiSfx = useCallback((type: "click" | "start" | "diff" | "pause") => {
    if (soundMuted) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = (window as any)._uiAudioCtx || new AudioCtx();
      (window as any)._uiAudioCtx = ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === "click") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.035);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
        osc.start(now);
        osc.stop(now + 0.035);
      } else if (type === "start") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(554.37, now + 0.05);
        osc.frequency.setValueAtTime(659.25, now + 0.1);
        osc.frequency.setValueAtTime(880, now + 0.15);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.start(now);
        osc.stop(now + 0.28);
      } else if (type === "diff") {
        osc.type = "square";
        osc.frequency.setValueAtTime(330, now);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.05);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (type === "pause") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.08);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);
      }
    } catch {
      /* ignore audio context restrictions before user gesture */
    }
  }, [soundMuted]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setSoundMuted(next);
    const eng = engineRef.current;
    if (eng) {
      try {
        eng.master.gain.value = next ? 0 : 0.35;
      } catch {
        /* ignore */
      }
    }
  }, []);

  const hitsRef = useRef(0);
  const totalRef = useRef(0);
  const activeTouchesRef = useRef<Map<number, number>>(new Map());
  const mutedRef = useRef(false);
  const cloudReadyRef = useRef(false);
  // Interstitial cooldown — YouTube requires ads only at natural breakpoints,
  // never mid-run and never too frequently. Track last shown timestamp and
  // whether the current run has already surfaced one.
  const lastInterstitialAtRef = useRef(0);
  const shownInterstitialThisRunRef = useRef(false);
  const INTERSTITIAL_MIN_INTERVAL_MS = 90_000;
  const [rewardGranted, setRewardGranted] = useState(false);
  const [rewardPending, setRewardPending] = useState(false);

  // Interstitial availability hint for the current pause/game-over screen.
  //  - "cooldown"   : rate-limited by our INTERSTITIAL_MIN_INTERVAL_MS
  //  - "unavailable": not in Playables env or SDK returned false
  //  - "shown"      : request went through (may or may not have rendered)
  //  - null         : nothing to say
  const [interstitialHint, setInterstitialHint] = useState<InterstitialHint>(null);

  // Playables & Visibility lifecycle: whether YouTube currently considers us backgrounded,
  // and whether YouTube or document.visibilityState triggered the current pause.
  const ytPausedRef = useRef(false);
  const ytAutoPausedRef = useRef(false);
  const visibilityAutoPausedRef = useRef(false);

  // ---------- Hidden debug overlay ----------
  // Toggle with backtick (`) or by appending ?debug=1 to the URL.
  const [debugOpen, setDebugOpen] = useState(false);
  const [debug, setDebug] = useState<DebugInfo>(() => ({
    cloudSchemaVersion: CLOUD_SAVE_VERSION,
    cloudSourceVersion: null,
    cloudMigrationStatus: "pending",
    inPlayables: false,
    lastAd: null,
    lastSave: null,
    saveQueueDepth: 0,
    saveQueueAttempts: 0,
    saveRetry: { state: "idle", attempts: 0, maxAttempts: MAX_SAVE_ATTEMPTS, nextAttemptAt: null },
    lastError: null,
    errorLog: [],
    cloudAnalytics: getCloudSaveAnalyticsSummary(),
  }));
  const patchDebug = useCallback((p: Partial<DebugInfo>) => {
    setDebug((d) => ({ ...d, ...p }));
  }, []);

  /** Append an entry to the debug error log (newest first, capped at 12). */
  const logDebugError = useCallback((source: DebugLogEntry["source"], message: string) => {
    const entry: DebugLogEntry = { at: Date.now(), source, message: message.slice(0, 300) };
    setDebug((d) => ({ ...d, lastError: entry.message, errorLog: [entry, ...d.errorLog].slice(0, 12) }));
  }, []);

  // ---------- Global error capture ----------
  // Certification runs flag uncaught errors and unhandled rejections. We record
  // them (plus console.error and failed fetches) into the debug overlay and
  // forward them to ytgame.health.logError so YouTube sees the signal too.
  useEffect(() => {
    const describe = (v: unknown) =>
      v instanceof Error ? `${v.name}: ${v.message}` : typeof v === "string" ? v : safeStringify(v);

    const onError = (ev: ErrorEvent) => {
      const where = ev.filename ? ` (${ev.filename}:${ev.lineno}:${ev.colno})` : "";
      logDebugError("window.onerror", `${describe(ev.error ?? ev.message)}${where}`);
      ytg.logError();
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      logDebugError("unhandledrejection", describe(ev.reason));
      ytg.logError();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    // Mirror console.error without swallowing it.
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      try {
        logDebugError("console.error", args.map(describe).join(" "));
      } catch {
        /* never let logging break logging */
      }
      originalConsoleError.apply(console, args as never[]);
    };

    // Record network failures (offline, CORS, 5xx) surfaced through fetch.
    const originalFetch = window.fetch?.bind(window);
    if (originalFetch) {
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          const res = await originalFetch(input, init);
          if (!res.ok && res.status >= 500) {
            logDebugError("network", `${res.status} ${res.statusText} · ${String(res.url || input)}`);
          }
          return res;
        } catch (err) {
          logDebugError("network", `fetch failed · ${String(input)} · ${describe(err)}`);
          throw err;
        }
      };
    }

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = originalConsoleError;
      if (originalFetch) window.fetch = originalFetch;
    };
  }, [logDebugError]);

  // ---------- Queued cloud save with retry ----------
  // Only the newest payload is kept; older stats are strictly obsolete once
  // a more recent snapshot exists locally. flushCloudQueue is called from
  // queueCloudSave, from an interval, from `online`, and from tab visibility.
  // Failures back off exponentially with full jitter and stop after
  // MAX_SAVE_ATTEMPTS (queue marked `abandoned`, surfaced in the UI hint).
  const flushingRef = useRef(false);

  const publishRetryState = useCallback(
    (q: QueuedSave | null) => {
      if (!q) {
        patchDebug({
          saveQueueDepth: 0,
          saveQueueAttempts: 0,
          saveRetry: { state: "idle", attempts: 0, maxAttempts: MAX_SAVE_ATTEMPTS, nextAttemptAt: null },
        });
        return;
      }
      patchDebug({
        saveQueueDepth: 1,
        saveQueueAttempts: q.attempts,
        saveRetry: {
          state: q.abandoned ? "abandoned" : q.attempts > 0 ? "backoff" : "pending",
          attempts: q.attempts,
          maxAttempts: MAX_SAVE_ATTEMPTS,
          nextAttemptAt: q.abandoned ? null : q.nextAttemptAt,
        },
      });
    },
    [patchDebug],
  );

  const flushCloudQueue = useCallback(
    async (opts?: { force?: boolean }) => {
      if (flushingRef.current) return;
      const q = readQueue();
      if (!q) return;
      if (q.abandoned && !opts?.force) return;
      if (!opts?.force && Date.now() < q.nextAttemptAt) {
        publishRetryState(q);
        return;
      }
      flushingRef.current = true;
      trackCloudSaveEvent({
        type: "save_attempt",
        attempt: q.attempts + 1,
        maxAttempts: MAX_SAVE_ATTEMPTS,
        inPlayables: ytg.inPlayablesEnv(),
        payloadSize: q.payload.length,
      });

      const res = await ytg.saveCloudDataStrict(q.payload);
      flushingRef.current = false;
      if (res.ok) {
        writeQueue(null);
        trackCloudSaveEvent({
          type: "save_success",
          attempt: q.attempts + 1,
          maxAttempts: MAX_SAVE_ATTEMPTS,
          inPlayables: ytg.inPlayablesEnv(),
          payloadSize: q.payload.length,
          note: res.noop ? "noop (outside Playables)" : "flushed",
        });
        patchDebug({
          lastSave: {
            ok: true,
            note: res.noop ? "noop (outside Playables)" : "flushed",
            at: Date.now(),
          },
          cloudAnalytics: getCloudSaveAnalyticsSummary(),
        });
        publishRetryState(null);
        return;
      }
      const attempts = q.attempts + 1;
      const abandoned = attempts >= MAX_SAVE_ATTEMPTS;
      const delay = backoffDelay(attempts);
      const bumped: QueuedSave = {
        ...q,
        attempts,
        abandoned,
        nextAttemptAt: abandoned ? 0 : Date.now() + delay,
      };
      writeQueue(bumped);

      if (abandoned) {
        trackCloudSaveEvent({
          type: "save_abandoned",
          attempt: attempts,
          maxAttempts: MAX_SAVE_ATTEMPTS,
          errorReason: res.error ?? "save failed permanently",
          inPlayables: ytg.inPlayablesEnv(),
          payloadSize: q.payload.length,
        });
      } else {
        trackCloudSaveEvent({
          type: "save_retry_scheduled",
          attempt: attempts,
          maxAttempts: MAX_SAVE_ATTEMPTS,
          backoffDelayMs: delay,
          errorReason: res.error ?? "save failed, scheduled backoff",
          inPlayables: ytg.inPlayablesEnv(),
          payloadSize: q.payload.length,
        });
      }

      patchDebug({
        lastSave: {
          ok: false,
          note: abandoned
            ? `gave up after ${attempts} attempts: ${res.error ?? "err"}`
            : `retry ${attempts}/${MAX_SAVE_ATTEMPTS} in ${Math.round(delay / 1000)}s: ${res.error ?? "err"}`,
          at: Date.now(),
        },
        lastError: res.error ?? "save failed",
        cloudAnalytics: getCloudSaveAnalyticsSummary(),
      });
      publishRetryState(bumped);
      if (!res.noop) ytg.logError();
    },
    [patchDebug, publishRetryState],
  );

  const queueCloudSave = useCallback(
    async (payload: string) => {
      // Newest wins — overwrite any queued payload with fresher stats and
      // reset the backoff, since this is a brand new save attempt.
      trackCloudSaveEvent({
        type: "save_queued",
        attempt: 0,
        maxAttempts: MAX_SAVE_ATTEMPTS,
        inPlayables: ytg.inPlayablesEnv(),
        payloadSize: payload.length,
      });
      const q: QueuedSave = { payload, queuedAt: Date.now(), attempts: 0, nextAttemptAt: 0 };
      writeQueue(q);
      publishRetryState(q);
      await flushCloudQueue({ force: true });
    },
    [flushCloudQueue, publishRetryState],
  );

  // Retry loop for queued saves: interval + network + visibility triggers.
  useEffect(() => {
    // Adopt any queue from a previous session (backoff clock restarts fresh).
    const existing = readQueue();
    if (existing) {
      publishRetryState(existing);
      void flushCloudQueue();
    }
    const t = window.setInterval(() => {
      void flushCloudQueue();
    }, 5_000);
    // A regained connection is a strong signal — bypass the backoff timer once.
    const onOnline = () => void flushCloudQueue({ force: true });
    const onVis = () => {
      if (!document.hidden) void flushCloudQueue();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [flushCloudQueue, publishRetryState]);

  // Debug overlay toggle: backtick key or ?debug=1 URL flag.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("debug") === "1") {
        setDebugOpen(true);
      }
    } catch {
      /* ignore */
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" || e.key === "~") {
        e.preventDefault();
        setDebugOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  // Load persisted stats + offset + parse challenge URL
  useEffect(() => {
    setStatsAll(loadStats());
    const off = loadOffset();
    latencyOffsetRef.current = off;
    setLatencyOffset(off);
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("s")) {
        const d = params.get("d");
        const diff: Difficulty =
          d === "easy" || d === "normal" || d === "hard" ? d : "normal";
        setChallenge({
          score: Number(params.get("s")) || 0,
          combo: Number(params.get("c")) || 0,
          acc: Number(params.get("a")) || 0,
          diff,
        });
        setDifficulty(diff);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // YouTube Playables SDK lifecycle. Runs as a no-op outside of Playables.
  useEffect(() => {
    let cancelled = false;

    // Initial audio state from YT settings.
    mutedRef.current = !ytg.isAudioEnabled();
    patchDebug({ inPlayables: ytg.inPlayablesEnv() });

    // Merge any cloud save into local stats (cloud wins on higher values).
    // Payload is versioned (see migrateCloudPayload) so older saves are
    // upgraded transparently and unknown-future saves are salvaged if possible.
    (async () => {
      const raw = await ytg.loadCloudData();
      if (cancelled) {
        cloudReadyRef.current = true;
        return;
      }
      const { save: migrated, status, sourceVersion } = migrateCloudPayload(raw);
      patchDebug({ cloudMigrationStatus: status, cloudSourceVersion: sourceVersion });
      if (!migrated) {
        cloudReadyRef.current = true;
        return;
      }
      const cloud = migrated.stats;
      setStatsAll((cur) => {
        const merged: AllStats = { ...cur };
        (Object.keys(EMPTY_STATS) as Difficulty[]).forEach((d) => {
          const a = cur[d];
          const b = cloud[d];
          if (!b) return;
          merged[d] = {
            bestScore: Math.max(a.bestScore, b.bestScore ?? 0),
            bestCombo: Math.max(a.bestCombo, b.bestCombo ?? 0),
            bestAccuracy: Math.max(a.bestAccuracy, b.bestAccuracy ?? 0),
            plays: Math.max(a.plays, b.plays ?? 0),
          };
        });
        saveStats(merged);
        // Rewrite cloud in the current envelope so legacy v1 saves get upgraded.
        void queueCloudSave(encodeCloudPayload(merged));
        return merged;
      });
      cloudReadyRef.current = true;
    })();


    // Signal SDK milestones. firstFrameReady after paint, gameReady when interactable.
    const raf = requestAnimationFrame(() => {
      ytg.firstFrameReady();
      // The idle menu is interactable immediately.
      ytg.gameReady();
    });

    // React to YouTube-driven audio, pause and resume.
    const offAudio = ytg.onAudioEnabledChange((enabled) => {
      mutedRef.current = !enabled;
      const eng = engineRef.current;
      if (eng) {
        try {
          eng.master.gain.value = enabled ? 0.35 : 0;
        } catch {
          /* ignore */
        }
      }
    });
    // YouTube-driven pause/resume must map exactly onto our game + audio state.
    // We only auto-resume gameplay if *YouTube* was the one that paused it —
    // a user-initiated pause must stay paused when the tab comes back.
    const offPause = ytg.onPause(() => {
      ytPausedRef.current = true;
      // Always silence audio, whatever screen we're on.
      const eng = engineRef.current;
      if (eng) {
        try {
          eng.master.gain.value = 0;
        } catch {
          /* ignore */
        }
      }
      if (stateRef.current === "playing") {
        ytAutoPausedRef.current = true;
        stateRef.current = "paused";
        setState("paused");
        eng?.pause();
      } else {
        eng?.pause();
      }
    });
    const offResume = ytg.onResume(() => {
      ytPausedRef.current = false;
      const eng = engineRef.current;
      const restoreGain = () => {
        if (!eng) return;
        try {
          eng.master.gain.value = mutedRef.current ? 0 : 0.35;
        } catch {
          /* ignore */
        }
      };
      // Auto-resume gameplay if YouTube triggered pause AND document is visible
      if (
        (ytAutoPausedRef.current || visibilityAutoPausedRef.current) &&
        stateRef.current === "paused" &&
        !document.hidden
      ) {
        ytAutoPausedRef.current = false;
        visibilityAutoPausedRef.current = false;
        void resumeGame().then(() => {
          restoreGain();
        });
        return;
      }
      // Not mid-run: just bring the audio graph back online for menus/SFX.
      if (stateRef.current !== "paused" && !document.hidden) {
        void eng?.unpause().then(restoreGain);
      } else {
        restoreGain();
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      offAudio();
      offPause();
      offResume();
    };
  }, []);


  // Try to surface an interstitial at a natural break. Sets a UI hint so the
  // player knows whether an ad was actually requested, deferred by cooldown,
  // or unavailable in this environment.
  const tryInterstitial = useCallback(async () => {
    const now = Date.now();
    if (now - lastInterstitialAtRef.current < INTERSTITIAL_MIN_INTERVAL_MS) {
      setInterstitialHint("cooldown");
      patchDebug({
        lastAd: { kind: "interstitial", result: "skipped: cooldown", at: now },
      });
      return;
    }
    if (!ytg.inPlayablesEnv()) {
      setInterstitialHint("unavailable");
      patchDebug({
        lastAd: { kind: "interstitial", result: "skipped: not in Playables", at: now },
      });
      return;
    }
    lastInterstitialAtRef.current = now;
    const ok = await ytg.requestInterstitialAd();
    setInterstitialHint(ok ? "shown" : "unavailable");
    patchDebug({
      lastAd: {
        kind: "interstitial",
        result: ok ? "requested" : "failed/unavailable",
        at: Date.now(),
      },
      ...(ok ? {} : { lastError: "interstitial request failed" }),
    });
  }, [patchDebug]);


  const endGame = useCallback(() => {
    if (stateRef.current !== "playing" && stateRef.current !== "paused") return;
    stateRef.current = "over";
    setState("over");
    const engine = engineRef.current;
    engine?.stop();
    const total = totalRef.current || 1;
    const accuracy = Math.round((hitsRef.current / total) * 100);

    const prev = statsAll[difficulty];
    const newBestScore = scoreRef.current > prev.bestScore;
    const newBestCombo = bestComboRef.current > prev.bestCombo;

    const stats: FinalStats = {
      score: scoreRef.current,
      bestCombo: bestComboRef.current,
      accuracy,
      hits: hitsRef.current,
      total: totalRef.current,
      difficulty,
      bpm: engine?.bpm ?? DIFFICULTIES[difficulty].bpm,
      newBestScore,
      newBestCombo,
    };
    setFinalStats(stats);
    setRewardGranted(false);
    setRewardPending(false);

    // Compute final TypeSafe System One Evaluation Report
    const recent = hitDeltasRef.current.slice(-30);
    const jitter = computeStandardDeviation(recent);
    const mean = computeMean(recent);
    const totalJudged = hitsRef.current + missesRef.current || 1;
    const finalReport = evaluateRhythmTelemetry({
      recentHitDeltas: recent,
      jitterMs: jitter,
      meanDeltaMs: mean,
      perfectRatio: perfectHitsRef.current / totalJudged,
      greatRatio: greatHitsRef.current / totalJudged,
      missRatio: missesRef.current / totalJudged,
      currentCombo: bestComboRef.current,
      bestCombo: bestComboRef.current,
      recentConsecutiveMisses: consecutiveMissesRef.current,
      bpm: engine?.bpm ?? DIFFICULTIES[difficulty].bpm,
      difficulty,
      laneDistribution: [...laneDistributionRef.current],
      elapsedSeconds: Math.max(1, Math.floor((performance.now() - gameStartTimeRef.current) / 1000)),
    });
    setTypeSafeReport(finalReport);

    const next: AllStats = {
      ...statsAll,
      [difficulty]: {
        bestScore: Math.max(prev.bestScore, stats.score),
        bestCombo: Math.max(prev.bestCombo, stats.bestCombo),
        bestAccuracy: Math.max(prev.bestAccuracy, accuracy),
        plays: prev.plays + 1,
      },
    };
    setStatsAll(next);
    saveStats(next);
    // Push best-score to YouTube leaderboards and mirror stats to cloud save
    // (queued + retried on transient failure) using the current envelope.
    void ytg.sendScore(next[difficulty].bestScore);
    void queueCloudSave(encodeCloudPayload(next));


    try {
      const u = new URL(window.location.href);
      u.search = "";
      u.searchParams.set("s", String(stats.score));
      u.searchParams.set("c", String(stats.bestCombo));
      u.searchParams.set("a", String(accuracy));
      u.searchParams.set("d", stats.difficulty);
      setShareUrl(u.toString());
    } catch {
      setShareUrl("");
    }

    // Natural break: game over. Only if we didn't already show one this run.
    if (!shownInterstitialThisRunRef.current) {
      shownInterstitialThisRunRef.current = true;
      void tryInterstitial();
    }
  }, [difficulty, statsAll, tryInterstitial, queueCloudSave]);

  const startGame = useCallback(async () => {
    const cfg = DIFFICULTIES[difficulty];
    notesRef.current = [];
    noteIdRef.current = 0;
    scoreRef.current = 0;
    comboRef.current = 0;
    bestComboRef.current = 0;
    missesRef.current = 0;
    hitsRef.current = 0;
    totalRef.current = 0;
    judgementsRef.current = [];
    pulseRef.current = 0;
    laneFlashRef.current = [0, 0, 0, 0];
    hitWindowRef.current = cfg.hitWindow;
    perfectWindowRef.current = cfg.perfectWindow;
    setHud({ score: 0, combo: 0, misses: 0, best: 0 });
    hitDeltasRef.current = [];
    consecutiveMissesRef.current = 0;
    laneDistributionRef.current = [0, 0, 0, 0];
    particlesRef.current = [];
    ripplesRef.current = [];
    perfectHitsRef.current = 0;
    greatHitsRef.current = 0;
    gameStartTimeRef.current = performance.now();
    setTypeSafeReport(null);
    setFinalStats(null);
    setRewardGranted(false);
    setRewardPending(false);
    shownInterstitialThisRunRef.current = false;
    setInterstitialHint(null);

    // Stop any prior engine
    engineRef.current?.stop();

    const bpm = cfg.bpm + (Math.random() * 2 - 1) * cfg.bpmJitter;
    const engine = new ChiptuneEngine(bpm, cfg.density);
    engineRef.current = engine;
    await engine.resume();
    try {
      engine.master.gain.value = mutedRef.current ? 0 : 0.35;
    } catch {
      /* ignore */
    }

    stateRef.current = "playing";
    setState("playing");
    engine.start((beat, hitTime, lanes) => {
      if (beat < 8) return;
      for (const lane of lanes) {
        notesRef.current.push({
          id: noteIdRef.current++,
          lane,
          spawnAt: hitTime - NOTE_TRAVEL_MS / 1000,
          hitAt: hitTime,
          hit: false,
          missed: false,
          judged: false,
        });
        totalRef.current++;
      }
    });
  }, [difficulty]);

  const pauseGame = useCallback(() => {
    if (stateRef.current !== "playing") return;
    stateRef.current = "paused";
    setState("paused");
    engineRef.current?.pause();
    // Natural break: pause is a good spot for an interstitial (rate-limited).
    if (!shownInterstitialThisRunRef.current) {
      shownInterstitialThisRunRef.current = true;
      void tryInterstitial();
    }
  }, [tryInterstitial]);

  const resumeGame = useCallback(async () => {
    if (stateRef.current !== "paused") return;
    const drift = (await engineRef.current?.unpause()) ?? 0;
    if (drift > 0.005) {
      // Beat timing drift correction: shift all in-flight notes by the exact audio clock drift
      for (const n of notesRef.current) {
        if (!n.judged) {
          n.spawnAt += drift;
          n.hitAt += drift;
        }
      }
    }
    stateRef.current = "playing";
    setState("playing");
  }, []);

  const quitToMenu = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    notesRef.current = [];
    stateRef.current = "idle";
    setState("idle");
  }, []);

  const tapLane = useCallback((lane: number) => {
    if (stateRef.current !== "playing") return;
    const engine = engineRef.current;
    if (!engine) return;
    const now = engine.ctx.currentTime;
    const offset = latencyOffsetRef.current;
    let best: Note | null = null;
    let bestDelta = Infinity;
    for (const n of notesRef.current) {
      if (n.lane !== lane || n.judged) continue;
      const d = Math.abs((n.hitAt - now) * 1000 - offset);
      if (d < bestDelta) {
        bestDelta = d;
        best = n;
      }
    }
    laneFlashRef.current[lane] = 1;
    laneDistributionRef.current[lane]++;

    if (best && bestDelta <= hitWindowRef.current) {
      best.hit = true;
      best.judged = true;
      hitsRef.current++;
      comboRef.current++;
      if (comboRef.current > bestComboRef.current)
        bestComboRef.current = comboRef.current;

      // Realistic 8K Combo Milestone Burst every 10 combo streak
      if (comboRef.current > 0 && comboRef.current % 10 === 0) {
        const cEl = canvasRef.current;
        if (cEl) {
          const cW = cEl.getBoundingClientRect().width;
          const cH = cEl.getBoundingClientRect().height;
          const laneAreaW = Math.min(cW, 520);
          const laneAreaX = (cW - laneAreaW) / 2;
          const laneW = laneAreaW / LANES;
          const hitX = laneAreaX + lane * laneW + laneW / 2;
          const hitY = cH * HIT_LINE_RATIO;
          for (let p = 0; p < 28; p++) {
            const angle = Math.random() * Math.PI * 2;
            const spd = 3 + Math.random() * 6;
            particlesRef.current.push({
              x: hitX,
              y: hitY,
              vx: Math.cos(angle) * spd,
              vy: Math.sin(angle) * spd - 2,
              color: p % 2 === 0 ? "#ffe94a" : "#ff3ea5",
              size: 3 + Math.random() * 3,
              alpha: 1,
              life: 0,
              maxLife: 32,
              sparkle: true,
            });
          }
          judgementsRef.current.push({
            text: `${comboRef.current} COMBO!`,
            color: "#ffe94a",
            at: performance.now(),
          });
          if (typeof navigator !== "undefined" && "vibrate" in navigator) {
            try {
              navigator.vibrate?.([15, 30, 20]);
            } catch {
              /* ignore */
            }
          }
        }
      }

      const perfect = bestDelta <= perfectWindowRef.current;
      const gain = (perfect ? 100 : 50) * (1 + Math.floor(comboRef.current / 10) * 0.5);
      scoreRef.current += Math.round(gain);
      pulseRef.current = 1;

      // Realistic 8K Particle Physics & Shockwave Spawning
      const canvasEl = canvasRef.current;
      if (canvasEl) {
        const W = canvasEl.getBoundingClientRect().width;
        const H = canvasEl.getBoundingClientRect().height;
        const laneAreaW = Math.min(W, 520);
        const laneAreaX = (W - laneAreaW) / 2;
        const laneW = laneAreaW / LANES;
        const hitX = laneAreaX + lane * laneW + laneW / 2;
        const hitY = H * HIT_LINE_RATIO;
        const count = perfect ? 24 : 14;
        const baseColor = LANE_COLORS[lane];

        for (let p = 0; p < count; p++) {
          const angle = (Math.PI * 2 * p) / count + (Math.random() - 0.5) * 0.4;
          const speed = 2 + Math.random() * (perfect ? 5.5 : 3.5);
          particlesRef.current.push({
            x: hitX + (Math.random() - 0.5) * 18,
            y: hitY + (Math.random() - 0.5) * 8,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - (perfect ? 2 : 1),
            color: perfect && Math.random() > 0.4 ? "#ffffff" : baseColor,
            size: 2.5 + Math.random() * (perfect ? 3.5 : 2.5),
            alpha: 1,
            life: 0,
            maxLife: 22 + Math.floor(Math.random() * 16),
            sparkle: Math.random() > 0.4,
          });
        }

        ripplesRef.current.push({
          x: hitX,
          y: hitY,
          radius: 10,
          maxRadius: perfect ? 55 : 38,
          color: baseColor,
          alpha: 0.85,
        });
      }

      const signedDelta = (now - best.hitAt) * 1000 - offset;
      hitDeltasRef.current.push(signedDelta);
      if (perfect) {
        perfectHitsRef.current++;
      } else {
        greatHitsRef.current++;
      }
      consecutiveMissesRef.current = 0;

      // Apple-style tactile haptic feedback
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate?.(perfect ? 14 : 22);
        } catch {
          /* ignore */
        }
      }

      judgementsRef.current.push({
        text: perfect ? "PERFECT" : "GOOD",
        color: perfect ? "#ffe94a" : "#22e2ff",
        at: performance.now(),
      });
    } else {
      comboRef.current = 0;
      consecutiveMissesRef.current++;
      hitDeltasRef.current.push(115);

      const canvasEl = canvasRef.current;
      if (canvasEl) {
        const W = canvasEl.getBoundingClientRect().width;
        const H = canvasEl.getBoundingClientRect().height;
        const laneAreaW = Math.min(W, 520);
        const laneAreaX = (W - laneAreaW) / 2;
        const laneW = laneAreaW / LANES;
        const hitX = laneAreaX + lane * laneW + laneW / 2;
        const hitY = H * HIT_LINE_RATIO;
        for (let p = 0; p < 8; p++) {
          particlesRef.current.push({
            x: hitX + (Math.random() - 0.5) * 20,
            y: hitY,
            vx: (Math.random() - 0.5) * 3,
            vy: 1 + Math.random() * 3,
            color: "#ff3ea5",
            size: 2.2 + Math.random() * 2,
            alpha: 0.85,
            life: 0,
            maxLife: 20,
            sparkle: false,
          });
        }
      }

      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate?.(32);
        } catch {
          /* ignore */
        }
      }
      judgementsRef.current.push({
        text: "MISS",
        color: "#ff3ea5",
        at: performance.now(),
      });
    }

    // TypeSafe System One live evaluation stream
    if ((hitsRef.current + missesRef.current) % 4 === 0 && hitDeltasRef.current.length >= 3) {
      const recent = hitDeltasRef.current.slice(-24);
      const jitter = computeStandardDeviation(recent);
      const mean = computeMean(recent);
      const totalJudged = hitsRef.current + missesRef.current || 1;
      const rep = evaluateRhythmTelemetry({
        recentHitDeltas: recent,
        jitterMs: jitter,
        meanDeltaMs: mean,
        perfectRatio: perfectHitsRef.current / totalJudged,
        greatRatio: greatHitsRef.current / totalJudged,
        missRatio: missesRef.current / totalJudged,
        currentCombo: comboRef.current,
        bestCombo: bestComboRef.current,
        recentConsecutiveMisses: consecutiveMissesRef.current,
        bpm: engine.bpm,
        difficulty,
        laneDistribution: [...laneDistributionRef.current],
        elapsedSeconds: Math.max(1, Math.floor((performance.now() - gameStartTimeRef.current) / 1000)),
      });
      setTypeSafeReport(rep);
    }
  }, []);

  // keyboard input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      const idx = LANE_KEYS.indexOf(k as (typeof LANE_KEYS)[number]);
      if (idx >= 0 && stateRef.current === "playing") {
        e.preventDefault();
        setPressedLanes((p) => {
          const next = [...p];
          next[idx] = true;
          return next;
        });
        tapLane(idx);
      } else if (
        e.key === " " &&
        (stateRef.current === "idle" || stateRef.current === "over")
      ) {
        e.preventDefault();
        startGame();
      } else if (
        (e.key === "Escape" || k === "p") &&
        stateRef.current === "playing"
      ) {
        e.preventDefault();
        pauseGame();
      } else if (
        (e.key === "Escape" || k === "p") &&
        stateRef.current === "paused"
      ) {
        e.preventDefault();
        resumeGame();
      }
    };
    const upHandler = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const idx = LANE_KEYS.indexOf(k as (typeof LANE_KEYS)[number]);
      if (idx >= 0) {
        setPressedLanes((p) => {
          const next = [...p];
          next[idx] = false;
          return next;
        });
      }
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", upHandler);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", upHandler);
    };
  }, [tapLane, startGame, pauseGame, resumeGame]);

  // Visibility & YouTube coordination: pause/resume the game and AudioContext exactly
  // when the browser tab or YouTube environment suspends or resumes playback.
  useEffect(() => {
    const onVis = () => {
      const eng = engineRef.current;
      if (document.hidden) {
        // Tab backgrounded: pause gameplay and suspend audio context
        if (stateRef.current === "playing") {
          visibilityAutoPausedRef.current = true;
          stateRef.current = "paused";
          setState("paused");
        }
        if (eng) {
          try {
            eng.master.gain.value = 0;
            eng.pause();
          } catch {
            /* ignore */
          }
        }
      } else {
        // Tab restored to foreground
        const restoreGain = () => {
          if (!eng) return;
          try {
            eng.master.gain.value = mutedRef.current ? 0 : 0.35;
          } catch {
            /* ignore */
          }
        };

        // If paused automatically by visibility (and YouTube is not actively pausing)
        if (
          visibilityAutoPausedRef.current &&
          stateRef.current === "paused" &&
          !ytPausedRef.current
        ) {
          visibilityAutoPausedRef.current = false;
          void resumeGame().then(() => {
            restoreGain();
          });
        } else if (stateRef.current !== "paused" && !ytPausedRef.current) {
          void eng?.unpause().then(restoreGain);
        }
      }
    };

    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [resumeGame]);

  // main render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    // Resize handling: coalesce every source (window resize, orientation
    // change, visualViewport changes from the YouTube chrome / mobile URL bar,
    // and element-level layout changes) into a single rAF-debounced pass, and
    // skip no-op resizes so the canvas isn't cleared on every scroll tick.
    let resizeRaf = 0;
    const applyResize = () => {
      resizeRaf = 0;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const resize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(applyResize);
    };
    applyResize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", resize);
    vv?.addEventListener("scroll", resize);
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);


    const freqData = new Uint8Array(64);

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const engine = engineRef.current;

      const pulse = pulseRef.current;
      pulseRef.current *= 0.9;

      // 1. Deep Space Canvas Background with Dynamic Audio Pulse
      ctx.fillStyle = `rgba(10, 6, 22, ${0.88 - pulse * 0.2})`;
      ctx.fillRect(0, 0, W, H);

      // 2. Audio-Reactive Luminescent Aurora Wave
      if (engine) {
        engine.analyser.getByteFrequencyData(freqData);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < 32; i++) {
          const normX = (i / 31) * W;
          const val = freqData[i] / 255;
          const waveY = H - 35 - val * H * 0.38 - Math.sin(performance.now() * 0.002 + i * 0.28) * 10;
          if (i === 0) ctx.lineTo(normX, waveY);
          else {
            const prevX = ((i - 1) / 31) * W;
            const cpX = (prevX + normX) / 2;
            ctx.quadraticCurveTo(cpX, waveY, normX, waveY);
          }
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        const gradAurora = ctx.createLinearGradient(0, H - 260, 0, H);
        gradAurora.addColorStop(0, "rgba(255, 62, 165, 0.22)");
        gradAurora.addColorStop(0.5, "rgba(34, 226, 255, 0.16)");
        gradAurora.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = gradAurora;
        ctx.fill();
        ctx.restore();
      }

      // 3. Subtle Cybernetic Perspective Grid
      ctx.strokeStyle = `rgba(120, 60, 220, ${0.12 + pulse * 0.18})`;
      ctx.lineWidth = 1;
      for (let y = 0; y < H; y += 28) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      const laneAreaW = Math.min(W, 520);
      const laneAreaX = (W - laneAreaW) / 2;
      const laneW = laneAreaW / LANES;
      const hitY = H * HIT_LINE_RATIO;

      // 4. Lanes with Glossy Frosted Rail Highlights
      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW;
        const flash = laneFlashRef.current[i];
        laneFlashRef.current[i] *= 0.86;
        ctx.fillStyle = `rgba(255,255,255,${0.015 + flash * 0.12})`;
        ctx.fillRect(x, 0, laneW - 2, H);
        ctx.strokeStyle = `rgba(255,255,255,${0.06 + flash * 0.35})`;
        ctx.strokeRect(x, 0, laneW - 2, H);
      }

      // 5. Laser Voltage Beam Hitline (Multi-pass glow)
      ctx.save();
      // Ambient soft laser aura
      ctx.strokeStyle = `rgba(34, 226, 255, ${0.25 + pulse * 0.35})`;
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(laneAreaX, hitY);
      ctx.lineTo(laneAreaX + laneAreaW, hitY);
      ctx.stroke();

      // Electric beam
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.75 + pulse * 0.25})`;
      ctx.shadowColor = "#22e2ff";
      ctx.shadowBlur = 18;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(laneAreaX, hitY);
      ctx.lineTo(laneAreaX + laneAreaW, hitY);
      ctx.stroke();

      // Sharp white core
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(laneAreaX, hitY);
      ctx.lineTo(laneAreaX + laneAreaW, hitY);
      ctx.stroke();
      ctx.restore();

      // 6. Interactive Diamond Target Receptors at Hitline
      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW;
        const flash = laneFlashRef.current[i];
        const targetW = laneW - 14;
        const targetH = 14 + flash * 6;
        ctx.save();
        ctx.fillStyle = LANE_COLORS[i];
        ctx.shadowColor = LANE_COLORS[i];
        ctx.shadowBlur = 10 + flash * 24;
        ctx.globalAlpha = 0.28 + flash * 0.72;
        ctx.beginPath();
        ctx.roundRect(x + 7, hitY - targetH / 2, targetW, targetH, 7);
        ctx.fill();

        if (flash > 0.08) {
          ctx.fillStyle = "#ffffff";
          ctx.globalAlpha = flash * 0.95;
          ctx.beginPath();
          ctx.roundRect(x + 12, hitY - 3, targetW - 10, 6, 3);
          ctx.fill();
        }
        ctx.restore();
      }

      // 7. Realistic 8K 3D Rounded Note Capsules
      if (engine && stateRef.current === "playing") {
        const now = engine.ctx.currentTime;
        for (const n of notesRef.current) {
          if (n.judged) continue;
          const t = (now - n.spawnAt) / (NOTE_TRAVEL_MS / 1000);
          if (t < 0) continue;
          const y = t * hitY;
          const x = laneAreaX + n.lane * laneW + 6;
          const w = laneW - 14;
          const h = 26;
          const r = 8;
          const color = LANE_COLORS[n.lane];

          ctx.save();
          // Dynamic Neon Bloom
          ctx.shadowColor = color;
          ctx.shadowBlur = 18 + Math.sin(now * 8) * 4;

          // 3D Cylindrical Vertical Gradient
          const grad = ctx.createLinearGradient(x, y - h / 2, x, y + h / 2);
          grad.addColorStop(0, "#ffffff");
          grad.addColorStop(0.22, color);
          grad.addColorStop(0.85, color);
          grad.addColorStop(1, "rgba(0, 0, 0, 0.45)");
          ctx.fillStyle = grad;

          // Capsule Body
          ctx.beginPath();
          ctx.roundRect(x, y - h / 2, w, h, r);
          ctx.fill();

          // Glossy Glass Specular Sheen
          ctx.shadowBlur = 0;
          ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
          ctx.beginPath();
          ctx.roundRect(x + 4, y - h / 2 + 3, w - 8, 4, 2);
          ctx.fill();

          // High-Energy Core
          ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
          ctx.fillRect(x + w / 2 - 8, y - 1.5, 16, 3);
          ctx.restore();

          if ((now - n.hitAt) * 1000 > hitWindowRef.current + latencyOffsetRef.current) {
            n.judged = true;
            n.missed = true;
            comboRef.current = 0;
            missesRef.current++;
            consecutiveMissesRef.current++;
            hitDeltasRef.current.push(hitWindowRef.current + 20);
            judgementsRef.current.push({
              text: "MISS",
              color: "#ff3ea5",
              at: performance.now(),
            });
            if (missesRef.current >= MAX_MISSES) {
              endGame();
            }
          }
        }
        notesRef.current = notesRef.current.filter(
          (n) => !n.judged || (engine.ctx.currentTime - n.hitAt) < 1.5,
        );
      }

      // 8. Render Luminous Shockwave Ripples
      for (let i = ripplesRef.current.length - 1; i >= 0; i--) {
        const rip = ripplesRef.current[i];
        rip.radius += 2.4;
        rip.alpha *= 0.92;
        if (rip.alpha < 0.02 || rip.radius >= rip.maxRadius) {
          ripplesRef.current.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.strokeStyle = rip.color;
        ctx.shadowColor = rip.color;
        ctx.shadowBlur = 14;
        ctx.globalAlpha = rip.alpha;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(rip.x, rip.y, rip.radius, rip.radius * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 9. Render Physical Glowing Particle Sparks
      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const p = particlesRef.current[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.14; // gentle gravity
        p.vx *= 0.97;
        p.vy *= 0.97;
        p.life++;
        p.alpha = 1 - p.life / p.maxLife;

        if (p.life >= p.maxLife || p.alpha <= 0.01) {
          particlesRef.current.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.sparkle ? 14 : 6;
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 10. Keycap Labels at Lanes
      ctx.font = "12px 'VT323', monospace";
      ctx.textAlign = "center";
      for (let i = 0; i < LANES; i++) {
        const x = laneAreaX + i * laneW + laneW / 2;
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.fillText(LANE_KEYS[i].toUpperCase(), x, hitY + 28);
      }

      // 11. Judgements with Elevated Neon Glow
      const nowMs = performance.now();
      judgementsRef.current = judgementsRef.current.filter(
        (j) => nowMs - j.at < 600,
      );
      ctx.textAlign = "center";
      for (const j of judgementsRef.current) {
        const age = (nowMs - j.at) / 600;
        ctx.save();
        ctx.globalAlpha = 1 - age;
        ctx.font = "18px 'Press Start 2P', monospace";
        ctx.fillStyle = j.color;
        ctx.shadowColor = j.color;
        ctx.shadowBlur = 16;
        ctx.fillText(j.text, W / 2, hitY - 42 - age * 35);
        ctx.restore();
      }

      setHud((h) =>
        h.score === scoreRef.current &&
        h.combo === comboRef.current &&
        h.misses === missesRef.current &&
        h.best === bestComboRef.current
          ? h
          : {
              score: scoreRef.current,
              combo: comboRef.current,
              misses: missesRef.current,
              best: bestComboRef.current,
            },
      );

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      vv?.removeEventListener("resize", resize);
      vv?.removeEventListener("scroll", resize);
      ro?.disconnect();
    };
  }, [endGame]);

  const laneFromClientX = (host: HTMLElement, clientX: number) => {
    const rect = host.getBoundingClientRect();
    const rel = clientX - rect.left;
    if (rel < 0 || rel > rect.width) return -1;
    const lane = Math.floor((rel / rect.width) * LANES);
    return Math.max(0, Math.min(LANES - 1, lane));
  };

  // ---------- Tap gesture gating ----------
  // Certification dings games that let the browser synthesise scroll, zoom,
  // text-selection or double-tap gestures out of gameplay taps. We accept only
  // primary pointers while actually playing, swallow multi-finger pinches, and
  // keep focus on the play surface so keyboard input never escapes to chrome.
  const gestureBlockedRef = useRef(false);

  const onZonePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (stateRef.current !== "playing" || ytPausedRef.current) return;
    // A second simultaneous contact within the same finger-down means pinch —
    // still allow genuine two-lane taps, but never treat a pinch as a tap.
    if (!e.isPrimary && activeTouchesRef.current.size >= 2) return;
    if (gestureBlockedRef.current) return;
    const lane = laneFromClientX(e.currentTarget, e.clientX);
    if (lane < 0) return;
    activeTouchesRef.current.set(e.pointerId, lane);
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture unsupported / pointer already gone */
    }
    // Keep keyboard focus on the play surface (focus retention).
    playSurfaceRef.current?.focus?.({ preventScroll: true });
    tapLane(lane);
  };
  const onZonePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeTouchesRef.current.has(e.pointerId)) return;
    if (stateRef.current !== "playing") return;
    const lane = laneFromClientX(e.currentTarget, e.clientX);
    if (lane < 0) return;
    const prev = activeTouchesRef.current.get(e.pointerId);
    if (prev !== lane) {
      activeTouchesRef.current.set(e.pointerId, lane);
      tapLane(lane);
    }
  };
  const onZonePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activeTouchesRef.current.delete(e.pointerId);
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
  };

  // Document-level gesture suppression + focus retention while mounted.
  useEffect(() => {
    const surface = playSurfaceRef.current;
    const stop = (ev: Event) => {
      if (stateRef.current === "playing") ev.preventDefault();
    };
    // iOS Safari pinch-zoom gestures (non-standard but still fired).
    document.addEventListener("gesturestart", stop as EventListener, { passive: false });
    document.addEventListener("gesturechange", stop as EventListener, { passive: false });
    // Double-tap-to-zoom shows up as a dblclick on the surface.
    surface?.addEventListener("dblclick", stop, { passive: false });
    surface?.addEventListener("selectstart", stop);
    // Long-press callout on mobile.
    surface?.addEventListener("contextmenu", stop);
    // Multi-touch on the surface should never scroll the page.
    const onTouchMove = (ev: TouchEvent) => {
      if (stateRef.current === "playing") ev.preventDefault();
      if (ev.touches.length > 1) gestureBlockedRef.current = true;
    };
    const onTouchEnd = (ev: TouchEvent) => {
      if (ev.touches.length === 0) gestureBlockedRef.current = false;
    };
    surface?.addEventListener("touchmove", onTouchMove, { passive: false });
    surface?.addEventListener("touchend", onTouchEnd);
    surface?.addEventListener("touchcancel", onTouchEnd);

    // Focus retention: if focus drifts to browser chrome while playing, pull it
    // back to the play surface so key handlers keep working.
    const onBlur = () => {
      if (stateRef.current !== "playing") return;
      window.setTimeout(() => {
        if (document.activeElement === document.body) {
          playSurfaceRef.current?.focus?.({ preventScroll: true });
        }
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    surface?.focus?.({ preventScroll: true });

    return () => {
      document.removeEventListener("gesturestart", stop as EventListener);
      document.removeEventListener("gesturechange", stop as EventListener);
      surface?.removeEventListener("dblclick", stop);
      surface?.removeEventListener("selectstart", stop);
      surface?.removeEventListener("contextmenu", stop);
      surface?.removeEventListener("touchmove", onTouchMove);
      surface?.removeEventListener("touchend", onTouchEnd);
      surface?.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // ---------- Rewarded ad (bonus points on the score card) ----------
  const REWARD_BONUS_POINTS = 500;
  const REWARD_ID = "score-bonus-500";

  const claimRewardedBonus = useCallback(async () => {
    if (!finalStats || rewardGranted || rewardPending) return;
    setRewardPending(true);
    const startedAt = Date.now();
    const earned = await ytg.requestRewardedAd(REWARD_ID);
    setRewardPending(false);
    patchDebug({
      lastAd: {
        kind: "rewarded",
        result: earned ? "reward granted" : "not earned/unavailable",
        at: Date.now() - startedAt >= 0 ? Date.now() : startedAt,
      },
      ...(earned ? {} : { lastError: "rewarded ad not earned" }),
    });
    if (!earned) {
      // Graceful fallback: ad failed, wasn't watched to completion, or
      // Playables env is unavailable. Leave the button available for retry.
      return;
    }
    // Apply the bonus to the final-stats card and persist a new best if beaten.
    const bonusScore = finalStats.score + REWARD_BONUS_POINTS;
    const updated: FinalStats = {
      ...finalStats,
      score: bonusScore,
      newBestScore:
        finalStats.newBestScore || bonusScore > statsAll[finalStats.difficulty].bestScore,
    };
    setFinalStats(updated);
    setRewardGranted(true);

    const prev = statsAll[updated.difficulty];
    if (bonusScore > prev.bestScore) {
      const next: AllStats = {
        ...statsAll,
        [updated.difficulty]: { ...prev, bestScore: bonusScore },
      };
      setStatsAll(next);
      saveStats(next);
      void ytg.sendScore(bonusScore);
      void queueCloudSave(encodeCloudPayload(next));
    }


    // Refresh the share URL to reflect the bonused score.
    try {
      const u = new URL(window.location.href);
      u.search = "";
      u.searchParams.set("s", String(bonusScore));
      u.searchParams.set("c", String(updated.bestCombo));
      u.searchParams.set("a", String(updated.accuracy));
      u.searchParams.set("d", updated.difficulty);
      setShareUrl(u.toString());
    } catch {
      /* ignore */
    }
  }, [finalStats, rewardGranted, rewardPending, statsAll, queueCloudSave, patchDebug]);

  // ---------- Share ----------
  const buildShareText = (fs: FinalStats) =>
    `🕹️ Pixel Pulse Rush [${DIFFICULTIES[fs.difficulty].label}]\nScore ${fs.score} · Combo ${fs.bestCombo}x · ${fs.accuracy}% acc — beat my run:`;

  const shareScore = async () => {
    if (!finalStats) return;
    const text = buildShareText(finalStats);
    const url = shareUrl || window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Pixel Pulse Rush", text, url });
        return;
      }
    } catch {
      /* ignore */
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      alert("Score link copied to clipboard!");
    } catch {
      alert(`${text}\n${url}`);
    }
  };

  const copyShareLink = async () => {
    const url = shareUrl || window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      alert("Link copied!");
    } catch {
      prompt("Copy this link:", url);
    }
  };

  const socialLinks = useMemo(() => {
    if (!finalStats) return null;
    const text = buildShareText(finalStats);
    const url = shareUrl || (typeof window !== "undefined" ? window.location.href : "");
    const enc = encodeURIComponent;
    return {
      twitter: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}&quote=${enc(text)}`,
      reddit: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(`Pixel Pulse Rush — ${finalStats.score}`)}`,
      whatsapp: `https://api.whatsapp.com/send?text=${enc(`${text} ${url}`)}`,
    };
  }, [finalStats, shareUrl]);

  const buildCardCanvas = () => {
    if (!finalStats) return null;
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 630;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 1200, 630);
    grad.addColorStop(0, "#1a0836");
    grad.addColorStop(1, "#06222f");
    g.fillStyle = grad;
    g.fillRect(0, 0, 1200, 630);
    g.strokeStyle = "rgba(180,100,255,0.2)";
    for (let y = 0; y < 630; y += 32) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(1200, y);
      g.stroke();
    }
    const colors = ["#ff3ea5", "#22e2ff", "#ffe94a", "#5cff8a"];
    for (let i = 0; i < 40; i++) {
      g.fillStyle = colors[i % 4];
      g.globalAlpha = 0.3 + (i % 5) * 0.1;
      const bx = (i * 137) % 1200;
      const by = (i * 211) % 630;
      g.fillRect(bx, by, 20, 20);
    }
    g.globalAlpha = 1;
    g.fillStyle = "#ffe94a";
    g.font = "bold 64px monospace";
    g.fillText("PIXEL PULSE RUSH", 60, 110);
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "28px monospace";
    g.fillText(
      `${DIFFICULTIES[finalStats.difficulty].label} · ${Math.round(finalStats.bpm)} BPM`,
      60,
      155,
    );
    g.fillStyle = "#ff3ea5";
    g.font = "bold 180px monospace";
    g.fillText(String(finalStats.score), 60, 340);
    g.fillStyle = "#22e2ff";
    g.font = "36px monospace";
    g.fillText(`COMBO  ${finalStats.bestCombo}x`, 60, 430);
    g.fillText(`ACC    ${finalStats.accuracy}%`, 60, 480);
    g.fillText(`HITS   ${finalStats.hits}/${finalStats.total}`, 60, 530);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.font = "24px monospace";
    g.fillText("tap the beat · chase the combo", 60, 590);
    return c;
  };

  const downloadCard = () => {
    const c = buildCardCanvas();
    if (!c || !finalStats) return;
    const url = c.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `pixel-pulse-rush-${finalStats.score}.png`;
    a.click();
  };

  const downloadCardPdf = () => {
    const c = buildCardCanvas();
    if (!c || !finalStats) return;
    const imgData = c.toDataURL("image/jpeg", 0.92);
    const jpegBinary = atob(imgData.split(",")[1]);
    const jpegBytes = new Uint8Array(jpegBinary.length);
    for (let i = 0; i < jpegBinary.length; i++) jpegBytes[i] = jpegBinary.charCodeAt(i);

    const W = 1200;
    const H = 630;
    const parts: (string | Uint8Array)[] = [];
    const offsets: number[] = [];
    let pos = 0;
    const push = (s: string | Uint8Array) => {
      parts.push(s);
      pos += typeof s === "string" ? s.length : s.length;
    };
    const startObj = (n: number) => {
      offsets[n] = pos;
      push(`${n} 0 obj\n`);
    };
    push("%PDF-1.4\n%\xff\xff\xff\xff\n");
    startObj(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    startObj(2);
    push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    startObj(3);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    );
    startObj(4);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
    );
    push(jpegBytes);
    push("\nendstream\nendobj\n");
    const contentStream = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`;
    startObj(5);
    push(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`);
    const xrefStart = pos;
    push(`xref\n0 6\n0000000000 65535 f \n`);
    for (let i = 1; i <= 5; i++) {
      push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
    }
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

    const blobParts: BlobPart[] = parts.map((p) =>
      typeof p === "string" ? p : new Uint8Array(p),
    );
    const blob = new Blob(blobParts, { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pixel-pulse-rush-${finalStats.score}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ---------- Calibration ----------
  const calibRef = useRef<{
    ctx: AudioContext;
    startAt: number;
    interval: number;
    taps: number[];
    total: number;
  } | null>(null);
  const [calProgress, setCalProgress] = useState<
    | null
    | { taps: number; total: number; offset: number }
  >(null);

  const startCalibration = async () => {
    const Ctor: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext || window.AudioContext;
    const ctx = new Ctor();
    await ctx.resume();
    const interval = 0.5; // 120 BPM
    const total = 8;
    const startAt = ctx.currentTime + 0.8;
    for (let i = 0; i < total + 2; i++) {
      const when = startAt + i * interval;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = i === 0 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.3, when + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(when);
      o.stop(when + 0.12);
    }
    calibRef.current = { ctx, startAt, interval, taps: [], total };
    stateRef.current = "calibrating";
    setState("calibrating");
    setCalProgress({ taps: 0, total, offset: 0 });
  };

  const calibrationTap = () => {
    const c = calibRef.current;
    if (!c) return;
    const now = c.ctx.currentTime;
    const elapsed = now - c.startAt;
    if (elapsed < -0.1) return;
    const beatIdx = Math.max(0, Math.round(elapsed / c.interval));
    const beatTime = beatIdx * c.interval;
    const deltaMs = (elapsed - beatTime) * 1000;
    if (Math.abs(deltaMs) > 300) return; // reject wild taps
    c.taps.push(deltaMs);
    const avg = c.taps.reduce((a, b) => a + b, 0) / c.taps.length;
    setCalProgress({ taps: c.taps.length, total: c.total, offset: avg });
    if (c.taps.length >= c.total) finishCalibration(avg);
  };

  const finishCalibration = (offset: number) => {
    const clamped = Math.max(-150, Math.min(150, Math.round(offset)));
    latencyOffsetRef.current = clamped;
    setLatencyOffset(clamped);
    saveOffset(clamped);
    const c = calibRef.current;
    if (c) {
      try {
        c.ctx.close();
      } catch {
        /* ignore */
      }
    }
    calibRef.current = null;
    setCalProgress(null);
    stateRef.current = "idle";
    setState("idle");
  };

  const cancelCalibration = () => {
    const c = calibRef.current;
    if (c) {
      try {
        c.ctx.close();
      } catch {
        /* ignore */
      }
    }
    calibRef.current = null;
    setCalProgress(null);
    stateRef.current = "idle";
    setState("idle");
  };

  const resetCalibration = () => {
    latencyOffsetRef.current = 0;
    setLatencyOffset(0);
    saveOffset(0);
  };

  const diffKeys = useMemo(() => Object.keys(DIFFICULTIES) as Difficulty[], []);

  return (
    <div className="h-screen w-screen max-h-screen overflow-hidden flex flex-col items-center justify-between p-2 sm:p-3 relative font-apple select-none touch-none bg-[#06040d]">
      {/* Dynamic Apple Spatial Ambient Lighting */}
      <div
        className="apple-ambient-glow fixed -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[400px] rounded-full opacity-40 blur-[100px] pointer-events-none -z-10"
        style={{
          background:
            hud.combo > 20
              ? "radial-gradient(ellipse, rgba(255, 62, 165, 0.45) 0%, rgba(41, 151, 255, 0.25) 50%, transparent 80%)"
              : "radial-gradient(ellipse, rgba(41, 151, 255, 0.35) 0%, rgba(255, 62, 165, 0.2) 50%, transparent 80%)",
        }}
      />

      {/* Apple Liquid Glass Arcade Top Bar */}
      <div className="w-full max-w-[500px] apple-glass rounded-2xl px-3 py-1.5 flex items-center justify-between border border-white/12 shadow-xl shadow-black/40 z-20">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-xl bg-gradient-to-tr from-[var(--neon-pink)] via-[#7b2cbf] to-[#0066cc] p-0.5 shadow-md shadow-pink-500/25">
            <Gamepad2 className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-white text-xs sm:text-sm tracking-tight leading-none font-apple">
                PIXEL PULSE RUSH
              </span>
              <span className="px-1.5 py-0.5 text-[8px] font-mono uppercase rounded-full bg-pink-500/20 text-pink-300 border border-pink-400/30">
                ARCADE
              </span>
            </div>
            <div className="text-[9px] text-white/50 font-apple flex items-center gap-2 mt-0.5">
              <span>{engineRef.current ? Math.round(engineRef.current.bpm) : DIFFICULTIES[difficulty].bpm} BPM</span>
              <span>·</span>
              <span>HI-SCORE {statsAll[difficulty].bestScore}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* TypeSafe Neural Engine Pill */}
          <button
            onClick={() => {
              playUiSfx("click");
              setNeuralDrawerOpen(true);
            }}
            className="apple-interactive flex items-center gap-1 px-2 py-1 rounded-full bg-blue-500/15 border border-blue-400/30 text-[#2997ff] text-[10px] font-semibold"
            title="Open TypeSafe System One Neural Rhythm Inspector"
          >
            <Brain className="w-3.5 h-3.5 animate-pulse text-[#2997ff]" />
            <span className="hidden xs:inline">
              {typeSafeReport ? typeSafeReport.rhythmPrecision.levelName : "AI Router"}
            </span>
          </button>

          {/* Fullscreen Toggle Button */}
          <button
            onClick={() => {
              playUiSfx("click");
              toggleFullscreen();
            }}
            aria-label={isFullscreen ? "Exit Fullscreen Arcade" : "Enter Fullscreen Arcade"}
            className="apple-interactive p-1.5 rounded-full bg-white/10 hover:bg-white/15 text-white/80 hover:text-white border border-white/10"
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen Arcade"}
          >
            {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
          </button>

          {/* Sound Mute Toggle */}
          <button
            onClick={() => {
              playUiSfx("click");
              toggleMute();
            }}
            aria-label={soundMuted ? "Unmute Audio" : "Mute Audio"}
            className="apple-interactive p-1.5 rounded-full bg-white/10 hover:bg-white/15 text-white/80 hover:text-white border border-white/10"
            title={soundMuted ? "Unmute Audio" : "Mute Audio"}
          >
            {soundMuted ? <VolumeX className="w-3.5 h-3.5 text-red-400" /> : <Volume2 className="w-3.5 h-3.5 text-[#5cff8a]" />}
          </button>
        </div>
      </div>

      {/* Main Game Stage Chassis */}
      <div className="relative w-full max-w-[500px] flex-1 flex flex-col items-center justify-center min-h-0">
        <div
          ref={playSurfaceRef}
          tabIndex={0}
          role="application"
          aria-label="Pixel Pulse Rush play surface"
          style={{ touchAction: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
          className="relative w-full aspect-[9/16] max-h-[calc(100vh-140px)] rounded-3xl overflow-hidden border border-white/18 scanlines shadow-[0_25px_60px_-10px_rgba(0,0,0,0.95),inset_0_1px_0_0_rgba(255,255,255,0.3)] outline-none select-none touch-none focus-visible:ring-2 focus-visible:ring-[#2997ff]"
        >
          {/* Realistic 8K Curved Arcade Glass Sheen & Vignette */}
          <div className="apple-glass-sheen absolute inset-0 z-10 pointer-events-none" />
          <div className="apple-vignette absolute inset-0 z-10 pointer-events-none" />

          {/* Apple Dynamic Island (Adaptive Floating Top HUD) */}
          <div
            onClick={() => setNeuralDrawerOpen(true)}
            className="apple-dynamic-island absolute top-3 left-1/2 -translate-x-1/2 z-30 px-3.5 py-1.5 flex items-center gap-2.5 cursor-pointer hover:scale-105 active:scale-95 text-white shadow-xl"
            title="TypeSafe AI Dynamic Island · Tap to inspect"
          >
            {/* Live Audio Visualizer Waveform Dots */}
            <div className="flex items-center gap-0.5 h-3">
              <span className="w-0.5 h-full bg-[#ff3ea5] rounded-full animate-pulse" />
              <span className="w-0.5 h-2 bg-[#22e2ff] rounded-full animate-pulse delay-75" />
              <span className="w-0.5 h-3 bg-[#ffe94a] rounded-full animate-pulse delay-150" />
              <span className="w-0.5 h-1.5 bg-[#5cff8a] rounded-full animate-pulse delay-100" />
            </div>

            <div className="text-[10px] font-apple font-semibold tracking-tight flex items-center gap-1.5">
              <span className="text-[#2997ff]">
                {typeSafeReport ? typeSafeReport.rhythmPrecision.levelName : "Locked-In"}
              </span>
              <span className="text-white/40">·</span>
              <span className="text-glow-yellow font-mono">{hud.score}</span>
              {hud.combo > 5 && (
                <span className="px-1.5 py-0.5 rounded-full bg-pink-500/25 border border-pink-400/40 text-[9px] font-bold text-glow-pink animate-pulse">
                  {hud.combo}x
                </span>
              )}
              {state === "playing" && typeSafeReport?.derivedAdjustments?.statusBadge && (
                <>
                  <span className="text-white/40">·</span>
                  <span className="text-[9px] text-[#5cff8a] font-mono tracking-tight font-medium">
                    {typeSafeReport.derivedAdjustments.statusBadge}
                  </span>
                </>
              )}
            </div>
          </div>

          <canvas
            ref={canvasRef}
            className="w-full h-full block touch-none select-none pointer-events-none"
          />

          {state === "playing" && (
            <div
              className="absolute left-0 right-0 flex touch-none select-none"
              style={{
                top: `${HIT_LINE_RATIO * 100 - 30}%`,
                bottom: 0,
              }}
              onPointerDown={onZonePointerDown}
              onPointerMove={onZonePointerMove}
              onPointerUp={onZonePointerUp}
              onPointerCancel={onZonePointerUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              {Array.from({ length: LANES }).map((_, i) => (
                <div
                  key={i}
                  className="flex-1 border-x border-white/5 active:bg-white/10 transition-colors"
                  style={{
                    background: `linear-gradient(to top, ${LANE_COLORS[i]}22, transparent)`,
                  }}
                  aria-label={`Lane ${i + 1}`}
                />
              ))}
            </div>
          )}

          {/* Miss pips (Apple rounded glass pips) */}
          <div className="absolute top-3 left-3 flex gap-1.5 z-20">
            {Array.from({ length: MAX_MISSES }).map((_, i) => (
              <div
                key={i}
                className="w-3.5 h-3.5 rounded-full transition-all duration-200"
                style={{
                  background:
                    i < hud.misses ? "rgba(255,255,255,0.12)" : "var(--neon-pink)",
                  border: i < hud.misses ? "1px solid rgba(255,255,255,0.2)" : "1px solid var(--neon-pink)",
                  boxShadow:
                    i < hud.misses ? "none" : "0 0 10px var(--neon-pink)",
                }}
              />
            ))}
          </div>



          {/* Pause button during play */}
          {state === "playing" && (
            <button
              onClick={() => { playUiSfx("pause"); pauseGame(); }}
              aria-label="Pause"
              className="apple-interactive absolute top-3 right-3 z-20 font-apple text-[10px] font-semibold px-3 py-1.5 rounded-full bg-black/60 border border-white/20 text-white/90 backdrop-blur-md hover:bg-black/80 flex items-center gap-1"
            >
              <span>❚❚</span>
              <span>PAUSE</span>
            </button>
          )}

          {/* Idle / Start Overlay */}
          {state === "idle" && (
            <Overlay>
              <div className="apple-glass-card w-full max-w-[340px] p-5 sm:p-6 border border-white/15 shadow-2xl flex flex-col items-center">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-[var(--neon-pink)] to-[#0066cc] p-0.5 shadow-lg shadow-pink-500/30 mb-3 flex items-center justify-center">
                  <span className="text-white text-xl font-display">⚡</span>
                </div>

                <h2 className="font-display text-glow-pink text-base sm:text-xl mb-1 text-center">
                  PIXEL PULSE RUSH
                </h2>
                <p className="text-xs text-white/60 mb-4 text-center font-apple">
                  Tap neon blocks on the beat line. Miss 3 and pulse flatlines.
                </p>

                {challenge && (
                  <div className="mb-3 px-3 py-1.5 rounded-xl border border-[var(--neon-yellow)]/40 bg-[var(--neon-yellow)]/10 text-[11px] text-glow-yellow max-w-xs text-center">
                    CHALLENGE · {DIFFICULTIES[challenge.diff].label} · {challenge.score} pts · {challenge.combo}x
                  </div>
                )}

                {/* Apple Segmented Control for Difficulty */}
                <div className="w-full mb-3.5">
                  <div className="text-[10px] font-semibold text-white/60 mb-1.5 tracking-wider font-apple text-center uppercase">
                    DIFFICULTY MODE
                  </div>
                  <div className="apple-glass-pill p-1 rounded-xl flex items-center justify-between border border-white/10">
                    {diffKeys.map((k) => (
                      <button
                        key={k}
                        onClick={() => { playUiSfx("diff"); setDifficulty(k); }}
                        className={`apple-interactive flex-1 py-1.5 px-2 rounded-lg text-xs font-apple transition-all duration-150 ${
                          difficulty === k
                            ? "bg-white/20 text-white font-semibold shadow-sm border border-white/25"
                            : "text-white/60 hover:text-white"
                        }`}
                      >
                        {DIFFICULTIES[k].label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-[10px] text-white/50 min-h-[1.8em] font-apple text-center">
                    {DIFFICULTIES[difficulty].blurb}
                  </div>
                </div>

                {/* Per-difficulty stats card */}
                <div className="w-full mb-4 apple-glass-pill p-2.5 rounded-xl border border-white/10">
                  <div className="text-[10px] font-semibold text-[#2997ff] mb-1.5 tracking-wider font-apple text-left uppercase flex items-center justify-between">
                    <span>Personal Best · {DIFFICULTIES[difficulty].label}</span>
                    <Trophy className="w-3.5 h-3.5 text-yellow-400" />
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-left font-mono">
                    <div>
                      <div className="text-[8px] text-white/50">SCORE</div>
                      <div className="text-glow-yellow text-xs font-bold">
                        {statsAll[difficulty].bestScore}
                      </div>
                    </div>
                    <div>
                      <div className="text-[8px] text-white/50">COMBO</div>
                      <div className="text-glow-pink text-xs font-bold">
                        {statsAll[difficulty].bestCombo}x
                      </div>
                    </div>
                    <div>
                      <div className="text-[8px] text-white/50">ACC</div>
                      <div className="text-glow-cyan text-xs font-bold">
                        {statsAll[difficulty].bestAccuracy}%
                      </div>
                    </div>
                    <div>
                      <div className="text-[8px] text-white/50">RUNS</div>
                      <div className="text-white text-xs font-bold">
                        {statsAll[difficulty].plays}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Start Button */}
                <button
                  onClick={() => { playUiSfx("start"); startGame(); }}
                  className="apple-interactive w-full font-apple font-bold text-xs sm:text-sm py-3 px-6 rounded-xl bg-gradient-to-r from-[var(--neon-pink)] to-[#0066cc] text-white shadow-lg shadow-pink-500/25 hover:brightness-110 active:scale-95 flex items-center justify-center gap-2 mb-3"
                >
                  <Play className="w-4 h-4 fill-white" />
                  PRESS START
                </button>

                {/* Physical Keycaps */}
                <div className="flex items-center justify-center gap-1.5 text-[11px] text-white/70 font-apple mb-2">
                  <span>Keys:</span>
                  <span className="apple-keycap">D</span>
                  <span className="apple-keycap">F</span>
                  <span className="apple-keycap">J</span>
                  <span className="apple-keycap">K</span>
                  <span className="text-white/40">·</span>
                  <span className="apple-keycap">SPACE</span>
                </div>

                {/* Calibration pill */}
                <div className="flex gap-2 items-center text-[10px] font-mono text-white/50">
                  <button
                    onClick={startCalibration}
                    className="apple-interactive px-2 py-0.5 rounded border border-white/20 text-white/70 hover:text-white"
                  >
                    CALIBRATE
                  </button>
                  <span>
                    offset {latencyOffset >= 0 ? "+" : ""}
                    {latencyOffset}ms
                  </span>
                  {latencyOffset !== 0 && (
                    <button onClick={resetCalibration} className="underline hover:text-white">
                      reset
                    </button>
                  )}
                </div>
              </div>
            </Overlay>
          )}

          {/* Paused Screen Overlay */}
          {state === "paused" && (
            <Overlay>
              <div className="apple-glass-card w-full max-w-[280px] p-6 border border-white/15 shadow-2xl flex flex-col items-center">
                <h2 className="font-display text-glow-cyan text-xl mb-3">PAUSED</h2>
                <div className="text-sm mb-4 space-y-1 text-center font-mono">
                  <div>
                    <span className="text-glow-yellow">SCORE</span> {hud.score}
                  </div>
                  <div>
                    <span className="text-glow-pink">COMBO</span> {hud.combo}x · BEST {hud.best}x
                  </div>
                </div>
                <div className="flex flex-col gap-2.5 w-full">
                  <button
                    onClick={() => { playUiSfx("start"); resumeGame(); }}
                    className="apple-interactive font-apple font-bold text-xs py-2.5 px-4 rounded-xl bg-[var(--neon-green)] text-black hover:brightness-110 shadow-lg shadow-green-500/20"
                  >
                    ▶ RESUME
                  </button>
                  <button
                    onClick={startGame}
                    className="apple-interactive font-apple font-bold text-xs py-2.5 px-4 rounded-xl bg-[var(--neon-yellow)] text-black hover:brightness-110 shadow-lg shadow-yellow-500/20"
                  >
                    ↻ RESTART
                  </button>
                  <button
                    onClick={quitToMenu}
                    className="apple-interactive font-apple text-xs py-2 px-4 rounded-xl border border-white/20 text-white/80 hover:bg-white/10"
                  >
                    QUIT TO MENU
                  </button>
                </div>
                <AdHint hint={interstitialHint} retry={debug.saveRetry} />
              </div>
            </Overlay>
          )}

          {/* Calibration Screen */}
          {state === "calibrating" && calProgress && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center text-center bg-black/75 backdrop-blur-md px-4 z-10 touch-none select-none"
              onPointerDown={(e) => {
                e.preventDefault();
                calibrationTap();
              }}
            >
              <div className="apple-glass-card p-6 rounded-2xl max-w-xs border border-white/15">
                <h2 className="font-display text-glow-yellow text-base sm:text-xl mb-2">
                  CALIBRATE
                </h2>
                <p className="text-[12px] text-white/60 mb-4 font-apple">
                  Tap anywhere in time with the beeps to align timing to your hardware audio latency.
                </p>
                <div className="font-display text-glow-cyan text-3xl mb-2">
                  {calProgress.taps} / {calProgress.total}
                </div>
                <div className="text-xs text-white/70 mb-4 font-mono">
                  offset {calProgress.offset >= 0 ? "+" : ""}
                  {Math.round(calProgress.offset)}ms
                </div>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelCalibration();
                    }}
                    className="apple-interactive font-apple text-[11px] px-3.5 py-1.5 rounded-lg border border-white/30 text-white/80 hover:bg-white/10"
                  >
                    CANCEL
                  </button>
                  {calProgress.taps >= 3 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        finishCalibration(calProgress.offset);
                      }}
                      className="apple-interactive font-apple font-bold text-[11px] px-3.5 py-1.5 rounded-lg bg-[var(--neon-green)] text-black"
                    >
                      SAVE
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Game Over Screen */}
          {state === "over" && finalStats && (
            <Overlay>
              <div className="apple-glass-card w-full max-w-[340px] p-5 sm:p-6 border border-white/15 shadow-2xl flex flex-col items-center max-h-[85vh] overflow-y-auto">
                <h2 className="font-display text-glow-pink text-lg sm:text-2xl mb-0.5">
                  FLATLINE
                </h2>
                <div className="text-[10px] font-mono text-white/60 mb-2 uppercase tracking-wider">
                  {DIFFICULTIES[finalStats.difficulty].label} · {Math.round(finalStats.bpm)} BPM
                </div>
                <div className="font-display text-glow-yellow text-4xl sm:text-5xl mb-2">
                  {finalStats.score}
                </div>

                {(finalStats.newBestScore || finalStats.newBestCombo) && (
                  <div className="mb-3 px-3 py-1 rounded-full bg-pink-500/20 border border-pink-400/40 text-[10px] font-apple font-bold text-glow-pink animate-pulse">
                    {finalStats.newBestScore ? "★ NEW BEST SCORE! " : ""}
                    {finalStats.newBestCombo ? "★ NEW BEST COMBO!" : ""}
                  </div>
                )}

                {/* Score breakdown grid */}
                <div className="grid grid-cols-3 gap-2 w-full mb-3 text-center font-mono">
                  <div className="apple-glass-pill p-2 rounded-xl border border-white/10">
                    <div className="text-[9px] text-white/50">COMBO</div>
                    <div className="text-glow-pink text-sm font-bold">{finalStats.bestCombo}x</div>
                  </div>
                  <div className="apple-glass-pill p-2 rounded-xl border border-white/10">
                    <div className="text-[9px] text-white/50">ACCURACY</div>
                    <div className="text-glow-cyan text-sm font-bold">{finalStats.accuracy}%</div>
                  </div>
                  <div className="apple-glass-pill p-2 rounded-xl border border-white/10">
                    <div className="text-[9px] text-white/50">HITS</div>
                    <div className="text-white text-sm font-bold">{finalStats.hits}/{finalStats.total}</div>
                  </div>
                </div>

                {/* TypeSafe System One Neural Evaluation Report Card */}
                {typeSafeReport && (
                  <div className="w-full mb-3 apple-glass-card p-3 rounded-xl border border-blue-400/20 text-left">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-semibold text-[#2997ff] flex items-center gap-1 font-apple">
                        <Brain className="w-3.5 h-3.5 text-[#2997ff]" />
                        TypeSafe™ System One Evaluation
                      </span>
                      <span className="text-[10px] font-mono text-[#ffe94a] font-bold">
                        {typeSafeReport.rhythmPrecision.levelName}
                      </span>
                    </div>
                    <div className="text-[11px] text-white/80 font-apple mb-1">
                      <span className="text-white/50 font-normal">Archetype: </span>
                      <span className="font-semibold text-white">
                        {typeSafeReport.playerArchetype.distribution.find(d => d.id === typeSafeReport.playerArchetype.selected)?.label}
                      </span>
                    </div>
                    <div className="text-[10px] text-white/60 font-apple italic">
                      "{typeSafeReport.derivedAdjustments.coachingTip}"
                    </div>
                  </div>
                )}

                {/* Rewarded Ad Bonus */}
                <div className="mb-3 w-full">
                  <button
                    onClick={claimRewardedBonus}
                    disabled={rewardGranted || rewardPending}
                    className="apple-interactive w-full font-apple font-semibold text-[11px] px-4 py-2.5 rounded-xl bg-gradient-to-r from-[var(--neon-pink)] to-[var(--neon-yellow)] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
                  >
                    {rewardGranted
                      ? `✓ +${REWARD_BONUS_POINTS} BONUS APPLIED`
                      : rewardPending
                        ? "LOADING AD…"
                        : `🎁 WATCH AD · +${REWARD_BONUS_POINTS} PTS`}
                  </button>
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2 justify-center w-full mb-3">
                  <button
                    onClick={startGame}
                    className="apple-interactive flex-1 font-apple font-bold text-xs py-2 px-3 rounded-xl bg-[var(--neon-pink)] text-black hover:brightness-110 shadow-md shadow-pink-500/20"
                  >
                    RETRY
                  </button>
                  <button
                    onClick={quitToMenu}
                    className="apple-interactive flex-1 font-apple text-xs py-2 px-3 rounded-xl border border-white/20 text-white/80 hover:bg-white/10"
                  >
                    MENU
                  </button>
                  <button
                    onClick={shareScore}
                    className="apple-interactive flex-1 font-apple font-semibold text-xs py-2 px-3 rounded-xl bg-[var(--neon-cyan)] text-black hover:brightness-110"
                  >
                    SHARE
                  </button>
                </div>

                <div className="flex gap-2 justify-center w-full">
                  <button
                    onClick={copyShareLink}
                    className="apple-interactive text-[10px] px-3 py-1.5 rounded-lg border border-white/20 text-white/70 hover:text-white"
                  >
                    COPY LINK
                  </button>
                  <button
                    onClick={downloadCard}
                    className="apple-interactive text-[10px] px-3 py-1.5 rounded-lg bg-[var(--neon-yellow)] text-black font-semibold"
                  >
                    PNG
                  </button>
                  <button
                    onClick={downloadCardPdf}
                    className="apple-interactive text-[10px] px-3 py-1.5 rounded-lg bg-[var(--neon-green)] text-black font-semibold"
                  >
                    PDF
                  </button>
                </div>

                {socialLinks && (
                  <div className="flex gap-2 justify-center text-[10px] font-mono mt-3">
                    <a
                      href={socialLinks.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-0.5 rounded border border-white/20 hover:text-white"
                    >
                      X
                    </a>
                    <a
                      href={socialLinks.facebook}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-0.5 rounded border border-white/20 hover:text-white"
                    >
                      FB
                    </a>
                    <a
                      href={socialLinks.reddit}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-0.5 rounded border border-white/20 hover:text-white"
                    >
                      REDDIT
                    </a>
                    <a
                      href={socialLinks.whatsapp}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-0.5 rounded border border-white/20 hover:text-white"
                    >
                      WA
                    </a>
                  </div>
                )}
                <AdHint hint={interstitialHint} retry={debug.saveRetry} />
              </div>
            </Overlay>
          )}

          <DebugOverlay open={debugOpen} info={debug} onClose={() => setDebugOpen(false)} />
        </div>

        {/* Physical 4-Lane Arcade Push-Button Deck */}
        <div className="w-full max-w-[500px] grid grid-cols-4 gap-2 px-1 pt-2 pb-0.5 z-20">
          {Array.from({ length: LANES }).map((_, i) => (
            <button
              key={i}
              onPointerDown={(e) => {
                e.preventDefault();
                setPressedLanes((p) => {
                  const n = [...p];
                  n[i] = true;
                  return n;
                });
                tapLane(i);
              }}
              onPointerUp={() => {
                setPressedLanes((p) => {
                  const n = [...p];
                  n[i] = false;
                  return n;
                });
              }}
              onPointerLeave={() => {
                setPressedLanes((p) => {
                  const n = [...p];
                  n[i] = false;
                  return n;
                });
              }}
              aria-label={`Lane ${i + 1} (${LANE_KEYS[i].toUpperCase()})`}
              className={`arcade-button arcade-button-${["pink", "cyan", "yellow", "green"][i]} ${
                pressedLanes[i] ? "arcade-pressed" : ""
              } flex flex-col items-center justify-center py-2 sm:py-2.5 rounded-xl transition-all cursor-pointer select-none touch-none`}
            >
              <span
                className="text-xs sm:text-sm font-black font-mono tracking-wider"
                style={{ color: LANE_COLORS[i] }}
              >
                {LANE_KEYS[i].toUpperCase()}
              </span>
              <span className="text-[9px] font-apple text-white/50 tracking-tighter uppercase font-semibold">
                LANE {i + 1}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* TypeSafe System One Neural Rhythm Inspector Modal */}
      <TypeSafeNeuralInspector
        open={neuralDrawerOpen}
        onClose={() => setNeuralDrawerOpen(false)}
        report={typeSafeReport}
        currentBpm={engineRef.current ? Math.round(engineRef.current.bpm) : DIFFICULTIES[difficulty].bpm}
        combo={hud.combo}
      />
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center bg-black/65 backdrop-blur-md px-4 z-10 overflow-y-auto py-6 animate-in fade-in zoom-in-[0.98] duration-200">
      {children}
    </div>
  );
}

/**
 * Small non-disruptive line explaining ad state on pause/game-over.
 * Always renders (fixed height) so the button layout doesn't shift.
 */
function AdHint({ hint, retry }: { hint: InterstitialHint; retry?: SaveRetryState }) {
  const text =
    hint === "cooldown"
      ? "ad on cooldown — next break eligible in ~90s"
      : hint === "unavailable"
        ? "no ad available right now"
        : hint === "shown"
          ? "ad requested"
          : "";
  const retryText =
    !retry || retry.state === "idle"
      ? ""
      : retry.state === "abandoned"
        ? `stats couldn't sync — saved on this device only (${retry.attempts}/${retry.maxAttempts} tries)`
        : retry.state === "backoff"
          ? `syncing stats — retry ${retry.attempts}/${retry.maxAttempts}${
              retry.nextAttemptAt
                ? ` in ~${Math.max(0, Math.ceil((retry.nextAttemptAt - Date.now()) / 1000))}s`
                : ""
            }`
          : "syncing stats…";
  return (
    <div className="mt-3 min-h-[14px] text-[9px] font-mono tracking-wide text-white/50">
      <div>{text}</div>
      {retryText && (
        <div className={retry?.state === "abandoned" ? "text-glow-pink" : "text-white/45"}>
          {retryText}
        </div>
      )}
    </div>
  );
}

/**
 * Hidden diagnostics panel — toggle with backtick (`) or ?debug=1.
 * Non-blocking (pointer-events-none body) so it never intercepts gameplay taps.
 * Renders cloud payload version, migration status, ad request results, save
 * queue depth, and the last error we saw.
 */
function DebugOverlay({
  open,
  info,
  onClose,
}: {
  open: boolean;
  info: DebugInfo;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const fmt = (t: number) =>
    t ? new Date(t).toLocaleTimeString(undefined, { hour12: false }) : "—";

  const exportDebugJson = () => {
    try {
      const blob = {
        exportedAt: new Date().toISOString(),
        cloudSave: {
          schemaVersion: info.cloudSchemaVersion,
          sourceVersion: info.cloudSourceVersion,
          migrationStatus: info.cloudMigrationStatus,
          lastSave: info.lastSave,
          retryQueue: {
            depth: info.saveQueueDepth,
            attempts: info.saveQueueAttempts,
            retryState: info.saveRetry,
          },
        },
        cloudAnalytics: info.cloudAnalytics ?? getCloudSaveAnalyticsSummary(),
        recentEvents: getAllCloudSaveAnalyticsEvents(),
        adState: {
          lastAd: info.lastAd,
        },
        environment: {
          inPlayables: info.inPlayables,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
          url: typeof window !== "undefined" ? window.location.href : "",
          visibilityState: typeof document !== "undefined" ? document.visibilityState : "unknown",
        },
        diagnostics: {
          lastError: info.lastError,
          errorLog: info.errorLog,
        },
      };

      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(JSON.stringify(blob, null, 2));
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy debug JSON:", err);
    }
  };

  return (
    <div className="pointer-events-none absolute top-2 right-2 z-30 max-w-[280px] text-[10px] font-mono leading-tight">
      <div className="pointer-events-auto rounded border border-[var(--neon-cyan)]/60 bg-black/85 p-2 text-white/85 shadow-[0_0_18px_-4px_var(--neon-cyan)]">
        <div className="flex items-center justify-between mb-1.5 pb-1 border-b border-white/10">
          <span className="text-glow-cyan font-display text-[9px]">DEBUG</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={exportDebugJson}
              className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white text-[9px] border border-white/20 font-mono transition-colors"
              title="Copy current debug state and retry queue as JSON blob"
            >
              {copied ? "✓ Copied!" : "📋 Copy JSON"}
            </button>
            <button
              onClick={onClose}
              className="text-white/60 hover:text-white text-[10px] px-1"
              aria-label="Close debug overlay"
            >
              ×
            </button>
          </div>
        </div>
        <div>
          cloud v: <span className="text-glow-yellow">{info.cloudSchemaVersion}</span>
          {" · src: "}
          <span className="text-glow-yellow">{info.cloudSourceVersion ?? "—"}</span>
        </div>
        <div>
          migration: <span className="text-glow-pink">{info.cloudMigrationStatus}</span>
        </div>
        <div>
          playables env:{" "}
          <span className={info.inPlayables ? "text-glow-cyan" : "text-white/50"}>
            {info.inPlayables ? "yes" : "no"}
          </span>
        </div>
        <div className="mt-1 border-t border-white/10 pt-1">
          last ad:{" "}
          {info.lastAd ? (
            <span>
              <span className="text-glow-cyan">{info.lastAd.kind}</span>{" "}
              {info.lastAd.result} · {fmt(info.lastAd.at)}
            </span>
          ) : (
            "—"
          )}
        </div>
        <div>
          last save:{" "}
          {info.lastSave ? (
            <span className={info.lastSave.ok ? "text-glow-cyan" : "text-glow-pink"}>
              {info.lastSave.ok ? "ok" : "fail"} · {info.lastSave.note} · {fmt(info.lastSave.at)}
            </span>
          ) : (
            "—"
          )}
        </div>
        <div>
          queue: {info.saveQueueDepth} · attempts: {info.saveQueueAttempts}
        </div>
        <div>
          retry:{" "}
          <span
            className={
              info.saveRetry.state === "abandoned"
                ? "text-glow-pink"
                : info.saveRetry.state === "idle"
                  ? "text-white/50"
                  : "text-glow-yellow"
            }
          >
            {info.saveRetry.state}
          </span>{" "}
          {info.saveRetry.attempts}/{info.saveRetry.maxAttempts}
          {info.saveRetry.nextAttemptAt ? ` · next ${fmt(info.saveRetry.nextAttemptAt)}` : ""}
        </div>
        <div className="mt-1 border-t border-white/10 pt-1">
          <div className="text-white/50 text-[9px]">analytics (cross-session):</div>
          <div>
            attempts: <span className="text-glow-cyan">{info.cloudAnalytics?.totalAttempts ?? 0}</span> ·
            succ: <span className="text-glow-green">{info.cloudAnalytics?.successfulSaves ?? 0}</span> ·
            retries: <span className="text-glow-yellow">{info.cloudAnalytics?.retriesScheduled ?? 0}</span>
          </div>
          {info.cloudAnalytics?.lastFailureReason && (
            <div className="text-glow-pink truncate text-[9px]">
              fail: {info.cloudAnalytics.lastFailureReason}
            </div>
          )}
        </div>
        <div className="mt-1 border-t border-white/10 pt-1 text-glow-pink break-words">
          err: {info.lastError ?? "—"}
        </div>
        <div className="mt-1 border-t border-white/10 pt-1">
          <div className="text-white/50">errors ({info.errorLog.length})</div>
          <div className="max-h-32 overflow-y-auto">
            {info.errorLog.length === 0 ? (
              <div className="text-white/40">—</div>
            ) : (
              info.errorLog.map((e, i) => (
                <div key={`${e.at}-${i}`} className="break-words text-white/70">
                  <span className="text-glow-cyan">{fmt(e.at)}</span>{" "}
                  <span className="text-glow-yellow">{e.source}</span> {e.message}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="mt-1 text-[9px] text-white/40">` toggles · ?debug=1</div>
      </div>
    </div>
  );
}
