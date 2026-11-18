// 실행: npm test  (Node.js 18 이상, 별도 설치 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoFillExcludedCodes } from "../js/grades.js";
import {
  slotsOverlap,
  coursesConflict,
  generateSchedules,
  totalCredit,
  countFreeWeekdays,
  parseGradeLevels,
  fitsGrade,
  buildPool,
  validateMajors,
  explorationCategoryFor,
  findTimeConflicts,
  explorationScope,
  recommendedExploration,
  forbiddenExploration,
  buildFillerPool,
  findUnavoidableConflicts,
  scoreSchedule,
  pushTopK,
} from "../js/scheduler.js";

// 테스트용 강좌를 짧게 만드는 도우미: c("IS00015", "01", 3, ["화", "15:00", "16:15"], ...)
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
function c(code, section, credit, ...times) {
  return {
    id: `${code}-${section}`,
    code,
    section,
    name: code,
    credit,
    times: times.map(([day, s, e]) => ({ day, start: toMin(s), end: toMin(e) })),
  };
}

test("같은 요일에 구간이 겹치면 충돌", () => {
  const a = { day: "월", start: toMin("09:00"), end: toMin("10:15") };
  assert.equal(slotsOverlap(a, { day: "월", start: toMin("10:00"), end: toMin("11:00") }), true);
  assert.equal(slotsOverlap(a, { day: "화", start: toMin("10:00"), end: toMin("11:00") }), false);
});

test("끝나는 시각과 시작 시각이 같으면 겹치지 않음", () => {
  const a = { day: "월", start: toMin("09:00"), end: toMin("10:15") };
  const b = { day: "월", start: toMin("10:15"), end: toMin("11:30") };
  assert.equal(slotsOverlap(a, b), false);
});

test("주 2회 수업 중 하나만 겹쳐도 강좌 충돌", () => {
  const x = c("A", "01", 3, ["화", "15:00", "16:15"], ["목", "15:00", "16:15"]);
  const y = c("B", "01", 3, ["목", "16:00", "17:00"]);
  assert.equal(coursesConflict(x, y), true);
});

const sample = [
  c("A", "01", 3, ["월", "09:00", "11:50"]),
  c("A", "02", 3, ["화", "09:00", "11:50"]),
  c("B", "01", 3, ["월", "10:30", "11:45"], ["수", "10:30", "11:45"]),
  c("C", "01", 3, ["금", "13:00", "15:50"]),
  c("D", "01", 2, ["목", "13:00", "14:50"]),
];

test("결과 조합에는 시간 겹침과 같은 과목 중복이 없다", () => {
  const { schedules } = generateSchedules(sample, { minCredit: 1, maxCredit: 21 });
  assert.ok(schedules.length > 0);
  for (const s of schedules) {
    const codes = s.map((x) => x.code);
    assert.equal(new Set(codes).size, codes.length, "같은 과목 분반이 2개 들어감");
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) assert.equal(coursesConflict(s[i], s[j]), false);
  }
});

test("학점 범위를 벗어나는 조합은 없다", () => {
  const { schedules } = generateSchedules(sample, { minCredit: 8, maxCredit: 9 });
  assert.ok(schedules.length > 0);
  for (const s of schedules) assert.ok(totalCredit(s) >= 8 && totalCredit(s) <= 9);
});

test("공강 요일로 지정한 금요일에는 수업이 없다", () => {
  const { schedules } = generateSchedules(sample, { minCredit: 1, maxCredit: 21, offDays: ["금"] });
  assert.ok(schedules.length > 0);
  for (const s of schedules) assert.ok(s.every((x) => x.times.every((t) => t.day !== "금")));
});

test("필수 과목은 모든 조합에 들어간다", () => {
  const { schedules } = generateSchedules(sample, { minCredit: 1, maxCredit: 21, required: ["B"] });
  assert.ok(schedules.length > 0);
  for (const s of schedules) assert.ok(s.some((x) => x.code === "B"));
  // B(월 10:30)와 겹치는 A-01은 나올 수 없다
  for (const s of schedules) assert.ok(!s.some((x) => x.id === "A-01"));
});

test("이수 과목(excluded)은 결과에 나오지 않는다", () => {
  const { schedules } = generateSchedules(sample, { minCredit: 1, maxCredit: 21, excluded: ["C"] });
  for (const s of schedules) assert.ok(!s.some((x) => x.code === "C"));
});

test("필수 과목이 조건에 막히면 오류 메시지를 준다", () => {
  const r = generateSchedules(sample, { required: ["C"], offDays: ["금"] });
  assert.match(r.error, /C/);
});

test("maxResults를 넘으면 잘라내고 truncated를 표시한다", () => {
  const many = Array.from({ length: 12 }, (_, i) => c(`X${i}`, "01", 1, [["월", "화", "수", "목", "금"][i % 5], `${String(9 + i).padStart(2, "0")}:00`, `${String(9 + i).padStart(2, "0")}:50`]));
  const r = generateSchedules(many, { minCredit: 1, maxCredit: 12, maxResults: 50 });
  assert.equal(r.schedules.length, 50);
  assert.equal(r.truncated, true);
});

