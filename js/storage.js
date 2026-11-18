// localStorage 래퍼: 사생활 보호 모드 등에서 저장소가 막혀 있어도 앱이 멈추지 않게 한다.
const PREFIX = "timetable-maker:";

/**
 * 저장값을 읽는다. 없거나, JSON이 깨졌거나, isValid 검사를 통과하지 못하면 fallback을 돌려준다.
 * 예전 버전이 다른 형식으로 저장했거나 값이 손상돼도 앱이 시작하다 멈추지 않게 하기 위해서다.
 */
export function load(key, fallback, isValid = () => true) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const value = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** 자주 쓰는 형식 검사 */
export const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
export const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 이 앱이 저장한 값(PREFIX로 시작하는 키)만 모두 지운다. 같은 사이트의 다른 앱 저장값은 건드리지 않는다 */
export function clearAll() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(PREFIX)) keys.push(key);
    }
    // 지우면서 돌면 번호가 밀리므로 먼저 모은 뒤에 지운다
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* 저장소가 막혀 있으면 지울 것도 없다 */
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* 무시 */
  }
}
