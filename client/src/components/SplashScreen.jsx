import { useState, useEffect, useRef } from 'react';
import logo from '../assets/panther head.png';
import roarSrc from '../assets/panther-roar.wav';

export default function SplashScreen({ onComplete }) {
  const [phase, setPhase] = useState(0);
  // 0 = black, nothing (0-0.8s)
  // 1 = head fading in from darkness, growing slowly (0.8s)
  // 2 = head huge and bright, filling screen — roar plays (4s)
  // 3 = text fades in below (5.5s)
  // 4 = fade out (8s)
  const audioRef = useRef(null);

  useEffect(() => {
    const t0 = setTimeout(() => setPhase(1), 800);

    const t1 = setTimeout(() => {
      setPhase(2);
      try {
        audioRef.current = new Audio(roarSrc);
        audioRef.current.volume = 0.85;
        audioRef.current.play();
      } catch (_) { /* audio not supported */ }
    }, 4000);

    const t2 = setTimeout(() => setPhase(3), 5500);

    const t3 = setTimeout(() => setPhase(4), 8000);

    const t4 = setTimeout(() => onComplete(), 9200);

    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  }, [onComplete]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: '#000',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      opacity: phase === 4 ? 0 : 1,
      transition: 'opacity 1.2s ease-out',
    }}>
      <img
        src={logo}
        alt="PNTHR"
        style={{
          width: phase >= 2 ? '70vh' : phase >= 1 ? 120 : 40,
          height: phase >= 2 ? '70vh' : phase >= 1 ? 120 : 40,
          objectFit: 'contain',
          opacity: phase >= 1 ? 1 : 0,
          filter: `brightness(${phase >= 2 ? 1.4 : phase >= 1 ? 0.3 : 0})`,
          transition: phase >= 2
            ? 'width 3s ease-out, height 3s ease-out, filter 2s ease-in, opacity 0.5s'
            : 'width 3s ease-out, height 3s ease-out, filter 3s ease-in, opacity 2s ease-in',
        }}
      />
      <div style={{
        marginTop: 40,
        fontSize: 32,
        fontStyle: 'italic',
        fontWeight: 300,
        color: '#FCF000',
        letterSpacing: '0.08em',
        opacity: phase >= 3 ? 1 : 0,
        transform: phase >= 3 ? 'translateY(0)' : 'translateY(16px)',
        transition: 'opacity 1.5s ease-out, transform 1.5s ease-out',
      }}>
        Welcome to The PNTHR's Den
      </div>
    </div>
  );
}