test("공강 일수 계산", () => {
  assert.equal(countFreeWeekdays([sample[0], sample[3]]), 3); // 월, 금 수업 -> 화수목 공강
});

test("학년 칸 해석: 쉼표·마침표·전체", () => {
  assert.deepEqual(parseGradeLevels("2,3,4"), [2, 3, 4]);
  assert.deepEqual(parseGradeLevels("2.3.4"), [2, 3, 4]);
  assert.equal(parseGradeLevels("전체"), null);
  assert.equal(fitsGrade({ grade: "3,4" }, 2), false);
  assert.equal(fitsGrade({ grade: "전체" }, 1), true);
  assert.equal(fitsGrade({ grade: "3,4" }, 0), true); // 학년 상관없음
});

test("후보 풀: 전공 과목 중 이수·학년 안 맞는 것은 빼고, 담은 과목은 고른 분반만", () => {
  const major = [
    { ...c("M1", "01", 3, ["월", "09:00", "11:50"]), category: "SW", grade: "2,3,4" },
    { ...c("M1", "02", 3, ["화", "09:00", "11:50"]), category: "SW", grade: "2,3,4" },
    { ...c("M2", "01", 3, ["수", "09:00", "11:50"]), category: "SW", grade: "3,4" },
    { ...c("M3", "01", 3, ["목", "09:00", "11:50"]), category: "SW", grade: "전체" },
    { ...c("G1", "01", 2, ["금", "09:00", "10:50"]), category: "교양", grade: "전체" },
  ];
  const picked = [major[0], major[4]]; // M1-01과 교양 G1을 담음
  const pool = buildPool(major, { categories: ["SW"], myGrade: 2, taken: ["M3"], picked });
  const ids = pool.map((x) => x.id).sort();
  // M1-02(담은 과목의 다른 분반), M2(3학년 이상), M3(이수)는 빠진다
  assert.deepEqual(ids, ["G1-01", "M1-01"]);
});

test("담은 과목(required)은 모든 결과에 들어간다", () => {
  const { schedules } = generateSchedules(sample, { minCredit: 6, maxCredit: 9, required: ["D"], topK: 20 });
  assert.ok(schedules.length > 0);
  for (const s of schedules) assert.ok(s.some((x) => x.code === "D"));
});

test("담은 과목이 0개여도 결과는 상위 20개 이하", () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    c(`Y${i}`, "01", 1, [["월", "화", "수", "목", "금"][i % 5], `${String(9 + i).padStart(2, "0")}:00`, `${String(9 + i).padStart(2, "0")}:50`])
  );
  const r = generateSchedules(many, { minCredit: 3, maxCredit: 6, topK: 20 });
  assert.ok(r.total > 20);
  assert.equal(r.schedules.length, 20);
});

test("상위 20개는 점수 내림차순이고, 버려진 조합보다 점수가 낮지 않다", () => {
  const all = generateSchedules(sample, { minCredit: 1, maxCredit: 21, maxResults: 1e6 }).schedules;
  const top = generateSchedules(sample, { minCredit: 1, maxCredit: 21, topK: 3, rankMode: "free" }).schedules;
  const scores = top.map((s) => scoreSchedule(s, "free"));
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i]);
  const best = Math.max(...all.map((s) => scoreSchedule(s, "free")));
  assert.equal(scores[0], best);
});

test("pushTopK는 k개만 유지하며 큰 점수가 앞에 온다", () => {
  const top = [];
  for (const score of [5, 1, 9, 3, 7]) pushTopK(top, { score }, 3);
  assert.deepEqual(top.map((t) => t.score), [9, 7, 5]);
});

test("공강 순위: 공강이 많은 조합이 더 높은 점수", () => {
  const twoDays = [sample[0], sample[3]]; // 월, 금 -> 공강 3일
  const threeDays = [sample[0], sample[2]]; // 월, 수 -> 공강 3일
  const oneDay = [sample[0]]; // 월 -> 공강 4일
  assert.ok(scoreSchedule(oneDay, "free") > scoreSchedule(twoDays, "free"));
  assert.ok(scoreSchedule(threeDays, "free") <= scoreSchedule(oneDay, "free"));
});

test("담은 과목 학점만으로 최대 학점을 넘으면 오류", () => {
  const r = generateSchedules(sample, { maxCredit: 5, required: ["A", "C"] });
  assert.match(r.error, /최대 학점/);
});

test("성능(N1): 소프트웨어융합전공 전체를 풀로 15~18학점 탐색 + 상위 20개 선택이 1초 안에 끝난다", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["소프트웨어융합전공"], myGrade: 3 });
  const t0 = performance.now();
  const r = generateSchedules(pool, { minCredit: 15, maxCredit: 18, topK: 20 });
  const ms = performance.now() - t0;
  assert.ok(r.schedules.length === 20);
  assert.ok(ms < 1000, `${Math.round(ms)}ms (조합 ${r.total}개)`);
});

