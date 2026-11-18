import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  holidaysInSemester,
  formatHoliday,
  affectedCourses,
  isSubstitute,
  yearsBetween,
  fetchHolidays,
  fetchSemesterHolidays,
} from "../js/holidays.js";

// 네트워크를 쓰지 않도록, 실제 API 응답(2026년 KR)을 파일로 저장해 두고 쓴다
const holidays2026 = JSON.parse(readFileSync(new URL("./fixtures/holidays_2026_KR.json", import.meta.url), "utf-8"));
const semester = JSON.parse(readFileSync(new URL("../data/semester.json", import.meta.url), "utf-8"));

// Node에는 브라우저의 localStorage가 없어서, 캐시 검사를 위해 Map으로 만든 가짜를 넣는다
function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}
beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: fakeLocalStorage(), configurable: true, writable: true });
});

/** 가짜 fetch: 불린 횟수와 주소를 기록하고, 정해 둔 응답을 돌려준다 */
function fakeFetch({ ok = true, status = 200, body = holidays2026 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  return { fn, calls };
}

const course = (name, times) => ({ name, code: name, times });

// ---------- 학기 기간 / 형식 ----------

test("semester.json은 이름과 YYYY-MM-DD 형식의 시작·종료일이 있고 시작이 종료보다 앞이다", () => {
  assert.equal(typeof semester.name, "string");
  assert.match(semester.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(semester.end, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(semester.start < semester.end);
});

test("학기 기간 필터: 2026-2 기간에는 추석 3일·개천절 대체·한글날만 나오고 광복절(8/17)은 안 나온다", () => {
  const dates = holidaysInSemester(holidays2026, "2026-08-31", "2026-12-18").map((h) => h.date);
  assert.deepEqual(dates, ["2026-09-24", "2026-09-25", "2026-09-26", "2026-10-05", "2026-10-09"]);
  assert.ok(!dates.includes("2026-08-17"));
});

test("학기 기간 필터: 시작일·종료일 당일도 포함하고, 순서가 섞여 있어도 날짜순으로 돌려준다", () => {
  const shuffled = [...holidays2026].reverse();
  const dates = holidaysInSemester(shuffled, "2026-09-25", "2026-10-05").map((h) => h.date);
  assert.deepEqual(dates, ["2026-09-25", "2026-09-26", "2026-10-05"]);
});

test("formatHoliday: '9월 24일(목) 추석' 형식 (날짜·이름으로도, 공휴일 객체로도)", () => {
  assert.equal(formatHoliday("2026-09-24", "추석"), "9월 24일(목) 추석");
  assert.equal(formatHoliday({ date: "2026-10-09", localName: "한글날" }), "10월 9일(금) 한글날");
});

test("대체휴일: 양력 공휴일이 원래 날짜가 아닌 날이면 '대체휴일'을 붙인다 (2026 개천절 10/5, 광복절 8/17)", () => {
  assert.equal(formatHoliday("2026-10-05", "개천절"), "10월 5일(월) 개천절 대체휴일");
  assert.equal(formatHoliday({ date: "2026-08-17", localName: "광복절" }), "8월 17일(월) 광복절 대체휴일");
  assert.equal(formatHoliday("2026-10-09", "한글날"), "10월 9일(금) 한글날"); // 원래 날짜면 붙이지 않는다
  assert.equal(isSubstitute("2026-03-02", "3·1절"), true);
});

test("대체휴일: 음력 공휴일(추석 등)과 모르는 이름은 대체휴일로 표시하지 않는다", () => {
  assert.equal(isSubstitute("2026-09-24", "추석"), false);
  assert.equal(isSubstitute("2026-06-03", "지방 선거일"), false);
});

test("해를 넘기는 학기는 두 해가 모두 필요하다", () => {
  assert.deepEqual(yearsBetween("2026-08-31", "2026-12-18"), [2026]);
  assert.deepEqual(yearsBetween("2026-12-21", "2027-02-26"), [2026, 2027]);
});

// ---------- 공휴일과 겹치는 과목 ----------

test("affectedCourses: 9/24(목)에는 목요일 수업만 걸리고, 시간 미정 과목은 빠진다", () => {
  const schedule = [
    course("백엔드프로그래밍", [{ day: "화", start: 900, end: 975 }, { day: "목", start: 900, end: 975 }]),
    course("컴퓨터그래픽스", [{ day: "목", start: 540, end: 690 }]),
    course("데이터베이스", [{ day: "월", start: 600, end: 750 }]),
    course("인턴십", []), // 시간 미정
  ];
  const names = affectedCourses({ date: "2026-09-24", localName: "추석" }, schedule).map((c) => c.name);
  assert.deepEqual(names, ["백엔드프로그래밍", "컴퓨터그래픽스"]);
});

test("affectedCourses: 토요일 공휴일(9/26)에 토요일 수업이 없으면 빈 목록", () => {
  const schedule = [course("백엔드프로그래밍", [{ day: "목", start: 900, end: 975 }])];
  assert.deepEqual(affectedCourses("2026-09-26", schedule), []);
});

// ---------- 불러오기 (가짜 fetch) ----------

test("fetchHolidays: response.ok가 false면 에러를 던지고 캐시에 저장하지 않는다", async () => {
  const { fn } = fakeFetch({ ok: false, status: 500 });
  await assert.rejects(fetchHolidays(2026, { fetchFn: fn }), /500/);
  assert.equal(localStorage.length, 0);
});

test("fetchHolidays: 요청 주소에는 연도와 KR만 들어간다 (사용자 정보 없음)", async () => {
  const { fn, calls } = fakeFetch();
  const list = await fetchHolidays(2026, { fetchFn: fn });
  assert.equal(list.length, holidays2026.length);
  assert.equal(calls[0].url, "https://date.nager.at/api/v3/PublicHolidays/2026/KR");
  assert.equal(calls[0].init.body, undefined);
});

test("fetchHolidays: 캐시가 있으면 fetch를 다시 부르지 않고, 7일이 지나면 다시 부른다", async () => {
  const { fn, calls } = fakeFetch();
  const day = 24 * 60 * 60 * 1000;
  const t0 = Date.UTC(2026, 9, 1);
  await fetchHolidays(2026, { fetchFn: fn, now: t0 });
  const again = await fetchHolidays(2026, { fetchFn: fn, now: t0 + 6 * day });
  assert.equal(calls.length, 1, "7일 안에는 캐시를 써야 함");
  assert.equal(again.length, holidays2026.length);
  await fetchHolidays(2026, { fetchFn: fn, now: t0 + 7 * day });
  assert.equal(calls.length, 2, "7일이 지나면 다시 요청해야 함");
});

test("fetchHolidays: 캐시는 연도별로 따로 둔다", async () => {
  const { fn, calls } = fakeFetch();
  await fetchHolidays(2026, { fetchFn: fn });
  await fetchHolidays(2027, { fetchFn: fn });
  assert.equal(calls.length, 2);
});

test("fetchHolidays: 손상된 캐시는 무시하고 다시 받는다", async () => {
  localStorage.setItem("timetable-maker:holidays-2026", "{망가진 값");
  const { fn, calls } = fakeFetch();
  await fetchHolidays(2026, { fetchFn: fn });
  assert.equal(calls.length, 1);
});

test("fetchHolidays: 정해진 시간 안에 답이 없으면 요청을 취소하고 에러를 던진다", async () => {
  // 답을 영영 안 주다가, 취소 신호(abort)가 오면 그때 AbortError로 실패하는 가짜 fetch
  const hang = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  await assert.rejects(fetchHolidays(2026, { fetchFn: hang, timeoutMs: 30 }), /답하지 않았습니다/);
});

test("fetchSemesterHolidays: 해를 넘기는 학기는 두 해를 함께 받아 기간 안의 것만 돌려준다", async () => {
  const byYear = {
    2026: [{ date: "2026-12-25", localName: "크리스마스" }, { date: "2026-10-09", localName: "한글날" }],
    2027: [{ date: "2027-01-01", localName: "새해" }, { date: "2027-03-01", localName: "3·1절" }],
  };
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => byYear[url.match(/\/(\d{4})\//)[1]] };
  };
  const list = await fetchSemesterHolidays({ start: "2026-12-21", end: "2027-02-26" }, { fetchFn: fn });
  assert.equal(urls.length, 2);
  assert.deepEqual(list.map((h) => h.date), ["2026-12-25", "2027-01-01"]);
});
