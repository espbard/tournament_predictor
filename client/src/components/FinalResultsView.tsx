import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Pause, Play, FastForward, RotateCcw, Download, Video } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';

interface DisplayUser {
  userId: string;
  username: string;
  imageUrl?: string | null;
  iconColor?: string | null;
}

interface TeamInfo {
  id: string;
  name: string | null;
  imageUrl: string | null;
}

interface PointSource {
  id: string;
  label: string;
  eyebrow?: string;
  subLabel?: string;
  pointsByUser: Record<string, number>;
  answerByUser?: Record<string, string>;
  kind?: 'winner';
  actualTeam?: TeamInfo | null;
  predictedTeamByUser?: Record<string, TeamInfo | null>;
}

interface FinalResultsViewProps {
  users: DisplayUser[];
  pointSources: PointSource[];
  introText: string;
  tournamentLogoUrl?: string | null;
  competitionLogoUrl?: string | null;
  winnerLabel: (name: string) => string;
  toLeaderboardLabel: string;
  closeLabel: string;
  exitLabel: string;
  pauseLabel: string;
  playLabel: string;
  fastForwardLabel: string;
  replayLabel: string;
  downloadLabel: string;
  downloadPromptTitle: string;
  downloadPromptBody: string;
  startRecordingLabel: string;
  cancelLabel: string;
  recordingLabel: string;
  recordingFailedLabel: string;
  onGoToLeaderboard: () => void;
}

// getDisplayMedia's own options type doesn't include preferCurrentTab (it's only typed on
// the older MediaStreamConstraints in this repo's pinned TS/DOM lib), but it's a real,
// widely-supported Chrome/Edge hint that pre-selects "this tab" in the share picker.
type DisplayMediaOptions = DisplayMediaStreamOptions & { preferCurrentTab?: boolean };

const INTRO_DARK_MS = 1000;
const INTRO_LOGO_FADE_MS = 1800;
const INTRO_LOGO_HOLD_MS = 2200;
const INTRO_CRAWL_MS = 80000;
const TOURNAMENT_LOGO_PLACEHOLDER = '/tournament-logo-placeholder.png';
const COMPETITION_LOGO_PLACEHOLDER = '/competition-logo-placeholder.jpg';
const LABEL_MS = 1200;
const PRE_REVEAL_MS = 700;
const STATIC_MS = 1000;
const FALL_MS = 1000;
const PAUSE_MS = 900;
const OVERLAY_DELAY_MS = 2800;
const FAST_FORWARD_MULTIPLIER = 4;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

// Lightweight canvas fireworks, self-contained (no external libs) — bursts of
// particles keep spawning for as long as this component stays mounted.
function Fireworks() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    let particles: Particle[] = [];
    let lastBurst = 0;
    let raf = 0;

    function spawnBurst() {
      const x = canvas!.width * (0.15 + Math.random() * 0.7);
      const y = canvas!.height * (0.1 + Math.random() * 0.4);
      const hue = Math.floor(Math.random() * 360);
      const count = 40;
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.15;
        const speed = 2 + Math.random() * 2.5;
        particles.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          color: `hsl(${hue}, 90%, 65%)`,
        });
      }
    }

    function frame(t: number) {
      if (t - lastBurst > 750) {
        spawnBurst();
        lastBurst = t;
      }
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      particles = particles.filter(p => p.life > 0);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.045;
        p.life -= 0.014;
        ctx!.globalAlpha = Math.max(p.life, 0);
        ctx!.fillStyle = p.color;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" />;
}

function TeamIcon({ team, size, correct }: { team: TeamInfo | null | undefined; size: number; correct?: boolean }) {
  const ring = correct ? 'ring-2 ring-offset-2 ring-offset-black ring-[#ffe81f]' : '';
  if (!team) {
    return (
      <div
        className={`flex flex-shrink-0 items-center justify-center rounded-full bg-white/10 text-[#ffe81f]/60 ${ring}`}
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.45)), fontWeight: 700 }}
      >
        ?
      </div>
    );
  }
  return team.imageUrl ? (
    <img
      src={team.imageUrl}
      alt=""
      className={`flex-shrink-0 rounded-full object-cover ${ring}`}
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      className={`flex flex-shrink-0 items-center justify-center rounded-full bg-white/10 font-bold text-[#ffe81f] ${ring}`}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) }}
    >
      {team.name?.charAt(0) ?? '?'}
    </div>
  );
}

