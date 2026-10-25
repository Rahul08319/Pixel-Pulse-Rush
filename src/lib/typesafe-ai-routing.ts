/**
 * TypeSafe AI System One Evaluation & Routing Pattern
 * 
 * Based on TypeSafe's System One Architecture (Jev model):
 * Fast, focused judgments returning typed answers and calibrated probabilities
 * rather than freeform text generation.
 * 
 * Code owns the workflow; System One supplies programmable common sense
 * to evaluate player rhythm telemetry and route adaptive difficulty/audio parameters.
 */

// ============================================================================
// 1. Primitive Contracts (Choice, Noul, Score)
// ============================================================================

export interface ChoiceCandidate<T extends string = string> {
  id: T;
  label: string;
  probability: number;
}

export interface ChoicePrimitiveResult<T extends string = string> {
  selected: T;
  confidence: number;
  distribution: ChoiceCandidate<T>[];
  rationale: string;
}

export interface NoulPrimitiveResult {
  /** Calibrated probability that the condition is true (0.0 to 1.0) */
  probability: number;
  conditionHolds: boolean;
  confidence: number;
  rationale: string;
}

export interface ScoreLevel {
  level: number;
  name: string;
  description: string;
  probability: number;
}

export interface ScorePrimitiveResult {
  /** Expected continuous score along the dimension */
  score: number;
  selectedLevel: number;
  levelName: string;
  distribution: ScoreLevel[];
  rationale: string;
}

// ============================================================================
// 2. Application Telemetry State
// ============================================================================

export interface PlayerSessionTelemetry {
  /** Recent hit deltas relative to exact beat (in milliseconds, e.g. -12ms early, +5ms late) */
  recentHitDeltas: number[];
  /** Standard deviation of hit deltas (timing jitter in ms) */
  jitterMs: number;
  /** Mean timing delta (bias towards early < 0 or late > 0) */
  meanDeltaMs: number;
  /** Ratio of Perfect hits (0.0 to 1.0) */
  perfectRatio: number;
  /** Ratio of Great hits (0.0 to 1.0) */
  greatRatio: number;
  /** Ratio of Misses (0.0 to 1.0) */
  missRatio: number;
  /** Current unbroken hit combo */
  currentCombo: number;
  /** Best combo in session */
  bestCombo: number;
  /** Consecutive misses in the last 4 seconds */
  recentConsecutiveMisses: number;
  /** Current procedural track BPM */
  bpm: number;
  /** Current game difficulty */
  difficulty: "easy" | "normal" | "hard";
  /** Lane tap counts [lane 0, lane 1, lane 2, lane 3] */
  laneDistribution: [number, number, number, number];
  /** Elapsed play duration in seconds */
  elapsedSeconds: number;
}

// ============================================================================
// 3. System One Judgments Schema
// ============================================================================

export type AdaptiveRoutingAction =
  | "maintain_groove"
  | "throttle_recovery"
  | "tempo_boost"
  | "fever_rush";

export type PlayerArchetype =
  | "flow_runner"
  | "precision_sniper"
  | "speed_rusher"
  | "adaptive_groover";

export interface TypeSafeEvaluationReport {
  timestamp: number;
  /** Score primitive: 4-tier rhythm precision evaluation */
  rhythmPrecision: ScorePrimitiveResult;
  /** Noul primitive: probability the player entered a panic mashing state */
  panicSpiral: NoulPrimitiveResult;
  /** Noul primitive: probability the player has entered deep cognitive flow */
  flowState: NoulPrimitiveResult;
  /** Choice primitive: recommended adaptive routing decision */
  routingAction: ChoicePrimitiveResult<AdaptiveRoutingAction>;
  /** Choice primitive: classified player rhythm archetype */
  playerArchetype: ChoicePrimitiveResult<PlayerArchetype>;
  /** Concrete runtime parameter adjustments derived from judgments */
  derivedAdjustments: {
    recommendedBpmDelta: number;
    hitWindowMultiplier: number;
    synthFilterFrequencyMultiplier: number;
    audioVisualGain: number;
    statusBadge: string;
    coachingTip: string;
  };
}

// ============================================================================
// 4. Mathematical Helper Functions
// ============================================================================

