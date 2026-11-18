// 시간표 조합 알고리즘 (화면 코드와 분리해서 node:test로 검증한다)
//
// 강좌(course) 형태 예시:
// { id: "IS00015-01", code: "IS00015", section: "01", name: "백엔드프로그래밍", credit: 3,
//   type: "전공선택", grade: "2,3,4", category: "소프트웨어융합전공",
//   times: [{ day: "화", start: 900, end: 975 }, { day: "목", start: 900, end: 975 }] }
// start/end는 0시 기준 '분' 단위다. (900 = 15:00)

export const DAYS = ["월", "화", "수", "목", "금", "토"];

/** 두 수업 시간이 겹치는지: 같은 요일이고 구간이 조금이라도 겹치면 true */
export function slotsOverlap(a, b) {
  return a.day === b.day && a.start < b.end && b.start < a.end;
}

/** 두 강좌 중 하나라도 시간이 겹치면 true */
export function coursesConflict(c1, c2) {
  return c1.times.some((a) => c2.times.some((b) => slotsOverlap(a, b)));
}

/** 공강 요일·시작/종료 시간 조건을 만족하는 강좌인지 */
export function fitsTimeRules(course, { offDays = [], earliestStart = 0, latestEnd = 24 * 60 } = {}) {
  return course.times.every(
    (t) => !offDays.includes(t.day) && t.start >= earliestStart && t.end <= latestEnd
  );
}

/**
 * 학년 칸 해석: "2,3,4" / "2.3.4" / "1" / "전체" -> 수강 가능 학년 배열 (null이면 전체 학년)
 * PDF마다 쉼표·마침표가 섞여 있어서 숫자만 뽑는다.
 */
export function parseGradeLevels(grade) {
  const nums = String(grade ?? "").match(/[1-4]/g);
  return nums ? nums.map(Number) : null;
}

/** 내 학년(myGrade)에 들을 수 있는 강좌인지. myGrade가 0이면 학년 상관없음 */
export function fitsGrade(course, myGrade) {
  if (!myGrade) return true;
  const levels = parseGradeLevels(course.grade);
  return levels === null || levels.includes(myGrade);
}

/**
 * 조합에 쓸 후보 풀을 만든다.
 * - 선택한 전공들(categories: 주전공 + 복수전공·부전공)의 강좌 중 학년이 맞고 이수하지 않은 것
 * - + 사용자가 담은 '꼭 넣을 과목'
 * 전공을 여러 개 고를 수 있게 되면서 문자열 하나 대신 배열을 받는다. 빈 배열이면 담은 과목만 쓴다.
 * 담은 과목은 사용자가 고른 분반만 쓰도록, 같은 과목코드의 다른 분반은 풀에서 뺀다.
 * 시간 미정 과목(인턴십 등)은 요일을 차지하지 않아 '공강 많은 순'에서 공짜 학점처럼 1등을 차지하므로
 * 자동 채우기 후보에서는 빼고, 학생이 직접 담았을 때만 넣는다.
 */
export function hasTime(course) {
  return course.times.length > 0;
}

export function buildPool(courses, { categories = [], myGrade = 0, taken = [], picked = [] } = {}) {
  const takenSet = new Set(taken);
  const pickedCodes = new Set(picked.map((c) => c.code));
  // 빈 문자열(선택 안 함)은 빼고, 같은 전공이 두 번 들어와도 한 번만 세도록 Set으로 만든다
  const categorySet = new Set(categories.filter(Boolean));
  const fromMajor = courses.filter(
    (c) =>
      categorySet.has(c.category) &&
      hasTime(c) &&
      !pickedCodes.has(c.code) &&
      !takenSet.has(c.code) &&
      fitsGrade(c, myGrade)
  );
  return [...picked, ...fromMajor];
}

