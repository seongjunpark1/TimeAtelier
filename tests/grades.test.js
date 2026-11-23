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

// ---------- 잘못 올린 파일 (예외 상황) ----------
// 브라우저의 file.text()는 파일을 항상 UTF-8로 읽는다. 아래 테스트도 같은 방식으로 바이트를 글자로 바꾼다.
const readAsBrowser = (bytes) => new TextDecoder("utf-8").decode(new Uint8Array(bytes));

test("빈 파일이나 빈 줄만 있는 파일은 '빈 파일' 오류", () => {
  assert.throws(() => extractTakenCourses(""), /빈 파일/);
  assert.throws(() => extractTakenCourses("﻿\r\n"), /빈 파일/);
});

test("'CSV UTF-8'이 아닌 그냥 'CSV'로 저장해 한글이 깨지면 CSV UTF-8로 다시 저장하라고 안내한다", () => {
  // "No,과목코드,과목명,등급 / 1,AB12345,가짜과목,A0"를 한글 Windows 기본 인코딩(CP949)으로 저장한 바이트
  const cp949 = [78, 111, 44, 176, 250, 184, 241, 196, 218, 181, 229, 44, 176, 250, 184, 241, 184, 237, 44, 181, 238, 177, 222, 13, 10,
    49, 44, 65, 66, 49, 50, 51, 52, 53, 44, 176, 161, 194, 165, 176, 250, 184, 241, 44, 65, 48, 13, 10];
  assert.throws(() => extractTakenCourses(readAsBrowser(cp949)), /CSV UTF-8/);
});

test("엑셀 파일(.xlsx)을 그대로 올리면 CSV UTF-8로 저장하라고 안내한다", () => {
  // .xlsx는 zip 파일이라 'PK'로 시작하는 바이너리다
  const xlsx = [80, 75, 3, 4, 20, 0, 6, 0, 8, 0, 0, 0, 33, 0, 98, 238, 157, 104, 94, 1, 0, 0, 144, 4, 0, 0];
  assert.throws(() => extractTakenCourses(readAsBrowser(xlsx)), /CSV UTF-8/);
});

test("열 이름은 맞지만 과목 행이 없으면(합계 행만) 이수 과목 0개를 돌려준다", () => {
  const onlyTotal = "﻿No,년도,학기,과목코드,과목명,이수구분,학점,등급\r\n1,,,,,합계,0,\r\n";
  const { taken, retake } = extractTakenCourses(onlyTotal);
  assert.equal(taken.length + retake.length, 0); // app.js는 이때 '과목코드가 있는 행을 찾지 못했습니다'를 띄운다
});