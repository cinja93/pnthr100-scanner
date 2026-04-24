// client/src/components/HeaderTooltip.jsx
// Reusable column-header tooltip for table `<th>` elements.
//
// Native HTML `title` attributes are unreliable — Chrome delays them 1.5-2s,
// ad-blockers / extensions suppress them, and they can't be styled. This
// component renders a styled popover instantly on hover using position: fixed
// and getBoundingClientRect so the table's overflow-x: auto container can't
// clip the popover. Native title is kept as an accessibility fallback
// (screen readers, mobile long-press) but the custom popover drives the UX.
//
// Usage:
//   <ThTip label="REPORTED" tooltip="..." style={thR}>REPORTED</ThTip>
//
// If you pass a string as the only child with no `label`, the child text is
// used as the header in the popover.

import { useState, useRef } from 'react';

export default function ThTip({ children, tooltip, label, style }) {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);

  const show = () => { if (tooltip && ref.current) setRect(ref.current.getBoundingClientRect()); };
  const hide = () => setRect(null);

  const headerLabel = (label ?? (typeof children === 'string' ? children : '')).toString();

  const mergedStyle = tooltip
    ? {
        ...style,
        cursor: 'help',
        textDecoration: 'underline dotted rgba(255,255,255,0.28)',
        textUnderlineOffset: 3,
        position: 'relative',
      }
    : style;

  return (
    <th
      ref={ref}
      style={mergedStyle}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      title={tooltip || undefined}
    >
      {children}
      {rect && tooltip && (
        <div
          style={{
            position:   'fixed',
            top:        rect.bottom + 8,
            left:       Math.max(8, Math.min(rect.left, window.innerWidth - 360 - 8)),
            width:      360,
            maxWidth:   'calc(100vw - 16px)',
            zIndex:     9999,
            padding:    '12px 14px',
            background: '#1a1a1a',
            border:     '1px solid rgba(252,240,0,0.3)',
            borderRadius: 6,
            color:      '#e0e0e0',
            fontSize:   12,
            fontWeight: 400,
            lineHeight: 1.55,
            letterSpacing: 'normal',
            textTransform: 'none',
            textAlign:  'left',
            whiteSpace: 'normal',
            boxShadow:  '0 8px 28px rgba(0,0,0,0.7)',
            pointerEvents: 'none',
          }}
        >
          {headerLabel && (
            <div style={{
              color: '#FCF000', fontWeight: 800, fontSize: 10, letterSpacing: '0.12em',
              marginBottom: 6, textTransform: 'uppercase',
            }}>
              {headerLabel}
            </div>
          )}
          {tooltip}
        </div>
      )}
    </th>
  );
}