test("가지치기를 해도 상위 20개는 전부 비교했을 때와 같다 (4가지 순위 기준)", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["디지털콘텐츠전공"] });
  for (const mode of ["free", "morning", "required", "major"]) {
    const fast = generateSchedules(pool, { minCredit: 15, maxCredit: 18, topK: 20, rankMode: mode })
      .schedules.map((s) => scoreSchedule(s, mode));
    const slow = generateSchedules(pool, { minCredit: 15, maxCredit: 18, maxResults: 1e7 })
      .schedules.map((s) => scoreSchedule(s, mode))
      .sort((a, b) => b - a)
      .slice(0, 20);
    assert.deepEqual(fast, slow, mode);
  }
});

// ---------- 전공 규칙 (validateMajors) ----------
// 실제 data/major_rules.json은 학교 사정에 따라 바뀔 수 있으므로, 규칙 검사 테스트는 같은 내용의 고정 값으로 한다.
// (파일이 바뀌어도 '함수가 규칙대로 동작하는지' 테스트는 깨지지 않게)
const RULES = { singleMajorAllowed: ["소프트웨어융합전공"], secondMajorFromGrade: 2 };

test("전공 규칙 파일은 singleMajorAllowed(배열)와 secondMajorFromGrade(숫자)를 가진다", () => {
  const rules = JSON.parse(readFileSync(new URL("../data/major_rules.json", import.meta.url), "utf-8"));
  assert.ok(Array.isArray(rules.singleMajorAllowed));
  assert.equal(typeof rules.secondMajorFromGrade, "number");
});

test("전공 규칙: 소프트웨어융합전공은 2학년 이상이어도 단독(심화전공) OK", () => {
  const r = validateMajors({ mainMajor: "소프트웨어융합전공", myGrade: 3 }, RULES);
  assert.deepEqual(r, { ok: true, message: "" });
});

test("전공 규칙: 다른 전공은 2학년부터 단독이면 오류", () => {
  const r = validateMajors({ mainMajor: "신문방송학전공", myGrade: 2 }, RULES);
  assert.equal(r.ok, false);
  assert.match(r.message, /2학년부터는 복수전공 또는 부전공을 선택해야 합니다/);
});

test("전공 규칙: 1학년은 다른 전공이어도 단독 OK", () => {
  assert.equal(validateMajors({ mainMajor: "신문방송학전공", myGrade: 1 }, RULES).ok, true);
});

test("전공 규칙: 주전공과 같은 전공을 복수전공으로 고르면 오류", () => {
  const r = validateMajors(
    { mainMajor: "신문방송학전공", secondMajor: "신문방송학전공", secondType: "복수전공", myGrade: 2 },
    RULES
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /같은 전공/);
});

test("전공 규칙: 복수전공 대신 부전공을 골라도 OK", () => {
  const r = validateMajors(
    { mainMajor: "신문방송학전공", secondMajor: "소프트웨어융합전공", secondType: "부전공", myGrade: 3 },
    RULES
  );
  assert.equal(r.ok, true);
});

test("전공 규칙: 전공을 아예 안 고르거나 학년이 '상관없음'이면 막지 않는다", () => {
  assert.equal(validateMajors({ mainMajor: "", myGrade: 3 }, RULES).ok, true); // 담은 과목으로만 짜기
  assert.equal(validateMajors({ mainMajor: "신문방송학전공", myGrade: 0 }, RULES).ok, true);
});

test("후보 풀: 주전공과 복수전공·부전공 과목을 모두 포함한다", () => {
  const courses = [
    { ...c("S1", "01", 3, ["월", "09:00", "10:15"]), category: "SW", grade: "전체" },
    { ...c("N1", "01", 3, ["화", "09:00", "10:15"]), category: "신방", grade: "전체" },
    { ...c("E1", "01", 3, ["수", "09:00", "10:15"]), category: "영어", grade: "전체" },
  ];
  const ids = buildPool(courses, { categories: ["SW", "신방"] }).map((x) => x.id).sort();
  assert.deepEqual(ids, ["N1-01", "S1-01"]); // 고르지 않은 영어 과목은 빠진다
  // '선택 안 함'('')이 섞여 있어도 주전공 과목만 들어간다
  assert.deepEqual(buildPool(courses, { categories: ["SW", ""] }).map((x) => x.id), ["S1-01"]);
  // 전공을 하나도 안 고르면 담은 과목만
  assert.deepEqual(buildPool(courses, { categories: [], picked: [courses[2]] }).map((x) => x.id), ["E1-01"]);
});

