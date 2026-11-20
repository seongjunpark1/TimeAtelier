// 시간표 PNG 내보내기(F12). 라이브러리 없이 Canvas API로 직접 그린다.
// - 블록 위치는 화면 격자와 같은 grid.js의 layoutGrid 결과를 그대로 받아 픽셀로만 바꾼다
// - 크기·글자 크기는 css/style.css의 데스크톱 격자(.grid, .block)와 같은 값을 쓴다
// - imageLayout·wrapText·imageFileName은 DOM이 필요 없는 순수 함수라 node:test로 검증한다

/** css/style.css 데스크톱 격자와 같은 치수 (px) */
export const IMAGE_METRICS = {
  width: 760, // 이미지 가로 (CSS 픽셀). 휴대폰에서 내보내도 읽기 좋은 크기로 고정한다
  head: 34, // 요일 머리 줄 높이 (.grid grid-template-rows 첫 줄)
  hourCol: 38, // 왼쪽 시간 눈금 폭
  row: 50, // 한 시간 높이 (--row)
  inset: 3, // 블록 좌우 여백 (.block left/right)
  radius: 14, // 격자 모서리
  blockRadius: 8,
  edge: 4, // 블록 왼쪽 띠 두께
  padX: 9, // 블록 왼쪽 안쪽 여백 (띠 포함)
  padY: 5,
  nameSize: 11.25, // 0.75rem (기본 15px)
  subSize: 10.5, // 0.7rem
  hourSize: 10.5,
  daySize: 12.75, // 0.85rem
  lineHeight: 1.3,
};

/** "시간표공방_1위_16학점.png" */
export function imageFileName(rank, credit) {
  return `시간표공방_${rank}위_${credit}학점.png`;
}

/**
 * layoutGrid 결과를 이미지 픽셀 좌표로 바꾼다.
 * 블록의 top·height 비율은 그대로 두고 격자 높이(시간 수 × row)에 곱하기만 하므로, 화면 격자와 같은 칸에 놓인다.
 * 픽셀 값은 x·y·w·h에 따로 담는다 (비율 top·height를 덮어쓰지 않아야 화면 격자와 비교할 수 있다)
 */
export function imageLayout(grid, metrics = IMAGE_METRICS) {
  const m = { ...IMAGE_METRICS, ...metrics };
  const bodyHeight = grid.hours * m.row;
  const colWidth = (m.width - m.hourCol) / grid.days.length;
  const columns = grid.days.map((day, i) => ({ day, x: m.hourCol + i * colWidth, width: colWidth }));
  const hourLines = Array.from({ length: grid.hours }, (_, i) => ({
    label: String(grid.dayStart / 60 + i),
    y: m.head + i * m.row,
  }));
  const blocks = grid.blocks.map((b) => ({
    ...b,
    x: m.hourCol + b.col * colWidth + m.inset,
    y: m.head + b.top * bodyHeight,
    w: colWidth - m.inset * 2,
    h: b.height * bodyHeight,
  }));
  return { metrics: m, width: m.width, height: m.head + bodyHeight, columns, hourLines, blocks };
}

/**
 * 글자를 maxWidth 안에 들어가게 줄로 나눈다. 띄어쓰기에서 먼저 끊고, 한 낱말이 너무 길면 글자 단위로 끊는다.
 * measure(text) → 폭(px). 캔버스에서는 ctx.measureText를 넘기고, 테스트에서는 가짜 함수를 넘긴다.
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/(\s+)/)) {
    if (!word) continue;
    const next = line + word;
    if (measure(next) <= maxWidth) {
      line = next;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = "";
    if (/^\s+$/.test(word)) continue;
    // 낱말 하나가 한 줄보다 길면 글자 단위로 끊는다 (좁은 칸의 긴 과목명)
    for (const ch of word) {
      if (line && measure(line + ch) > maxWidth) {
        lines.push(line);
        line = "";
      }
      line += ch;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** 지금 화면의 색·글꼴을 CSS 변수에서 읽는다 (다크 모드면 다크 색으로 그려진다) */
