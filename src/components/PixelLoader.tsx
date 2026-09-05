export function PixelLoader({ label = "Loading" }: { label?: string }) {
  return <span className="pixel-loading" role="status"><span className="pixel-matrix" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ animationDelay: `${index * 90}ms` }} />)}</span><span>{label}</span></span>;
}
