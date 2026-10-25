import React from "react";
import {
  Brain,
  Zap,
  Gauge,
  Flame,
  Activity,
  ShieldAlert,
  Sparkles,
  X,
  Target,
  Compass,
} from "lucide-react";
import type { TypeSafeEvaluationReport } from "@/lib/typesafe-ai-routing";

interface TypeSafeNeuralInspectorProps {
  open: boolean;
  onClose: () => void;
  report: TypeSafeEvaluationReport | null;
  currentBpm: number;
  combo: number;
}

export function TypeSafeNeuralInspector({
  open,
  onClose,
  report,
  currentBpm,
  combo,
}: TypeSafeNeuralInspectorProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto apple-glass rounded-2xl border border-white/20 p-5 sm:p-6 text-white shadow-2xl"
        role="dialog"
        aria-label="TypeSafe System One Neural Inspector"
      >
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-tr from-[#0066cc] to-[#2997ff] shadow-md shadow-blue-500/30">
              <Brain className="w-5 h-5 text-white animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-base sm:text-lg tracking-tight font-apple text-white">
                  TypeSafe™ System One Neural Engine
                </h3>
                <span className="px-2 py-0.5 text-[9px] font-mono uppercase rounded-full bg-blue-500/20 text-[#2997ff] border border-blue-400/30">
                  JEV MODEL
                </span>
              </div>
              <p className="text-xs text-white/60 font-apple">
                Probabilistic telemetry evaluation & adaptive difficulty routing
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="apple-interactive p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white/70 hover:text-white"
            aria-label="Close Neural Inspector"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!report ? (
          <div className="py-12 text-center text-white/60">
            <Activity className="w-8 h-8 mx-auto mb-2 opacity-50 animate-bounce" />
            <p className="text-sm">Start tapping the lanes to stream telemetry into the model.</p>
            <p className="text-xs text-white/40 mt-1 font-mono">
              Judgments evaluate once enough timing deltas are recorded.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Live Runtime Status Bar */}
            <div className="apple-glass-pill p-3 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                </span>
                <span className="text-xs font-semibold text-white/90">
                  {report.derivedAdjustments.statusBadge}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs font-mono text-white/70">
                <span>⚡ {currentBpm} BPM</span>
                <span>COMBO {combo}x</span>
              </div>
            </div>

            {/* Primitive 1: Score Primitive (Rhythm Precision Grade) */}
            <div className="apple-glass-card p-3.5 rounded-xl border border-white/10">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Gauge className="w-4 h-4 text-[#ffe94a]" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-white/80 font-apple">
                    Score Primitive · Rhythm Precision
                  </span>
                </div>
                <div className="text-xs font-mono font-bold text-[#ffe94a]">
                  Grade: {report.rhythmPrecision.levelName} ({report.rhythmPrecision.score}/4.0)
                </div>
              </div>
              <p className="text-[11px] text-white/60 mb-3">{report.rhythmPrecision.rationale}</p>
              
              {/* Distribution bars */}
              <div className="grid grid-cols-4 gap-1.5 pt-1">
                {report.rhythmPrecision.distribution.map((tier) => (
                  <div key={tier.level} className="text-center">
                    <div className="text-[9px] font-mono text-white/50 mb-1">{tier.name}</div>
                    <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-yellow-400 to-amber-500 rounded-full transition-all duration-300"
                        style={{ width: `${Math.round(tier.probability * 100)}%` }}
                      />
                    </div>
                    <div className="text-[9px] font-mono text-white/70 mt-1">
                      {Math.round(tier.probability * 100)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Primitives 2 & 3: Noul Primitives (Panic Spiral & Flow State) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Noul: Panic Spiral */}
              <div className="apple-glass-card p-3.5 rounded-xl border border-white/10">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 text-[#ff3ea5]" />
                    <span className="text-xs font-semibold text-white/80">Panic Spiral</span>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold ${
                      report.panicSpiral.conditionHolds
                        ? "bg-red-500/20 text-red-400 border border-red-500/30"
                        : "bg-green-500/20 text-green-400 border border-green-500/30"
                    }`}
                  >
                    {report.panicSpiral.conditionHolds ? "ACTIVE" : "CALM"}
                  </span>
                </div>
                <div className="text-[11px] text-white/60 mb-2">
                  P(Panic) = {Math.round(report.panicSpiral.probability * 100)}% · Conf:{" "}
                  {Math.round(report.panicSpiral.confidence * 100)}%
                </div>
                <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#ff3ea5] transition-all duration-300"
                    style={{ width: `${Math.round(report.panicSpiral.probability * 100)}%` }}
                  />
                </div>
              </div>

              {/* Noul: Cognitive Flow State */}
              <div className="apple-glass-card p-3.5 rounded-xl border border-white/10">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <Flame className="w-4 h-4 text-[#22e2ff]" />
                    <span className="text-xs font-semibold text-white/80">Cognitive Flow</span>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold ${
                      report.flowState.conditionHolds
                        ? "bg-cyan-500/20 text-[#22e2ff] border border-cyan-500/30"
                        : "bg-white/10 text-white/50 border border-white/10"
                    }`}
                  >
                    {report.flowState.conditionHolds ? "IMMERSIVE" : "WARMING UP"}
                  </span>
                </div>
                <div className="text-[11px] text-white/60 mb-2">
                  P(Flow) = {Math.round(report.flowState.probability * 100)}% · Conf:{" "}
                  {Math.round(report.flowState.confidence * 100)}%
                </div>
                <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#22e2ff] transition-all duration-300"
                    style={{ width: `${Math.round(report.flowState.probability * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Primitive 4: Choice Primitive (Adaptive Routing Action) */}
            <div className="apple-glass-card p-3.5 rounded-xl border border-white/10">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Zap className="w-4 h-4 text-[#2997ff]" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-white/80 font-apple">
                    Choice Primitive · Adaptive Audio/Game Routing
                  </span>
                </div>
                <span className="text-xs font-mono font-bold text-[#2997ff] uppercase">
                  {report.routingAction.selected.replace(/_/g, " ")}
                </span>
              </div>
              <p className="text-[11px] text-white/60 mb-2.5">{report.routingAction.rationale}</p>
              
              <div className="space-y-1.5">
                {report.routingAction.distribution.map((candidate) => {
                  const isSelected = candidate.id === report.routingAction.selected;
                  return (
                    <div
                      key={candidate.id}
                      className={`p-2 rounded-lg text-xs flex items-center justify-between transition-colors ${
                        isSelected
                          ? "bg-blue-500/20 border border-blue-400/40 text-white font-medium"
                          : "bg-white/5 text-white/60"
                      }`}
                    >
                      <span>{candidate.label}</span>
                      <span className="font-mono text-[10px]">
                        {Math.round(candidate.probability * 100)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Primitive 5: Choice Primitive (Player Archetype) & Coaching Tip */}
            <div className="apple-glass-card p-3.5 rounded-xl border border-white/10">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Compass className="w-4 h-4 text-[#5cff8a]" />
                  <span className="text-xs font-semibold text-white/80">
                    Player Cadence Archetype
                  </span>
                </div>
                <span className="text-xs font-mono font-bold text-[#5cff8a]">
                  {report.playerArchetype.distribution.find((d) => d.id === report.playerArchetype.selected)?.label}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/80 flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-[#ffe94a] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-[#ffe94a]">Tactical Coach: </span>
                  {report.derivedAdjustments.coachingTip}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer info */}
        <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] text-white/40 font-mono">
          <span>TypeSafe System One Architecture</span>
          <span>Zero-hallucination typed judgments</span>
        </div>
      </div>
    </div>
  );
}
