// 화면 동작 담당. 계산은 scheduler.js, 성적 파일 처리는 grades.js가 맡는다.
import {
  DAYS,
  buildPool,
  buildFillerPool,
  validateMajors,
  recommendedExploration,
  forbiddenExploration,
  findUnavoidableConflicts,
  describeConflict,
  generateSchedules,
  totalCredit,
  countFreeWeekdays,
  toHHMM,
} from "./scheduler.js";
import { extractTakenCourses, autoFillExcludedCodes } from "./grades.js";
import { fetchSemesterHolidays, formatHoliday, affectedCourses } from "./holidays.js";
import * as store from "./storage.js";

const $ = (id) => document.getElementById(id);
const MAX_SEARCH_RESULTS = 60;
const TOP_K = 20; // 결과는 점수 상위 20개까지만 보여준다

const state = {
  courses: [],
  byId: new Map(),
  codeMap: {},
  // 저장값은 형식을 검사해서 읽는다. 손상되거나 예전 형식이면 기본값으로 시작해 앱이 멈추지 않게 한다
  cart: store.load("cart", [], store.isStringArray), // 꼭 넣을 과목(분반 id 목록)
  taken: store.load(
    "taken",
    { taken: [], retake: [] },
    (v) => store.isPlainObject(v) && store.isStringArray(v.taken) && store.isStringArray(v.retake)
  ),
  // 1학년 교양필수로 고정한 분반 id 목록. 담은 과목처럼 고르는 즉시 저장한다 (과목코드·분반만, 성적 아님)
  liberal: store.load("liberal", [], store.isStringArray),
  // 전공 규칙(data/major_rules.json). 파일을 못 읽으면 secondMajorFromGrade 0 = '검사 안 함'으로 둔다
  rules: {
    singleMajorAllowed: [],
    secondMajorFromGrade: 0,
    freshmanLiberalRequired: [],
    explorationByDepartment: {},
    freeMajorDepartment: "",
    freeMajorLiberalRequired: [],
    fillerTypes: [],
  },
  majorList: [], // 복수전공·부전공으로 고를 수 있는 '전공' 영역 이름 목록
  // 결과를 만들 때의 전공 선택 [{ category, role }]과 고정한 교양필수 과목코드. 결과 배지는 이 값으로 그린다.
  // 전공 드롭다운을 바꾸면 후보 과목 자체가 달라지므로 다시 만들기 전까지 배지를 유지하고,
  // 복수전공/부전공 버튼은 표시용이라 누르는 즉시 배지에 반영한다.
  majorsUsed: [],
  liberalUsed: [],
  filled: false, // 마지막 결과가 교양으로 채운 결과인지 (상태 문구에 쓴다)
  majorCredits: {}, // 전공별 학점 입력값 { 전공 이름: { min, max } } (빈 칸은 키를 아예 두지 않음)
  majorCreditSignature: null, // 전공별 학점 줄을 마지막으로 그린 전공 조합 (불필요하게 다시 그리지 않으려고)
  schedules: [],
  page: 0,
  // 마지막 결과를 만들 때의 입력값 요약. 지금 입력값과 다르면 '조건이 바뀌었습니다' 안내를 띄운다
  resultKey: "",
  // 이번 학기 공휴일. status: "loading"(불러오는 중) / "error"(실패) / "ok"(성공)
  // 시간표 계산과 따로 움직이므로, 어떤 상태여도 시간표 만들기는 그대로 된다
  holidays: { status: "loading", list: [], semester: null },
};

// ---------- 데이터 불러오기 ----------
async function init() {
  // 전체 초기화 버튼은 가장 먼저 연결한다. 아래 준비 과정에서 오류가 나도 저장값을 지우고 다시 시작할 수 있게
  bindResetAll();
  // 공휴일은 강좌 데이터를 기다리지 않고 바로 요청한다. await하지 않으므로 느리거나 실패해도
  // 아래 강좌 데이터 준비와 시간표 만들기가 멈추지 않는다
  $("holidayRetry").addEventListener("click", loadHolidays);
  loadHolidays();
  try {
    const [coursesRes, mapRes, rulesRes] = await Promise.all([
      fetch("data/courses.json"),
      fetch("data/course_map.json"),
      fetch("data/major_rules.json"),
    ]);
    if (!coursesRes.ok) throw new Error(`courses.json ${coursesRes.status}`);
    const data = await coursesRes.json();
    state.courses = data.courses;
    state.byId = new Map(data.courses.map((c) => [c.id, c]));
    state.codeMap = mapRes.ok ? (await mapRes.json()).map : {};
    // 규칙 파일이 없어도 시간표는 짤 수 있어야 하므로, 실패하면 기본값(검사 안 함)을 그대로 쓴다
    if (rulesRes.ok) state.rules = { ...state.rules, ...(await rulesRes.json()) };
    else console.warn("major_rules.json을 읽지 못해 전공 규칙 검사를 건너뜁니다.");
    $("semester").textContent = `(${data.semester.replace("-", "학년도 ")}학기 · 강좌 ${data.courses.length}개)`;
  } catch (err) {
    showStatus("강좌 데이터를 불러오지 못했습니다. 파일을 직접 열지 말고 로컬 서버(Live Server 등)로 실행하세요.", true);
    console.error(err);
    return;
  }

  try {
    // 저장된 담기 목록 중 데이터에 없는 id는 정리
    state.cart = state.cart.filter((id) => state.byId.has(id));
    state.liberal = state.liberal.filter((id) => state.byId.has(id));

    fillCategories();
    fillDepartments();
    renderSecondOptions(); // 저장된 조건이 없을 때도 복수전공·부전공 목록이 채워져 있어야 한다
    fillOffDays();
    restoreConditions();
    renderLiberal(); // 소속(자유전공학부인지)에 따라 줄이 달라지므로 조건을 복원한 다음에 그린다
    bindEvents();
    renderSearch();
    renderCart();
    renderTakenStatus();
    renderChecks();
    renderPoolInfo();
  } catch (err) {
    // 저장값 검사를 통과했는데도 예상 못 한 이유로 실패하면, 화면이 조용히 멈추지 않게 해결 방법을 알려 준다
    showStatus("화면을 준비하다 오류가 났습니다. 맨 아래 '전체 초기화'를 눌러 저장된 설정을 지운 뒤 다시 해 보세요.", true);
    console.error(err);
  }
}

/** 전체 초기화: 이 앱의 저장값을 모두 지우고 페이지를 다시 연다 (처음 연 것과 똑같은 상태가 확실히 보장된다) */
function bindResetAll() {
  $("resetAll").addEventListener("click", () => {
    if (!confirm("담은 과목, 불러온 이수 과목, 교양필수 분반, 전공·학년·학점·공강 조건을 모두 지웁니다. 계속할까요?")) return;
    store.clearAll();
    location.reload();
  });
}

