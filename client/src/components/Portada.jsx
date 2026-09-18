import { useRef } from 'react';

// Portada de una plantilla: imagen, o video que se reproduce al pasar el mouse.
export default function Portada({ cover, alt, autoPlay = false, onDuracion }) {
  const ref = useRef(null);
  if (!cover?.url) return null;
  const esVideo = cover.type === 'video' || /\.mp4($|\?)/i.test(cover.url);
  const ratio = cover.width && cover.height ? `${cover.width} / ${cover.height}` : undefined;
  if (!esVideo) return <img src={cover.url} alt={alt} loading="lazy" style={{ aspectRatio: ratio }} />;
  return (
    <video
      ref={ref}
      src={cover.url}
      poster={cover.poster_url}
      muted
      loop
      playsInline
      autoPlay={autoPlay}
      preload={autoPlay ? 'auto' : 'none'}
      style={{ aspectRatio: ratio }}
      onLoadedMetadata={(e) => onDuracion?.(e.currentTarget.duration)}
      onMouseEnter={() => !autoPlay && ref.current?.play().catch(() => {})}
      onMouseLeave={() => { if (!autoPlay && ref.current) { ref.current.pause(); ref.current.currentTime = 0; } }}
    />
  );
}

export const esVideo = (cover) => !!cover && (cover.type === 'video' || /\.mp4($|\?)/i.test(cover.url || ''));
