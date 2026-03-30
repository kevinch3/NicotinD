import { useState } from 'react';

const GRADIENTS = [
  ['#6366f1', '#8b5cf6'],
  ['#ec4899', '#f43f5e'],
  ['#14b8a6', '#06b6d4'],
  ['#f59e0b', '#ef4444'],
  ['#10b981', '#14b8a6'],
  ['#3b82f6', '#6366f1'],
  ['#8b5cf6', '#d946ef'],
  ['#f97316', '#f59e0b'],
];

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

interface CoverArtProps {
  src?: string;
  artist?: string;
  album?: string;
  size: number;
  className?: string;
  rounded?: string;
}

export function CoverArt({
  src,
  artist = '',
  album = '',
  size,
  className = '',
  rounded = 'rounded',
}: CoverArtProps) {
  const [imgError, setImgError] = useState(false);

  const [from, to] =
    GRADIENTS[hashCode(`${artist}:${album}`) % GRADIENTS.length];

  const style = {
    width: size,
    height: size,
    flexShrink: 0 as const,
  };

  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={album || artist || 'cover'}
        width={size}
        height={size}
        className={`object-cover ${rounded} ${className}`}
        style={{ flexShrink: 0 }}
        onError={() => setImgError(true)}
      />
    );
  }

  const initial = (album || artist || '?')[0].toUpperCase();

  return (
    <div
      className={`${rounded} flex items-center justify-center select-none ${className}`}
      style={{
        ...style,
        background: `linear-gradient(135deg, ${from}, ${to})`,
      }}
    >
      <span
        style={{ fontSize: size * 0.35, color: 'rgba(255,255,255,0.85)', fontWeight: 700 }}
      >
        {initial}
      </span>
    </div>
  );
}