/** 개설 영역 목록: 전공 / 전공탐색 / 교양·기타로 묶어서 보여준다 */
function fillCategories() {
  const kinds = new Map(); // category -> 그룹 이름
  for (const c of state.courses) {
    if (!c.category || kinds.get(c.category) === "전공") continue;
    const kind = c.type.startsWith("전공필수") || c.type.startsWith("전공선택")
      ? "전공"
      : c.type === "전공탐색" ? "전공탐색" : "교양·기타";
    kinds.set(c.category, kind);
  }

  for (const groupName of ["전공", "전공탐색", "교양·기타"]) {
    const cats = [...kinds].filter(([, k]) => k === groupName).map(([cat]) => cat).sort();
    const group = (label) => {
      const g = document.createElement("optgroup");
      g.label = label;
      for (const cat of cats) {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        g.append(opt);
      }
      return g;
    };
    $("mainMajor").append(group(groupName));
    $("category").append(group(groupName));
    // 복수전공·부전공은 실제 '전공'만 가능하다 (전공탐색·교양은 전공이 아니므로 제외)
    if (groupName === "전공") state.majorList = cats;
  }
}

/**
 * 복수전공·부전공 드롭다운을 다시 만든다. 주전공이나 학년이 바뀔 때마다 호출한다.
 * - 주전공과 같은 전공은 목록에서 뺀다 (같은 전공을 두 번 이수할 수는 없으니까)
 * - 첫 칸('')의 이름은 상황에 따라 다르게 보여 준다
 */
function renderSecondOptions() {
  const select = $("secondMajor");
  const prev = select.value;
  const { mainMajor, myGrade } = readMajorInputs();
  const { singleMajorAllowed, secondMajorFromGrade } = state.rules;

  let emptyLabel = "선택 안 함";
  if (singleMajorAllowed.includes(mainMajor)) emptyLabel = "선택 안 함 (심화전공)";
  else if (mainMajor && secondMajorFromGrade && myGrade >= secondMajorFromGrade) emptyLabel = "선택하세요";

  select.innerHTML = "";
  select.append(new Option(emptyLabel, ""));
  for (const cat of state.majorList) {
    if (cat !== mainMajor) select.append(new Option(cat, cat));
  }
  // 주전공을 바꿔도 이전에 고른 복수전공·부전공은 가능한 한 유지한다
  select.value = prev !== mainMajor && state.majorList.includes(prev) ? prev : "";
}

function fillOffDays() {
  for (const day of DAYS.slice(0, 5)) {
    const label = document.createElement("label");
    label.className = "day-chip";
    label.innerHTML = `<input type="checkbox" value="${day}"><span>${day}</span>`;
    $("offDays").append(label);
  }
}

// ---------- 조건 저장/복원 ----------

/** 1학년은 자유전공학부라 전공이 없다. 2학년 때 전공을 고르므로 1학년 화면은 따로 다룬다 */
function isFreshman() {
  return Number($("myGrade").value) === 1;
}

/** 1학년은 전공이 정해지지 않았으므로 복수전공·부전공 영역을 보여 주지 않는다 */
function secondAreaVisible() {
  return !isFreshman();
}

/** 1학년 소속이 자유전공학부인지. 자유전공학부만 관심 전공을 고르고 전 학부 전탐을 들을 수 있다 */
function isFreeMajor() {
  return isFreshman() && $("freshmanDept").value !== "" && $("freshmanDept").value === state.rules.freeMajorDepartment;
}

/** 주전공(1학년 자유전공학부면 관심 전공) 칸을 쓰는지. 학부 소속 1학년은 학부가 곧 전탐 범위라 필요 없다 */
function mainMajorUsable() {
  return !isFreshman() || isFreeMajor();
}

/** 1단계 입력값. 숨겨진 칸(1학년의 복수전공·부전공, 학부 소속 1학년의 관심 전공)은 '선택 안 함'으로 본다 */
function readMajorInputs() {
  const mainMajor = mainMajorUsable() ? $("mainMajor").value : "";
  const myGrade = Number($("myGrade").value);
  const usable = secondAreaVisible() && mainMajor !== "";
  const secondMajor = usable ? $("secondMajor").value : "";
  // 복수전공/부전공 구분은 지금은 표시용이지만, 나중에 이수 학점 기준이 달라질 수 있어서 값을 같이 둔다
  const secondType = secondMajor ? document.querySelector('input[name="secondType"]:checked').value : "";
  // 1학년 소속(학부의 전공탐색 영역 이름 또는 '자유전공학부'). 1학년이 아니어도 값은 저장해 둔다
  const freshmanDept = $("freshmanDept").value;
  return { mainMajor, secondMajor, secondType, myGrade, freshmanDept };
}

/**
 * 학점 칸 값을 0~24 정수로 읽는다. 빈 칸이면 fallback.
 * number 칸의 min/max 속성은 직접 타이핑한 값을 막지 못하므로 여기서 한 번 더 맞춘다
 */
