// InfoTip — small "?" hover tooltip, portal-based so it renders at document.body
// and is never clipped by a scrolling/overflow-hidden ancestor.

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipState { top: number; bottom: number; left: number }

export function InfoTip({ text }: { text: string }) {
  const [pos, setPos] = useState<TooltipState | null>(null);
  const btnRef = useRef<HTMLSpanElement>(null);

  const open = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.top, bottom: r.bottom, left: r.left + r.width / 2 });
  };

  const close = () => setPos(null);

  // Show below when trigger is in the upper half of the viewport (avoids hiding under title bar)
  const showBelow = pos ? pos.top < window.innerHeight / 2 : false;

  return (
    <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
      <span
        ref={btnRef}
        onMouseEnter={open}
        onMouseLeave={close}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          background: '#334155', color: '#94a3b8',
          fontSize: 9, fontWeight: 700, cursor: 'help', marginLeft: 4, flexShrink: 0,
          lineHeight: 1,
        }}
      >?</span>
      {pos && createPortal(
        <div style={{
          position: 'fixed',
          ...(showBelow
            ? { top: pos.bottom + 6 }
            : { bottom: `calc(100vh - ${pos.top}px + 6px)` }),
          left: pos.left,
          transform: 'translateX(-50%)',
          zIndex: 99999,
          background: '#1e293b',
          border: '1px solid #475569',
          borderRadius: 6,
          padding: '9px 11px',
          fontSize: 11,
          color: '#cbd5e1',
          lineHeight: 1.55,
          maxWidth: 280,
          width: 'max-content',
          boxShadow: '0 6px 18px rgba(0,0,0,0.6)',
          pointerEvents: 'none',
          whiteSpace: 'pre-line',
        }}>
          {text}
        </div>,
        document.body,
      )}
    </span>
  );
}
