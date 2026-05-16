import { useState, useEffect, useRef } from 'react';
import logo from '../assets/panther head.png';
import roarSrc from '../assets/panther-roar.wav';

export default function SplashScreen({ onComplete }) {
  const [phase, setPhase] = useState(0); // 0=logo growing, 1=text fade in, 2=fade out
  const audioRef = useRef(null);

  useEffect(() => {
    // Phase 0: logo starts growing immediately
    // Phase 1: text appears + growl plays at 1.5s
    const t1 = setTimeout(() => {
      setPhase(1);
      try {
        audioRef.current = new Audio(roarSrc);
        audioRef.current.volume = 0.8;
        audioRef.current.play();
      } catch (_) { /* audio not supported */ }
    }, 1500);

    // Phase 2: fade out at 4s
    const t2 = setTimeout(() => setPhase(2), 4000);

    // Complete at 4.8s (after fade out animation)
    const t3 = setTimeout(() => onComplete(), 4800);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  }, [onComplete]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: '#000',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      opacity: phase === 2 ? 0 : 1,
      transition: 'opacity 0.8s ease-out',
    }}>
      <img
        src={logo}
        alt="PNTHR"
        style={{
          width: phase >= 1 ? 160 : 60,
          height: phase >= 1 ? 160 : 60,
          objectFit: 'contain',
          filter: `brightness(${phase >= 1 ? 1.3 : 0.4})`,
          transition: 'width 2s ease-out, height 2s ease-out, filter 2s ease-out',
        }}
      />
      <div style={{
        marginTop: 30,
        fontSize: 28,
        fontStyle: 'italic',
        fontWeight: 300,
        color: '#FCF000',
        letterSpacing: '0.08em',
        opacity: phase >= 1 ? 1 : 0,
        transform: phase >= 1 ? 'translateY(0)' : 'translateY(12px)',
        transition: 'opacity 1.2s ease-out 0.3s, transform 1.2s ease-out 0.3s',
      }}>
        Welcome to The PNTHR's Den
      </div>
    </div>
  );
}
