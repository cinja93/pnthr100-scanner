import { useState, useEffect, useRef } from 'react';
import logo from '../assets/panther head.png';
import roarSrc from '../assets/panther-roar.wav';

const WELCOME_TEXT = "Welcome to The PNTHR's Den";

export default function SplashScreen({ onComplete }) {
  const [phase, setPhase] = useState(0);
  // 0 = black (0-1.5s)
  // 1 = head fading in from pure black, very slow (1.5s)
  // 2 = head fully bright and huge (6s)
  // 3 = typewriter text starts (7s)
  // 4 = roar plays after text finishes (9.5s)
  // 5 = fade out (11.5s)
  const [charCount, setCharCount] = useState(0);
  const audioRef = useRef(null);

  useEffect(() => {
    const t0 = setTimeout(() => setPhase(1), 1500);
    const t1 = setTimeout(() => setPhase(2), 6000);
    const t2 = setTimeout(() => setPhase(3), 7000);

    // Typewriter: reveal one char every 70ms starting at phase 3
    let typeTimer;
    const t3 = setTimeout(() => {
      let i = 0;
      typeTimer = setInterval(() => {
        i++;
        setCharCount(i);
        if (i >= WELCOME_TEXT.length) clearInterval(typeTimer);
      }, 70);
    }, 7000);

    // Roar after typewriter finishes (~7s + 26chars × 70ms ≈ 8.8s)
    const roarTime = 7000 + WELCOME_TEXT.length * 70 + 400;
    const t4 = setTimeout(() => {
      setPhase(4);
      try {
        audioRef.current = new Audio(roarSrc);
        audioRef.current.volume = 0.85;
        audioRef.current.play();
      } catch (_) { /* audio not supported */ }
    }, roarTime);

    const t5 = setTimeout(() => setPhase(5), roarTime + 2500);
    const t6 = setTimeout(() => onComplete(), roarTime + 3700);

    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
      clearTimeout(t6);
      if (typeTimer) clearInterval(typeTimer);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
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
            : 'width 4.5s ease-out, height 4.5s ease-out, filter 4.5s ease-in, opacity 3s ease-in',
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
