'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Brain,
  ArrowLeft,
  Activity,
  Shield,
  Wifi,
  WifiOff,
  Server,
  Database,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Send,
  Copy,
  ChevronDown,
  ChevronUp,
  Loader2,
  Zap,
  Radio,
  HardDrive,
  Bot,
  Sparkles,
  BarChart3,
  Heart,
  Cpu,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DiagnosticData {
  timestamp: string;
  overall: 'healthy' | 'warning' | 'critical';
  checks: Record<string, { status: string; message: string; details?: any }>;
  summary: string[];
  rawData: {
    engineStatus: any;
    queueStats: any;
    taskStats: any;
    recentFailedTasks: any[];
    stuckItems: any[];
    errorPatterns: Record<string, number>;
  };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ─── Status color helpers ────────────────────────────────────────────────────

function statusColor(s: string) {
  switch (s) {
    case 'ok':
      return 'text-emerald-400';
    case 'warning':
      return 'text-amber-400';
    case 'critical':
      return 'text-rose-400';
    default:
      return 'text-slate-500';
  }
}

function statusBg(s: string) {
  switch (s) {
    case 'ok':
      return 'bg-emerald-500/10 border-emerald-500/20';
    case 'warning':
      return 'bg-amber-500/10 border-amber-500/20';
    case 'critical':
      return 'bg-rose-500/10 border-rose-500/20';
    default:
      return 'bg-slate-800/50 border-slate-700/30';
  }
}

function statusIcon(s: string) {
  switch (s) {
    case 'ok':
      return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case 'warning':
      return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    case 'critical':
      return <XCircle className="w-4 h-4 text-rose-400" />;
    default:
      return <Clock className="w-4 h-4 text-slate-500" />;
  }
}

function checkIcon(key: string) {
  switch (key) {
    case 'firebase':
      return <Database className="w-4 h-4" />;
    case 'engine':
      return <Cpu className="w-4 h-4" />;
    case 'vpsTimer':
      return <Server className="w-4 h-4" />;
    case 'vpsHubcloud':
      return <HardDrive className="w-4 h-4" />;
    case 'queueHealth':
      return <Radio className="w-4 h-4" />;
    case 'taskHealth':
      return <BarChart3 className="w-4 h-4" />;
    case 'recentErrors':
      return <AlertTriangle className="w-4 h-4" />;
    default:
      return <Activity className="w-4 h-4" />;
  }
}

function checkLabel(key: string) {
  const labels: Record<string, string> = {
    firebase: 'Firebase',
    engine: 'Cron Engine',
    vpsTimer: 'VPS Timer',
    vpsHubcloud: 'VPS HubCloud',
    queueHealth: 'Queue',
    taskHealth: 'Tasks',
    recentErrors: 'Errors',
  };
  return labels[key] || key;
}

// ─── Quick action prompts ────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: '🔍 System kaise hai?', prompt: 'System ka overall health status kya hai? Koi problem hai?' },
  { label: '🔗 Links fail kyun?', prompt: 'Mere links kyun fail ho rahe hain? Error patterns kya hain?' },
  { label: '⚙️ Engine kyun band?', prompt: 'Engine OFFLINE kyun dikh raha hai? Kaise fix karun?' },
  { label: '📋 Queue stuck hai', prompt: 'Queue items processing mein stuck hain. Kya karein?' },
  { label: '🚀 Performance tips', prompt: 'System ki performance improve karne ke liye kya changes karein?' },
  { label: '🛠️ VPS check karo', prompt: 'VPS server ka status kya hai? Timer aur HubCloud API kaam kar rahi hai?' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function AiControlCenter({ onBack }: { onBack: () => void }) {
  // ─── State ──────────────────────────────────────────────────────────────
  const [diagnostics, setDiagnostics] = useState<DiagnosticData | null>(null);
  const [isLoadingDiag, setIsLoadingDiag] = useState(true);
  const [diagError, setDiagError] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);
  const [showRawData, setShowRawData] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ─── Auto-scroll chat ──────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ─── Fetch diagnostics ─────────────────────────────────────────────────
  const fetchDiagnostics = useCallback(async () => {
    setIsLoadingDiag(true);
    setDiagError(null);
    try {
      const res = await fetch('/api/ai/diagnose');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDiagnostics(data);
    } catch (e: any) {
      setDiagError(e.message);
    } finally {
      setIsLoadingDiag(false);
    }
  }, []);

  // ─── Initial load ──────────────────────────────────────────────────────
  useEffect(() => {
    fetchDiagnostics();
    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchDiagnostics, 60000);
    return () => clearInterval(interval);
  }, [fetchDiagnostics]);

  // ─── Send chat message ─────────────────────────────────────────────────
  const sendMessage = async (msg?: string) => {
    const message = (msg || chatInput).trim();
    if (!message || isSending) return;

    setChatInput('');
    setChatError(null);

    const userMsg: ChatMessage = {
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setIsSending(true);

    try {
      // Build history (last 10 messages only to stay within context)
      const history = chatMessages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history,
          diagnostics,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: data.response,
        timestamp: new Date().toISOString(),
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch (e: any) {
      setChatError(e.message);
      // Remove the user message if request failed
      setChatMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  };

  // ─── Copy to clipboard ─────────────────────────────────────────────────
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  // ─── Overall status styles ─────────────────────────────────────────────
  const overallGradient =
    diagnostics?.overall === 'healthy'
      ? 'from-emerald-600/20 via-emerald-900/10 to-transparent'
      : diagnostics?.overall === 'warning'
      ? 'from-amber-600/20 via-amber-900/10 to-transparent'
      : diagnostics?.overall === 'critical'
      ? 'from-rose-600/20 via-rose-900/10 to-transparent'
      : 'from-slate-600/20 via-slate-900/10 to-transparent';

  const overallText =
    diagnostics?.overall === 'healthy'
      ? 'All Systems Operational'
      : diagnostics?.overall === 'warning'
      ? 'Issues Detected'
      : diagnostics?.overall === 'critical'
      ? 'Critical Problems'
      : 'Checking...';

  const overallColor =
    diagnostics?.overall === 'healthy'
      ? 'text-emerald-400'
      : diagnostics?.overall === 'warning'
      ? 'text-amber-400'
      : diagnostics?.overall === 'critical'
      ? 'text-rose-400'
      : 'text-slate-400';

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen min-h-dvh bg-black text-white">
      {/* ── Background ─────────────────────────────────────────────────── */}
      <div className={`fixed inset-0 bg-gradient-to-b ${overallGradient} pointer-events-none z-0`} />
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-violet-950/15 via-transparent to-transparent pointer-events-none z-0" />

      {/* ── Main Content ───────────────────────────────────────────────── */}
      <div className="relative z-10 max-w-2xl mx-auto px-4 pt-4 pb-8">

        {/* ═══ HEADER ═════════════════════════════════════════════════════ */}
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={onBack}
            className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 active:scale-95 transition-all"
          >
            <ArrowLeft className="w-4 h-4 text-slate-300" />
          </button>

          <div className="flex items-center gap-2.5 flex-1">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-600/30">
              <Brain className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">AI Control Center</h1>
              <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                System Diagnostics & AI Assistant
              </p>
            </div>
          </div>

          <button
            onClick={fetchDiagnostics}
            disabled={isLoadingDiag}
            className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 active:scale-95 transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-slate-300 ${isLoadingDiag ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* ═══ OVERALL STATUS BANNER ══════════════════════════════════════ */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-2xl border p-4 mb-4 ${
            diagnostics?.overall === 'healthy'
              ? 'bg-emerald-950/30 border-emerald-500/20'
              : diagnostics?.overall === 'warning'
              ? 'bg-amber-950/30 border-amber-500/20'
              : diagnostics?.overall === 'critical'
              ? 'bg-rose-950/30 border-rose-500/20'
              : 'bg-slate-900/50 border-slate-700/30'
          }`}
        >
          <div className="flex items-center gap-3">
            {isLoadingDiag ? (
              <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
            ) : diagnostics?.overall === 'healthy' ? (
              <Heart className="w-5 h-5 text-emerald-400" />
            ) : diagnostics?.overall === 'warning' ? (
              <AlertTriangle className="w-5 h-5 text-amber-400" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-400" />
            )}

            <div className="flex-1">
              <p className={`text-sm font-bold ${overallColor}`}>
                {isLoadingDiag ? 'Running diagnostics...' : overallText}
              </p>
              {diagnostics && (
                <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                  Last scan: {new Date(diagnostics.timestamp).toLocaleTimeString()}
                </p>
              )}
            </div>

            {diagnostics && (
              <div className="flex gap-1">
                {Object.values(diagnostics.checks).map((c, i) => (
                  <div
                    key={i}
                    className={`w-2 h-2 rounded-full ${
                      c.status === 'ok'
                        ? 'bg-emerald-400'
                        : c.status === 'warning'
                        ? 'bg-amber-400'
                        : c.status === 'critical'
                        ? 'bg-rose-400'
                        : 'bg-slate-600'
                    }`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Summary issues */}
          {diagnostics && diagnostics.summary.length > 0 && diagnostics.overall !== 'healthy' && (
            <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
              {diagnostics.summary.map((issue, i) => (
                <p key={i} className="text-xs text-slate-300 leading-relaxed">
                  {issue}
                </p>
              ))}
            </div>
          )}
        </motion.div>

        {/* ═══ HEALTH CHECKS GRID ═════════════════════════════════════════ */}
        {diagnostics && (
          <div className="space-y-2 mb-5">
            <div className="flex items-center gap-2 mb-1">
              <Shield className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                Health Checks
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {Object.entries(diagnostics.checks).map(([key, check]) => (
                <motion.button
                  key={key}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setExpandedCheck(expandedCheck === key ? null : key)}
                  className={`text-left rounded-xl border p-3 transition-all ${statusBg(check.status)} ${
                    expandedCheck === key ? 'col-span-2' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={statusColor(check.status)}>
                      {checkIcon(key)}
                    </span>
                    <span className="text-xs font-semibold text-white flex-1">
                      {checkLabel(key)}
                    </span>
                    {statusIcon(check.status)}
                  </div>

                  <p className={`text-[10px] mt-1.5 ${statusColor(check.status)} opacity-80 line-clamp-2`}>
                    {check.message}
                  </p>

                  {/* Expanded details */}
                  <AnimatePresence>
                    {expandedCheck === key && check.details && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-2 pt-2 border-t border-white/5">
                          <pre className="text-[9px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
                            {JSON.stringify(check.details, null, 2)}
                          </pre>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* ═══ TASK STATS (if available) ══════════════════════════════════ */}
        {diagnostics?.rawData?.taskStats?.totalLinks > 0 && (
          <div className="rounded-2xl bg-white/[0.03] border border-white/5 p-4 mb-5">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-xs font-semibold">Link Success Rate</span>
              <span className={`ml-auto text-sm font-bold ${
                diagnostics.rawData.taskStats.linkSuccessRate >= 75
                  ? 'text-emerald-400'
                  : diagnostics.rawData.taskStats.linkSuccessRate >= 50
                  ? 'text-amber-400'
                  : 'text-rose-400'
              }`}>
                {diagnostics.rawData.taskStats.linkSuccessRate}%
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden mb-3">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${diagnostics.rawData.taskStats.linkSuccessRate}%` }}
                transition={{ duration: 1, ease: 'easeOut' }}
                className={`h-full rounded-full ${
                  diagnostics.rawData.taskStats.linkSuccessRate >= 75
                    ? 'bg-emerald-500'
                    : diagnostics.rawData.taskStats.linkSuccessRate >= 50
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
                }`}
              />
            </div>

            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: 'Done', value: diagnostics.rawData.taskStats.doneLinks, color: 'text-emerald-400' },
                { label: 'Error', value: diagnostics.rawData.taskStats.errorLinks, color: 'text-rose-400' },
                { label: 'Pending', value: diagnostics.rawData.taskStats.pendingLinks, color: 'text-amber-400' },
                { label: 'Total', value: diagnostics.rawData.taskStats.totalLinks, color: 'text-slate-300' },
              ].map((item) => (
                <div key={item.label}>
                  <p className={`text-lg font-bold ${item.color}`}>{item.value}</p>
                  <p className="text-[9px] text-slate-500 uppercase tracking-wider">{item.label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══ ERROR PATTERNS (if any) ════════════════════════════════════ */}
        {diagnostics?.rawData?.errorPatterns &&
          Object.keys(diagnostics.rawData.errorPatterns).length > 0 && (
          <div className="rounded-2xl bg-rose-950/20 border border-rose-500/10 p-4 mb-5">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span className="text-xs font-semibold text-rose-300">Error Patterns</span>
            </div>
            <div className="space-y-2">
              {Object.entries(diagnostics.rawData.errorPatterns)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([pattern, count], i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-[10px] font-mono text-rose-400 font-bold min-w-[24px]">
                      {count}x
                    </span>
                    <p className="text-[10px] text-slate-400 font-mono break-all leading-relaxed">
                      {pattern}
                    </p>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* ═══ QUICK ACTIONS ══════════════════════════════════════════════ */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
              Quick Ask
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((action, i) => (
              <button
                key={i}
                onClick={() => sendMessage(action.prompt)}
                disabled={isSending}
                className="text-[11px] px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white active:scale-95 transition-all disabled:opacity-50"
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>

        {/* ═══ AI CHAT ════════════════════════════════════════════════════ */}
        <div className="rounded-2xl bg-white/[0.02] border border-white/5 overflow-hidden">
          {/* Chat header */}
          <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
            <Bot className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-semibold">AI Assistant</span>
            <Sparkles className="w-3 h-3 text-violet-400/50" />
            <span className="text-[9px] text-slate-600 ml-auto font-mono">Claude Sonnet</span>
          </div>

          {/* Chat messages */}
          <div className="max-h-[400px] overflow-y-auto p-4 space-y-4">
            {chatMessages.length === 0 && !isSending && (
              <div className="text-center py-8">
                <Brain className="w-10 h-10 text-violet-500/30 mx-auto mb-3" />
                <p className="text-sm text-slate-500">
                  Mujhse kuch bhi pucho apni website ke baare mein
                </p>
                <p className="text-[10px] text-slate-600 mt-1">
                  Main automatically system diagnostics check karke jawab dunga
                </p>
              </div>
            )}

            {chatMessages.map((msg, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-indigo-600/30 border border-indigo-500/20 text-white'
                      : 'bg-white/[0.04] border border-white/5 text-slate-200'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <Bot className="w-3 h-3 text-violet-400" />
                      <span className="text-[9px] text-violet-400 font-mono">AI</span>

                      {/* Copy button */}
                      <button
                        onClick={() => copyToClipboard(msg.content)}
                        className="ml-auto p-1 rounded hover:bg-white/10 transition-colors"
                        title="Copy response"
                      >
                        {copiedText === msg.content ? (
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3 text-slate-500" />
                        )}
                      </button>
                    </div>
                  )}

                  {/* Render message with basic markdown-like formatting */}
                  <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content.split('\n').map((line, li) => {
                      // Code blocks
                      if (line.startsWith('```')) {
                        return null; // Skip markers, handled by pre blocks
                      }
                      // Bold text
                      const parts = line.split(/(\*\*.*?\*\*)/g);
                      return (
                        <p key={li} className={li > 0 ? 'mt-1.5' : ''}>
                          {parts.map((part, pi) => {
                            if (part.startsWith('**') && part.endsWith('**')) {
                              return (
                                <span key={pi} className="font-bold text-white">
                                  {part.slice(2, -2)}
                                </span>
                              );
                            }
                            // Inline code
                            const codeParts = part.split(/(`[^`]+`)/g);
                            return codeParts.map((cp, ci) => {
                              if (cp.startsWith('`') && cp.endsWith('`')) {
                                return (
                                  <code
                                    key={`${pi}-${ci}`}
                                    className="text-[11px] px-1.5 py-0.5 rounded bg-black/40 text-violet-300 font-mono"
                                  >
                                    {cp.slice(1, -1)}
                                  </code>
                                );
                              }
                              return <span key={`${pi}-${ci}`}>{cp}</span>;
                            });
                          })}
                        </p>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            ))}

            {/* Loading indicator */}
            {isSending && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex justify-start"
              >
                <div className="bg-white/[0.04] border border-white/5 rounded-2xl px-4 py-3 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                  <span className="text-xs text-slate-400">Analyzing system...</span>
                </div>
              </motion.div>
            )}

            {/* Error message */}
            {chatError && (
              <div className="bg-rose-950/30 border border-rose-500/20 rounded-xl px-3 py-2 text-xs text-rose-300">
                ❌ {chatError}
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div className="border-t border-white/5 p-3">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Apni problem batao..."
                rows={1}
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-600 resize-none focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/30"
                style={{ minHeight: '40px', maxHeight: '120px' }}
              />
              <button
                onClick={() => sendMessage()}
                disabled={!chatInput.trim() || isSending}
                className="w-10 h-10 rounded-xl bg-violet-600 flex items-center justify-center hover:bg-violet-500 active:scale-95 transition-all disabled:opacity-30 disabled:hover:bg-violet-600 flex-shrink-0"
              >
                {isSending ? (
                  <Loader2 className="w-4 h-4 text-white animate-spin" />
                ) : (
                  <Send className="w-4 h-4 text-white" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* ═══ RAW DIAGNOSTICS TOGGLE ═════════════════════════════════════ */}
        {diagnostics && (
          <div className="mt-4">
            <button
              onClick={() => setShowRawData(!showRawData)}
              className="flex items-center gap-2 text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
            >
              {showRawData ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              <span className="font-mono uppercase tracking-widest">Raw Diagnostics Data</span>
            </button>

            <AnimatePresence>
              {showRawData && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 rounded-xl bg-black border border-white/5 p-3 relative">
                    <button
                      onClick={() => copyToClipboard(JSON.stringify(diagnostics, null, 2))}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                      title="Copy JSON"
                    >
                      {copiedText === JSON.stringify(diagnostics, null, 2) ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-slate-500" />
                      )}
                    </button>
                    <pre className="text-[9px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-[400px] overflow-y-auto">
                      {JSON.stringify(diagnostics, null, 2)}
                    </pre>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Bottom spacing */}
        <div className="h-8" />
      </div>
    </div>
  );
}