test("성능(N2): 개설 과목이 많은 두 전공(소프트웨어융합+신문방송학)을 합친 풀에서 15~18학점 상위 20개가 1초 안에 끝난다", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["소프트웨어융합전공", "신문방송학전공"], myGrade: 3 });
  // 순위 기준마다 가지치기 효과가 달라서 네 가지를 모두 잰다
  for (const mode of ["free", "morning", "required", "major"]) {
    const t0 = performance.now();
    const r = generateSchedules(pool, { minCredit: 15, maxCredit: 18, topK: 20, rankMode: mode });
    const ms = performance.now() - t0;
    assert.equal(r.schedules.length, 20);
    assert.ok(ms < 1000, `${mode}: ${Math.round(ms)}ms (분반 ${pool.length}개, 조합 ${r.total}개)`);
  }
});

// ---------- 전공별 학점 (categoryCredits) ----------
const creditOf = (s, cat) => s.filter((x) => x.category === cat).reduce((sum, x) => sum + x.credit, 0);
const twoMajors = [
  { ...c("S1", "01", 3, ["월", "09:00", "10:15"]), category: "SW" },
  { ...c("S2", "01", 3, ["화", "09:00", "10:15"]), category: "SW" },
  { ...c("S3", "01", 3, ["수", "09:00", "10:15"]), category: "SW" },
  { ...c("N1", "01", 3, ["월", "13:00", "14:15"]), category: "신방" },
  { ...c("N2", "01", 3, ["목", "13:00", "14:15"]), category: "신방" },
  { ...c("G1", "01", 2, ["금", "13:00", "14:50"]), category: "교양" },
];

test("전공별 학점: 모든 결과가 전공마다 정한 최소~최대 학점을 지킨다", () => {
  const categoryCredits = { SW: { min: 3, max: 6 }, 신방: { min: 6 } };
  const { schedules } = generateSchedules(twoMajors, { minCredit: 9, maxCredit: 15, categoryCredits, maxResults: 1e6 });
  assert.ok(schedules.length > 0);
  for (const s of schedules) {
    assert.ok(creditOf(s, "SW") >= 3 && creditOf(s, "SW") <= 6);
    assert.ok(creditOf(s, "신방") >= 6);
  }
  // 제한이 없을 때 나오던 'SW 9학점' 조합은 사라져야 한다
  assert.ok(!schedules.some((s) => creditOf(s, "SW") === 9));
});

test("전공별 학점: 담은 과목도 그 전공 학점에 포함해서 센다", () => {
  const r = generateSchedules(twoMajors, {
    minCredit: 3, maxCredit: 15, required: ["S1", "S2"], categoryCredits: { SW: { max: 3 } },
  });
  assert.match(r.error, /SW.*최대 학점/);
});

test("전공별 학점: 최소가 최대보다 크거나, 최소 합이 전체 최대 학점을 넘으면 오류", () => {
  assert.match(generateSchedules(twoMajors, { categoryCredits: { SW: { min: 9, max: 6 } } }).error, /SW/);
  assert.match(
    generateSchedules(twoMajors, { maxCredit: 9, categoryCredits: { SW: { min: 6 }, 신방: { min: 6 } } }).error,
    /합/
  );
});

test("전공별 학점: 가지치기를 해도 상위 20개는 '전부 구한 뒤 조건으로 거른 것'과 같다", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["사회학전공", "영어학전공"] });
  const categoryCredits = { 사회학전공: { min: 6, max: 9 }, 영어학전공: { min: 6 } };
  const ok = (s) => creditOf(s, "사회학전공") >= 6 && creditOf(s, "사회학전공") <= 9 && creditOf(s, "영어학전공") >= 6;
  for (const mode of ["free", "morning", "required"]) {
    const fast = generateSchedules(pool, { minCredit: 15, maxCredit: 18, topK: 20, rankMode: mode, categoryCredits })
      .schedules.map((s) => scoreSchedule(s, mode));
    const slow = generateSchedules(pool, { minCredit: 15, maxCredit: 18, maxResults: 1e7 })
      .schedules.filter(ok)
      .map((s) => scoreSchedule(s, mode))
      .sort((a, b) => b - a)
      .slice(0, 20);
    assert.ok(fast.length > 0);
    assert.deepEqual(fast, slow, mode);
  }
});

test("성능(N3): 두 전공 + 전공별 학점(주전공 9~12, 복수전공 6 이상)도 1초 안에 상위 20개", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["신문방송학전공", "소프트웨어융합전공"], myGrade: 3 });
  const categoryCredits = { 신문방송학전공: { min: 9, max: 12 }, 소프트웨어융합전공: { min: 6 } };
  for (const mode of ["free", "morning", "required"]) {
    const t0 = performance.now();
    const r = generateSchedules(pool, { minCredit: 15, maxCredit: 18, topK: 20, rankMode: mode, categoryCredits });
    const ms = performance.now() - t0;
    assert.equal(r.schedules.length, 20);
    for (const s of r.schedules) assert.ok(creditOf(s, "소프트웨어융합전공") >= 6);
    assert.ok(ms < 1000, `${mode}: ${Math.round(ms)}ms (조합 ${r.total}개)`);
  }
});

// ---------- 1학년 (자유전공학부): 전공탐색 추천 + 교양필수 고정 ----------
const FRESHMAN_RULES = {
  explorationByDepartment: {
    "전공탐색 – 미디어학부": ["신문방송학전공", "디지털콘텐츠전공"],
    "전공탐색 – IT학부": ["소프트웨어융합전공"],
  },
};

