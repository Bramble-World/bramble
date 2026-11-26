import { ImageResponse } from 'next/og';

/** The link preview: never the inviter's name, which anyone the link reaches would see. */
export const alt = 'a story for two on bramble';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#FFFFFB',
        color: '#000',
        gap: 24,
      }}
    >
      <div style={{ fontSize: 96, fontWeight: 700 }}>a story for two</div>
      <div style={{ fontSize: 48, opacity: 0.6 }}>on bramble</div>
    </div>,
    size
  );
}
