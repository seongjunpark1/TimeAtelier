// 데이터 파일 검사. 앱 시작(app.js init)과 단위 테스트(npm test)가 같은 함수를 쓴다.
// 학기마다 PDF에서 courses.json을 새로 뽑으므로, 형식이 틀린 강좌가 섞이면
// 엉뚱한 곳에서 알기 어려운 오류가 나기 전에 "어느 강좌의 무엇이 틀렸는지" 바로 알려 준다.
// DOM을 쓰지 않는 순수 함수라 node:test로 검증할 수 있다.

const DAY_NAMES = ["월", "화", "수", "목", "금", "토", "일"];
const MINUTES_PER_DAY = 24 * 60;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * courses.json 검사: { semester: "2026-2", courses: [강좌...] }
 * @returns {{ ok: boolean, errors: string[] }} errors는 "IS00015-01: times가 없습니다"처럼 강좌 id로 시작한다
 */
export function validateCourses(data) {
  const errors = [];
  if (!isObject(data)) return { ok: false, errors: ["courses.json: 최상위가 객체가 아닙니다"] };
  if (!isText(data.semester)) errors.push("courses.json: semester가 없습니다");
  if (!Array.isArray(data.courses)) {
    errors.push("courses.json: courses가 배열이 아닙니다");
    return { ok: false, errors };
  }
  if (data.courses.length === 0) errors.push("courses.json: 강좌가 하나도 없습니다");

  const seen = new Set();
  data.courses.forEach((c, i) => {
    if (!isObject(c)) {
      errors.push(`${i + 1}번째 강좌: 객체가 아닙니다`);
      return;
    }
    const who = isText(c.id) ? c.id : `${i + 1}번째 강좌`;
    const need = (cond, msg) => {
      if (!cond) errors.push(`${who}: ${msg}`);
    };

    need(isText(c.id), "id가 없습니다");
    need(isText(c.code), "code가 없습니다");
    need(isText(c.section), "section이 없습니다");
    need(isText(c.name), "name이 없습니다");
    need(typeof c.type === "string", "type이 없습니다");
    need(typeof c.category === "string", "category가 없습니다");
    need(typeof c.professor === "string", "professor가 문자열이 아닙니다");
    need(Number.isFinite(c.credit) && c.credit >= 0, "credit이 0 이상의 숫자가 아닙니다");
    if (isText(c.id) && isText(c.code) && isText(c.section)) {
      need(c.id === `${c.code}-${c.section}`, `id가 code-section(${c.code}-${c.section})과 다릅니다`);
    }
    if (isText(c.id)) {
      need(!seen.has(c.id), "id가 중복됩니다");
      seen.add(c.id);
    }

    if (!Array.isArray(c.times)) {
      need(false, "times가 없습니다");
      return;
    }
    // 시간 미정 강좌(인턴십 등)는 times가 빈 배열이라 허용한다
    c.times.forEach((t, j) => {
      const at = `times[${j}]`;
      if (!isObject(t)) {
        need(false, `${at}가 객체가 아닙니다`);
        return;
      }
      need(DAY_NAMES.includes(t.day), `${at}.day가 요일(월~일)이 아닙니다`);
      const inDay = (m) => Number.isInteger(m) && m >= 0 && m <= MINUTES_PER_DAY;
      need(inDay(t.start) && inDay(t.end), `${at}의 start·end가 0~1440분 정수가 아닙니다`);
      if (inDay(t.start) && inDay(t.end)) need(t.start < t.end, `${at}의 start가 end보다 늦거나 같습니다`);
    });
  });
  return { ok: errors.length === 0, errors };
}

/** course_map.json 검사: { map: { 옛 과목코드: 새 과목코드 } } */
export function validateCourseMap(data) {
  const errors = [];
  if (!isObject(data) || !isObject(data.map)) return { ok: false, errors: ["course_map.json: map이 객체가 아닙니다"] };
  for (const [from, to] of Object.entries(data.map)) {
    if (!isText(to)) errors.push(`course_map.json: ${from}의 새 과목코드가 문자열이 아닙니다`);
  }
  return { ok: errors.length === 0, errors };
}

/** major_rules.json 검사: 앱이 바로 쓰는 필드만 본다 */
export function validateMajorRules(data) {
  const errors = [];
  if (!isObject(data)) return { ok: false, errors: ["major_rules.json: 최상위가 객체가 아닙니다"] };
  const need = (cond, msg) => {
    if (!cond) errors.push(`major_rules.json: ${msg}`);
  };
  need(isStringArray(data.singleMajorAllowed), "singleMajorAllowed가 문자열 배열이 아닙니다");
  need(Number.isInteger(data.secondMajorFromGrade) && data.secondMajorFromGrade >= 0, "secondMajorFromGrade가 0 이상의 정수가 아닙니다");
  need(isStringArray(data.freshmanLiberalRequired), "freshmanLiberalRequired가 문자열 배열이 아닙니다");
  need(
    isObject(data.explorationByDepartment) && Object.values(data.explorationByDepartment).every(isStringArray),
    "explorationByDepartment가 { 영역: [전공...] } 형식이 아닙니다"
  );
  if (data.fillerTypes !== undefined) need(isStringArray(data.fillerTypes), "fillerTypes가 문자열 배열이 아닙니다");
  return { ok: errors.length === 0, errors };
}

/** 화면에 보여 줄 한 줄 요약: 처음 몇 개만 적고 나머지는 개수로 */
export function summarizeErrors(errors, max = 3) {
  const head = errors.slice(0, max).join(" / ");
  return errors.length > max ? `${head} 외 ${errors.length - max}건` : head;
}
