// 공휴일 계산과 불러오기 (화면 코드와 분리해서 node:test로 검증한다)
//
// 공휴일 정보는 Nager.Date 공개 API(https://date.nager.at)에서 받는다. 인증키가 필요 없고,
// 응답에 'access-control-allow-origin: *'이 붙어 있어 서버 없이 브라우저에서 바로 부를 수 있다.
// 응답 예: [{ "date": "2026-09-24", "localName": "추석", "name": "Chuseok", ... }, ...]
import * as store from "./storage.js";

export const HOLIDAY_API = "https://date.nager.at/api/v3/PublicHolidays";
const TIMEOUT_MS = 5000; // 5초 안에 답이 없으면 포기한다 (기다리는 동안에도 시간표는 쓸 수 있다)
const CACHE_DAYS = 7; // 공휴일은 자주 바뀌지 않으므로 일주일 동안은 다시 묻지 않는다
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * "2026-09-24" → "목".
 * new Date("2026-09-24")는 UTC 0시로 읽히는데 getDay()는 내 컴퓨터 시간대로 계산해서,
 * 시간대에 따라 하루가 밀릴 수 있다. 그래서 UTC로 읽고 getUTCDay()로 요일을 구한다.
 */
export function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/**
 * 날짜가 해마다 같은(양력) 공휴일의 원래 날짜. 이름은 API의 localName과 같게 적는다.
 * Nager.Date 응답에는 '대체공휴일' 표시가 따로 없고, 쉬는 날이 옮겨지면 옮겨진 날짜만 준다
 * (예: 2026년 광복절은 8/15가 토요일이라 8/17 하나만 온다).
 * 그래서 원래 날짜와 다르면 대체공휴일로 본다.
 * 설날·추석·부처님 오신 날은 음력이라 해마다 날짜가 달라서 이 방법으로는 알 수 없다 (표시하지 않음).
 */
const SOLAR_HOLIDAYS = {
  새해: "01-01",
  "3·1절": "03-01",
  노동절: "05-01",
  어린이날: "05-05",
  현충일: "06-06",
  제헌절: "07-17",
  광복절: "08-15",
  개천절: "10-03",
  한글날: "10-09",
  크리스마스: "12-25",
};

/** 대체공휴일인지: 양력 공휴일인데 원래 날짜가 아닌 날에 쉬면 true. 모르는 이름이면 false */
export function isSubstitute(date, name) {
  const official = SOLAR_HOLIDAYS[name];
  return official !== undefined && date.slice(5) !== official;
}

/**
 * 학기 기간(start~end, 양 끝 포함) 안의 공휴일만 날짜순으로 돌려준다.
 * "YYYY-MM-DD" 형식은 글자 순서가 곧 날짜 순서라서 Date로 바꾸지 않고 문자열 그대로 비교한다.
 */
