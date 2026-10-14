// canvas でアイコン（色＋形＋文字）を描く。地図用 ImageData と一覧用 dataURL の両方を返す。

const SIZE = 56;

function polygon(n, rotate = -Math.PI / 2, r = 22) {
  const c = SIZE / 2;
  return Array.from({ length: n }, (_, i) => {
    const a = rotate + (i * 2 * Math.PI) / n;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  });
}

function shapePath(shape) {
  const c = SIZE / 2;
  switch (shape) {
    case 'triangle': return [[c, 6], [SIZE - 6, SIZE - 10], [6, SIZE - 10]];
    case 'invtriangle': return [[6, 10], [SIZE - 6, 10], [c, SIZE - 6]];
    case 'square': return [[9, 9], [SIZE - 9, 9], [SIZE - 9, SIZE - 9], [9, SIZE - 9]];
    case 'diamond': return [[c, 4], [SIZE - 4, c], [c, SIZE - 4], [4, c]];
    case 'hexagon': return polygon(6, 0);
    case 'pentagon': return polygon(5);
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 25 : 14;
        pts.push([c + r * Math.cos(a), c + r * Math.sin(a) + 1]);
      }
      return pts;
    }
    default: return null; // circle
  }
}

export function drawIcon({ color, shape, glyph }) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const pts = shapePath(shape);
  const trace = () => {
    ctx.beginPath();
    if (pts) {
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    } else {
      ctx.arc(SIZE / 2, SIZE / 2, 22, 0, Math.PI * 2);
    }
  };
  ctx.lineJoin = 'round';
  trace();
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  trace();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#111111';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px "Hiragino Sans","Noto Sans JP",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const dy = shape === 'triangle' ? 7 : shape === 'invtriangle' ? -4 : 1;
  ctx.fillText(glyph, SIZE / 2, SIZE / 2 + dy);
  return canvas;
}

export function iconImageData(layer) {
  const canvas = drawIcon(layer);
  return canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE);
}

export function iconDataUrl(layer) {
  return drawIcon(layer).toDataURL('image/png');
}
