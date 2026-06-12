export function SoccerKickAnimation() {
  const dur = '3.8s';
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.08]"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 700 300"
        preserveAspectRatio="xMinYMax meet"
        className="absolute bottom-0 left-0 w-full h-full"
      >
        {/* Ground */}
        <line x1="0" y1="272" x2="700" y2="272" stroke="currentColor" strokeWidth="2" />

        {/* Head */}
        <circle cx="90" cy="127" r="13" fill="none" stroke="currentColor" strokeWidth="2.5" />

        {/* Body */}
        <line x1="90" y1="140" x2="90" y2="202" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />

        {/* Back arm */}
        <line x1="90" y1="162" x2="65" y2="192" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />

        {/* Forward arm (balance) */}
        <line x1="90" y1="162" x2="114" y2="178" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />

        {/* Standing left leg */}
        <line x1="90" y1="202" x2="72" y2="248" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="72" y1="248" x2="55" y2="257" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />

        {/* Kicking right leg — rotates around hip (90, 202) */}
        <g>
          <line x1="90" y1="202" x2="108" y2="246" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="108" y1="246" x2="120" y2="258" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="120" y1="258" x2="140" y2="261" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <animateTransform
            attributeName="transform"
            type="rotate"
            values={`0 90 202; -36 90 202; 68 90 202; 0 90 202`}
            keyTimes="0; 0.34; 0.48; 1"
            dur={dur}
            repeatCount="indefinite"
          />
        </g>

        {/* Soccer ball */}
        <g>
          <circle cx="134" cy="259" r="13" fill="none" stroke="currentColor" strokeWidth="2" />
          {/* Center pentagon */}
          <polygon
            points="134,252 141,257 138,265 130,265 127,257"
            fill="currentColor"
            opacity="0.5"
          />
          {/* Lines from pentagon vertices to ball edge */}
          <line x1="134" y1="246" x2="134" y2="252" stroke="currentColor" strokeWidth="1.5" />
          <line x1="146" y1="255" x2="141" y2="257" stroke="currentColor" strokeWidth="1.5" />
          <line x1="142" y1="270" x2="138" y2="265" stroke="currentColor" strokeWidth="1.5" />
          <line x1="126" y1="270" x2="130" y2="265" stroke="currentColor" strokeWidth="1.5" />
          <line x1="122" y1="255" x2="127" y2="257" stroke="currentColor" strokeWidth="1.5" />
          {/* Fade out before loop reset */}
          <animate
            attributeName="opacity"
            values="1; 1; 0; 0"
            keyTimes="0; 0.86; 0.90; 1"
            dur={dur}
            repeatCount="indefinite"
          />
          {/* Fly from foot, arc across, snap back while invisible */}
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; 0 0; 48 -35; 355 -155; 575 48; 575 48"
            keyTimes="0; 0.46; 0.52; 0.74; 0.87; 1"
            dur={dur}
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </div>
  );
}
