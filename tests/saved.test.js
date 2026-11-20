// 저장한 시간표(F11): 저장 형식 만들기/읽기, 중복 저장 방지, 최대 개수, 저장소가 깨졌을 때 안전하게 무시
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SAVED,
  savedKey,
  makeSavedEntry,
  isValidSavedEntry,
  readSaved,
  addSaved,
  removeSaved,
  isSaved,
  restoreSchedule,
  loadSaved,
  persistSaved,
} from "../js/saved.js";

// 테스트용 강좌. 화면에는 없는 칸(성적처럼 저장하면 안 되는 값)도 일부러 붙여 둔다
const course = (code, section, credit, day, start, end) => ({
  id: `${code}-${section}`,
  code,
  section,
  name: `과목 ${code}`,
  credit,
  professor: "홍길동",
  type: "전공선택",
  grade: "2,3,4", // 수강 학년 칸
  category: "소프트웨어융합전공",
  filler: true,
  score: "A+", // 혹시 강좌 객체에 성적이 섞여 들어와도 저장되면 안 된다
  times: [{ day, start, end, room: "7201" }],
});
const A = course("IS00001", "01", 3, "월", 540, 615);
const B = course("IS00002", "02", 3, "화", 600, 675);
const C = course("IS00003", "01", 2, "수", 780, 870);

// 노드에는 localStorage가 없으므로 가짜 저장소를 붙인다. failWrite면 쓰기가 실패한다(용량 초과·사생활 보호 모드)
let data;
let failWrite;
beforeEach(() => {
  data = new Map();
  failWrite = false;
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (failWrite) throw new Error("QuotaExceededError");
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
});

test("저장 형식: 과목코드-분반 목록, 저장 시각, 과목명·학점·시간 스냅숏", () => {
  const e = makeSavedEntry([A, B], { rank: 3, semester: "2026-2", savedAt: 1000 });
  assert.deepEqual(e.ids, ["IS00001-01", "IS00002-02"]);
  assert.equal(e.savedAt, 1000);
  assert.equal(e.rank, 3);
  assert.equal(e.credit, 6);
  assert.equal(e.semester, "2026-2");
  assert.deepEqual(e.courses[0], {
    id: "IS00001-01",
    code: "IS00001",
    section: "01",
    name: "과목 IS00001",
    credit: 3,
    type: "전공선택",
    category: "소프트웨어융합전공",
    professor: "홍길동",
    times: [{ day: "월", start: 540, end: 615, room: "7201" }],
  });
  assert.ok(isValidSavedEntry(e));
});

test("저장 형식에는 성적·등급 값이 들어가지 않는다 (N2)", () => {
  const json = JSON.stringify(makeSavedEntry([A, B, C], { rank: 1 }));
  assert.ok(!json.includes("A+"));
  assert.ok(!/"(score|grade|등급|성적)"/.test(json), json);
});

test("강의실이 없는 시간도 빈 문자열로 저장해 다시 읽을 수 있다", () => {
  const noRoom = { ...A, times: [{ day: "월", start: 540, end: 615 }] };
  const e = makeSavedEntry([noRoom]);
  assert.equal(e.courses[0].times[0].room, "");
  assert.ok(isValidSavedEntry(e));
});

test("같은 조합은 과목 순서가 달라도 중복 저장하지 않는다", () => {
  const first = addSaved([], makeSavedEntry([A, B]));
  assert.equal(first.status, "added");
  const again = addSaved(first.list, makeSavedEntry([B, A]));
  assert.equal(again.status, "duplicate");
  assert.equal(again.list.length, 1);
  assert.equal(savedKey(["b", "a"]), savedKey(["a", "b"]));
  assert.ok(isSaved(first.list, [B, A]));
  assert.ok(!isSaved(first.list, [A, C]));
});

test("최대 개수를 넘으면 더하지 않고 'full'을 돌려준다, 지우면 다시 저장할 수 있다", () => {
  let list = [];
  for (let i = 0; i < MAX_SAVED; i++) {
    const x = course(`IS9${String(i).padStart(4, "0")}`, "01", 3, "목", 540, 615);
    ({ list } = addSaved(list, makeSavedEntry([x], { savedAt: i })));
  }
  assert.equal(list.length, MAX_SAVED);
  const over = addSaved(list, makeSavedEntry([A]));
  assert.equal(over.status, "full");
  assert.equal(over.list.length, MAX_SAVED);
  // 최근 것이 앞에 온다
  assert.equal(list[0].savedAt, MAX_SAVED - 1);
  const fewer = removeSaved(list, savedKey(list[0].ids));
  assert.equal(fewer.length, MAX_SAVED - 1);
  assert.equal(addSaved(fewer, makeSavedEntry([A])).status, "added");
});

test("새로고침(다시 읽기) 후에도 저장한 시간표가 그대로 남는다", () => {
  const { list } = addSaved([], makeSavedEntry([A, B], { rank: 2, savedAt: 5 }));
  assert.equal(persistSaved(list), true);
  assert.deepEqual(loadSaved(), list);
});

test("저장소 값이 깨졌으면 빈 목록으로 시작한다 (앱이 멈추지 않음)", () => {
  for (const raw of ["{not json", '"oops"', '{"x":1}', "null", "42"]) {
    data.set("timetable-maker:saved", raw);
    assert.deepEqual(loadSaved(), [], raw);
  }
});

test("깨진 항목·중복 항목만 빼고 나머지는 살린다", () => {
  const good = makeSavedEntry([A, B], { savedAt: 1 });
  const other = makeSavedEntry([C], { savedAt: 2 });
  const broken = [
    null,
    "문자열",
    { ...good, ids: "IS00001-01" },
    { ...other, courses: [] }, // ids와 스냅숏 개수가 다름
    { ...other, courses: [{ ...other.courses[0], times: [{ day: "월" }] }] },
    { ...other, savedAt: "어제" },
  ];
  data.set("timetable-maker:saved", JSON.stringify([good, ...broken, { ...good, savedAt: 9 }, other]));
  const list = loadSaved();
  assert.deepEqual(list.map((e) => e.savedAt), [1, 2]);
  // 손으로 고쳐 최대 개수보다 많이 넣어도 최대 개수까지만 읽는다
  assert.equal(readSaved(Array.from({ length: 15 }, (_, i) => makeSavedEntry([course(`AA${10000 + i}`, "01", 1, "금", 600, 660)]))).length, MAX_SAVED);
});

test("저장소에 쓰지 못해도 예외 없이 false를 돌려준다", () => {
  failWrite = true;
  assert.equal(persistSaved([makeSavedEntry([A])]), false);
  delete globalThis.localStorage; // 저장소 자체가 없는 환경
  assert.equal(persistSaved([]), false);
  assert.deepEqual(loadSaved(), []);
});

test("다시 보여 줄 때는 저장할 때의 스냅숏을 쓰고, 이번 학기 데이터에 없는 과목을 알려 준다", () => {
  const e = makeSavedEntry([A, B]);
  // 다음 학기: A는 시간이 바뀌어 남아 있고, B는 없어졌다
  const byId = new Map([[A.id, { ...A, times: [{ day: "금", start: 900, end: 975, room: "" }] }]]);
  const { schedule, missing } = restoreSchedule(e, byId);
  assert.deepEqual(schedule.map((c) => c.id), ["IS00001-01", "IS00002-02"]);
  assert.equal(schedule[0].times[0].day, "월"); // 저장한 그 시간표 그대로
  assert.deepEqual(missing, ["과목 IS00002"]);
});