function readCreditInput(el, fallback) {
  if (el.value.trim() === "") return fallback;
  const n = Math.round(Number(el.value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(24, Math.max(0, n));
}

function readConditions() {
  return {
    ...readMajorInputs(),
    minCredit: readCreditInput($("minCredit"), 0),
    maxCredit: readCreditInput($("maxCredit"), 24),
    offDays: [...$("offDays").querySelectorAll("input:checked")].map((i) => i.value),
    earliestStart: Number($("earliestStart").value),
    latestEnd: Number($("latestEnd").value),
    rankMode: $("sort").value,
    categoryCredits: readMajorCredits(),
  };
}

// ---------- 전공별 학점 ----------

/**
 * 자동 채우기에 쓸 영역 목록 [{ category, role }].
 * category는 courses.json의 개설 영역 이름, role은 배지에 쓰는 '주전공' / '복수전공' / '부전공' / '전공탐색'.
 * 후보 풀·전공별 학점·결과 배지가 모두 이 함수 하나를 보므로, 1학년 처리도 여기서만 바꾸면 된다.
 */
function chosenMajors() {
  const { mainMajor, secondMajor, secondType, freshmanDept } = readMajorInputs();
  if (isFreshman()) {
    // 1학년은 전공 과목 대신 전공탐색 과목으로 채운다.
    // 학부 소속이면 자기 학부 전탐, 자유전공학부면 관심 전공의 학부(관심 전공이 없으면 전 학부) 전탐
    return recommendedExploration({ dept: freshmanDept, interest: mainMajor }, state.rules)
      .map((category) => ({ category, role: "전공탐색" }));
  }
  const list = [];
  if (mainMajor) list.push({ category: mainMajor, role: "주전공" });
  if (secondMajor) list.push({ category: secondMajor, role: secondType });
  return list;
}

// ---------- 1학년 교양필수 ----------

/**
 * 1학년 교양필수 과목마다 '이번 학기 안 들음 / 분반(교수·시간)' 선택 칸을 만든다.
 * 학부마다 학기별로 듣는 과목이 달라서, 어떤 과목을 들을지와 분반은 학생이 직접 고른다.
 * 과목 목록은 data/major_rules.json의 freshmanLiberalRequired에서 읽는다.
 */
function renderLiberal() {
  const rows = liberalCodesForMe().map((code) => {
    const sections = state.courses.filter((c) => c.code === code);
    if (!sections.length) return ""; // 이번 학기에 개설되지 않은 과목은 줄을 만들지 않는다
    const chosen = state.liberal.find((id) => state.byId.get(id).code === code) ?? "";
    const options = sections
      .map((c) => `<option value="${escapeHTML(c.id)}" ${c.id === chosen ? "selected" : ""}>${escapeHTML(c.section)} · ${escapeHTML(professorLabel(c))} · ${formatTimes(c)}</option>`) // 칸이 좁아 '분반' 글자는 뺀다
      .join("");
    const name = escapeHTML(sections[0].name);
    return `<div class="liberal-row">
      <span class="name">${name} <span class="muted">${sections[0].credit}학점</span>${isTaken(code) ? ` <span class="badge taken">이수</span>` : ""}</span>
      <select data-code="${escapeHTML(code)}" aria-label="${name} 분반"><option value="">이번 학기 안 들음</option>${options}</select>
    </div>`;
  });
  $("liberalList").innerHTML = rows.join("");
}

/** 1학년일 때 고정할 교양필수 분반(강좌 객체). 1학년이 아니면 저장만 해 두고 쓰지 않는다 */
function fixedLiberalSections() {
  if (!isFreshman()) return [];
  // 소속을 바꾸면 그 소속이 듣지 않는 교필(예: 학부 소속의 자유전공팀세미나)은 저장만 해 두고 쓰지 않는다
  const mine = new Set(liberalCodesForMe());
  return state.liberal.map((id) => state.byId.get(id)).filter((c) => mine.has(c.code));
}

/** 지금 소속의 1학년이 듣는 교양필수 과목코드. 자유전공팀세미나처럼 자유전공학부만 듣는 과목은 자유전공학부일 때만 넣는다 */
function liberalCodesForMe() {
  const { freshmanLiberalRequired, freeMajorLiberalRequired } = state.rules;
  return isFreeMajor() ? [...freshmanLiberalRequired, ...freeMajorLiberalRequired] : freshmanLiberalRequired;
}

/**
 * 꼭 넣을 과목(교필 고정 분반 + 담은 과목) 중 어떤 분반을 골라도 겹치는 쌍을 찾아 안내 문구를 만든다.
 * 교필끼리 겹치면 교필 칸 아래에, 담은 과목이 끼어 있으면 담은 과목 아래에 보여 준다.
 * @returns {{ liberal: string, cart: string }}
 */
function conflictMessages() {
  const liberalCodes = new Set(fixedLiberalSections().map((c) => c.code));
  const pairs = findUnavoidableConflicts(pickedSections());
  const liberalPair = pairs.find(([a, b]) => liberalCodes.has(a[0].code) && liberalCodes.has(b[0].code));
  const cartPair = pairs.find((pair) => pair !== liberalPair);
  return {
    liberal: liberalPair ? `${describeConflict(liberalPair)}. 한 학기에 같이 듣는 과목인지 확인해 주세요.` : "",
    cart: cartPair ? `${describeConflict(cartPair)}. 둘 중 하나를 빼거나 다른 분반을 담아 주세요.` : "",
  };
}

/** 1학년인데 교양필수를 하나도 안 골랐으면 경고 문구, 아니면 "" */
function liberalMissingNotice() {
  if (!isFreshman() || fixedLiberalSections().length > 0) return "";
  return "1학년은 교양필수를 꼭 들어야 합니다. 이번 학기에 배정받은 분반을 고르지 않으면 교양필수 시간이 빠진, 실제와 다른 시간표가 나와요.";
}

// ---------- 1학년 소속 ----------

/** 1학년 소속 목록: 자유전공학부 + 각 학부 (값은 그 학부의 전공탐색 영역 이름, 보이는 이름은 학부 이름만) */
function fillDepartments() {
  const select = $("freshmanDept");
  const free = state.rules.freeMajorDepartment;
  if (free) select.append(new Option(`${free} (모든 학부 전공탐색 가능)`, free));
  for (const category of Object.keys(state.rules.explorationByDepartment)) {
    select.append(new Option(category.replace(/^전공탐색\s*–\s*/, ""), category));
  }
}

/** 지금 소속으로는 들을 수 없는 강좌인지 (학부 소속 1학년의 다른 학부 전탐) */
function isForbiddenForMe(course) {
  const dept = $("freshmanDept").value;
  if (!isFreshman() || !dept) return false;
  // 자유전공학부 전용 교필은 학부 소속 1학년이 들을 수 없다
  if (!isFreeMajor() && state.rules.freeMajorLiberalRequired.includes(course.code)) return true;
  return forbiddenExploration([course], dept, state.rules).length > 0;
}

/** 담은 과목 중 소속 때문에 들을 수 없는 것이 있으면 안내 문구, 아니면 "" */
function forbiddenCartMessage() {
  const bad = state.cart.map((id) => state.byId.get(id)).filter(isForbiddenForMe);
  if (!bad.length) return "";
  const names = [...new Set(bad.map((c) => c.name))].join(", ");
  return `지금 소속으로는 들을 수 없는 과목입니다(다른 학부 전공탐색, 자유전공학부 전용 교양필수). 담은 과목에서 빼 주세요: ${names}`;
}

/**
 * 3단계의 '전공별 학점' 줄을 고른 전공에 맞춰 다시 그린다.
 * 입력값은 state.majorCredits에 전공 이름별로 기억해 두기 때문에,
 * 복수전공을 바꿨다가 되돌려도 전에 쓴 학점이 다시 나타난다.
 */
function renderMajorCredits() {
  // 1학년은 교양필수 + 전공탐색뿐이라 전체 학점 범위로 충분하다. (자유전공학부는 전탐 영역이 6개라 줄도 너무 많아진다)
  const majors = isFreshman() ? [] : chosenMajors();
  // 전공이 그대로인데 다시 그리면 입력 중인 칸의 커서가 사라지므로, 바뀌었을 때만 다시 그린다
  const signature = majors.map((m) => `${m.category}/${m.role}`).join("|");
  if (signature === state.majorCreditSignature) return;
  state.majorCreditSignature = signature;

  $("majorCreditArea").hidden = majors.length === 0;
  $("majorCredits").innerHTML = majors
    .map(({ category, role }) => {
      const saved = state.majorCredits[category] ?? {};
      const cat = escapeHTML(category);
      return `<div class="credit-row">
        <span class="name"><span class="badge major">${escapeHTML(role)}</span> ${cat}</span>
        <input type="number" min="0" max="24" data-cat="${cat}" data-bound="min" value="${saved.min ?? ""}" aria-label="${cat} 최소 학점">
        ~
        <input type="number" min="0" max="24" data-cat="${cat}" data-bound="max" value="${saved.max ?? ""}" aria-label="${cat} 최대 학점">
        학점
      </div>`;
    })
    .join("");
}

/** 고른 전공의 학점 범위만 골라서 scheduler.js가 받는 형태({ 전공: { min, max } })로 만든다 */
function readMajorCredits() {
  const result = {};
  if (isFreshman()) return result; // 1학년은 전공별 학점 칸이 없다 (renderMajorCredits 참고)
  for (const { category } of chosenMajors()) {
    const saved = state.majorCredits[category];
    if (saved && (saved.min !== undefined || saved.max !== undefined)) result[category] = { ...saved };
  }
  return result;
}

/** select에 없는 값이 저장돼 있으면(예전 버전·손상) fallback으로 둔다 */
function setSelect(el, value, fallback) {
  el.value = String(value ?? fallback);
  if (el.selectedIndex === -1) el.value = String(fallback);
}

function restoreConditions() {
  const saved = store.load("conditions", null, store.isPlainObject);
  if (!saved) return;
  // 예전 버전은 전공을 하나만 골라 major로 저장했다. 그 값을 주전공(mainMajor)으로 옮겨 새 형식으로 다시 저장한다
  if (saved.major !== undefined && saved.mainMajor === undefined) {
    saved.mainMajor = saved.major;
    delete saved.major;
    store.save("conditions", saved);
  }
  // 저장된 전공이 이번 학기 데이터에 없으면 select 값이 저절로 ''(선택 안 함)이 된다
  setSelect($("mainMajor"), saved.mainMajor, "");
  setSelect($("myGrade"), saved.myGrade, 0);
  setSelect($("freshmanDept"), saved.freshmanDept, "");
  renderSecondOptions(); // 주전공·학년을 먼저 넣어야 복수전공·부전공 목록을 만들 수 있다
  setSelect($("secondMajor"), saved.secondMajor, "");
  for (const radio of document.querySelectorAll('input[name="secondType"]')) {
    if (radio.value === saved.secondType) radio.checked = true;
  }
  const credit = (v, d) => (Number.isFinite(v) ? Math.min(24, Math.max(0, Math.round(v))) : d);
  $("minCredit").value = credit(saved.minCredit, 15);
  $("maxCredit").value = credit(saved.maxCredit, 18);
  setSelect($("earliestStart"), saved.earliestStart, 0);
  setSelect($("latestEnd"), saved.latestEnd, 1440);
  setSelect($("sort"), saved.rankMode, "free");
  const offDays = store.isStringArray(saved.offDays) ? saved.offDays : [];
  for (const input of $("offDays").querySelectorAll("input")) {
    input.checked = offDays.includes(input.value);
  }
  // 줄은 init의 renderChecks()가 그린다
  state.majorCredits = store.isPlainObject(saved.categoryCredits) ? saved.categoryCredits : {};
}

/**
 * 조건을 바로 저장한다. (예전에는 '만들기'를 눌러야 저장돼서, 교필은 남는데 학년은 사라지는 일이 있었다)
 * 숨겨진 칸(1학년의 주전공·복수전공 등)도 화면 값 그대로 저장해서, 학년을 바꿨다 돌아와도 선택이 남게 한다
 */
function saveConditions() {
  store.save("conditions", {
    mainMajor: $("mainMajor").value,
    secondMajor: $("secondMajor").value,
    secondType: document.querySelector('input[name="secondType"]:checked').value,
    myGrade: Number($("myGrade").value),
    freshmanDept: $("freshmanDept").value,
    minCredit: readCreditInput($("minCredit"), 0),
    maxCredit: readCreditInput($("maxCredit"), 24),
    offDays: [...$("offDays").querySelectorAll("input:checked")].map((i) => i.value),
    earliestStart: Number($("earliestStart").value),
    latestEnd: Number($("latestEnd").value),
    rankMode: $("sort").value,
    categoryCredits: state.majorCredits, // 지금 안 보이는 전공의 값도 함께 둔다
  });
}

/**
 * 결과와 입력값이 어긋났는지 판단할 때 쓰는 입력값 요약.
 * 순위 기준은 바꾸면 바로 다시 계산하고, 복수전공/부전공 구분은 배지만 바뀌므로 비교에서 뺀다
 */
function inputKey() {
  const { rankMode, secondType, ...cond } = readConditions();
  return JSON.stringify({
    cond,
    cart: state.cart,
    liberal: fixedLiberalSections().map((c) => c.id),
    taken: autoFillExcludedCodes(state.taken), // 재수강 목록이 바뀌어도 후보가 달라진다
  });
}

/** 결과를 만든 뒤 조건이 바뀌었으면 결과 위에 안내를 띄운다 (화면 결과가 어떤 조건인지 헷갈리지 않게) */
function renderStale() {
  const stale = state.schedules.length > 0 && state.resultKey !== inputKey();
  $("staleNotice").hidden = !stale;
}

/**
 * 2단계 검색 영역을 자동 채우기 영역에 맞춰 준다. '꼭 넣을 과목'을 같은 영역에서 찾는 경우가 많아서다.
 * 자동 채우기 영역이 여러 개면(자유전공학부 + 관심 전공 없음) 하나로 정할 수 없으니 '전체 영역'으로 둔다.
 */
function syncSearchCategory() {
  if ($("search").value) return; // 검색어를 쓰는 중이면 건드리지 않는다
  const majors = chosenMajors();
  $("category").value = majors.length === 1 ? majors[0].category : isFreshman() ? "" : $("mainMajor").value;
  renderSearch();
}

// ---------- 이벤트 ----------
function bindEvents() {
  $("mainMajor").addEventListener("change", () => {
    renderSecondOptions();
    renderChecks();
    renderPoolInfo();
    syncSearchCategory();
  });
  $("myGrade").addEventListener("change", () => {
    renderSecondOptions(); // 학년에 따라 첫 칸 이름('선택하세요' / '선택 안 함')이 바뀐다
    renderLiberal(); // 다시 1학년이 되면 자유전공학부 전용 교필 줄도 맞춰서 그린다
    renderChecks();
    renderPoolInfo();
    renderSearch(); // 1학년 학부 소속이면 다른 학부 전탐의 '담기'가 잠긴다
  });
  $("freshmanDept").addEventListener("change", () => {
    renderLiberal(); // 자유전공학부일 때만 자유전공팀세미나 줄이 나온다
    renderChecks();
    renderPoolInfo();
    syncSearchCategory();
    renderSearch();
  });
  // 교양필수 분반: 같은 과목은 한 분반만 고정하므로, 그 과목코드의 이전 선택을 지우고 새로 넣는다
  $("liberalList").addEventListener("change", (e) => {
    const { code } = e.target.dataset;
    if (!code) return;
    state.liberal = state.liberal.filter((id) => state.byId.get(id).code !== code);
    if (e.target.value) state.liberal.push(e.target.value);
    store.save("liberal", state.liberal);
    renderChecks();
    renderPoolInfo();
    renderStale();
  });
  $("secondMajor").addEventListener("change", () => {
    renderChecks();
    renderPoolInfo();
  });
  for (const radio of document.querySelectorAll('input[name="secondType"]')) {
    radio.addEventListener("change", () => {
      renderChecks();
      // 복수전공/부전공 구분은 시간표 계산에 영향이 없는 표시용 값이라 다시 계산할 필요 없이 배지만 바꾼다
      const second = state.majorsUsed.find((m) => m.role === "복수전공" || m.role === "부전공");
      if (second) {
        second.role = radio.value;
        renderResult();
      }
    });
  }

  $("search").addEventListener("input", renderSearch);
  $("category").addEventListener("change", renderSearch);
  $("hideTaken").addEventListener("change", renderSearch);

  $("results").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-add]");
    if (!btn) return;
    const id = btn.dataset.add;
    if (!state.cart.includes(id)) state.cart.push(id);
    saveCart();
  });

  $("cart").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-remove]");
    if (!btn) return;
    state.cart = state.cart.filter((id) => id !== btn.dataset.remove);
    saveCart();
  });

  $("gradeFile").addEventListener("change", onGradeFile);

  $("clearTaken").addEventListener("click", () => {
    state.taken = { taken: [], retake: [] };
    store.remove("taken");
    $("gradeFile").value = "";
    renderLiberal(); // 교양필수 줄의 '이수' 표시를 지운다
    renderTakenStatus();
    renderSearch();
    renderCart();
    renderPoolInfo();
    renderStale();
  });

  // 전공별 학점 칸: 줄이 다시 그려져도 동작하도록 바깥 상자 하나에 이벤트를 건다
  $("majorCredits").addEventListener("input", (e) => {
    const { cat, bound } = e.target.dataset;
    if (!cat) return;
    const entry = (state.majorCredits[cat] ??= {});
    if (e.target.value === "") delete entry[bound]; // 빈 칸 = 제한 없음
    else entry[bound] = readCreditInput(e.target, 0);
  });
  // 칸에서 나갈 때 실제로 쓰는 값(0~24 정수)으로 고쳐 보여 준다
  $("majorCredits").addEventListener("change", (e) => {
    const { cat, bound } = e.target.dataset;
    if (cat && e.target.value !== "") e.target.value = state.majorCredits[cat]?.[bound] ?? "";
  });

  // 1단계·3단계의 칸이 바뀌면 바로 저장하고, 결과와 어긋났는지 표시한다.
  // 칸마다 따로 붙이면 빠뜨리기 쉬워서 카드 단위로 한 번에 처리한다
  const settingCards = '[aria-labelledby="step1"], [aria-labelledby="step3"]';
  const onSettingChanged = (e) => {
    if (!e.target.closest(settingCards)) return;
    if (e.type === "change" && (e.target.id === "minCredit" || e.target.id === "maxCredit")) {
      // 24를 넘거나 소수로 입력하면 실제로 쓰는 값으로 칸을 고쳐 보여 준다
      e.target.value = readCreditInput(e.target, e.target.id === "minCredit" ? 0 : 24);
    }
    saveConditions();
    renderStale();
  };
  document.addEventListener("change", onSettingChanged);
  document.addEventListener("input", onSettingChanged);

  $("generate").addEventListener("click", onGenerate);
  // 순위 기준이 바뀌면 상위 20개가 달라지므로 다시 계산한다
  $("sort").addEventListener("change", () => {
    saveConditions();
    if (state.schedules.length) onGenerate();
  });
  $("prev").addEventListener("click", () => movePage(-1));
  $("next").addEventListener("click", () => movePage(1));
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "ArrowLeft") movePage(-1);
    if (e.key === "ArrowRight") movePage(1);
  });
}

