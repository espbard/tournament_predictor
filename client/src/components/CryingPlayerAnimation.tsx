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
        @keyframes cryingTearLeft {
          0%   { transform: translate(0px, 0px); opacity: 0; }
          8%   { opacity: 1; }
          88%  { transform: translate(-4px, 90px); opacity: 0.7; }
          100% { transform: translate(-5px, 112px); opacity: 0; }
        }
        @keyframes cryingTearRight {
          0%   { transform: translate(0px, 0px); opacity: 0; }
          8%   { opacity: 1; }
          88%  { transform: translate(4px, 90px); opacity: 0.7; }
          100% { transform: translate(5px, 112px); opacity: 0; }
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
        {/* Crying player — static */}
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
          }}
        />

        {/* Left eye */}
        <img
          src="/crying-tear.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: '103px',
            left: '85px',
            height: '22px',
            width: '16px',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'cryingTearLeft 3.8s ease-in 0s infinite',
          }}
        />

        {/* Right eye */}
        <img
          src="/crying-tear.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: '103px',
            left: '114px',
            height: '22px',
            width: '16px',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'cryingTearRight 4.0s ease-in 1.5s infinite',
          }}
        />
      </div>
    </div>
  );
}