/**
 * 전공 과목만으로 목표 학점을 못 채울 때 더할 교양 후보.
 * - types(예: ["교양선택"])에 해당하고, 시간이 정해져 있고, 학년이 맞고, 이수하지 않았고, 이미 후보 풀에 있는 과목이 아닌 것
 * - 결과에서 교양으로 채운 과목을 구분할 수 있게 filler: true 표시를 붙인 복사본을 돌려준다
 *   (원본 강좌 객체를 고치면 검색 목록 등 다른 화면에도 표시가 묻어나므로 복사한다)
 */
export function buildFillerPool(courses, { types = [], myGrade = 0, taken = [], excludeCodes = [] } = {}) {
  const typeSet = new Set(types);
  const skip = new Set([...taken, ...excludeCodes]);
  return courses
    .filter((c) => typeSet.has(c.type) && hasTime(c) && !skip.has(c.code) && fitsGrade(c, myGrade))
    .map((c) => ({ ...c, filler: true }));
}

// ---------- 전공 규칙 ----------

/**
 * 주전공·복수전공·부전공 조합이 학교 규칙에 맞는지 검사한다. (화면과 상관없는 순수 함수라 테스트하기 쉽다)
 * 규칙 값은 학교 사정에 따라 바뀔 수 있어서 코드에 쓰지 않고 data/major_rules.json에서 받아 온다.
 *
 * @param {Object} majors
 *   mainMajor   : 주전공 (""이면 전공 없이 담은 과목으로만 짠다)
 *   secondMajor : 복수전공 또는 부전공 ("" = 선택 안 함)
 *   secondType  : "복수전공" | "부전공" | ""
 *   myGrade     : 내 학년 (0 = 상관없음)
 * @param {Object} rules
 *   singleMajorAllowed   : 복수전공·부전공 없이 주전공만 들어도 되는(심화전공이 있는) 전공 목록
 *   secondMajorFromGrade : 이 학년부터 복수전공·부전공이 필수 (0이나 없으면 검사하지 않음)
 * @returns {{ ok: boolean, message: string }}
 */
export function validateMajors({ mainMajor = "", secondMajor = "", secondType = "", myGrade = 0 } = {}, rules = {}) {
  const { singleMajorAllowed = [], secondMajorFromGrade = 0 } = rules;
  const fail = (message) => ({ ok: false, message });

  if (secondMajor) {
    if (!mainMajor) return fail("주전공을 먼저 선택해야 합니다.");
    if (secondMajor === mainMajor) return fail("주전공과 같은 전공은 복수전공·부전공으로 선택할 수 없습니다.");
    if (secondType !== "복수전공" && secondType !== "부전공") return fail("복수전공인지 부전공인지 선택해야 합니다.");
    return { ok: true, message: "" };
  }

  // 여기부터는 복수전공·부전공을 고르지 않은 경우
  // 전공을 아예 안 고르면 담은 과목으로만 짜는 것이므로 막지 않는다.
  // 학년이 '상관없음'(0)이면 몇 학년인지 모르니 강요하지 않는다.
  const mustChoose =
    mainMajor &&
    secondMajorFromGrade > 0 &&
    myGrade >= secondMajorFromGrade &&
    !singleMajorAllowed.includes(mainMajor);
  if (mustChoose) return fail(`${secondMajorFromGrade}학년부터는 복수전공 또는 부전공을 선택해야 합니다.`);
  return { ok: true, message: "" };
}

/**
 * 1학년(자유전공학부)이 고른 관심 전공 -> 그 전공이 속한 학부의 전공탐색 영역 이름.
 * 1학년은 전공 과목 대신 전공탐색 과목을 들으므로, 관심 전공의 학부 전탐을 추천하는 데 쓴다.
 * - 전공탐색 영역을 직접 골랐으면 그대로 돌려준다
 * - 학부 정보가 없는 전공이면 ""(추천 없음)
 */