// Longer answers shrink to fit their allocated width before wrapping onto a second line.
function answerFontSizeClass(text: string): string {
  const len = text.length;
  if (len <= 8) return 'text-lg sm:text-2xl';
  if (len <= 14) return 'text-base sm:text-xl';
  if (len <= 22) return 'text-sm sm:text-lg';
  return 'text-xs sm:text-base';
}

const BAR_COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#ec4899',
];

// A wait() that can be paused/resumed and sped up mid-flight — it polls in small real-time
// ticks, only counting down the virtual remaining duration while not paused, at a rate set
// by the (live-read) speed multiplier, so toggling pause or fast-forward takes effect
// immediately instead of only on the next wait() call.
function pausableWait(
  ms: number,
  pausedRef: { current: boolean },
  speedRef: { current: number },
  isCancelled: () => boolean,
): Promise<void> {
  const TICK = 50;
  return new Promise(resolve => {
    let remaining = ms;
    function step() {
      if (isCancelled()) { resolve(); return; }
      if (!pausedRef.current) {
        remaining -= TICK * speedRef.current;
      }
      if (remaining <= 0) { resolve(); return; }
      setTimeout(step, TICK);
    }
    setTimeout(step, TICK);
  });
}

// Video-only mimeTypes, most-preferred first — the resulting stream never has an audio
// track (we always request audio: false), so audio codecs are deliberately left out.
function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function isRecordingSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getDisplayMedia
    && typeof MediaRecorder !== 'undefined';
}

// Users with a custom photo don't have an "icon color" of their own, so their bar
// gets a random color that doesn't collide with any color already in use.
function assignBarColors(users: DisplayUser[]): Record<string, string> {
  const used = new Set<string>();
  const colors: Record<string, string> = {};

  for (const u of users) {
    if (!u.imageUrl) {
      const c = (u.iconColor ?? '#4b5563').toLowerCase();
      colors[u.userId] = c;
      used.add(c);
    }
  }

  for (const u of users) {
    if (u.imageUrl) {
      const available = BAR_COLOR_PALETTE.filter(c => !used.has(c.toLowerCase()));
      const pool = available.length > 0 ? available : BAR_COLOR_PALETTE;
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      colors[u.userId] = chosen;
      used.add(chosen.toLowerCase());
    }
  }

  return colors;
}