export function holidaysInSemester(holidays, start, end) {
  return holidays
    .filter((h) => h.date >= start && h.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * "9월 24일(목) 추석" 형식으로 만든다. 대체공휴일이면 "10월 5일(월) 개천절 대체휴일"처럼 뒤에 붙인다.
 * 공휴일 객체 하나(formatHoliday(h)) 또는 날짜와 이름(formatHoliday("2026-09-24", "추석"))을 받는다.
 */
export function formatHoliday(h, name) {
  const date = typeof h === "string" ? h : h.date;
  const label = typeof h === "string" ? name : h.localName;
  const [, month, day] = date.split("-").map(Number); // "09" → 9 처럼 앞의 0을 뗀다
  return `${month}월 ${day}일(${weekdayOf(date)}) ${label}${isSubstitute(date, label) ? " 대체휴일" : ""}`;
}

/**
 * 그 공휴일 요일에 수업이 있는 과목 목록 (= 그날 수업이 겹치는 과목).
 * 시간 미정 과목(인턴십 등)은 times가 비어 있어 어느 요일에도 걸리지 않으므로 저절로 빠진다.
 */
export function affectedCourses(holiday, schedule) {
  const day = weekdayOf(typeof holiday === "string" ? holiday : holiday.date);
  return schedule.filter((c) => c.times.some((t) => t.day === day));
}

/** 학기가 걸친 연도 목록. 2026-12 ~ 2027-02 학기라면 [2026, 2027] */
export function yearsBetween(start, end) {
  const years = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);
  return years;
}

// 캐시 저장값 형식 검사: 예전 형식이거나 손상됐으면 캐시가 없는 것으로 보고 다시 받는다
const isCache = (v) => store.isPlainObject(v) && typeof v.savedAt === "number" && Array.isArray(v.holidays);

/**
 * 한 해의 한국 공휴일을 받아 온다.
 * - 7일 안에 받아 둔 캐시가 있으면 네트워크를 쓰지 않고 그것을 돌려준다
 * - 실패(서버 오류·5초 초과·네트워크 끊김)하면 Error를 던진다. 화면 쪽에서 잡아서 '다시 시도'를 보여 준다
 * - 요청 주소에는 연도와 나라 코드(KR)만 들어간다. 성적·담은 과목 같은 사용자 정보는 보내지 않는다
 *
 * options는 테스트용이다. fetchFn에 가짜 fetch를, now에 가짜 현재 시각을 넣어 네트워크 없이 검사한다.
 */
export async function fetchHolidays(year, { fetchFn = globalThis.fetch, now = Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
  const cacheKey = `holidays-${year}`;
  const cached = store.load(cacheKey, null, isCache);
  // now - savedAt이 음수(컴퓨터 시계를 되돌린 경우)면 믿을 수 없으니 다시 받는다
  if (cached && now - cached.savedAt >= 0 && now - cached.savedAt < CACHE_DAYS * 24 * 60 * 60 * 1000) {
    return cached.holidays;
  }

  // fetch는 스스로 시간 제한이 없어서, 서버가 답을 안 하면 계속 기다린다.
  // AbortController로 5초 뒤에 요청을 취소한다
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${HOLIDAY_API}/${year}/KR`, {
      signal: controller.signal,
      referrerPolicy: "no-referrer", // 어느 페이지에서 불렀는지(주소)도 보내지 않는다
    });
    // fetch는 404·500 같은 오류 응답에도 실패하지 않으므로 ok를 직접 확인해야 한다
    if (!res.ok) throw new Error(`공휴일 서버 응답 오류 (${res.status})`);
    const holidays = await res.json();
    if (!Array.isArray(holidays)) throw new Error("공휴일 응답 형식이 예상과 다릅니다");
    store.save(cacheKey, { savedAt: now, holidays }); // 저장소가 막혀 있어도 save는 멈추지 않는다
    return holidays;
  } catch (err) {
    // 취소된 요청은 'AbortError'라는 알아보기 어려운 오류가 나므로 이유를 바꿔서 알려 준다
    if (err.name === "AbortError") throw new Error(`공휴일 서버가 ${timeoutMs / 1000}초 안에 답하지 않았습니다`);
    throw err;
  } finally {
    clearTimeout(timer); // 먼저 끝났으면 예약해 둔 취소를 지운다
  }
}

/**
 * 학기({ start, end }) 안의 공휴일을 받아 날짜순으로 돌려준다.
 * 학기가 해를 넘기면(예: 12월~2월) 두 해를 Promise.all로 동시에 받는다. 하나라도 실패하면 전체 실패로 본다
 * (한 해 것만 보여 주면 빠진 공휴일이 '수업 있음'처럼 보여 잘못된 정보가 되기 때문이다).
 */
export async function fetchSemesterHolidays(semester, options) {
  const lists = await Promise.all(yearsBetween(semester.start, semester.end).map((y) => fetchHolidays(y, options)));
  return holidaysInSemester(lists.flat(), semester.start, semester.end);
}
