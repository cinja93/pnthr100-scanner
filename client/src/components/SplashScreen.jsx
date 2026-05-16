import { useState, useEffect, useRef } from 'react';
import logo from '../assets/panther head.png';
import roarSrc from '../assets/panther-roar.wav';

const WELCOME_TEXT = "Welcome to The PNTHR's Den";

function startDrone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 4);
    master.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 9);
    master.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 11);
    master.connect(ctx.destination);

    // Deep bass foundation — sub rumble
    const bass = ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.setValueAtTime(40, ctx.currentTime);
    bass.frequency.linearRampToValueAtTime(55, ctx.currentTime + 10);
    const bassGain = ctx.createGain();
    bassGain.gain.value = 0.7;
    bass.connect(bassGain).connect(master);
    bass.start();

    // Mid drone — dark tension
    const mid = ctx.createOscillator();
    mid.type = 'sawtooth';
    mid.frequency.setValueAtTime(80, ctx.currentTime);
    mid.frequency.linearRampToValueAtTime(110, ctx.currentTime + 10);
    const midGain = ctx.createGain();
    midGain.gain.setValueAtTime(0, ctx.currentTime);
    midGain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 5);
    midGain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 10);
    const midFilter = ctx.createBiquadFilter();
    midFilter.type = 'lowpass';
    midFilter.frequency.setValueAtTime(200, ctx.currentTime);
    midFilter.frequency.linearRampToValueAtTime(600, ctx.currentTime + 10);
    mid.connect(midFilter).connect(midGain).connect(master);
    mid.start();

    // High overtone — eerie shimmer that creeps in
    const high = ctx.createOscillator();
    high.type = 'sine';
    high.frequency.setValueAtTime(220, ctx.currentTime);
    high.frequency.linearRampToValueAtTime(330, ctx.currentTime + 10);
    const highGain = ctx.createGain();
    highGain.gain.setValueAtTime(0, ctx.currentTime);
    highGain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 7);
    highGain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 11);
    high.connect(highGain).connect(master);
    high.start();

    // Subtle LFO tremor on master — heartbeat-like pulse
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.08;
    lfo.connect(lfoGain).connect(master.gain);
    lfo.start();

    return {
      fadeOut(duration = 1.5) {
        const now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0, now + duration);
        setTimeout(() => {
          bass.stop(); mid.stop(); high.stop(); lfo.stop();
          ctx.close();
        }, duration * 1000 + 100);
      },
      stop() {
        bass.stop(); mid.stop(); high.stop(); lfo.stop();
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
    // Start drone when head begins appearing
    const tDrone = setTimeout(() => {
      droneRef.current = startDrone();
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
      // Fade drone out as roar takes over
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