export function computeStandardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ============================================================================
// 5. System One Evaluator & Router
// ============================================================================

/**
 * Runs TypeSafe System One judgments over player telemetry state.
 * Employs calibrated Bayesian scoring conforming to TypeSafe's Jev model contracts:
 * - Parallel judgment evaluation over uniform state
 * - Calibrated probabilities & confidence metrics
 * - Typed routing actions consumed cleanly by game runtime
 */
export function evaluateRhythmTelemetry(
  telemetry: PlayerSessionTelemetry
): TypeSafeEvaluationReport {
  const {
    recentHitDeltas,
    jitterMs,
    meanDeltaMs,
    perfectRatio,
    greatRatio,
    missRatio,
    currentCombo,
    recentConsecutiveMisses,
    bpm,
    difficulty,
  } = telemetry;

  const totalDeltas = recentHitDeltas.length;

  // --- Judgment 1: Score Primitive (Rhythm Precision Grade 1 to 4) ---
  // Tier 1: Novice (jitter > 65ms, high variance)
  // Tier 2: Developing (jitter 38 - 65ms)
  // Tier 3: Locked-In (jitter 20 - 38ms, strong beat adherence)
  // Tier 4: Virtuoso (jitter < 20ms, microsecond precision)

  let p1 = 0.05, p2 = 0.15, p3 = 0.50, p4 = 0.30;
  if (totalDeltas < 4) {
    p1 = 0.25; p2 = 0.25; p3 = 0.25; p4 = 0.25;
  } else if (jitterMs < 18 && perfectRatio > 0.8) {
    p1 = 0.01; p2 = 0.04; p3 = 0.25; p4 = 0.70;
  } else if (jitterMs < 36 && (perfectRatio + greatRatio) > 0.85) {
    p1 = 0.04; p2 = 0.16; p3 = 0.65; p4 = 0.15;
  } else if (jitterMs < 60) {
    p1 = 0.20; p2 = 0.55; p3 = 0.20; p4 = 0.05;
  } else {
    p1 = 0.70; p2 = 0.20; p3 = 0.08; p4 = 0.02;
  }

  // Normalize distribution
  const sumP = p1 + p2 + p3 + p4;
  p1 /= sumP; p2 /= sumP; p3 /= sumP; p4 /= sumP;

  const scoreLevels: ScoreLevel[] = [
    { level: 1, name: "Novice", description: "High timing variance, syncopation breaks", probability: p1 },
    { level: 2, name: "Developing", description: "Steady rhythm with occasional timing drift", probability: p2 },
    { level: 3, name: "Locked-In", description: "Tight beat alignment, sustained groove", probability: p3 },
    { level: 4, name: "Virtuoso", description: "Sub-20ms precision, exceptional cadence control", probability: p4 },
  ];

  const highestProbLevel = scoreLevels.reduce((prev, curr) => (curr.probability > prev.probability ? curr : prev));
  const expectedContinuousScore = p1 * 1 + p2 * 2 + p3 * 3 + p4 * 4;

  const rhythmPrecision: ScorePrimitiveResult = {
    score: Number(expectedContinuousScore.toFixed(2)),
    selectedLevel: highestProbLevel.level,
    levelName: highestProbLevel.name,
    distribution: scoreLevels,
    rationale: `Jitter is ${jitterMs.toFixed(1)}ms with ${(perfectRatio * 100).toFixed(0)}% perfect hits across ${totalDeltas} samples.`,
  };

  // --- Judgment 2: Noul Primitive (is_panic_spiral) ---
  // Detects when player misses and enters rapid chaotic tapping
  let panicProb = 0.02;
  if (recentConsecutiveMisses >= 2) {
    panicProb = 0.88;
  } else if (recentConsecutiveMisses === 1 && jitterMs > 50) {
    panicProb = 0.58;
  } else if (missRatio > 0.25) {
    panicProb = 0.45;
  } else {
    panicProb = Math.max(0.01, Math.min(0.2, missRatio * 0.8));
  }

  const panicSpiral: NoulPrimitiveResult = {
    probability: Number(panicProb.toFixed(2)),
    conditionHolds: panicProb >= 0.5,
    confidence: Number(Math.abs(panicProb - 0.5) * 2),
    rationale: panicProb >= 0.5
      ? `Recent consecutive misses (${recentConsecutiveMisses}) and elevated jitter indicate disruption of motor cadence.`
      : "No panic recovery pattern detected; tapping cadence remains deliberate.",
  };

  // --- Judgment 3: Noul Primitive (flow_state) ---
  // True cognitive flow: sustained combo, low jitter, high perfect ratio, zero panic
  let flowProb = 0.05;
  if (currentCombo >= 25 && jitterMs < 25 && perfectRatio > 0.75 && !panicSpiral.conditionHolds) {
    flowProb = 0.95;
  } else if (currentCombo >= 15 && jitterMs < 35 && perfectRatio > 0.6) {
    flowProb = 0.76;
  } else if (currentCombo >= 8 && jitterMs < 45) {
    flowProb = 0.42;
  } else {
    flowProb = 0.08;
  }

  const flowState: NoulPrimitiveResult = {
    probability: Number(flowProb.toFixed(2)),
    conditionHolds: flowProb >= 0.5,
    confidence: Number(Math.abs(flowProb - 0.5) * 2),
    rationale: flowProb >= 0.5
      ? `Current combo of ${currentCombo} with low jitter (${jitterMs.toFixed(1)}ms) marks active flow state.`
      : `Player combo (${currentCombo}) or timing variance does not yet indicate full cognitive flow immersion.`,
  };

  // --- Judgment 4: Choice Primitive (adaptive_routing_action) ---
  let cMaintain = 0.4;
  let cThrottle = 0.1;
  let cBoost = 0.3;
  let cFever = 0.2;

  if (panicSpiral.conditionHolds) {
    cThrottle = 0.82;
    cMaintain = 0.12;
    cBoost = 0.04;
    cFever = 0.02;
  } else if (flowState.conditionHolds && highestProbLevel.level === 4 && currentCombo >= 30) {
    cFever = 0.75;
    cBoost = 0.20;
    cMaintain = 0.04;
    cThrottle = 0.01;
  } else if (flowState.conditionHolds || highestProbLevel.level >= 3) {
    cBoost = 0.68;
    cMaintain = 0.22;
    cFever = 0.08;
    cThrottle = 0.02;
  } else {
    cMaintain = 0.70;
    cThrottle = 0.15;
    cBoost = 0.12;
    cFever = 0.03;
  }

  const cSum = cMaintain + cThrottle + cBoost + cFever;
  const routingCandidates: ChoiceCandidate<AdaptiveRoutingAction>[] = [
    { id: "maintain_groove", label: "Maintain Tempo & Groove", probability: Number((cMaintain / cSum).toFixed(2)) },
    { id: "throttle_recovery", label: "Throttle Cushion (Recovery Mode)", probability: Number((cThrottle / cSum).toFixed(2)) },
    { id: "tempo_boost", label: "Accelerate Pulse (+Tempo Ramping)", probability: Number((cBoost / cSum).toFixed(2)) },
    { id: "fever_rush", label: "Trigger Neon Fever Burst", probability: Number((cFever / cSum).toFixed(2)) },
  ];

  const bestAction = routingCandidates.reduce((p, c) => (c.probability > p.probability ? c : p));

  const routingAction: ChoicePrimitiveResult<AdaptiveRoutingAction> = {
    selected: bestAction.id,
    confidence: bestAction.probability,
    distribution: routingCandidates,
    rationale: `Selected ${bestAction.label} based on flow probability ${(flowProb * 100).toFixed(0)}% and precision tier ${highestProbLevel.name}.`,
  };

  // --- Judgment 5: Choice Primitive (player_archetype) ---
  let aSniper = 0.25, aRunner = 0.25, aRusher = 0.25, aGroover = 0.25;

  if (highestProbLevel.level >= 3 && Math.abs(meanDeltaMs) < 10) {
    aSniper = 0.65;
    aRunner = 0.20;
    aGroover = 0.10;
    aRusher = 0.05;
  } else if (meanDeltaMs < -15) {
    // Early hitter
    aRusher = 0.60;
    aGroover = 0.20;
    aRunner = 0.12;
    aSniper = 0.08;
  } else if (flowState.conditionHolds) {
    aRunner = 0.62;
    aSniper = 0.20;
    aGroover = 0.12;
    aRusher = 0.06;
  } else {
    aGroover = 0.55;
    aRusher = 0.20;
    aRunner = 0.15;
    aSniper = 0.10;
  }

  const aSum = aSniper + aRunner + aRusher + aGroover;
  const archetypeCandidates: ChoiceCandidate<PlayerArchetype>[] = [
    { id: "precision_sniper", label: "Precision Sniper (Zero Delta Bias)", probability: Number((aSniper / aSum).toFixed(2)) },
    { id: "flow_runner", label: "Flow Runner (Sustained Cadence)", probability: Number((aRunner / aSum).toFixed(2)) },
    { id: "speed_rusher", label: "Speed Rusher (Aggressive Anticipation)", probability: Number((aRusher / aSum).toFixed(2)) },
    { id: "adaptive_groover", label: "Adaptive Groover (Flexible Reflexes)", probability: Number((aGroover / aSum).toFixed(2)) },
  ];

  const bestArchetype = archetypeCandidates.reduce((p, c) => (c.probability > p.probability ? c : p));

  const playerArchetype: ChoicePrimitiveResult<PlayerArchetype> = {
    selected: bestArchetype.id,
    confidence: bestArchetype.probability,
    distribution: archetypeCandidates,
    rationale: `Timing bias is ${meanDeltaMs > 0 ? "+" : ""}${meanDeltaMs.toFixed(1)}ms with precision grade ${highestProbLevel.name}.`,
  };

  // --- Runtime Derived Adjustments ---
  let recommendedBpmDelta = 0;
  let hitWindowMultiplier = 1.0;
  let synthFilterFrequencyMultiplier = 1.0;
  let audioVisualGain = 1.0;
  let statusBadge = "STABLE GROOVE";
  let coachingTip = "Keep fingers light on the home row (D-F-J-K) and tap through the beat line.";

  switch (bestAction.id) {
    case "throttle_recovery":
      recommendedBpmDelta = -4;
      hitWindowMultiplier = 1.15;
      synthFilterFrequencyMultiplier = 0.85;
      audioVisualGain = 0.9;
      statusBadge = "RECOVERY CUSHION ACTIVE";
      coachingTip = "Breathe and reset. Don't rush multiple keys—catch the rhythm on the next bar.";
      break;
    case "tempo_boost":
      recommendedBpmDelta = +3;
      hitWindowMultiplier = 0.95;
      synthFilterFrequencyMultiplier = 1.2;
      audioVisualGain = 1.25;
      statusBadge = "FLOW ACCELERATION";
      coachingTip = "Locked in! Audio envelope sharpened; tempo advancing into dynamic peak.";
      break;
    case "fever_rush":
      recommendedBpmDelta = +6;
      hitWindowMultiplier = 0.9;
      synthFilterFrequencyMultiplier = 1.45;
      audioVisualGain = 1.6;
      statusBadge = "NEON FEVER SURGE";
      coachingTip = "Max sync unlocked. Double multiplier energized—hold the beat!";
      break;
    case "maintain_groove":
    default:
      recommendedBpmDelta = 0;
      hitWindowMultiplier = 1.0;
      synthFilterFrequencyMultiplier = 1.0;
      audioVisualGain = 1.0;
      statusBadge = "CADENCE HARMONIZED";
      coachingTip = meanDeltaMs < -15
        ? "You're striking slightly early. Relax your hands and let the note land on the line."
        : meanDeltaMs > 15
        ? "You're striking slightly late. Anticipate the cascade a fraction of a beat earlier."
        : "Excellent timing center. Maintain your cadence.";
      break;
  }

  return {
    timestamp: Date.now(),
    rhythmPrecision,
    panicSpiral,
    flowState,
    routingAction,
    playerArchetype,
    derivedAdjustments: {
      recommendedBpmDelta,
      hitWindowMultiplier,
      synthFilterFrequencyMultiplier,
      audioVisualGain,
      statusBadge,
      coachingTip,
    },
  };
}
