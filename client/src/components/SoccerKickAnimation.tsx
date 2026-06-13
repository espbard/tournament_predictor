import { useRef, useState, useEffect } from 'react';

const DESIGN_HEIGHT = 220; // px — player (200) + 20px breathing room for jump animation

export function SoccerKickAnimation() {
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
        @keyframes soccerPlayerKick {
          0%, 28%  { transform: translateY(0px) rotate(0deg); }
          40%      { transform: translateY(-12px) rotate(-4deg); }
          54%      { transform: translateY(4px) rotate(2deg); }
          68%, 100%{ transform: translateY(0px) rotate(0deg); }
        }
        @keyframes soccerBallFly {
          0%, 37%  { transform: translate(0px, 0px) rotate(0deg); opacity: 1; }
          42%      { transform: translate(45px, -32px) rotate(80deg); opacity: 1; }
          66%      { transform: translate(390px, -210px) rotate(420deg); opacity: 1; }
          86%      { transform: translate(670px, 60px) rotate(570deg); opacity: 0; }
          91%, 100%{ transform: translate(0px, 0px) rotate(0deg); opacity: 0; }
        }
      `}</style>

      {/* Inner wrapper: fixed design size, scales from bottom-left to fit container */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: '260px',
          height: `${DESIGN_HEIGHT}px`,
          transformOrigin: 'bottom left',
          transform: `scale(${scale})`,
        }}
      >
        <img
          src="/soccer-player.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: 0,
            left: '24px',
            height: '200px',
            width: 'auto',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'soccerPlayerKick 4s ease-in-out infinite',
          }}
        />
        <img
          src="/soccer-ball.png"
          alt=""
          style={{
            position: 'absolute',
            bottom: '6px',
            left: '178px',
            height: '58px',
            width: '58px',
            objectFit: 'contain',
            mixBlendMode: 'multiply',
            animation: 'soccerBallFly 4s ease-in-out infinite',
          }}
        />
      </div>
    </div>
  );
}