export function explorationCategoryFor(major, rules = {}) {
  const departments = rules.explorationByDepartment ?? {};
  if (!major) return "";
  if (major in departments) return major;
  for (const [category, majors] of Object.entries(departments)) {
    if (majors.includes(major)) return category;
  }
  return "";
}

/**
 * 1학년이 들을 수 있는 전공탐색 영역 목록.
 * - 자유전공학부(rules.freeMajorDepartment): 모든 학부의 전공탐색
 * - 학부 소속: 자기 학부의 전공탐색 하나 (dept에는 전공탐색 영역 이름이 들어온다)
 * - 소속을 아직 안 골랐으면 []
 */
export function explorationScope(dept, rules = {}) {
  const all = Object.keys(rules.explorationByDepartment ?? {});
  if (!dept) return [];
  if (dept === rules.freeMajorDepartment) return all;
  return all.includes(dept) ? [dept] : [];
}

/**
 * 1학년 자동 채우기에 쓸 전공탐색 영역.
 * 학부 소속이면 자기 학부, 자유전공학부면 관심 전공의 학부(관심 전공을 안 골랐으면 전 학부)를 쓴다.
 * 관심 전공의 학부 정보가 없으면 []을 돌려서 화면이 '추천할 수 없음'을 알릴 수 있게 한다.
 */
export function recommendedExploration({ dept = "", interest = "" } = {}, rules = {}) {
  if (dept && dept === rules.freeMajorDepartment && interest) {
    const category = explorationCategoryFor(interest, rules);
    return category ? [category] : [];
  }
  return explorationScope(dept, rules);
}

/**
 * 소속 때문에 들을 수 없는 전공탐색 강좌를 골라낸다. (학부 소속 1학년이 다른 학부 전탐을 담은 경우)
 * 전공탐색이 아닌 과목(교양 등)은 소속과 상관없으므로 건드리지 않는다.
 */
export function forbiddenExploration(sections, dept, rules = {}) {
  const all = new Set(Object.keys(rules.explorationByDepartment ?? {}));
  const allowed = new Set(explorationScope(dept, rules));
  return sections.filter((c) => all.has(c.category) && !allowed.has(c.category));
}

/**
 * 직접 고정한 분반들 중 시간이 겹치는 쌍을 찾는다. [[강좌A, 강좌B], ...]
 * 예: 인권과평화와 디지털리터러시는 모든 분반이 금요일 같은 시간이라 한 학기에 같이 고를 수 없다.
 * 탐색을 돌린 뒤 '조합 없음'만 보여 주는 것보다, 무엇이 겹치는지 바로 알려 주는 편이 고치기 쉽다.
 */
export function findTimeConflicts(sections) {
  const pairs = [];
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (coursesConflict(sections[i], sections[j])) pairs.push([sections[i], sections[j]]);
    }
  }
  return pairs;
}

/**
 * 꼭 넣을 과목들 중 '어떤 분반을 골라도 반드시 겹치는' 과목 쌍을 찾는다. [[과목A 분반들, 과목B 분반들], ...]
 * 같은 과목의 분반을 여러 개 담으면 그중 하나만 들어가므로, 안 겹치는 분반이 하나라도 있으면 문제가 아니다.
 * (세 과목 이상이 얽혀서 막히는 경우까지는 찾지 않는다. 그때는 탐색 결과가 '조합 없음'으로 나온다)
 */
export function findUnavoidableConflicts(sections) {
  const groups = groupByCode(sections);
  const pairs = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const always = groups[i].sections.every((a) => groups[j].sections.every((b) => coursesConflict(a, b)));
      if (always) pairs.push([groups[i].sections, groups[j].sections]);
    }
  }
  return pairs;
}

/** 겹치는 과목 쌍을 사람이 읽을 문장으로 만든다. (분반이 하나면 '몇 분반'까지 적는다) */
export function describeConflict([a, b]) {
  const label = (secs) => (secs.length === 1 ? `${secs[0].name}(${secs[0].section}분반)` : secs[0].name);
  return `${label(a)}과(와) ${label(b)}의 시간이 겹칩니다`;
}

