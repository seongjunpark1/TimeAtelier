// 화면 점검: 실제 Chrome을 headless로 띄워 index.html을 사람이 쓰듯 조작하고 결과를 확인한다.
// 실행: npm run test:ui   (Node.js 22 이상 + Chrome 또는 Edge 필요, 설치할 패키지 없음)
//
// 왜 따로 두었나: app.js(화면 로직)는 브라우저가 있어야 돌아가서 npm test(node:test)로는 검사할 수 없다.
// 브라우저를 띄우는 데 몇 초 걸리므로 npm test에는 넣지 않고, 화면을 고친 뒤에 이 점검을 따로 돌린다.
// Chrome이 없거나 Node가 오래돼 WebSocket이 없으면 '실패'가 아니라 '건너뜀'으로 표시한다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------- 준비물 찾기 ----------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => p && existsSync(p));
}
const CHROME = findChrome();
const SKIP = !CHROME
  ? "Chrome/Edge를 찾지 못했습니다 (CHROME_PATH 환경 변수로 경로를 알려 줄 수 있습니다)"
  : typeof WebSocket === "undefined"
    ? "Node.js 22 이상이 필요합니다 (내장 WebSocket 사용)"
    : false;

// ---------- 정적 파일 서버 (fetch로 JSON을 읽으므로 file://로는 열 수 없다) ----------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
function startServer() {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.normalize(path.join(ROOT, urlPath === "/" ? "index.html" : urlPath));
    // 프로젝트 폴더 밖의 파일은 주지 않는다
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": `${TYPES[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- Chrome 조작 (DevTools 프로토콜) ----------
let server, chrome, profileDir, ws, URL_;
let msgId = 0;
const pending = new Map();
const logs = []; // 콘솔 오류·경고와 잡히지 않은 예외

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 페이지 안에서 식을 실행하고 값을 돌려받는다. 페이지에서 예외가 나면 테스트도 실패한다 */
async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`페이지 오류: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 공휴일 API 가로채기 ----------
// 화면 점검이 인터넷 상태에 따라 달라지지 않게, 공휴일 요청은 Chrome이 실제로 보내기 전에 가로채서 대신 답한다.
//   "fixture": 저장해 둔 실제 응답(tests/fixtures/holidays_2026_KR.json)으로 답한다 (기본)
//   "fail":    요청을 차단한다 (네트워크 오류와 같다)
//   "hang":    답하지 않고 붙잡아 둔다 (아주 느린 서버)
let holidayMode = "fixture";
const hungRequests = [];
const holidayBody = readFileSync(path.join(ROOT, "tests/fixtures/holidays_2026_KR.json")).toString("base64");
function answerHolidayRequest({ requestId }) {
  if (holidayMode === "fail") {
    send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
  } else if (holidayMode === "hang") {
    hungRequests.push(requestId);
  } else {
    send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      // 실제 서버처럼 CORS 허용 헤더를 붙여야 다른 주소(우리 페이지)에서 읽을 수 있다
      responseHeaders: [
        { name: "Content-Type", value: "application/json; charset=utf-8" },
        { name: "Access-Control-Allow-Origin", value: "*" },
      ],
      body: holidayBody,
    });
  }
}

/** 공휴일 영역이 '불러오는 중'을 벗어날 때까지 기다린다 */
async function waitHolidays() {
  for (let i = 0; i < 100; i++) {
    if ((await ev(`$t("holidayStatus").textContent`)) !== "공휴일 불러오는 중…") return;
    await sleep(50);
  }
  throw new Error("공휴일 영역이 5초 안에 '불러오는 중'을 벗어나지 않았습니다");
}

// 페이지 안에서 쓸 도우미: select 값 바꾸기(+change 이벤트), 실제로 화면에 보이는지 등
const HELPERS = `
  window.$t = (id) => document.getElementById(id);
  window.setSel = (id, v) => { const el = $t(id); el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; };
  window.setVal = (id, v) => { const el = $t(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; };
  window.radio = (v) => { document.querySelector('input[name="secondType"][value="' + v + '"]').click(); return true; };
  window.visible = (id) => $t(id).getClientRects().length > 0; // hidden 속성이 아니라 실제로 그려졌는지
  window.pickLib = (code, id) => { const s = document.querySelector('#liberalList select[data-code="' + code + '"]'); s.value = id; s.dispatchEvent(new Event("change", { bubbles: true })); return s.value; };
  window.addToCart = (id) => { $t("category").value = ""; $t("search").value = id.split("-")[0]; $t("search").dispatchEvent(new Event("input")); const b = document.querySelector('#results button[data-add="' + id + '"]'); if (!b || b.disabled) return false; b.click(); $t("search").value = ""; $t("search").dispatchEvent(new Event("input")); return true; };
  window.allPages = () => { const out = []; for (let p = 0; p < 20 && !$t("pager").hidden; p++) { out.push({ info: $t("pageInfo").textContent, badges: [...document.querySelectorAll("#summary .badge.major")].map((b) => b.textContent), text: $t("summary").textContent }); $t("next").click(); } return out; };
  true;
`;

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    if (await ev(`document.getElementById("mainMajor")?.options.length > 5`)) break;
    await sleep(50);
  }
  await ev(HELPERS);
}

/** 저장값을 모두 지운 새 상태로 페이지를 연다 */
async function fresh() {
  await send("Page.navigate", { url: URL_ });
  await sleep(200);
  await ev("localStorage.clear(); true");
  await reload();
}

async function reload() {
  await send("Page.navigate", { url: URL_ });
  await sleep(200);
  await waitReady();
}

before(async () => {
  if (SKIP) return;
  server = await startServer();
  URL_ = `http://127.0.0.1:${server.address().port}/index.html`;
  profileDir = mkdtempSync(path.join(tmpdir(), "timetable-ui-"));
  chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,1400",
    "about:blank",
  ]);
  // Chrome이 고른 포트는 프로필 폴더의 DevToolsActivePort 파일 첫 줄에 적힌다.
  // (시작 메시지를 stderr로 읽는 방법은 Windows에서 메시지가 안 나오는 경우가 있어 파일을 쓴다)
  const portFile = path.join(profileDir, "DevToolsActivePort");
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    if (existsSync(portFile)) port = readFileSync(portFile, "utf-8").split("\n")[0].trim();
    if (!port) await sleep(100);
  }
  if (!port) throw new Error("Chrome이 15초 안에 시작되지 않았습니다");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m.result ?? {});
      pending.delete(m.id);
    }
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
    if (m.method === "Fetch.requestPaused") answerHolidayRequest(m.params);
    if (m.method === "Runtime.exceptionThrown") logs.push(`exception: ${m.params.exceptionDetails.exception?.description}`);
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://date.nager.at/*" }] });
});

