import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCSV, extractTakenCourses } from "../js/grades.js";

// 실제 성적이 아닌 테스트용 가짜 CSV (엑셀 'CSV UTF-8' 형식: BOM + CRLF + 합계 행)
// 과목코드·학년도·과목명·등급은 모두 지어낸 값이다. AC00015는 과목코드 대응표 테스트용.
const csv =
  "\uFEFFNo,년도,학기,과목코드,과목명,이수구분,학점,등급,전공소속\r\n" +
  "1,2031,2학기,AC00015,테스트용 옛 교양과목,교양필수,2,C+,\r\n" +
  "2,2031,2학기,TS90003,가짜 교양과목,교양필수,2,A0,\r\n" +
  "3,2032,2학기,TS90002,가짜 패스과목,교양필수,0,NP,\r\n" +
  "4,,,,,합계,4,,\r\n" +
  "5,2032,2학기,TS90004,가짜 전공과목 하나,전공필수,3,B0,(주전공) 가짜전공\r\n" +
  "6,2033,2학기,TS90001,가짜 전공과목 둘,전공선택,3,D0,(주전공) 가짜전공\r\n" +
  '7,2033,2학기,TS90005,"가짜과목, 쉼표 포함",전공선택,3,C0,(주전공) 가짜전공\r\n' +
  "8,,,,,합계,9,,\r\n";
const codeMap = { AC00015: "AK00179" };

test("따옴표 안의 쉼표는 칸을 나누지 않는다", () => {
  const rows = parseCSV('a,"b, c",d\n1,2,3');
  assert.deepEqual(rows[0], ["a", "b, c", "d"]);
});

test("BOM이 있어도 첫 열 이름을 '과목코드' 등으로 정상 인식한다", () => {
  assert.equal(parseCSV(csv)[0][0], "No");
});

test("합계 행은 건너뛰고 과목코드가 있는 행만 읽는다", () => {
  const { taken, retake } = extractTakenCourses(csv);
  assert.equal(taken.length + retake.length, 6);
});

test("D0·NP 과목은 이수가 아니라 재수강 후보", () => {
  const { taken, retake } = extractTakenCourses(csv);
  assert.ok(retake.includes("TS90001"));
  assert.ok(retake.includes("TS90002"));
  assert.ok(!taken.includes("TS90001"));
});

test("과목코드 대응표: 예전 코드를 이수했으면 새 코드도 이수로 본다", () => {
  const { taken } = extractTakenCourses(csv, codeMap);
  assert.ok(taken.includes("AC00015"));
  assert.ok(taken.includes("AK00179"));
});

test("과목코드 열이 없으면 원인을 알려주는 오류", () => {
  assert.throws(() => extractTakenCourses("이름,점수\n홍길동,90"), /과목코드/);
});
