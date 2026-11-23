import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCourses, validateCourseMap, validateMajorRules, summarizeErrors } from "../js/validate.js";

const readData = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf-8"));

// 올바른 강좌 하나 (테스트마다 한 칸씩 망가뜨려 본다)
const good = () => ({
  id: "IS00015-01",
  code: "IS00015",
  section: "01",
  name: "테스트과목",
  credit: 3,
  professor: "홍길동",
  type: "전공선택",
  grade: "2,3,4",
  category: "소프트웨어융합전공",
  times: [{ day: "화", start: 900, end: 975, room: "6201" }],
});
const wrap = (...courses) => ({ semester: "2026-2", courses });

// ---------- 실제 데이터 ----------

test("실제 데이터 파일 3개(courses·course_map·major_rules)가 모두 검사를 통과한다", () => {
  assert.deepEqual(validateCourses(readData("courses.json")).errors, []);
  assert.deepEqual(validateCourseMap(readData("course_map.json")).errors, []);
  assert.deepEqual(validateMajorRules(readData("major_rules.json")).errors, []);
});

// ---------- courses.json: 잘못된 입력 ----------

test("times가 빠진 강좌는 'IS00015-01: times가 없습니다'처럼 강좌 id와 함께 알려 준다", () => {
  const c = good();
  delete c.times;
  const r = validateCourses(wrap(c));
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["IS00015-01: times가 없습니다"]);
});

test("시간 미정 강좌(times가 빈 배열)는 통과한다", () => {
  assert.deepEqual(validateCourses(wrap({ ...good(), times: [] })).errors, []);
});

test("요일이 틀리거나 시작이 끝보다 늦은 수업 시간을 찾는다", () => {
  const c = { ...good(), times: [{ day: "화요일", start: 900, end: 975 }, { day: "목", start: 975, end: 900 }] };
  const r = validateCourses(wrap(c));
  assert.deepEqual(r.errors, [
    "IS00015-01: times[0].day가 요일(월~일)이 아닙니다",
    "IS00015-01: times[1]의 start가 end보다 늦거나 같습니다",
  ]);
});

test("학점이 숫자가 아니거나 id가 code-section과 다르거나 중복이면 알려 준다", () => {
  const r = validateCourses(wrap({ ...good(), credit: "3" }, { ...good(), id: "IS00015-02" }, good()));
  assert.deepEqual(r.errors, [
    "IS00015-01: credit이 0 이상의 숫자가 아닙니다",
    "IS00015-02: id가 code-section(IS00015-01)과 다릅니다",
    "IS00015-01: id가 중복됩니다",
  ]);
});

test("최상위 형식이 틀린 파일(빈 객체, 배열이 아닌 courses, 빈 강좌 목록)", () => {
  assert.equal(validateCourses(null).ok, false);
  assert.deepEqual(validateCourses({ semester: "2026-2", courses: {} }).errors, ["courses.json: courses가 배열이 아닙니다"]);
  assert.deepEqual(validateCourses({ courses: [] }).errors, ["courses.json: semester가 없습니다", "courses.json: 강좌가 하나도 없습니다"]);
});

// ---------- course_map.json / major_rules.json ----------

test("course_map.json: map이 없거나 새 과목코드가 문자열이 아니면 오류", () => {
  assert.equal(validateCourseMap({}).ok, false);
  assert.deepEqual(validateCourseMap({ map: { AC00015: 179 } }).errors, ["course_map.json: AC00015의 새 과목코드가 문자열이 아닙니다"]);
  assert.equal(validateCourseMap({ map: { AC00015: "AK00179" } }).ok, true);
});

test("major_rules.json: 앱이 쓰는 필수 필드의 형식을 검사한다", () => {
  const rules = readData("major_rules.json");
  assert.equal(validateMajorRules({ ...rules, secondMajorFromGrade: "2" }).ok, false);
  assert.equal(validateMajorRules({ ...rules, singleMajorAllowed: "소프트웨어융합전공" }).ok, false);
  assert.equal(validateMajorRules({ ...rules, explorationByDepartment: { "전공탐색 – 경영학부": "경영학전공" } }).ok, false);
  assert.equal(validateMajorRules([]).ok, false);
});

test("화면 안내용 요약: 처음 3개만 적고 나머지는 개수로", () => {
  assert.equal(summarizeErrors(["a", "b"]), "a / b");
  assert.equal(summarizeErrors(["a", "b", "c", "d", "e"]), "a / b / c 외 2건");
});
