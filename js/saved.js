// 저장한 시간표(F11). 형식 만들기·읽기·중복 검사는 순수 함수로 두고, 실제 저장은 storage.js의 안전 저장 함수만 쓴다.
//
// 저장 형식 (localStorage "timetable-maker:saved" = 아래 항목의 배열, 최근 것이 앞):
// { ids: ["IS00015-01", ...],   과목코드-분반 (화면 색 순서를 지키려고 결과 순서 그대로)
//   savedAt: 1763600000000,      저장 시각 (ms)
//   semester: "2026-2", rank: 1, credit: 16,
//   courses: [{ id, code, section, name, credit, type, category, professor, times: [{ day, start, end, room }] }] }
// courses는 스냅숏이다. 다음 학기에 courses.json이 바뀌어 과목을 못 찾아도 저장할 때 모습 그대로 보여 줄 수 있다.
// 성적·등급 값은 어떤 경우에도 넣지 않는다 (계획서 N2). 스냅숏도 아래 snapshotCourse가 고른 칸만 담는다.
import * as store from "./storage.js";
import { totalCredit } from "./scheduler.js";

export const MAX_SAVED = 10;
const KEY = "saved";

/** 같은 조합인지 비교할 때 쓰는 열쇠. 과목 순서가 달라도 같은 분반 묶음이면 같은 조합이다 */
export function savedKey(ids) {
  return [...ids].sort().join("|");
}

/** 화면에 다시 그리는 데 필요한 값만 골라 담는다 (원본 강좌에 다른 칸이 늘어도 저장되지 않게) */
function snapshotCourse(c) {
  return {
    id: c.id,
    code: c.code,
    section: c.section,
    name: c.name,
    credit: c.credit,
    type: c.type ?? "",
    category: c.category ?? "",
    professor: c.professor ?? "",
    times: c.times.map(({ day, start, end, room }) => ({ day, start, end, room: room ?? "" })),
  };
}

/** 지금 보고 있는 시간표로 저장 항목을 만든다 */
export function makeSavedEntry(schedule, { rank = 0, semester = "", savedAt = Date.now() } = {}) {
  return {
    ids: schedule.map((c) => c.id),
    savedAt,
    semester,
    rank,
    credit: totalCredit(schedule),
    courses: schedule.map(snapshotCourse),
  };
}

const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isTime = (t) => store.isPlainObject(t) && isStr(t.day) && isNum(t.start) && isNum(t.end) && isStr(t.room);
const isCourse = (c) =>
  store.isPlainObject(c) && isStr(c.id) && isStr(c.code) && isStr(c.section) && isStr(c.name) && isNum(c.credit) &&
  isStr(c.type) && isStr(c.category) && isStr(c.professor) && Array.isArray(c.times) && c.times.every(isTime);

/** 저장 항목 하나가 형식에 맞는지. 예전 버전·손상된 값이면 false */
export function isValidSavedEntry(e) {
  return (
    store.isPlainObject(e) && store.isStringArray(e.ids) && e.ids.length > 0 && isNum(e.savedAt) &&
    isStr(e.semester) && isNum(e.rank) && isNum(e.credit) &&
    Array.isArray(e.courses) && e.courses.length === e.ids.length && e.courses.every(isCourse) &&
    e.courses.every((c, i) => c.id === e.ids[i])
  );
}

/**
 * 저장소에서 읽은 값을 목록으로 정리한다. 배열이 아니면 빈 목록, 깨진 항목·중복 항목은 빼고 최대 개수까지만 남긴다.
 * 하나가 깨졌다고 나머지 저장한 시간표까지 잃지 않게 항목마다 따로 검사한다.
 */
export function readSaved(raw, max = MAX_SAVED) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  for (const e of raw) {
    if (!isValidSavedEntry(e)) continue;
    const key = savedKey(e.ids);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(e);
  }
  return list.slice(0, max);
}

/**
 * 목록에 항목을 더한다 (원래 목록은 바꾸지 않는다).
 * @returns {{ list: Object[], status: "added" | "duplicate" | "full" }}
 */
export function addSaved(list, entry, max = MAX_SAVED) {
  const key = savedKey(entry.ids);
  if (list.some((e) => savedKey(e.ids) === key)) return { list, status: "duplicate" };
  if (list.length >= max) return { list, status: "full" };
  return { list: [entry, ...list], status: "added" };
}

/** 열쇠(savedKey)가 같은 항목을 뺀 새 목록 */
export function removeSaved(list, key) {
  return list.filter((e) => savedKey(e.ids) !== key);
}

/** 이 시간표가 이미 저장돼 있는지 */
export function isSaved(list, schedule) {
  const key = savedKey(schedule.map((c) => c.id));
  return list.some((e) => savedKey(e.ids) === key);
}

/**
 * 저장 항목을 다시 그릴 시간표로 바꾼다. 항상 저장할 때의 스냅숏을 쓴다
 * (이번 학기 데이터의 같은 분반이 시간이 바뀌었더라도, 저장한 그 시간표를 그대로 보여 주기 위해서).
 * missing은 지금 강좌 데이터(byId)에 없는 과목 이름 목록 (안내 문구용)
 */
export function restoreSchedule(entry, byId = new Map()) {
  const missing = entry.courses.filter((c) => !byId.has(c.id)).map((c) => c.name);
  return { schedule: entry.courses, missing };
}

/** 저장소에서 읽기 (실패·손상이면 빈 목록) */
export function loadSaved() {
  return readSaved(store.load(KEY, [], Array.isArray));
}

/** 저장소에 쓰기. 저장소가 막혀 있거나 가득 차면 false (앱은 멈추지 않는다) */
export function persistSaved(list) {
  return store.save(KEY, list);
}