function saveCart() {
  store.save("cart", state.cart);
  renderSearch();
  renderCart();
  renderChecks(); // 학부 소속 1학년이 다른 학부 전탐을 담았는지, 담은 과목끼리 겹치는지 다시 검사한다
  renderPoolInfo();
  renderStale();
}

// ---------- 성적 CSV ----------
async function onGradeFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text(); // 브라우저 안에서만 읽는다. 서버 전송 없음.
    const { taken, retake } = extractTakenCourses(text, state.codeMap);
    if (taken.length === 0 && retake.length === 0) throw new Error("과목코드가 있는 행을 찾지 못했습니다.");
    state.taken = { taken, retake }; // 성적 값은 저장하지 않는다
    store.save("taken", state.taken);
    renderLiberal(); // 이미 들은 교양필수에 '이수' 표시
    renderTakenStatus();
    renderSearch();
    renderCart();
    renderPoolInfo();
    renderStale();
  } catch (err) {
    $("takenStatus").textContent = `불러오기 실패: ${err.message}`;
    $("takenStatus").className = "status error";
  }
}

function renderTakenStatus() {
  const { taken, retake } = state.taken;
  const el = $("takenStatus");
  el.className = "status";
  el.textContent = taken.length
    ? `이수 과목 ${taken.length}개를 자동 채우기에서 제외합니다.` +
      (retake.length ? ` 재수강 가능 ${retake.length}개도 자동으로 넣지 않습니다(다시 들으려면 2단계에서 담으세요).` : "")
    : "불러온 이수 과목이 없습니다.";
}

