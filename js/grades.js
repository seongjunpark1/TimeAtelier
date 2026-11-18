// 종합정보시스템 '졸업자가진단 - 전체성적' 엑셀을 CSV UTF-8로 저장한 파일을 읽는다.
// 성적 값은 '재수강 후보' 판단에만 잠깐 쓰고 저장하지 않는다. (개인정보 비기능 요구사항 N2)

/** 따옴표("...")를 고려해 CSV 텍스트를 2차원 배열로 나눈다 */
export function parseCSV(text) {
  text = text.replace(/^﻿/, ""); // 엑셀 UTF-8 CSV 맨 앞의 BOM 제거
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'; // "" 는 따옴표 한 개
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// 이 등급이면 '이수'로 보지 않고 재수강 후보로 남긴다
export const RETAKE_GRADES = ["D+", "D0", "D", "F", "NP"];

/**
 * 자동 채우기(전공 후보·교양 채우기)에서 뺄 과목코드 = 이수한 과목 + 재수강 가능 과목.
 * 재수강은 학생이 직접 정할 일이라 프로그램이 알아서 넣지 않는다. 다시 들으려면 2단계에서 직접 담으면 된다.
 * (검색 목록의 '재수강 가능' 표시와 '이수한 과목 숨기기'는 이 목록과 따로 동작한다)
 */
export function autoFillExcludedCodes({ taken = [], retake = [] } = {}) {
  return [...new Set([...taken, ...retake])];
}

/**
 * 성적 CSV 텍스트에서 이수 과목코드를 뽑는다.
 * @param {string} text  CSV 파일 내용
 * @param {Object} codeMap  { 예전코드: 새코드 } 과목코드 대응표
 * @returns {{ taken: string[], retake: string[], names: Object }}
 * @throws {Error} 과목코드 열을 찾을 수 없을 때
 */
export function extractTakenCourses(text, codeMap = {}) {
  const rows = parseCSV(text);
  if (rows.length === 0) throw new Error("빈 파일입니다.");

  const header = rows[0].map((h) => h.trim());
  const codeCol = header.indexOf("과목코드");
  const nameCol = header.indexOf("과목명");
  const gradeCol = header.indexOf("등급");
  if (codeCol === -1) {
    throw new Error("'과목코드' 열을 찾을 수 없습니다. 전체성적 엑셀을 'CSV UTF-8'로 저장했는지 확인하세요.");
  }

  const taken = new Set();
  const retake = new Set();
  const names = {};

  for (const row of rows.slice(1)) {
    const code = (row[codeCol] || "").trim();
    if (!/^[A-Z]{2}\d{5}$/.test(code)) continue; // '합계' 행처럼 과목코드가 없는 행은 건너뛴다

    const grade = gradeCol === -1 ? "" : (row[gradeCol] || "").trim();
    const codes = [code];
    if (codeMap[code]) codes.push(codeMap[code]); // 이름·코드가 바뀐 과목도 함께 처리

    for (const c of codes) {
      names[c] = nameCol === -1 ? "" : (row[nameCol] || "").trim();
      if (RETAKE_GRADES.includes(grade)) {
        if (!taken.has(c)) retake.add(c);
      } else {
        taken.add(c);
        retake.delete(c); // 재수강해서 통과했다면 이수로 본다
      }
    }
  }
  return { taken: [...taken], retake: [...retake], names };
}
