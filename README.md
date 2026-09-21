# DoYu Todo Calendar

날짜별 할 일, 카테고리(색상), 마감일(D-day)을 관리하는 개인용 Todo 캘린더.

- `todo-app/` — 백엔드(Node + SQLite, 의존성 없음) + 프런트(`public/index.html`)
  - 실행: `cd todo-app && node server.js` → http://localhost:3000 (Node 22.5+)
  - 배포: `todo-app/DEPLOY.md` (Oracle Cloud + systemd + Caddy)
- `todo-calendar.html` — 백엔드 없이 동작하는 브라우저 저장(localStorage) 버전
- `todo-design.html` — 초기 디자인 시안
- `*.png` — 디자인 스크린샷

## GitHub Pages (서버 없이 배포)
- `docs/index.html` 은 `todo-app/public/index.html` 과 같은 화면이지만, 데이터를 브라우저 localStorage에 저장하는 정적 버전입니다.
- 화면을 수정한 뒤에는 `node scripts/build-pages.js` 로 다시 빌드하세요.