const isTaken = (code) => state.taken.taken.includes(code);
const isRetake = (code) => state.taken.retake.includes(code);

// ---------- 전공 규칙 ----------

/**
 * 전공 규칙을 검사해서 1단계 카드에 안내를 띄우고, 규칙에 어긋나면 '시간표 조합 만들기'를 막는다.
 * 검사는 scheduler.js의 validateMajors(순수 함수)가 하고, 여기서는 결과를 화면에 보여 주기만 한다.
 */
function renderChecks() {
  const freshman = isFreshman();
  $("secondArea").hidden = !secondAreaVisible();
  // 1학년은 전공이 없으므로 소속을 먼저 고른다.
  // 자유전공학부만 '관심 전공'을 골라 그 학부 전탐을 추천받고, 학부 소속은 자기 학부 전탐으로 정해져 있어 관심 전공 칸을 숨긴다
  $("deptField").hidden = !freshman;
  $("mainMajorField").hidden = !mainMajorUsable();
  $("mainMajorLabel").textContent = freshman ? "관심 전공" : "주전공";
  $("mainMajor").options[0].textContent = freshman
    ? "선택 안 함 (모든 학부 전공탐색)"
    : "선택 안 함 (담은 과목으로만 짜기)";
  $("step1Hint").textContent = !freshman
    ? "고른 전공(주전공 + 복수전공·부전공)의 과목 중 내 학년이 들을 수 있고 아직 안 들은 과목으로 남은 학점을 자동으로 채웁니다."
    : isFreeMajor()
      ? "자유전공학부는 모든 학부의 전공탐색 과목을 들을 수 있어요. 관심 전공을 고르면 그 학부의 전공탐색 과목으로 남은 학점을 채웁니다."
      : "1학년은 소속 학부의 전공탐색 과목만 들을 수 있어요. 자유전공학부는 모든 학부의 전공탐색을 들을 수 있습니다.";
  $("liberalArea").hidden = !freshman;
  // 주전공 목록: 2학년 이상은 실제 '전공'만, 1학년(자유전공학부의 관심 전공)은 전공 + 전공탐색 영역.
  // 교양 영역을 주전공으로 고르는 일이 없게 한다. 지금 고른 값이 막힌 묶음에 있으면 '선택 안 함'으로 되돌린다
  for (const group of $("mainMajor").querySelectorAll("optgroup")) {
    const allowed = group.label === "전공" || (freshman && group.label === "전공탐색");
    group.disabled = !allowed;
    group.hidden = !allowed;
  }
  if ($("mainMajor").selectedOptions[0]?.parentElement.disabled) {
    $("mainMajor").value = "";
    renderSecondOptions();
  }
  // 주전공 없이 복수전공·부전공만 고를 수는 없으므로 주전공을 고르기 전에는 잠가 둔다
  const hasMain = $("mainMajor").value !== "";
  $("secondMajor").disabled = !hasMain;
  // 이수 방식(복수전공/부전공)은 두 번째 전공을 골랐을 때만 의미가 있다.
  // 고르지 않았는데 '복수전공'이 켜져 보이면 심화전공 학생이 헷갈리므로, 버튼을 잠그고 선택 표시도 지운다
  const hasSecond = hasMain && $("secondMajor").value !== "";
  for (const radio of document.querySelectorAll('input[name="secondType"]')) radio.disabled = !hasSecond;
  $("secondArea").classList.toggle("no-second", !hasSecond);
  const deepMajor = state.rules.singleMajorAllowed.includes($("mainMajor").value);
  $("secondHint").hidden = !secondAreaVisible() || !hasMain || hasSecond;
  $("secondHint").innerHTML = deepMajor
    ? "<b>심화전공</b>으로 주전공만 이수합니다. 이수 방식은 복수전공·부전공을 고를 때만 정하면 돼요."
    : "이수 방식은 복수전공·부전공을 고르면 선택할 수 있어요.";

  let { ok, message } = validateMajors(readMajorInputs(), state.rules);
  // 1학년은 소속에 따라 들을 수 있는 전공탐색이 달라서, 소속을 모르면 규칙대로 시간표를 짤 수 없다
  if (ok && freshman && !$("freshmanDept").value) {
    ok = false;
    message = "1학년은 소속(학부 또는 자유전공학부)을 먼저 선택해 주세요.";
  }
  $("majorWarn").hidden = ok;
  $("majorWarn").textContent = message;

  // 꼭 넣을 과목끼리 반드시 겹치면 어떤 조합도 나올 수 없으므로 미리 알려 주고 버튼을 막는다
  const conflicts = conflictMessages();
  const liberalMessage = conflicts.liberal;
  $("liberalWarn").hidden = !liberalMessage;
  $("liberalWarn").textContent = liberalMessage;

  // 1학년은 교양필수를 꼭 듣는다. 안 고르면 교필 시간이 빠진 '실제와 다른' 시간표가 나오므로 고를 때마다 바로 알려 준다.
  // 학부마다 학기별로 듣는 과목이 달라 몇 개가 맞는지는 알 수 없으므로, 막지는 않고 경고만 한다
  const notice = liberalMissingNotice();
  $("liberalNotice").hidden = !notice;
  $("liberalNotice").textContent = notice;

  // 학부 소속 1학년은 다른 학부 전탐을 들을 수 없다. 예전에 담아 둔 과목이 있으면 빼도록 알려 주고 버튼을 막는다
  const cartMessage = [forbiddenCartMessage(), conflicts.cart].filter(Boolean).join(" ");
  $("cartWarn").hidden = !cartMessage;
  $("cartWarn").textContent = cartMessage;

  const ready = ok && !liberalMessage && !cartMessage;
  $("generate").disabled = !ready;
  // 전공 선택이 바뀌는 모든 곳에서 이 함수를 부르므로, 3단계 전공별 학점 줄도 여기서 맞춰 준다
  renderMajorCredits();
  return ready;
}