export default function FinalResultsView({
  users,
  pointSources,
  introText,
  tournamentLogoUrl,
  competitionLogoUrl,
  winnerLabel,
  toLeaderboardLabel,
  closeLabel,
  exitLabel,
  pauseLabel,
  playLabel,
  fastForwardLabel,
  replayLabel,
  downloadLabel,
  downloadPromptTitle,
  downloadPromptBody,
  startRecordingLabel,
  cancelLabel,
  recordingLabel,
  recordingFailedLabel,
  onGoToLeaderboard,
}: FinalResultsViewProps) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  const [showIntro, setShowIntro] = useState(true);
  const [logosVisible, setLogosVisible] = useState(false);
  const [crawlStarted, setCrawlStarted] = useState(false);
  const [sourceIdx, setSourceIdx] = useState(-1);
  const [phase, setPhase] = useState<'idle' | 'label' | 'preReveal' | 'static' | 'falling' | 'landed'>('idle');
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [done, setDone] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fastForward, setFastForward] = useState(false);
  const [replayCount, setReplayCount] = useState(0);
  const [showDownloadPrompt, setShowDownloadPrompt] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  const pausedRef = useRef(false);
  const speedRef = useRef(1);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { speedRef.current = fastForward ? FAST_FORWARD_MULTIPLIER : 1; }, [fastForward]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }

  async function handleStartRecording() {
    if (isRecording) return;
    if (!isRecordingSupported()) {
      setRecordError(recordingFailedLabel);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
        preferCurrentTab: true,
      } as DisplayMediaOptions);
    } catch {
      setRecordError(recordingFailedLabel);
      return;
    }

    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      stream.getTracks().forEach(t => t.stop());
      setRecordError(recordingFailedLabel);
      return;
    }

    recordedChunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = e => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: mimeType });
      recordedChunksRef.current = [];
      stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `final-results-${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setIsRecording(false);
    };

    // Handles the user clicking the browser's own native "Stop sharing" control —
    // whatever was captured up to that point still gets downloaded via onstop above.
    stream.getVideoTracks()[0].addEventListener('ended', stopRecording);

    mediaRecorderRef.current = recorder;
    streamRef.current = stream;
    recorder.start(1000);
    setIsRecording(true);
    setRecordError(null);
    setShowDownloadPrompt(false);
    // Restart the whole reveal from the intro so the recording captures it in full.
    setReplayCount(c => c + 1);
  }

  // A few seconds after the winner overlay appears, the celebratory moment has had time
  // to play out (winner card + a couple of fireworks bursts) — stop recording there.
  useEffect(() => {
    if (!isRecording || !showOverlay) return;
    const timer = setTimeout(stopRecording, 4000);
    return () => clearTimeout(timer);
  }, [isRecording, showOverlay]);

  // Safety net: don't leave a screen-share dangling if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      stopRecording();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const barColors = useMemo(() => assignBarColors(users), [users]);

  // Points/answers should surface in the empty gap between the header and the bars,
  // not at a fixed percentage of the (much taller) bars container — so measure the
  // header's actual bottom edge and position the reveal just below it.
  const headerRef = useRef<HTMLDivElement>(null);
  const barsContainerRef = useRef<HTMLDivElement>(null);
  const [revealTopPx, setRevealTopPx] = useState(24);

  useEffect(() => {
    function recompute() {
      const header = headerRef.current;
      const container = barsContainerRef.current;
      if (!header || !container) return;
      const headerBottom = header.getBoundingClientRect().bottom;
      const containerTop = container.getBoundingClientRect().top;
      setRevealTopPx(headerBottom + 16 - containerTop);
    }
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [sourceIdx, showIntro]);

  useEffect(() => {
    if (pointSources.length === 0) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    const pw = (ms: number) => pausableWait(ms, pausedRef, speedRef, isCancelled);

    async function run() {
      setShowIntro(true);
      setLogosVisible(false);
      setCrawlStarted(false);
      setTotals({});
      setDone(false);
      setShowOverlay(false);
      await pw(INTRO_DARK_MS);
      if (cancelled) return;
      setLogosVisible(true);
      await pw(INTRO_LOGO_FADE_MS + INTRO_LOGO_HOLD_MS);
      if (cancelled) return;
      setLogosVisible(false);
      await pw(INTRO_LOGO_FADE_MS);
      if (cancelled) return;
      setCrawlStarted(true);
      await pw(INTRO_CRAWL_MS);
      if (cancelled) return;
      setShowIntro(false);
      for (let i = 0; i < pointSources.length; i++) {
        if (cancelled) return;
        const source = pointSources[i];
        const hasPreReveal = !!source.answerByUser || source.kind === 'winner';
        setSourceIdx(i);
        setPhase('label');
        await pw(LABEL_MS);
        if (cancelled) return;
        if (hasPreReveal) {
          setPhase('preReveal');
          await pw(PRE_REVEAL_MS);
          if (cancelled) return;
        }
        setPhase('static');
        await pw(STATIC_MS);
        if (cancelled) return;
        setPhase('falling');
        await pw(FALL_MS);
        if (cancelled) return;
        setTotals(prev => {
          const next = { ...prev };
          for (const [uid, pts] of Object.entries(pointSources[i].pointsByUser)) {
            next[uid] = (next[uid] ?? 0) + pts;
          }
          return next;
        });
        setPhase('landed');
        await pw(PAUSE_MS);
      }
      if (!cancelled) {
        setPhase('idle');
        setDone(true);
        await pw(OVERLAY_DELAY_MS);
        if (cancelled) return;
        setShowOverlay(true);
      }
    }

    run();
    return () => { cancelled = true; };
  }, [pointSources, replayCount]);

  const maxTotal = useMemo(() => {
    let max = 0;
    for (const user of users) {
      let sum = 0;
      for (const source of pointSources) sum += source.pointsByUser[user.userId] ?? 0;
      if (sum > max) max = sum;
    }
    return Math.max(max, 1);
  }, [users, pointSources]);

  // Left-to-right order follows current standing — ties keep their prior relative
  // order (stable sort + original-index tiebreaker) so nothing jitters at 0-0.
  const rankByUserId = useMemo(() => {
    const ranked = users
      .map((u, i) => ({ userId: u.userId, i, total: totals[u.userId] ?? 0 }))
      .sort((a, b) => b.total - a.total || a.i - b.i);
    const m = new Map<string, number>();
    ranked.forEach((u, idx) => m.set(u.userId, idx));
    return m;
  }, [users, totals]);

  const winner = useMemo(() => {
    if (!done || users.length === 0) return null;
    return [...users].sort((a, b) => (totals[b.userId] ?? 0) - (totals[a.userId] ?? 0) )[0];
  }, [done, users, totals]);

  const currentSource = sourceIdx >= 0 ? pointSources[sourceIdx] : null;
  const showHeader = currentSource !== null && phase !== 'idle';
  const showReveal = currentSource !== null && (phase === 'preReveal' || phase === 'static' || phase === 'falling');
  const showPoints = currentSource !== null && (phase === 'static' || phase === 'falling');
  const isFalling = phase === 'falling';
  const widthPct = users.length > 0 ? 100 / users.length : 100;

  // Screen recording is a desktop-only browser capability (no mobile browser implements
  // getDisplayMedia) — hide the download entry point entirely rather than showing a
  // button that can only ever fail.
  const recordingSupported = isRecordingSupported();

  // Fast-forward shrinks CSS transition/animation durations to match the sped-up JS timings.
  const speed = fastForward ? FAST_FORWARD_MULTIPLIER : 1;
  const headerTransitionMs = 500 / speed;
  const columnTransitionMs = 700 / speed;
  const barTransitionMs = 700 / speed;
  const fallDurationMs = FALL_MS / speed;
  const introCrawlMs = INTRO_CRAWL_MS / speed;
  const introLogoFadeMs = INTRO_LOGO_FADE_MS / speed;
  const tournamentLogoSrc = tournamentLogoUrl || TOURNAMENT_LOGO_PLACEHOLDER;
  const competitionLogoSrc = competitionLogoUrl || COMPETITION_LOGO_PLACEHOLDER;

  return (
    <div className="fixed inset-0 z-[200] bg-black overflow-hidden">
      <div
        className={`pointer-events-none absolute inset-0 animate-edge-pulse-gold transition-opacity ${
          logosVisible ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ transitionDuration: `${introLogoFadeMs}ms` }}
      />
      <div
        className={`pointer-events-none absolute inset-0 animate-edge-pulse transition-opacity duration-1000 ${
          showIntro ? 'opacity-0' : 'opacity-100'
        }`}
      />

      {!showOverlay && (
        <div className="absolute left-4 top-4 z-[210] flex items-center gap-2 sm:left-6 sm:top-6">
          <button
            onClick={() => { stopRecording(); onGoToLeaderboard(); }}
            aria-label={exitLabel}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#ffe81f]/10 text-[#ffe81f] backdrop-blur hover:bg-[#ffe81f]/20"
          >
            <X size={18} />
          </button>
          <button
            onClick={() => setPaused(p => !p)}
            aria-label={paused ? playLabel : pauseLabel}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#ffe81f]/10 text-[#ffe81f] backdrop-blur hover:bg-[#ffe81f]/20"
          >
            {paused ? <Play size={18} /> : <Pause size={18} />}
          </button>
          {!recordingSupported ? null : isRecording ? (
            <span className="flex items-center gap-1.5 rounded-full bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              {recordingLabel}
            </span>
          ) : (
            <button
              onClick={() => setShowDownloadPrompt(true)}
              aria-label={downloadLabel}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[#ffe81f]/10 text-[#ffe81f] backdrop-blur hover:bg-[#ffe81f]/20"
            >
              <Download size={18} />
            </button>
          )}
        </div>
      )}

      {!showOverlay && (
        <button
          onClick={() => setFastForward(f => !f)}
          aria-label={fastForwardLabel}
          className={`absolute right-4 top-4 z-[210] flex h-9 w-9 items-center justify-center rounded-full backdrop-blur transition-colors sm:right-6 sm:top-6 ${
            fastForward ? 'bg-[#ffe81f]/30 text-[#ffe81f]' : 'bg-[#ffe81f]/10 text-[#ffe81f] hover:bg-[#ffe81f]/20'
          }`}
        >
          <FastForward size={18} />
        </button>
      )}

      {showIntro ? (
        <>
          <div
            className={`absolute inset-0 flex items-center justify-center gap-6 px-6 transition-opacity sm:gap-10 ${
              logosVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
            style={{ transitionDuration: `${introLogoFadeMs}ms` }}
          >
            <div className="flex h-28 w-28 items-center justify-center rounded-2xl bg-white p-3 shadow-2xl sm:h-44 sm:w-44 sm:p-4 md:h-56 md:w-56">
              <img src={tournamentLogoSrc} alt="" className="h-full w-full object-contain" />
            </div>
            <div className="flex h-28 w-28 items-center justify-center rounded-2xl bg-white p-3 shadow-2xl sm:h-44 sm:w-44 sm:p-4 md:h-56 md:w-56">
              <img src={competitionLogoSrc} alt="" className="h-full w-full object-contain" />
            </div>
          </div>

          {crawlStarted && (
            <div className="intro-crawl-container px-1 sm:px-6">
              <div
                className="animate-intro-crawl text-center text-3xl font-black uppercase leading-tight tracking-wide text-[#ffe81f] sm:text-7xl lg:text-9xl"
                style={{ animationDuration: `${introCrawlMs}ms` }}
              >
                {introText.split('\n\n').map((paragraph, i) => (
                  <p key={i} className="mb-10 last:mb-0 sm:mb-16">{paragraph}</p>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div
            ref={headerRef}
            className={`absolute inset-x-0 top-16 z-10 px-4 text-center transition-opacity sm:top-6 ${
              showHeader ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ transitionDuration: `${headerTransitionMs}ms` }}
          >
            {currentSource?.eyebrow && (
              <div className="text-sm font-medium uppercase tracking-wide text-[#ffe81f]/60 sm:text-lg">{currentSource.eyebrow}</div>
            )}
            <div className="text-xl font-semibold tracking-wide text-[#ffe81f] sm:text-3xl">{currentSource?.label}</div>
            {currentSource?.kind === 'winner' ? (
              <div className="mt-2 flex items-center justify-center gap-2">
                <TeamIcon team={currentSource.actualTeam} size={40} />
                {currentSource.actualTeam?.name && (
                  <span className="text-lg font-semibold text-[#ffe81f] sm:text-2xl">{currentSource.actualTeam.name}</span>
                )}
              </div>
            ) : currentSource?.subLabel && (
              <div className="mt-1 text-sm text-[#ffe81f]/70 sm:text-lg">{currentSource.subLabel}</div>
            )}
          </div>

          <div ref={barsContainerRef} className="absolute left-4 right-4 top-56 bottom-20 sm:left-8 sm:right-8 sm:top-64">
            {users.map(user => {
              const total = totals[user.userId] ?? 0;
              const pct = Math.min((total / maxTotal) * 100, 100);
              const sourcePoints = currentSource?.pointsByUser[user.userId] ?? 0;
              const sourceAnswer = currentSource?.answerByUser?.[user.userId];
              const isCorrect = sourcePoints > 0;
              const predictedTeam = currentSource?.predictedTeamByUser?.[user.userId];
              const color = barColors[user.userId] ?? '#4b5563';
              const rank = rankByUserId.get(user.userId) ?? 0;

              return (
                <div
                  key={user.userId}
                  className="absolute inset-y-0 flex flex-col items-center justify-end transition-[left] ease-in-out"
                  style={{ left: `${rank * widthPct}%`, width: `${widthPct}%`, transitionDuration: `${columnTransitionMs}ms` }}
                >
                  {showReveal && (
                    <div
                      key={`${currentSource?.id}-reveal`}
                      className={`absolute left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-1.5 ${
                        isFalling ? 'animate-points-fall' : ''
                      }`}
                      style={
                        isFalling
                          ? ({
                              ['--fall-start' as string]: `${revealTopPx}px`,
                              animationDuration: `${fallDurationMs}ms`,
                              animationPlayState: paused ? 'paused' : 'running',
                            } as React.CSSProperties)
                          : { top: revealTopPx, opacity: 1 }
                      }
                    >
                      {sourceAnswer !== undefined && (
                        <span className={`max-w-[150px] whitespace-normal break-words text-center leading-tight font-semibold sm:max-w-[260px] ${answerFontSizeClass(sourceAnswer || '—')} ${isCorrect ? 'text-[#ffe81f]' : 'text-gray-400'}`}>
                          {sourceAnswer || '—'}
                        </span>
                      )}
                      {currentSource?.kind === 'winner' && (
                        <TeamIcon team={predictedTeam} size={32} correct={isCorrect} />
                      )}
                      {showPoints && (
                        <span className={`text-3xl font-extrabold sm:text-5xl ${sourcePoints > 0 ? 'text-[#ffe81f]' : 'text-gray-500'}`}>
                          {sourcePoints > 0 ? `+${sourcePoints}` : '0'}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex w-full flex-1 items-end px-1 sm:px-1.5">
                    <div
                      className="w-full rounded-t-sm transition-[height] ease-out"
                      style={{ height: `${pct}%`, background: `linear-gradient(to top, ${color}, ${color}99)`, transitionDuration: `${barTransitionMs}ms` }}
                    />
                  </div>
                  <div className="mt-2 flex max-w-full flex-col items-center gap-1">
                    <UserAvatar
                      username={user.username}
                      imageUrl={user.imageUrl}
                      iconColor={user.iconColor}
                      className="h-8 w-8 sm:h-10 sm:w-10"
                      resizeWidth={96}
                    />
                    <span className="max-w-full truncate text-[10px] font-medium text-white sm:text-xs">
                      {user.username}
                    </span>
                    <span className="text-xs font-bold text-white sm:text-sm">{total}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {done && !isRecording && (
        <div className="absolute inset-x-0 bottom-4 z-[150] flex items-center justify-center gap-3">
          <button
            onClick={() => setReplayCount(c => c + 1)}
            aria-label={replayLabel}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#ffe81f]/10 text-[#ffe81f] backdrop-blur hover:bg-[#ffe81f]/20"
          >
            <RotateCcw size={18} />
          </button>
          <button
            onClick={onGoToLeaderboard}
            className="rounded-full bg-[#ffe81f]/10 px-5 py-2 text-sm font-medium text-[#ffe81f] backdrop-blur hover:bg-[#ffe81f]/20 sm:text-base"
          >
            {toLeaderboardLabel}
          </button>
        </div>
      )}

      {showDownloadPrompt && (
        <div className="fixed inset-0 z-[310] flex items-center justify-center bg-black/70 p-4">
          <div className="relative w-full max-w-sm rounded-xl border border-[#ffe81f]/20 bg-neutral-900 p-6 text-center shadow-2xl">
            <button
              onClick={() => { setShowDownloadPrompt(false); setRecordError(null); }}
              aria-label={closeLabel}
              className="absolute right-3 top-3 text-[#ffe81f]/60 hover:text-[#ffe81f]"
            >
              <X size={20} />
            </button>
            <Video size={28} className="mx-auto mb-3 text-[#ffe81f]/80" />
            <p className="text-lg font-bold text-[#ffe81f]">{downloadPromptTitle}</p>
            <p className="mt-2 text-sm text-white/70">{downloadPromptBody}</p>
            {recordError && <p className="mt-3 text-sm text-red-400">{recordError}</p>}
            <div className="mt-5 flex justify-center gap-3">
              <button
                onClick={() => { setShowDownloadPrompt(false); setRecordError(null); }}
                className="rounded-full border border-[#ffe81f]/30 px-4 py-2 text-sm font-medium text-[#ffe81f] hover:bg-[#ffe81f]/10"
              >
                {cancelLabel}
              </button>
              <button
                onClick={handleStartRecording}
                className="rounded-full bg-[#ffe81f] px-4 py-2 text-sm font-medium text-black hover:bg-[#ffe81f]/90"
              >
                {startRecordingLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {showOverlay && winner && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4">
          <Fireworks />
          <div className="relative w-full max-w-sm rounded-xl border border-[#ffe81f]/20 bg-neutral-900 p-6 text-center shadow-2xl">
            <button
              onClick={() => setShowOverlay(false)}
              aria-label={closeLabel}
              className="absolute right-3 top-3 text-[#ffe81f]/60 hover:text-[#ffe81f]"
            >
              <X size={20} />
            </button>
            <div className="mb-3 text-4xl">🏆</div>
            <UserAvatar
              username={winner.username}
              imageUrl={winner.imageUrl}
              iconColor={winner.iconColor}
              className="mx-auto h-16 w-16"
              resizeWidth={128}
            />
            <p className="mt-3 text-lg font-bold text-[#ffe81f]">{winnerLabel(winner.username)}</p>
            <p className="text-sm text-[#ffe81f]/60">{totals[winner.userId] ?? 0} pts</p>
          </div>
        </div>
      )}
    </div>
  );
}