test("1학년: 관심 전공 -> 그 학부의 전공탐색 영역", () => {
  assert.equal(explorationCategoryFor("디지털콘텐츠전공", FRESHMAN_RULES), "전공탐색 – 미디어학부");
  assert.equal(explorationCategoryFor("소프트웨어융합전공", FRESHMAN_RULES), "전공탐색 – IT학부");
  // 전공탐색 영역을 직접 고르면 그대로, 학부 정보가 없거나 안 고르면 ""
  assert.equal(explorationCategoryFor("전공탐색 – IT학부", FRESHMAN_RULES), "전공탐색 – IT학부");
  assert.equal(explorationCategoryFor("소프트웨어공학전공", FRESHMAN_RULES), "");
  assert.equal(explorationCategoryFor("", FRESHMAN_RULES), "");
});

test("고정한 분반끼리 시간이 겹치는 쌍을 찾는다", () => {
  const human = c("AC00007", "01", 2, ["금", "10:00", "11:50"]);
  const digital = c("AK00179", "01", 2, ["금", "10:00", "11:50"]);
  const speech = c("AC00013", "05", 2, ["목", "09:00", "10:50"]);
  assert.deepEqual(findTimeConflicts([speech, human]), []);
  const pairs = findTimeConflicts([speech, human, digital]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].map((x) => x.code), ["AC00007", "AK00179"]);
});

test("규칙 파일의 1학년 교양필수 과목코드와 학부·전공 이름이 실제 개설강좌 데이터에 있다", () => {
  const rules = JSON.parse(readFileSync(new URL("../data/major_rules.json", import.meta.url), "utf-8"));
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const codes = new Set(courses.map((x) => x.code));
  const categories = new Set(courses.map((x) => x.category));
  // 오타가 있으면 화면에서 그 과목·전공이 조용히 사라지므로 테스트로 막는다
  for (const code of [...rules.freshmanLiberalRequired, ...rules.freeMajorLiberalRequired]) assert.ok(codes.has(code), code);
  const types = new Set(courses.map((x) => x.type));
  for (const type of rules.fillerTypes) assert.ok(types.has(type), type);
  for (const [exploration, majors] of Object.entries(rules.explorationByDepartment)) {
    assert.ok(categories.has(exploration), exploration);
    for (const major of majors) assert.ok(categories.has(major), major);
  }
});

test("1학년: 교양필수 고정 분반 + 관심 학부 전공탐색으로 짜면 고정 분반은 모든 결과에 그대로 들어간다", () => {
  const rules = JSON.parse(readFileSync(new URL("../data/major_rules.json", import.meta.url), "utf-8"));
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const byId = new Map(courses.map((x) => [x.id, x]));
  const exploration = explorationCategoryFor("신문방송학전공", rules);
  // 학교가 배정한 분반이라고 가정: 말과글 05분반, 과학기술과에콜로지 02분반, 전공진로세미나 04분반
  const fixed = ["AC00013-05", "AC00016-02", "AK00183-04"].map((id) => byId.get(id));
  const pool = buildPool(courses, { categories: [exploration], myGrade: 1, picked: fixed });
  const r = generateSchedules(pool, {
    minCredit: 14, maxCredit: 18, topK: 20, required: fixed.map((x) => x.code),
  });
  assert.ok(r.schedules.length > 0, r.error);
  for (const s of r.schedules) {
    for (const f of fixed) assert.ok(s.some((x) => x.id === f.id), `${f.name} ${f.section}분반이 빠짐`);
    // 고정 분반 말고는 관심 학부의 전공탐색 과목만 들어간다
    for (const x of s) assert.ok(fixed.includes(x) || x.category === exploration, x.name);
  }
});

// ---------- 1학년 소속: 학부 소속은 자기 학부 전탐만, 자유전공학부는 전 학부 전탐 ----------
const DEPT_RULES = { ...FRESHMAN_RULES, freeMajorDepartment: "자유전공학부" };

test("1학년 소속별로 들을 수 있는 전공탐색 영역", () => {
  assert.deepEqual(explorationScope("자유전공학부", DEPT_RULES), ["전공탐색 – 미디어학부", "전공탐색 – IT학부"]);
  assert.deepEqual(explorationScope("전공탐색 – IT학부", DEPT_RULES), ["전공탐색 – IT학부"]);
  assert.deepEqual(explorationScope("", DEPT_RULES), []); // 소속을 아직 안 고름
  assert.deepEqual(explorationScope("없는학부", DEPT_RULES), []);
});