// ---------- 후보 풀 ----------
/**
 * 모든 결과에 꼭 들어갈 강좌 = 1학년 교양필수 고정 분반 + 담은 과목.
 * 같은 과목을 교양필수로도 고정하고 담기도 했다면, 학교 배정 분반인 교양필수 쪽을 따른다.
 */
function pickedSections() {
  const fixed = fixedLiberalSections();
  const fixedCodes = new Set(fixed.map((c) => c.code));
  const cart = state.cart.map((id) => state.byId.get(id)).filter((c) => !fixedCodes.has(c.code));
  return [...fixed, ...cart];
}

function currentPool() {
  const { myGrade } = readMajorInputs();
  return buildPool(state.courses, {
    // 주전공 + 복수전공·부전공 (1학년이면 관심 전공 학부의 전공탐색) 과목을 합쳐서 후보로 쓴다
    categories: chosenMajors().map((m) => m.category),
    myGrade,
    // 이수한 과목과 재수강 가능 과목은 자동으로 넣지 않는다 (직접 담은 과목은 picked로 그대로 들어간다)
    taken: autoFillExcludedCodes(state.taken),
    picked: pickedSections(),
  });
}

function renderPoolInfo() {
  const { mainMajor } = readMajorInputs();
  const majors = chosenMajors();
  const pool = currentPool();
  const codes = new Set(pool.map((c) => c.code));
  const counts = `후보 ${codes.size}과목 (분반 ${pool.length}개, 고정·담은 과목 포함)`;
  let text = "";
  if (isFreshman() && !$("freshmanDept").value) {
    text = ""; // 소속을 고르라는 안내가 이미 위에 떠 있다
  } else if (isFreshman() && mainMajor && !majors.length) {
    text = "이 전공은 소속 학부 정보가 없어 전공탐색 과목을 추천할 수 없습니다. 2단계에서 직접 담아 주세요.";
  } else if (isFreshman() && majors.length > 1) {
    text = `모든 학부의 전공탐색 과목으로 채웁니다. ${counts}`;
  } else if (isFreshman() && majors.length) {
    text = `${majors[0].category} 과목으로 채웁니다. ${counts}`;
  } else if (majors.length) {
    text = `자동 채우기 후보 ${codes.size}과목 (분반 ${pool.length}개, 담은 과목 포함)`;
  } else if (pool.length) {
    text = "전공을 고르지 않으면 담은 과목으로만 시간표를 짭니다.";
  }
  $("poolInfo").textContent = text;
}

// ---------- 검색 / 담기 ----------
/** 교수명이 비어 있는 강좌(개설강좌 PDF에서 교수 미정)는 빈칸 대신 '교수 미정'으로 보여 준다 */
function professorLabel(course) {
  return course.professor || "교수 미정";
}

function formatTimes(course) {
  if (!course.times.length) return "시간 미정";
  return course.times.map((t) => `${t.day} ${toHHMM(t.start)}~${toHHMM(t.end)}`).join(", ");
}

