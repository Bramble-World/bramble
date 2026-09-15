'use client';

import Image from 'next/image';
import { useState } from 'react';

// A person's avatar. Falls back to a grey disc with their initial when the
// artwork is missing, so a dropped asset never leaves a hole in the graph.

type Props = {
  src?: string | null;
  /** Name to take the fallback initial from. */
  fallback: string;
  /** Ring width as a CSS length; the graph scales it with the node. */
  ringWidth?: string;
  ringColor?: string;
  /** Sized by the parent — this fills whatever square it is given. */
  className?: string;
  style?: React.CSSProperties;
  sizes?: string;
  grayscale?: boolean;
};

export function PortraitCircle({
  src,
  fallback,
  ringWidth,
  ringColor = '#ffffff',
  className = '',
  style,
  sizes = '120px',
  grayscale = false,
}: Props) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <div
      className={`@container relative aspect-square overflow-hidden rounded-full ${className}`}
      style={{
        ...style,
        boxShadow: ringWidth ? `inset 0 0 0 ${ringWidth} ${ringColor}` : undefined,
      }}
    >
      {showImage ? (
        <Image
          src={src as string}
          alt=""
          fill
          sizes={sizes}
          onError={() => setFailed(true)}
          className={`object-cover ${grayscale ? 'grayscale' : ''}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#dadada]">
          <span className="font-grotesque text-[36cqw] font-semibold text-black/45">
            {fallback.slice(0, 1).toUpperCase()}
          </span>
        </div>
      )}
    </div>
  );
}
