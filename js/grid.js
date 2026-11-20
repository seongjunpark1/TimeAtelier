// 시간표 격자 배치 계산. 화면 격자(app.js)와 PNG 내보내기(image.js)가 같은 데이터를 쓰도록 따로 둔다.
// DOM을 쓰지 않는 순수 함수라 node:test로 검증할 수 있다.
import { DAYS, toHHMM } from "./scheduler.js";

/** 수업 색 개수. 과목 순서대로 c0~c7을 돌려 쓴다 (css/style.css의 .c0~.c7과 같은 수) */
export const COLORS = 8;

/**
 * 시간표(강좌 배열)를 격자에 놓을 블록 목록으로 바꾼다.
 * - 요일: 월~금, 토요일 수업이 있으면 토요일까지
 * - 시간: 9시~18시를 기본으로, 그보다 이르거나 늦은 수업이 있으면 한 시간 단위로 넓힌다
 * - top·height는 격자 전체 높이에 대한 비율(0~1). 화면은 %로, 이미지는 픽셀로 바꿔 쓴다
 * - 블록 순서는 요일 순 → 같은 요일 안에서는 과목 순 (화면에 그려지는 순서와 같다)
 * @returns {{ days: string[], dayStart: number, dayEnd: number, hours: number, blocks: Object[] }}
 */
export function layoutGrid(schedule) {
  const slots = schedule.flatMap((c, i) => c.times.map((t) => ({ ...t, course: c, color: i % COLORS })));
  const days = slots.some((s) => s.day === "토") ? DAYS : DAYS.slice(0, 5);
  const dayStart = Math.min(9 * 60, ...slots.map((s) => Math.floor(s.start / 60) * 60));
  const dayEnd = Math.max(18 * 60, ...slots.map((s) => Math.ceil(s.end / 60) * 60));
  const span = dayEnd - dayStart;

  const blocks = [];
  days.forEach((day, col) => {
    for (const s of slots.filter((x) => x.day === day)) {
      blocks.push({
        courseId: s.course.id,
        name: s.course.name,
        room: s.room ?? "",
        day,
        col,
        start: s.start,
        end: s.end,
        startLabel: toHHMM(s.start),
        endLabel: toHHMM(s.end),
        top: (s.start - dayStart) / span,
        height: (s.end - s.start) / span,
        color: s.color,
      });
    }
  });
  return { days, dayStart, dayEnd, hours: span / 60, blocks };
}