function badges(course) {
  let html = `<span class="badge">${escapeHTML(course.type)}</span>`;
  if (isTaken(course.code)) html += `<span class="badge taken">이수</span>`;
  if (isRetake(course.code)) html += `<span class="badge retake">재수강 가능</span>`;
  return html;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function renderSearch() {
  const q = $("search").value.trim().toLowerCase();
  const cat = $("category").value;
  const hideTaken = $("hideTaken").checked;
  const list = $("results");

  if (!q && !cat) {
    list.innerHTML = `<li class="empty">검색어를 입력하거나 영역을 고르세요.</li>`;
    return;
  }

  const matches = state.courses.filter(
    (c) =>
      (!cat || c.category === cat) &&
      (!q || `${c.name} ${c.code} ${c.professor}`.toLowerCase().includes(q)) &&
      !(hideTaken && isTaken(c.code))
  );

  list.innerHTML =
    matches
      .slice(0, MAX_SEARCH_RESULTS)
      .map((c) => {
        const inCart = state.cart.includes(c.id);
        // 학부 소속 1학년은 다른 학부 전탐을 들을 수 없으므로 담기 버튼을 잠근다
        const blocked = !inCart && isForbiddenForMe(c);
        const freeOnly = state.rules.freeMajorLiberalRequired.includes(c.code);
        const label = inCart ? "담음" : blocked ? (freeOnly ? "자유전공 전용" : "다른 학부") : "담기";
        return `<li>
          <div class="info">
            <strong>${escapeHTML(c.name)}</strong> <span class="muted">${escapeHTML(c.code)}-${escapeHTML(c.section)} · ${c.credit}학점 · ${escapeHTML(professorLabel(c))}</span>
            <div class="meta">${badges(c)} ${formatTimes(c)}</div>
          </div>
          <button type="button" data-add="${escapeHTML(c.id)}" ${inCart || blocked ? "disabled" : ""} ${blocked ? `title="소속 학부의 전공탐색만 들을 수 있습니다"` : ""}>${label}</button>
        </li>`;
      })
      .join("") ||
    `<li class="empty">검색 결과가 없습니다.</li>`;

  if (matches.length > MAX_SEARCH_RESULTS) {
    list.insertAdjacentHTML("beforeend", `<li class="empty">${matches.length - MAX_SEARCH_RESULTS}개 더 있습니다. 검색어를 좁혀 보세요.</li>`);
  }
}

function renderCart() {
  const courses = state.cart.map((id) => state.byId.get(id));
  const codes = new Map(courses.map((c) => [c.code, c.credit]));
  const credit = [...codes.values()].reduce((a, b) => a + b, 0);
  $("cartCount").textContent = courses.length ? `${codes.size}과목 · ${credit}학점` : "";

  $("cart").innerHTML =
    courses
      .map(
        (c) => `<li>
          <div class="info">
            <strong>${escapeHTML(c.name)}</strong> <span class="muted">${escapeHTML(c.code)}-${escapeHTML(c.section)} · ${c.credit}학점</span>
            <div class="meta">${badges(c)} ${formatTimes(c)}</div>
          </div>
          <button type="button" class="ghost" data-remove="${escapeHTML(c.id)}" aria-label="${escapeHTML(c.name)} 빼기">빼기</button>
        </li>`
      )
      .join("") || `<li class="empty">담은 과목이 없으면 전공 과목으로 채우고, 모자란 학점은 교양선택으로 채웁니다.</li>`;
}

// ---------- 조합 만들기 ----------
function onGenerate() {
  // 순위 기준을 바꿀 때도 여기로 오므로, 버튼이 막혀 있어도 한 번 더 검사한다
  if (!renderChecks()) {
    state.schedules = [];
    renderResult();
    renderStale();
    // 화면에 떠 있는 안내 중 첫 번째를 결과 자리에도 보여 준다
    const shown = ["majorWarn", "liberalWarn", "cartWarn"].map($).find((el) => !el.hidden);
    showStatus(shown?.textContent ?? "조건을 확인해 주세요.", true);
    return;
  }
  const cond = readConditions();
  saveConditions(); // 조건만 저장한다 (성적 값은 저장하지 않음)
  state.majorsUsed = chosenMajors();
  state.liberalUsed = fixedLiberalSections().map((c) => c.code);

  const pool = currentPool();
  if (!pool.length) {
    state.schedules = [];
    renderResult();
    showStatus("전공을 고르거나 꼭 넣을 과목을 담아 주세요.", true);
    return;
  }

  // 교양필수 고정 분반과 담은 과목은 모든 결과에 들어가야 한다
  const required = [...new Set(pickedSections().map((c) => c.code))];
  const t0 = performance.now();
  let result = generateSchedules(pool, {
    ...cond,
    required,
    topK: TOP_K,
  });

  // 전공(1학년은 전공탐색) 과목만으로 조합이 하나도 안 나오면 = 목표 학점을 못 채우면,
  // 교양선택 과목을 후보에 더해 다시 찾는다.
  // 순위: '전공 많이 넣는 순'을 골랐으면 전공 학점 > 공강, 그 밖에는 공강 > 전공 학점 (scoreSchedule의 'major' / 'fill').
  // 전공을 아예 안 골랐다면 '담은 과목으로만 짜기'를 고른 것이므로 교양을 마음대로 넣지 않는다.
  state.filled = false;
  if (!result.error && !result.schedules.length && chosenMajors().length) {
    const filler = buildFillerPool(state.courses, {
      types: state.rules.fillerTypes,
      myGrade: cond.myGrade,
      taken: autoFillExcludedCodes(state.taken), // 재수강 가능 교양도 자동으로 넣지 않는다
      excludeCodes: pool.map((c) => c.code),
    }).filter((c) => !isForbiddenForMe(c));
    const fillMode = cond.rankMode === "major" ? "major" : "fill";
    const filled = generateSchedules([...pool, ...filler], { ...cond, required, topK: TOP_K, rankMode: fillMode });
    if (filled.schedules.length) {
      result = filled;
      state.filled = true;
    }
  }
  const ms = Math.round(performance.now() - t0);

  state.schedules = result.schedules;
  state.page = 0;
  state.resultKey = inputKey();
  renderResult();
  renderStale();

  if (result.error) {
    showStatus(result.error, true);
  } else if (!state.schedules.length) {
    // 1학년은 교양필수 + 전공탐색만으로 학점을 채우는데, 학부에 따라 전탐이 몇 과목 안 돼서 학점이 모자라기 쉽다
    showStatus(
      isFreshman()
        ? `조건을 만족하는 조합이 없습니다. 1학년은 교양필수와 전공탐색만으로 학점을 채우므로, ${liberalMissingNotice() ? "교양필수 분반을 고르거나 " : ""}최소 학점을 낮춰 보세요.`
        : "조건을 만족하는 조합이 없습니다. 학점 범위나 공강 조건을 풀어 보세요.",
      true
    );
  } else {
    // 상위 20개가 다 찼으면 가지치기로 나머지를 건너뛰었으므로 '전체 개수'는 알 수 없다
    const head = state.schedules.length < TOP_K
      ? `조건에 맞는 조합 ${state.schedules.length}개`
      : `조건에 맞는 조합 중 상위 ${TOP_K}개 (끝까지 비교한 조합 ${result.total.toLocaleString()}개)`;
    // 1학년이 교양필수를 안 고르고 만들었다면 결과 옆에도 한 번 더 알려 준다
    const notice = liberalMissingNotice();
    // 교양으로 채웠다면 어떤 순서로 골랐는지 알려 준다 ('전공 많이 넣는 순'이 아니면 공강 우선)
    const fillOrder = cond.rankMode === "major" ? "전공 학점 많은 순 → 공강 많은 순" : "공강 많은 순 → 전공 학점 많은 순";
    const fillNote = state.filled
      ? ` · ${isFreshman() ? "교양필수·전공탐색" : "전공"} 과목만으로는 최소 학점(${cond.minCredit})을 채울 수 없어 교양선택으로 채웠습니다 (${fillOrder})`
      : "";
    // 조합 수 상한에 걸려 탐색을 끝까지 못 했다면, 진짜 상위 20개가 아닐 수 있으므로 알려 준다
    const truncNote = result.truncated
      ? " · 비교할 조합이 너무 많아 일부만 비교했습니다. 학점 범위나 공강 조건을 좁히면 더 정확해집니다."
      : "";
    const warn = notice || result.truncated;
    showStatus(
      `${head} · ${ms}ms${fillNote}${truncNote}` + (notice ? ` · 주의: 교양필수를 고르지 않아 실제 시간표와 다를 수 있습니다.` : ""),
      warn ? "warn" : false
    );
  }
}

/** 결과 상태 문구. kind: true/"error" = 오류(빨강), "warn" = 주의(주황), 그 밖 = 보통 */
function showStatus(msg, kind = false) {
  $("resultStatus").textContent = msg;
  const cls = kind === true || kind === "error" ? " error" : kind === "warn" ? " warn" : "";
  $("resultStatus").className = `status${cls}`;
}

function movePage(delta) {
  if (!state.schedules.length) return;
  state.page = (state.page + delta + state.schedules.length) % state.schedules.length;
  renderResult();
}

/** 결과 요약에서 어느 영역 과목인지 [주전공] / [복수전공] / [부전공] / [전공탐색] / [교양필수] 배지로 보여 준다 */
function majorBadge(course) {
  if (state.liberalUsed.includes(course.code)) return `<span class="badge major">교양필수</span>`;
  if (course.filler) return `<span class="badge major">교양</span>`; // 학점이 모자라 교양으로 채운 과목
  const major = state.majorsUsed.find((m) => m.category === course.category);
  return major ? `<span class="badge major">${escapeHTML(major.role)}</span>` : ""; // 다른 영역에서 담은 과목은 배지 없음
}

// ---------- 이번 학기 공휴일 ----------

// 다시 시도를 여러 번 눌러 요청이 겹치면, 늦게 도착한 '예전' 응답이 새 결과를 덮지 않게 번호를 매긴다
let holidayRequest = 0;

/** 학기 기간(data/semester.json)을 읽고 그 기간의 공휴일을 받아 온다. 실패해도 화면에 안내만 한다 */
async function loadHolidays() {
  const request = ++holidayRequest;
  state.holidays = { ...state.holidays, status: "loading" };
  renderHolidays();
  try {
    // 학기 날짜는 코드에 적지 않고 파일에서 읽는다. 학기가 바뀌면 semester.json만 고치면 된다
    const res = await fetch("data/semester.json");
    if (!res.ok) throw new Error(`semester.json ${res.status}`);
    const semester = await res.json();
    if (typeof semester.start !== "string" || typeof semester.end !== "string") throw new Error("semester.json에 start/end가 없습니다");
    const list = await fetchSemesterHolidays(semester);
    if (request !== holidayRequest) return;
    state.holidays = { status: "ok", list, semester };
  } catch (err) {
    if (request !== holidayRequest) return;
    state.holidays = { ...state.holidays, status: "error" };
    // 화면에 이미 실패 안내가 뜨므로 콘솔에는 이유만 조용히(info) 남긴다
    console.info("공휴일을 불러오지 못했습니다:", err.message);
  }
  renderHolidays();
}

/** "2026-08-31" → "8/31" */
const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/**
 * 공휴일 목록을 그린다. 지금 보고 있는 순위의 시간표 기준으로 그날 수업이 있는 과목을 붙인다.
 * 휴강인지 온라인 수업인지는 학교·과목마다 달라 단정하지 않는다.
 * 1위~20위를 넘길 때마다 renderResult가 이 함수를 다시 부른다.
 */
function renderHolidays() {
  const { status, list, semester } = state.holidays;
  const statusEl = $("holidayStatus");
  $("holidayRetry").hidden = status !== "error";
  $("holidayPeriod").textContent = semester ? `(${semester.name}학기 · ${shortDate(semester.start)}~${shortDate(semester.end)})` : "";

  if (status !== "ok") {
    $("holidayList").innerHTML = "";
    statusEl.textContent = status === "loading" ? "공휴일 불러오는 중…" : "공휴일 정보를 불러오지 못했습니다";
    statusEl.className = status === "loading" ? "status" : "status warn";
    return;
  }

  const schedule = state.schedules[state.page]; // 아직 시간표를 안 만들었으면 undefined
  statusEl.className = "status";
  statusEl.textContent = !list.length
    ? "이번 학기에는 공휴일이 없습니다."
    : schedule ? "휴강·온라인 수업 여부는 학교나 교수님 공지를 확인하세요." : "시간표를 만들면 공휴일과 겹치는 수업을 알려 드려요.";

  $("holidayList").innerHTML = list
    .map((h) => {
      const date = `<span class="date">${escapeHTML(formatHoliday(h))}</span>`;
      if (!schedule) return `<li>${date}</li>`;
      const names = affectedCourses(h, schedule).map((c) => escapeHTML(c.name));
      return names.length
        ? `<li>${date} — <span class="off">${names.join(", ")}</span></li>`
        : `<li class="none">${date} — 수업 없음</li>`;
    })
    .join("");
}

// ---------- 시간표 격자 ----------
const COLORS = 8;

function renderResult() {
  renderHolidays(); // 결과가 바뀌거나 순위를 넘기면 공휴일 수업 목록도 그 시간표 기준으로 바뀐다
  const grid = $("grid");
  const has = state.schedules.length > 0;
  grid.hidden = !has;
  $("pager").hidden = !has;
  $("summary").innerHTML = "";
  if (!has) return;

  const schedule = state.schedules[state.page];
  const pickedCodes = new Set(state.cart.map((id) => state.byId.get(id).code));
  // 전공별 학점을 같이 보여 주면 3단계에서 정한 전공별 학점이 지켜졌는지 바로 확인할 수 있다
  const creditIn = (cat) => totalCredit(schedule.filter((c) => c.category === cat));
  // 같은 역할(예: 자유전공학부의 여러 학부 전탐)은 한 번에 더해서 '전공탐색 9'처럼 보여 준다
  const byRole = new Map();
  for (const m of state.majorsUsed) byRole.set(m.role, (byRole.get(m.role) ?? 0) + creditIn(m.category));
  // 교양으로 채운 학점도 같이 보여 준다
  const fillerCredit = totalCredit(schedule.filter((c) => c.filler));
  if (fillerCredit) byRole.set("교양", fillerCredit);
  const perMajor = [...byRole].map(([role, credit]) => `${role} ${credit}`);
  $("pageInfo").textContent =
    // '1위 / 15'는 15가 무엇인지 헷갈려서 '1위 / 15위'처럼 양쪽에 '위'를 붙인다
    `${state.page + 1}위 / ${state.schedules.length}위 · ${totalCredit(schedule)}학점` +
    (perMajor.length ? ` (${perMajor.join(" · ")})` : "") +
    ` · 공강 ${countFreeWeekdays(schedule)}일`;

  const slots = schedule.flatMap((c, i) => c.times.map((t) => ({ ...t, course: c, color: i % COLORS })));
  const days = slots.some((s) => s.day === "토") ? DAYS : DAYS.slice(0, 5);
  const dayStart = Math.min(9 * 60, ...slots.map((s) => Math.floor(s.start / 60) * 60));
  const dayEnd = Math.max(18 * 60, ...slots.map((s) => Math.ceil(s.end / 60) * 60));
  const hours = (dayEnd - dayStart) / 60;

  grid.style.setProperty("--days", days.length);
  grid.style.setProperty("--hours", hours);

  let html = `<div class="corner"></div>` + days.map((d) => `<div class="day-head">${d}</div>`).join("");
  html += `<div class="hours">${Array.from({ length: hours }, (_, i) => `<div>${dayStart / 60 + i}</div>`).join("")}</div>`;
  for (const day of days) {
    html += `<div class="day-col">`;
    for (const s of slots.filter((x) => x.day === day)) {
      const top = ((s.start - dayStart) / (dayEnd - dayStart)) * 100;
      const height = ((s.end - s.start) / (dayEnd - dayStart)) * 100;
      html += `<div class="block c${s.color}" style="top:${top}%;height:${height}%" title="${escapeHTML(s.course.name)} ${toHHMM(s.start)}~${toHHMM(s.end)}">
        <strong>${escapeHTML(s.course.name)}</strong><span>${escapeHTML(s.room ?? "")} · ${toHHMM(s.start)}</span></div>`;
    }
    html += `</div>`;
  }
  grid.innerHTML = html;

  $("summary").innerHTML = schedule
    .map(
      (c, i) => `<li><span class="dot c${i % COLORS}"></span>${escapeHTML(c.name)}
        ${majorBadge(c)}
        ${pickedCodes.has(c.code) ? `<span class="badge retake">담은 과목</span>` : ""}
        <span class="muted">${escapeHTML(c.code)}-${escapeHTML(c.section)} · ${escapeHTML(c.type)} · ${c.credit}학점 · ${escapeHTML(professorLabel(c))}${c.times.length ? "" : " · 시간 미정"}</span></li>`
    )
    .join("");
}

init();
