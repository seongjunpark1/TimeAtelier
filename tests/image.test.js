// 시간표 격자 배치(grid.js)와 PNG 그리기 데이터(image.js, F12)
// 화면 격자와 PNG가 같은 layoutGrid 결과를 쓰므로, 여기서 배치가 맞으면 이미지도 화면과 같은 칸에 그려진다
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutGrid, COLORS } from "../js/grid.js";
import { imageLayout, imageFileName, wrapText, IMAGE_METRICS, drawTimetable } from "../js/image.js";
import { makeSavedEntry, restoreSchedule } from "../js/saved.js";

const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
function c(code, credit, ...times) {
  const slots = [];
  for (let i = 0; i < times.length; i += 3) slots.push({ day: times[i], start: toMin(times[i + 1]), end: toMin(times[i + 2]), room: "7201" });
  return { id: `${code}-01`, code, section: "01", name: `과목${code}`, credit, type: "전공선택", category: "x", professor: "", times: slots };
}

const A = c("IS00001", 3, "월", "09:00", "10:15", "수", "09:00", "10:15");
const B = c("IS00002", 3, "화", "13:30", "14:45");
const C = c("IS00003", 2, "목", "18:00", "19:50"); // 18시를 넘으면 격자가 늘어난다

test("layoutGrid: 요일·시간 범위·블록 수", () => {
  const g = layoutGrid([A, B, C]);
  assert.deepEqual(g.days, ["월", "화", "수", "목", "금"]);
  assert.equal(g.dayStart, 9 * 60);
  assert.equal(g.dayEnd, 20 * 60);
  assert.equal(g.hours, 11);
  assert.equal(g.blocks.length, 4);
  // 요일 순서대로, 같은 과목은 같은 색
  assert.deepEqual(g.blocks.map((b) => b.day), ["월", "화", "수", "목"]);
  assert.deepEqual(g.blocks.map((b) => b.color), [0, 1, 0, 2]);
  const thu = g.blocks[3];
  assert.equal(thu.name, "과목IS00003");
  assert.equal(thu.room, "7201");
  assert.equal(thu.startLabel, "18:00");
  assert.equal(thu.top, (18 * 60 - 9 * 60) / (11 * 60));
  assert.equal(thu.height, 110 / (11 * 60));
});

test("layoutGrid: 토요일 수업이 있으면 토요일 열이 생기고, 일찍 시작하면 앞으로 넓힌다", () => {
  const g = layoutGrid([c("AA00001", 3, "토", "08:30", "09:45")]);
  assert.equal(g.days.at(-1), "토");
  assert.equal(g.dayStart, 8 * 60);
  assert.equal(g.blocks[0].col, 5);
});

test("layoutGrid: 시간 미정 과목은 블록이 없고, 빈 시간표도 9~18시 격자", () => {
  const g = layoutGrid([{ ...A, times: [] }]);
  assert.equal(g.blocks.length, 0);
  assert.equal(g.hours, 9);
});

test("layoutGrid: 색은 과목 순서대로 COLORS개를 돌려 쓴다", () => {
  const many = Array.from({ length: COLORS + 1 }, (_, i) => c(`BB0000${i}`, 1, "금", "09:00", "09:50"));
  assert.equal(layoutGrid(many).blocks.at(-1).color, 0);
});

test("imageLayout: 화면 격자와 같은 블록 목록을 픽셀 좌표로만 바꾼다", () => {
  const g = layoutGrid([A, B, C]);
  const img = imageLayout(g);
  const m = IMAGE_METRICS;
  assert.equal(img.width, m.width);
  assert.equal(img.height, m.head + 11 * m.row);
  assert.equal(img.blocks.length, g.blocks.length);
  const colWidth = (m.width - m.hourCol) / 5;
  img.blocks.forEach((b, i) => {
    const s = g.blocks[i];
    assert.equal(b.name, s.name);
    assert.equal(b.day, s.day);
    assert.equal(b.x, m.hourCol + s.col * colWidth + m.inset);
    assert.equal(b.y, m.head + s.top * 11 * m.row);
    assert.equal(b.h, s.height * 11 * m.row);
    assert.equal(b.top, s.top); // 비율은 화면 격자와 같은 값 그대로
    assert.equal(b.height, s.height);
  });
  // 9시 수업은 머리 줄 바로 아래, 1시간 15분 수업은 1.25줄
  assert.equal(img.blocks[0].y, m.head);
  assert.equal(img.blocks[0].h, 1.25 * m.row);
  assert.deepEqual(img.columns.map((x) => x.day), g.days);
  assert.deepEqual(img.hourLines.map((h) => h.label), ["9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19"]);
});

test("저장한 시간표를 다시 열어도 같은 그리기 데이터가 나온다", () => {
  const schedule = [A, B, C];
  const { schedule: restored } = restoreSchedule(JSON.parse(JSON.stringify(makeSavedEntry(schedule))));
  assert.deepEqual(layoutGrid(restored), layoutGrid(schedule));
});

test("파일명에 순위와 학점이 들어간다", () => {
  assert.equal(imageFileName(1, 16), "시간표공방_1위_16학점.png");
});

test("wrapText: 칸 폭에 맞게 띄어쓰기에서 먼저, 긴 낱말은 글자 단위로 끊는다", () => {
  const measure = (t) => t.length * 10; // 글자당 10px
  assert.deepEqual(wrapText("백엔드 프로그래밍", 60, measure), ["백엔드", "프로그래밍"]);
  assert.deepEqual(wrapText("과학기술과에콜로지", 40, measure), ["과학기술", "과에콜로", "지"]);
  assert.deepEqual(wrapText("짧음", 100, measure), ["짧음"]);
});

test("drawTimetable: 블록마다 과목명을 그리고, 과목명은 블록 안에 그린다", () => {
  const img = imageLayout(layoutGrid([A, B, C]));
  const texts = [];
  // 캔버스 대신 호출만 기록하는 가짜 ctx
  const ctx = new Proxy(
    { measureText: (t) => ({ width: t.length * 8 }), fillText: (t, x, y) => texts.push({ t, x, y }) },
    { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true }
  );
  const theme = { font: "sans-serif", fill: Array(8).fill("#eee"), edge: Array(8).fill("#333") };
  drawTimetable(ctx, img, theme);
  for (const b of img.blocks) {
    const drawn = texts.find((x) => x.t === b.name);
    assert.ok(drawn, b.name);
  }
  for (const day of ["월", "화", "수", "목", "금"]) assert.ok(texts.some((x) => x.t === day));
  assert.ok(texts.some((x) => x.t === "7201 · 18:00"));
});
