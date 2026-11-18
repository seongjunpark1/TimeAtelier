"""
개설강좌 PDF -> data/courses.json 변환 스크립트

사용법:
    pip install -r tools/requirements.txt
    python tools/parse_pdf.py <개설강좌.pdf> [-o data/courses.json]

동작 방식:
1. pdfplumber로 각 페이지를 '레이아웃 유지' 텍스트로 뽑는다.
2. '■ 섹션명 ■' 줄을 만나면 현재 카테고리를 바꾼다.
3. 과목코드(AA00000)와 분반(01)이 있는 줄을 '강좌 행'으로 인식한다.
4. '강의실/요일/HH:MM~HH:MM' 형태의 시간 토큰을 찾아,
   같은 페이지에서 줄 번호가 가장 가까운 강좌 행에 붙인다.
   (PDF에서 시간이 2개인 강좌는 강좌 행의 위/아래 줄에 나뉘어 적혀 있기 때문)
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit("pdfplumber가 필요합니다: pip install -r tools/requirements.txt")

# 강좌 행: 순번 이수구분 학년 과목코드 분반 과목명 학점 교수명 ...
# 레이아웃 텍스트는 칸 사이가 공백 2칸 이상이므로 이를 구분자로 쓴다.
ROW_RE = re.compile(
    r"^\s*(?P<no>\d+)\s+(?P<type>교필|교선|전필|전선|전탐|평교)\s+(?P<grade>\S+)\s+"
    r"(?P<code>[A-Z]{2}\d{5})\s+(?P<section>\d{2})\s+(?P<rest>.+)$"
)
# rest = '과목명  학점  교수명  [Y Y]  시간...  확인사항'
# 1순위: 칸 사이 공백 2칸 이상 / 2순위: 영어 과목명처럼 공백 1칸 / 3순위: 학점이 안 보이는 행
REST_PATTERNS = [
    re.compile(r"^(?P<name>.*?)\s{2,}(?P<credit>\d)\s+(?P<prof>[^\s/]+)"),
    re.compile(r"^(?P<name>.+?)\s(?P<credit>\d)\s+(?P<prof>[가-힣]{2,5})(?:\s|$)"),
    re.compile(r"^(?P<credit>\d)\s+(?P<prof>[^\s/]+)"),  # 과목명이 위/아래 줄로 밀린 경우
    re.compile(r"^(?P<name>.+?)\s{2,}(?P<prof>[가-힣]{2,5})\s"),  # 학점 칸이 비어 보이는 경우
]
TIME_RE = re.compile(
    r"(?P<room>[^\s/]+)/(?P<day>월|화|수|목|금|토|일)(?:요일)?/"
    r"\s?(?P<start>\d{1,2}:\d{2})\s?~\s?(?P<end>\d{1,2}:\d{2})"
)
SECTION_RE = re.compile(r"■\s*(.+?)\s*■")

TYPE_NAMES = {
    "교필": "교양필수",
    "교선": "교양선택",
    "전필": "전공필수",
    "전선": "전공선택",
    "전탐": "전공탐색",
    "평교": "평생교육",
}


def to_minutes(hhmm: str) -> int:
    """'09:30' -> 570"""
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def clean_category(title: str) -> str:
    """'■ 소프트웨어융합전공 개설과목 ■' 같은 제목에서 불필요한 말을 뺀다."""
    title = re.sub(r"\s+", " ", title.split("※")[0]).strip()
    return re.sub(r"\s*개설과목$", "", title)


def wrapped_name(lines, idx):
    """과목명이 길어서 강좌 행의 위/아래 줄로 나뉘어 적힌 경우, 위/아래 줄의 글자를 이어 붙인다."""
    pieces = []
    for j in (idx - 1, idx + 1):
        if 0 <= j < len(lines) and not ROW_RE.match(lines[j]):
            piece = TIME_RE.sub("", lines[j]).strip()
            if piece and not TIME_RE.search(piece):
                pieces.append(piece)
    return " ".join(pieces)


def estimate_credit(times):
    """학점이 안 읽힌 강좌는 주당 수업 시간으로 추정한다. (170분·150분 -> 3학점, 110분 -> 2학점)"""
    total = sum(t["end"] - t["start"] for t in times)
    return max(1, round(total / 55)) if total else 3


def parse_page(page, lines, category):
    """한 페이지의 줄 목록을 받아 (강좌 목록, 마지막 카테고리)를 돌려준다."""
    rows = []   # (줄 번호, 강좌 dict)

    for idx, line in enumerate(lines):
        sec = SECTION_RE.search(line)
        if sec:
            category = clean_category(sec.group(1))

        m = ROW_RE.match(line)
        if m:
            rest_text = m.group("rest").strip()
            rest = next((r for pat in REST_PATTERNS if (r := pat.match(rest_text))), None)
            if not rest:
                print(f"[경고] 과목명/학점 인식 실패: {line.strip()}", file=sys.stderr)
                continue
            parts = rest.groupdict()
            name = (parts.get("name") or "").strip()
            if not name:
                name = wrapped_name(lines, idx)
            prof = parts.get("prof") or ""
            # 교수명 칸을 강좌 행에서 못 읽으면 바로 옆 Y/N 표시 칸이 교수명 자리로 당겨져 읽힌다.
            # (예: 공동 강의라 교수명이 위/아래 두 줄로 나뉜 경우 - 2026-2 과학기술과에콜로지 03~06분반, 또는 교수 미정)
            # 'Y'·'N' 한 글자는 사람 이름일 수 없으므로 비워 두고, PDF를 보고 직접 채우도록 알린다.
            if re.fullmatch(r"[YN]", prof):
                print(
                    f"[알림] {m.group('code')}-{m.group('section')} 교수명을 읽지 못해 비워 둡니다. "
                    "공동 강의(이름이 두 줄)인지 교수 미정인지 PDF를 보고 courses.json에 직접 채우세요",
                    file=sys.stderr,
                )
                prof = ""
            rows.append((idx, {
                "code": m.group("code"),
                "section": m.group("section"),
                "name": re.sub(r"\s+", " ", name).strip(),
                "credit": int(parts["credit"]) if parts.get("credit") else None,
                "professor": prof,
                "type": TYPE_NAMES[m.group("type")],
                "grade": m.group("grade"),
                "category": category,
                "times": [],
            }))

    # 시간 토큰을 같은 페이지에서 '세로 위치'가 가장 가까운 강좌 행에 붙인다.
    # 시간이 2개인 강좌는 강좌 행의 위/아래에 나뉘어 적혀 있어서 줄 번호보다 좌표가 정확하다.
    # 텍스트에서 찾은 강좌 행과 좌표 검색 결과를 과목코드+분반으로 짝짓는다.
    hits = page.search(r"[A-Z]{2}\d{5}\s+\d{2}", regex=True)
    row_centers = []
    h = 0
    for _, c in rows:
        key = c["code"] + c["section"]
        while h < len(hits) and re.sub(r"\s+", "", hits[h]["text"]) != key:
            h += 1  # 강좌 행이 아닌 곳(안내문 등)에 나온 과목코드는 건너뛴다
        if h < len(hits):
            row_centers.append((hits[h]["top"] + hits[h]["bottom"]) / 2)
            h += 1
        else:
            print(f"[경고] {page.page_number}쪽 {key}: 좌표를 찾지 못함", file=sys.stderr)
            row_centers.append(float("inf"))

    for hit in page.search(TIME_RE.pattern, regex=True):
        t = TIME_RE.match(hit["text"])
        start, end = to_minutes(t.group("start")), to_minutes(t.group("end"))
        if end <= start or not row_centers:
            continue
        center = (hit["top"] + hit["bottom"]) / 2
        nearest = min(range(len(row_centers)), key=lambda k: abs(row_centers[k] - center))
        if abs(row_centers[nearest] - center) > 25:
            continue  # 강좌표 밖의 시간 표기(안내문 등)는 버린다
        rows[nearest][1]["times"].append({
            "day": t.group("day"),
            "start": start,
            "end": end,
            "room": t.group("room"),
        })

    courses = [c for _, c in rows]
    for c in courses:
        if c["credit"] is None:
            c["credit"] = estimate_credit(c["times"])
            c["creditEstimated"] = True
            print(f"[알림] 학점 추정: {c['code']} {c['name']} -> {c['credit']}학점", file=sys.stderr)
    return courses, category


def parse_pdf(pdf_path: Path):
    courses = []
    category = ""
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text(layout=True) or ""
            page_courses, category = parse_page(page, text.splitlines(), category)
            courses.extend(page_courses)

    # 같은 과목코드+분반이 중복되면 하나만 남긴다 (공동개설 과목이 여러 섹션에 나오는 경우)
    unique = {}
    for c in courses:
        key = f"{c['code']}-{c['section']}"
        if key not in unique:
            c["id"] = key
            unique[key] = c
    return list(unique.values())


def main():
    ap = argparse.ArgumentParser(description="개설강좌 PDF를 courses.json으로 변환")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=Path("data/courses.json"))
    args = ap.parse_args()

    if not args.pdf.exists():
        sys.exit(f"파일이 없습니다: {args.pdf}")

    courses = parse_pdf(args.pdf)
    no_time = [c for c in courses if not c["times"]]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps({"semester": "2026-2", "courses": courses}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"강좌 {len(courses)}개 저장 -> {args.output}")
    print(f"시간 정보가 없는 강좌 {len(no_time)}개 (원격/미정 등, 조합에서는 시간 충돌 없이 처리)")


if __name__ == "__main__":
    main()