after(() => {
  ws?.close();
  chrome?.kill();
  server?.close();
  try {
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* Chrome이 아직 파일을 쥐고 있으면 임시 폴더는 OS가 나중에 정리한다 */
  }
});

// 테스트에 쓸 실제 강좌 id (데이터가 바뀌면 여기만 고친다)
const { courses } = JSON.parse(readFileSync(path.join(ROOT, "data/courses.json"), "utf-8"));
const overlaps = (a, b) => a.times.some((x) => b.times.some((y) => x.day === y.day && x.start < y.end && y.start < x.end));
const jsCourse = courses.find((c) => c.id === "IS00001-01");
const clashing = courses.find((c) => c.code !== jsCourse.code && c.times.length && overlaps(c, jsCourse));
const SW_DEPT = "전공탐색 – 소프트웨어융합학부(IT융합자율학부)";
const MEDIA_DEPT = "전공탐색 – 미디어콘텐츠융합학부(미디어콘텐츠융합자율학부)";

// ---------- 점검 항목 ----------
test("화면 점검", { skip: SKIP }, async (t) => {
  await t.test("2학년 + 다른 전공만: 복수전공·부전공 안내가 뜨고 만들기 버튼이 잠긴다", async () => {
    await fresh();
    await ev(`setSel("myGrade","2"); setSel("mainMajor","사회학전공")`);
    assert.equal(await ev(`visible("majorWarn")`), true);
    assert.match(await ev(`$t("majorWarn").textContent`), /2학년부터는 복수전공 또는 부전공/);
    assert.equal(await ev(`$t("generate").disabled`), true);
  });

  await t.test("2학년 + 소프트웨어융합전공(심화): '선택 안 함 (심화전공)'이 보이고 바로 만들 수 있다", async () => {
    await ev(`setSel("mainMajor","소프트웨어융합전공")`);
    assert.equal(await ev(`$t("secondMajor").options[0].textContent`), "선택 안 함 (심화전공)");
    assert.equal(await ev(`$t("generate").disabled`), false);
    await ev(`$t("generate").click()`);
    assert.match(await ev(`$t("resultStatus").textContent`), /상위 20개/);
  });

  await t.test("심화전공(두 번째 전공 없음): 이수 방식 버튼이 잠기고 심화전공 안내가 뜬다, 전공을 고르면 다시 켜진다", async () => {
    await ev(`setSel("mainMajor","소프트웨어융합전공"); setSel("secondMajor","")`);
    assert.equal(await ev(`[...document.querySelectorAll('input[name="secondType"]')].every(r => r.disabled)`), true);
    assert.equal(await ev(`$t("secondArea").classList.contains("no-second")`), true);
    assert.equal(await ev(`visible("secondHint")`), true);
    assert.match(await ev(`$t("secondHint").textContent`), /심화전공/);
    await ev(`setSel("secondMajor","신문방송학전공")`);
    assert.equal(await ev(`[...document.querySelectorAll('input[name="secondType"]')].some(r => r.disabled)`), false);
    assert.equal(await ev(`visible("secondHint")`), false);
    await ev(`setSel("secondMajor","")`);
  });

  await t.test("2학년 이상 주전공 목록에는 전공만 있다 (전공탐색·교양 영역은 고를 수 없음)", async () => {
    const groups = await ev(`[...$t("mainMajor").querySelectorAll("optgroup")].filter(g => !g.disabled).map(g => g.label)`);
    assert.deepEqual(groups, ["전공"]);
  });

  await t.test("복수전공 → 부전공 전환: 결과 배지가 바로 바뀌고 '조건 바뀜' 안내는 뜨지 않는다", async () => {
    await ev(`setSel("myGrade","3"); setSel("mainMajor","신문방송학전공"); setSel("secondMajor","소프트웨어융합전공"); radio("복수전공")`);
    await ev(`$t("generate").click()`);
    const pages = await ev(`allPages()`);
    const idx = pages.findIndex((p) => p.badges.includes("복수전공"));
    assert.ok(idx >= 0, "복수전공 과목이 들어간 조합이 없음");
    await ev(`for (let i = 0; i < ${idx}; i++) $t("next").click(); true`);
    await ev(`radio("부전공")`);
    const badges = await ev(`[...document.querySelectorAll("#summary .badge.major")].map(b => b.textContent)`);
    assert.ok(badges.includes("부전공") && !badges.includes("복수전공"));
    assert.equal(await ev(`visible("staleNotice")`), false);
  });

  await t.test("전공별 학점: 20개 조합 모두 정한 범위를 지킨다", async () => {
    await ev(`radio("복수전공")`);
    const typeIn = (cat, bound, v) =>
      `(() => { const el = document.querySelector('#majorCredits input[data-cat="${cat}"][data-bound="${bound}"]'); el.value = "${v}"; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
    await ev(typeIn("신문방송학전공", "min", 9));
    await ev(typeIn("신문방송학전공", "max", 12));
    await ev(typeIn("소프트웨어융합전공", "min", 6));
    await ev(`$t("generate").click()`);
    const pages = await ev(`allPages()`);
    assert.equal(pages.length, 20);
    assert.match(pages[0].info, /^1위 \/ 20위 · /); // 'N위 / 전체위' 형식
    for (const p of pages) {
      const m = p.info.match(/주전공 (\d+) · 복수전공 (\d+)/);
      assert.ok(m && +m[1] >= 9 && +m[1] <= 12 && +m[2] >= 6, p.info);
    }
  });

  await t.test("결과를 만든 뒤 조건을 바꾸면 '조건이 바뀌었습니다'가 뜨고, 다시 만들면 사라진다", async () => {
    assert.equal(await ev(`visible("staleNotice")`), false);
    await ev(`setVal("minCredit", "16")`);
    assert.equal(await ev(`visible("staleNotice")`), true);
    await ev(`$t("generate").click()`);
    assert.equal(await ev(`visible("staleNotice")`), false);
  });

  await t.test("학점 칸에 24를 넘게 입력하면 24로 고쳐진다", async () => {
    await ev(`setVal("maxCredit", "30")`);
    assert.equal(await ev(`$t("maxCredit").value`), "24");
  });

  await t.test("조건은 '만들기'를 누르지 않아도 바로 저장된다 (새로고침 후 유지)", async () => {
    await fresh();
    await ev(`setSel("myGrade","1"); setSel("freshmanDept","자유전공학부"); setVal("minCredit","14")`);
    await reload();
    assert.equal(await ev(`$t("myGrade").value`), "1");
    assert.equal(await ev(`$t("freshmanDept").value`), "자유전공학부");
    assert.equal(await ev(`$t("minCredit").value`), "14");
  });

  await t.test("1학년: 복수전공·부전공 칸이 실제로 안 보이고, 소속을 고르기 전에는 만들 수 없다", async () => {
    await fresh();
    await ev(`setSel("myGrade","1")`);
    assert.equal(await ev(`visible("secondArea")`), false);
    assert.equal(await ev(`visible("deptField")`), true);
    assert.match(await ev(`$t("majorWarn").textContent`), /소속/);
    assert.equal(await ev(`$t("generate").disabled`), true);
  });

  await t.test("1학년이 교양필수를 안 고르면 경고가 바로 뜨고, 하나 고르면 사라진다", async () => {
    assert.equal(await ev(`visible("liberalNotice")`), true);
    await ev(`pickLib("AC00013","AC00013-05")`);
    assert.equal(await ev(`visible("liberalNotice")`), false);
  });

  await t.test("교양필수끼리 반드시 겹치면(인권과평화+디지털리터러시) 안내가 뜨고 버튼이 잠긴다", async () => {
    await ev(`setSel("freshmanDept","자유전공학부")`);
    await ev(`pickLib("AC00007","AC00007-01"); pickLib("AK00179","AK00179-01")`);
    assert.match(await ev(`$t("liberalWarn").textContent`), /겹칩니다/);
    assert.equal(await ev(`$t("generate").disabled`), true);
    await ev(`pickLib("AC00007",""); pickLib("AK00179","")`);
    assert.equal(await ev(`$t("generate").disabled`), false);
  });

  await t.test("교수명을 직접 채운 강좌(공동 강의 등)는 이름이 보인다 ('Y' 같은 글자 아님)", async () => {
    const options = await ev(`[...document.querySelector('#liberalList select[data-code="AC00016"]').options].map(o => o.textContent)`);
    assert.ok(options.some((o) => o.startsWith("03 · 김명철, 신익상 ·")), options.join(" | "));
    assert.ok(options.some((o) => o.startsWith("05 · 신익상, 김명철 ·")), options.join(" | "));
    assert.ok(!options.some((o) => / · [YN] · /.test(o)));
    // 예전에 교수명이 'Y'로 들어가 있던 기초일본어
    await ev(`$t("category").value = ""; $t("search").value = "AD00003"; $t("search").dispatchEvent(new Event("input")); true`);
    assert.match(await ev(`$t("results").textContent`), /요코야마나호코/);
    await ev(`$t("search").value = ""; $t("search").dispatchEvent(new Event("input")); true`);
  });

  await t.test("자유전공팀세미나는 자유전공학부일 때만 교필 목록에 나온다", async () => {
    const names = () => ev(`[...document.querySelectorAll("#liberalList .liberal-row .name")].map(n => n.firstChild.textContent.trim())`);
    assert.ok((await names()).includes("자유전공팀세미나"));
    await ev(`setSel("freshmanDept", ${JSON.stringify(SW_DEPT)})`);
    assert.ok(!(await names()).includes("자유전공팀세미나"));
  });

  await t.test("학부 소속 1학년은 다른 학부 전탐을 담을 수 없다", async () => {
    await ev(`$t("search").value = ""; setSel("category", ${JSON.stringify(MEDIA_DEPT)})`);
    const labels = await ev(`[...document.querySelectorAll("#results button[data-add]")].map(b => b.textContent + (b.disabled ? "(잠김)" : ""))`);
    assert.ok(labels.length > 0 && labels.every((l) => l === "다른 학부(잠김)"), labels.join(","));
  });

  await t.test("전탐만으로 학점이 모자라면 교양으로 채우고, '전공 많이 넣는 순'이면 전탐을 더 넣는다", async () => {
    await ev(`pickLib("AC00016","AC00016-02"); pickLib("AK00183","AK00183-04"); setVal("minCredit","15"); setVal("maxCredit","18"); setSel("sort","free")`);
    await ev(`$t("generate").click()`);
    assert.match(await ev(`$t("resultStatus").textContent`), /교양선택으로 채웠습니다/);
    const pages = await ev(`allPages()`);
    assert.ok(pages.every((p) => p.badges.includes("교양") && p.badges.filter((b) => b === "교양필수").length === 3));
    await ev(`setSel("sort","major")`); // 순위 기준을 바꾸면 바로 다시 계산한다
    assert.match(await ev(`$t("pageInfo").textContent`), /전공탐색 9/);
  });

  await t.test("담은 과목끼리 반드시 겹치면 이유를 알려 주고 버튼이 잠긴다", async () => {
    await fresh();
    await ev(`setSel("myGrade","3"); setSel("mainMajor","소프트웨어융합전공")`);
    assert.equal(await ev(`addToCart(${JSON.stringify(jsCourse.id)})`), true);
    assert.equal(await ev(`addToCart(${JSON.stringify(clashing.id)})`), true);
    assert.match(await ev(`$t("cartWarn").textContent`), /겹칩니다/);
    assert.equal(await ev(`$t("generate").disabled`), true);
  });

  await t.test("시간 미정 과목(인턴십)은 자동 채우기로 들어가지 않는다", async () => {
    await fresh();
    // 4학년 단독 전공은 복수전공이 필요해 버튼이 잠기므로, 규칙 검사가 없는 '학년 상관없음'으로 같은 과목들을 띄운다
    await ev(`setSel("myGrade","0"); setSel("mainMajor","인공지능전공"); setVal("minCredit","3")`);
    assert.equal(await ev(`$t("generate").disabled`), false);
    await ev(`$t("generate").click()`);
    const pages = await ev(`allPages()`);
    assert.ok(pages.length > 0);
    assert.ok(pages.every((p) => !p.text.includes("시간 미정")));
  });

  await t.test("재수강 과목: 자동으로 안 들어가고, 검색 목록에는 '재수강 가능'으로 보이며, 담으면 모든 결과에 들어간다", async () => {
    await fresh();
    await ev(`setSel("myGrade","3"); setSel("mainMajor","소프트웨어융합전공"); $t("generate").click(); true`);
    // 원래 1위 조합에 들어가던 과목을 재수강 과목으로 쓴다 (원래 안 나오는 과목이면 '0번'이 의미가 없다)
    const id = await ev(`document.querySelector("#summary li .muted").textContent.split(" · ")[0].trim()`);
    const code = id.split("-")[0];
    await ev(`localStorage.setItem("timetable-maker:taken", JSON.stringify({ taken: [], retake: [${JSON.stringify(code)}] })); true`);
    await reload();
    await ev(`$t("generate").click()`);
    const pages = await ev(`allPages()`);
    assert.ok(pages.length > 0);
    assert.ok(pages.every((p) => !p.text.includes(code)), `${code}가 자동으로 들어감`);
    // '이수한 과목 숨기기'가 켜져 있어도 재수강 과목은 보이고 담을 수 있다
    assert.equal(await ev(`$t("hideTaken").checked`), true);
    await ev(`$t("category").value = ""; $t("search").value = ${JSON.stringify(code)}; $t("search").dispatchEvent(new Event("input")); true`);
    assert.match(await ev(`$t("results").textContent`), /재수강 가능/);
    assert.equal(await ev(`addToCart(${JSON.stringify(id)})`), true);
    await ev(`$t("generate").click()`);
    const withRetake = await ev(`allPages()`);
    assert.ok(withRetake.length > 0 && withRetake.every((p) => p.text.includes(id)), "담은 재수강 과목이 빠진 결과가 있음");
  });

  await t.test("저장값이 손상돼도 앱이 멈추지 않는다", async () => {
    await ev(`localStorage.setItem("timetable-maker:cart", '{"x":1}'); localStorage.setItem("timetable-maker:conditions", '"oops"'); localStorage.setItem("timetable-maker:taken", "[1,2]"); true`);
    const logStart = logs.length;
    await reload();
    assert.deepEqual(logs.slice(logStart), []);
    assert.equal(await ev(`$t("myGrade").value`), "0");
    assert.match(await ev(`$t("takenStatus").textContent`), /불러온 이수 과목이 없습니다/);
  });

  await t.test("파일 초기화는 이수 과목만, 전체 초기화는 모든 저장값을 지운다 (취소하면 그대로)", async () => {
    await ev(`localStorage.setItem("다른앱:설정", "남아야 함"); localStorage.setItem("timetable-maker:taken", JSON.stringify({ taken: ["AC00007"], retake: [] })); true`);
    await reload();
    await ev(`setSel("myGrade","2")`);
    assert.equal(await ev(`$t("clearTaken").textContent`), "파일 초기화");
    await ev(`$t("clearTaken").click()`);
    assert.equal(await ev(`localStorage.getItem("timetable-maker:taken")`), null);
    assert.equal(await ev(`$t("myGrade").value`), "2");
    await ev(`window.confirm = () => false; $t("resetAll").click(); true`);
    assert.equal(await ev(`$t("myGrade").value`), "2");
    await ev(`window.confirm = () => true; $t("resetAll").click(); true`);
    await sleep(300);
    await waitReady();
    assert.equal(await ev(`$t("myGrade").value`), "0");
    // 다시 열린 페이지가 공휴일을 새로 받아 캐시(holidays-연도)에 저장할 수 있으므로 그것만 빼고 비교한다
    const keys = await ev(`Object.keys(localStorage).filter(k => !k.startsWith("timetable-maker:holidays-"))`);
    assert.deepEqual(keys, ["다른앱:설정"]);
  });

  await t.test("공휴일 영역: 결과 아래에 보이고, 1위~20위를 넘길 때마다 그 시간표의 목요일 수업이 9/24 추석 수업으로 나온다", async () => {
    holidayMode = "fixture";
    await fresh();
    await waitHolidays();
    assert.equal(await ev(`visible("holidayArea")`), true);
    assert.deepEqual(
      await ev(`[...$t("holidayList").children].map(li => li.textContent)`),
      ["9월 24일(목) 추석", "9월 25일(금) 추석", "9월 26일(토) 추석", "10월 5일(월) 개천절 대체휴일", "10월 9일(금) 한글날"]
    );
    assert.match(await ev(`$t("holidayArea").textContent`), /공휴일 정보: Nager\.Date/);

    await ev(`setSel("myGrade","3"); setSel("mainMajor","소프트웨어융합전공"); $t("generate").click(); true`);
    // 결과 시간표(격자·과목 목록)보다 아래에 있어야 한다
    assert.equal(await ev(`$t("holidayArea").getBoundingClientRect().top >= $t("summary").getBoundingClientRect().bottom`), true);
    // 각 순위마다: 격자의 '목' 열에 있는 과목 = 9/24(목) 줄에 적힌 과목
    const pages = await ev(`(() => {
      const out = [];
      for (let p = 0; p < 20; p++) {
        const heads = [...document.querySelectorAll("#grid .day-head")].map(d => d.textContent);
        const col = document.querySelectorAll("#grid .day-col")[heads.indexOf("목")];
        const thu = [...new Set([...col.querySelectorAll(".block strong")].map(b => b.textContent))].sort();
        const items = [...$t("holidayList").children];
        const first = items[0];
        const listed = first.classList.contains("none") ? [] : first.querySelector(".off").textContent.split(", ").sort();
        out.push({ thu, listed, text: first.textContent, all: items.map(li => li.textContent) });
        $t("next").click();
      }
      return out;
    })()`);
    // 목요일 수업이 하나도 없는 결과뿐이면 이 검사가 의미 없으므로 확인해 둔다
    assert.ok(pages.some((p) => p.thu.length > 0), "목요일 수업이 있는 순위가 없음");
    for (const p of pages) {
      assert.deepEqual(p.listed, p.thu, p.text);
      assert.ok(p.all.every((x) => /— .+$/.test(x)), p.all.join(" | "));
    }
    // 수업이 없는 토요일 공휴일(9/26)은 '수업 없음'으로 흐리게 표시된다
    assert.match(pages[0].all[2], /9월 26일\(토\) 추석 — 수업 없음/);
    assert.equal(await ev(`$t("holidayList").children[2].className`), "none");
  });

  await t.test("공휴일 요청이 차단돼도 시간표는 정상으로 만들어지고, 실패 안내와 [다시 시도]가 보인다", async () => {
    holidayMode = "fail";
    await fresh(); // 저장값(공휴일 캐시 포함)을 지웠으므로 다시 요청하다 차단된다
    await waitHolidays();
    assert.equal(await ev(`$t("holidayStatus").textContent`), "공휴일 정보를 불러오지 못했습니다");
    assert.equal(await ev(`visible("holidayRetry")`), true);
    await ev(`setSel("myGrade","3"); setSel("mainMajor","소프트웨어융합전공"); $t("generate").click(); true`);
    assert.match(await ev(`$t("resultStatus").textContent`), /상위 20개/);
    assert.equal(await ev(`visible("grid")`), true);
    // 결과를 넘겨도 실패 안내는 그대로이고 오류가 나지 않는다
    await ev(`$t("next").click(); true`);
    assert.equal(await ev(`$t("holidayStatus").textContent`), "공휴일 정보를 불러오지 못했습니다");

    // 다시 시도하면(이번엔 성공) 지금 시간표 기준 목록이 나온다
    holidayMode = "fixture";
    await ev(`$t("holidayRetry").click(); true`);
    await waitHolidays();
    assert.equal(await ev(`visible("holidayRetry")`), false);
    assert.equal(await ev(`$t("holidayList").children.length`), 5);
    assert.match(await ev(`$t("holidayList").textContent`), / — /);
  });

  await t.test("공휴일 서버가 답하지 않아도(느림) '불러오는 중…'만 보이고 시간표는 바로 만들어진다", async () => {
    holidayMode = "hang";
    await fresh();
    assert.equal(await ev(`$t("holidayStatus").textContent`), "공휴일 불러오는 중…");
    await ev(`setSel("myGrade","3"); setSel("mainMajor","소프트웨어융합전공"); $t("generate").click(); true`);
    assert.match(await ev(`$t("resultStatus").textContent`), /상위 20개/);
    assert.equal(await ev(`$t("holidayStatus").textContent`), "공휴일 불러오는 중…");
    // 붙잡아 둔 요청을 정리하고 기본 모드로 되돌린다
    holidayMode = "fixture";
    for (const requestId of hungRequests.splice(0)) await send("Fetch.failRequest", { requestId, errorReason: "Aborted" });
  });

  // 화면과 코드 어디에도 쓰지 않기로 한 표현이라, 검사하는 이 파일에도 글자 그대로 적지 않고 조각을 이어 붙인다
  const BANNED = ["제", "2전공"].join("");
  await t.test("화면 어디에도 금지된 전공 표현(복수전공·부전공 대신 쓰던 말)이 없고, 콘솔 오류도 없다", async () => {
    assert.equal(await ev(`document.documentElement.outerHTML.includes(${JSON.stringify(BANNED)})`), false);
    assert.deepEqual(logs, []);
  });
});