test("1학년 자동 채우기 영역: 학부 소속은 자기 학부, 자유전공학부는 관심 전공 학부(없으면 전 학부)", () => {
  // 학부 소속이면 관심 전공을 넘겨도 무시하고 자기 학부 전탐만
  assert.deepEqual(
    recommendedExploration({ dept: "전공탐색 – IT학부", interest: "신문방송학전공" }, DEPT_RULES),
    ["전공탐색 – IT학부"]
  );
  assert.deepEqual(
    recommendedExploration({ dept: "자유전공학부", interest: "신문방송학전공" }, DEPT_RULES),
    ["전공탐색 – 미디어학부"]
  );
  assert.equal(recommendedExploration({ dept: "자유전공학부" }, DEPT_RULES).length, 2);
  assert.deepEqual(recommendedExploration({ dept: "자유전공학부", interest: "소프트웨어공학전공" }, DEPT_RULES), []);
});

test("학부 소속 1학년이 담은 다른 학부 전탐만 골라낸다 (교양 등은 상관없음)", () => {
  const it = { ...c("BI1", "01", 3, ["월", "09:00", "11:50"]), category: "전공탐색 – IT학부" };
  const media = { ...c("BD1", "01", 3, ["화", "09:00", "11:50"]), category: "전공탐색 – 미디어학부" };
  const liberal = { ...c("AC1", "01", 2, ["수", "09:00", "10:50"]), category: "기초핵심교육 – 말과 글" };
  assert.deepEqual(forbiddenExploration([it, media, liberal], "전공탐색 – IT학부", DEPT_RULES).map((x) => x.code), ["BD1"]);
  assert.deepEqual(forbiddenExploration([it, media, liberal], "자유전공학부", DEPT_RULES), []);
});

test("성능(N4): 자유전공학부(전 학부 전탐) + 교양필수 3과목 고정으로 14~18학점 상위 20개가 1초 안에 끝난다", () => {
  const rules = JSON.parse(readFileSync(new URL("../data/major_rules.json", import.meta.url), "utf-8"));
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  assert.equal(typeof rules.freeMajorDepartment, "string");
  const byId = new Map(courses.map((x) => [x.id, x]));
  const fixed = ["AC00013-05", "AC00016-02", "AK00183-04"].map((id) => byId.get(id));
  const categories = recommendedExploration({ dept: rules.freeMajorDepartment }, rules);
  const pool = buildPool(courses, { categories, myGrade: 1, picked: fixed });
  for (const mode of ["free", "morning", "required"]) {
    const t0 = performance.now();
    const r = generateSchedules(pool, { minCredit: 14, maxCredit: 18, topK: 20, rankMode: mode, required: fixed.map((x) => x.code) });
    const ms = performance.now() - t0;
    assert.equal(r.schedules.length, 20);
    assert.ok(ms < 1000, `${mode}: ${Math.round(ms)}ms (분반 ${pool.length}개, 조합 ${r.total}개)`);
  }
});

// ---------- 전공 학점이 모자랄 때 교양으로 채우기 (rankMode "fill") ----------

test("교양 후보: 정한 구분(교양선택)만, 이수·이미 풀에 있는 과목은 빼고, filler 표시를 붙인 복사본", () => {
  const courses = [
    { ...c("G1", "01", 3, ["월", "09:00", "11:50"]), type: "교양선택", grade: "전체" },
    { ...c("G2", "01", 3, ["화", "09:00", "11:50"]), type: "교양선택", grade: "전체" },
    { ...c("G3", "01", 3, ["수", "09:00", "11:50"]), type: "교양선택", grade: "전체" },
    { ...c("R1", "01", 2, ["목", "09:00", "10:50"]), type: "교양필수", grade: "1" },
  ];
  const filler = buildFillerPool(courses, { types: ["교양선택"], taken: ["G2"], excludeCodes: ["G3"] });
  assert.deepEqual(filler.map((x) => x.code), ["G1"]);
  assert.equal(filler[0].filler, true);
  assert.equal(courses[0].filler, undefined); // 원본은 그대로
});

test("교양 채우기 점수: 공강 > 전공 학점 많음 > 교양 학점 적음 순으로 앞선다", () => {
  const major = (code, day) => ({ ...c(code, "01", 3, [day, "09:00", "11:50"]) });
  const lib = (code, day) => ({ ...c(code, "01", 3, [day, "13:00", "15:50"]), filler: true });
  // 공강이 하루 더 많으면 전공 학점이 적어도 앞선다
  assert.ok(scoreSchedule([major("M1", "월"), lib("G1", "월")], "fill") > scoreSchedule([major("M1", "월"), major("M2", "화")], "fill"));
  // 공강이 같으면 전공 학점이 많은 쪽
  assert.ok(scoreSchedule([major("M1", "월"), major("M2", "월")], "fill") > scoreSchedule([major("M1", "월"), lib("G1", "월")], "fill"));
  // 공강·전공 학점이 같으면 교양을 덜 넣은 쪽
  assert.ok(scoreSchedule([major("M1", "월")], "fill") > scoreSchedule([major("M1", "월"), lib("G1", "월")], "fill"));
});