export function readTheme(root = document.documentElement) {
  const css = getComputedStyle(root);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    font: css.fontFamily,
    card: v("--card"),
    sunken: v("--sunken"),
    line: v("--line"),
    text2: v("--text-2"),
    muted: v("--muted"),
    blockText: v("--block-text"),
    fill: Array.from({ length: 8 }, (_, i) => v(`--c${i}`)),
    edge: Array.from({ length: 8 }, (_, i) => v(`--c${i}e`)),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** imageLayout 결과를 캔버스에 그린다. ctx는 이미 devicePixelRatio 배율이 걸려 있다고 본다 */
export function drawTimetable(ctx, img, theme) {
  const m = img.metrics;
  const font = (weight, size) => `${weight} ${size}px ${theme.font}`;

  // 바탕 + 바깥 테두리 (모서리를 둥글게 자른다)
  ctx.save();
  roundRect(ctx, 0.5, 0.5, img.width - 1, img.height - 1, m.radius);
  ctx.clip();
  ctx.fillStyle = theme.card;
  ctx.fillRect(0, 0, img.width, img.height);
  // 요일 머리 줄과 시간 눈금 열은 한 단계 들어간 색
  ctx.fillStyle = theme.sunken;
  ctx.fillRect(0, 0, img.width, m.head);
  ctx.fillRect(0, 0, m.hourCol, img.height);

  // 선: 머리 줄 아래, 요일 사이, 한 시간마다
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, m.head + 0.5);
  ctx.lineTo(img.width, m.head + 0.5);
  for (const col of img.columns) {
    ctx.moveTo(Math.round(col.x) + 0.5, 0);
    ctx.lineTo(Math.round(col.x) + 0.5, img.height);
  }
  for (const h of img.hourLines.slice(1)) {
    ctx.moveTo(0, Math.round(h.y) + 0.5);
    ctx.lineTo(img.width, Math.round(h.y) + 0.5);
  }
  ctx.stroke();

  // 요일 이름
  ctx.fillStyle = theme.text2;
  ctx.font = font(750, m.daySize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const col of img.columns) ctx.fillText(col.day, col.x + col.width / 2, m.head / 2);

  // 시간 눈금 (각 줄 오른쪽 위)
  ctx.fillStyle = theme.muted;
  ctx.font = font(400, m.hourSize);
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  for (const h of img.hourLines) ctx.fillText(h.label, m.hourCol - 6, h.y + 3);

  // 수업 블록
  ctx.textAlign = "left";
  for (const b of img.blocks) {
    ctx.save();
    roundRect(ctx, b.x, b.y, b.w, b.h, m.blockRadius);
    ctx.clip();
    ctx.fillStyle = theme.fill[b.color];
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = theme.edge[b.color];
    ctx.fillRect(b.x, b.y, m.edge, b.h);

    const textWidth = b.w - m.padX - 7;
    const bottom = b.y + b.h - m.padY;
    let y = b.y + m.padY;
    ctx.fillStyle = theme.blockText;
    ctx.font = font(750, m.nameSize);
    for (const line of wrapText(b.name, textWidth, (t) => ctx.measureText(t).width)) {
      if (y + m.nameSize * m.lineHeight > bottom) break; // 화면처럼 칸을 넘는 글자는 잘라 낸다
      ctx.fillText(line, b.x + m.padX, y);
      y += m.nameSize * m.lineHeight;
    }
    // 강의실 · 시작 시각 (화면의 흐린 둘째 줄)
    y += 2;
    if (y + m.subSize * m.lineHeight <= bottom) {
      ctx.globalAlpha = 0.72;
      ctx.font = font(400, m.subSize);
      const sub = b.room ? `${b.room} · ${b.startLabel}` : b.startLabel;
      ctx.fillText(wrapText(sub, textWidth, (t) => ctx.measureText(t).width)[0] ?? "", b.x + m.padX, y);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  ctx.restore();

  // 바깥 테두리
  ctx.strokeStyle = theme.line;
  roundRect(ctx, 0.5, 0.5, img.width - 1, img.height - 1, m.radius);
  ctx.stroke();
}

/**
 * 격자 데이터(layoutGrid 결과)를 PNG로 만들어 내려받게 한다.
 * 레티나 화면에서도 흐리지 않게 devicePixelRatio 배율(최소 2배)로 그린다.
 * @returns {Promise<Object>} 그린 데이터(imageLayout 결과). 화면 격자와 같은지 확인할 때 쓴다
 */
export async function downloadTimetablePNG(grid, fileName) {
  const img = imageLayout(grid);
  const scale = Math.max(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  // 웹 글꼴을 쓰는 경우 다 불러온 뒤에 그려야 한글이 기본 글꼴로 바뀌지 않는다
  await document.fonts?.ready;
  drawTimetable(ctx, img, readTheme());

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("이미지를 만들지 못했습니다.");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // 내려받기가 시작될 시간을 준 뒤 메모리를 돌려준다
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return img;
}