/** 강좌 목록을 과목코드별로 묶는다. 같은 과목의 분반은 하나만 고를 수 있기 때문 */
export function groupByCode(courses) {
  const groups = new Map();
  for (const c of courses) {
    if (!groups.has(c.code)) groups.set(c.code, []);
    groups.get(c.code).push(c);
  }
  return [...groups.entries()].map(([code, sections]) => ({
    code,
    credit: sections[0].credit,
    sections,
  }));
}

// ---------- 조합 평가 ----------

/** 시간표의 총 학점 */
export function totalCredit(schedule) {
  return schedule.reduce((sum, c) => sum + c.credit, 0);
}

/** 수업이 하나도 없는 평일 수 */
export function countFreeWeekdays(schedule) {
  const used = new Set(schedule.flatMap((c) => c.times.map((t) => t.day)));
  return DAYS.slice(0, 5).filter((d) => !used.has(d)).length;
}

/** 같은 날 수업 사이 빈 시간(분)의 합. 작을수록 학교에 붙잡혀 있는 시간이 짧다 */
export function totalGapMinutes(schedule) {
  let gap = 0;
  for (const day of DAYS) {
    const slots = schedule
      .flatMap((c) => c.times)
      .filter((t) => t.day === day)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < slots.length; i++) gap += Math.max(0, slots[i].start - slots[i - 1].end);
  }
  return gap;
}

/** 전공필수 과목 수 */
export function countMajorRequired(schedule) {
  return schedule.filter((c) => c.type === "전공필수").length;
}

/** 오전 수업(10:30 전에 시작하는 수업) 횟수 */
export const MORNING_LIMIT = 10 * 60 + 30;
export function countMorningClasses(schedule) {
  return schedule.flatMap((c) => c.times).filter((t) => t.start < MORNING_LIMIT).length;
}

export const RANK_MODES = {
  free: "공강 많은 순",
  morning: "오전 수업 적은 순",
  required: "전공필수 많은 순",
  major: "전공 많이 넣는 순",
};

/**
 * 1순위 기준 값. 이 값은 과목을 더 넣을수록 '나빠지기만' 하거나(공강, 오전 수업)
 * 남은 과목으로 얼마나 좋아질 수 있는지 계산할 수 있어서(전공필수), 탐색 중 가지치기에 쓴다.
 */
export function primaryValue(schedule, mode) {
  if (mode === "morning") return -countMorningClasses(schedule);
  if (mode === "required") return countMajorRequired(schedule);
  if (mode === "major") return mainCredit(schedule);
  return countFreeWeekdays(schedule);
}

/** 교양으로 채운 과목(filler)을 뺀 학점 = 전공(1학년은 교필·전탐)과 담은 과목 학점 */
export function mainCredit(schedule) {
  return totalCredit(schedule.filter((c) => !c.filler));
}

/**
 * 조합 점수(클수록 좋음) = 1순위 x 큰 가중치 + 2순위(공강·빈 시간 등).
 * 빈 시간은 최대 수천 분이라 x10을 해도 1,000,000을 넘지 않으므로 1순위 순서를 뒤집지 못한다.
 */
export const PRIMARY_WEIGHT = 1e6;
export function scoreSchedule(schedule, mode = "free") {
  const free = countFreeWeekdays(schedule);
  const gap = totalGapMinutes(schedule);
  if (mode === "fill" || mode === "major") {
    // fill(교양으로 채우기, 공강 우선)  : 공강 일수 > 전공 학점 많음 > 교양 학점 적음 > 빈 시간 적음
    // major(전공 많이 넣는 순)          : 전공 학점 많음 > 공강 일수 > 교양 학점 적음 > 빈 시간 적음
    // 단계마다 아래 값이 위 단계 가중치를 넘지 않게 잡았다 (학점은 최대 24, 공강은 최대 5, 빈 시간은 많아야 수천 분)
    const main = mainCredit(schedule);
    const fillerCredit = totalCredit(schedule) - main;
    const [first, second] = mode === "fill" ? [free, main] : [main, free];
    return first * 1e9 + second * 1e6 - fillerCredit * 1e4 - gap;
  }
  const tie = mode === "free" ? -gap * 10 : free * 1e5 - gap * 10; // 동점일 때: 공강 많고 빈 시간 적은 쪽
  return primaryValue(schedule, mode) * PRIMARY_WEIGHT + tie;
}

