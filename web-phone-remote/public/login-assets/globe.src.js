// 登录页地球：与 tianxi-ui 登录页同一套 cobe 参数（src/pages/login/index.tsx），去掉 React 外壳。
import createGlobe from 'cobe';

const MARKERS = [
  [1.3521, 103.8198], [35.6762, 139.6503], [25.2048, 55.2708], [51.5072, -0.1276],
  [34.0522, -118.2437], [40.7128, -74.006], [-33.8688, 151.2093], [-23.5505, -46.6333],
].map((location) => ({ location, size: 0.026 }));
const ARCS = [
  [[1.3521, 103.8198], [25.2048, 55.2708]], [[25.2048, 55.2708], [51.5072, -0.1276]],
  [[51.5072, -0.1276], [40.7128, -74.006]], [[40.7128, -74.006], [34.0522, -118.2437]],
  [[1.3521, 103.8198], [-33.8688, 151.2093]],
].map(([from, to]) => ({ from, to }));

function start() {
  const canvas = document.getElementById('globe');
  if (!canvas) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  let size = canvas.offsetWidth;
  let phi = 0.4;
  let globe;
  try {
    globe = createGlobe(canvas, {
      devicePixelRatio: dpr, width: size * dpr, height: size * dpr,
      phi, theta: 0.14, dark: 1, diffuse: 1.55, scale: 1.12,
      mapSamples: 16000, mapBrightness: 8, mapBaseBrightness: 0.16,
      baseColor: [0.13, 0.15, 0.2], glowColor: [0.15, 0.22, 0.46], markerColor: [0.36, 0.62, 1],
      markers: MARKERS, arcs: ARCS, arcColor: [0.24, 0.38, 0.62], arcWidth: 0.36, arcHeight: 0.18,
    });
  } catch {
    canvas.closest('.globe')?.classList.add('no-webgl');
    return;
  }
  canvas.style.opacity = '1';
  let visible = true;
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; });
  window.addEventListener('resize', () => {
    const next = canvas.offsetWidth;
    if (next && next !== size) { size = next; globe.update({ width: size * dpr, height: size * dpr }); }
  });
  if (reduce) return;
  const frame = () => {
    if (visible) { phi += 0.0022; globe.update({ phi }); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