test("교양 채우기: 가지치기를 해도 상위 20개는 '전부 구해서 점수순 정렬'과 같다", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["경제학전공"], myGrade: 3 });
  // 전부 구하는 쪽이 너무 오래 걸리지 않게 교양 후보를 SEED 영역(24분반)으로 줄인다. 그래도 조합은 20만 개가 넘는다
  const filler = buildFillerPool(courses, { types: ["교양선택"], excludeCodes: pool.map((x) => x.code) })
    .filter((x) => /SEED/.test(x.category));
  const all = [...pool, ...filler];
  const opts = { minCredit: 15, maxCredit: 18 };
  const full = generateSchedules(all, { ...opts, maxResults: 1e7 });
  assert.equal(full.truncated, false);
  assert.ok(full.total > 100000, `비교할 조합이 너무 적음: ${full.total}`);
  // 공강 우선(fill)과 전공 많이 넣는 순(major) 둘 다 확인한다
  for (const mode of ["fill", "major"]) {
    const fast = generateSchedules(all, { ...opts, topK: 20, rankMode: mode }).schedules.map((s) => scoreSchedule(s, mode));
    const slow = full.schedules.map((s) => scoreSchedule(s, mode)).sort((a, b) => b - a).slice(0, 20);
    assert.ok(fast.length > 0);
    assert.deepEqual(fast, slow, mode);
  }
});

test("성능(N5): 교양 70분반을 더해 채워도 1초 안에 상위 20개 (교필 없는 1학년 소프트웨어융합학부 = 가장 느린 경우)", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const rules = JSON.parse(readFileSync(new URL("../data/major_rules.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["전공탐색 – 소프트웨어융합학부(IT융합자율학부)"], myGrade: 1 });
  // 전탐만으로는 9학점이라 15학점을 못 채운다 -> 교양으로 채우는 상황
  assert.equal(generateSchedules(pool, { minCredit: 15, maxCredit: 18, topK: 20 }).schedules.length, 0);
  const filler = buildFillerPool(courses, { types: rules.fillerTypes, myGrade: 1, excludeCodes: pool.map((x) => x.code) });
  for (const mode of ["fill", "major"]) {
    const t0 = performance.now();
    const r = generateSchedules([...pool, ...filler], { minCredit: 15, maxCredit: 18, topK: 20, rankMode: mode });
    const ms = performance.now() - t0;
    assert.equal(r.schedules.length, 20);
    assert.ok(r.schedules.every((s) => s.some((x) => x.filler)), "교양이 하나도 안 들어간 조합이 있음");
    assert.ok(ms < 1000, `${mode}: ${Math.round(ms)}ms (분반 ${pool.length + filler.length}개, 조합 ${r.total}개)`);
  }
});

test("전공 많이 넣는 순: 전공 학점이 많으면 공강이 적어도 앞서고, 실제 데이터에서도 1위의 전탐 학점이 공강 우선보다 많다", () => {
  const major = (code, day) => ({ ...c(code, "01", 3, [day, "09:00", "11:50"]) });
  const lib = (code, day) => ({ ...c(code, "01", 3, [day, "13:00", "15:50"]), filler: true });
  const moreMajor = [major("M1", "월"), major("M2", "화")]; // 전공 6, 공강 3
  const moreFree = [major("M1", "월"), lib("G1", "월")]; // 전공 3, 공강 4
  assert.ok(scoreSchedule(moreMajor, "major") > scoreSchedule(moreFree, "major"));
  assert.ok(scoreSchedule(moreFree, "fill") > scoreSchedule(moreMajor, "fill")); // 공강 우선이면 반대

  // 1학년 소프트웨어융합학부 + 교필 3과목: 공강 우선 1위는 전탐 3학점, 전공 많이 넣는 순 1위는 전탐 9학점
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const byId = new Map(courses.map((x) => [x.id, x]));
  const fixed = ["AC00013-05", "AC00016-02", "AK00183-04"].map((id) => byId.get(id));
  const cat = "전공탐색 – 소프트웨어융합학부(IT융합자율학부)";
  const pool = buildPool(courses, { categories: [cat], myGrade: 1, picked: fixed });
  const filler = buildFillerPool(courses, { types: ["교양선택"], myGrade: 1, excludeCodes: pool.map((x) => x.code) });
  const best = (mode) =>
    generateSchedules([...pool, ...filler], { minCredit: 15, maxCredit: 18, topK: 1, rankMode: mode, required: fixed.map((x) => x.code) }).schedules[0];
  assert.equal(creditOf(best("fill"), cat), 3);
  assert.equal(creditOf(best("major"), cat), 9);
});

// ---------- 점검에서 찾은 문제 회귀 테스트 ----------

test("시간 미정 과목은 자동 채우기 후보에서 빠지고, 직접 담으면 들어간다", () => {
  const timed = { ...c("T1", "01", 3, ["월", "09:00", "11:50"]), category: "SW", type: "전공선택", grade: "전체" };
  const untimed = { ...c("U1", "01", 3), category: "SW", type: "전공선택", grade: "전체" }; // times: []
  const lib = { ...c("U2", "01", 3), category: "교양", type: "교양선택", grade: "전체" };
  assert.deepEqual(buildPool([timed, untimed], { categories: ["SW"] }).map((x) => x.code), ["T1"]);
  assert.deepEqual(buildPool([timed, untimed], { categories: ["SW"], picked: [untimed] }).map((x) => x.code).sort(), ["T1", "U1"]);
  assert.deepEqual(buildFillerPool([lib], { types: ["교양선택"] }), []);
});

test("시간 미정 인턴십이 '공강 많은 순' 1위를 차지하지 않는다 (인공지능전공 4학년)", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const pool = buildPool(courses, { categories: ["인공지능전공"], myGrade: 4 });
  assert.ok(pool.every((x) => x.times.length > 0));
  const r = generateSchedules(pool, { minCredit: 3, maxCredit: 18, topK: 20 });
  for (const s of r.schedules) assert.ok(s.every((x) => x.times.length > 0));
});

test("꼭 넣을 과목끼리 반드시 겹치면 이유를 담은 오류를 준다 (분반을 여러 개 담았으면 하나라도 안 겹치면 통과)", () => {
  const a = c("A", "01", 3, ["월", "09:00", "11:50"]);
  const b1 = c("B", "01", 3, ["월", "10:00", "11:00"]);
  const b2 = c("B", "02", 3, ["화", "10:00", "11:00"]);
  assert.equal(findUnavoidableConflicts([a, b1]).length, 1);
  assert.equal(findUnavoidableConflicts([a, b1, b2]).length, 0); // B-02를 고르면 된다
  const r = generateSchedules([a, b1], { minCredit: 1, maxCredit: 18, required: ["A", "B"] });
  assert.match(r.error, /A\(01분반\)과\(와\) B\(01분반\)의 시간이 겹칩니다/);
  const ok = generateSchedules([a, b1, b2], { minCredit: 1, maxCredit: 18, required: ["A", "B"] });
  assert.equal(ok.error, undefined);
  assert.ok(ok.schedules.every((s) => s.some((x) => x.id === "B-02")));
});

test("개설강좌 데이터: 교수명 자리에 PDF의 Y/N 표시 칸 같은 영문 한 글자가 들어가 있지 않다", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  // 교수명이 비어 있으면 parse_pdf.py가 옆 칸의 'Y'/'N'을 교수명으로 읽은 적이 있다 (교수 미정은 ""로 둔다)
  const bad = courses.filter((x) => /^[A-Za-z]$/.test(x.professor)).map((x) => `${x.id}=${x.professor}`);
  assert.deepEqual(bad, []);
});

