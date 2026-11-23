// 저장한 시간표(F11)·PNG 내보내기(F12) 화면. app.js에서 떼어 낸 부분이다.
// 계산(저장 형식·중복·최대 개수)은 saved.js, 격자 배치는 grid.js, 그리기는 image.js가 맡고,
// 이 파일은 버튼·목록·펼친 격자를 화면에 연결하는 일만 한다.
import { COLORS, layoutGrid } from "./grid.js";
import * as saved from "./saved.js";
import { imageFileName, downloadTimetablePNG } from "./image.js";
import { totalCredit, countFreeWeekdays } from "./scheduler.js";

/**
 * 저장·PNG 화면을 준비한다. app.js가 가진 화면 상태와 도우미 함수를 ctx로 받는다.
 * @param {{ state: Object, $: Function, escapeHTML: Function, renderGrid: Function, professorLabel: Function }} ctx
 * @returns {{ showAction: Function, renderSaveButton: Function, renderSaved: Function, bindSavedEvents: Function }}
 */
export function createSavedView({ state, $, escapeHTML, renderGrid, professorLabel }) {

  /** 저장·내보내기 안내 문구. kind는 showStatus와 같다 */
  function showAction(msg, kind = false) {
    $("actionStatus").textContent = msg;
    $("actionStatus").className = `status${kind === "error" ? " error" : kind === "warn" ? " warn" : ""}`;
  }

  /** 지금 보고 있는 순위가 이미 저장돼 있으면 '저장됨'으로 잠가 같은 조합을 두 번 저장하지 않게 한다 */
  function renderSaveButton() {
    const schedule = state.schedules[state.page];
    const done = !!schedule && saved.isSaved(state.saved, schedule);
    $("saveSchedule").disabled = done;
    $("saveSchedule").textContent = done ? "저장됨" : "이 시간표 저장";
  }

  function onSaveSchedule() {
    const schedule = state.schedules[state.page];
    if (!schedule) return;
    const entry = saved.makeSavedEntry(schedule, { rank: state.page + 1, semester: state.semester });
    const { list, status } = saved.addSaved(state.saved, entry);
    if (status === "duplicate") {
      showAction("이미 저장한 조합입니다.");
    } else if (status === "full") {
      showAction(`시간표는 ${saved.MAX_SAVED}개까지 저장할 수 있습니다. 아래 '저장한 시간표'에서 하나를 삭제한 뒤 다시 저장하세요.`, "warn");
    } else {
      state.saved = list;
      // 저장소가 막혀 있어도(사생활 보호 모드·용량 초과) 앱은 그대로 두고, 이 창에서만 남는다고 알린다
      if (saved.persistSaved(state.saved)) showAction(`${state.page + 1}위 시간표를 저장했습니다.`);
      else showAction("브라우저 저장소에 쓰지 못해, 이 창을 닫으면 저장한 시간표가 사라집니다.", "warn");
    }
    renderSaveButton();
    renderSaved();
  }

  /** 격자 데이터로 PNG를 만들어 내려받는다. 만든 그리기 데이터는 이벤트로 알려 준다(화면 점검이 격자와 비교한다) */
  async function exportPng(schedule, rank, onError) {
    const fileName = imageFileName(rank, totalCredit(schedule));
    try {
      const img = await downloadTimetablePNG(layoutGrid(schedule), fileName);
      document.dispatchEvent(new CustomEvent("timetable:png", { detail: { fileName, blocks: img.blocks } }));
      return fileName;
    } catch (err) {
      console.info("PNG를 만들지 못했습니다:", err.message);
      onError(`이미지를 만들지 못했습니다: ${err.message}`);
      return "";
    }
  }

  async function onExportPng() {
    const schedule = state.schedules[state.page];
    if (!schedule) return;
    const fileName = await exportPng(schedule, state.page + 1, (msg) => showAction(msg, "error"));
    if (fileName) showAction(`${fileName} 파일을 내려받았습니다.`);
  }

  /** "11/20 14:03" */
  function formatSavedAt(ms) {
    const d = new Date(ms);
    const two = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  /** 저장 항목 제목: '1위 · 16학점 · 공강 2일' */
  function savedLabel(entry) {
    return `${entry.rank}위 · ${entry.credit}학점 · 공강 ${countFreeWeekdays(entry.courses)}일`;
  }

  /** 저장한 시간표 목록을 그린다. 펼쳐 본 항목이 지워졌으면 펼친 격자도 닫는다 */
  function renderSaved() {
    const list = state.saved;
    $("savedCount").textContent = `(${list.length}/${saved.MAX_SAVED})`;
    $("savedList").innerHTML =
      list
        .map((e) => {
          const key = escapeHTML(saved.savedKey(e.ids));
          const names = e.courses.map((c) => c.name);
          const preview = names.slice(0, 3).join(", ") + (names.length > 3 ? ` 외 ${names.length - 3}과목` : "");
          const semester = e.semester ? `${e.semester}학기 · ` : "";
          return `<li>
            <button type="button" class="ghost open${saved.savedKey(e.ids) === state.savedOpen ? " current" : ""}" data-open="${key}">
              ${escapeHTML(savedLabel(e))}<span class="muted">${escapeHTML(semester + formatSavedAt(e.savedAt))} · ${escapeHTML(preview)}</span>
            </button>
            <button type="button" class="ghost delete" data-delete="${key}" aria-label="${escapeHTML(savedLabel(e))} 저장한 시간표 삭제">삭제</button>
          </li>`;
        })
        .join("") || `<li class="empty">저장한 시간표가 없습니다. 결과에서 '이 시간표 저장'을 누르면 여기에 남아요.</li>`;

    const open = list.find((e) => saved.savedKey(e.ids) === state.savedOpen);
    $("savedView").hidden = !open;
    if (!open) {
      state.savedOpen = "";
      return;
    }
    const { schedule, missing } = saved.restoreSchedule(open, state.byId);
    $("savedTitle").textContent = savedLabel(open);
    // 다음 학기에 강좌 데이터가 바뀌어도 저장할 때의 스냅숏으로 그린다. 없어진 과목은 알려 준다
    $("savedNote").hidden = !missing.length;
    $("savedNote").textContent = missing.length
      ? `이번 학기 강좌 목록에 없는 과목이 있어 저장할 때의 정보로 보여 줍니다: ${missing.join(", ")}`
      : "";
    renderGrid($("savedGrid"), schedule);
    $("savedSummary").innerHTML = schedule
      .map(
        (c, i) => `<li><span class="dot c${i % COLORS}"></span>${escapeHTML(c.name)}
          <span class="muted">${escapeHTML(c.code)}-${escapeHTML(c.section)} · ${escapeHTML(c.type)} · ${c.credit}학점 · ${escapeHTML(professorLabel(c))}${c.times.length ? "" : " · 시간 미정"}</span></li>`
      )
      .join("");
  }

  function bindSavedEvents() {
    $("saveSchedule").addEventListener("click", onSaveSchedule);
    $("exportPng").addEventListener("click", onExportPng);
    $("savedList").addEventListener("click", (e) => {
      const openBtn = e.target.closest("button[data-open]");
      const deleteBtn = e.target.closest("button[data-delete]");
      if (openBtn) {
        // 이미 펼친 항목을 다시 누르면 접는다
        state.savedOpen = state.savedOpen === openBtn.dataset.open ? "" : openBtn.dataset.open;
      } else if (deleteBtn) {
        state.saved = saved.removeSaved(state.saved, deleteBtn.dataset.delete);
        if (!saved.persistSaved(state.saved)) showAction("브라우저 저장소에 쓰지 못해, 새로고침하면 지운 시간표가 다시 보일 수 있습니다.", "warn");
        renderSaveButton(); // 지운 조합을 보고 있었다면 다시 저장할 수 있게
      } else {
        return;
      }
      renderSaved();
    });
    $("savedClose").addEventListener("click", () => {
      state.savedOpen = "";
      renderSaved();
    });
    $("savedExport").addEventListener("click", async () => {
      const open = state.saved.find((e) => saved.savedKey(e.ids) === state.savedOpen);
      if (!open) return;
      const note = $("savedNote");
      await exportPng(saved.restoreSchedule(open).schedule, open.rank, (msg) => {
        note.hidden = false;
        note.textContent = msg;
      });
    });
  }

  return { showAction, renderSaveButton, renderSaved, bindSavedEvents };
}