/**
 * 점수 상위 k개만 유지하는 목록에 하나를 넣는다. (k가 20처럼 작아서 정렬된 배열에 끼워 넣어도 충분히 빠르다)
 * 결과를 전부 모았다가 정렬하면 조합이 수십만 개일 때 메모리를 많이 쓰기 때문.
 */
export function pushTopK(top, item, k) {
  if (top.length === k && item.score <= top[top.length - 1].score) return;
  let i = top.length;
  while (i > 0 && top[i - 1].score < item.score) i--;
  top.splice(i, 0, item);
  if (top.length > k) top.pop();
}

/**
 * 조건을 만족하는 시간표 조합을 백트래킹으로 찾는다.
 *
 * @param {Array} candidates  후보 강좌(분반 단위)
 * @param {Object} options
 *   minCredit, maxCredit : 목표 학점 범위
 *   offDays              : 공강으로 비울 요일 배열 (예: ["금"])
 *   earliestStart        : 이 시각(분) 전에 시작하는 수업 제외
 *   latestEnd            : 이 시각(분) 후에 끝나는 수업 제외
 *   required             : 반드시 넣을 과목코드 배열 (사용자가 담은 과목)
 *   excluded             : 빼야 할 과목코드 배열
 *   topK                 : 이 값이 있으면 점수 상위 topK개만 돌려준다 (rankMode 기준)
 *   rankMode             : "free" | "morning" | "required" | "major"(전공 학점 > 공강)
 *                          | "fill"(교양으로 채우기: 공강 > 전공 학점 > 교양 학점 적음)
 *   maxResults           : 찾을 조합 수 상한 (무한히 오래 도는 것을 막는 안전장치)
 *   categoryCredits      : 전공별 학점 범위 { "신문방송학전공": { min: 9, max: 12 }, ... }
 *                          min/max를 생략하면 그쪽은 제한 없음. 담은 과목도 그 전공 과목이면 포함해서 센다.
 * @returns {{ schedules: Array<Array>, total: number, truncated: boolean, error?: string }}
 */