// ---------- 재수강 가능 과목은 자동 채우기에서 뺀다 ----------

test("자동 채우기에서 뺄 과목코드 = 이수 + 재수강 가능 (중복 없이)", () => {
  assert.deepEqual(autoFillExcludedCodes({ taken: ["A", "B"], retake: ["B", "C"] }).sort(), ["A", "B", "C"]);
  assert.deepEqual(autoFillExcludedCodes({}), []);
});

test("재수강 과목: 담지 않으면 결과에 0번, 담으면 모든 결과에 들어간다", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const opts = { minCredit: 15, maxCredit: 18, topK: 20 };
  const categories = ["소프트웨어융합전공"];
  // 재수강 과목으로 쓸 과목: 아무것도 빼지 않았을 때 1위 조합에 들어가는 과목 (원래는 결과에 나오는 과목이어야 의미가 있다)
  const before = generateSchedules(buildPool(courses, { categories, myGrade: 3 }), opts).schedules;
  const retakeSection = before[0][0];
  const code = retakeSection.code;
  assert.ok(before.some((s) => s.some((x) => x.code === code)));

  const excluded = autoFillExcludedCodes({ taken: [], retake: [code] });
  const notPicked = generateSchedules(buildPool(courses, { categories, myGrade: 3, taken: excluded }), opts).schedules;
  assert.ok(notPicked.length > 0);
  assert.equal(notPicked.filter((s) => s.some((x) => x.code === code)).length, 0, "담지 않은 재수강 과목이 자동으로 들어감");

  const picked = generateSchedules(
    buildPool(courses, { categories, myGrade: 3, taken: excluded, picked: [retakeSection] }),
    { ...opts, required: [code] }
  ).schedules;
  assert.ok(picked.length > 0);
  assert.ok(picked.every((s) => s.some((x) => x.id === retakeSection.id)), "담은 재수강 과목이 빠진 결과가 있음");
});

test("재수강 가능 교양도 교양 채우기 후보에서 빠진다", () => {
  const { courses } = JSON.parse(readFileSync(new URL("../data/courses.json", import.meta.url), "utf-8"));
  const lib = courses.find((x) => x.type === "교양선택" && x.times.length);
  const excluded = autoFillExcludedCodes({ taken: [], retake: [lib.code] });
  const filler = buildFillerPool(courses, { types: ["교양선택"], taken: excluded });
  assert.ok(filler.length > 0);
  assert.ok(!filler.some((x) => x.code === lib.code));
});
