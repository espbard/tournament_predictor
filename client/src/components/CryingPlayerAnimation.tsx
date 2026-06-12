import { useRef, useState, useEffect } from 'react';

const DESIGN_HEIGHT = 200;

export function CryingPlayerAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      setScale(Math.min(1, Math.max(0.1, h / DESIGN_HEIGHT)));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ opacity: 0.18 }}
    >
      <style>{`
        @keyframes cryingPlayerSob {
          0%, 100% { transform: rotate(0deg) translateY(0px); }
          30%      { transform: rotate(-2deg) translateY(-3px); }
          65%      { transform: rotate(0deg) translateY(0px); }
          82%      { transform: rotate(-1deg) translateY(-2px); }
        }
        @keyframes cryingTear1 {
          0%        { transform: translate(0px, 0px); opacity: 0; }
          8%        { opacity: 1; }
          85%       { transform: translate(-3px, 90px); opacity: 0.7; }
          100%      { transform: translate(-4px, 112px); opacity: 0; }
        }
        @keyframes cryingTear2 {
          0%        { transform: translate(0px, 0px); opacity: 0; }
          8%        { opacity: 1; }
          85%       { transform: translate(2px, 82px); opacity: 0.6; }
          100%      { transform: translate(3px, 104px); opacity: 0; }
        }
        @keyframes cryingTear3 {
          0%        { transform: translate(0px, 0px); opacity: 0; }
          8%        { opacity: 1; }
          85%       { transform: translate(-1px, 96px); opacity: 0.8; }
          100%      { transform: translate(-2px, 118px); opacity: 0; }
        }
      `}</style>

      {/* Inner wrapper — fixed design size, scales from bottom-left */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: '200px',
          height: `${DESIGN_HEIGHT}px`,
          transformOrigin: 'bottom left',
          transform: `scale(${scale})`,
        }}
      >
        {/* Crying player */}
        <img
          src="/crying-player.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: 0,
            left: '20px',
            height: '180px',
            width: 'auto',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'cryingPlayerSob 3.5s ease-in-out infinite',
          }}
        />

        {/* Tears — staggered, falling from eye level */}
        <img
          src="/crying-tear.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: '113px',
            left: '90px',
            height: '22px',
            width: '16px',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'cryingTear1 2.2s ease-in 0s infinite',
          }}
        />
        <img
          src="/crying-tear.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: '110px',
            left: '86px',
            height: '19px',
            width: '14px',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'cryingTear2 2.5s ease-in 0.9s infinite',
          }}
        />
        <img
          src="/crying-tear.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: '116px',
            left: '92px',
            height: '20px',
            width: '15px',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'cryingTear3 2.0s ease-in 1.6s infinite',
          }}
        />
      </div>
    </div>
  );
}