export function generateSchedules(candidates, options = {}) {
  const {
    minCredit = 0,
    maxCredit = 21,
    offDays = [],
    earliestStart = 0,
    latestEnd = 24 * 60,
    required = [],
    excluded = [],
    topK = 0,
    rankMode = "free",
    maxResults = topK ? 1_000_000 : 200,
    categoryCredits = {},
  } = options;

  const fail = (error) => ({ schedules: [], total: 0, truncated: false, error });

  if (minCredit > maxCredit) return fail("최소 학점이 최대 학점보다 큽니다.");

  // 전공별 학점 제한 목록. 실제로 제한이 있는 전공만 남겨서 탐색 중 검사 횟수를 줄인다
  const limits = Object.entries(categoryCredits)
    .map(([category, { min = 0, max = Infinity } = {}]) => ({ category, min, max }))
    .filter((l) => l.min > 0 || l.max < Infinity);
  for (const l of limits) {
    if (l.min > l.max) return fail(`${l.category}의 최소 학점이 최대 학점보다 큽니다.`);
  }
  const limitMinSum = limits.reduce((s, l) => s + l.min, 0);
  if (limitMinSum > maxCredit) {
    return fail(`전공별 최소 학점의 합(${limitMinSum})이 전체 최대 학점(${maxCredit})보다 큽니다.`);
  }

  // 1) 빼야 할 과목 + 시간 조건에 안 맞는 분반을 미리 걸러낸다 (탐색 전 가지치기)
  const excludedSet = new Set(excluded.filter((code) => !required.includes(code)));
  const usable = candidates.filter(
    (c) => !excludedSet.has(c.code) && fitsTimeRules(c, { offDays, earliestStart, latestEnd })
  );
  const groups = groupByCode(usable);

  // 2) 꼭 넣을 과목이 조건 때문에 전부 걸러졌다면 이유를 알려준다
  for (const code of required) {
    if (!groups.some((g) => g.code === code)) {
      const name = candidates.find((c) => c.code === code)?.name ?? code;
      return fail(`'${name}'의 분반이 공강·시간 조건을 만족하지 못합니다. 조건을 풀거나 담은 과목에서 빼 보세요.`);
    }
  }
  const requiredSet = new Set(required);
  // 꼭 넣을 과목끼리 어떤 분반을 골라도 겹치면 조합이 하나도 나올 수 없다. '조건을 풀어 보세요' 대신 이유를 알려 준다
  const requiredSections = usable.filter((c) => requiredSet.has(c.code));
  const clash = findUnavoidableConflicts(requiredSections);
  if (clash.length) return fail(`${describeConflict(clash[0])}. 둘 중 하나를 빼거나 다른 분반을 담아 주세요.`);
  const requiredCredit = groups.filter((g) => requiredSet.has(g.code)).reduce((s, g) => s + g.credit, 0);
  if (requiredCredit > maxCredit) {
    return fail(`담은 과목만으로 ${requiredCredit}학점이라 최대 학점(${maxCredit})을 넘습니다.`);
  }

  // 3) 탐색 순서: 꼭 넣을 과목 먼저, 그다음 분반이 적은 과목부터 (일찍 막히는 쪽을 먼저 시도)
  groups.sort(
    (a, b) =>
      Number(requiredSet.has(b.code)) - Number(requiredSet.has(a.code)) ||
      // 교양으로 채우기: 전공 과목을 먼저 정하고 교양은 나중에 시도한다.
      // 그래야 교양 차례가 왔을 때 '남은 전공 학점'이 0이 되어 아래 2순위 가지치기가 잘 듣는다
      Number(Boolean(a.sections[0].filler)) - Number(Boolean(b.sections[0].filler)) ||
      a.sections.length - b.sections.length
  );

  // remainingMax[i] = i번째 이후 과목을 모두 넣었을 때 더할 수 있는 최대 학점
  const remainingMax = new Array(groups.length + 1).fill(0);
  for (let i = groups.length - 1; i >= 0; i--) {
    remainingMax[i] = remainingMax[i + 1] + groups[i].credit;
  }

  // 전공별 학점 제한 준비.
  // limitOf[i] = i번째 과목이 속한 제한의 번호 (제한 없는 영역이면 -1)
  // remainingCat[i][k] = i번째 이후 과목 중 k번 전공 과목을 모두 넣었을 때 더할 수 있는 학점
  //   -> '남은 과목을 다 넣어도 이 전공 최소 학점을 못 채우면 중단'하는 가지치기에 쓴다 (전체 학점의 remainingMax와 같은 원리)
  const limitIndex = new Map(limits.map((l, k) => [l.category, k]));
  const limitOf = groups.map((g) => limitIndex.get(g.sections[0].category) ?? -1);
  const remainingCat = Array.from({ length: groups.length + 1 }, () => new Array(limits.length).fill(0));
  for (let i = groups.length - 1; i >= 0; i--) {
    remainingCat[i] = [...remainingCat[i + 1]];
    if (limitOf[i] >= 0) remainingCat[i][limitOf[i]] += groups[i].credit;
  }
  // 담은 과목만으로 어떤 전공의 최대 학점을 넘으면 어떤 조합도 만들 수 없으므로 미리 알려 준다
  for (const [k, l] of limits.entries()) {
    const pickedCredit = groups
      .filter((g, i) => requiredSet.has(g.code) && limitOf[i] === k)
      .reduce((s, g) => s + g.credit, 0);
    if (pickedCredit > l.max) {
      return fail(`담은 ${l.category} 과목만으로 ${pickedCredit}학점이라 이 전공의 최대 학점(${l.max})을 넘습니다.`);
    }
  }
  const catCredit = new Array(limits.length).fill(0); // 지금 고른 과목의 전공별 학점

  const found = []; // topK가 없을 때: 찾은 순서대로 저장
  const top = []; // topK가 있을 때: { score, schedule } 상위 k개
  const chosen = [];
  let total = 0;
  let truncated = false;

  function record() {
    total++;
    if (total >= maxResults) truncated = true;
    const schedule = [...chosen];
    if (topK) {
      const [primary, second] = currentKey();
      // 1·2순위부터 k등보다 나쁘면 자세한 점수(빈 시간 계산)는 건너뛴다
      if (top.length === topK && worseThanLast(primary, second)) return;
      pushTopK(top, { score: scoreSchedule(schedule, rankMode), primary, second, schedule }, topK);
    }
    else found.push(schedule);
  }

  // remainingReq[i] = i번째 이후 과목 중 전공필수 과목 수 ('전공필수 많은 순' 가지치기용)
  const remainingReq = new Array(groups.length + 1).fill(0);
  for (let i = groups.length - 1; i >= 0; i--) {
    remainingReq[i] = remainingReq[i + 1] + (groups[i].sections[0].type === "전공필수" ? 1 : 0);
  }
  // remainingMain[i] = i번째 이후 과목 중 교양 채우기가 아닌 과목의 학점 합 ('fill' 2순위 가지치기용)
  const remainingMain = new Array(groups.length + 1).fill(0);
  for (let i = groups.length - 1; i >= 0; i--) {
    remainingMain[i] = remainingMain[i + 1] + (groups[i].sections[0].filler ? 0 : groups[i].credit);
  }

  // 지금 고른 과목들의 요일 사용·오전 수업·전공필수 수를 넣고 뺄 때마다 갱신한다.
  // (매번 처음부터 세면 느리기 때문. 결과는 primaryValue(chosen)와 같다)
  const dayUse = Object.fromEntries(DAYS.map((d) => [d, 0]));
  const counts = { usedWeekdays: 0, morning: 0, req: 0, main: 0 }; // main = 교양 채우기가 아닌 과목 학점
  const WEEKDAYS = new Set(DAYS.slice(0, 5));

  function add(section, sign) {
    for (const t of section.times) {
      if (sign > 0 && dayUse[t.day]++ === 0 && WEEKDAYS.has(t.day)) counts.usedWeekdays++;
      if (sign < 0 && --dayUse[t.day] === 0 && WEEKDAYS.has(t.day)) counts.usedWeekdays--;
      if (t.start < MORNING_LIMIT) counts.morning += sign;
    }
    if (section.type === "전공필수") counts.req += sign;
    if (!section.filler) counts.main += sign * section.credit;
  }

  function currentPrimary() {
    if (rankMode === "morning") return -counts.morning;
    if (rankMode === "required") return counts.req;
    if (rankMode === "major") return counts.main;
    return 5 - counts.usedWeekdays;
  }

  /**
   * 정렬 키 [1순위, 2순위]. 2순위는 공강 일수인데, '공강 많은 순'에서는 2순위가 빈 시간이라
   * 과목을 넣을수록 줄어든다는 보장이 없어서 가지치기에 쓰지 않는다(Infinity).
   * '교양으로 채우기'(fill)는 1순위 공강 일수, 2순위 전공 학점이고,
   * '전공 많이 넣는 순'(major)은 1순위 전공 학점, 2순위 공강 일수다.
   */
  function currentKey() {
    if (rankMode === "fill") return [currentPrimary(), counts.main];
    if (rankMode === "major") return [currentPrimary(), 5 - counts.usedWeekdays];
    return [currentPrimary(), rankMode === "free" ? Infinity : 5 - counts.usedWeekdays];
  }

  function worseThanLast(primary, second) {
    const last = top[topK - 1];
    return primary < last.primary || (primary === last.primary && second < last.second);
  }

  /** 지금 고른 과목에서 앞으로 가장 좋아져 봐야 얼마인지 (낙관적 추정) */
  function bestPossibleKey(i, credit) {
    const [p, s2] = currentKey();
    // 공강·오전 수업은 과목을 더 넣으면 나빠지기만 하므로 지금 값이 최선.
    // 전공필수 수는 남은 전공필수를 전부 넣는 경우가 최선.
    // 전공 학점도 같은 원리로 남은 전공 과목을 전부 넣는 경우가 최선인데, 최대 학점을 넘을 수는 없으므로
    // '최대 학점 - 이미 넣은 교양 학점'보다 커질 수 없다. (이 상한 덕분에 가지치기가 훨씬 잘 된다)
    const bestMain = Math.min(counts.main + remainingMain[i], maxCredit - (credit - counts.main));
    if (rankMode === "fill") return [p, bestMain];
    if (rankMode === "major") return [bestMain, s2];
    return [rankMode === "required" ? p + remainingReq[i] : p, s2];
  }

  function search(i, credit) {
    if (truncated) return;
    // 가지치기 1: 남은 과목을 다 넣어도 최소 학점에 못 미치면 더 볼 필요가 없다
    if (credit + remainingMax[i] < minCredit) return;
    // 가지치기 1-2: 같은 원리로, 어떤 전공의 남은 과목을 다 넣어도 그 전공 최소 학점에 못 미치면 중단
    // (맨 끝 i === groups.length에서는 remainingCat이 0이므로, 여기를 통과했다면 전공별 최소 학점은 채운 것이다)
    for (let k = 0; k < limits.length; k++) {
      if (catCredit[k] + remainingCat[i][k] < limits[k].min) return;
    }
    // 가지치기 2: 상위 k개가 다 찼는데, 이 길로 가면 1순위 값이 k등보다 나쁠 수밖에 없다면 버린다
    if (topK && top.length === topK && worseThanLast(...bestPossibleKey(i, credit))) return;

    if (i === groups.length) {
      if (credit >= minCredit && credit > 0) record();
      return;
    }

    const group = groups[i];

    // 선택지 A: 이 과목의 분반 하나를 넣는다
    // 전체 최대 학점뿐 아니라, 이 과목이 속한 전공의 최대 학점도 넘지 않을 때만 넣는다
    const k = limitOf[i];
    const fitsCategory = k < 0 || catCredit[k] + group.credit <= limits[k].max;
    if (credit + group.credit <= maxCredit && fitsCategory) {
      if (k >= 0) catCredit[k] += group.credit;
      for (const section of group.sections) {
        if (chosen.some((c) => coursesConflict(c, section))) continue; // 시간 겹침 -> 되돌아감
        chosen.push(section);
        add(section, +1);
        search(i + 1, credit + group.credit);
        add(section, -1);
        chosen.pop();
        if (truncated) break; // return하면 아래 catCredit 되돌리기를 건너뛰므로 break
      }
      if (k >= 0) catCredit[k] -= group.credit;
      if (truncated) return;
    }

    // 선택지 B: 이 과목을 건너뛴다 (꼭 넣을 과목은 건너뛸 수 없음)
    if (!requiredSet.has(group.code)) search(i + 1, credit);
  }

  search(0, 0);
  return {
    schedules: topK ? top.map((t) => t.schedule) : found,
    total,
    truncated,
  };
}

/** "09:30" <-> 570 변환 */
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function toHHMM(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}
