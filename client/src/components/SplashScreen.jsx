import { useState, useEffect, useRef } from 'react';
import logo from '../assets/panther head.png';
import roarSrc from '../assets/panther-roar.wav';

const WELCOME_TEXT = "Welcome to The PNTHR's Den";

function startHeartbeat() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    let stopped = false;
    let bpm = 35;
    let volume = 0.15;
    let timeout;

    function beat() {
      if (stopped) return;

      // Each heartbeat is a short filtered thump — like a bass drum in your chest
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(60, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.25);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

      osc.connect(gain).connect(master);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);

      // Double-tap for realistic heartbeat (lub-dub)
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(50, ctx.currentTime + 0.12);
      osc2.frequency.exponentialRampToValueAtTime(25, ctx.currentTime + 0.35);

      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0, ctx.currentTime);
      gain2.gain.setValueAtTime(volume * 0.6, ctx.currentTime + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);

      osc2.connect(gain2).connect(master);
      osc2.start(ctx.currentTime + 0.12);
      osc2.stop(ctx.currentTime + 0.5);

      // Accelerate and get louder over time
      bpm = Math.min(bpm + 3, 120);
      volume = Math.min(volume + 0.025, 0.7);

      const interval = 60000 / bpm;
      timeout = setTimeout(beat, interval);
    }

    // Start first beat
    beat();

    return {
      fadeOut(duration = 1.5) {
        const now = ctx.currentTime;
        master.gain.linearRampToValueAtTime(0, now + duration);
        setTimeout(() => { stopped = true; clearTimeout(timeout); ctx.close(); }, duration * 1000 + 100);
      },
      stop() {
        stopped = true;
        clearTimeout(timeout);
        ctx.close();
      },
    };
  } catch (_) {
    return { fadeOut() {}, stop() {} };
  }
}

export default function SplashScreen({ onComplete }) {
  const [phase, setPhase] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const audioRef = useRef(null);
  const droneRef = useRef(null);

  useEffect(() => {
    // Start heartbeat when head begins appearing
    const tDrone = setTimeout(() => {
      droneRef.current = startHeartbeat();
    }, 1500);

    const t0 = setTimeout(() => setPhase(1), 1500);
    const t1 = setTimeout(() => setPhase(2), 11500);
    const t2 = setTimeout(() => setPhase(3), 12500);

    let typeTimer;
    const t3 = setTimeout(() => {
      let i = 0;
      typeTimer = setInterval(() => {
        i++;
        setCharCount(i);
        if (i >= WELCOME_TEXT.length) clearInterval(typeTimer);
      }, 70);
    }, 12500);

    const roarTime = 12500 + WELCOME_TEXT.length * 70 + 400;
    const t4 = setTimeout(() => {
      setPhase(4);
      if (droneRef.current) droneRef.current.fadeOut(1.5);
      try {
        audioRef.current = new Audio(roarSrc);
        audioRef.current.volume = 0.85;
        audioRef.current.play();
      } catch (_) { /* audio not supported */ }
    }, roarTime);

    const t5 = setTimeout(() => setPhase(5), roarTime + 2500);
    const t6 = setTimeout(() => onComplete(), roarTime + 3700);

    return () => {
      clearTimeout(tDrone);
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
      clearTimeout(t6);
      if (typeTimer) clearInterval(typeTimer);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      if (droneRef.current) { droneRef.current.stop(); droneRef.current = null; }
    };
  }, [onComplete]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: '#000',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      opacity: phase === 5 ? 0 : 1,
      transition: 'opacity 1.2s ease-out',
    }}>
      <img
        src={logo}
        alt="PNTHR"
        style={{
          width: phase >= 2 ? '70vh' : phase >= 1 ? 80 : 30,
          height: phase >= 2 ? '70vh' : phase >= 1 ? 80 : 30,
          objectFit: 'contain',
          opacity: phase >= 1 ? 1 : 0,
          filter: `brightness(${phase >= 2 ? 1.4 : phase >= 1 ? 0.15 : 0})`,
          transition: phase >= 2
            ? 'width 1.5s ease-out, height 1.5s ease-out, filter 1s ease-in, opacity 0.5s'
            : 'width 10s ease-out, height 10s ease-out, filter 10s ease-in, opacity 3s ease-in',
        }}
      />
      <div style={{
        marginTop: 40,
        fontSize: 32,
        fontStyle: 'italic',
        fontWeight: 300,
        color: '#FCF000',
        letterSpacing: '0.08em',
        height: 44,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}>
        {phase >= 3 && (
          <span>{WELCOME_TEXT.slice(0, charCount)}</span>
        )}
        {phase >= 3 && charCount < WELCOME_TEXT.length && (
          <span style={{
            display: 'inline-block', width: 2, height: '1em',
            background: '#FCF000', marginLeft: 2, verticalAlign: 'text-bottom',
            animation: 'blink 0.6s step-end infinite',
          }} />
        )}
      </div>
      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
    </div>
  );
}
